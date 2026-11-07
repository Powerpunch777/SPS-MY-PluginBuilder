import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskPacket, taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../src/task-worker-runtime.ts";
import { setupVerifiedWorkstreamPlatform } from "./fixtures/verified-workstream-platform.ts";
import { A, C, CTO, W, key, mapKey } from "./fixtures/cto-platform.ts";

const DEV_SESSION = "12121212-1212-4212-8212-121212121212";
const DEV_AGENT = "33333333-3333-4333-8333-333333333333";
const runId = "abababab-abab-4bab-8bab-abababababab";

async function dispatchFixture(undecided: readonly string[], withUnmapped = false, omitDecisionModel = false) {
  const f = await setupVerifiedWorkstreamPlatform(withUnmapped, { undecidedRequirementIds: undecided, omitDecisionModel });
  const packetStore = createTaskPacketStore(W, W, CTO, "ws-1", f.f.state as never);
  const board = (await packetStore.current())!.revision;
  const dev = board.packets.find(row => row.packet.taskId === "task-dev")!;
  const taskWorker = (f.f.values.get(mapKey(key(taskWorkerRegistryKey(W, CTO)))) as any).records
    .find((row: any) => row.taskId === "task-dev" && row.role === "worker");
  const binding = deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO,
    packet: dev, currentPackets: board.packets, worker: taskWorker });
  const requestId = taskWorkerRequestId(binding);
  f.requests.delete(`${DEV_SESSION}:${requestId}`);

  const sessions = f.f.platform.agents.sessions as any;
  const originalSend = sessions.sendMessage?.bind(sessions);
  const originalGetRequest = sessions.getRequest.bind(sessions);
  sessions.getRequest = async (sessionId: string, workspaceId: string, id: string) => sessionId === DEV_SESSION
    ? f.requests.get(`${sessionId}:${id}`) ?? null : originalGetRequest(sessionId, workspaceId, id);
  let sends = 0;
  sessions.sendMessage = async (sessionId: string, workspaceId: string, input: { requestId: string }) => {
    assert.equal(sessionId, DEV_SESSION); assert.equal(workspaceId, W);
    sends += 1;
    const acceptedRun = runId;
    f.requests.set(`${sessionId}:${input.requestId}`, { requestId: input.requestId, state: "submitted", runId: acceptedRun });
    return { runId: acceptedRun };
  };
  Object.assign(f.f.platform, { localFolders: {
    async status(folderKey: string) { return { folderKey, configured: true, healthy: true, readable: true, writable: true }; },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) {
      return { folderKey, workspaceSourceId, match: "same_root" };
    }, async readWorkspaceSourceTextV1() { return ""; }, async writeWorkspaceSourceTextAtomicV1() {},
    async deleteWorkspaceSourceFileV1() {},
  } });
  return { ...f, packetStore, board, dev, taskWorker, requestId, sessions, get sends() { return sends; }, originalSend };
}

function params(taskId = "task-dev") {
  return { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId, packetRevision: 1, role: "worker" };
}

test("registered dispatch blocks only the Task directly naming an approved UNDECIDED requirement", async () => {
  const f = await dispatchFixture(["REQ-1"]);
  await assert.rejects(Promise.resolve(f.dispatchTool.handler(params(), f.ctoContext, f.f.platform)),
    /explicitly UNDECIDED approved requirement/u);
  assert.equal(f.sends, 0, "the blocked exact Task never reaches Worker send");
});

test("registered G4 verification does not publish a Task whose scoped requirement is UNDECIDED", async () => {
  const f = await setupVerifiedWorkstreamPlatform(false, { undecidedRequirementIds: ["REQ-1"] });
  const result = await f.verify();
  assert.equal(result.data.status, "unknown", JSON.stringify(result.data));
  assert.equal(result.data.reason, "workstream-task-inventory-incomplete",
    "the blocked development Task cannot disappear from whole-Workstream verification");
  assert.equal("snapshot" in result.data, false, "partial inputs never produce a VERIFIED projection");
  assert.equal(f.atomicWakeCalls, 0, "an UNKNOWN whole-Workstream result does not queue the verification wake");
  assert.equal(f.wakes.length, 0);
});

test("registered dispatch allows a Task whose requirement is unrelated to the approved UNDECIDED item", async () => {
  const f = await dispatchFixture(["REQ-1"], true);
  const record = f.dev;
  const updatedPacket = parseTaskPacket({ ...record.packet, requirementIds: ["REQ-UNMAPPED"] }, W, CTO, "ws-1");
  const updated = { ...record, packet: updatedPacket };
  const updatedDigest = taskPacketRecordDigest(updated, W, CTO, "ws-1");
  const qa = f.board.packets.find(row => row.packet.taskId === "task-qa")!;
  const updatedQa = { ...qa, dependencyPins: [{ taskId: "task-dev", revision: 1, recordSha256: updatedDigest }] };
  await f.packetStore.publish({ expectedBaseRevisionId: f.board.revisionId, revision: { ...f.board,
    revisionId: "task-board-unrelated-undecided", packets: f.board.packets.map(row => row.packet.taskId === "task-dev" ? updated
      : row.packet.taskId === "task-qa" ? updatedQa : row) } });
  const registryKey = key(taskWorkerRegistryKey(W, CTO));
  const registry = f.f.values.get(mapKey(registryKey)) as any;
  f.f.values.set(mapKey(registryKey), { ...registry, revision: registry.revision + 1,
    records: registry.records.map((row: any) => row.taskId === "task-dev" && row.role === "worker"
      ? { ...row, packetRecordSha256: updatedDigest } : row) });
  const result = await f.dispatchTool.handler(params(), f.ctoContext, f.f.platform) as any;
  assert.equal(result.data.status, "submitted", JSON.stringify(result.data));
  assert.equal(f.sends, 1);
});

test("registered dispatch rechecks the approved original source at the last pre-send guard", async () => {
  const f = await dispatchFixture([]);
  const storageKey = mapKey(f.sourceTurnKey);
  const source = f.f.values.get(storageKey) as Record<string, unknown>;
  let drifted = false;
  const folders = (f.f.platform as any).localFolders;
  folders.status = async (folderKey: string) => {
    if (!drifted) {
      drifted = true;
      f.f.values.set(storageKey, { ...source, text: `${String(source.text)} changed after decision read` });
    }
    return { folderKey, configured: true, healthy: true, readable: true, writable: true };
  };
  await assert.rejects(Promise.resolve(f.dispatchTool.handler(params(), f.ctoContext, f.f.platform)),
    /original-source-(?:digest-mismatch|changed-during-read)/u);
  assert.equal(drifted, true);
  assert.equal(f.sends, 0, "a source change between folder preflight and final authority check prevents send");
});

test("registered dispatch does not synthesize an UNDECIDED blocker when the exact approved review has no model", async () => {
  const f = await dispatchFixture([], false, true);
  const result = await f.dispatchTool.handler(params(), f.ctoContext, f.f.platform) as any;
  assert.equal(result.data.status, "submitted", JSON.stringify(result.data));
  assert.equal(f.sends, 1);
});
