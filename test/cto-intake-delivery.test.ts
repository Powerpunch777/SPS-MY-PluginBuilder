import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SpsAgentSessionRunResult } from "@sonparkserver/plugin-sdk/platform";
import { dispatchQuestionToLead, readBoundCtoIntake } from "../src/cto-intake-delivery.ts";
import { createCtoIntakeStore } from "../src/cto-intake-store.ts";
import { createCtoQuestionStore, reviewCtoQuestion, submitCtoQuestion } from "../src/cto-question-tools.ts";
import { submitAssignedCtoQuestion } from "../src/platform.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { fixture, W, A, S, C, P, CTO, ctx, key, mapKey } from "./fixtures/cto-platform.ts";

const QUESTION = "question-retention";
const QUESTION_2 = "question-encryption";
const INBOX_RUN = "66666666-6666-4666-8666-666666666666";
const PRIVATE_OUTPUT = "private-CTO-output-must-not-leak";

const proposal = {
  id: QUESTION,
  title: "Which retention boundary applies?",
  context: "The assigned planning scope has two viable policies.",
  reasonNeeded: "The current wording leaves retention unspecified.",
  options: [
    { id: "session", label: "Per session", tradeoff: "Less retention." },
    { id: "project", label: "Per project", tradeoff: "More continuity." },
  ],
  recommendation: "session",
  delayImpact: "The affected planning decision is blocked.",
  scopeNodeIds: ["feature"],
  evidenceRefs: [],
};

async function setup(options: { cas?: boolean; seedQuestion?: boolean } = {}) {
  const f = await fixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const ctoRunId = [...f.runs.keys()][0]!;
  const ctoRunContext = ctx(C, ctoRunId);
  const questionInput = { projectId: P, ctoId: CTO, workstreamId: "ws-1", expectedBaseRevisionId: null,
    revisionId: "question-board-1", proposal };
  if (options.seedQuestion !== false) {
    const submitted = await submitCtoQuestion(questionInput, ctoRunContext, f.platform);
    assert.equal((submitted.data as { status: string }).status, "published");
  }

  const inboxSession = randomUUID();
  f.values.set(mapKey(key("lead-sessions.v1.1")), { workspaceId: W, selectionRevision: 1, agentId: A,
    sessions: { main: S, decisions: null, "cto-inbox": inboxSession } });

  const sessions = f.platform.agents.sessions as Record<string, (...args: any[]) => Promise<any>>;
  const original = {
    describePolicySupport: sessions.describePolicySupport,
    getRequest: sessions.getRequest,
    getRun: sessions.getRun,
    sendMessage: sessions.sendMessage,
    cancel: sessions.cancel,
  };
  const receipts = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const inboxRuns = new Map<string, SpsAgentSessionRunResult>();
  const inboxSent: Array<{ sessionId: string; workspaceId: string; options: Record<string, unknown> }> = [];
  let loseNextResponse = false;
  let acceptNextSend = true;
  let inboxCancelled = false;
  let unsupportedInboxPolicy = false;
  sessions.describePolicySupport = async (sessionId: string, workspaceId: string) => {
    if (sessionId === inboxSession && unsupportedInboxPolicy) return { schemaVersion: 1, modes: [],
      enforcement: "dispatch-and-run", readiness: "unknown", osIsolation: "not-certified" };
    return original.describePolicySupport(sessionId, workspaceId);
  };
  sessions.getRequest = async (sessionId: string, workspaceId: string, requestId: string) => {
    if (sessionId === inboxSession) {
      assert.equal(workspaceId, W);
      return structuredClone(receipts.get(requestId) ?? null);
    }
    return original.getRequest(sessionId, workspaceId, requestId);
  };
  sessions.getRun = async (sessionId: string, workspaceId: string, runId: string) => {
    if (sessionId === inboxSession) {
      assert.equal(workspaceId, W);
      const run = inboxRuns.get(runId);
      if (!run) throw new Error("Unknown Lead inbox run");
      return structuredClone(run);
    }
    return original.getRun(sessionId, workspaceId, runId);
  };
  sessions.sendMessage = async (sessionId: string, workspaceId: string, sendOptions: Record<string, unknown>) => {
    if (sessionId !== inboxSession) return original.sendMessage(sessionId, workspaceId, sendOptions);
    assert.equal(workspaceId, W);
    inboxSent.push({ sessionId, workspaceId, options: structuredClone(sendOptions) });
    if (!acceptNextSend) throw new Error("Core admission unavailable before receipt");
    const requestId = sendOptions.requestId as string;
    const runId = randomUUID();
    receipts.set(requestId, { requestId, state: "submitted", runId });
    inboxRuns.set(runId, { runId, status: "running", cancellationRequested: false, termination: "not_applicable",
      error: null, errorCode: null, output: { state: "available", text: PRIVATE_OUTPUT } });
    if (loseNextResponse) {
      loseNextResponse = false;
      throw new Error("Accepted, but response was lost");
    }
    return { runId };
  };
  sessions.cancel = async (sessionId: string, workspaceId: string, runId: string) => {
    if (sessionId !== inboxSession) return original.cancel(sessionId, workspaceId, runId);
    inboxCancelled = true;
    const current = inboxRuns.get(runId);
    if (!current) throw new Error("Unknown Lead inbox run");
    const cancelled = { ...current, status: "cancelled", cancellationRequested: true, termination: "pending" } as SpsAgentSessionRunResult;
    inboxRuns.set(runId, cancelled);
    return structuredClone(cancelled);
  };

  const inboxRunContext = { companyId: W, agentId: A, sessionId: inboxSession, runId: INBOX_RUN };
  inboxRuns.set(INBOX_RUN, { runId: INBOX_RUN, status: "running", cancellationRequested: false,
    termination: "not_applicable", error: null, errorCode: null });
  const params = { projectId: P, ctoId: CTO, workstreamId: "ws-1", questionId: QUESTION };
  const intakeStore = createCtoIntakeStore(W, P, QUESTION, f.state);
  const boundInboxRunContext = () => {
    const delivery = intakeStore.current();
    return delivery.then(current => ({ companyId: W, agentId: A, sessionId: inboxSession,
      runId: receipts.get(current!.revision.requestId)?.runId ?? INBOX_RUN }));
  };
  return {
    ...f, ctoRunContext, inboxSession, inboxRunContext, boundInboxRunContext, params, intakeStore, questionInput,
    receipts, inboxRuns, inboxSent,
    get inboxCancelled() { return inboxCancelled; },
    loseResponse() { loseNextResponse = true; },
    rejectAdmission() { acceptNextSend = false; },
    rejectInboxPolicy() { unsupportedInboxPolicy = true; },
    dispatch() { return dispatchQuestionToLead(params, ctoRunContext, f.platform); },
    async read(context?: { companyId: string; agentId: string; sessionId: string; runId: string }, questionId = QUESTION) {
      return readBoundCtoIntake({ projectId: P, questionId }, context ?? await boundInboxRunContext(), f.platform);
    },
  };
}

