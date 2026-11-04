import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import { parseTaskPacketRecord } from "../domain/task-packets.ts";
import { createBuilderGateRecordLibrary } from "./records.ts";
import { BUILDER_GATE_IDS } from "./index.ts";
import type { GateScopeSnapshot } from "./index.ts";

const W = "11111111-1111-4111-8111-111111111111";
const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const MAIN_AGENT = "22222222-2222-4222-8222-222222222222";
const MAIN_SESSION = "33333333-3333-4333-8333-333333333333";
const QA_AGENT = "44444444-4444-4444-8444-444444444444";
const QA_SESSION = "55555555-5555-4555-8555-555555555555";
const QA_RUN = "66666666-6666-4666-8666-666666666666";
const RUN_ID = "77777777-7777-4777-8777-777777777777";
const WORKSTREAM = "workstream-1";
const CTO = "cto-1";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function hostFixture() {
  const values = new Map<string, JsonValue>();
  const key = (input: SpsStateKey) => `${input.scopeId}/${input.namespace}/${input.stateKey}`;
  let runOutput = "QA run report: all planned checks passed.";
  let executionIdentity = { companyId: W, agentId: QA_AGENT, sessionId: QA_SESSION, runId: QA_RUN,
    phase: "succeeded", cancellationRequested: false, termination: "confirmed" };
  const state = {
    get: async (input: SpsStateKey) => values.get(key(input)) ?? null,
    set: async (input: SpsStateKey, value: JsonValue) => { values.set(key(input), value); },
    delete: async (input: SpsStateKey) => { values.delete(key(input)); },
    compareAndSet: async (input: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
      const current = values.get(key(input));
      const swapped = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value) : current === undefined;
      if (swapped) values.set(key(input), value);
      return { swapped };
    },
  };
  const contextIds = [MAIN_SESSION, QA_SESSION, "88888888-8888-4888-8888-888888888888",
    "99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
  values.set(`${W}/sonpark.my-builder/lead-agent.v1`, { workspaceId: W, revision: 7, selectedAgentId: MAIN_AGENT });
  values.set(`${W}/sonpark.my-builder/lead-contexts.v2.7`, { schemaVersion: 2, workspaceId: W, selectionRevision: 7,
    agentId: MAIN_AGENT, requestId: null, status: "ready", pendingContext: null,
    contexts: Object.fromEntries(["user_conversation", "ui_design", "background_planning", "question_intake", "question_discussion"]
      .map((name, index) => [name, contextIds[index]])) });
  const platform = { events: { emit: async () => undefined }, state, agents: { sessions: { getRun: async (sessionId: string, companyId: string, runId: string) => ({
    runId, status: "succeeded", cancellationRequested: false, termination: "confirmed", output: { state: "available", text: runOutput },
    execution: { ...executionIdentity, sessionId, companyId, runId },
  }) } } } as unknown as SpsPlatformInvocationContext;
  const runContext = { companyId: W, agentId: MAIN_AGENT, sessionId: MAIN_SESSION, runId: RUN_ID, projectId: P };
  const library = () => createBuilderGateRecordLibrary(W, P, platform,
    { kind: "lead", runContext, formalPublication: true });
  return { values, state, platform, runContext, library, setRunOutput(text: string) { runOutput = text; },
    setExecutionIdentity(identity: typeof executionIdentity) { executionIdentity = identity; } };
}

const snapshot = (revisionId = "scope-r1"): GateScopeSnapshot => Object.freeze({ workspaceId: W, projectId: P,
  scopeId: WORKSTREAM, revisionId, pins: Object.freeze([{ sourceId: "spec-ref", revisionId: "spec-r1", sha256: "a".repeat(64) }]) });

