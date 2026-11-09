import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTaskPacketStore, publishCtoTaskPacket } from "../src/task-packet-tools.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { prepareTaskWorker, readTaskWorkerFile, writeTaskWorkerFile, deleteTaskWorkerFile } from "../src/task-worker-tools.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../src/task-worker-runtime.ts";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { fixture, W, A, C, CTO, ctx, now } from "./fixtures/cto-platform.ts";
import { prepareApprovedTaskFileDesign } from "./fixtures/task-file-approved-design.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const HEAD = "a".repeat(40), COMMIT = "b".repeat(40), TREE = "c".repeat(40);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const PEER_AGENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PEER_SESSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PEER_RUN = "90909090-9090-4090-8090-909090909090";

async function taskFixture(sourceBound = true) {
  const f = await fixture(W);
  const design = await prepareApprovedTaskFileDesign(f);
  await dispatchCtoWorkstream(design.params, ctx(), f.platform);
  const delivery = (await f.deliveryStore().current())!.revision;
  const ctoRun = [...f.runs.keys()][0]!;
  const record = { packet: { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev", revision: 1,
    kind: "development" as const, title: "One scoped source edit", goal: "Edit the assigned source only.",
    scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies: [], included: ["src/feature.ts"], excluded: [],
    constraints: [], acceptance: ["Review the submitted commit"], evidenceRequired: ["Exact source commit"], reuse: [], testPlan: null,
    sourceAccess: { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task-dev", expectedHead: HEAD,
      readPaths: ["src/feature.ts"], writePaths: ["src/feature.ts"], qaWritePaths: [] } },
    source: { requestId: delivery.requestId, workstreamId: "ws-1", specRevision: design.instruction.spec.revision,
      instructionSha256: workstreamInstructionDigest(design.instruction) }, author: { agentId: A, sessionId: C, runId: ctoRun },
    createdAtISO: now, dependencyPins: [] };
  const packets = createTaskPacketStore(W, W, CTO, "ws-1", f.state);
  await packets.publish({ expectedBaseRevisionId: null, revision: { projectId: W, ctoId: CTO,
    workstreamId: "ws-1", revisionId: "qa-file-board-1", packets: [record] } });
  const pluginAgentKey = `builder-task-worker:${hash([W, "ws-1", "task-dev", "worker"])}`;
  const profile = { agentId: AGENT, status: "idle" };
  let ensureContext: unknown = "not-called";
  Object.assign(f.platform.agents, {
    owned: {
      async get(input: { pluginAgentKey: string }) { return input.pluginAgentKey === pluginAgentKey
        ? { status: "resolved", revision: 1, agent: profile } : { status: "missing" }; },
      async ensure() { throw new Error("Existing fixture profile must be reused"); },
    },
    async list() { return [{ id: A, companyId: W, status: "idle" }, { id: AGENT, companyId: W, status: "idle" }]; },
    async describeExecution() { return { agentId: A, adapterType: "fixture", state: "configured", adapterRegistration: "registered",
      executionOwner: "adapter", authorization: "recheck_on_dispatch", readiness: "unknown", node: null }; },
  });
  Object.assign(f.platform.agents.sessions, { async ensure(_agentId: string, _companyId: string, input: { context?: unknown }) {
    ensureContext = input.context;
    return { sessionId: SESSION, created: true };
  } });
  const prepared = await prepareTaskWorker({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev",
    packetRevision: 1, role: "worker" }, ctx(C, ctoRun), f.platform);
  assert.equal((prepared.data as { status: string }).status, "registered");
  const registry = parseTaskWorkerRegistry(await f.state.get({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder",
    stateKey: taskWorkerRegistryKey(W, CTO) }), W, W, CTO);
  const binding = deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO, packet: record,
    currentPackets: [record], worker: registry.records[0]! });
  let cancellationRequested = false;
  let receiptRunId = RUN;
  const { getRun: getCtoRun, getRequest: getCtoRequest } = f.platform.agents.sessions;
  Object.assign(f.platform.agents.sessions, {
    async getRun(sessionId: string, companyId: string, runId: string) {
      if (sessionId === C) return getCtoRun(sessionId, companyId, runId);
      assert.equal(sessionId, SESSION); assert.equal(companyId, W); assert.equal(runId, RUN);
      return { runId: RUN, status: "running", cancellationRequested, termination: "not_applicable", error: null, errorCode: null };
    },
    async getRequest(sessionId: string, companyId: string, requestId: string) {
      if (sessionId === C) return getCtoRequest(sessionId, companyId, requestId);
      assert.equal(sessionId, SESSION); assert.equal(companyId, W); assert.equal(requestId, taskWorkerRequestId(binding));
      return { requestId, state: "submitted", runId: receiptRunId };
    },
  });
  const files = new Map([["src/feature.ts", "original"]]);
  const effects = { reads: 0, writes: 0, deletes: 0 };
  function assertSource(sourceId: string, folderKey: string, relativePath: string) {
    assert.equal(sourceId, SOURCE);
    assert.equal(folderKey, "project-source");
    assert.equal(relativePath, "src/feature.ts");
  }
  let onMatch = async () => {};
  let onEffect = async () => {};
  Object.assign(f.platform, { hostSupport: { state: "reported", contractVersion: "1.0", operations: ["localFolders.workspaceSourceFileEffectV1"] }, localFolders: {
    async status(folderKey: string) { return { folderKey, configured: true, access: "readWrite", readable: true, writable: true, healthy: true,
      requiredDirectories: [], requiredFiles: [], missingDirectories: [], missingFiles: [], checkedAt: now }; },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) { await onMatch(); return { folderKey, workspaceSourceId, match: "same_root" }; },
    async commitTaskFilesV1(input: unknown) {
      assert.deepEqual(input, { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task-dev", expectedHead: HEAD, paths: ["src/feature.ts"] });
      return { status: "committed", commitSha: COMMIT, treeSha: TREE, changedPaths: ["src/feature.ts"] };
    },
    async readText() { assert.fail("Legacy reads must not be used for a Task Source"); },
    async writeTextAtomic() { assert.fail("Legacy writes must not be used for a Task Source"); },
    async deleteFile() { assert.fail("Legacy deletes must not be used for a Task Source"); },
    ...(sourceBound ? {
      async workspaceSourceFileEffectV1(input: { sourceId: string; folderKey: string; relativePath: string;
        operation: "read" | "write" | "delete"; contents?: string;
        guards: readonly { namespace?: string; stateKey: string; expectedValue: unknown }[] }) {
        assertSource(input.sourceId, input.folderKey, input.relativePath);
        await onEffect();
        assert.ok(input.guards.length >= 5);
        assert.ok(input.guards.every(guard => !guard.stateKey.includes("-revision.v1.")));
        for (const prefix of ["design-baseline-head.v1.", "technology-decisions-head.v1."])
          assert.ok(input.guards.some(guard => guard.namespace === "sonpark.my-builder" && guard.stateKey.startsWith(prefix)));
        for (const guard of input.guards) {
          assert.deepEqual(await f.state.get({ scopeKind: "company", scopeId: W,
            ...(guard.namespace === undefined ? {} : { namespace: guard.namespace }), stateKey: guard.stateKey }), guard.expectedValue);
        }
        if (input.operation === "read") { effects.reads++; return { status: "read", text: files.get(input.relativePath) }; }
        if (input.operation === "write") { effects.writes++; files.set(input.relativePath, input.contents!); return { status: "written" }; }
        effects.deletes++; files.delete(input.relativePath); return { status: "deleted" };
      },
      async readWorkspaceSourceTextV1(sourceId: string, folderKey: string, relativePath: string) {
        assertSource(sourceId, folderKey, relativePath); effects.reads++; return files.get(relativePath);
      },
      async writeWorkspaceSourceTextAtomicV1(sourceId: string, folderKey: string, relativePath: string, contents: string) {
        assertSource(sourceId, folderKey, relativePath); effects.writes++; files.set(relativePath, contents);
      },
      async deleteWorkspaceSourceFileV1(sourceId: string, folderKey: string, relativePath: string) {
        assertSource(sourceId, folderKey, relativePath); effects.deletes++; files.delete(relativePath);
      },
    } : {}),
  } });
  return { f, ensureContext, effects, files, packets, record, ctoContext: ctx(C, ctoRun),
    context: { companyId: W, agentId: AGENT, sessionId: SESSION, runId: RUN },
    setOnMatch(callback: typeof onMatch) { onMatch = callback; },
    setOnEffect(callback: typeof onEffect) { onEffect = callback; },
    cancel() { cancellationRequested = true; }, changeReceipt() { receiptRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; } };
}

