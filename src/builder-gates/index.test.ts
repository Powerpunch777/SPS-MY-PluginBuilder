import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { BUILDER_GATE_IDS, BUILDER_GATE_PURPOSES, evaluateBuilderGates, type GateEvidence, type GateRequirement,
  type GateScopeSnapshot, type EvidencePin } from "./index.ts";
import { resolveBuilderGateRegistry, type BuilderGateRegistry } from "./registry.ts";

const bytes = new TextEncoder().encode("stored source revision r2");
const pin: EvidencePin = Object.freeze({ sourceId: "source:spec", revisionId: "spec-r2",
  sha256: createHash("sha256").update(bytes).digest("hex") });
const current: GateScopeSnapshot = Object.freeze({ workspaceId: "workspace-a", projectId: "project-a",
  scopeId: "project-a", revisionId: "project-r2", pins: Object.freeze([pin]) });

function requirement(overrides: Partial<GateRequirement> = {}): GateRequirement {
  return Object.freeze({ gateId: "G4", checkerId: "checker-v1", checkerVersion: "1", requireAuthority: true,
    requireQa: true, ...overrides });
}

function registryFor(snapshot: GateScopeSnapshot, options: { qa?: boolean; checker?: boolean } = {}): BuilderGateRegistry {
  return Object.freeze({
    lookupCurrentScope: async () => ({ status: "found" as const, value: { snapshot, records: {} } }),
    lookupCurrentRevision: async (_scopeId, expected) => ({ status: "found" as const, value: expected }),
    lookupSource: async (sourceId, scopeId, revisionId) => ({ status: "found" as const, value: { sourceId, scopeId, revisionId, bytes } }),
    lookupChecker: options.checker === false ? undefined : async (checkerId, checkerVersion) => ({ status: "found" as const,
      value: { checkerId, checkerVersion, implementation: pin } }),
    lookupIndependentQa: options.qa === false ? undefined : async target => ({ status: "found" as const, value: {
      actorId: "qa-agent", target, command: "node --test", exitCode: 0, result: "passed" as const, report: pin,
    } }),
    resolveAuthority: async () => ({ actorId: "cto-agent", workspaceId: snapshot.workspaceId, scopeId: snapshot.scopeId,
      check: async () => undefined }),
  });
}

async function evidence(snapshot = current, options: { qa?: boolean; checker?: boolean } = {}): Promise<GateEvidence> {
  const resolution = await resolveBuilderGateRegistry({ gateId: "G4", expected: snapshot, checkerId: "checker-v1",
    checkerVersion: "1", authority: { kind: "lead", runContext: {}, platform: {} as never, formalPublication: false },
    requireQa: true, evidenceRefs: [pin] }, registryFor(snapshot, options));
  return Object.freeze({ gateId: "G4", target: snapshot, evidenceRefs: Object.freeze([pin]), registry: resolution });
}

function evaluate(currentScope: GateScopeSnapshot, evidenceItem: GateEvidence | readonly GateEvidence[] | undefined, req = requirement()) {
  const evidenceItems = evidenceItem === undefined ? [] : Array.isArray(evidenceItem) ? evidenceItem : [evidenceItem];
  return evaluateBuilderGates([{ current: currentScope, requirements: [req], evidence: evidenceItems }]).scopes[0];
}

test("reviewed v0.8 defines G0-G7 and missing evidence cannot pass", () => {
  assert.deepEqual(Object.keys(BUILDER_GATE_PURPOSES), [...BUILDER_GATE_IDS]);
  const requirements = BUILDER_GATE_IDS.map(gateId => requirement({ gateId, requireQa: gateId === "G6" }));
  const result = evaluateBuilderGates([{ current, requirements, evidence: [] }]);
  assert.deepEqual(result.scopes[0].gates.map(gate => gate.verdict), Array(8).fill("UNKNOWN"));
});

test("caller-provided registry consistency is useful but cannot authorize PASS", async () => {
  const result = evaluate(current, await evidence());
  assert.equal(result.verdict, "UNKNOWN");
  assert.ok(result.gates[0].reasons.includes("required-lookup:trusted-production-registry-unavailable"));
  assert.equal(result.enforcement, "NOT_ENFORCED");
  assert.match(result.limitations.join(" "), /product acceptance remain unenforced/u);
});

test("missing checker or independent QA provider remains UNKNOWN", async () => {
  assert.equal(evaluate(current, await evidence(current, { checker: false })).verdict, "UNKNOWN");
  assert.equal(evaluate(current, await evidence(current, { qa: false })).verdict, "UNKNOWN");
  const missingG6Qa = evaluate(current, await evidence(), requirement({ gateId: "G6", requireQa: false }));
  assert.ok(missingG6Qa.gates[0].reasons.includes("g6-requires-independent-qa-evidence"));
});

test("caller-created registry PASS text is not a Registry resolution", () => {
  const forged = { gateId: "G4", target: current, evidenceRefs: [pin], registry: { status: "RESOLVED", requiredLookups: [] } } as unknown as GateEvidence;
  const result = evaluate(current, forged);
  assert.equal(result.verdict, "UNKNOWN");
  assert.ok(result.gates[0].reasons.includes("registry-lookups-unresolved-or-untrusted"));
});

test("affected and unaffected scopes retain independent stale-scope findings", async () => {
  const affected = Object.freeze({ ...current, revisionId: "project-r1" });
  const badResolution = await resolveBuilderGateRegistry({ gateId: "G4", expected: affected, checkerId: "checker-v1",
    checkerVersion: "1", authority: { kind: "lead", runContext: {}, platform: {} as never, formalPublication: false },
    requireQa: true, evidenceRefs: [pin] }, registryFor(current));
  const affectedEvidence: GateEvidence = Object.freeze({ gateId: "G4", target: affected, evidenceRefs: [pin], registry: badResolution });
  const unaffectedEvidence = await evidence(current);
  const result = evaluateBuilderGates([
    { current: affected, requirements: [requirement()], evidence: [affectedEvidence] },
    { current, requirements: [requirement()], evidence: [unaffectedEvidence] },
  ]);
  assert.equal(result.scopes[0].verdict, "UNKNOWN");
  assert.equal(result.scopes[1].verdict, "UNKNOWN");
  assert.ok(result.scopes[0].gates[0].reasons.includes("registry-lookups-unresolved-or-untrusted"));
  assert.ok(!result.scopes[1].gates[0].reasons.includes("registry-resolution-scope-or-gate-mismatch"));
  assert.ok(!result.scopes[1].gates[0].reasons.some(reason => reason.includes("lookup-current-scope-current-revision-and-pins")));
});

test("duplicate evidence, stale source and malformed current pins fail closed", async () => {
  const currentEvidence = await evidence();
  assert.ok(evaluate(current, [currentEvidence, currentEvidence])
    .gates[0].reasons.includes("gate-evidence-ambiguous"));
  const invalid = Object.freeze({ ...current, pins: Object.freeze([{ ...pin, sha256: "invalid" }]) });
  assert.equal(evaluate(invalid, await evidence()).verdict, "UNKNOWN");
  const stale = Object.freeze({ ...current, revisionId: "project-r1" });
  assert.equal(evaluate(stale, await evidence()).verdict, "UNKNOWN");
});
