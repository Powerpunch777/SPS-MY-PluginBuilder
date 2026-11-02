import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { submitCtoQuestion, readOwnCtoQuestion, readCtoQuestions, reviewCtoQuestion, readUserCtoQuestions, createCtoQuestionStore } from "../src/cto-question-tools.ts";
import { createCtoIntakeStore } from "../src/cto-intake-store.ts";
import { CTO_INTAKE_EXECUTION_POLICY, ctoIntakeRequestId, parseCtoIntakeDelivery } from "../src/domain/cto-intake-deliveries.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { fixture, W, A, S, C, P, CTO, ctx, key, mapKey } from "./fixtures/cto-platform.ts";

async function setup() {
  const f = await fixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const runId = [...f.runs.keys()][0]!, context = ctx(C, runId), intakeSession = randomUUID(), intakeRun = randomUUID();
  f.values.set(mapKey(key("lead-sessions.v1.1")), { workspaceId: W, selectionRevision: 1, agentId: A,
    sessions: { main: S, decisions: null, "cto-inbox": intakeSession } });
  const original = f.platform.agents.sessions.getRun;
  f.platform.agents.sessions.getRun = async (sessionId, workspaceId, id) => {
    if (sessionId === intakeSession) {
      assert.equal(workspaceId, W); assert.equal(id, intakeRun);
      return { runId: intakeRun, status: "running", cancellationRequested: false, termination: "not_applicable", error: null, errorCode: null };
    }
    return original(sessionId, workspaceId, id);
  };
  const proposal = { id: "q-one", title: "Which retention boundary applies?", context: "The assigned planning scope has two viable policies.",
    reasonNeeded: "The current wording leaves retention unspecified.", options: [
      { id: "session", label: "Per session", tradeoff: "Less retention" }, { id: "project", label: "Per project", tradeoff: "More continuity" }],
    recommendation: "session", delayImpact: "Only the affected planning decision is blocked.", scopeNodeIds: ["feature"], evidenceRefs: [] };
  const input = { projectId: P, ctoId: CTO, workstreamId: "ws-1", expectedBaseRevisionId: null, revisionId: "question-board-1", proposal };
  const intake = ctx(intakeSession, intakeRun), store = createCtoQuestionStore(W, P, f.state);
  let seededRequestId: string | null = null, intakeReceiptRunId: string = intakeRun;
  const originalGetRequest = f.platform.agents.sessions.getRequest;
  f.platform.agents.sessions.getRequest = async (sessionId, workspaceId, requestId) => {
    if (sessionId === intakeSession) {
      if (workspaceId !== W || requestId !== seededRequestId || seededRequestId === null) return null;
      return { requestId: seededRequestId, state: "submitted", runId: intakeReceiptRunId };
    }
    return originalGetRequest(sessionId, workspaceId, requestId);
  };
  const submit = () => submitCtoQuestion(input, context, f.platform);
  const reviewParams = (disposition = "user-decision-needed", evidenceRefs = ["baseline:baseline-1"]) => ({
    projectId: P, questionId: proposal.id, expectedBaseRevisionId: "question-board-1", revisionId: "question-board-2",
    reviewId: "review-1", disposition, rationale: "The user owns this policy decision; the cited baseline does not settle it.", evidenceRefs,
  });
  const reviewDirect = (runContext = intake, disposition = "user-decision-needed", evidenceRefs = ["baseline:baseline-1"]) =>
    reviewCtoQuestion(reviewParams(disposition, evidenceRefs), runContext, f.platform);
  async function seedIntake() {
    if (seededRequestId !== null) return seededRequestId;
    const question = (await store.current())?.revision.questions.find(row => row.proposal.id === proposal.id);
    if (!question) return null;
    const target = { agentId: A, sessionId: intakeSession, selectionRevision: 1 };
    const requestId = ctoIntakeRequestId(W, P, proposal.id, question, target);
    const intakeStore = createCtoIntakeStore(W, P, proposal.id, f.state);
    const prepared = parseCtoIntakeDelivery({ schemaVersion: 1, workspaceId: W, projectId: P, questionId: proposal.id,
      revisionId: `${requestId}:prepared`, requestId, question, target, executionPolicy: CTO_INTAKE_EXECUTION_POLICY,
      createdAtISO: "2026-11-02T01:02:03.004Z", phase: "prepared", runId: null, cancellationRequested: false,
      termination: "not_applicable" }, W, P, proposal.id);
    assert.equal((await intakeStore.publish({ expectedBaseRevisionId: null, revision: prepared })).status, "published");
    const dispatching = parseCtoIntakeDelivery({ ...prepared, revisionId: `${requestId}:dispatching`, phase: "dispatching" }, W, P, proposal.id);
    assert.equal((await intakeStore.publish({ expectedBaseRevisionId: prepared.revisionId, revision: dispatching })).status, "published");
    const submitted = parseCtoIntakeDelivery({ ...dispatching, revisionId: `${requestId}:submitted`, phase: "submitted", runId: intakeRun }, W, P, proposal.id);
    assert.equal((await intakeStore.publish({ expectedBaseRevisionId: dispatching.revisionId, revision: submitted })).status, "published");
    seededRequestId = requestId;
    return requestId;
  }
  const review = async (disposition = "user-decision-needed", evidenceRefs = ["baseline:baseline-1"]) => {
    await seedIntake();
    return reviewDirect(intake, disposition, evidenceRefs);
  };
  return { ...f, f, context, intake, intakeSession, intakeRun, runId, proposal, input, store, submit, review, reviewDirect,
    seedIntake, setIntakeReceiptRunId: (value: string) => { intakeReceiptRunId = value; } };
}

