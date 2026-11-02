import assert from "node:assert/strict";
import test from "node:test";
import {
  CTO_INTAKE_EXECUTION_POLICY,
  ctoIntakeRequestId,
  parseCtoIntakeDelivery,
  type CtoIntakeTarget,
} from "../src/domain/cto-intake-deliveries.ts";
import type { CtoQuestionRecord } from "../src/domain/cto-questions.ts";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "project-intake";
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
      id: questionId,
      title: "Select the authentication token lifetime",
      context: "The current instruction leaves token duration open.",
      reasonNeeded: "The API contract needs one bounded duration.",
      options: [
        { id: "short", label: "Short-lived", tradeoff: "More frequent refreshes." },
        { id: "long", label: "Long-lived", tradeoff: "Longer exposure window." },
      ],
      recommendation: "short",
      delayImpact: "The affected endpoint remains blocked.",
      scopeNodeIds: ["auth-api"],
      evidenceRefs: ["baseline:BASELINE-1"],
    },
    reporter: { ctoId: "CTO-1", agentId, sessionId, runId, requestId, workstreamId: "WS-1", specRevision: 2, instructionSha256: digest },
    createdAtISO: timestamp,
    review: null,
    ...overrides,
  } as CtoQuestionRecord;
}

function target(overrides: Partial<CtoIntakeTarget> = {}): CtoIntakeTarget {
  return { agentId, sessionId, selectionRevision: 3, ...overrides };
}

function delivery(overrides: Record<string, unknown> = {}) {
  const source = (overrides.question as CtoQuestionRecord | undefined) ?? question();
  const selectedTarget = (overrides.target as CtoIntakeTarget | undefined) ?? target();
  return {
    schemaVersion: 1,
    workspaceId,
    projectId,
    questionId,
    revisionId: "intake-delivery-1",
    requestId: ctoIntakeRequestId(workspaceId, projectId, questionId, source, selectedTarget),
    question: source,
    target: selectedTarget,
    executionPolicy: CTO_INTAKE_EXECUTION_POLICY,
    createdAtISO: timestamp,
    phase: "prepared",
    runId: null,
    cancellationRequested: false,
    termination: "not_applicable",
    ...overrides,
  };
}

test("exports an exact sorted nine-tool policy and parses detached deeply frozen delivery", () => {
  const input = delivery();
  const parsed = parseCtoIntakeDelivery(input, workspaceId, projectId, questionId);
  assert.deepEqual(parsed, input);
  assert.deepEqual(parsed.executionPolicy.toolNames, [
    "builder.read-cto-intake", "builder.read-design-baseline", "builder.read-design-draft", "builder.read-design-sources",
    "builder.read-lead-memory", "builder.read-solution", "builder.read-technology-decisions", "builder.read-workstreams",
    "builder.review-cto-question",
  ]);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.question, input.question);
  assert.notEqual(parsed.target, input.target);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.question));
  assert(Object.isFrozen(parsed.question.proposal.options));
  assert(Object.isFrozen(parsed.target));
  assert(Object.isFrozen(parsed.executionPolicy));
  assert(Object.isFrozen(parsed.executionPolicy.toolNames));
});

test("request identity is stable for canonical data and changes with question, scope, or target", () => {
  const first = ctoIntakeRequestId(workspaceId, projectId, questionId, question(), target());
  assert.equal(first, ctoIntakeRequestId(workspaceId, projectId, questionId, question(), target()));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(first, ctoIntakeRequestId(workspaceId, projectId, questionId, question({ createdAtISO: "2026-11-02T01:02:04.004Z" }), target()));
  assert.notEqual(first, ctoIntakeRequestId(workspaceId, projectId, questionId, question(), target({ selectionRevision: 4 })));
  assert.notEqual(first, ctoIntakeRequestId(workspaceId, "other-project", questionId, question(), target()));
  assert.throws(() => ctoIntakeRequestId("not-a-uuid", projectId, questionId, question(), target()), /canonical lowercase UUID/);
  assert.throws(() => ctoIntakeRequestId(workspaceId, projectId, questionId, question({ review: {
    reviewId: "review-1", reviewer: { agentId, sessionId, runId, selectionRevision: 1 }, disposition: "user-decision-needed",
    rationale: "Need a decision.", evidenceRefs: [], createdAtISO: timestamp,
  } }), target()), /review must be null/);
});

