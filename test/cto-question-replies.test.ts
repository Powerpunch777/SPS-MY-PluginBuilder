import assert from "node:assert/strict";
import test from "node:test";
import {
  CTO_QUESTION_REPLY_EXECUTION_POLICY,
  ctoQuestionReplyRequestId,
  parseCtoQuestionReply,
  type CtoQuestionReplyAnswer,
} from "../src/domain/cto-question-replies.ts";
import type { CtoQuestionRecord } from "../src/domain/cto-questions.ts";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "project-replies";
const questionId = "question-001";
const agentId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-11-02T01:02:03.004Z";
const digest = "a".repeat(64);

function question(overrides: Record<string, unknown> = {}): CtoQuestionRecord {
  return {
    proposal: {
      id: questionId, title: "Choose token lifetime", context: "The assigned work leaves duration open.",
      reasonNeeded: "The contract needs a bounded value.",
      options: [
        { id: "short", label: "Short-lived", tradeoff: "More refresh requests." },
        { id: "long", label: "Long-lived", tradeoff: "Longer exposure." },
      ],
      recommendation: "short", delayImpact: "The endpoint remains blocked.", scopeNodeIds: ["auth-api"], evidenceRefs: [],
    },
    reporter: { ctoId: "CTO-1", agentId, sessionId, runId, requestId, workstreamId: "WS-1", specRevision: 2, instructionSha256: digest },
    createdAtISO: timestamp,
    review: { reviewId: "review-1", reviewer: { agentId, sessionId, runId, selectionRevision: 3 },
      disposition: "delegated-choice", rationale: "This is within the delegated scope.", evidenceRefs: ["workstream:WS-1:2"], createdAtISO: timestamp },
    ...overrides,
  } as CtoQuestionRecord;
}

function answer(overrides: Record<string, unknown> = {}) {
  return { text: "Use the short-lived token option.", selectedOptionId: "short", evidenceRefs: ["baseline:BASELINE-1"], ...overrides };
}

function reply(overrides: Record<string, unknown> = {}) {
  const source = (overrides.question as CtoQuestionRecord | undefined) ?? question();
  const response = (overrides.answer as CtoQuestionReplyAnswer | undefined) ?? answer();
  return {
    schemaVersion: 1, workspaceId, projectId, questionId, revisionId: "reply-1",
    requestId: ctoQuestionReplyRequestId(workspaceId, projectId, source, response), question: source, answer: response,
    createdAtISO: timestamp, executionPolicy: CTO_QUESTION_REPLY_EXECUTION_POLICY, phase: "prepared", runId: null,
    cancellationRequested: false, termination: "not_applicable", acknowledgement: null,
    ...overrides,
  };
}

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return { agentId, sessionId, runId, requestId: reply().requestId, createdAtISO: timestamp,
    understanding: "I understand the selected option and its cited basis.", ...overrides };
}

test("parses an exact reply into detached deeply frozen question, answer and policy", () => {
  const input = reply();
  const parsed = parseCtoQuestionReply(input, workspaceId, projectId, questionId);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.question, input.question);
  assert.notEqual(parsed.answer, input.answer);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.question));
  assert(Object.isFrozen(parsed.question.review));
  assert(Object.isFrozen(parsed.answer));
  assert(Object.isFrozen(parsed.answer.evidenceRefs));
  assert(Object.isFrozen(parsed.executionPolicy));
  assert(Object.isFrozen(parsed.executionPolicy.toolNames));
  assert.deepEqual(parsed.executionPolicy.toolNames, ["builder.acknowledge-cto-question-answer", "builder.read-cto-question-answer"]);
});

test("request ID is canonical UUIDv8 over normalized reviewed question and answer", () => {
  const first = ctoQuestionReplyRequestId(workspaceId, projectId, question(), answer());
  assert.equal(first, ctoQuestionReplyRequestId(workspaceId, projectId, question(), answer()));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(first, ctoQuestionReplyRequestId(workspaceId, projectId, question(), answer({ text: "Different response." })));
  assert.notEqual(first, ctoQuestionReplyRequestId(workspaceId, projectId, question({ createdAtISO: "2026-11-02T01:02:04.004Z" }), answer()));
  assert.notEqual(first, ctoQuestionReplyRequestId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId, question(), answer()));
  let calls = 0;
  const getterAnswer = answer();
  Object.defineProperty(getterAnswer, "text", { enumerable: true, get() { calls += 1; return "ignored"; } });
  assert.throws(() => ctoQuestionReplyRequestId(workspaceId, projectId, question(), getterAnswer), /enumerable data field/);
  assert.equal(calls, 0);
  assert.throws(() => ctoQuestionReplyRequestId(workspaceId, projectId, question(), answer({ text: "x".repeat(8_193) })), /8192 UTF-8 bytes/);
});

