import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskPacket,
  parseTaskPacketBoard,
  parseTaskPacketRecord,
  taskPacketRecordDigest,
  type TaskPacketRecord,
} from "../src/domain/task-packets.ts";

const projectId = "project-1";
const ctoId = "CTO-1";
const workstreamId = "WS-1";
const requestId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const instructionSha256 = "a".repeat(64);
const timestamp = "2026-11-02T01:02:03.004Z";

function packet(overrides: Record<string, unknown> = {}) {
  return {
    projectId, ctoId, workstreamId, taskId: "TASK-1", revision: 1, kind: "development",
    title: "Implement endpoint", goal: "Expose the approved endpoint.",
    scopeNodeIds: ["node-1"], requirementIds: ["REQ-1"], dependencies: [],
    included: ["Handler"], excluded: [], constraints: [], acceptance: ["Contract passes"],
    evidenceRequired: ["Test result"], reuse: [], testPlan: null,
    ...overrides,
  };
}

function taskRecord(packetValue = packet(), overrides: Record<string, unknown> = {}): TaskPacketRecord {
  return {
    packet: packetValue,
    source: { requestId, workstreamId, specRevision: 2, instructionSha256 },
    author: { agentId, sessionId, runId }, createdAtISO: timestamp, dependencyPins: [],
    ...overrides,
  } as TaskPacketRecord;
}

function board(packets: unknown[] = [taskRecord()], overrides: Record<string, unknown> = {}) {
  return { projectId, ctoId, workstreamId, revisionId: "BOARD-1", packets, ...overrides };
}

function reuse(overrides: Record<string, unknown> = {}) {
  return {
    id: "LIB-1", sourceUrl: "https://example.com/library", licenseStatus: "unreviewed",
    licenseExpression: null, evidenceRefs: [], compatibilityStatus: "not-verified",
    reuseScope: "Use the parser only", doNotRebuild: "Do not replace the host runtime.", ...overrides,
  };
}

function testPlan() {
  return { environment: "Node 24", steps: ["Run the focused tests"], expectedResults: ["All assertions pass"], passCriteria: ["Exit code is zero"] };
}

test("parses a packet into a detached, deeply frozen snapshot", () => {
  const input = packet();
  const parsed = parseTaskPacket(input, projectId, ctoId, workstreamId);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.scopeNodeIds, input.scopeNodeIds);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.scopeNodeIds));
  (input.scopeNodeIds as string[]).push("later");
  assert.deepEqual(parsed.scopeNodeIds, ["node-1"]);
});

test("checks exact shape, scope, revisions, required lists, uniqueness and limits", () => {
  assert.throws(() => parseTaskPacket(packet({ extra: true }), projectId, ctoId, workstreamId), /unknown or missing/);
  assert.throws(() => parseTaskPacket(packet({ projectId: "other" }), projectId, ctoId, workstreamId), /does not match/);
  assert.throws(() => parseTaskPacket(packet({ ctoId: "other" }), projectId, ctoId, workstreamId), /does not match/);
  assert.throws(() => parseTaskPacket(packet({ workstreamId: "other" }), projectId, ctoId, workstreamId), /does not match/);
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseTaskPacket(packet({ revision }), projectId, ctoId, workstreamId), /positive safe integer/);
  }
  for (const field of ["scopeNodeIds", "requirementIds", "included", "acceptance", "evidenceRequired"] as const) {
    assert.throws(() => parseTaskPacket(packet({ [field]: [] }), projectId, ctoId, workstreamId), /at least 1/);
  }
  assert.throws(() => parseTaskPacket(packet({ scopeNodeIds: ["x", "x"] }), projectId, ctoId, workstreamId), /unique/);
  assert.throws(() => parseTaskPacket(packet({ requirementIds: ["x", "x"] }), projectId, ctoId, workstreamId), /unique/);
  assert.throws(() => parseTaskPacket(packet({ dependencies: ["TASK-1"] }), projectId, ctoId, workstreamId), /must not include/);
  assert.throws(() => parseTaskPacket(packet({ dependencies: ["x", "x"] }), projectId, ctoId, workstreamId), /unique/);
  assert.equal(parseTaskPacket(packet({ excluded: [], constraints: [] }), projectId, ctoId, workstreamId).excluded.length, 0);
});