test("Workspace-only Worker context passes exact Source and observed mutable authority guards to Core", async () => {
  const f = await taskFixture();
  assert.equal(f.ensureContext, undefined);
  const read = await readTaskWorkerFile({ relativePath: "src/feature.ts" }, f.context, f.f.platform);
  assert.equal((read.data as { text: string }).text, "original");
  const written = await writeTaskWorkerFile({ relativePath: "src/feature.ts", contents: "modified" }, f.context, f.f.platform);
  assert.equal((written.data as { status: string }).status, "written");
  assert.equal(f.files.get("src/feature.ts"), "modified");
  const deleted = await deleteTaskWorkerFile({ relativePath: "src/feature.ts" }, f.context, f.f.platform);
  assert.equal((deleted.data as { status: string }).status, "deleted");
  assert.deepEqual(f.effects, { reads: 1, writes: 1, deletes: 1 });
});

test("registered planning reports duplicate intent and blocks unordered shared-root writers without blocking reads", async () => {
  const f = await taskFixture();
  const peer = { ...f.record.packet, taskId: "task-peer", sourceAccess: { ...f.record.packet.sourceAccess,
    branch: "feature/peer", writePaths: ["SRC/Feature.ts"] } };
  const input = { projectId: W, ctoId: CTO, workstreamId: "ws-1" };
  const plan = await publishCtoTaskPacket({ ...input, expectedBaseRevisionId: "qa-file-board-1", revisionId: "shared-plan",
    packet: peer }, f.ctoContext, f.f.platform);
  const reviewed = (plan.data as { parallelReview: { tasks: unknown[] } }).parallelReview.tasks;
  assert.deepEqual(reviewed, [
    { taskId: "task-dev", unorderedWriterIds: ["task-peer"], similarGoalIds: ["task-peer"], truncated: false },
    { taskId: "task-peer", unorderedWriterIds: ["task-dev"], similarGoalIds: ["task-dev"], truncated: false },
  ]);
  const tools = createBuilderPlatform().tools;
  const call = (name: string, params: object, context = f.context) => tools.find(tool => tool.name === name)!
    .handler(params as never, context as never, f.f.platform);
  const sessions = f.f.platform.agents.sessions;
  const getRequest = sessions.getRequest.bind(sessions);
  Object.assign(sessions, {
    async getRequest(sessionId: string, companyId: string, requestId: string) {
      return sessionId === SESSION ? null : getRequest(sessionId, companyId, requestId);
    },
    async sendMessage() { assert.fail("A conflicting new plan must not send a Worker Run."); },
  });
  const denied = await call("builder.dispatch-task-worker", { ...input, taskId: "task-dev", packetRevision: 1, role: "worker" }, f.ctoContext);
  assert.equal((denied.data as { status: string }).status, "blocked");
  assert.equal((denied.data as { reason: string }).reason, "unordered-source-writers");
  sessions.getRequest = getRequest;
  assert.equal(((await call("builder.read-task-source-file", { relativePath: "src/feature.ts" })).data as { status: string }).status, "read");
  await assert.rejects(async () => call("builder.write-task-source-file", { relativePath: "src/feature.ts", contents: "blocked" }),
    /unordered writers/u);
  await assert.rejects(async () => call("builder.submit-task-source", { paths: ["src/feature.ts"] }), /unordered writers/u);
  assert.deepEqual(f.effects, { reads: 1, writes: 0, deletes: 0 });
});

