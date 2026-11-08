import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { JsonValue, SpsAgentSessionRunResult, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { fixture, A, C, CTO, W, ctx, key, mapKey, now } from "./cto-platform.ts";
import { dispatchCtoWorkstream } from "../../src/cto-workstream-delivery.ts";
import { workstreamInstructionDigest } from "../../src/cto-delivery-store.ts";
import { createTaskPacketStore } from "../../src/task-packet-tools.ts";
import { taskPacketRecordDigest, type TaskPacketRecord } from "../../src/domain/task-packets.ts";
import { taskWorkerRegistryKey, type TaskWorkerRecord } from "../../src/domain/task-workers.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../../src/task-worker-runtime.ts";
import { submitTaskSourceFiles } from "../../src/task-source-submissions.ts";
import { MANAGER_SESSION_TERMINAL_JOB } from "../../src/builder-gates/integration-manager-job.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Receipt = NonNullable<Awaited<ReturnType<SpsPlatformInvocationContext["agents"]["sessions"]["getRequest"]>>>;
type SystemEvent = { schemaVersion: 1; kind: "agent-session-terminal-event"; requestId: string; previousRunId: string;
  eventId: string; sourceSessionId: string; sourceRunId: string; resultSha256: string };
type Run = SpsAgentSessionRunResult & { systemEvent?: SystemEvent };
type DispatchInput = { previousRunId: string; eventId: string; sourceSessionId: string; sourceRunId: string;
  guards: readonly { stateKey: string; namespace?: string; expectedValue: unknown }[] };
type Dispatch = (sessionId: string, companyId: string, input: DispatchInput) => Promise<{ requestId: string; runId: string; replayed: boolean }>;
type Admission = { sessionId: string; companyId: string; input: DispatchInput; requestId: string; runId: string };
type WorkerResult = { worker: TaskWorkerRecord; packet: TaskPacketRecord; runId: string; requestId: string; eventId: string;
  payload: { schemaVersion: 1; runId: string; sessionId: string; requestId: string; status: "succeeded" | "failed"; resultSha256: string; finishedAt: string } };

export const runDto = (runId: string, status = "running"): Run => ({ runId, status,
  cancellationRequested: status === "cancelled", termination: status === "cancelled" ? "confirmed" : "not_applicable",
  error: null, errorCode: null });

/** In-memory stores, injected source/Run readers and fake dispatch only; no AI, Core or OS execution. */
export async function workerResultFixture(count = 1,
  options: Readonly<{ noSourceSubmission?: boolean; sourceStatus?: "succeeded" | "failed" }> = {}) {
  const f = await fixture(W);
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const parent = (await f.deliveryStore().current())!.revision;
  const parentRunId = parent.runId!;
  let headRunId = parentRunId;
  const source = { requestId: parent.requestId, workstreamId: "ws-1", specRevision: 1,
    instructionSha256: workstreamInstructionDigest(parent.instruction) };
  const packetStore = createTaskPacketStore(W, W, CTO, "ws-1", f.state);
  const packets = Array.from({ length: count }, (_, index) => ({ packet: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    taskId: `task-${index + 1}`, revision: 1, kind: "development" as const, title: `Worker fixture ${index + 1}`,
    goal: "Exercise exact source-result routing", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies: [],
    included: ["Assigned implementation"], excluded: [], constraints: [], acceptance: ["Fixture behavior"],
    evidenceRequired: ["Exact source pointer"], reuse: [], testPlan: null,
    sourceAccess: { sourceId: "99999999-9999-4999-8999-999999999999", folderKey: "fixture-source",
      branch: `fixture/task-${index + 1}`, expectedHead: "a".repeat(40), readPaths: [`src/task-${index + 1}.ts`],
      writePaths: [`src/task-${index + 1}.ts`], qaWritePaths: [] } }, source,
    author: { agentId: A, sessionId: C, runId: parentRunId }, createdAtISO: now, dependencyPins: [] }));
  assert.equal((await packetStore.publish({ expectedBaseRevisionId: null, revision: { projectId: W, ctoId: CTO,
    workstreamId: "ws-1", revisionId: "independent-packets-1", packets } })).status, "published");
  const currentPackets = (await packetStore.current())!.revision.packets;
  const workers = currentPackets.map(packet => ({ workstreamId: "ws-1", taskId: packet.packet.taskId,
    packetRevision: packet.packet.revision, packetRecordSha256: taskPacketRecordDigest(packet, W, CTO, "ws-1"),
    role: "worker" as const, agentId: randomUUID(), sessionId: randomUUID(),
    pluginAgentKey: `builder-task-worker:${hash([W, "ws-1", packet.packet.taskId, "worker"])}`,
    source: { requestId: source.requestId, specRevision: source.specRevision, instructionSha256: source.instructionSha256 }, registeredAtISO: now }));
  const registryKey = key(taskWorkerRegistryKey(W, CTO));
  f.values.set(mapKey(registryKey), { schemaVersion: 1, workspaceId: W, projectId: W, ctoId: CTO, revision: 1, records: workers });
  const sourceRuns = new Map<string, ReturnType<typeof runDto>>();
  const sourceReceipts = new Map<string, Receipt>();
  const tips = new Map<string, { commitSha: string; treeSha: string }>();
  let committingBranch = "", sourceSubmissionCalls = 0, commitCalls = 0;
  Object.assign(f.platform, { localFolders: {
    async status(folderKey: string) {
      return { folderKey, configured: true, access: "readWrite", readable: true, writable: true,
        healthy: true, requiredDirectories: [], requiredFiles: [], missingDirectories: [], missingFiles: [], checkedAt: now };
    },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) { return { folderKey, workspaceSourceId, match: "same_root" }; },
    async commitTaskFilesV1(input: { branch: string; paths: string[] }) {
      commitCalls++;
      committingBranch = input.branch;
      return { status: "committed", ...tips.get(input.branch)!, changedPaths: input.paths };
    },
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      return { status: "current", sourceId, folderKey, branch, ...tips.get(branch)!, observedAt: now };
    },
  } });
  const results: WorkerResult[] = [];
  for (const [index, worker] of workers.entries()) {
    const packet = currentPackets[index]!, access = packet.packet.sourceAccess!, runId = randomUUID();
    tips.set(access.branch!, { commitSha: (index + 11).toString(16).repeat(40), treeSha: (index + 13).toString(16).repeat(40) });
    const binding = { schemaVersion: 1 as const, workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1",
      taskId: worker.taskId, packetRevision: worker.packetRevision, packetRecordSha256: worker.packetRecordSha256,
      dependencyPins: packet.dependencyPins, role: "worker" as const, agentId: worker.agentId, sessionId: worker.sessionId, runId,
      source: { sourceId: access.sourceId, folderKey: access.folderKey, branch: access.branch!, expectedHead: access.expectedHead! },
      readPaths: access.readPaths, writePaths: access.writePaths, qaWritePaths: access.qaWritePaths };
    if (!options.noSourceSubmission) {
      sourceSubmissionCalls++;
      const submitted = await submitTaskSourceFiles({ runContext: { companyId: W, projectId: W, agentId: worker.agentId,
        sessionId: worker.sessionId, runId }, paths: access.writePaths, platform: f.platform, state: f.state,
        async resolveAuthority() { return { binding, async assertCurrent() {} }; } });
      assert.equal(submitted.status, "submitted", JSON.stringify(submitted));
      assert.equal(committingBranch, access.branch);
    }
    const requestId = taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO,
      packet, currentPackets, worker }));
    const sourceStatus = options.sourceStatus ?? "succeeded";
    sourceRuns.set(runId, { ...runDto(runId, sourceStatus),
      ...(sourceStatus === "failed" ? { errorCode: "synthetic_worker_technical_failure", error: "Fixture-only failure; no source submission attempted" } : {}) });
    sourceReceipts.set(`${worker.sessionId}:${requestId}`, { requestId, state: "submitted", runId });
    // Deliberately reverse event order relative to arrival/ledger order for deterministic selection coverage.
    const eventId = `agent-session-terminal-v1:${(count - index).toString(16).padStart(64, "0")}`;
    const payload: WorkerResult["payload"] = { schemaVersion: 1, runId, sessionId: worker.sessionId, requestId,
      status: sourceStatus, resultSha256: hash([worker.taskId, sourceStatus, "synthetic-result"]), finishedAt: now };
    results.push({ worker, packet, runId, requestId, eventId, payload });
  }
  const sessions = f.platform.agents.sessions as typeof f.platform.agents.sessions & {
    getRun(sessionId: string, workspaceId: string, runId: string): Promise<Run>;
    dispatchSessionTerminalEventV1?: Dispatch;
  };
  sessions.getRequest = async (sessionId: string, workspaceId: string, requestId: string) => {
    assert.equal(workspaceId, W);
    return structuredClone(sessionId === C ? f.receipts.get(requestId) ?? null : sourceReceipts.get(`${sessionId}:${requestId}`) ?? null);
  };
  sessions.getRun = async (sessionId: string, workspaceId: string, runId: string) => {
    assert.equal(workspaceId, W);
    const value = sessionId === C ? f.runs.get(runId)
      : results.some(row => row.worker.sessionId === sessionId && row.runId === runId) ? sourceRuns.get(runId) : undefined;
    if (!value) throw new Error("Injected unknown Run");
    return structuredClone(value);
  };
  sessions.list = async (agentId: string, workspaceId: string) => {
    assert.equal(workspaceId, W);
    return agentId === A ? [{ sessionId: C, agentId: A, companyId: W, status: "active", closedAt: null, lastRunId: headRunId }] : [];
  };
  const dispatches: Admission[] = [];
  const attempts: DispatchInput[] = [];
  let beforeDispatch = async () => {};
  let afterAdmission = async (_admitted: Admission) => {};
  sessions.dispatchSessionTerminalEventV1 = async (sessionId, companyId, input) => {
    assert.equal(sessionId, C); assert.equal(companyId, W);
    attempts.push(structuredClone(input));
    await beforeDispatch();
    for (const guard of input.guards) assert.deepEqual(await f.state.get({ ...key(guard.stateKey), namespace: guard.namespace }), guard.expectedValue,
      `injected Core admission rejects revoked guard ${guard.stateKey}`);
    const original = results.find(result => result.eventId === input.eventId);
    assert.ok(original);
    assert.equal(input.sourceSessionId, original.worker.sessionId); assert.equal(input.sourceRunId, original.runId);
    const prior = dispatches.find(row => row.sessionId === sessionId && row.companyId === companyId
      && row.input.previousRunId === input.previousRunId && row.input.eventId === input.eventId);
    if (prior) return { requestId: prior.requestId, runId: prior.runId, replayed: true };
    assert.equal(input.previousRunId, headRunId, "fake Core requires the actual current session head for a new request");
    assert.ok(["succeeded", "failed"].includes(f.runs.get(headRunId)?.status ?? ""),
      "fake Core cannot start a new request from a running parent");
    const requestId = randomUUID(), runId = randomUUID();
    const systemEvent: SystemEvent = { schemaVersion: 1, kind: "agent-session-terminal-event", requestId,
      previousRunId: input.previousRunId, eventId: input.eventId, sourceSessionId: input.sourceSessionId,
      sourceRunId: input.sourceRunId, resultSha256: original.payload.resultSha256 };
    f.receipts.set(requestId, { requestId, state: "submitted", runId });
    const run: Run = { ...runDto(runId), systemEvent };
    f.runs.set(runId, run);
    const admitted = { sessionId, companyId, input: structuredClone(input), requestId, runId };
    dispatches.push(admitted);
    headRunId = runId;
    await afterAdmission(admitted);
    return { requestId, runId, replayed: false };
  };
  const job = (payload: unknown, eventId: string) => ({ jobKey: MANAGER_SESSION_TERMINAL_JOB, companyId: W,
    runId: randomUUID(), trigger: "event", eventId, event: { eventType: "agent.session.run.terminal", payload } });
  return { f, sessions, results, sourceRuns, sourceReceipts, tips, packetStore, workers, registryKey, dispatches, attempts, parentRunId,
    get sourceSubmissionCalls() { return sourceSubmissionCalls; }, get commitCalls() { return commitCalls; },
    childJob(index = 0) { return job(results[index]!.payload, results[index]!.eventId); },
    terminalParent(runId = parentRunId, status = "succeeded") {
      f.runs.set(runId, { ...f.runs.get(runId)!, ...runDto(runId, status) });
      const receipt = [...f.receipts.values()].find(row => row.runId === runId)!;
      return job({ schemaVersion: 1, runId, sessionId: C, requestId: receipt.requestId, status,
        resultSha256: hash([runId, "synthetic-parent-result"]), finishedAt: now }, `agent-session-terminal-v1:${hash([runId, status])}`);
    },
    setBeforeDispatch(hook: typeof beforeDispatch) { beforeDispatch = hook; },
    setAfterAdmission(hook: typeof afterAdmission) { afterAdmission = hook; },
    async handoffs() { return (await f.deliveryStore().current())!.revision.taskResultHandoffs ?? []; },
    retireCto() {
      const registry = structuredClone(f.values.get(mapKey(f.registryKey))) as { ctos: Array<Record<string, unknown>> };
      registry.ctos[0]!.status = "RETIRED"; f.values.set(mapKey(f.registryKey), registry as JsonValue);
    },
  };
}