test("rejects accessors, symbols, custom prototypes, sparse arrays and invalid Unicode", () => {
  let calls = 0;
  const accessor = packet();
  Object.defineProperty(accessor, "title", { enumerable: true, get() { calls += 1; return "title"; } });
  assert.throws(() => parseTaskPacket(accessor, projectId, ctoId, workstreamId), /data field/);
  assert.equal(calls, 0);
  const symbol = packet();
  Object.defineProperty(symbol, Symbol("hidden"), { value: true });
  assert.throws(() => parseTaskPacket(symbol, projectId, ctoId, workstreamId), /unknown or missing/);
  assert.throws(() => parseTaskPacket(Object.assign(Object.create({ inherited: true }), packet()), projectId, ctoId, workstreamId), /plain record/);
  assert.throws(() => parseTaskPacket(packet({ goal: "bad\ud800" }), projectId, ctoId, workstreamId), /invalid Unicode/);
  assert.throws(() => parseTaskPacket(packet({ goal: "bad\ntext" }), projectId, ctoId, workstreamId), /control characters/);
  assert.throws(() => parseTaskPacket(packet({ scopeNodeIds: new Array(1) }), projectId, ctoId, workstreamId), /dense/);
  const extra = ["node"] as string[] & { named?: boolean };
  extra.named = true;
  assert.throws(() => parseTaskPacket(packet({ scopeNodeIds: extra }), projectId, ctoId, workstreamId), /extra properties/);
});

test("enforces identifier lengths, UTF-8 byte limits, text bounds and packet size", () => {
  assert.throws(() => parseTaskPacket(packet({ taskId: "x".repeat(161) }), projectId, ctoId, workstreamId), /160 characters/);
  assert.throws(() => parseTaskPacket(packet({ taskId: "bad\u007f" }), projectId, ctoId, workstreamId), /control characters/);
  assert.throws(() => parseTaskPacket(packet({ title: "😀".repeat(129) }), projectId, ctoId, workstreamId), /512 UTF-8 bytes/);
  assert.equal(parseTaskPacket(packet({ title: "😀".repeat(128) }), projectId, ctoId, workstreamId).title.length, 256);
  assert.throws(() => parseTaskPacket(packet({ goal: "x".repeat(4_097) }), projectId, ctoId, workstreamId), /4096 UTF-8 bytes/);
  assert.throws(() => parseTaskPacket(packet({ included: ["  "] }), projectId, ctoId, workstreamId), /nonblank/);
  assert.throws(() => parseTaskPacket(packet({ included: Array.from({ length: 13 }, (_, i) => `${i}${"x".repeat(4_000)}`) }), projectId, ctoId, workstreamId), /49152-byte limit/);
});

test("validates reuse URLs, licensing and evidence references", () => {
  const reviewed = reuse({ licenseStatus: "reviewed", licenseExpression: "MIT", evidenceRefs: ["LICENSE-1"] });
  assert.deepEqual(parseTaskPacket(packet({ reuse: [reviewed] }), projectId, ctoId, workstreamId).reuse[0], reviewed);
  assert(Object.isFrozen(parseTaskPacket(packet({ reuse: [reviewed] }), projectId, ctoId, workstreamId).reuse[0]));
  assert.throws(() => parseTaskPacket(packet({ reuse: [reuse({ sourceUrl: "http://example.com" })] }), projectId, ctoId, workstreamId), /HTTPS URL/);
  assert.throws(() => parseTaskPacket(packet({ reuse: [reuse({ sourceUrl: "https://user:pass@example.com" })] }), projectId, ctoId, workstreamId), /without credentials/);
  assert.throws(() => parseTaskPacket(packet({ reuse: [reuse({ licenseStatus: "reviewed" })] }), projectId, ctoId, workstreamId), /requires an expression/);
  assert.throws(() => parseTaskPacket(packet({ reuse: [reuse({ licenseExpression: "MIT" })] }), projectId, ctoId, workstreamId), /unreviewed license/);
  assert.throws(() => parseTaskPacket(packet({ reuse: [reuse({ compatibilityStatus: "verified" })] }), projectId, ctoId, workstreamId), /requires evidence/);
  assert.throws(() => parseTaskPacket(packet({ reuse: [reuse(), reuse()] }), projectId, ctoId, workstreamId), /IDs must be unique/);
});