function supportSecondTask(f: Awaited<ReturnType<typeof taskFixture>>, replayFirst = false) {
  const sessions = f.f.platform.agents.sessions;
  const { getRequest, getRun } = sessions;
  const owned = (f.f.platform.agents as unknown as { owned: { get(input: unknown): Promise<unknown> } }).owned;
  const profile = owned.get.bind(owned);
  owned.get = async (input: unknown) => (input as { pluginAgentKey: string }).pluginAgentKey === `builder-task-worker:${hash([W, "ws-1", "task-peer", "worker"])}`
    ? { status: "resolved", revision: 1, agent: { agentId: PEER_AGENT, status: "idle" } } : profile(input);
  const list = f.f.platform.agents.list.bind(f.f.platform.agents);
  Object.assign(f.f.platform.agents, { async list(input: Parameters<typeof list>[0]) {
    return [...await list(input), { id: PEER_AGENT, companyId: W, status: "idle" }];
  } });
  const receipts = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const started: string[] = [];
  let firstSucceeded = false;
  Object.assign(sessions, {
    async ensure(agentId: string) { return { sessionId: agentId === PEER_AGENT ? PEER_SESSION : SESSION, created: agentId === PEER_AGENT }; },
    async getRequest(sessionId: string, companyId: string, requestId: string) {
      return sessionId === C || (sessionId === SESSION && replayFirst) ? getRequest(sessionId, companyId, requestId) : receipts.get(sessionId) ?? null;
    },
    async getRun(sessionId: string, companyId: string, runId: string) {
      return sessionId === C ? getRun(sessionId, companyId, runId)
        : { runId, status: sessionId === SESSION && firstSucceeded ? "succeeded" : "running",
          cancellationRequested: false, termination: "not_applicable", error: null, errorCode: null };
    },
    async sendMessage(sessionId: string, companyId: string, { requestId, prompt }: { requestId: string; prompt: string }) {
      assert.equal(companyId, W);
      assert.match(prompt, /Choose and combine the tools actually available/u);
      const runId = sessionId === PEER_SESSION ? PEER_RUN : RUN;
      started.push(sessionId); receipts.set(sessionId, { requestId, state: "submitted", runId });
      return { runId };
    },
  });
  return { started, receipts, finishFirst() { firstSucceeded = true; } };
}

