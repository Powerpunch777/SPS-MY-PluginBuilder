import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkstreamBoard,
  parseWorkstreamChange,
  parseWorkstreamSpec,
  type WorkstreamRecord,
} from "../src/domain/workstreams.ts";

const projectId = "project-1";
const agentId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-11-02T01:02:03.004Z";
const digest = "a".repeat(64);

function spec(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    id: "WS-001",
    revision: 1,
    sourceSpecRevisionId: "SPEC-004",
    assignedCtoId: "CTO-001",
    title: "Authentication API",
    goal: "Provide the approved authentication flow.",
    scopeNodeIds: ["auth-api", "token-session"],
    included: ["API and contract tests"],
    excluded: ["Billing"],
    dependencies: ["WS-002 provides the user model"],
    interfaceContracts: ["auth-contract-v2"],
    technologyDecisionsRef: "TECH-DEC-003@rev2",
    reuseCandidates: ["Existing approved components"],
    acceptance: ["API contract passes"],
    evidenceRequired: ["PR and test result"],
    openQuestions: ["Q-001"],
    ...overrides,
  };
}

function change(overrides: Record<string, unknown> = {}) {
  return {
    previousRevision: null,
    reason: "Initial assignment",
    diff: "Create the first workstream revision.",
    impactNodeIds: ["auth-api"],
    impactInterfaceContracts: ["auth-contract-v2"],
    impactTaskIds: [],
    effectiveFrom: "Immediately",
    ...overrides,
  };
}

function workstream(overrides: Record<string, unknown> = {}): WorkstreamRecord {
  return {
    spec: spec(),
    sourceBaselineRevisionId: "BASELINE-001",
    baselineDigest: digest,
    technologyDigest: "b".repeat(64),
    ctoAgentId: agentId,
    ctoSessionId: sessionId,
    author: { agentId, sessionId, runId, selectionRevision: 1 },
    createdAt: timestamp,
    change: change(),
    receipt: null,
    ...overrides,
  } as WorkstreamRecord;
}

function board(workstreams: unknown[] = [workstream()], overrides: Record<string, unknown> = {}) {
  return { projectId, revisionId: "BOARD-001", workstreams, ...overrides };
}

test("parses the exact spec shape into a detached deeply frozen snapshot", () => {
  const input = spec();
  const parsed = parseWorkstreamSpec(input, projectId);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.scopeNodeIds, input.scopeNodeIds);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.scopeNodeIds));
  assert(Object.isFrozen(parsed.included));
  (input.scopeNodeIds as string[]).push("later-mutation");
  assert.deepEqual(parsed.scopeNodeIds, ["auth-api", "token-session"]);
});

test("validates project scope, exact keys, safe revisions, required fields and duplicate collections", () => {
  assert.throws(() => parseWorkstreamSpec(spec({ projectId: "project-2" }), projectId), /does not match/);
  assert.throws(() => parseWorkstreamSpec(spec({ extra: true }), projectId), /unknown or missing fields/);
  assert.throws(() => parseWorkstreamSpec(spec({ revision: Number.MAX_SAFE_INTEGER + 1 }), projectId), /positive safe integer/);
  assert.throws(() => parseWorkstreamSpec(spec({ revision: 0 }), projectId), /positive safe integer/);
  for (const field of ["scopeNodeIds", "included", "acceptance", "evidenceRequired"] as const) {
    assert.throws(() => parseWorkstreamSpec(spec({ [field]: [] }), projectId), /must not be empty/);
  }
  assert.throws(() => parseWorkstreamSpec(spec({ scopeNodeIds: ["same", "same"] }), projectId), /unique/);
  assert.throws(() => parseWorkstreamSpec(spec({ included: ["same", "same"] }), projectId), /unique/);
  assert.throws(() => parseWorkstreamSpec(spec({ interfaceContracts: ["same", "same"] }), projectId), /unique/);
  assert.throws(() => parseWorkstreamSpec(spec({ openQuestions: ["same", "same"] }), projectId), /unique/);
  assert.deepEqual(parseWorkstreamSpec(spec({ excluded: [], dependencies: [], reuseCandidates: [] }), projectId).excluded, []);
});