test("requires QA plans and validates/freeze-copies plan arrays", () => {
  assert.throws(() => parseTaskPacket(packet({ kind: "qa" }), projectId, ctoId, workstreamId), /require a testPlan/);
  const parsed = parseTaskPacket(packet({ kind: "qa", testPlan: testPlan() }), projectId, ctoId, workstreamId);
  assert.deepEqual(parsed.testPlan, testPlan());
  assert(Object.isFrozen(parsed.testPlan));
  assert(Object.isFrozen(parsed.testPlan?.steps));
  assert.throws(() => parseTaskPacket(packet({ testPlan: { ...testPlan(), steps: [] } }), projectId, ctoId, workstreamId), /at least 1/);
  assert.throws(() => parseTaskPacket(packet({ testPlan: { ...testPlan(), surprise: true } }), projectId, ctoId, workstreamId), /unknown or missing/);
});

test("parses records, validates provenance and returns frozen nested snapshots", () => {
  const raw = taskRecord(packet({ reuse: [reuse()] }));
  const parsed = parseTaskPacketRecord(raw, projectId, ctoId, workstreamId);
  assert.deepEqual(parsed, raw);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.source));
  assert(Object.isFrozen(parsed.author));
  assert(Object.isFrozen(parsed.dependencyPins));
  assert.throws(() => parseTaskPacketRecord(taskRecord(packet(), { source: { ...raw.source, workstreamId: "other" } }), projectId, ctoId, workstreamId), /must match/);
  assert.throws(() => parseTaskPacketRecord(taskRecord(packet(), { source: { ...raw.source, instructionSha256: "A".repeat(64) } }), projectId, ctoId, workstreamId), /64 lowercase/);
  assert.throws(() => parseTaskPacketRecord(taskRecord(packet(), { author: { agentId: "not-uuid", sessionId, runId } }), projectId, ctoId, workstreamId), /canonical UUID/);
  assert.throws(() => parseTaskPacketRecord(taskRecord(packet(), { createdAtISO: "2026-11-02" }), projectId, ctoId, workstreamId), /canonical ISO/);
});

test("validates latest-per-task board references, matching instruction snapshots and acyclic dependencies", () => {
  const first = taskRecord(packet({ taskId: "TASK-1" }));
  const second = taskRecord(packet({ taskId: "TASK-2", dependencies: ["TASK-1"] }), {
    dependencyPins: [{ taskId: "TASK-1", revision: 1, recordSha256: taskPacketRecordDigest(first, projectId, ctoId, workstreamId) }],
  });
  const parsed = parseTaskPacketBoard(board([first, second]), projectId, ctoId, workstreamId);
  assert.deepEqual(parsed.packets.map(item => item.packet.taskId), ["TASK-1", "TASK-2"]);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.packets));
  assert.throws(() => parseTaskPacketBoard(board([first, first]), projectId, ctoId, workstreamId), /latest record/);
  assert.throws(() => parseTaskPacketBoard(board([second]), projectId, ctoId, workstreamId), /missing from the board/);
  assert.throws(() => parseTaskPacketBoard(board([
    first,
    taskRecord(packet({ taskId: "TASK-2", dependencies: ["TASK-1"] }), {
      source: { requestId, workstreamId, specRevision: 3, instructionSha256 },
      dependencyPins: [{ taskId: "TASK-1", revision: 1, recordSha256: taskPacketRecordDigest(first, projectId, ctoId, workstreamId) }],
    }),
  ]), projectId, ctoId, workstreamId), /same specification revision/);
  const a = taskRecord(packet({ taskId: "TASK-1", revision: 2, dependencies: ["TASK-2"] }), {
    dependencyPins: [{ taskId: "TASK-2", revision: 1, recordSha256: "b".repeat(64) }],
  });
  const b = taskRecord(packet({ taskId: "TASK-2", revision: 2, dependencies: ["TASK-1"] }), {
    dependencyPins: [{ taskId: "TASK-1", revision: 1, recordSha256: "c".repeat(64) }],
  });
  assert.throws(() => parseTaskPacketBoard(board([a, b]), projectId, ctoId, workstreamId), /DAG without cycles/);
  assert.throws(() => parseTaskPacketBoard(board([first], { workstreamId: "other" }), projectId, ctoId, workstreamId), /does not match/);
});