test("two distinct registered Tasks sharing a read path can both be admitted on a readable-only Host", async () => {
  const f = await taskFixture();
  const boardScope = { projectId: W, ctoId: CTO, workstreamId: "ws-1" };
  const readOnly = { ...f.record.packet, goal: "Read shared input for the first independent result.", revision: 2,
    sourceAccess: { ...f.record.packet.sourceAccess, writePaths: [] } };
  const peer = { ...readOnly, taskId: "task-peer", revision: 1, goal: "Review shared input for another deliverable." };
  const published = await publishCtoTaskPacket({ ...boardScope, expectedBaseRevisionId: "qa-file-board-1", revisionId: "read-only-parallel",
    packet: readOnly, additionalPackets: [peer] }, f.ctoContext, f.f.platform);
  assert.equal((published.data as { status: string }).status, "published");
  const { started, receipts } = supportSecondTask(f);
  const { localFolders: folders } = f.f.platform as unknown as { localFolders: { status(folderKey: string): Promise<unknown> } };
  const folderStatus = folders.status.bind(folders);
  folders.status = async folderKey => ({ ...await folderStatus(folderKey) as object, writable: false, access: "readOnly" });
  const parameters = [readOnly, peer].map(packet => ({ ...boardScope, taskId: packet.taskId, packetRevision: packet.revision, role: "worker" }));
  for (const input of parameters) {
    const prepared = await prepareTaskWorker(input, f.ctoContext, f.f.platform);
    assert.equal((prepared.data as { status: string }).status, "registered", JSON.stringify(prepared.data));
  }
  const tool = createBuilderPlatform().tools.find(tool => tool.name === "builder.dispatch-task-worker")!;
  const results = await Promise.all(parameters.map(input => tool.handler(input, f.ctoContext as never, f.f.platform)));
  assert.deepEqual(results.map(result => (result.data as { status: string }).status), ["submitted", "submitted"]);
  assert.deepEqual(new Set(started), new Set([SESSION, PEER_SESSION]));
  assert.deepEqual(new Set([...receipts.values()].map(row => row.runId)), new Set([RUN, PEER_RUN]));
  assert.deepEqual(f.effects, { reads: 0, writes: 0, deletes: 0 }, "Core DTO receipts are admission, not actual execution");
});