function qaPacket() {
  return parseTaskPacketRecord({ packet: { projectId: P, ctoId: CTO, workstreamId: WORKSTREAM, taskId: "qa-task", revision: 1,
    kind: "qa", title: "Product QA", goal: "Execute the product TestPlan", scopeNodeIds: ["node-1"], requirementIds: ["REQ-1"],
    dependencies: [], included: ["run planned checks"], excluded: ["unplanned behavior"], constraints: ["preserve source identity"],
    acceptance: ["all planned checks pass"], evidenceRequired: ["host run output"], reuse: [],
    testPlan: { environment: "Builder test environment", steps: ["run named suite"], expectedResults: ["all tests pass"],
      passCriteria: ["exit code is zero"] } },
    source: { requestId: "11111111-1111-4111-8111-111111111111", workstreamId: WORKSTREAM, specRevision: 1,
      instructionSha256: "b".repeat(64) },
    author: { agentId: MAIN_AGENT, sessionId: MAIN_SESSION, runId: RUN_ID }, createdAtISO: "2026-11-04T00:00:00.000Z",
    dependencyPins: [] }, P, CTO, WORKSTREAM);
}

test("Host-bound gate and checker journals isolate scope, preserve immutable history, and stay UNKNOWN for A-owned trace", async () => {
  const fixture = hostFixture(), library = fixture.library(), scope1 = snapshot("scope-r1"), scope2 = snapshot("scope-r2");
  assert.equal((await library.publishScope(null, scope1)).status, "published");
  assert.equal((await library.publishScope("scope-r1", scope2)).status, "published");
  const history = await library.publishedScope(WORKSTREAM, "scope-r1");
  assert.equal(history.status, "found");
  if (history.status === "found") assert.equal(history.value.snapshot.revisionId, "scope-r1");
  assert.equal((await library.currentScope("scope-other")).status, "missing");
  assert.equal((await library.registry.lookupCurrentScope!("another-workspace", P, WORKSTREAM)).status, "missing");

  const checker = { checkerId: "g4-checker", checkerVersion: "2.1.0", revisionId: "checker-r1",
    implementation: { sourceId: "checker-implementation", revisionId: "impl-r7", sha256: "c".repeat(64) } } as const;
  assert.equal((await library.publishChecker(null, checker)).status, "published");
  const checkerRecord = await library.currentCheckerRecord(checker.checkerId, checker.checkerVersion);
  assert.equal(checkerRecord.status, "found");
  if (checkerRecord.status === "found") assert.equal(checkerRecord.value.admissionStatus, "unknown");
  assert.equal((await library.registry.lookupChecker!(checker.checkerId, checker.checkerVersion)).status, "unavailable");
  const nextChecker = { ...checker, revisionId: "checker-r2", implementation: { ...checker.implementation, revisionId: "impl-r8" } };
  assert.equal((await library.publishChecker("checker-r1", nextChecker)).status, "published");
  assert.equal((await library.publishedChecker(checker.checkerId, checker.checkerVersion, "checker-r1")).status, "found");
  assert.equal((await library.publishChecker("stale-base", { ...checker, revisionId: "checker-r3" })).status, "conflict");

  const result = await (await fixture.library()).registry.lookupCurrentScope!(W, P, WORKSTREAM);
  assert.equal(result.status, "found");
  const resolution = await import("./registry.ts").then(({ resolveBuilderGateRegistry }) => resolveBuilderGateRegistry({
    gateId: "G4", expected: scope2, checkerId: checker.checkerId, checkerVersion: checker.checkerVersion,
    authority: { kind: "lead", runContext: fixture.runContext, platform: fixture.platform, formalPublication: true },
    requireQa: false, evidenceRefs: scope2.pins,
  }, library.registry));
  assert.equal(resolution.status, "UNKNOWN");
  assert.ok(resolution.requiredLookups.includes("lookup-original-source:spec-ref"));
  assert.ok(resolution.requiredLookups.includes("lookup-current-revision:spec-ref"));
  assert.ok(!resolution.requiredLookups.includes("trusted-production-registry-unavailable"));
  assert.ok(BUILDER_GATE_IDS.includes(resolution.gateId));
});