function readyLogicalContexts(x: Awaited<ReturnType<typeof setup>>, questionIntakeSession = x.inboxSession) {
  const contexts = { user_conversation: randomUUID(), ui_design: randomUUID(), background_planning: randomUUID(),
    question_intake: questionIntakeSession, question_discussion: randomUUID() };
  x.values.set(mapKey(key("lead-contexts.v2.1")), { schemaVersion: 2, workspaceId: W, selectionRevision: 1,
    agentId: A, requestId: randomUUID(), status: "ready", pendingContext: null, contexts });
  return contexts;
}

test("admits one stable question request and reuses it without a second send", async () => {
  const x = await setup();
  const first = await x.dispatch();
  const firstData = first.data as { status: string; delivery: { questionId: string; requestId: string; phase: string; runId: string } };
  assert.equal(firstData.status, "submitted");
  assert.equal(firstData.delivery.questionId, QUESTION);
  assert.equal(firstData.delivery.phase, "submitted");
  assert.ok(firstData.delivery.runId);
  assert.equal(x.inboxSent.length, 1);
  const stored = (await x.intakeStore.current())!.revision;
  assert.equal(stored.requestId, firstData.delivery.requestId);
  assert.equal(x.inboxSent[0]!.options.requestId, stored.requestId);
  assert.deepEqual(x.inboxSent[0]!.options.executionPolicy, stored.executionPolicy);

  const again = await x.dispatch();
  assert.equal((again.data as { status: string }).status, "existing");
  assert.equal(x.inboxSent.length, 1);
});