test("ordered overlapping writes wait for the exact accepted predecessor and its closed Run", async () => {
  const f = await taskFixture();
  const scope = { projectId: W, ctoId: CTO, workstreamId: "ws-1" };
  const tools = createBuilderPlatform().tools;
  const call = async (name: string, params: object, context = f.ctoContext) => tools.find(tool => tool.name === name)!
    .handler(params as never, context as never, f.f.platform);
  const submitted = (await call("builder.submit-task-source", { paths: ["src/feature.ts"] }, f.context)).data as {
    status: string; submission: { submissionId: string } };
  assert.equal(submitted.status, "submitted");
  const peer = { ...f.record.packet, taskId: "task-peer", goal: "Extend the accepted feature in sequence.", dependencies: ["task-dev"],
    sourceAccess: { ...f.record.packet.sourceAccess, expectedHead: COMMIT } };
  await publishCtoTaskPacket({ ...scope, expectedBaseRevisionId: "qa-file-board-1", revisionId: "ordered-overlap",
    packet: peer }, f.ctoContext, f.f.platform);
  const host = supportSecondTask(f, true);
  const params = { ...scope, taskId: "task-peer", packetRevision: 1, role: "worker" };
  assert.equal(((await prepareTaskWorker(params, f.ctoContext, f.f.platform)).data as { status: string }).status, "registered");
  const dispatch = async () => (await call("builder.dispatch-task-worker", params)).data as { status: string; reason?: string };
  assert.equal((await dispatch()).reason, "overlapping-predecessor-source-not-handed-off");
  const accepted = (await call("builder.accept-task-source-submission", {
    ...scope, taskId: "task-dev", submissionId: submitted.submission.submissionId,
  })).data as { status: string };
  assert.equal(accepted.status, "accepted");
  assert.equal((await dispatch()).reason, "overlapping-predecessor-source-not-handed-off", "acceptance alone is not a closed Run");
  assert.deepEqual(host.started, []);
  host.finishFirst();
  let branchHead = HEAD;
  Object.assign((f.f.platform as unknown as { localFolders: object }).localFolders, {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      return { status: "current", sourceId, folderKey, branch, commitSha: branchHead, treeSha: TREE, observedAt: now };
    },
  });
  assert.equal((await dispatch()).reason, "overlapping-predecessor-branch-tip-changed");
  assert.deepEqual(host.started, []);
  branchHead = COMMIT;
  assert.equal((await dispatch()).status, "submitted");
  assert.deepEqual(host.started, [PEER_SESSION]);
});

test("a current second Workstream writing the same Source blocks effects, while original submission replay stays readable", async () => {
  const f = await taskFixture();
  const submit = () => createBuilderPlatform().tools.find(tool => tool.name === "builder.submit-task-source")!
    .handler({ paths: ["src/feature.ts"] }, f.context as never, f.f.platform);
  const original = (await submit()).data as { status: string; submission: unknown };
  assert.equal(original.status, "submitted");
  const workstreams = createWorkstreamStore(W, W, f.f.state);
  const board = (await workstreams.current())!.revision;
  const originalWorkstream = board.workstreams[0]!;
  const peer = { ...originalWorkstream, spec: { ...originalWorkstream.spec, id: "ws-peer", assignedCtoId: "cto-peer",
    scopeNodeIds: ["peer-feature"] }, ctoAgentId: PEER_AGENT, ctoSessionId: PEER_SESSION };
  await workstreams.publish({ expectedBaseRevisionId: board.revisionId, revision: { ...board,
    revisionId: "cross-workstream-writers", workstreams: [...board.workstreams, peer] } });
  const packet = { ...f.record, packet: { ...f.record.packet, workstreamId: "ws-peer", ctoId: "cto-peer", taskId: "task-peer",
    scopeNodeIds: ["peer-feature"], sourceAccess: { ...f.record.packet.sourceAccess, branch: "feature/peer" } },
    source: { ...f.record.source, workstreamId: "ws-peer", instructionSha256: workstreamInstructionDigest(peer) },
    author: { agentId: PEER_AGENT, sessionId: PEER_SESSION, runId: PEER_RUN } };
  const peerStore = createTaskPacketStore(W, W, "cto-peer", "ws-peer", f.f.state);
  assert.equal((await peerStore.publish({ expectedBaseRevisionId: null, revision: { projectId: W, workstreamId: "ws-peer",
    ctoId: "cto-peer", revisionId: "peer-packets", packets: [packet] } })).status, "published");
  await assert.rejects(() => writeTaskWorkerFile({ relativePath: "src/feature.ts", contents: "must not overwrite" }, f.context, f.f.platform),
    /writers in another Workstream/u);
  assert.equal(((await readTaskWorkerFile({ relativePath: "src/feature.ts" }, f.context, f.f.platform)).data as { status: string }).status, "read");
  const replay = (await submit()).data as typeof original;
  assert.equal(replay.status, "existing");
  assert.deepEqual(replay.submission, original.submission);
  assert.deepEqual(f.effects, { reads: 1, writes: 0, deletes: 0 });
});