test("requires exact workspace, project, question and matching embedded proposal IDs", () => {
  assert.throws(() => parseCtoIntakeDelivery(delivery(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId, questionId), /expected scope/);
  assert.throws(() => parseCtoIntakeDelivery(delivery(), workspaceId, "other-project", questionId), /expected scope/);
  assert.throws(() => parseCtoIntakeDelivery(delivery(), workspaceId, projectId, "other-question"), /expected scope/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ question: question({ proposal: { ...question().proposal, id: "other-question" } }) }),
    workspaceId, projectId, questionId), /does not match questionId/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ question: question({ review: {
    reviewId: "review-1", reviewer: { agentId, sessionId, runId, selectionRevision: 1 }, disposition: "user-decision-needed",
    rationale: "Need a decision.", evidenceRefs: [], createdAtISO: timestamp,
  } }) }), workspaceId, projectId, questionId), /review must be null/);
});

test("requires the exact policy and rejects permutations, additions, accessors and symbols", () => {
  const reversed = [...CTO_INTAKE_EXECUTION_POLICY.toolNames].reverse();
  assert.throws(() => parseCtoIntakeDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v1", toolNames: reversed } }),
    workspaceId, projectId, questionId), /exact canonical sorted/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v1",
    toolNames: [...CTO_INTAKE_EXECUTION_POLICY.toolNames, "builder.dispatch"] } }), workspaceId, projectId, questionId), /exactly 9/);
  const getterNames = [...CTO_INTAKE_EXECUTION_POLICY.toolNames];
  Object.defineProperty(getterNames, "0", { enumerable: true, get() { throw new Error("getter ran"); } });
  assert.throws(() => parseCtoIntakeDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v1", toolNames: getterNames } }),
    workspaceId, projectId, questionId), /data fields/);
  const symbolNames = [...CTO_INTAKE_EXECUTION_POLICY.toolNames];
  Object.defineProperty(symbolNames, Symbol("extra"), { value: true });
  assert.throws(() => parseCtoIntakeDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v1", toolNames: symbolNames } }),
    workspaceId, projectId, questionId), /exactly 9/);
});

test("rejects malformed exact records, prototypes, symbols, accessors and output injection fields", () => {
  assert.throws(() => parseCtoIntakeDelivery({ ...delivery(), answer: "never persisted here" }, workspaceId, projectId, questionId), /unknown or missing fields/);
  assert.throws(() => parseCtoIntakeDelivery(Object.assign(Object.create({ inherited: true }), delivery()), workspaceId, projectId, questionId), /plain record/);
  const symbol = delivery();
  Object.defineProperty(symbol, Symbol("hidden"), { value: true });
  assert.throws(() => parseCtoIntakeDelivery(symbol, workspaceId, projectId, questionId), /unknown or missing fields/);
  let calls = 0;
  const accessor = delivery();
  Object.defineProperty(accessor, "phase", { enumerable: true, get() { calls += 1; return "prepared"; } });
  assert.throws(() => parseCtoIntakeDelivery(accessor, workspaceId, projectId, questionId), /data field/);
  assert.equal(calls, 0);
  const targetAccessor = { ...target() };
  Object.defineProperty(targetAccessor, "sessionId", { enumerable: true, get() { calls += 1; return sessionId; } });
  assert.throws(() => parseCtoIntakeDelivery(delivery({ target: targetAccessor }), workspaceId, projectId, questionId), /data field/);
  assert.equal(calls, 0);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ revisionId: "x".repeat(161) }), workspaceId, projectId, questionId), /160 characters/);
});

