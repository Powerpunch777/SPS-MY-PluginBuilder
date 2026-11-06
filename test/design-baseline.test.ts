import assert from "node:assert/strict";
import test from "node:test";
import { parseDesignBaseline } from "../src/domain/design-baseline.ts";

const agentId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const leadTurnId = "lead-turn:44444444-4444-4444-8444-444444444444";
const digest = "a".repeat(64);

function validBaseline() {
  return {
    projectId: "project-1",
    revisionId: "baseline-r01",
    sourceDraftRevisionId: "draft-r01",
    draftDigest: digest,
    createdAt: "2026-11-02T01:02:03.004Z",
    author: { agentId, sessionId, runId, selectionRevision: 1 },
    userDecision: { sourceId: leadTurnId, sourceSha256: digest, interpretation: "Build the approved workflow." },
    specification: {
      projectId: "project-1",
      revisionId: "spec-r01",
      productTier: "M",
      requirements: [{ id: "REQ-1", description: "A required feature", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"],
      dataPolicyRef: "policy-r01",
      approvalEvidenceRef: leadTurnId,
    },
    graph: {
      approvedSpecRevisionId: "spec-r01",
      graphRevisionId: "graph-r01",
      entities: [{ id: "feature-a", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] }],
      relations: [],
      viewLayoutRef: "layout-r01",
    },
  };
}

test("accepts a scoped baseline and returns a detached, deeply frozen canonical snapshot", () => {
  const input = validBaseline();
  const parsed = parseDesignBaseline(input, "project-1");

  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.specification, input.specification);
  assert.notEqual(parsed.graph, input.graph);
  assert.equal(parsed.createdAt, "2026-11-02T01:02:03.004Z");
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.author));
  assert(Object.isFrozen(parsed.userDecision));
  assert(Object.isFrozen(parsed.specification));
  assert(Object.isFrozen(parsed.specification.requirements));
  assert(Object.isFrozen(parsed.specification.requirements[0]));
  assert(Object.isFrozen(parsed.graph));
  assert(Object.isFrozen(parsed.graph.entities));
  assert(Object.isFrozen(parsed.graph.entities[0]));
  assert(Object.isFrozen(parsed.graph.entities[0]?.contractRefs));
});

test("rejects mismatched project scope, approval source, graph spec, and unknown spec references", () => {
  assert.throws(() => parseDesignBaseline(validBaseline(), "project-2"), /does not match/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(),
    specification: { ...validBaseline().specification, projectId: "project-2" },
  }, "project-1"), /does not match/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(),
    specification: { ...validBaseline().specification, approvalEvidenceRef: "lead-turn:55555555-5555-4555-8555-555555555555" },
  }, "project-1"), /approvalEvidenceRef/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(),
    graph: { ...validBaseline().graph, approvedSpecRevisionId: "spec-r02" },
  }, "project-1"), /approvedSpecRevisionId/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(),
    graph: { ...validBaseline().graph, entities: [{ id: "feature-a", kind: "feature", specRef: "REQ-404" }] },
  }, "project-1"), /undeclared requirement/);
});

test("requires distinct bounded revision IDs and rejects ASCII controls", () => {
  assert.throws(() => parseDesignBaseline({ ...validBaseline(), revisionId: "draft-r01" }, "project-1"), /must differ/);
  assert.throws(() => parseDesignBaseline({ ...validBaseline(), revisionId: `x${"x".repeat(160)}` }, "project-1"), /160 characters/);
  assert.throws(() => parseDesignBaseline({ ...validBaseline(), sourceDraftRevisionId: "draft\n1" }, "project-1"), /ASCII controls/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(),
    graph: { ...validBaseline().graph, graphRevisionId: "spec-r01" },
  }, "project-1"), /revision IDs must differ/);
});

test("requires canonical UUIDs, source hashes, and canonical ISO timestamps", () => {
  assert.throws(() => parseDesignBaseline({ ...validBaseline(), createdAt: "2026-11-02T01:02:03Z" }, "project-1"), /canonical ISO/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(), author: { ...validBaseline().author, agentId: "not-a-uuid" },
  }, "project-1"), /canonical UUID/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(), userDecision: { ...validBaseline().userDecision, sourceId: "lead-turn:44444444-4444-4444-7444-444444444444" },
  }, "project-1"), /canonical UUID/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(), userDecision: { ...validBaseline().userDecision, sourceSha256: "A".repeat(64) },
  }, "project-1"), /64 lowercase hexadecimal/);
  assert.throws(() => parseDesignBaseline({ ...validBaseline(), draftDigest: "f".repeat(63) }, "project-1"), /64 lowercase hexadecimal/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(), author: { ...validBaseline().author, selectionRevision: 0 },
  }, "project-1"), /positive safe integer/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(), author: { ...validBaseline().author, selectionRevision: Number.MAX_SAFE_INTEGER + 1 },
  }, "project-1"), /positive safe integer/);
});

test("bounds user interpretation by UTF-8 bytes and final serialized size", () => {
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(),
    userDecision: { ...validBaseline().userDecision, interpretation: "   " },
  }, "project-1"), /nonblank/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(),
    userDecision: { ...validBaseline().userDecision, interpretation: "é".repeat(4097) },
  }, "project-1"), /8192 UTF-8 bytes/);
  assert.throws(() => parseDesignBaseline({
    ...validBaseline(),
    userDecision: { ...validBaseline().userDecision, interpretation: "x".repeat(8193) },
  }, "project-1"), /8192 UTF-8 bytes/);
  const large = validBaseline();
  large.specification.requirements[0]!.description = "x".repeat(8 * 1024);
  large.specification.requirements.push({ id: "REQ-2", description: "y".repeat(8 * 1024), acceptanceCriteriaIds: [] });
  for (let index = 0; index < 20; index += 1) {
    large.specification.requirements.push({ id: `REQ-${index + 3}`, description: "z".repeat(8 * 1024), acceptanceCriteriaIds: [] });
  }
  assert.throws(() => parseDesignBaseline(large, "project-1"), /validated JSON limit/);
});

test("rejects symbols, accessors, and non-exact nested records", () => {
  const withSymbol = validBaseline();
  Object.defineProperty(withSymbol, Symbol("extra"), { value: true, enumerable: true });
  assert.throws(() => parseDesignBaseline(withSymbol, "project-1"), /unknown or missing fields/);

  const withGetter = validBaseline();
  Object.defineProperty(withGetter.author, "runId", { enumerable: true, get: () => runId });
  assert.throws(() => parseDesignBaseline(withGetter, "project-1"), /enumerable data field/);

  assert.throws(() => parseDesignBaseline({
    ...validBaseline(), author: { ...validBaseline().author, extra: "field" },
  }, "project-1"), /unknown or missing fields/);
});