test("Task revision drift between Builder observation and Core effect cannot mutate a file", async () => {
  const f = await taskFixture();
  f.setOnEffect(async () => {
    const published = await f.packets.publish({ expectedBaseRevisionId: "qa-file-board-1", revision: { projectId: W, ctoId: CTO,
      workstreamId: "ws-1", revisionId: "qa-file-board-2", packets: [{ ...f.record, packet: { ...f.record.packet, revision: 2 } }] } });
    assert.equal(published.status, "published");
  });
  const result = await writeTaskWorkerFile({ relativePath: "src/feature.ts", contents: "must not change" }, f.context, f.f.platform);
  assert.deepEqual(result.data, { status: "unknown", reason: "task-source-file-effect-outcome-uncertain",
    completion: "not-established", qaVerdict: "not-established" });
  assert.equal(f.files.get("src/feature.ts"), "original");
  assert.deepEqual(f.effects, { reads: 0, writes: 0, deletes: 0 });
});

test("registered Worker file tools accept optional Host timing without borrowing execution authority", async () => {
  const f = await taskFixture();
  const originalGetRun = f.f.platform.agents.sessions.getRun;
  let unrelatedField = false;
  Object.assign(f.f.platform.agents.sessions, {
    async getRun(sessionId: string, companyId: string, runId: string) {
      const run = await originalGetRun(sessionId, companyId, runId);
      return sessionId === SESSION ? { ...run,
        timing: { createdAt: now, startedAt: now, finishedAt: null },
        ...(unrelatedField ? { callerApproved: true } : {}),
      } : run;
    },
  });
  const platform = createBuilderPlatform();
  const read = platform.tools.find(tool => tool.name === "builder.read-task-source-file")!;
  const call = () => read.handler({ relativePath: "src/feature.ts" }, f.context as never, f.f.platform);
  assert.equal(((await call()).data as { text: string }).text, "original");
  assert.equal(f.effects.reads, 1);
  unrelatedField = true;
  await assert.rejects(Promise.resolve().then(call), /Invalid Builder tool fields/u);
  unrelatedField = false;
  f.cancel();
  await assert.rejects(Promise.resolve().then(call), /uncancelled/u);
  assert.deepEqual(f.effects, { reads: 1, writes: 0, deletes: 0 });
});