test("formal checker publication requires current Main authority and a CAS journal", async () => {
  const fixture = hostFixture();
  const wrong = createBuilderGateRecordLibrary(W, P, fixture.platform,
    { kind: "lead", runContext: { companyId: W, agentId: MAIN_AGENT, sessionId: "55555555-5555-4555-8555-555555555555", runId: RUN_ID }, formalPublication: true });
  await assert.rejects(() => wrong.publishChecker(null, { checkerId: "checker", checkerVersion: "1",
    revisionId: "r1", implementation: { sourceId: "implementation", revisionId: "i1", sha256: "d".repeat(64) } }));
  const noCas = { get: fixture.state.get, set: fixture.state.set, delete: fixture.state.delete } as never;
  const unsupported = createBuilderGateRecordLibrary(W, P, { ...fixture.platform, state: noCas } as never,
    { kind: "lead", runContext: { companyId: W, agentId: MAIN_AGENT, sessionId: "33333333-3333-4333-8333-333333333333", runId: RUN_ID,
      projectId: P }, formalPublication: true });
  await assert.rejects(() => unsupported.publishChecker(null, { checkerId: "checker", checkerVersion: "1",
    revisionId: "r1", implementation: { sourceId: "implementation", revisionId: "i1", sha256: "d".repeat(64) } }), /atomic state.compareAndSet/);
});

test("SDK contexts and state facades with malformed fields, accessors, or altered prototypes cannot mint a library", () => {
  const fixture = hostFixture();
  const before = fixture.values.size;
  const make = (platform: unknown) => createBuilderGateRecordLibrary(W, P, platform as SpsPlatformInvocationContext,
    { kind: "lead", runContext: fixture.runContext, formalPublication: true });
  const customContext = Object.assign(Object.create({ injected: true }), fixture.platform);
  assert.throws(() => make(customContext), /plain record/u);
  const customState = Object.assign(Object.create({ get: fixture.state.get }), { set: fixture.state.set, delete: fixture.state.delete });
  assert.throws(() => make({ ...fixture.platform, state: customState }), /plain record/u);
  const accessorState = { ...fixture.state };
  Object.defineProperty(accessorState, "get", { enumerable: true, get: () => fixture.state.get });
  assert.throws(() => make({ ...fixture.platform, state: accessorState }), /Malformed SDK facade/u);
  const incompleteState = { get: fixture.state.get };
  assert.throws(() => make({ ...fixture.platform, state: incompleteState }), /Malformed SDK state facade/u);
  assert.equal(fixture.values.size, before);
});

test("factory captures the original SDK state facade and ignores later platform.state replacement", async () => {
  const fixture = hostFixture(), platform = fixture.platform as unknown as { state: unknown };
  const library = fixture.library();
  const target = snapshot();
  assert.equal((await library.publishScope(null, target)).status, "published");
  let replacementReads = 0, replacementWrites = 0;
  platform.state = { get: async () => { replacementReads += 1; return null; },
    set: async () => { replacementWrites += 1; }, delete: async () => { replacementWrites += 1; },
    compareAndSet: async () => { replacementWrites += 1; return { swapped: true }; } };
  const result = await library.currentScope(WORKSTREAM);
  assert.equal(result.status, "found");
  assert.equal(replacementReads, 0);
  assert.equal(replacementWrites, 0);
  assert.ok([...fixture.values.keys()].some(key => key.includes("gate-scope-head.v1.")));
});

test("corrupt gate scope journal fails unavailable without falling back to a caller snapshot", async () => {
  const fixture = hostFixture(), library = fixture.library();
  assert.equal((await library.publishScope(null, snapshot())).status, "published");
  const headKey = [...fixture.values.keys()].find(key => key.includes("gate-scope-head.v1."));
  assert.ok(headKey);
  fixture.values.set(headKey!, { malformed: true });
  assert.equal((await library.currentScope(WORKSTREAM)).status, "unavailable");
  assert.equal((await library.registry.lookupCurrentScope!(W, P, WORKSTREAM)).status, "unavailable");
});

