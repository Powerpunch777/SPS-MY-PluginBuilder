import assert from "node:assert/strict";
import test from "node:test";
import { parseCtoUserQuestionsView, projectCtoUserQuestions } from "../src/domain/cto-question-view.ts";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";

const workspaceId = "workspace-1";
const projectId = "project-1";
const id = "11111111-1111-4111-8111-111111111111";
function payload(disposition: string | null = "user-decision-needed") {
  const review = disposition === null ? null : { reviewId: "review-1", reviewer: {
    agentId: id, sessionId: id, runId: id, selectionRevision: 1 }, disposition,
    rationale: "Lead requests a user decision.", evidenceRefs: ["baseline:base-1"], createdAtISO: "2026-11-02T00:00:00.000Z" };
  return { workspaceId, projectId, sequence: 2, board: { projectId, revisionId: "questions-2", questions: [{
    proposal: { id: "q-1", title: "Select a storage mode", context: "The service needs a storage mode.",
      reasonNeeded: "This changes the data contract.", options: [{ id: "local", label: "Local", tradeoff: "Single device" },
        { id: "shared", label: "Shared", tradeoff: "More operations" }], recommendation: "local", delayImpact: "Blocks data work.",
      scopeNodeIds: ["node-1"], evidenceRefs: [] }, reporter: { ctoId: "cto-1", agentId: id, sessionId: id,
      runId: id, requestId: id, workstreamId: "ws-1", specRevision: 1, instructionSha256: "a".repeat(64) },
    createdAtISO: "2026-11-02T00:00:00.000Z", review,
  }] } };
}

test("projects only Lead-reviewed user decisions, without treating CTO recommendation as Lead recommendation", () => {
  const view = parseCtoUserQuestionsView(payload(), workspaceId, projectId);
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  snapshot.questions.push({ id: "legacy-question", title: "Old stored item", text: "Preserved in storage", status: "open",
    options: [], recommendation: null, answer: null, revisionId: null });
  const projected = projectCtoUserQuestions(snapshot, view);
  assert.equal(projected.questions.length, 1);
  assert.notEqual(projected.questions[0]?.id, "legacy-question");
  assert.equal(projected.questions[0]?.status, "open");
  assert.equal(projected.questions[0]?.recommendation, null);
  assert.equal(projected.questions[0]?.ctoRecommendation, "local");
  assert.equal(projected.questions[0]?.answer, null);
  assert.equal(projected.questions[0]?.decisionOrigin, "cto-intake");
  assert.equal(projected.questions[0]?.answerUnavailableReason, "이 CTO 질문의 답변 연결은 아직 준비되지 않았습니다.");
  assert.equal(projected.questions[0]?.questionContext, undefined);
});

test("projection excludes unreviewed and non-user-decision records", () => {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  const noReview = payload(null);
  noReview.board.questions[0]!.proposal.id = "q-2";
  const otherDisposition = payload("delegated-choice");
  otherDisposition.board.questions[0]!.proposal.id = "q-3";
  const merged = { ...payload(), board: { ...payload().board, questions: [...payload().board.questions, ...noReview.board.questions, ...otherDisposition.board.questions] } };
  assert.equal(projectCtoUserQuestions(snapshot, parseCtoUserQuestionsView(merged, workspaceId, projectId)).questions.length, 1);
});

test("view rejects cross-scope, extra envelope fields and malformed boards", () => {
  for (const input of [
    { ...payload(), workspaceId: "other" },
    { ...payload(), projectId: "other" },
    { ...payload(), extra: true },
    { ...payload(), board: { ...payload().board, extra: true } },
  ]) assert.throws(() => parseCtoUserQuestionsView(input, workspaceId, projectId));
  const accessor = payload();
  Object.defineProperty(accessor, "board", { enumerable: true, get() { throw new Error("getter must not run"); } });
  assert.throws(() => parseCtoUserQuestionsView(accessor, workspaceId, projectId));
});