test("rejects getters, symbols, custom prototypes and non-enumerable fields without running accessors", () => {
  let calls = 0;
  const accessor = spec();
  Object.defineProperty(accessor, "title", { enumerable: true, get() { calls += 1; return "Title"; } });
  assert.throws(() => parseWorkstreamSpec(accessor, projectId), /data field/);
  assert.equal(calls, 0);
  const symbol = spec();
  Object.defineProperty(symbol, Symbol("hidden"), { value: true });
  assert.throws(() => parseWorkstreamSpec(symbol, projectId), /unknown or missing fields/);
  assert.throws(() => parseWorkstreamSpec(Object.assign(Object.create({ inherited: true }), spec()), projectId), /plain record/);
  const hidden = spec();
  Object.defineProperty(hidden, "title", { value: "Hidden", enumerable: false });
  assert.throws(() => parseWorkstreamSpec(hidden, projectId), /data field/);
});

test("enforces identifier and UTF-8 byte limits", () => {
  assert.throws(() => parseWorkstreamSpec(spec({ id: "bad\u0000id" }), projectId), /ASCII controls/);
  assert.throws(() => parseWorkstreamSpec(spec({ id: "x".repeat(161) }), projectId), /160 characters/);
  assert.throws(() => parseWorkstreamSpec(spec({ title: "😀".repeat(129) }), projectId), /512 UTF-8 bytes/);
  assert.equal(parseWorkstreamSpec(spec({ title: "😀".repeat(128) }), projectId).title.length, 256);
  assert.throws(() => parseWorkstreamSpec(spec({ goal: "é".repeat(2_049) }), projectId), /4096 UTF-8 bytes/);
  assert.throws(() => parseWorkstreamSpec(spec({ acceptance: [" "] }), projectId), /nonblank/);
  assert.throws(() => parseWorkstreamSpec(spec({ excluded: ["x".repeat(4_097)] }), projectId), /4096 UTF-8 bytes/);
});

test("rejects sparse, accessor, symbol and extended arrays", () => {
  const sparse = new Array(1);
  assert.throws(() => parseWorkstreamSpec(spec({ scopeNodeIds: sparse }), projectId), /dense/);
  const extra = ["node"] as string[] & { named?: boolean };
  extra.named = true;
  assert.throws(() => parseWorkstreamSpec(spec({ scopeNodeIds: extra }), projectId), /extra properties/);
  const symbol = ["node"];
  Object.defineProperty(symbol, Symbol("extra"), { value: true });
  assert.throws(() => parseWorkstreamSpec(spec({ scopeNodeIds: symbol }), projectId), /extra properties/);
  const accessor = ["node"];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => parseWorkstreamSpec(spec({ scopeNodeIds: accessor }), projectId), /dense data/);
});

test("enforces spec serialized size after validating strings", () => {
  assert.throws(() => parseWorkstreamSpec(spec({
    excluded: Array.from({ length: 9 }, (_, index) => `${index}${"x".repeat(4_000)}`),
  }), projectId), /32768-byte limit/);
});

test("validates change fields and returns frozen arrays", () => {
  const parsed = parseWorkstreamChange(change());
  assert.deepEqual(parsed, change());
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.impactNodeIds));
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseWorkstreamChange(change({ previousRevision: invalid })), /positive safe integer/);
  }
  assert.throws(() => parseWorkstreamChange(change({ reason: "\t " })), /nonblank/);
  assert.throws(() => parseWorkstreamChange(change({ diff: "x".repeat(4_097) })), /4096 UTF-8 bytes/);
  assert.throws(() => parseWorkstreamChange(change({ impactTaskIds: ["task", "task"] })), /unique/);
  assert.throws(() => parseWorkstreamChange(change({ surprise: true })), /unknown or missing fields/);
});

