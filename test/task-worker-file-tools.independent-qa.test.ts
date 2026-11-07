import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { prepareTaskWorker, readTaskWorkerFile, writeTaskWorkerFile, deleteTaskWorkerFile } from "../src/task-worker-tools.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../src/task-worker-runtime.ts";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { fixture, W, A, C, CTO, ctx, now } from "./fixtures/cto-platform.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function taskFixture() {
  const f = await fixture(W);
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const delivery = (await f.deliveryStore().current())!.revision;
  const ctoRun = [...f.runs.keys()][0]!;
  const record = { packet: { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev", revision: 1,
    kind: "development" as const, title: "One scoped source edit", goal: "Edit the assigned source only.",
    scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies: [], included: ["src/feature.ts"], excluded: [],
    constraints: [], acceptance: ["Review the submitted commit"], evidenceRequired: ["Exact source commit"], reuse: [], testPlan: null,
    sourceAccess: { sourceId: SOURCE, folderKey: "project-source", readPaths: ["src/feature.ts"], writePaths: ["src/feature.ts"], qaWritePaths: [] } },
    source: { requestId: delivery.requestId, workstreamId: "ws-1", specRevision: 1,
      instructionSha256: workstreamInstructionDigest(f.instruction) }, author: { agentId: A, sessionId: C, runId: ctoRun },
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
  Object.assign(f.platform.agents.sessions, {
    async getRun(sessionId: string, companyId: string, runId: string) {
      assert.equal(sessionId, SESSION); assert.equal(companyId, W); assert.equal(runId, RUN);
      return { runId: RUN, status: "running", cancellationRequested, termination: "not_applicable", error: null, errorCode: null };
    },
    async getRequest(sessionId: string, companyId: string, requestId: string) {
      assert.equal(sessionId, SESSION); assert.equal(companyId, W); assert.equal(requestId, taskWorkerRequestId(binding));
      return { requestId, state: "submitted", runId: receiptRunId };
    },
  });
  const files = new Map([["src/feature.ts", "original"]]);
  const effects = { reads: 0, writes: 0, deletes: 0 };
  Object.assign(f.platform, { localFolders: {
    async status(folderKey: string) { return { folderKey, configured: true, access: "readWrite", readable: true, writable: true, healthy: true }; },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) { return { folderKey, workspaceSourceId, match: "same_root" }; },
    async readText(_folder: string, relativePath: string) { effects.reads++; return files.get(relativePath); },
    async writeTextAtomic(_folder: string, relativePath: string, contents: string) { effects.writes++; files.set(relativePath, contents); },
    async deleteFile(_folder: string, relativePath: string) { effects.deletes++; files.delete(relativePath); },
  } });
  return { f, ensureContext, effects, files, packets, record,
    context: { companyId: W, agentId: AGENT, sessionId: SESSION, runId: RUN },
    cancel() { cancellationRequested = true; }, changeReceipt() { receiptRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; } };
}

test("Workspace-only Worker context prepares without a Core Project and reaches exact registered file handlers", async () => {
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
