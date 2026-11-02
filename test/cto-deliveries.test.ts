import assert from "node:assert/strict";
import test from "node:test";
import { ctoDeliveryRequestId, parseCtoDelivery } from "../src/domain/cto-deliveries.ts";
import type { WorkstreamRecord } from "../src/domain/workstreams.ts";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "project-1";
const ctoId = "CTO-001";
const agentId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-11-02T01:02:03.004Z";
const digest = "a".repeat(64);

function instruction(overrides: Record<string, unknown> = {}): WorkstreamRecord {
  return {
    spec: {
      projectId, id: "WS-001", revision: 1, sourceSpecRevisionId: "SPEC-004", assignedCtoId: ctoId,
      title: "Authentication API", goal: "Provide the approved authentication flow.", scopeNodeIds: ["auth-api"],
      included: ["API and contract tests"], excluded: [], dependencies: [], interfaceContracts: [],
      technologyDecisionsRef: "TECH-DEC-003", reuseCandidates: [], acceptance: ["API contract passes"],
      evidenceRequired: ["PR and test result"], openQuestions: [],
    },
    sourceBaselineRevisionId: "BASELINE-001", baselineDigest: digest, technologyDigest: "b".repeat(64),
    ctoAgentId: agentId, ctoSessionId: sessionId,
    author: { agentId, sessionId, runId, selectionRevision: 1 }, createdAt: timestamp,
    change: {
      previousRevision: null, reason: "Initial assignment", diff: "Create the first workstream revision.",
      impactNodeIds: [], impactInterfaceContracts: [], impactTaskIds: [], effectiveFrom: "Immediately",
    },
    receipt: null,
    ...overrides,
  } as WorkstreamRecord;
}

function delivery(overrides: Record<string, unknown> = {}) {
  const workstream = (overrides.instruction as WorkstreamRecord | undefined) ?? instruction();
  const result = {
    schemaVersion: 1,
    workspaceId,
    projectId,
    ctoId,
    revisionId: "DELIVERY-001",
    requestId: ctoDeliveryRequestId(workspaceId, projectId, ctoId, workstream),
    boardRevisionId: "BOARD-001",
    instruction: workstream,
    requestedBy: { agentId, sessionId, runId, selectionRevision: 2 },
    executionPolicy: { mode: "plugin-tools-only-v1", toolNames: ["builder.acknowledge-workstream", "builder.read-cto-workstream"] },
    createdAt: timestamp,
    phase: "prepared",
    runId: null,
    cancellationRequested: false,
    termination: "not_applicable",
    outputState: "not_ready",
    answer: null,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "requestId")) result.requestId = ctoDeliveryRequestId(workspaceId, projectId, ctoId, workstream);
  return result;
}

test("parses an exact scoped delivery into a detached deeply frozen snapshot", () => {
  const input = delivery();
  const parsed = parseCtoDelivery(input, workspaceId, projectId, ctoId);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.requestedBy, input.requestedBy);
  assert.notEqual(parsed.instruction, input.instruction);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.requestedBy));
  assert(Object.isFrozen(parsed.executionPolicy));
  assert(Object.isFrozen(parsed.executionPolicy.toolNames));
  assert(Object.isFrozen(parsed.instruction));
  assert(Object.isFrozen(parsed.instruction.spec.scopeNodeIds));
  (input.instruction.spec.scopeNodeIds as string[]).push("later-change");
  assert.deepEqual(parsed.instruction.spec.scopeNodeIds, ["auth-api"]);
});