test("accepts consistent records and receipts, rejecting identity/revision mismatches", () => {
  const withReceipt = workstream({ receipt: {
    revision: 1, agentId, sessionId, runId, createdAt: timestamp, readiness: "needs-clarification", note: "Waiting on Q-001.",
  } });
  const parsed = parseWorkstreamBoard(board([withReceipt]), projectId);
  assert.deepEqual(parsed.workstreams[0], withReceipt);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.workstreams));
  assert(Object.isFrozen(parsed.workstreams[0]));
  assert(Object.isFrozen(parsed.workstreams[0]?.author));
  assert(Object.isFrozen(parsed.workstreams[0]?.receipt));

  const wrongRevision = workstream({ spec: spec({ revision: 2 }), change: change({ previousRevision: null }) });
  assert.throws(() => parseWorkstreamBoard(board([wrongRevision]), projectId), /spec.revision - 1/);
  assert.throws(() => parseWorkstreamBoard(board([workstream({ receipt: {
    revision: 2, agentId, sessionId, runId, createdAt: timestamp, readiness: "ready", note: "Received.",
  } })]), projectId), /receipt.revision/);
  assert.throws(() => parseWorkstreamBoard(board([workstream({ receipt: {
    revision: 1, agentId, sessionId: runId, runId, createdAt: timestamp, readiness: "ready", note: "Received.",
  } })]), projectId), /identity must match/);
});

test("validates UUID, digest, canonical dates, author revision and exact nested records", () => {
  assert.throws(() => parseWorkstreamBoard(board([workstream({ ctoAgentId: "not-a-uuid" })]), projectId), /canonical UUID/);
  assert.throws(() => parseWorkstreamBoard(board([workstream({ baselineDigest: "A".repeat(64) })]), projectId), /lowercase hexadecimal/);
  assert.throws(() => parseWorkstreamBoard(board([workstream({ technologyDigest: "f".repeat(63) })]), projectId), /lowercase hexadecimal/);
  assert.throws(() => parseWorkstreamBoard(board([workstream({ createdAt: "2026-11-02T01:02:03Z" })]), projectId), /canonical ISO/);
  assert.throws(() => parseWorkstreamBoard(board([workstream({ author: { agentId, sessionId, runId, selectionRevision: 0 } })]), projectId), /positive safe integer/);
  assert.throws(() => parseWorkstreamBoard(board([workstream({ author: { agentId, sessionId, runId, selectionRevision: 1, extra: true } })]), projectId), /unknown or missing fields/);
});

test("enforces board boundary, unique workstream IDs, record count and total size", () => {
  assert.throws(() => parseWorkstreamBoard(board(), "other-project"), /does not match/);
  assert.throws(() => parseWorkstreamBoard(board([workstream(), workstream()]), projectId), /unique spec.id/);
  const tooMany = Array.from({ length: 129 }, (_, index) => workstream({ spec: spec({ id: `WS-${index}` }) }));
  assert.throws(() => parseWorkstreamBoard(board(tooMany), projectId), /at most 128/);
  const bigRecords = Array.from({ length: 9 }, (_, index) => workstream({
    spec: spec({ id: `WS-${index}`, goal: "g".repeat(4_000), included: ["i".repeat(4_000)], acceptance: ["a".repeat(4_000)], evidenceRequired: ["e".repeat(4_000)] }),
  }));
  assert.throws(() => parseWorkstreamBoard(board(bigRecords), projectId), /131072-byte limit/);
});

test("loaded boards preserve one responsible CTO per node but allow that CTO's internal decomposition", () => {
  const second = workstream({ spec: spec({ id: "WS-002" }) });
  assert.equal(parseWorkstreamBoard(board([workstream(), second]), projectId).workstreams.length, 2);
  const sharedOwner = workstream({ spec: spec({ id: "WS-002", assignedCtoId: "CTO-002" }) });
  assert.throws(() => parseWorkstreamBoard(board([workstream(), sharedOwner]), projectId), /one responsible CTO/);
  const independent = workstream({ spec: spec({ id: "WS-002", assignedCtoId: "CTO-002", scopeNodeIds: ["separate-node"] }) });
  assert.equal(parseWorkstreamBoard(board([workstream(), independent]), projectId).workstreams.length, 2);
});