test("EMPTY5 public submit sends once to Question Intake and reads/reviews the same Core receipt", async () => {
  const x = await setup({ seedQuestion: false });
  const contexts = readyLogicalContexts(x);
  x.values.delete(mapKey(key("lead-sessions.v1.1")));
  const submitted = await submitAssignedCtoQuestion(x.questionInput, x.ctoRunContext, x.platform);
  const data = submitted.data as { intake: { status: string; delivery: { requestId: string; runId: string } } };
  const requestId = data.intake.delivery.requestId, runId = data.intake.delivery.runId;
  assert.equal(data.intake.status, "submitted");
  assert.equal(x.inboxSent.length, 1);
  assert.equal(x.inboxSent[0]!.sessionId, contexts.question_intake);
  assert.equal(x.inboxSent[0]!.options.requestId, requestId);
  assert.deepEqual(x.receipts.get(requestId), { requestId, state: "submitted", runId });
  assert.equal(x.inboxRuns.get(runId)?.runId, runId);

  const read = await x.read();
  assert.equal((read.data as { delivery: { requestId: string; runId: string } }).delivery.requestId, requestId);
  assert.equal((read.data as { delivery: { requestId: string; runId: string } }).delivery.runId, runId);
  const review = await reviewCtoQuestion({ projectId: P, questionId: QUESTION, expectedBaseRevisionId: "question-board-1",
    revisionId: "question-board-v2-reviewed", reviewId: "review-v2-intake", disposition: "user-decision-needed",
    rationale: "The pinned sources leave this choice to the user.",
    evidenceRefs: ["baseline:baseline-1", "spec:spec-1", "graph:graph-1",
      "technology:tech-1", "workstream:ws-1:1"] }, await x.boundInboxRunContext(), x.platform);
  assert.equal((review.data as { status: string }).status, "published");
  const duplicate = await x.dispatch();
  assert.equal((duplicate.data as { status: string }).status, "existing");
  assert.equal(x.inboxSent.length, 1);
  assert.equal((await x.intakeStore.current())!.revision.requestId, requestId);
});

test("v2 Question Intake rejects other logical contexts and never falls back from preparation", async () => {
  const x = await setup();
  const contexts = readyLogicalContexts(x);
  for (const context of ["user_conversation", "ui_design", "background_planning", "question_discussion"] as const) {
    await assert.rejects(x.read({ companyId: W, agentId: A, sessionId: contexts[context], runId: INBOX_RUN }));
  }
  assert.equal(x.inboxSent.length, 0);

  const pending = await setup();
  pending.values.set(mapKey(key("lead-contexts.v2.1")), { schemaVersion: 2, workspaceId: W, selectionRevision: 1,
    agentId: A, requestId: randomUUID(), status: "uncertain", pendingContext: "question_intake",
    contexts: { user_conversation: randomUUID(), ui_design: randomUUID(), background_planning: randomUUID(),
      question_intake: null, question_discussion: randomUUID() } });
  await assert.rejects(pending.dispatch(), /not ready|fallback/i);
  assert.equal(pending.inboxSent.length, 0);
  assert.equal((await pending.intakeStore.current()), null);
});

test("changed Host selection or Question Intake identity is observed without rewriting the old receipt", async () => {
  const x = await setup();
  const contexts = readyLogicalContexts(x);
  await x.dispatch();
  const before = (await x.intakeStore.current())!.revision;
  const replaced = { ...contexts, question_intake: randomUUID() };
  x.values.set(mapKey(key("lead-contexts.v2.1")), { schemaVersion: 2, workspaceId: W, selectionRevision: 1,
    agentId: A, requestId: randomUUID(), status: "ready", pendingContext: null, contexts: replaced });
  await assert.rejects(x.read(), /authority changed|target changed|authorized/i);
  const after = (await x.intakeStore.current())!.revision;
  assert.equal(after.requestId, before.requestId);
  assert.deepEqual(after.target, before.target);
  assert.equal(x.receipts.get(before.requestId)?.runId, before.runId);
  assert.equal(x.inboxSent.length, 1);

  const legacy = await setup();
  await legacy.dispatch();
  const legacyBefore = (await legacy.intakeStore.current())!.revision;
  readyLogicalContexts(legacy, randomUUID());
  await assert.rejects(legacy.dispatch(), /different delivery target/i);
  const legacyAfter = (await legacy.intakeStore.current())!.revision;
  assert.equal(legacyAfter.requestId, legacyBefore.requestId);
  assert.deepEqual(legacyAfter.target, legacyBefore.target);
  assert.equal(legacy.receipts.get(legacyBefore.requestId)?.runId, legacyBefore.runId);
  assert.equal(legacy.inboxSent.length, 1);
});