test("registered Worker submit and CTO receipt bind the same commit, deny other actors and detect Task drift", async () => {
  const f = await taskFixture();
  const platform = createBuilderPlatform();
  const call = (name: string, params: object, context = f.ctoContext) => Promise.resolve().then(() =>
    platform.tools.find(tool => tool.name === name)!.handler(params as never, context as never, f.f.platform));
  const task = { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev" };
  const read = "builder.read-task-source-submissions", accept = "builder.accept-task-source-submission";
  const empty = (await call(read, task)).data as { status: string; reason: string };
  assert.equal(empty.status, "unknown");
  assert.equal(empty.reason, "submission-not-found");
  await assert.rejects(call(accept, task));
  const submit = await call("builder.submit-task-source", { paths: ["src/feature.ts"] }, f.context);
  const submitted = submit.data as { status: string; submission: { submissionId: string; commitSha: string } };
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.submission.commitSha, COMMIT);
  const input = { ...task, submissionId: submitted.submission.submissionId };
  const discovered = (await call(read, task)).data as { status: string; submissionId: string };
  assert.equal(discovered.status, "submitted");
  assert.equal(discovered.submissionId, input.submissionId);
  await assert.rejects(call(accept, input, f.context));
  assert.equal(((await call(read, input)).data as { status: string }).status, "submitted");
  const first = (await call(accept, input)).data as { status: string; acceptance: { commitSha: string }; qaVerdict: string };
  assert.equal(first.status, "accepted");
  assert.equal(first.acceptance.commitSha, COMMIT);
  assert.equal(first.qaVerdict, "not-established");
  const replay = (await call(accept, input)).data as typeof first;
  assert.equal(replay.status, "existing");
  assert.deepEqual(replay.acceptance, first.acceptance);
  f.setOnMatch(async () => {
    const result = await f.packets.publish({ expectedBaseRevisionId: "qa-file-board-1", revision: { projectId: W, ctoId: CTO,
      workstreamId: "ws-1", revisionId: "qa-file-board-2", packets: [{ ...f.record, packet: { ...f.record.packet, revision: 2 } }] } });
    assert.equal(result.status, "published");
  });
  await assert.rejects(call(read, input), /Task Packet or dependency changed/);
  f.setOnMatch(async () => {});
  assert.equal(((await call(read, input)).data as { status: string }).status, "stale");
  assert.equal(((await call(read, task)).data as { reason: string }).reason, "submission-not-found");
});

test("Workspace-only Worker file tools never fall back to legacy alias IO on a Host without V1", async () => {
  const f = await taskFixture(false);
  const params = { relativePath: "src/feature.ts" };
  for (const result of [
    await readTaskWorkerFile(params, f.context, f.f.platform),
    await writeTaskWorkerFile({ ...params, contents: "unexpected" }, f.context, f.f.platform),
    await deleteTaskWorkerFile(params, f.context, f.f.platform),
  ]) {
    assert.equal((result.data as { status: string }).status, "unsupported");
  }
  assert.equal(f.files.get("src/feature.ts"), "original");
  assert.deepEqual(f.effects, { reads: 0, writes: 0, deletes: 0 });
});

test("file handlers reject caller-selected Task identity, unassigned paths and cancelled exact runs before file effects", async () => {
  const f = await taskFixture();
  await assert.rejects(writeTaskWorkerFile({ relativePath: "src/feature.ts", contents: "bad", taskId: "another-task" }, f.context, f.f.platform));
  await assert.rejects(writeTaskWorkerFile({ relativePath: "src/other.ts", contents: "bad" }, f.context, f.f.platform), /does not allow/u);
  await assert.rejects(writeTaskWorkerFile({ relativePath: "src/feature.ts", contents: "bad" },
    { ...f.context, projectId: "not-this-project" }, f.f.platform));
  f.cancel();
  await assert.rejects(writeTaskWorkerFile({ relativePath: "src/feature.ts", contents: "bad" }, f.context, f.f.platform), /uncancelled/u);
  assert.deepEqual(f.effects, { reads: 0, writes: 0, deletes: 0 });
});

test("a different request receipt or changed Task revision cannot borrow an active Worker run", async () => {
  const f = await taskFixture();
  f.changeReceipt();
  await assert.rejects(readTaskWorkerFile({ relativePath: "src/feature.ts" }, f.context, f.f.platform), /exact current Task dispatch/u);
  await f.packets.publish({ expectedBaseRevisionId: "qa-file-board-1", revision: { projectId: W, ctoId: CTO,
    workstreamId: "ws-1", revisionId: "qa-file-board-2", packets: [{ ...f.record, packet: { ...f.record.packet, revision: 2 } }] } });
  await assert.rejects(readTaskWorkerFile({ relativePath: "src/feature.ts" }, f.context, f.f.platform), /current packet/u);
  assert.deepEqual(f.effects, { reads: 0, writes: 0, deletes: 0 });
});