test("pins each dependency revision, verifies equal-revision hashes, and permits old pins as history", () => {
  const target = taskRecord(packet({ revision: 3 }));
  const currentDependent = taskRecord(packet({ taskId: "TASK-2", dependencies: ["TASK-1"] }), {
    dependencyPins: [{ taskId: "TASK-1", revision: 3, recordSha256: taskPacketRecordDigest(target, projectId, ctoId, workstreamId) }],
  });
  assert.doesNotThrow(() => parseTaskPacketBoard(board([target, currentDependent]), projectId, ctoId, workstreamId));

  const historicalDependent = taskRecord(packet({ taskId: "TASK-2", dependencies: ["TASK-1"] }), {
    dependencyPins: [{ taskId: "TASK-1", revision: 2, recordSha256: "d".repeat(64) }],
  });
  assert.doesNotThrow(() => parseTaskPacketBoard(board([target, historicalDependent]), projectId, ctoId, workstreamId));

  assert.throws(() => parseTaskPacketBoard(board([target, taskRecord(packet({ taskId: "TASK-2", dependencies: ["TASK-1"] }), {
    dependencyPins: [{ taskId: "TASK-1", revision: 4, recordSha256: "d".repeat(64) }],
  })]), projectId, ctoId, workstreamId), /newer than the target/);
  assert.throws(() => parseTaskPacketBoard(board([target, taskRecord(packet({ taskId: "TASK-2", dependencies: ["TASK-1"] }), {
    dependencyPins: [{ taskId: "TASK-1", revision: 3, recordSha256: "d".repeat(64) }],
  })]), projectId, ctoId, workstreamId), /does not match the target record digest/);
});

test("requires an exact unique dependency-pin set and hashes canonical parsed record JSON", () => {
  const dependency = taskRecord(packet({ taskId: "TASK-1" }));
  const goodPin = { taskId: "TASK-1", revision: 1, recordSha256: taskPacketRecordDigest(dependency, projectId, ctoId, workstreamId) };
  const dependentPacket = packet({ taskId: "TASK-2", dependencies: ["TASK-1"] });
  assert.throws(() => parseTaskPacketRecord(taskRecord(dependentPacket), projectId, ctoId, workstreamId), /match packet.dependencies exactly/);
  assert.throws(() => parseTaskPacketRecord(taskRecord(dependentPacket, { dependencyPins: [goodPin, goodPin] }), projectId, ctoId, workstreamId), /taskIds must be unique/);
  assert.throws(() => parseTaskPacketRecord(taskRecord(packet(), { dependencyPins: [goodPin] }), projectId, ctoId, workstreamId), /match packet.dependencies exactly/);
  assert.throws(() => parseTaskPacketRecord(taskRecord(dependentPacket, { dependencyPins: [{ ...goodPin, recordSha256: "A".repeat(64) }] }), projectId, ctoId, workstreamId), /64 lowercase/);
  assert.throws(() => parseTaskPacketRecord(taskRecord(dependentPacket, { dependencyPins: [{ ...goodPin, revision: 0 }] }), projectId, ctoId, workstreamId), /positive safe integer/);
  assert.equal(taskPacketRecordDigest(dependency, projectId, ctoId, workstreamId), goodPin.recordSha256);
  assert.notEqual(taskPacketRecordDigest(taskRecord(packet({ title: "Changed" })), projectId, ctoId, workstreamId), goodPin.recordSha256);
  const accessor = taskRecord();
  Object.defineProperty(accessor, "createdAtISO", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => taskPacketRecordDigest(accessor, projectId, ctoId, workstreamId), /data field/);
});
