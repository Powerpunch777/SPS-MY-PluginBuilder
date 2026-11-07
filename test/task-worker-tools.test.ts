import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { prepareTaskWorker, readTaskWorkers } from "../src/task-worker-tools.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { parseTaskPacket } from "../src/domain/task-packets.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey } from "../src/domain/integration-manager.ts";
import { fixture, W, A, C, P, CTO, ctx, now } from "./fixtures/cto-platform.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QA_AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const QA_SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const workerKey = (taskId: string, role: "worker" | "qa") => `builder-task-${role}:${createHash("sha256")
  .update(JSON.stringify([P, "ws-1", taskId, role]), "utf8").digest("hex")}`;
const baseRecord = { workstreamId: "ws-1", taskId: "task-1", packetRevision: 1,
  packetRecordSha256: "a".repeat(64), role: "worker" as const, agentId: AGENT, sessionId: SESSION,
  pluginAgentKey: workerKey("task-1", "worker"),
  source: { requestId: "11111111-1111-4111-8111-111111111111", specRevision: 1, instructionSha256: "c".repeat(64) },
  registeredAtISO: "2026-11-06T01:02:03.004Z" };

function packet(taskId: string, revision: number, kind: "development" | "qa", dependencies: string[] = []) {
  return { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId, revision, kind, title: `Task ${taskId}`,
    goal: "Use only this exact published packet.", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies,
    included: ["Assigned scope"], excluded: [], constraints: [], acceptance: ["Acceptance is checked"],
    evidenceRequired: ["Evidence reference"], reuse: [], testPlan: kind === "qa" ? { environment: "Node fixture",
      steps: ["Run independent checks"], expectedResults: ["Evidence is recorded"], passCriteria: ["All criteria are checked"] } : null };
}

async function activeFixture() {
  const f = await fixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const runId = [...f.runs.keys()][0]!;
  const runContext = ctx(C, runId);
  const currentDelivery = (await f.deliveryStore().current())!.revision;
  const source = { requestId: currentDelivery.requestId, workstreamId: "ws-1", specRevision: 1,
    instructionSha256: workstreamInstructionDigest(f.instruction) };
  const author = { agentId: A, sessionId: C, runId };
  const development = { packet: packet("task-dev", 1, "development"), source, author, createdAtISO: now, dependencyPins: [] };
  const qa = { packet: packet("task-qa", 1, "qa"), source, author, createdAtISO: now, dependencyPins: [] };
  const taskStore = createTaskPacketStore(W, P, CTO, "ws-1", f.state);
  await taskStore.publish({ expectedBaseRevisionId: null, revision: { projectId: P, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "task-board-1", packets: [development, qa] } });
  return { f, runContext, taskStore, development, qa };
}

function installOwnedHost(f: Awaited<ReturnType<typeof fixture>>) {
  const profiles = new Map<string, { agentId: string; status: string }>();
  const sessions = new Map<string, string>();
  const getCalls: string[] = [], ensureProfiles: string[] = [], ensureSessions: string[] = [];
  let managerAgentId: string | null = null;
  const owned = {
    async get({ pluginAgentKey }: { companyId: string; pluginAgentKey: string }) {
      getCalls.push(pluginAgentKey);
      if (pluginAgentKey === "integration-manager") return managerAgentId
        ? { status: "resolved", revision: 1, agent: { agentId: managerAgentId, status: "idle" } }
        : { status: "missing" };
      const profile = profiles.get(pluginAgentKey);
      return profile ? { status: "resolved", revision: 1, agent: profile } : { status: "missing" };
    },
    async ensure({ pluginAgentKey, config }: { companyId: string; pluginAgentKey: string; config: { title: string } }) {
      ensureProfiles.push(pluginAgentKey);
      assert.match(config.title, /^Builder (Worker|QA)$/u);
      const profile = { agentId: pluginAgentKey.startsWith("builder-task-qa:") ? QA_AGENT : AGENT, status: "idle" };
      profiles.set(pluginAgentKey, profile);
      return { status: "created", revision: 1, agent: profile };
    },
  };
  Object.assign(f.platform.agents, {
    owned,
    async describeExecution(agentId: string, companyId: string) {
      assert.equal(agentId, A); assert.equal(companyId, W);
      return { agentId, adapterType: "fixture-adapter", state: "configured", adapterRegistration: "registered",
        executionOwner: "adapter", authorization: "recheck_on_dispatch", readiness: "unknown", node: null };
    },
    async list({ companyId }: { companyId: string }) {
      return [{ id: A, companyId, status: "idle" }, ...(managerAgentId ? [{ id: managerAgentId, companyId, status: "idle" }] : []),
        ...[...profiles.values()].map(profile => ({ id: profile.agentId, companyId, status: profile.status }))];
    },
  });
  Object.assign(f.platform.agents.sessions, {
    async ensure(agentId: string, companyId: string, options: { taskKey: string; expectedSessionId?: string }) {
      assert.equal(companyId, W); ensureSessions.push(options.taskKey);
      const sessionId = agentId === QA_AGENT ? QA_SESSION : SESSION;
      const existing = sessions.get(options.taskKey);
      if (options.expectedSessionId !== undefined) assert.equal(options.expectedSessionId, existing);
      if (existing) return { sessionId: existing, created: false };
      sessions.set(options.taskKey, sessionId);
      return { sessionId, created: true };
    },
  });
  return { getCalls, ensureProfiles, ensureSessions, setManagerAgentId(value: string) { managerAgentId = value; } };
}

test("registry pins current and historical packet revisions to one distinct role identity", () => {
  const registry = parseTaskWorkerRegistry({ schemaVersion: 1, workspaceId: W, projectId: P, ctoId: CTO, revision: 2,
    records: [baseRecord, { ...baseRecord, packetRevision: 2, packetRecordSha256: "d".repeat(64) }] }, W, P, CTO);
  assert.equal(registry.records.length, 2);
  assert.equal(registry.records[0]!.agentId, registry.records[1]!.agentId);
  assert.equal(registry.records[0]!.sessionId, registry.records[1]!.sessionId);
  assert.match(taskWorkerRegistryKey(P, CTO), /^task-workers\.v1\.[a-f0-9]{64}$/u);
});

test("registry rejects cross-scope, role-key mismatch, duplicate revisions and shared Worker/QA IDs", () => {
  const registry = { schemaVersion: 1, workspaceId: W, projectId: P, ctoId: CTO, revision: 1, records: [baseRecord] };
  assert.throws(() => parseTaskWorkerRegistry({ ...registry, projectId: "other" }, W, P, CTO), /scope does not match/);
  assert.throws(() => parseTaskWorkerRegistry({ ...registry, records: [{ ...baseRecord, role: "qa" }] }, W, P, CTO), /key does not match/);
  assert.throws(() => parseTaskWorkerRegistry({ ...registry, revision: 2, records: [baseRecord, baseRecord] }, W, P, CTO), /duplicate task roles/);
  assert.throws(() => parseTaskWorkerRegistry({ ...registry, revision: 2,
    records: [baseRecord, { ...baseRecord, taskId: "qa-task", role: "qa", pluginAgentKey: workerKey("qa-task", "qa") }] }, W, P, CTO), /identities must be distinct/);
  assert.throws(() => parseTaskWorkerRegistry({ ...registry, records: [Object.defineProperty({ ...baseRecord }, "taskId",
    { enumerable: true, get() { return "task-1"; } })] }, W, P, CTO), /data field/);
  assert.throws(() => parseTaskWorkerRegistry({ ...registry, records: [{ ...baseRecord,
    pluginAgentKey: `builder-task-worker:${"f".repeat(64)}` }] }, W, P, CTO), /project\/task\/role scope/);
});

test("new Task Worker tool names require their own CTO delivery permissions", async () => {
  const f = await fixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const current = (await f.deliveryStore().current())!.revision;
  await f.deliveryStore().publish({ expectedBaseRevisionId: current.revisionId, revision: { ...current,
    revisionId: "fixture-historical-eight-tool-policy", executionPolicy: { mode: "plugin-tools-only-v1", toolNames: [
      "builder.acknowledge-workstream", "builder.publish-task-packet", "builder.read-cto-memory", "builder.read-cto-workstream",
      "builder.read-own-cto-question", "builder.read-task-packets", "builder.submit-cto-question", "builder.update-cto-memory",
    ] } } });
  const runId = [...f.runs.keys()][0]!;
  const runContext = ctx("44444444-4444-4444-8444-444444444444", runId);
  const params = { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-1", packetRevision: 1, role: "worker" };
  const beforeSends = f.sends, beforeWrites = f.writes;
  await assert.rejects(prepareTaskWorker(params, runContext, f.platform), /explicitly permitted/);
  await assert.rejects(readTaskWorkers({ projectId: P, ctoId: CTO, workstreamId: "ws-1" }, runContext, f.platform), /explicitly permitted/);
  assert.equal(f.sends, beforeSends);
  assert.equal(f.writes, beforeWrites);
});

test("current ten-name delivery registers Worker and QA identities and keeps prior packet revisions", async () => {
  const { f, runContext, taskStore } = await activeFixture();
  const host = installOwnedHost(f);
  const workerInput = { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev", packetRevision: 1, role: "worker" };
  const qaInput = { ...workerInput, taskId: "task-qa", role: "qa" };
  const worker = await prepareTaskWorker(workerInput, runContext, f.platform);
  const qa = await prepareTaskWorker(qaInput, runContext, f.platform);
  assert.equal((worker.data as { status: string }).status, "registered", JSON.stringify(worker.data));
  assert.equal((qa.data as { status: string }).status, "registered", JSON.stringify(qa.data));
  assert.notEqual((worker.data as { worker: { agentId: string } }).worker.agentId,
    (qa.data as { worker: { agentId: string } }).worker.agentId);
  const repeated = await prepareTaskWorker(workerInput, runContext, f.platform);
  assert.deepEqual((repeated.data as { worker: unknown }).worker, (worker.data as { worker: unknown }).worker);

  const board = (await taskStore.current())!.revision;
  const previousDev = board.packets.find(item => item.packet.taskId === "task-dev")!;
  const nextDev = { ...previousDev, packet: packet("task-dev", 2, "development") };
  await taskStore.publish({ expectedBaseRevisionId: board.revisionId, revision: { ...board, revisionId: "task-board-2",
    packets: [nextDev, ...board.packets.filter(item => item.packet.taskId !== "task-dev")] } });
  const next = await prepareTaskWorker({ ...workerInput, packetRevision: 2 }, runContext, f.platform);
  assert.equal((next.data as { status: string }).status, "registered");
  assert.equal(host.ensureProfiles.length, 2, "one owned profile per role across packet revisions");
  assert.equal(new Set(host.ensureSessions).size, 2, "Worker and QA keyed sessions stay distinct");
  assert.equal(f.sends, 1, "preparation performs no additional AI run");
  const read = await readTaskWorkers({ projectId: P, ctoId: CTO, workstreamId: "ws-1" }, runContext, f.platform);
  const records = (read.data as { records: Array<{ taskId: string; packetRevision: number; packetStatus: string }> }).records;
  assert.deepEqual(records.filter(row => row.taskId === "task-dev").map(row => [row.packetRevision, row.packetStatus]),
    [[1, "historical"], [2, "current"]]);
  assert.equal((read.data as { qaPass: boolean }).qaPass, false);
});

test("missing owned API returns unsupported and a stale requested packet revision makes no owned call", async () => {
  const { f, runContext } = await activeFixture();
  const owned = installOwnedHost(f);
  const params = { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev", packetRevision: 2, role: "worker" };
  await assert.rejects(prepareTaskWorker(params, runContext, f.platform), /packetRevision is stale/);
  assert.equal(owned.getCalls.length, 0);

  const unsupportedFixture = await activeFixture();
  const unsupportedParams = { ...params, packetRevision: 1 };
  const writes = unsupportedFixture.f.writes;
  const unsupported = await prepareTaskWorker(unsupportedParams, unsupportedFixture.runContext, unsupportedFixture.f.platform);
  assert.equal((unsupported.data as { status: string }).status, "unsupported");
  assert.equal((unsupported.data as { executionStarted: boolean }).executionStarted, false);
  assert.equal(unsupportedFixture.f.writes, writes);
});

test("dependency drift is rejected before owned Agent lookup or session ensure", async () => {
  const { f, runContext, taskStore } = await activeFixture();
  const host = installOwnedHost(f);
  const board = (await taskStore.current())!.revision;
  const currentDev = board.packets.find(item => item.packet.taskId === "task-dev")!;
  const dependent = { ...board.packets.find(item => item.packet.taskId === "task-qa")!,
    packet: packet("task-qa", 1, "qa", ["task-dev"]),
    dependencyPins: [{ taskId: "task-dev", revision: 1,
      recordSha256: taskPacketRecordDigest(currentDev, P, CTO, "ws-1") }] };
  await taskStore.publish({ expectedBaseRevisionId: board.revisionId, revision: { ...board, revisionId: "task-board-with-dependency",
    packets: [currentDev, dependent] } });
  const dependentBoard = (await taskStore.current())!.revision;
  const first = await prepareTaskWorker({ projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-qa",
    packetRevision: 1, role: "qa" }, runContext, f.platform);
  assert.equal((first.data as { status: string }).status, "registered");
  const ownedLookups = host.getCalls.length, sessionEnsures = host.ensureSessions.length;
  const nextDev = { ...currentDev, packet: packet("task-dev", 2, "development") };
  await taskStore.publish({ expectedBaseRevisionId: dependentBoard.revisionId, revision: { ...dependentBoard,
    revisionId: "task-board-dependency-drift", packets: [nextDev, dependent] } });
  await assert.rejects(prepareTaskWorker({ projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-qa",
    packetRevision: 1, role: "qa" }, runContext, f.platform), /dependency pins/);
  assert.equal(host.getCalls.length, ownedLookups, "drift is rejected before another owned profile lookup");
  assert.equal(host.ensureSessions.length, sessionEnsures, "drift is rejected before another session ensure");
  const read = await readTaskWorkers({ projectId: P, ctoId: CTO, workstreamId: "ws-1" }, runContext, f.platform);
  const registration = (read.data as { records: Array<{ taskId: string; packetStatus: string }> }).records
    .find(item => item.taskId === "task-qa");
  assert.equal(registration?.packetStatus, "historical", "read must not treat a drifted dependency as current");
});

test("packet revision racing the registry CAS keeps the new registration as historical", async () => {
  const { f, runContext, taskStore } = await activeFixture();
  installOwnedHost(f);
  let raced = false;
  f.setAfterCas(async key => {
    if (raced || !key.stateKey.startsWith("task-workers.v1.")) return;
    raced = true;
    const current = (await taskStore.current())!.revision;
    const development = current.packets.find(item => item.packet.taskId === "task-dev")!;
    const revised = { ...development, packet: packet("task-dev", 2, "development") };
    await taskStore.publish({ expectedBaseRevisionId: current.revisionId, revision: { ...current,
      revisionId: "task-board-raced", packets: [revised, ...current.packets.filter(item => item.packet.taskId !== "task-dev")] } });
  });
  await assert.rejects(prepareTaskWorker({ projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev",
    packetRevision: 1, role: "worker" }, runContext, f.platform), /after registration/);
  assert.equal(raced, true);
  const key = { scopeKind: "company" as const, scopeId: W, namespace: "sonpark.my-builder",
    stateKey: taskWorkerRegistryKey(P, CTO) };
  const raw = await f.platform.state.get(key);
  const saved = parseTaskWorkerRegistry(raw, W, P, CTO);
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0]!.packetRevision, 1);
  const readBoard = (await taskStore.current())!.revision;
  assert.equal(readBoard.packets.find(item => item.packet.taskId === "task-dev")!.packet.revision, 2);
  assert.equal(f.sends, 1);
});

test("Manager Agent and session identities are excluded from Worker registration", async () => {
  const identityCase = await activeFixture();
  const identityHost = installOwnedHost(identityCase.f);
  identityHost.setManagerAgentId(AGENT);
  const input = { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev", packetRevision: 1, role: "worker" };
  const identityResult = await prepareTaskWorker(input, identityCase.runContext, identityCase.f.platform);
  assert.equal((identityResult.data as { reason: string }).reason, "manager-agent-identity-conflict");
  assert.equal(identityHost.ensureSessions.length, 0);

  const sessionCase = await activeFixture();
  const sessionHost = installOwnedHost(sessionCase.f);
  const managerAgentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  sessionHost.setManagerAgentId(managerAgentId);
  const managerSessionKey = integrationManagerSessionStateKey(W, P, managerAgentId);
  const taskKey = integrationManagerSessionTaskKey(W, P, managerAgentId);
  const saved = await (sessionCase.f.platform.state as typeof sessionCase.f.platform.state & {
    compareAndSet(key: typeof managerSessionKey, expected: { exists: false }, value: JsonValue): Promise<{ swapped: boolean }>;
  }).compareAndSet(managerSessionKey, { exists: false }, { schemaVersion: 1, workspaceId: W, projectId: P,
    managerAgentId, sessionId: SESSION, taskKey });
  assert.equal(saved.swapped, true);
  await assert.rejects(prepareTaskWorker(input, sessionCase.runContext, sessionCase.f.platform), /reused or invalid Task Worker session/);
  assert.equal(sessionHost.ensureSessions.length, 1);
  const registryKey = { scopeKind: "company" as const, scopeId: W, namespace: "sonpark.my-builder",
    stateKey: taskWorkerRegistryKey(P, CTO) };
  assert.equal(await sessionCase.f.platform.state.get(registryKey), null, "Manager session collision must not publish a Worker row");
});

test("invalid role is rejected before authority access", async () => {
  await assert.rejects(prepareTaskWorker({ projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-1", packetRevision: 1, role: "manager" }, {}, {} as never), /role must be worker or qa/);
  await assert.rejects(prepareTaskWorker({ projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-1", role: "worker" }, {}, {} as never), /Invalid Builder tool fields/);
  await assert.rejects(prepareTaskWorker({ projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-1", packetRevision: 0, role: "worker" }, {}, {} as never), /positive safe integer/);
});

test("registered dispatch fails closed before send when a legacy Baseline has no pinned source closure", async () => {
  const { f, runContext, taskStore } = await activeFixture();
  installOwnedHost(f);
  const board = (await taskStore.current())!.revision;
  const current = board.packets.find(item => item.packet.taskId === "task-dev")!;
  const sourceAccess = { sourceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", folderKey: "approved-source",
    readPaths: ["src/feature.ts"], writePaths: ["src/feature.ts"], qaWritePaths: [] };
  const updated = { ...current, packet: parseTaskPacket({ ...current.packet, sourceAccess }, P, CTO, "ws-1") };
  await taskStore.publish({ expectedBaseRevisionId: board.revisionId, revision: { ...board, revisionId: "legacy-no-model-task-board",
    packets: [updated, ...board.packets.filter(item => item.packet.taskId !== "task-dev")] } });
  Object.assign(f.platform, { localFolders: {
    async status(folderKey: string) { return { folderKey, configured: true, healthy: true, readable: true, writable: true }; },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) {
      return { folderKey, workspaceSourceId, match: "same_root" };
    }, async readWorkspaceSourceTextV1() { return ""; }, async writeWorkspaceSourceTextAtomicV1() {},
    async deleteWorkspaceSourceFileV1() {},
  } });
  const requests = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  let workerSends = 0;
  const originalGetRequest = f.platform.agents.sessions.getRequest.bind(f.platform.agents.sessions);
  Object.assign(f.platform.agents.sessions, {
    async getRequest(sessionId: string, workspaceId: string, requestId: string) {
      assert.equal(workspaceId, W);
      if (sessionId !== SESSION) return originalGetRequest(sessionId, workspaceId, requestId);
      return structuredClone(requests.get(requestId) ?? null);
    },
    async sendMessage(sessionId: string, workspaceId: string, options: { requestId: string }) {
      assert.equal(sessionId, SESSION); assert.equal(workspaceId, W); workerSends += 1;
      const runId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      requests.set(options.requestId, { requestId: options.requestId, state: "submitted", runId });
      f.runs.set(runId, { runId, status: "running", cancellationRequested: false, termination: "not_applicable",
        error: null, errorCode: null, output: { state: "not_ready", text: null } });
      return { runId };
    },
  });
  const params = { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev", packetRevision: 1, role: "worker" };
  const prepared = await prepareTaskWorker(params, runContext, f.platform);
  assert.equal((prepared.data as { status: string }).status, "registered");
  const dispatch = createBuilderPlatform().tools.find(tool => tool.name === "builder.dispatch-task-worker");
  assert(dispatch);
  await assert.rejects(Promise.resolve(dispatch.handler(params, runContext, f.platform)), /original-source-unavailable/u);
  assert.equal(workerSends, 0, "missing source closure must not be treated as a no-model/no-blocker decision");
});
