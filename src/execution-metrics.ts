import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "./domain/task-workers.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { readProjectCtos } from "./project-cto-tools.ts";
import { createTaskPacketStore } from "./task-packet-tools.ts";
import { deriveTaskWorkerFileBinding, readTaskWorkerSessionRun } from "./task-worker-runtime.ts";
import { readWorkstreams } from "./workstream-tools.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_RUNS = 128;
type Timing = Readonly<{ createdAt: string; startedAt: string | null; finishedAt: string | null }>;
export type WorkerExecutionMetric = Readonly<{ ctoId: string; workstreamId: string; taskId: string; role: "worker" | "qa";
  packetRevision: number; requestId: string; runId: string | null; runStatus: string;
  normalEnded: boolean; timing: Timing | null; queueMs: number | null; executionMs: number | null; reason: string | null }>;
export type ExecutionMetrics = Readonly<{ status: "ready"; workspaceId: string; projectId: string; observedAt: string;
  consistency: "rechecked-current-records-not-a-global-transaction";
  runs: readonly WorkerExecutionMetric[]; summary: Readonly<{ observedRuns: number; normalEndedRuns: number;
    measuredRuns: number; totalExecutionMs: number | null; totalQueueMs: number | null }>;
  unmeasured: Readonly<{ taskCompletionMs: null; permissionWaitMs: null; integrationWaitMs: null;
    reworkCount: null; manualInterventionCount: null }>; completionAuthority: "not-established" }>;

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

/** Missing Host timing is unmeasured, never a zero-duration execution. */
export function readExecutionTiming(value: unknown, runStatus: string, observedAt: string) {
  try {
    const row = exactToolRecord(value, ["createdAt", "startedAt", "finishedAt"]);
    const created = instant(row.createdAt), started = row.startedAt === null ? null : instant(row.startedAt);
    const finished = row.finishedAt === null ? null : instant(row.finishedAt), observed = instant(observedAt);
    if (created === null || observed === null || created > observed || row.startedAt !== null && started === null
      || row.finishedAt !== null && finished === null || started !== null && (started < created || started > observed)
      || finished !== null && (started === null || finished < started || finished > observed)
      || ["queued", "running"].includes(runStatus) && finished !== null) return null;
    const queueMs = started === null ? null : started - created;
    const executionMs = started === null || finished === null ? null : finished - started;
    if ([queueMs, executionMs].some(time => time !== null && !Number.isSafeInteger(time))) return null;
    return { timing: { createdAt: row.createdAt as string, startedAt: row.startedAt as string | null, finishedAt: row.finishedAt as string | null },
      queueMs, executionMs };
  } catch { return null; }
}