test("CTO proposals are internal, Core-bound, immutable and do not create a user question or another run", async () => {
  const x = await setup(), result = await x.submit();
  assert.equal((result.data as { status: string }).status, "published");
  assert.equal((result.data as { userQuestionCreated: boolean }).userQuestionCreated, false);
  const stored = (await x.store.current())!.revision.questions[0]!;
  assert.equal(stored.reporter.runId, x.runId); assert.equal(stored.reporter.requestId, x.sent[0]!.requestId);
  assert.equal(stored.review, null); assert.equal(x.f.sends, 1);
  assert.deepEqual((await readUserCtoQuestions(W, P, x.platform))!.board.questions, []);
  const before = x.f.writes;
  assert.equal((await x.submit()).data && x.f.writes, before);
  await assert.rejects(submitCtoQuestion({ ...x.input, proposal: { ...x.proposal, context: "Changed immutable content" } }, x.context, x.platform), /different immutable/);
});

test("only the prepared internal intake Lead may inspect or review proposals", async () => {
  const x = await setup(); await x.submit();
  for (const context of [ctx(), x.context, ctx(randomUUID(), randomUUID())]) {
    await assert.rejects(readCtoQuestions({ projectId: P }, context, x.platform));
  }
  const read = await readCtoQuestions({ projectId: P }, x.intake, x.platform);
  assert.equal((read.data as { current: { revision: { questions: unknown[] } } }).current.revision.questions.length, 1);
  await x.review();
  const reviewed = (await x.store.current())!.revision.questions[0]!;
  assert.equal(reviewed.review!.reviewer.sessionId, x.intakeSession);
  assert.equal(reviewed.review!.reviewer.runId, x.intakeRun);
  assert.equal(reviewed.review!.disposition, "user-decision-needed");
});

test("only Lead-classified user decisions reach the user list, not unresolved or internally resolved CTO questions", async () => {
  for (const disposition of ["existing-specification", "delegated-choice", "user-decision-needed"]) {
    const x = await setup(); await x.submit(); await x.review(disposition);
    const dto = await readUserCtoQuestions(W, P, x.platform);
    assert.equal(dto!.board.questions.length, disposition === "user-decision-needed" ? 1 : 0);
    assert.equal(await readUserCtoQuestions(W, "other-project", x.platform), null);
  }
});

test("out-of-scope nodes, wrong caller and cancelled CTO runs cannot add a proposal", async () => {
  const x = await setup(), before = x.f.writes;
  await assert.rejects(submitCtoQuestion({ ...x.input, proposal: { ...x.proposal, scopeNodeIds: ["other-node"] } }, x.context, x.platform), /assigned/);
  await assert.rejects(submitCtoQuestion(x.input, ctx(), x.platform));
  await assert.rejects(submitCtoQuestion({ ...x.input, ctoId: "other-cto" }, x.context, x.platform));
  x.runs.set(x.runId, { ...x.runs.get(x.runId)!, cancellationRequested: true, termination: "pending" });
  await assert.rejects(x.submit(), /active uncancelled/);
  assert.equal(x.f.writes, before);
});

test("a superseded specification cannot submit, be reviewed or appear as a current user decision", async () => {
  const x = await setup(); await x.submit();
  await createWorkstreamStore(W, P, x.state).publish({ expectedBaseRevisionId: "board-1", revision: {
    projectId: P, revisionId: "board-new", workstreams: [{ ...x.instruction,
      spec: { ...x.instruction.spec, revision: 2 }, change: { ...x.instruction.change, previousRevision: 1 } }],
  } });
  await assert.rejects(x.submit(), /no longer current/);
  await assert.rejects(x.review(), /assignment or specification changed/);
  assert.deepEqual((await readUserCtoQuestions(W, P, x.platform))!.board.questions, []);
});

test("a review requires real pinned record references and cannot overwrite a previous review", async () => {
  const x = await setup(); await x.submit();
  await assert.rejects(x.review("user-decision-needed", []), /must cite/);
  await assert.rejects(x.review("existing-specification", ["invented:approved"]), /must cite/);
  assert.equal((await x.store.current())!.sequence, 1);
  await x.review("existing-specification");
  await assert.rejects(reviewCtoQuestion({ projectId: P, questionId: x.proposal.id, expectedBaseRevisionId: "question-board-2",
    revisionId: "question-board-3", reviewId: "review-2", disposition: "user-decision-needed", rationale: "Overwrite",
    evidenceRefs: ["baseline:baseline-1"] }, x.intake, x.platform), /already has a review/);
  assert.equal((await x.store.current())!.sequence, 2);
});

