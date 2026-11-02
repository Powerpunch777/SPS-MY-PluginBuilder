import assert from "node:assert/strict";
import test from "node:test";
import { parseCtoQuestionBoard, parseCtoQuestionProposal, type CtoQuestionProposal, type CtoQuestionRecord } from "../src/domain/cto-questions.ts";

const projectId = "project-questions";
const agentId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-11-02T01:02:03.004Z";
const digest = "a".repeat(64);

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "Q-001",
    title: "Choose the authentication token lifetime",
    context: "The current design leaves token duration open.",
    reasonNeeded: "The API contract needs one bounded duration.",
    options: [
      { id: "short", label: "Short-lived tokens", tradeoff: "More frequent refreshes improve containment." },
      { id: "long", label: "Long-lived tokens", tradeoff: "Fewer refreshes increase exposure duration." },
    ],
    recommendation: "short",
    delayImpact: "The contract cannot be finalized until this is resolved.",
    scopeNodeIds: ["auth-api"],
    evidenceRefs: ["baseline:BASELINE-1"],
    ...overrides,
  };
}

function reviewer(overrides: Record<string, unknown> = {}) {
  return { agentId, sessionId, runId, selectionRevision: 2, ...overrides };
}

function question(overrides: Record<string, unknown> = {}) {
  return {
    proposal: proposal(),
    reporter: { ctoId: "CTO-001", agentId, sessionId, runId, requestId, workstreamId: "WS-001", specRevision: 3, instructionSha256: digest },
    createdAtISO: timestamp,
    review: null,
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return { reviewId: "REVIEW-1", reviewer: reviewer(), disposition: "user-decision-needed", rationale: "The options change the external security posture.",
    evidenceRefs: ["source:SEC-1"], createdAtISO: timestamp, ...overrides };
}

function board(questions: unknown[] = [question()], overrides: Record<string, unknown> = {}) {
  return { projectId, revisionId: "QUESTIONS-1", questions, ...overrides };
}

test("parses proposal into a detached deeply frozen exact snapshot", () => {
  const input = proposal();
  const parsed = parseCtoQuestionProposal(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.options, input.options);
  assert.notEqual(parsed.options[0], input.options[0]);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.options));
  assert(Object.isFrozen(parsed.options[0]));
  assert(Object.isFrozen(parsed.scopeNodeIds));
  assert(Object.isFrozen(parsed.evidenceRefs));
  (input.options[0] as { label: string }).label = "Changed after parse";
  (input.scopeNodeIds as string[]).push("later");
  assert.equal(parsed.options[0]?.label, "Short-lived tokens");
  assert.deepEqual(parsed.scopeNodeIds, ["auth-api"]);
  assert.equal(parseCtoQuestionProposal(proposal({ recommendation: null })).recommendation, null);
});

test("recommendation is null or an exact bounded option ID, including multibyte IDs", () => {
  assert.equal(parseCtoQuestionProposal(proposal({ recommendation: "short" })).recommendation, "short");
  assert.equal(parseCtoQuestionProposal(proposal({ recommendation: null })).recommendation, null);
  assert.throws(() => parseCtoQuestionProposal(proposal({ recommendation: "Recommendation text" })), /must match an option ID or be null/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ recommendation: "missing-option" })), /must match an option ID or be null/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ recommendation: "none" })), /must match an option ID or be null/);
  const multibyteId = "選".repeat(160);
  const options = [{ id: multibyteId, label: "Option A", tradeoff: "A tradeoff." }, { id: "other", label: "Option B", tradeoff: "Another tradeoff." }];
  assert.equal(parseCtoQuestionProposal(proposal({ options, recommendation: multibyteId })).recommendation, multibyteId);
  assert.throws(() => parseCtoQuestionProposal(proposal({
    options: [{ ...options[0], id: `${multibyteId}選` }, options[1]], recommendation: `${multibyteId}選`,
  })), /160 characters/);
});