test("inherits strict question digest, UUID, identifier, Unicode and text-size validation", () => {
  assert.throws(() => parseCtoIntakeDelivery(delivery({ question: question({ reporter: { ...question().reporter, instructionSha256: "A".repeat(64) } }) }),
    workspaceId, projectId, questionId), /64 lowercase hexadecimal/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ question: question({ reporter: { ...question().reporter, requestId: "not-uuid" } }) }),
    workspaceId, projectId, questionId), /canonical lowercase UUID/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ question: question({ proposal: { ...question().proposal, title: "x".repeat(513) } }) }),
    workspaceId, projectId, questionId), /512 UTF-8 bytes/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ question: question({ proposal: { ...question().proposal, context: "bad\u000btext" } }) }),
    workspaceId, projectId, questionId), /control-safe text/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ question: question({ proposal: { ...question().proposal, context: "bad\ud800" } }) }),
    workspaceId, projectId, questionId), /unpaired surrogate/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ question: question({ proposal: { ...question().proposal, context: "x".repeat(4_097) } }) }),
    workspaceId, projectId, questionId), /4096 UTF-8 bytes/);
});

test("enforces phase, run, cancellation and termination combinations", () => {
  for (const phase of ["prepared", "dispatching", "uncertain", "superseded"]) {
    const parsed = parseCtoIntakeDelivery(delivery({ phase }), workspaceId, projectId, questionId);
    assert.equal(parsed.runId, null);
    assert.throws(() => parseCtoIntakeDelivery(delivery({ phase, runId }), workspaceId, projectId, questionId), /runId does not match/);
    assert.throws(() => parseCtoIntakeDelivery(delivery({ phase, cancellationRequested: true, termination: "pending" }),
      workspaceId, projectId, questionId), /cancellation=false/);
  }
  for (const phase of ["submitted", "succeeded", "failed", "cancelled", "interrupted", "timed_out"]) {
    assert.throws(() => parseCtoIntakeDelivery(delivery({ phase }), workspaceId, projectId, questionId), /runId does not match/);
    assert.equal(parseCtoIntakeDelivery(delivery({ phase, runId }), workspaceId, projectId, questionId).runId, runId);
  }
  assert.equal(parseCtoIntakeDelivery(delivery({ phase: "submitted", runId, cancellationRequested: true, termination: "pending" }),
    workspaceId, projectId, questionId).termination, "pending");
  assert.equal(parseCtoIntakeDelivery(delivery({ phase: "cancelled", runId, cancellationRequested: true, termination: "confirmed" }),
    workspaceId, projectId, questionId).termination, "confirmed");
  assert.throws(() => parseCtoIntakeDelivery(delivery({ phase: "failed", runId, cancellationRequested: false, termination: "pending" }),
    workspaceId, projectId, questionId), /termination does not match/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ phase: "failed", runId, cancellationRequested: true, termination: "not_applicable" }),
    workspaceId, projectId, questionId), /termination does not match/);
});

test("requires canonical timestamps and deterministic UUIDv8 request IDs", () => {
  assert.throws(() => parseCtoIntakeDelivery(delivery({ createdAtISO: "2026-11-02T01:02:03Z" }), workspaceId, projectId, questionId), /canonical ISO/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ requestId: "55555555-5555-4555-8555-555555555555" }),
    workspaceId, projectId, questionId), /deterministic question and target identity/);
  assert.throws(() => parseCtoIntakeDelivery(delivery({ requestId: "not-a-uuid" }), workspaceId, projectId, questionId), /canonical lowercase UUID/);
});

test("rejects oversized inherited question data before accepting an intake delivery", () => {
  const options = Array.from({ length: 8 }, (_, index) => ({ id: `option-${index}`, label: "Option", tradeoff: "x".repeat(4_096) }));
  const tooLarge = question({ proposal: { ...question().proposal, options, recommendation: null } });
  assert.throws(() => parseCtoIntakeDelivery(delivery({ question: tooLarge }), workspaceId, projectId, questionId), /32768-byte JSON limit/);
  const exactlyBounded = question({ proposal: { ...question().proposal, options: options.slice(0, 7), recommendation: null } });
  const parsed = parseCtoIntakeDelivery(delivery({ question: exactlyBounded }), workspaceId, projectId, questionId);
  assert.equal(parsed.question.proposal.options.length, 7);
  assert(Buffer.byteLength(JSON.stringify(parsed), "utf8") < 96 * 1_024);
});