test("product QA journal binds the current QA Task Packet, TestPlan, Host run, output artifact and exact source pins", async () => {
  const fixture = hostFixture();
  const board = createTaskPacketStore(W, P, CTO, WORKSTREAM, fixture.state);
  const packet = qaPacket();
  assert.equal((await board.publish({ expectedBaseRevisionId: null, revision: { projectId: P, ctoId: CTO,
    workstreamId: WORKSTREAM, revisionId: "task-board-r1", packets: [packet] } })).status, "published");
  const library = fixture.library(), target = snapshot();
  assert.equal((await library.publishScope(null, target)).status, "published");
  const artifactText = "QA run report: all planned checks passed.";
  const qa = { recordId: `${target.scopeId}\u0000${target.revisionId}`, revisionId: "qa-record-r1", target,
    task: { ctoId: CTO, workstreamId: WORKSTREAM, taskId: "qa-task", taskRevision: 1 }, testPlan: packet.packet.testPlan!,
    run: { agentId: QA_AGENT, sessionId: QA_SESSION, runId: QA_RUN }, command: "node --test src/product.test.ts", exitCode: 0,
    result: "passed" as const, artifact: { sourceId: `host-run-output:${QA_RUN}`, revisionId: QA_RUN, sha256: sha(artifactText), text: artifactText },
    sourcePins: target.pins };
  assert.equal((await library.publishProductQa(null, qa)).status, "published");
  const qaRevision2 = { ...qa, revisionId: "qa-record-r2" };
  assert.equal((await library.publishProductQa("qa-record-r1", qaRevision2)).status, "published");
  assert.equal((await library.publishedProductQa(target, "qa-record-r1")).status, "found");
  assert.equal((await library.currentProductQaRecord(target)).status, "found");
  await assert.rejects(() => library.publishProductQa("qa-record-r2", { ...qaRevision2, revisionId: "qa-record-r3",
    sourcePins: [] }), /exact target scope/);
  await assert.rejects(() => library.publishProductQa("qa-record-r2", { ...qaRevision2, revisionId: "qa-record-r3",
    artifact: { ...qa.artifact, sourceId: "caller-selected-source-id" } }), /exact Host run output/);
  await assert.rejects(() => library.publishProductQa("qa-record-r2", { ...qaRevision2, revisionId: "qa-record-r3",
    testPlan: { ...qa.testPlan, passCriteria: ["caller changed criteria"] } }), /exact current QA Task Packet and CTO TestPlan/);
  const record = await library.currentProductQaRecord(target);
  assert.equal(record.status, "found");
  if (record.status === "found") {
    assert.equal(record.value.admissionStatus, "unverified");
    assert.equal(record.value.result, "passed");
    assert.equal(record.value.command, qa.command);
    assert.equal(record.value.artifact.sha256, sha(artifactText));
  }
  assert.equal((await library.registry.lookupIndependentQa!(target)).status, "unavailable");
  const reportBytes = await library.registry.lookupSource!(qa.artifact.sourceId, target.scopeId, QA_RUN);
  assert.equal(reportBytes.status, "found");
  if (reportBytes.status === "found") assert.equal(new TextDecoder().decode(reportBytes.value.bytes), artifactText);
  assert.equal((await library.registry.lookupSource!("spec-ref", target.scopeId, "spec-r1")).status, "unavailable");
  fixture.setRunOutput("changed output");
  assert.equal((await library.currentProductQaRecord(target)).status, "unavailable");
  fixture.setRunOutput(artifactText);
  fixture.setExecutionIdentity({ companyId: W, agentId: MAIN_AGENT, sessionId: MAIN_SESSION, runId: QA_RUN,
    phase: "succeeded", cancellationRequested: false, termination: "confirmed" });
  assert.equal((await library.currentProductQaRecord(target)).status, "unavailable");
  assert.equal((await library.currentProductQaRecord(snapshot("other-revision"))).status, "missing");
});