test("requires exact scope, canonical request identity and a receipt-free assigned instruction", () => {
  assert.throws(() => parseCtoDelivery(delivery(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId, ctoId), /match the expected scope/);
  assert.throws(() => parseCtoDelivery(delivery(), "not-a-uuid", projectId, ctoId), /workspaceId must be a canonical UUID/);
  assert.throws(() => parseCtoDelivery(delivery(), workspaceId, "other-project", ctoId), /match the expected scope/);
  assert.throws(() => parseCtoDelivery(delivery(), workspaceId, projectId, "other-cto"), /match the expected scope/);
  assert.throws(() => parseCtoDelivery(delivery({ instruction: instruction({ spec: { ...instruction().spec, projectId: "other" } }) }), workspaceId, projectId, ctoId), /does not match/);
  assert.throws(() => parseCtoDelivery(delivery({ instruction: instruction({ spec: { ...instruction().spec, assignedCtoId: "CTO-002" } }) }), workspaceId, projectId, ctoId), /does not match the expected CTO/);
  assert.throws(() => parseCtoDelivery(delivery({ instruction: instruction({ receipt: {
    revision: 1, agentId, sessionId, runId, createdAt: timestamp, readiness: "ready", note: "Received.",
  } }) }), workspaceId, projectId, ctoId), /receipt must be null/);
  assert.throws(() => parseCtoDelivery(delivery({ requestId: "44444444-4444-8444-8444-444444444444" }), workspaceId, projectId, ctoId), /deterministic instruction identity/);
  assert.match(ctoDeliveryRequestId(workspaceId, projectId, ctoId, instruction()), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(ctoDeliveryRequestId(workspaceId, projectId, ctoId, instruction()), ctoDeliveryRequestId(workspaceId, projectId, ctoId, instruction({ spec: { ...instruction().spec, goal: "A different approved goal." } })));
  assert.throws(() => ctoDeliveryRequestId(workspaceId, projectId, "CTO-002", instruction()), /expected CTO/);
  assert.throws(() => ctoDeliveryRequestId("not-a-uuid", projectId, ctoId, instruction()), /workspaceId must be a canonical UUID/);
});

test("new memory-capable policies do not silently expand a historical two-tool intent", () => {
  const legacy = parseCtoDelivery(delivery(), workspaceId, projectId, ctoId);
  assert.deepEqual(legacy.executionPolicy.toolNames, ["builder.acknowledge-workstream", "builder.read-cto-workstream"]);
  const names = ["builder.acknowledge-workstream", "builder.read-cto-memory", "builder.read-cto-workstream", "builder.update-cto-memory"];
  const current = parseCtoDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v1", toolNames: names } }), workspaceId, projectId, ctoId);
  assert.deepEqual(current.executionPolicy.toolNames, names);
  assert.equal(current.requestId, legacy.requestId);
  assert.equal(legacy.executionPolicy.toolNames.includes("builder.read-cto-memory"), false);
  const questionNames = [...names.slice(0, 3), "builder.read-own-cto-question", "builder.submit-cto-question", names[3]];
  const questions = parseCtoDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v1", toolNames: questionNames } }), workspaceId, projectId, ctoId);
  assert.deepEqual(questions.executionPolicy.toolNames, questionNames);
  assert.equal(current.executionPolicy.toolNames.includes("builder.submit-cto-question"), false);
  assert.throws(() => parseCtoDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v1", toolNames: [...names.slice(0, 3), "builder.propose-design"] } }), workspaceId, projectId, ctoId));
});

test("rejects unknown keys, accessors, symbols, custom prototypes and malformed arrays", () => {
  assert.throws(() => parseCtoDelivery({ ...delivery(), extra: true }, workspaceId, projectId, ctoId), /unknown or missing fields/);
  assert.throws(() => parseCtoDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v2", toolNames: ["builder.acknowledge-workstream", "builder.read-cto-workstream"] } }), workspaceId, projectId, ctoId), /mode is unsupported/);
  assert.throws(() => parseCtoDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v1", toolNames: ["builder.read-cto-workstream", "builder.acknowledge-workstream"] } }), workspaceId, projectId, ctoId), /canonical sorted/);
  assert.throws(() => parseCtoDelivery(delivery({ executionPolicy: { mode: "plugin-tools-only-v1", toolNames: ["builder.acknowledge-workstream", "builder.read-cto-workstream", "builder.extra"] } }), workspaceId, projectId, ctoId), /exactly two/);
  const policyAccessor = { mode: "plugin-tools-only-v1", toolNames: ["builder.acknowledge-workstream", "builder.read-cto-workstream"] };
  Object.defineProperty(policyAccessor, "mode", { enumerable: true, get() { calls += 1; return "plugin-tools-only-v1"; } });
  assert.throws(() => parseCtoDelivery(delivery({ executionPolicy: policyAccessor }), workspaceId, projectId, ctoId), /data field/);
  let calls = 0;
  const accessor = delivery();
  Object.defineProperty(accessor, "phase", { enumerable: true, get() { calls += 1; return "prepared"; } });
  assert.throws(() => parseCtoDelivery(accessor, workspaceId, projectId, ctoId), /data field/);
  assert.equal(calls, 0);
  const symbol = delivery();
  Object.defineProperty(symbol, Symbol("hidden"), { value: true });
  assert.throws(() => parseCtoDelivery(symbol, workspaceId, projectId, ctoId), /unknown or missing fields/);
  assert.throws(() => parseCtoDelivery(Object.assign(Object.create({ inherited: true }), delivery()), workspaceId, projectId, ctoId), /plain record/);
  const sparse = instruction({ spec: { ...instruction().spec, scopeNodeIds: new Array(1) } });
  assert.throws(() => parseCtoDelivery(delivery({ instruction: sparse }), workspaceId, projectId, ctoId), /dense/);
});

test("enforces phase, run, cancellation, termination, and answer state relationships", () => {
  assert.equal(parseCtoDelivery(delivery({ phase: "succeeded", runId, outputState: "available", answer: "Done." }), workspaceId, projectId, ctoId).answer, "Done.");
  const superseded = parseCtoDelivery(delivery({ phase: "superseded" }), workspaceId, projectId, ctoId);
  assert.equal(superseded.phase, "superseded");
  assert.equal(superseded.runId, null);
  assert.equal(superseded.cancellationRequested, false);
  assert.equal(superseded.termination, "not_applicable");
  assert.equal(superseded.outputState, "not_ready");
  assert.equal(superseded.answer, null);
  assert.throws(() => parseCtoDelivery(delivery({ phase: "superseded", runId }), workspaceId, projectId, ctoId), /runId does not match phase/);
  assert.throws(() => parseCtoDelivery(delivery({ phase: "superseded", cancellationRequested: true, termination: "pending" }), workspaceId, projectId, ctoId), /cancellation=false/);
  for (const phase of ["submitted", "succeeded", "failed", "cancelled", "interrupted", "timed_out"]) {
    assert.throws(() => parseCtoDelivery(delivery({ phase }), workspaceId, projectId, ctoId), /runId does not match phase/);
  }
  assert.throws(() => parseCtoDelivery(delivery({ phase: "prepared", runId }), workspaceId, projectId, ctoId), /runId does not match phase/);
  assert.throws(() => parseCtoDelivery(delivery({ cancellationRequested: true }), workspaceId, projectId, ctoId), /termination does not match/);
  assert.equal(parseCtoDelivery(delivery({ phase: "submitted", runId, cancellationRequested: true, termination: "pending" }), workspaceId, projectId, ctoId).termination, "pending");
  assert.throws(() => parseCtoDelivery(delivery({ cancellationRequested: false, termination: "confirmed" }), workspaceId, projectId, ctoId), /termination does not match/);
  assert.throws(() => parseCtoDelivery(delivery({ phase: "succeeded", runId, outputState: "available" }), workspaceId, projectId, ctoId), /answer must be present/);
  assert.throws(() => parseCtoDelivery(delivery({ phase: "failed", runId, outputState: "available" }), workspaceId, projectId, ctoId), /answer must be present/);
  assert.throws(() => parseCtoDelivery(delivery({ phase: "failed", runId, outputState: "available", answer: "late answer" }), workspaceId, projectId, ctoId), /answer must be present/);
  assert.throws(() => parseCtoDelivery(delivery({ phase: "failed", runId, answer: "unexpected" }), workspaceId, projectId, ctoId), /answer must be present/);
  assert.equal(parseCtoDelivery(delivery({ phase: "succeeded", runId }), workspaceId, projectId, ctoId).answer, null);
  for (const phase of ["prepared", "dispatching", "uncertain"]) {
    assert.throws(() => parseCtoDelivery(delivery({ phase, cancellationRequested: true, termination: "pending" }), workspaceId, projectId, ctoId), /cancellation=false/);
    assert.throws(() => parseCtoDelivery(delivery({ phase, outputState: "withheld" }), workspaceId, projectId, ctoId), /cancellation=false/);
  }
});

test("enforces UUID, timestamp, identifier, UTF-8 and whole-record bounds", () => {
  assert.throws(() => parseCtoDelivery(delivery({ requestId: "not-a-uuid" }), workspaceId, projectId, ctoId), /canonical UUID/);
  assert.throws(() => parseCtoDelivery(delivery({ requestedBy: { ...delivery().requestedBy, selectionRevision: 0 } }), workspaceId, projectId, ctoId), /positive safe integer/);
  assert.throws(() => parseCtoDelivery(delivery({ requestedBy: { ...delivery().requestedBy, agentId: "not-a-uuid" } }), workspaceId, projectId, ctoId), /requestedBy.agentId must be a canonical UUID/);
  assert.throws(() => parseCtoDelivery(delivery({ requestedBy: { ...delivery().requestedBy, sessionId: "not-a-uuid" } }), workspaceId, projectId, ctoId), /requestedBy.sessionId must be a canonical UUID/);
  assert.throws(() => parseCtoDelivery(delivery({ createdAt: "2026-11-02T01:02:03Z" }), workspaceId, projectId, ctoId), /canonical ISO/);
  assert.throws(() => parseCtoDelivery(delivery({ revisionId: "r".repeat(161) }), workspaceId, projectId, ctoId), /160 characters/);
  assert.throws(() => parseCtoDelivery(delivery({ revisionId: "bad\u0000id" }), workspaceId, projectId, ctoId), /ASCII controls/);
  assert.equal(parseCtoDelivery(delivery({ phase: "succeeded", runId, outputState: "available", answer: "😀".repeat(2_048) }), workspaceId, projectId, ctoId).answer?.length, 4_096);
  assert.throws(() => parseCtoDelivery(delivery({ phase: "succeeded", runId, outputState: "available", answer: "😀".repeat(2_049) }), workspaceId, projectId, ctoId), /8192 UTF-8 bytes/);
  assert.throws(() => parseCtoDelivery(delivery({ phase: "succeeded", runId, outputState: "available", answer: "\ud800" }), workspaceId, projectId, ctoId), /invalid Unicode/);
  assert.equal(parseCtoDelivery(delivery({ phase: "succeeded", runId, outputState: "available", answer: "line\r\n\tbreak" }), workspaceId, projectId, ctoId).answer, "line\r\n\tbreak");
  assert.throws(() => parseCtoDelivery(delivery({ phase: "succeeded", runId, outputState: "available", answer: "bad\u000btext" }), workspaceId, projectId, ctoId), /control characters/);
  assert.throws(() => parseCtoDelivery(delivery({ phase: "succeeded", runId, outputState: "available", answer: "bad\ufffdtext" }), workspaceId, projectId, ctoId), /replacement character/);
  const impacts = (prefix: string) => Array.from({ length: 128 }, (_, index) => `${prefix}${index.toString().padStart(3, "0")}${"x".repeat(150)}`);
  const largeInstruction = instruction({
    spec: { ...instruction().spec, excluded: Array.from({ length: 7 }, () => "x".repeat(4_000)) },
    change: {
      ...instruction().change, impactNodeIds: impacts("n"), impactInterfaceContracts: impacts("i"), impactTaskIds: impacts("t"),
      reason: "r".repeat(4_000), diff: "d".repeat(4_000), effectiveFrom: "e".repeat(4_000),
    },
  });
  assert.throws(() => parseCtoDelivery(delivery({ instruction: largeInstruction }), workspaceId, projectId, ctoId), /98304-byte limit/);
});

test("rejects unsupported fields, invalid Unicode and controls in nested workstream text", () => {
  assert.throws(() => parseCtoDelivery(delivery({ phase: "queued" }), workspaceId, projectId, ctoId), /phase is unsupported/);
  assert.equal(parseCtoDelivery(delivery({ instruction: instruction({ spec: { ...instruction().spec, goal: "line\r\n\ttwo" } }) }), workspaceId, projectId, ctoId).instruction.spec.goal, "line\r\n\ttwo");
  assert.throws(() => parseCtoDelivery(delivery({ instruction: instruction({ spec: { ...instruction().spec, goal: "bad\udfff" } }) }), workspaceId, projectId, ctoId), /invalid Unicode/);
  assert.throws(() => parseCtoDelivery(delivery({ instruction: instruction({ spec: { ...instruction().spec, goal: "bad\ufffdtext" } }) }), workspaceId, projectId, ctoId), /replacement character/);
  assert.throws(() => parseCtoDelivery(delivery({ instruction: instruction({ spec: { ...instruction().spec, goal: "bad\u000btext" } }) }), workspaceId, projectId, ctoId), /control characters/);
});