/** Read-only current Task/Worker observations. Run termination is not Task acceptance or QA. */
export async function readBuilderExecutionMetrics(workspaceId: string, platform: SpsPlatformInvocationContext): Promise<ExecutionMetrics
  | Readonly<{ status: "unknown"; reason: string }>> {
  if (!UUID.test(workspaceId)) throw new TypeError("Execution metrics require the current Workspace.");
  const heads = new Map<string, { key: SpsStateKey; value: JsonValue | null }>();
  const tracked = { ...platform, state: { ...platform.state, async get(key: SpsStateKey) {
    if (key.scopeKind !== "company" || key.scopeId !== workspaceId) throw new Error("Metrics escaped their Workspace.");
    const value = await platform.state.get(key);
    if (!key.stateKey.includes("-revision.v1.")) {
      const identity = JSON.stringify([key.namespace ?? "default", key.stateKey]), previous = heads.get(identity);
      if (previous && JSON.stringify(previous.value) !== JSON.stringify(value)) throw new Error("Metrics source changed.");
      heads.set(identity, { key, value: structuredClone(value) });
    }
    return value;
  } } };
  const check = async () => {
    for (const { key, value } of heads.values()) if (JSON.stringify(await platform.state.get(key)) !== JSON.stringify(value)) {
      throw new Error("Metrics source changed.");
    }
  };
  try {
    const board = await readWorkstreams(workspaceId, workspaceId, tracked), ctos = await readProjectCtos(workspaceId, workspaceId, tracked);
    if ((board?.revision.workstreams.length ?? 0) > 64 || ctos.ctos.length > 64) return { status: "unknown", reason: "metrics-scope-over-bound" };
    const runs: WorkerExecutionMetric[] = [], seenRuns = new Set<string>();
    const observedAt = new Date().toISOString();
    for (const workstream of board?.revision.workstreams ?? []) {
      const ctoId = workstream.spec.assignedCtoId, workstreamId = workstream.spec.id;
      if (!ctos.ctos.some(cto => cto.ctoId === ctoId && cto.status !== "RETIRED")) throw new Error("Metrics CTO is not current.");
      const packets = await createTaskPacketStore(workspaceId, workspaceId, ctoId, workstreamId, tracked.state).current();
      const registry = parseTaskWorkerRegistry(await tracked.state.get({ scopeKind: "company", scopeId: workspaceId,
        namespace: "sonpark.my-builder", stateKey: taskWorkerRegistryKey(workspaceId, ctoId) }) ?? { schemaVersion: 1,
        workspaceId, projectId: workspaceId, ctoId, revision: 0, records: [] }, workspaceId, workspaceId, ctoId);
      for (const worker of registry.records.filter(item => item.workstreamId === workstreamId)) {
        if (worker.source.specRevision !== workstream.spec.revision
          || worker.source.instructionSha256 !== workstreamInstructionDigest(workstream)) continue;
        const packet = packets?.revision.packets.find(item => item.packet.taskId === worker.taskId);
        if (!packet) continue;
        let binding;
        try { binding = deriveTaskWorkerFileBinding({ workspaceId, projectId: workspaceId, ctoId, packet,
          currentPackets: packets!.revision.packets, worker }); }
        catch { continue; }
        if (runs.length >= MAX_RUNS) return { status: "unknown", reason: "metrics-run-inventory-over-bound" };
        const observation = await readTaskWorkerSessionRun({ platform: tracked, binding, assertCurrent: check });
        const base = { ctoId, workstreamId, taskId: worker.taskId, role: worker.role, packetRevision: worker.packetRevision,
          requestId: observation.requestId, runId: observation.runId };
        if (observation.status !== "observed") {
          runs.push({ ...base, runStatus: observation.status, normalEnded: false, timing: null, queueMs: null, executionMs: null, reason: observation.reason });
          continue;
        }
        if (seenRuns.has(observation.runId)) throw new Error("One Run is bound to multiple Worker records.");
        seenRuns.add(observation.runId);
        const current = await tracked.agents.sessions.getRun(worker.sessionId, workspaceId, observation.runId);
        if (current.runId !== observation.runId || current.status !== observation.runStatus) throw new Error("Run changed during metrics read.");
        const timingField = Object.getOwnPropertyDescriptor(current, "timing");
        const parsed = timingField?.enumerable && Object.hasOwn(timingField, "value")
          ? readExecutionTiming(timingField.value, current.status, observedAt) : null;
        runs.push({ ...base, runStatus: current.status, normalEnded: current.status === "succeeded" && current.cancellationRequested === false
          && current.termination === "not_applicable", timing: parsed?.timing ?? null, queueMs: parsed?.queueMs ?? null,
          executionMs: parsed?.executionMs ?? null, reason: parsed ? null : "host-run-timing-unavailable-or-inconsistent" });
      }
    }
    await check();
    const executions = runs.filter(run => run.executionMs !== null), queues = runs.filter(run => run.queueMs !== null);
    const totalExecutionMs = executions.length ? executions.reduce((sum, run) => sum + run.executionMs!, 0) : null;
    const totalQueueMs = queues.length ? queues.reduce((sum, run) => sum + run.queueMs!, 0) : null;
    if ([totalExecutionMs, totalQueueMs].some(time => time !== null && !Number.isSafeInteger(time))) {
      return { status: "unknown", reason: "metrics-duration-over-bound" };
    }
    return { status: "ready", workspaceId, projectId: workspaceId, observedAt,
      consistency: "rechecked-current-records-not-a-global-transaction", runs,
      summary: { observedRuns: runs.filter(run => run.runId !== null && !["unknown", "unsupported", "pending"].includes(run.runStatus)).length,
        normalEndedRuns: runs.filter(run => run.normalEnded).length, measuredRuns: executions.length,
        totalExecutionMs, totalQueueMs },
      unmeasured: { taskCompletionMs: null, permissionWaitMs: null, integrationWaitMs: null, reworkCount: null, manualInterventionCount: null },
      completionAuthority: "not-established" };
  } catch { return { status: "unknown", reason: "metrics-current-scope-or-run-observation-unavailable" }; }
}
