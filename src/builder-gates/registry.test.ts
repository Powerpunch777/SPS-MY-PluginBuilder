import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskPacketRecord, taskPacketRecordDigest } from "../domain/task-packets.ts";
import { resolveBuilderGateRegistry, type BuilderGateRegistry, type StoredGateScope } from "./registry.ts";
import type { GateScopeSnapshot } from "./index.ts";

const snapshot: GateScopeSnapshot = Object.freeze({ workspaceId: "workspace-1", projectId: "project-1", scopeId: "project-1",
  revisionId: "rev-1", pins: Object.freeze([{ sourceId: "spec-source", revisionId: "rev-1", sha256: "a".repeat(64) }]) });

const id = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;
function packetRecord(taskId: string, dependencies: readonly string[] = [], dependencyPins: readonly object[] = []) {
  return parseTaskPacketRecord({
    packet: { projectId: "project-1", ctoId: "cto-1", workstreamId: "project-1", taskId, revision: 1,
      kind: "development", title: "Fixture task", goal: "Exercise current dependency lookup", scopeNodeIds: ["node-1"],
      requirementIds: ["requirement-1"], dependencies, included: ["bounded test"], excluded: ["other paths"],
      constraints: ["fail closed"], acceptance: ["UNKNOWN on stale dependency"], evidenceRequired: ["registry evidence"],
      reuse: [], testPlan: null },
    source: { requestId: id("1"), workstreamId: "project-1", specRevision: 1, instructionSha256: "b".repeat(64) },
    author: { agentId: id("2"), sessionId: id("3"), runId: id("4") }, createdAtISO: "2026-11-04T00:00:00.000Z",
    dependencyPins,
  }, "project-1", "cto-1", "project-1");
}

function registryInput() {
  return { gateId: "G4" as const, expected: snapshot, checkerId: "checker", checkerVersion: "1",
    authority: { kind: "lead" as const, runContext: null, platform: {} as never, formalPublication: false },
    requireQa: false, evidenceRefs: snapshot.pins };
}

function baseScope(records: StoredGateScope["records"] = {}): StoredGateScope {
  return Object.freeze({ snapshot, records });
}

test("a missing registry adapter reports each required lookup and cannot return authority", async () => {
  const result = await resolveBuilderGateRegistry({ gateId: "G1", expected: snapshot, checkerId: "checker", checkerVersion: "1",
    authority: { kind: "lead", runContext: null, platform: {} as never, formalPublication: true }, requireQa: true,
    evidenceRefs: snapshot.pins }, undefined);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.resolved.authority, null);
  assert.ok(result.requiredLookups.includes("lookup-current-scope"));
  assert.ok(result.requiredLookups.includes("lookup-current-revision-journal"));
  assert.ok(result.requiredLookups.includes("lookup-original-source-bytes"));
  assert.ok(result.requiredLookups.includes("lookup-approved-checker-registry"));
  assert.ok(result.requiredLookups.includes("resolve-current-lead-authority"));
  assert.ok(result.requiredLookups.includes("lookup-independent-qa-evidence"));
});

test("a stale current scope is reported even when other lookup providers are absent", async () => {
  const stale = Object.freeze({ ...snapshot, revisionId: "rev-0" });
  const result = await resolveBuilderGateRegistry({ gateId: "G5", expected: snapshot, checkerId: "impact-checker",
    checkerVersion: "1", authority: { kind: "lead", runContext: null, platform: {} as never, formalPublication: true },
    requireQa: false, evidenceRefs: snapshot.pins }, {
      lookupCurrentScope: async () => ({ status: "found", value: { snapshot: stale, records: {} } }),
    });
  assert.equal(result.status, "UNKNOWN");
  assert.ok(result.requiredLookups.includes("lookup-current-scope-current-revision-and-pins"));
  assert.equal(result.resolved.authority, null);
});

test("null, malformed and throwing provider results fail closed", async () => {
  const providers: BuilderGateRegistry[] = [
    { lookupCurrentScope: async () => null },
    { lookupCurrentScope: async () => ({ status: "found", value: null }) },
    { lookupCurrentScope: async () => ({ status: "found", value: { snapshot: null, records: {} } }) },
    { lookupCurrentScope: async () => { throw new Error("provider failure"); } },
  ] as unknown as BuilderGateRegistry[];
  for (const provider of providers) {
    const result = await resolveBuilderGateRegistry({ gateId: "G1", expected: snapshot, checkerId: "checker", checkerVersion: "1",
      authority: { kind: "lead", runContext: null, platform: {} as never, formalPublication: true }, requireQa: true,
      evidenceRefs: snapshot.pins }, provider);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.resolved.currentScope, null);
    assert.ok(result.requiredLookups.includes("trusted-production-registry-unavailable")
      || result.requiredLookups.includes("registry-provider-malformed-or-threw"));
  }
});