test("recovers an accepted lost response from the exact Core receipt without resending", async () => {
  const x = await setup();
  x.loseResponse();
  await assert.rejects(x.dispatch(), /uncertain|receipt|read/i);
  const uncertain = (await x.intakeStore.current())!.revision;
  assert.equal(uncertain.phase, "uncertain");
  assert.equal(x.receipts.get(uncertain.requestId)?.state, "submitted");

  const recovered = await x.dispatch();
  const delivery = (recovered.data as { status: string; delivery: { requestId: string; runId: string; phase: string } }).delivery;
  assert.equal((recovered.data as { status: string }).status, "existing");
  assert.equal(delivery.requestId, uncertain.requestId);
  assert.equal(delivery.runId, x.receipts.get(uncertain.requestId)?.runId);
  assert.equal(x.inboxSent.length, 1);
});

test("keeps a no-receipt outcome uncertain and never retries the send", async () => {
  const x = await setup();
  x.rejectAdmission();
  await assert.rejects(x.dispatch(), /uncertain|receipt|admission|read/i);
  const uncertain = (await x.intakeStore.current())!.revision;
  assert.equal(uncertain.phase, "uncertain");
  assert.equal(x.receipts.has(uncertain.requestId), false);

  const existing = await x.dispatch();
  assert.equal((existing.data as { status: string }).status, "existing");
  assert.equal(x.inboxSent.length, 1);
});

test("rejects wrong CTO, forged run, retired Lead, missing CAS and unsupported policy before admission", async () => {
  const wrongCto = await setup();
  await assert.rejects(dispatchQuestionToLead({ ...wrongCto.params, ctoId: "another-cto" }, wrongCto.ctoRunContext, wrongCto.platform));
  assert.equal(wrongCto.inboxSent.length, 0);

  const forgedRun = await setup();
  await assert.rejects(dispatchQuestionToLead(forgedRun.params, { ...forgedRun.ctoRunContext, runId: randomUUID() }, forgedRun.platform));
  assert.equal(forgedRun.inboxSent.length, 0);

  const retiredLead = await setup();
  retiredLead.values.set(mapKey(key("lead-agent.v1")), { workspaceId: W, revision: 2, selectedAgentId: randomUUID() });
  await assert.rejects(retiredLead.dispatch());
  assert.equal(retiredLead.inboxSent.length, 0);

  const noCas = await setup();
  noCas.platform.state.compareAndSet = undefined;
  await assert.rejects(noCas.dispatch());
  assert.equal(noCas.inboxSent.length, 0);

  const unsupported = await setup();
  unsupported.rejectInboxPolicy();
  await assert.rejects(unsupported.dispatch(), /support|policy|restricted/i);
  assert.equal(unsupported.inboxSent.length, 0);
});

test("does not deliver a question after its current Workstream instruction changes", async () => {
  const x = await setup();
  await createWorkstreamStore(W, P, x.state).publish({ expectedBaseRevisionId: "board-1", revision: {
    projectId: P, revisionId: "board-revised", workstreams: [{ ...x.instruction,
      spec: { ...x.instruction.spec, revision: 2, goal: "A changed instruction." },
      change: { ...x.instruction.change, previousRevision: 1 } }],
  } });
  await assert.rejects(x.dispatch());
  assert.equal(x.inboxSent.length, 0);
});

test("reads only the exact question and actual Core receipt/run, without private output", async () => {
  const x = await setup();
  await x.dispatch();
  const result = await x.read();
  const data = result.data as { projectId: string; question: { proposal: { id: string };
    reporter: { ctoId: string; runId: string } };
    delivery: { questionId: string; requestId: string; phase: string; runId: string }; sources: unknown };
  assert.deepEqual(Object.keys(data).sort(), ["delivery", "projectId", "question", "sources"]);
  assert.equal(data.projectId, P);
  assert.equal(data.question.proposal.id, QUESTION);
  assert.equal(data.question.reporter.runId, x.ctoRunContext.runId);
  assert.equal(data.delivery.questionId, QUESTION);
  assert.equal(data.delivery.phase, "submitted");
  assert.equal(data.delivery.runId, x.receipts.get(data.delivery.requestId)?.runId);
  const registry = x.values.get(mapKey(x.registryKey)) as unknown as { ctos: Array<{ ctoId: string; agentId: string; sessionId: string; status: string }> };
  assert.deepEqual(registry.ctos.find(cto => cto.ctoId === CTO), { ...x.cto, status: "ACTIVE" });
  assert.equal(registry.ctos.find(cto => cto.ctoId === data.question.reporter.ctoId)?.status, "ACTIVE");
  assert.equal(JSON.stringify(data).includes(PRIVATE_OUTPUT), false);
  assert.equal(JSON.stringify(data).includes("privateMemory"), false);
  await assert.rejects(x.read(x.inboxRunContext, QUESTION_2));
});