test("parses a board with an optional exact review and freezes all nested values", () => {
  const input = board([question({ review: review() })]);
  const parsed = parseCtoQuestionBoard(input, projectId);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.questions));
  assert(Object.isFrozen(parsed.questions[0]));
  assert(Object.isFrozen(parsed.questions[0]?.reporter));
  assert(Object.isFrozen(parsed.questions[0]?.review));
  assert(Object.isFrozen(parsed.questions[0]?.review?.reviewer));
  assert(Object.isFrozen(parsed.questions[0]?.review?.evidenceRefs));
  assert.equal(parseCtoQuestionBoard(board([]), projectId).questions.length, 0);
});

test("requires exact project scope and unique proposal IDs across the board", () => {
  assert.throws(() => parseCtoQuestionBoard(board(), "another-project"), /does not match the expected project/);
  assert.throws(() => parseCtoQuestionBoard(board([question(), question()]), projectId), /proposal.id is duplicated/);
  assert.throws(() => parseCtoQuestionBoard(board([], { extra: true }), projectId), /unknown or missing fields/);
});

test("rejects unknown keys, accessors, symbols, custom prototypes, and hidden properties", () => {
  assert.throws(() => parseCtoQuestionProposal({ ...proposal(), extra: true }), /unknown or missing fields/);
  assert.throws(() => parseCtoQuestionProposal(Object.assign(Object.create({ inherited: true }), proposal())), /plain record/);
  let calls = 0;
  const accessor = proposal();
  Object.defineProperty(accessor, "title", { enumerable: true, get() { calls += 1; return "title"; } });
  assert.throws(() => parseCtoQuestionProposal(accessor), /enumerable data field/);
  assert.equal(calls, 0);
  const symbol = proposal();
  Object.defineProperty(symbol, Symbol("extra"), { value: true });
  assert.throws(() => parseCtoQuestionProposal(symbol), /unknown or missing fields/);
  const optionAccessor = proposal();
  const options = optionAccessor.options as object[];
  Object.defineProperty(options[0], "label", { enumerable: true, get() { calls += 1; return "x"; } });
  assert.throws(() => parseCtoQuestionProposal(optionAccessor), /enumerable data field/);
  assert.equal(calls, 0);
  const hidden = proposal();
  Object.defineProperty(hidden, "title", { value: hidden.title, enumerable: false });
  assert.throws(() => parseCtoQuestionProposal(hidden), /enumerable data field/);
});

test("rejects sparse, accessor, symbol, and extended arrays", () => {
  assert.throws(() => parseCtoQuestionProposal(proposal({ options: new Array(2) })), /dense/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ options: [proposal().options[0]] })), /2 through 8/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: "Label", tradeoff: "Tradeoff" })) })), /2 through 8/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ scopeNodeIds: [] })), /1 through 64/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ scopeNodeIds: new Array(1) })), /dense/);
  const accessorArray = ["auth-api"];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get() { throw new Error("getter ran"); } });
  assert.throws(() => parseCtoQuestionProposal(proposal({ scopeNodeIds: accessorArray })), /dense data fields/);
  const symbolArray = ["auth-api"];
  Object.defineProperty(symbolArray, Symbol("extra"), { value: true });
  assert.throws(() => parseCtoQuestionProposal(proposal({ scopeNodeIds: symbolArray })), /extra properties/);
  assert.throws(() => parseCtoQuestionBoard(board(new Array(1)), projectId), /dense/);
  assert.throws(() => parseCtoQuestionBoard(board(Array.from({ length: 65 }, (_, i) => question({ proposal: proposal({ id: `Q-${i}` }) }))), projectId), /0 through 64/);
});

test("enforces identifiers, unique IDs, required option counts and bounded references", () => {
  assert.throws(() => parseCtoQuestionProposal(proposal({ id: "x".repeat(161) })), /160 characters/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ options: [proposal().options[0], { ...proposal().options[1], id: "short" }] })), /duplicated/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ scopeNodeIds: ["same", "same"] })), /unique identifiers/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ scopeNodeIds: Array.from({ length: 65 }, (_, i) => `node-${i}`) })), /1 through 64/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ evidenceRefs: Array.from({ length: 33 }, (_, i) => `ref-${i}`) })), /0 through 32/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ evidenceRefs: ["same", "same"] })), /unique identifiers/);
  assert.throws(() => parseCtoQuestionProposal(proposal({ evidenceRefs: ["x".repeat(161)] })), /160 characters/);
});