test("CAS conflicts and lost replies retain readable intake history without automatic resend", async () => {
  const x = await setup(); let lost = false;
  x.setAfterCas(async input => {
    if (!lost && input.stateKey.startsWith("cto-questions-head")) { lost = true; throw new Error("Lost intake reply"); }
  });
  await assert.rejects(x.submit(), /Lost intake reply/);
  assert.equal((await x.store.current())!.sequence, 1);
  const before = x.f.writes;
  assert.equal((await x.submit()).data && x.f.writes, before);
  await assert.rejects(readCtoQuestions({ projectId: P }, { ...x.intake, companyId: randomUUID() }, x.platform));
  assert.equal(x.f.sends, 1);
});

test("parallel independent CTO proposals publish only one project head with an explicit conflict", async () => {
  const x = await setup();
  const results = await Promise.all([x.submit(), submitCtoQuestion({ ...x.input, revisionId: "competing-board",
    proposal: { ...x.proposal, id: "another-question" } }, x.context, x.platform)]);
  assert.equal(results.filter(row => (row.data as { status: string }).status === "published").length, 1);
  assert.equal(results.filter(row => (row.data as { status: string }).status === "conflict").length, 1);
  assert.equal((await x.store.current())!.revision.questions.length, 1);
});

test("retiring the reporter during publication never claims the already committed proposal was rolled back", async () => {
  const x = await setup();
  x.setAfterCas(async input => {
    if (input.stateKey.startsWith("cto-questions-head")) x.values.set(mapKey(x.registryKey), {
      schemaVersion: 1, workspaceId: W, projectId: P, revision: 2, ctos: [{ ...x.cto, status: "RETIRED" }],
    });
  });
  await assert.rejects(x.submit(), /authority changed/);
  assert.equal((await x.store.current())!.revision.questions.length, 1);
  assert.equal(x.f.sends, 1);
});

test("a cancelled intake Lead or missing CAS cannot publish a review", async () => {
  for (const kind of ["cancelled", "cas"] as const) {
    const x = await setup(); await x.submit();
    if (kind === "cancelled") {
      const original = x.platform.agents.sessions.getRun;
      x.platform.agents.sessions.getRun = async (...args) => {
        const run = await original(...args);
        return args[0] === x.intakeSession ? { ...run, cancellationRequested: true, termination: "pending" } : run;
      };
      await assert.rejects(x.review());
    } else {
      await x.seedIntake();
      x.platform.state.compareAndSet = undefined;
      await assert.rejects(x.reviewDirect());
    }
    assert.equal((await x.store.current())!.revision.questions[0]!.review, null);
  }
});

test("review requires an exact Core-admitted intake journal, matching receipt and the intake Lead session", async () => {
  const x = await setup(); await x.submit();
  await assert.rejects(x.reviewDirect(), /recorded question intake/);
  assert.equal((await x.store.current())!.revision.questions[0]!.review, null);
  const requestId = await x.seedIntake();
  assert(requestId);
  assert.equal((await x.platform.agents.sessions.getRequest(x.intakeSession, W, requestId))?.runId, x.intakeRun);
  assert.equal(await x.platform.agents.sessions.getRequest(x.intakeSession, W, randomUUID()), null);
  x.setIntakeReceiptRunId(randomUUID());
  await assert.rejects(x.reviewDirect(), /actual Core receipt/);
  await assert.rejects(x.reviewDirect(ctx()), /prepared CTO-intake Lead session/);
  assert.equal((await x.store.current())!.revision.questions[0]!.review, null);
  x.setIntakeReceiptRunId(x.intakeRun);
  await x.reviewDirect();
  assert.equal((await x.store.current())!.revision.questions[0]!.review!.reviewer.runId, x.intakeRun);
});

test("the reporting CTO can reconcile its own question without reading another CTO's proposal", async () => {
  const x = await setup(); await x.submit();
  const input = { projectId: P, ctoId: CTO, workstreamId: "ws-1", questionId: x.proposal.id };
  const read = await readOwnCtoQuestion(input, x.context, x.platform);
  assert.equal((read.data as { boardRevisionId: string }).boardRevisionId, "question-board-1");
  assert.equal((read.data as { question: { proposal: { id: string } } }).question.proposal.id, x.proposal.id);
  const current = (await x.store.current())!.revision;
  await x.store.publish({ expectedBaseRevisionId: "question-board-1", revision: { ...current, revisionId: "other-reporter-board",
    questions: [{ ...current.questions[0]!, proposal: { ...x.proposal, id: "another-cto-question", context: "Private other CTO question" },
      reporter: { ...current.questions[0]!.reporter, ctoId: "other-cto" } }, ...current.questions] } });
  const hidden = await readOwnCtoQuestion({ ...input, questionId: "another-cto-question" }, x.context, x.platform);
  assert.equal((hidden.data as { question: unknown }).question, null);
  assert.doesNotMatch(JSON.stringify(hidden), /Private other CTO/);
  await assert.rejects(readOwnCtoQuestion(input, ctx(), x.platform));
  await assert.rejects(readOwnCtoQuestion({ ...input, ctoId: "other-cto" }, x.context, x.platform));
});
