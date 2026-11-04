import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSolutionRevisionStore } from "../solution-revision-store.ts";
import { createRevisionJournal } from "../solution-revision-store.ts";
import { parseUiRevision } from "../ui-contracts/domain.ts";
import { parseTaskPacketRecord, taskPacketRecordDigest } from "../domain/task-packets.ts";
import { lookupCurrentSolutionRevision, resolveBuilderGateRegistry,
  lookupCurrentSolutionRevisionRecordDigest, lookupCurrentTaskPacketRecord, lookupCurrentWorkstreamRecord,
  lookupCurrentCtoDeliveryRecord, lookupJournalCurrentRecordDigest, lookupJournalCurrentRevision,
  lookupPublishedFormalUiRevision, type BuilderGateRegistry, type StoredGateScope,
  type RegistryLookup } from "./registry.ts";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import { createWorkstreamStore } from "../workstream-tools.ts";
import { dispatchCtoWorkstream } from "../cto-workstream-delivery.ts";
import { CTO, P, W, ctx, fixture as ctoFixture } from "../../test/fixtures/cto-platform.ts";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import type { EvidencePin, GateScopeSnapshot } from "./index.ts";

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

test("an adapter echoing the expected pin does not establish stored source bytes", async () => {
  const result = await resolveBuilderGateRegistry(registryInput(), {
    lookupCurrentScope: async () => ({ status: "found", value: baseScope() }),
    lookupCurrentRevision: async (_scope, expected) => ({ status: "found", value: expected }),
  });
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.resolved.sources, []);
  assert.ok(result.requiredLookups.includes("lookup-original-source-bytes"));
  assert.ok(result.requiredLookups.includes("trusted-production-registry-unavailable"));
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

test("solution revision adapter hashes the actual persisted current journal record", async () => {
  const values = new Map<string, JsonValue>();
  const state = {
    get: async (key: { stateKey: string }) => values.get(key.stateKey) ?? null,
    compareAndSet: async (key: { stateKey: string }, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
      const current = values.get(key.stateKey);
      const swapped = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
        : current === undefined;
      if (swapped) values.set(key.stateKey, value);
      return { swapped };
    },
  };
  const workspaceId = "00000000-0000-4000-8000-000000000101";
  const projectId = "project-1";
  const revision = { approvedSpecRevisionId: "spec-r1", graphRevisionId: "graph-r1", entities: [], relations: [], viewLayoutRef: "layout-r1" };
  const store = createSolutionRevisionStore(workspaceId, projectId, state);
  assert.equal((await store.publish({ expectedBaseRevisionId: null, revision })).status, "published");
  const bytes = new TextEncoder().encode(JSON.stringify(revision));
  const expected = { sourceId: "solution:project-1", revisionId: "graph-r1",
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const found = await lookupCurrentSolutionRevision(workspaceId, projectId, state, "graph-r1");
  assert.equal(found.status, "found");
  if (found.status === "found") assert.deepEqual(found.value, { sequence: 1, revisionId: "graph-r1" });

  const verifiedDigest = await lookupCurrentSolutionRevisionRecordDigest(workspaceId, projectId, state, "graph-r1", expected.sha256);
  assert.equal(verifiedDigest.status, "found");
  if (verifiedDigest.status === "found") assert.equal(verifiedDigest.value.normalizedRecordSha256, expected.sha256);
  const tampered = await lookupCurrentSolutionRevisionRecordDigest(workspaceId, projectId, state,
    "graph-r1", "f".repeat(64));
  assert.equal(tampered.status, "missing");
  const stale = await lookupCurrentSolutionRevision(workspaceId, projectId, state, "graph-r0");
  assert.equal(stale.status, "missing");
  // Constructor validation errors are reported as unavailable, not thrown.
  assert.equal((await lookupCurrentSolutionRevisionRecordDigest("not-a-workspace", projectId, state,
    "graph-r1", expected.sha256)).status, "unavailable");
});

test("legacy four-argument journal lookup remains typed and does not prove original source bytes", async () => {
  const current = Object.freeze({ id: "stored-r2", content: "from journal" });
  const journal = { current: async () => ({ sequence: 2, revision: current }),
    publishedRevision: async () => null };
  const pin: EvidencePin = Object.freeze({ sourceId: "spec", revisionId: "stored-r2", sha256: "a".repeat(64) });
  const legacyConsumer: (source: typeof journal, revisionId: string, getRevisionId: (revision: typeof current) => string,
    pin: EvidencePin) => Promise<RegistryLookup<EvidencePin>> = lookupJournalCurrentRevision;
  assert.deepEqual(await legacyConsumer(journal, "stored-r2", revision => revision.id, pin),
    { status: "found", value: pin });
  assert.deepEqual(await legacyConsumer(journal, "caller-echo-r2", revision => revision.id,
    { ...pin, revisionId: "caller-echo-r2" }),
    { status: "missing" });
  assert.deepEqual(await legacyConsumer({ ...journal, current: async () => { throw new Error("invalid journal"); } },
    "stored-r2", revision => revision.id, pin), { status: "unavailable", reason: "revision-journal-unavailable-or-invalid" });
});

test("formal UI publication lookup reports stored positive, missing, corrupt, and provider failure distinctly", async () => {
  const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const sessionIds = ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff",
    "99999999-9999-4999-8999-999999999999"];
  const projectId = "ui-registry-test";
  const values = new Map<string, JsonValue>();
  const state = {
    get: async (key: { stateKey: string }) => values.get(key.stateKey) ?? null,
    compareAndSet: async (key: { stateKey: string }, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
      const old = values.get(key.stateKey);
      const swapped = expected.exists ? old !== undefined && JSON.stringify(old) === JSON.stringify(expected.value) : old === undefined;
      if (swapped) values.set(key.stateKey, value);
      return { swapped };
    },
  };
  values.set("lead-agent.v1", { workspaceId, revision: 1, selectedAgentId: agentId });
  values.set("lead-contexts.v2.1", { schemaVersion: 2, workspaceId, selectionRevision: 1, agentId,
    requestId: null, status: "ready", pendingContext: null,
    contexts: Object.fromEntries(["user_conversation", "ui_design", "background_planning", "question_intake", "question_discussion"]
      .map((key, index) => [key, sessionIds[index]])) });
  const platform = { state } as never;
  const runContext = { companyId: workspaceId, agentId, sessionId: sessionIds[0], runId: "12121212-1212-4212-8212-121212121212" };
  const journal = createRevisionJournal(workspaceId, projectId, state, { prefix: "ui-contracts",
    parse: value => parseUiRevision(value, projectId), revisionId: revision => revision.revisionId });
  const lookup = () => lookupPublishedFormalUiRevision(workspaceId, projectId, state,
    "formal-r1", runContext, platform);

  assert.deepEqual(await lookup(), { status: "missing" });
  const html = "<main><button data-ui-id=\"save\">Save</button></main>";
  const revision = parseUiRevision({ projectId, revisionId: "formal-r1", sourceBaselineRevisionId: "baseline-r1",
    sourceBaselineDigest: "a".repeat(64), sourceSpecRevisionId: "spec-r1", sourceProposalRevisionId: null,
    previousRevisionId: null, artifact: { artifactId: "artifact-r1", html,
      htmlSha256: createHash("sha256").update(html).digest("hex"), screenIds: ["home"], viewport: { width: 1280, height: 800 },
      sourceSessionId: sessionIds[0], sourceSpecRevisionId: "spec-r1" },
    contract: { projectId, revisionId: "contract-r1", screenIds: ["home"], interactions: [] },
    approvalSource: { sourceId: "lead-turn:12121212-1212-4212-8212-121212121212", sourceSha256: "b".repeat(64) },
    publication: "formal", reviewByInteractionId: {} }, projectId);
  assert.equal((await journal.publish({ expectedBaseRevisionId: null, revision })).status, "published");
  const positive = await lookup();
  assert.equal(positive.status, "found");
  if (positive.status === "found") assert.equal(positive.value.revisionId, "formal-r1");

  const corruptState = { ...state, get: async (key: { stateKey: string }) => key.stateKey.startsWith("ui-contracts-")
    ? ({ malformed: true } as JsonValue) : state.get(key) };
  assert.equal((await lookupPublishedFormalUiRevision(workspaceId, projectId, corruptState, "formal-r1", runContext,
    { state: corruptState } as never)).status, "unavailable");
  const failingState = { ...state, get: async () => { throw new Error("state provider failed"); } };
  assert.equal((await lookupPublishedFormalUiRevision(workspaceId, projectId, failingState, "formal-r1", runContext,
    { state: failingState } as never)).status, "unavailable");
});

test("generic journal helper labels and verifies only the normalized returned-record digest", async () => {
  const revision = Object.freeze({ id: "current", value: "persisted" });
  const result = await lookupJournalCurrentRecordDigest({ current: async () => ({ sequence: 1, revision }),
    publishedRevision: async () => ({ sequence: 1, revision }) }, "current", value => value.id, "a".repeat(64));
  assert.equal(result.status, "missing");
  const normalizedRecordSha256 = createHash("sha256").update(JSON.stringify(revision)).digest("hex");
  const matched = await lookupJournalCurrentRecordDigest({ current: async () => ({ sequence: 1, revision }),
    publishedRevision: async () => ({ sequence: 1, revision }) }, "current", value => value.id, normalizedRecordSha256);
  assert.deepEqual(matched, { status: "found", value: { revisionId: "current", normalizedRecordSha256 } });
});

test("current Task Packet adapter reads the exact persisted board scope", async () => {
  const values = new Map<string, JsonValue>();
  const state = {
    get: async (key: { stateKey: string }) => values.get(key.stateKey) ?? null,
    compareAndSet: async (key: { stateKey: string }, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
      const current = values.get(key.stateKey);
      const swapped = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
        : current === undefined;
      if (swapped) values.set(key.stateKey, value);
      return { swapped };
    },
  };
  const workspaceId = "00000000-0000-4000-8000-000000000102";
  const record = packetRecord("task-current");
  const store = createTaskPacketStore(workspaceId, "project-1", "cto-1", "project-1", state);
  assert.equal((await store.publish({ expectedBaseRevisionId: null, revision: { projectId: "project-1", ctoId: "cto-1",
    workstreamId: "project-1", revisionId: "board-r1", packets: [record] } })).status, "published");
  assert.deepEqual(await lookupCurrentTaskPacketRecord(workspaceId, "project-1", "cto-1", "project-1", "task-current", state),
    { status: "found", value: record });
  assert.equal((await lookupCurrentTaskPacketRecord(workspaceId, "project-1", "cto-other", "project-1", "task-current", state)).status, "missing");
});

test("current Workstream adapter reads only the current board and exact Workstream ID", async () => {
  const values = new Map<string, JsonValue>();
  const state = {
    get: async (key: { stateKey: string }) => values.get(key.stateKey) ?? null,
    compareAndSet: async (key: { stateKey: string }, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
      const current = values.get(key.stateKey);
      const swapped = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
        : current === undefined;
      if (swapped) values.set(key.stateKey, value);
      return { swapped };
    },
  };
  const workspaceId = "00000000-0000-4000-8000-000000000103";
  const projectId = "project-1";
  const workstream = { spec: { projectId, id: "workstream-1", revision: 1, sourceSpecRevisionId: "spec-r1",
    assignedCtoId: "cto-1", title: "Title", goal: "Goal", scopeNodeIds: ["node-1"], included: ["one"], excluded: ["two"],
    dependencies: [], interfaceContracts: [], technologyDecisionsRef: "tech-r1", reuseCandidates: [], acceptance: ["pass"],
    evidenceRequired: ["evidence"], openQuestions: [] }, sourceBaselineRevisionId: "base-r1", baselineDigest: "a".repeat(64),
    technologyDigest: "b".repeat(64), ctoAgentId: id("10"), ctoSessionId: id("11"),
    author: { agentId: id("12"), sessionId: id("13"), runId: id("14"), selectionRevision: 1 },
    createdAt: "2026-11-04T00:00:00.000Z", change: { previousRevision: null, reason: "initial", diff: "initial",
      impactNodeIds: ["node-1"], impactInterfaceContracts: [], impactTaskIds: [], effectiveFrom: "now" }, receipt: null };
  const store = createWorkstreamStore(workspaceId, projectId, state);
  assert.equal((await store.publish({ expectedBaseRevisionId: null, revision: { projectId, revisionId: "board-r1", workstreams: [workstream] } })).status, "published");
  assert.deepEqual(await lookupCurrentWorkstreamRecord(workspaceId, projectId, "workstream-1", state),
    { status: "found", value: (await store.current())?.revision.workstreams[0] });
  assert.equal((await lookupCurrentWorkstreamRecord(workspaceId, projectId, "workstream-old", state)).status, "missing");
});

test("current CTO delivery adapter reads the exact validated current delivery journal", async () => {
  const f = await ctoFixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const found = await lookupCurrentCtoDeliveryRecord(W, P, CTO, "ws-1", f.state);
  assert.equal(found.status, "found");
  if (found.status === "found") {
    assert.equal(found.value.workspaceId, W);
    assert.equal(found.value.projectId, P);
    assert.equal(found.value.instruction.spec.id, "ws-1");
    assert.equal(found.value.phase, "submitted");
  }
  assert.equal((await lookupCurrentCtoDeliveryRecord(W, P, "other-cto", "ws-1", f.state)).status, "missing");
  assert.equal((await lookupCurrentCtoDeliveryRecord(W, P, CTO, "another-workstream", f.state)).status, "missing");
  const corruptState = { ...f.state, get: async () => ({ corrupt: true } as JsonValue) };
  assert.equal((await lookupCurrentCtoDeliveryRecord(W, P, CTO, "ws-1", corruptState)).status, "unavailable");
  const failedState = { ...f.state, get: async () => { throw new Error("delivery provider failed"); } };
  assert.equal((await lookupCurrentCtoDeliveryRecord(W, P, CTO, "ws-1", failedState)).status, "unavailable");
});