test("a found QA result with a null value is treated as unavailable", async () => {
  const result = await resolveBuilderGateRegistry({ gateId: "G6", expected: snapshot, checkerId: "checker", checkerVersion: "1",
    authority: { kind: "lead", runContext: null, platform: {} as never, formalPublication: true }, requireQa: true,
    evidenceRefs: snapshot.pins }, {
    lookupIndependentQa: async () => ({ status: "found", value: null } as never),
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.resolved.qa, null);
  assert.ok(result.requiredLookups.includes("lookup-independent-qa-evidence"));
});

test("a stored domain record outside the target project is rejected", async () => {
  const result = await resolveBuilderGateRegistry({ gateId: "G3", expected: snapshot, checkerId: "checker", checkerVersion: "1",
    authority: { kind: "lead", runContext: null, platform: {} as never, formalPublication: true }, requireQa: false,
    evidenceRefs: snapshot.pins }, {
    lookupCurrentScope: async () => ({ status: "found", value: { snapshot,
      records: { changeImpact: { workspaceId: snapshot.workspaceId, projectId: "other-project" } } as never } }),
  });
  assert.ok(result.requiredLookups.includes("lookup-current-scope-current-revision-and-pins"));
});

test("changed, missing, and duplicate current task dependency records remain UNKNOWN", async () => {
  const dependency = packetRecord("dependency-1");
  const pin = { taskId: dependency.packet.taskId, revision: dependency.packet.revision,
    recordSha256: taskPacketRecordDigest(dependency, "project-1", "cto-1", "project-1") };
  const parent = packetRecord("parent-1", [dependency.packet.taskId], [pin]);
  const taskScope = Object.freeze({ ...snapshot, scopeId: "parent-1",
    pins: Object.freeze(snapshot.pins.map(pin => ({ ...pin, revisionId: "1" }))) });
  const taskInput = { ...registryInput(), expected: taskScope };
  const run = async (candidates: readonly typeof dependency[]) => resolveBuilderGateRegistry(taskInput, {
    lookupCurrentScope: async () => ({ status: "found", value: { snapshot: taskScope,
      records: { taskPacket: parent, taskDependencies: candidates.map(() => pin) } } }),
    lookupCurrentRevision: async (_scope, expected) => ({ status: "found", value: expected }),
    lookupCurrentTaskDependencies: async () => ({ status: "found", value: candidates }),
  });

  const changed = packetRecord("dependency-1");
  const changedRecord = parseTaskPacketRecord({ ...changed, packet: { ...changed.packet, revision: 2 } }, "project-1", "cto-1", "project-1");
  const changedResult = await run([changedRecord]);
  assert.equal(changedResult.status, "UNKNOWN");
  assert.ok(changedResult.requiredLookups.includes("stale-task-dependency:dependency-1"));

  const missingResult = await run([]);
  assert.equal(missingResult.status, "UNKNOWN");
  assert.ok(missingResult.requiredLookups.includes("lookup-current-task-dependency:dependency-1"));

  const duplicateResult = await run([dependency, dependency]);
  assert.equal(duplicateResult.status, "UNKNOWN");
  assert.ok(duplicateResult.requiredLookups.includes("lookup-current-task-dependency:dependency-1"));
});

test("original source bytes and current revision journal must match their exact pins", async () => {
  const input = registryInput();
  const sourceMismatch = await resolveBuilderGateRegistry(input, {
    lookupCurrentScope: async () => ({ status: "found", value: baseScope() }),
    lookupCurrentRevision: async (_scope, expected) => ({ status: "found", value: expected }),
    lookupSource: async sourceId => ({ status: "found", value: { sourceId, scopeId: snapshot.scopeId,
      revisionId: "rev-1", bytes: new TextEncoder().encode("different original bytes") } }),
  });
  assert.ok(sourceMismatch.requiredLookups.includes("lookup-original-source:spec-source"));

  const revisionMismatch = await resolveBuilderGateRegistry(input, {
    lookupCurrentScope: async () => ({ status: "found", value: baseScope() }),
    lookupCurrentRevision: async () => ({ status: "found", value: { ...snapshot.pins[0], revisionId: "rev-0" } }),
  });
  assert.ok(revisionMismatch.requiredLookups.includes("lookup-current-revision:spec-source"));
  assert.ok(revisionMismatch.requiredLookups.includes("recheck-current-revision:spec-source"));
});

test("authority resolution throws and a failed authority recheck both fail closed", async () => {
  const throwing = await resolveBuilderGateRegistry(registryInput(), { resolveAuthority: async () => { throw new Error("denied"); } });
  assert.ok(throwing.requiredLookups.includes("resolve-current-lead-authority"));
  assert.equal(throwing.resolved.authority, null);

  let checks = 0;
  const recheck = await resolveBuilderGateRegistry(registryInput(), { resolveAuthority: async () => ({ actorId: "lead",
    workspaceId: snapshot.workspaceId, scopeId: snapshot.scopeId, check: async () => { checks += 1; throw new Error("authority changed"); } }) });
  assert.equal(checks, 1);
  assert.ok(recheck.requiredLookups.includes("recheck-current-authority"));
  assert.equal(recheck.resolved.authority, null);
});

test("missing, unavailable, and throwing lookup providers are reported as unavailable", async () => {
  const providers: BuilderGateRegistry[] = [
    {},
    { lookupCurrentScope: async () => ({ status: "missing" }) },
    { lookupCurrentScope: async () => ({ status: "unavailable", reason: "offline" }) },
    { lookupCurrentScope: async () => { throw new Error("provider error"); } },
  ];
  for (const registry of providers) {
    const result = await resolveBuilderGateRegistry(registryInput(), registry);
    assert.equal(result.status, "UNKNOWN");
    assert.ok(result.requiredLookups.includes("lookup-current-scope"));
    assert.ok(result.requiredLookups.includes("trusted-production-registry-unavailable"));
  }
});