test("requires exact scopes and a Lead-reviewed non-user disposition", () => {
  assert.throws(() => parseCtoQuestionReply(reply(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId, questionId), /expected scope/);
  assert.throws(() => parseCtoQuestionReply(reply(), workspaceId, "other-project", questionId), /expected scope/);
  assert.throws(() => parseCtoQuestionReply(reply(), workspaceId, projectId, "other-question"), /expected scope/);
  assert.throws(() => parseCtoQuestionReply(reply({ question: question({ review: null }) }), workspaceId, projectId, questionId), /Lead-reviewed/);
  assert.throws(() => parseCtoQuestionReply(reply({ question: question({ review: { ...question().review!, disposition: "user-decision-needed" } }) }),
    workspaceId, projectId, questionId), /Lead-reviewed/);
  assert.throws(() => parseCtoQuestionReply(reply({ question: question({ proposal: { ...question().proposal, id: "different" } }) }),
    workspaceId, projectId, questionId), /does not match questionId/);
});

test("validates selected option IDs and one to 32 unique evidence identifiers", () => {
  assert.equal(parseCtoQuestionReply(reply({ answer: answer({ selectedOptionId: null }) }), workspaceId, projectId, questionId).answer.selectedOptionId, null);
  assert.throws(() => parseCtoQuestionReply(reply({ answer: answer({ selectedOptionId: "invented" }) }), workspaceId, projectId, questionId), /must match a question option ID/);
  assert.throws(() => parseCtoQuestionReply(reply({ answer: answer({ evidenceRefs: [] }) }), workspaceId, projectId, questionId), /1 through 32/);
  assert.throws(() => parseCtoQuestionReply(reply({ answer: answer({ evidenceRefs: ["same", "same"] }) }), workspaceId, projectId, questionId), /unique identifiers/);
  assert.throws(() => parseCtoQuestionReply(reply({ answer: answer({ evidenceRefs: Array.from({ length: 33 }, (_, index) => `ref-${index}`) }) }),
    workspaceId, projectId, questionId), /1 through 32/);
});

test("rejects extra fields, getters, prototypes, symbols and malformed arrays", () => {
  assert.throws(() => parseCtoQuestionReply({ ...reply(), rawAnswer: "extra" }, workspaceId, projectId, questionId), /unknown or missing fields/);
  assert.throws(() => parseCtoQuestionReply(Object.assign(Object.create({ inherited: true }), reply()), workspaceId, projectId, questionId), /plain record/);
  const symbol = reply();
  Object.defineProperty(symbol, Symbol("extra"), { value: true });
  assert.throws(() => parseCtoQuestionReply(symbol, workspaceId, projectId, questionId), /unknown or missing fields/);
  let calls = 0;
  const getter = reply();
  Object.defineProperty(getter, "phase", { enumerable: true, get() { calls += 1; return "prepared"; } });
  assert.throws(() => parseCtoQuestionReply(getter, workspaceId, projectId, questionId), /enumerable data field/);
  assert.equal(calls, 0);
  const refs = ["baseline:BASELINE-1"];
  Object.defineProperty(refs, "0", { enumerable: true, get() { calls += 1; return "x"; } });
  assert.throws(() => parseCtoQuestionReply(reply({ answer: answer({ evidenceRefs: refs }) }), workspaceId, projectId, questionId), /dense data fields/);
  assert.equal(calls, 0);
  const names = [...CTO_QUESTION_REPLY_EXECUTION_POLICY.toolNames].reverse();
  assert.throws(() => parseCtoQuestionReply(reply({ executionPolicy: { mode: "plugin-tools-only-v1", toolNames: names } }),
    workspaceId, projectId, questionId), /canonical reply policy/);
});

test("validates answer and acknowledgement UTF-8 bounds and rejects unsafe Unicode controls", () => {
  assert.equal(parseCtoQuestionReply(reply({ answer: answer({ text: "é".repeat(4_096) }) }), workspaceId, projectId, questionId).answer.text.length, 4_096);
  assert.throws(() => parseCtoQuestionReply(reply({ answer: answer({ text: "é".repeat(4_097) }) }), workspaceId, projectId, questionId), /8192 UTF-8 bytes/);
  assert.throws(() => parseCtoQuestionReply(reply({ answer: answer({ text: "bad\u000btext" }) }), workspaceId, projectId, questionId), /control-safe text/);
  assert.throws(() => parseCtoQuestionReply(reply({ answer: answer({ text: "bad\ud800" }) }), workspaceId, projectId, questionId), /invalid Unicode/);
  assert.throws(() => parseCtoQuestionReply(reply({ answer: answer({ text: "bad\ufffd" }) }), workspaceId, projectId, questionId), /replacement character/);
  const accepted = parseCtoQuestionReply(reply({ phase: "submitted", runId,
    acknowledgement: acknowledgement({ understanding: "é".repeat(2_048) }) }), workspaceId, projectId, questionId);
  assert.equal(accepted.acknowledgement?.understanding.length, 2_048);
  assert.throws(() => parseCtoQuestionReply(reply({ phase: "submitted", runId,
    acknowledgement: acknowledgement({ understanding: "é".repeat(2_049) }) }), workspaceId, projectId, questionId), /4096 UTF-8 bytes/);
});

test("early phases require no run, cancellation or acknowledgement; all later phases require a run", () => {
  for (const phase of ["prepared", "dispatching", "uncertain", "superseded"]) {
    assert.equal(parseCtoQuestionReply(reply({ phase }), workspaceId, projectId, questionId).acknowledgement, null);
    assert.throws(() => parseCtoQuestionReply(reply({ phase, runId }), workspaceId, projectId, questionId), /runId does not match/);
    assert.throws(() => parseCtoQuestionReply(reply({ phase, cancellationRequested: true, termination: "pending" }),
      workspaceId, projectId, questionId), /cancellation=false/);
    assert.throws(() => parseCtoQuestionReply(reply({ phase, acknowledgement: acknowledgement() }), workspaceId, projectId, questionId), /early reply phases/);
  }
  for (const phase of ["submitted", "succeeded", "failed", "cancelled", "interrupted", "timed_out"]) {
    assert.throws(() => parseCtoQuestionReply(reply({ phase }), workspaceId, projectId, questionId), /runId does not match/);
    assert.equal(parseCtoQuestionReply(reply({ phase, runId }), workspaceId, projectId, questionId).runId, runId);
  }
  assert.throws(() => parseCtoQuestionReply(reply({ phase: "failed", runId, cancellationRequested: false, termination: "pending" }),
    workspaceId, projectId, questionId), /termination does not match/);
  assert.throws(() => parseCtoQuestionReply(reply({ phase: "cancelled", runId, cancellationRequested: true, termination: "not_applicable" }),
    workspaceId, projectId, questionId), /termination does not match/);
});

test("preserves an exact CTO acknowledgement through submitted and every terminal outcome", () => {
  for (const phase of ["submitted", "succeeded", "failed", "cancelled", "interrupted", "timed_out"]) {
    const parsed = parseCtoQuestionReply(reply({ phase, runId, acknowledgement: acknowledgement() }), workspaceId, projectId, questionId);
    assert.equal(parsed.acknowledgement?.agentId, agentId);
    assert.equal(parsed.acknowledgement?.sessionId, sessionId);
    assert.equal(parsed.acknowledgement?.runId, runId);
    assert.equal(parsed.acknowledgement?.requestId, parsed.requestId);
  }
});

test("binds acknowledgements to reporter and exact reply request/run with canonical timestamps", () => {
  for (const bad of [
    acknowledgement({ agentId: "99999999-9999-4999-8999-999999999999" }),
    acknowledgement({ sessionId: "99999999-9999-4999-8999-999999999999" }),
    acknowledgement({ runId: "99999999-9999-4999-8999-999999999999" }),
    acknowledgement({ requestId: "99999999-9999-4999-8999-999999999999" }),
    acknowledgement({ createdAtISO: "2026-11-02T01:02:03Z" }),
  ]) assert.throws(() => parseCtoQuestionReply(reply({ phase: "succeeded", runId, acknowledgement: bad }), workspaceId, projectId, questionId));
  assert.throws(() => parseCtoQuestionReply(reply({ acknowledgement: acknowledgement() }), workspaceId, projectId, questionId), /early reply phases/);
  assert.throws(() => parseCtoQuestionReply(reply({ requestId: "55555555-5555-4555-8555-555555555555" }), workspaceId, projectId, questionId), /deterministic question and answer identity/);
});

test("rejects oversized inherited proposal records and keeps serialized replies within the delivery bound", () => {
  const options = Array.from({ length: 8 }, (_, index) => ({ id: `o-${index}`, label: "Option", tradeoff: "x".repeat(4_096) }));
  assert.throws(() => parseCtoQuestionReply(reply({ question: question({ proposal: { ...question().proposal, options, recommendation: null } }) }),
    workspaceId, projectId, questionId), /32768-byte JSON limit/);
  const parsed = parseCtoQuestionReply(reply({ answer: answer({ text: "x".repeat(8_192) }) }), workspaceId, projectId, questionId);
  assert(Buffer.byteLength(JSON.stringify(parsed), "utf8") < 96 * 1_024);
});
