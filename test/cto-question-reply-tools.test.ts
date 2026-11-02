import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SpsAgentSessionRunResult } from "@sonparkserver/plugin-sdk/platform";
import { answerCtoQuestion, acknowledgeCtoQuestionAnswer, readCtoQuestionAnswer } from "../src/cto-question-reply-tools.ts";
import { createCtoQuestionReplyStore } from "../src/cto-question-reply-store.ts";
import { createCtoQuestionStore, reviewCtoQuestion, submitCtoQuestion } from "../src/cto-question-tools.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { dispatchQuestionToLead } from "../src/cto-intake-delivery.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { createCtoIntakeStore } from "../src/cto-intake-store.ts";
import { LEGACY_CTO_INTAKE_EXECUTION_POLICY } from "../src/domain/cto-intake-deliveries.ts";
import { parseCtoQuestionReply } from "../src/domain/cto-question-replies.ts";
import { fixture, W, A, S, C, P, CTO, ctx, key, mapKey } from "./fixtures/cto-platform.ts";

const QUESTION = "question-retention";
const INBOX_RUN = "66666666-6666-4666-8666-666666666666";
const PRIVATE_LEAD_OUTPUT = "private-Lead-output-must-not-leak";
const PRIVATE_CTO_OUTPUT = "private-CTO-output-must-not-leak";
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
const answer = { text: "Use per-session retention for this assigned feature.", selectedOptionId: "session",
  evidenceRefs: ["baseline:baseline-1"] };
const reviewInput = (disposition: "existing-specification" | "delegated-choice" | "user-decision-needed") => ({
  projectId: P, questionId: QUESTION, expectedBaseRevisionId: "question-board-1", revisionId: "question-board-2",
  reviewId: "review-1", disposition, rationale: "The pinned planning sources support this classification.",
  evidenceRefs: ["baseline:baseline-1"],
});
const answerParams = { projectId: P, questionId: QUESTION, answer };
const answerScope = { projectId: P, ctoId: CTO, workstreamId: "ws-1", questionId: QUESTION };