test("validates UTF-8 text limits, normal line breaks, controls and Unicode scalar values", () => {
  assert.equal(parseCtoQuestionProposal(proposal({ context: "line\r\n\ttwo" })).context, "line\r\n\ttwo");
  assert.equal(parseCtoQuestionProposal(proposal({ title: "é".repeat(256) })).title.length, 256);
  assert.throws(() => parseCtoQuestionProposal(proposal({ title: "é".repeat(257) })), /512 UTF-8 bytes/);
  assert.equal(parseCtoQuestionProposal(proposal({ context: "é".repeat(2_048) })).context.length, 2_048);
  assert.throws(() => parseCtoQuestionProposal(proposal({ context: "é".repeat(2_049) })), /4096 UTF-8 bytes/);
  for (const bad of ["bad\u0000text", "bad\u000btext", "bad\u007ftext", "bad\ufffdtext", "bad\ud800text", "bad\udffftext"]) {
    assert.throws(() => parseCtoQuestionProposal(proposal({ reasonNeeded: bad })));
  }
  assert.throws(() => parseCtoQuestionProposal(proposal({ id: "bad\nidentifier" })), /without controls/);
});

test("validates reporter and reviewer shape, digests, revisions, dispositions and timestamps", () => {
  const invalidReporters = [
    { ...question().reporter, extra: true },
    { ...question().reporter, agentId: "not-a-uuid" },
    { ...question().reporter, requestId: "not-a-uuid" },
    { ...question().reporter, workstreamId: "x".repeat(161) },
    { ...question().reporter, specRevision: 0 },
    { ...question().reporter, instructionSha256: "A".repeat(64) },
  ];
  for (const reporter of invalidReporters) assert.throws(() => parseCtoQuestionBoard(board([question({ reporter })]), projectId));
  assert.throws(() => parseCtoQuestionBoard(board([question({ createdAtISO: "2026-11-02T01:02:03Z" })]), projectId), /canonical ISO/);
  assert.throws(() => parseCtoQuestionBoard(board([question({ review: review({ reviewer: reviewer({ sessionId: "bad" }) }) })]), projectId), /canonical lowercase UUID/);
  assert.throws(() => parseCtoQuestionBoard(board([question({ review: review({ reviewer: reviewer({ selectionRevision: 0 }) }) })]), projectId), /positive safe integer/);
  assert.throws(() => parseCtoQuestionBoard(board([question({ review: review({ disposition: "approved" }) })]), projectId), /disposition is unsupported/);
  assert.throws(() => parseCtoQuestionBoard(board([question({ review: review({ extra: true }) })]), projectId), /unknown or missing fields/);
});

test("enforces proposal and full-board serialized JSON bounds", () => {
  const largeOptions = Array.from({ length: 8 }, (_, index) => ({ id: `option-${index}`, label: "Option", tradeoff: "x".repeat(4_096) }));
  assert.throws(() => parseCtoQuestionProposal(proposal({ options: largeOptions, recommendation: null })), /32768-byte JSON limit/);
  const accepted = parseCtoQuestionProposal(proposal({ options: largeOptions.slice(0, 7), recommendation: null }));
  assert.equal(accepted.options.length, 7);
  const many = Array.from({ length: 24 }, (_, index) => question({
    proposal: proposal({ id: `Q-${index}`, recommendation: null, options: [
      { id: "a", label: "Option A", tradeoff: "x".repeat(4_000) },
      { id: "b", label: "Option B", tradeoff: "y".repeat(4_000) },
    ] }),
  }));
  assert.throws(() => parseCtoQuestionBoard(board(many), projectId), /196608-byte JSON limit/);
  const ok: CtoQuestionProposal = parseCtoQuestionProposal(proposal());
  const record: CtoQuestionRecord = parseCtoQuestionBoard(board(), projectId).questions[0]!;
  assert.equal(ok.id, record.proposal.id);
});