test("rejects a bound intake after its reporting CTO is retired", async () => {
  const x = await setup();
  await x.dispatch();
  const registry = x.values.get(mapKey(x.registryKey)) as unknown as { schemaVersion: number; workspaceId: string; projectId: string;
    revision: number; ctos: Array<typeof x.cto> };
  x.values.set(mapKey(x.registryKey), { ...registry, revision: registry.revision + 1,
    ctos: registry.ctos.map(cto => cto.ctoId === CTO ? { ...cto, status: "RETIRED" } : cto) });
  await assert.rejects(x.read());
});

test("rejects another Lead session and cancelled inbox run when reading the bound intake", async () => {
  const x = await setup();
  await x.dispatch();
  await assert.rejects(x.read(ctx(S, randomUUID())));
  await assert.rejects(x.read({ companyId: "22222222-2222-4222-8222-222222222222", agentId: A,
    sessionId: x.inboxSession, runId: INBOX_RUN }));
  const bound = await x.read().then(() => x.inboxSent[0]!.options.requestId as string);
  const runId = x.receipts.get(bound)!.runId;
  x.inboxRuns.set(runId, { ...x.inboxRuns.get(runId)!, cancellationRequested: true, termination: "pending" });
  await assert.rejects(x.read());
  assert.equal(x.inboxCancelled, false, "reading a cancelled intake must not call Core cancellation");
});

test("the platform wrapper admits only after publish/existing storage and sends once", async () => {
  const x = await setup({ seedQuestion: false });
  const first = await submitAssignedCtoQuestion(x.questionInput, x.ctoRunContext, x.platform);
  const firstData = first.data as { status: string; questionId: string; intake: { status: string; delivery: { requestId: string } };
    userQuestionCreated: boolean };
  assert.equal(firstData.status, "published");
  assert.equal(firstData.questionId, QUESTION);
  assert.equal(firstData.intake.status, "submitted");
  assert.equal(firstData.userQuestionCreated, false);
  assert.equal(x.inboxSent.length, 1);
  assert.equal((await x.intakeStore.current())!.revision.requestId, firstData.intake.delivery.requestId);

  const again = await submitAssignedCtoQuestion({ ...x.questionInput, revisionId: "question-board-retry" }, x.ctoRunContext, x.platform);
  const againData = again.data as { status: string; intake: { status: string } };
  assert.equal(againData.status, "existing");
  assert.equal(againData.intake.status, "existing");
  assert.equal(x.inboxSent.length, 1);
});

test("a storage conflict returns without admitting an intake message", async () => {
  const x = await setup({ seedQuestion: false });
  const conflict = await submitAssignedCtoQuestion({ ...x.questionInput, expectedBaseRevisionId: "unexpected-base" },
    x.ctoRunContext, x.platform);
  assert.equal((conflict.data as { status: string }).status, "conflict");
  assert.equal(x.inboxSent.length, 0);
  assert.equal(await x.intakeStore.current(), null);
});

test("a stored question with an unprepared Lead inbox remains explicitly unconfirmed", async () => {
  const x = await setup({ seedQuestion: false });
  x.values.set(mapKey(key("lead-sessions.v1.1")), { workspaceId: W, selectionRevision: 1, agentId: A,
    sessions: { main: S, decisions: null, "cto-inbox": null } });
  const result = await submitAssignedCtoQuestion(x.questionInput, x.ctoRunContext, x.platform);
  const data = result.data as { status: string; questionId: string; intake: { status: string; automaticallyResent: boolean };
    userQuestionCreated: boolean; aiDispatched?: boolean; completion?: unknown; providerCompletion?: unknown };
  assert.equal(data.status, "published");
  assert.equal(data.questionId, QUESTION);
  assert.deepEqual(data.intake, { status: "unconfirmed", automaticallyResent: false });
  assert.equal(data.userQuestionCreated, false);
  assert.equal(data.aiDispatched, undefined);
  assert.equal(data.completion, undefined);
  assert.equal(data.providerCompletion, undefined);
  assert.match(result.content, /proposal is stored, but Lead delivery is unconfirmed/i);
  const board = await createCtoQuestionStore(W, P, x.state).current();
  assert.equal(board?.revision.questions[0]?.proposal.id, QUESTION);
  assert.equal(await x.intakeStore.current(), null);
  assert.equal(x.inboxSent.length, 0);
});