async function setup(disposition: "existing-specification" | "delegated-choice" | "user-decision-needed" = "delegated-choice") {
  const f = await fixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const ctoRunId = [...f.runs.keys()][0]!;
  const ctoContext = ctx(C, ctoRunId);
  const submitted = await submitCtoQuestion({ projectId: P, ctoId: CTO, workstreamId: "ws-1",
    expectedBaseRevisionId: null, revisionId: "question-board-1", proposal }, ctoContext, f.platform);
  assert.equal((submitted.data as { status: string }).status, "published");

  const inboxSession = randomUUID();
  f.values.set(mapKey(key("lead-sessions.v1.1")), { workspaceId: W, selectionRevision: 1, agentId: A,
    sessions: { main: S, decisions: null, "cto-inbox": inboxSession } });
  const sessions = f.platform.agents.sessions as Record<string, (...args: any[]) => Promise<any>>;
  const original = { describePolicySupport: sessions.describePolicySupport, getRequest: sessions.getRequest,
    getRun: sessions.getRun, sendMessage: sessions.sendMessage };
  const inboxReceipts = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const inboxRuns = new Map<string, SpsAgentSessionRunResult>();
  const inboxSent: Array<{ sessionId: string; requestId: string; options: Record<string, unknown> }> = [];
  let replyPolicyUnsupported = false;
  let failReplyBeforeAccept = false;
  let replyAttempts = 0;
  let loseReplyResponse = false;
  sessions.describePolicySupport = async (sessionId: string, workspaceId: string) => {
    if (sessionId === C && replyPolicyUnsupported) return { schemaVersion: 1, modes: [],
      enforcement: "dispatch-and-run", readiness: "unknown", osIsolation: "not-certified" };
    return original.describePolicySupport(sessionId, workspaceId);
  };
  sessions.getRequest = async (sessionId: string, workspaceId: string, requestId: string) => {
    if (sessionId === inboxSession) {
      assert.equal(workspaceId, W);
      return structuredClone(inboxReceipts.get(requestId) ?? null);
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
  sessions.sendMessage = async (sessionId: string, workspaceId: string, options: Record<string, unknown>) => {
    if (sessionId === inboxSession) {
      assert.equal(workspaceId, W);
      inboxSent.push({ sessionId, requestId: options.requestId as string, options: structuredClone(options) });
      const runId = randomUUID();
      inboxReceipts.set(options.requestId as string, { requestId: options.requestId as string, state: "submitted", runId });
      inboxRuns.set(runId, { runId, status: "running", cancellationRequested: false, termination: "not_applicable",
        error: null, errorCode: null, output: { state: "available", text: PRIVATE_LEAD_OUTPUT } });
      return { runId };
    }
    if (sessionId === C && failReplyBeforeAccept) {
      replyAttempts += 1;
      failReplyBeforeAccept = false;
      throw new Error("Core reply admission failed before receipt");
    }
    if (sessionId === C) {
      replyAttempts += 1;
      const result = await original.sendMessage(sessionId, workspaceId, options);
      if (loseReplyResponse) {
        loseReplyResponse = false;
        throw new Error("CTO reply accepted but response was lost");
      }
      return result;
    }
    return original.sendMessage(sessionId, workspaceId, options);
  };

  const inboxContextBase = { companyId: W, agentId: A, sessionId: inboxSession, runId: INBOX_RUN };
  inboxRuns.set(INBOX_RUN, { runId: INBOX_RUN, status: "running", cancellationRequested: false,
    termination: "not_applicable", error: null, errorCode: null });
  const intake = await dispatchQuestionToLead({ projectId: P, ctoId: CTO, workstreamId: "ws-1", questionId: QUESTION }, ctoContext, f.platform);
  assert.equal((intake.data as { status: string }).status, "submitted");
  assert.equal((inboxSent[0]!.options.executionPolicy as { toolNames: string[] }).toolNames.length, 10);
  assert.ok((inboxSent[0]!.options.executionPolicy as { toolNames: string[] }).toolNames.includes("builder.answer-cto-question"));
  const intakeRequestId = (intake.data as { delivery: { requestId: string } }).delivery.requestId;
  const intakeRunId = inboxReceipts.get(intakeRequestId)!.runId;
  inboxRuns.set(intakeRunId, { runId: intakeRunId, status: "running", cancellationRequested: false,
    termination: "not_applicable", error: null, errorCode: null, output: { state: "available", text: PRIVATE_LEAD_OUTPUT } });
  const leadContext = { ...inboxContextBase, runId: intakeRunId };
  const reviewed = await reviewCtoQuestion(reviewInput(disposition), leadContext, f.platform);
  assert.equal((reviewed.data as { status: string }).status, "published");
  const replyStore = createCtoQuestionReplyStore(W, P, QUESTION, f.state);
  return {
    ...f, ctoContext, inboxSession, leadContext, replyStore, inboxReceipts, inboxRuns, inboxSent,
    get replyAttempts() { return replyAttempts; },
    setReplyPolicyUnsupported() { replyPolicyUnsupported = true; },
    failReplyWithoutReceipt() { failReplyBeforeAccept = true; },
    loseReplyResponse() { loseReplyResponse = true; },
    answer() { return answerCtoQuestion(answerParams, leadContext, f.platform); },
    answerWith(value: unknown) { return answerCtoQuestion({ projectId: P, questionId: QUESTION, answer: value }, leadContext, f.platform); },
    read(context: unknown = ctoContext) { return readCtoQuestionAnswer(answerScope, context, f.platform); },
    acknowledge(context: unknown, understanding = "I understand the recorded choice and its assigned scope.") {
      return acknowledgeCtoQuestionAnswer({ ...answerScope, understanding }, context, f.platform);
    },
  };
}

async function admittedReply(x: Awaited<ReturnType<typeof setup>>) {
  const result = await x.answer();
  const data = result.data as { status: string; reply: { requestId: string; phase: string; runId: string; acknowledged: boolean } };
  assert.equal(data.status, "submitted");
  assert.equal(data.reply.phase, "submitted");
  assert.ok(data.reply.runId);
  return { result, data, context: ctx(C, data.reply.runId) };
}

test("admits an internal answer once with a stable request and no completion claim", async () => {
  const x = await setup("delegated-choice");
  const first = await admittedReply(x);
  assert.equal(first.data.reply.acknowledged, false);
  assert.equal(x.sent.length, 2, "one Workstream send plus one question reply");
  const stored = (await x.replyStore.current())!.revision;
  assert.equal(stored.requestId, first.data.reply.requestId);
  assert.equal(stored.answer.text, answer.text);
  assert.equal(stored.answer.selectedOptionId, "session");
  assert.equal(x.sent[1]!.requestId, stored.requestId);
  assert.deepEqual(stored.executionPolicy.toolNames, ["builder.acknowledge-cto-question-answer", "builder.read-cto-question-answer"]);
  assert.match(first.result.content, /planning|answer|reply/i);
  assert.doesNotMatch(first.result.content, /completed|implementation complete|delivery complete/i);

  const again = await x.answer();
  assert.equal((again.data as { status: string }).status, "existing");
  assert.equal(x.sent.length, 2);
});

test("a user-decision-needed question cannot be answered as an internal CTO reply", async () => {
  const x = await setup("user-decision-needed");
  await assert.rejects(x.answer());
  assert.equal(x.sends, 1);
  assert.equal(await x.replyStore.current(), null);
});

test("a stored legacy nine-tool intake cannot gain the newer answer permission", async () => {
  const x = await setup();
  const store = createCtoIntakeStore(W, P, QUESTION, x.state);
  const current = (await store.current())!.revision;
  await store.publish({ expectedBaseRevisionId: current.revisionId, revision: { ...current,
    revisionId: "legacy-intake-policy-test", executionPolicy: LEGACY_CTO_INTAKE_EXECUTION_POLICY } });
  await assert.rejects(x.answer(), /legacy intake policy|answer permissions/i);
  assert.equal(x.replyAttempts, 0);
  assert.equal(x.sent.length, 1, "only the original Workstream dispatch exists");
  assert.equal(await x.replyStore.current(), null);
});

test("rejects an invalid option, invented source reference and oversized answer after internal review", async () => {
  const x = await setup("delegated-choice");
  await assert.rejects(x.answerWith({ ...answer, selectedOptionId: "invented-option" }), /option/i);
  await assert.rejects(x.answerWith({ ...answer, evidenceRefs: ["invented:source"] }), /real pinned|invented evidence/i);
  await assert.rejects(x.answerWith({ ...answer, text: "x".repeat(8_193) }), /8192|UTF-8 bytes/i);
  assert.equal(x.replyAttempts, 0);
  assert.equal(x.sent.length, 1);
  assert.equal(await x.replyStore.current(), null);
});

test("uncertain reply admission reconciles by receipt and never sends a replacement", async () => {
  const x = await setup();
  x.loseReplyResponse();
  await assert.rejects(x.answer(), /uncertain|receipt|observe|read/i);
  const uncertain = (await x.replyStore.current())!.revision;
  assert.equal(uncertain.phase, "uncertain");
  const recovered = await x.answer();
  const reply = (recovered.data as { status: string; reply: { requestId: string; runId: string } }).reply;
  assert.equal((recovered.data as { status: string }).status, "existing");
  assert.equal(reply.requestId, uncertain.requestId);
  assert.equal(reply.runId, x.receipts.get(uncertain.requestId)?.runId);
  assert.equal(x.replyAttempts, 1);

  const noReceipt = await setup();
  noReceipt.failReplyWithoutReceipt();
  await assert.rejects(noReceipt.answer());
  assert.equal((await noReceipt.replyStore.current())!.revision.phase, "uncertain");
  await noReceipt.answer().catch(() => undefined);
  assert.equal(noReceipt.replyAttempts, 1);
});

test("CAS, unsupported policy, changed Lead selection and stale instruction fail before reply admission", async () => {
  const noCas = await setup();
  noCas.platform.state.compareAndSet = undefined;
  await assert.rejects(noCas.answer());
  assert.equal(noCas.replyAttempts, 0);

  const unsupported = await setup();
  unsupported.setReplyPolicyUnsupported();
  await assert.rejects(unsupported.answer(), /support|policy|restricted/i);
  assert.equal(unsupported.replyAttempts, 0);

  const changedLead = await setup();
  changedLead.values.set(mapKey(key("lead-agent.v1")), { workspaceId: W, revision: 2, selectedAgentId: randomUUID() });
  await assert.rejects(changedLead.answer());
  assert.equal(changedLead.replyAttempts, 0);

  const staleInstruction = await setup();
  const workstreams = createWorkstreamStore(W, P, staleInstruction.state);
  const current = (await workstreams.current())!.revision;
  await workstreams.publish({ expectedBaseRevisionId: current.revisionId, revision: { ...current,
    revisionId: "changed-board", workstreams: current.workstreams.map(row => ({ ...row,
      spec: { ...row.spec, revision: row.spec.revision + 1, goal: "A changed instruction." },
      change: { ...row.change, previousRevision: row.spec.revision } })) } });
  await assert.rejects(staleInstruction.answer());
  assert.equal(staleInstruction.replyAttempts, 0);
});

test("only the exact target CTO reply run can read and acknowledge its immutable bounded answer", async () => {
  const x = await setup();
  const admitted = await admittedReply(x);
  const reply = await x.read(admitted.context);
  const data = reply.data as { reply: { projectId: string; questionId: string; requestId: string; answer: typeof answer;
    acknowledgement: unknown } };
  assert.deepEqual(Object.keys(data), ["reply"]);
  assert.equal(data.reply.projectId, P);
  assert.equal(data.reply.questionId, QUESTION);
  assert.equal(data.reply.requestId, admitted.data.reply.requestId);
  assert.deepEqual(data.reply.answer, answer);
  assert.equal(data.reply.acknowledgement, null);
  assert.equal(JSON.stringify(data).includes(PRIVATE_LEAD_OUTPUT), false);
  assert.equal(JSON.stringify(data).includes(PRIVATE_CTO_OUTPUT), false);

  for (const unbound of [x.ctoContext, ctx(), { ...admitted.context, agentId: randomUUID() }]) {
    await assert.rejects(x.read(unbound));
    await assert.rejects(x.acknowledge(unbound));
  }
  await assert.rejects(readCtoQuestionAnswer({ ...answerScope, questionId: "another-question" }, admitted.context, x.platform));
  await assert.rejects(x.acknowledge(admitted.context, "x".repeat(8_193)));

  const ack = await x.acknowledge(admitted.context);
  assert.equal((ack.data as { status: string }).status, "published");
  assert.match(ack.content, /understand|acknowledg/i);
  assert.doesNotMatch(ack.content, /completed|implementation complete|delivery complete/i);
  const duplicate = await x.acknowledge(admitted.context);
  assert.equal((duplicate.data as { status: string }).status, "existing");
  await assert.rejects(x.acknowledge(admitted.context, "A different immutable acknowledgement."));
  assert.equal(x.sent.length, 2, "acknowledgement is a record, not another provider send");

  const acknowledged = (await x.replyStore.current())!.revision;
  for (const [phase, cancellationRequested, termination] of [
    ["succeeded", false, "not_applicable"], ["failed", false, "not_applicable"],
    ["cancelled", true, "confirmed"], ["interrupted", false, "not_applicable"], ["timed_out", false, "not_applicable"],
  ] as const) {
    const terminal = parseCtoQuestionReply({ ...acknowledged, phase, cancellationRequested, termination }, W, P, QUESTION);
    assert.deepEqual(terminal.acknowledgement, acknowledged.acknowledgement, `acknowledgement must survive ${phase}`);
  }
});

test("preserves a CTO acknowledgement when later provider observation reports failure", async () => {
  const x = await setup("existing-specification");
  const admitted = await admittedReply(x);
  const ack = await x.acknowledge(admitted.context);
  assert.equal((ack.data as { status: string }).status, "published");
  const before = (await x.replyStore.current())!.revision;
  assert.ok(before.acknowledgement);

  const run = x.runs.get(admitted.data.reply.runId)!;
  x.runs.set(admitted.data.reply.runId, { ...run, status: "failed" });
  const observed = await x.answer();
  const summary = (observed.data as { status: string; reply: { phase: string; acknowledged: boolean } }).reply;
  assert.equal((observed.data as { status: string }).status, "existing");
  assert.equal(summary.phase, "failed");
  assert.equal(summary.acknowledged, true);
  assert.deepEqual((await x.replyStore.current())!.revision.acknowledgement, before.acknowledgement);
  assert.equal(x.sent.length, 2, "observing failure does not send another reply");
});
