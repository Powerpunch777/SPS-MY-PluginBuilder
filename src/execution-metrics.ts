import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey, type TaskWorkerRecord } from "./domain/task-workers.ts";
import { taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { readProjectCtos } from "./project-cto-tools.ts";
import { createTaskPacketStore } from "./task-packet-tools.ts";
import { deriveTaskWorkerFileBinding, readTaskWorkerSessionRun } from "./task-worker-runtime.ts";
import { readCtoTaskSourceAcceptanceForSubmission } from "./task-source-acceptance.ts";
import { readTaskSourceClaim, type TaskSourceSubmissionBinding } from "./task-source-submissions.ts";
import type { RevisionState } from "./solution-revision-store.ts";
import { readWorkstreams } from "./workstream-tools.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_RUNS = 128;
type Timing = Readonly<{ createdAt: string; startedAt: string | null; finishedAt: string | null }>;
export type WorkerExecutionMetric = Readonly<{ ctoId: string; workstreamId: string; taskId: string; role: "worker" | "qa";
  packetRevision: number; requestId: string; runId: string | null; runStatus: string;
  normalEnded: boolean; timing: Timing | null; queueMs: number | null; executionMs: number | null; reason: string | null;
  commitAcceptanceMs: number | null }>;
export type ExecutionMetrics = Readonly<{ status: "ready"; workspaceId: string; projectId: string; observedAt: string;
  consistency: "rechecked-current-records-not-a-global-transaction";
  runs: readonly WorkerExecutionMetric[]; summary: Readonly<{ observedRuns: number; normalEndedRuns: number;
    measuredRuns: number; totalExecutionMs: number | null; totalQueueMs: number | null;
    commitAcceptanceCount: number; totalCommitAcceptanceMs: number | null }>;
  unmeasured: Readonly<{ taskCompletionMs: null; permissionWaitMs: null; integrationWaitMs: null;
    reworkCount: null; manualInterventionCount: null }>; completionAuthority: "not-established" }>;

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

async function currentCommitAcceptanceMs(input: Readonly<{ workspaceId: string; projectId: string; ctoId: string;
  workstreamId: string; packet: TaskPacketRecord; worker: TaskWorkerRecord; packets: readonly TaskPacketRecord[];
  platform: SpsPlatformInvocationContext; assertCurrent(): Promise<void> }>): Promise<number | null> {
  if (input.worker.role !== "worker" || !input.packet?.packet.sourceAccess?.branch || !input.packet.packet.sourceAccess.expectedHead) return null;
  try {
    const packetDigest = taskPacketRecordDigest(input.packet, input.projectId, input.ctoId, input.workstreamId);
    if (packetDigest !== input.worker.packetRecordSha256 || input.packet.packet.kind !== "development"
      || input.packet.packet.revision !== input.worker.packetRevision
      || input.packet.dependencyPins.some(pin => {
        const dependency = input.packets.find(row => row.packet.taskId === pin.taskId);
        return !dependency || dependency.packet.revision !== pin.revision
          || taskPacketRecordDigest(dependency, input.projectId, input.ctoId, input.workstreamId) !== pin.recordSha256;
      })) return null;
    const access = input.packet.packet.sourceAccess;
    const branch = access.branch, expectedHead = access.expectedHead;
    if (typeof branch !== "string" || !branch || typeof expectedHead !== "string" || !expectedHead) return null;
    const binding: Omit<TaskSourceSubmissionBinding, "runId"> = Object.freeze({
      schemaVersion: 1, workspaceId: input.workspaceId, projectId: input.projectId, ctoId: input.ctoId,
      workstreamId: input.workstreamId, taskId: input.packet.packet.taskId, packetRevision: input.packet.packet.revision,
      packetRecordSha256: packetDigest, dependencyPins: input.packet.dependencyPins, role: input.worker.role,
      agentId: input.worker.agentId, sessionId: input.worker.sessionId,
      source: Object.freeze({ sourceId: access.sourceId, folderKey: access.folderKey, branch, expectedHead }),
      readPaths: access.readPaths, writePaths: access.writePaths, qaWritePaths: access.qaWritePaths,
    });
    const state = input.platform.state as typeof input.platform.state & RevisionState;
    const claim = await readTaskSourceClaim({ state, binding });
    await input.assertCurrent();
    if (claim.status !== "submitted") return null;
    const submission = claim.submission;
    if (submission.role !== "worker" || submission.authorityAfterCommit !== "current"
      || submission.workspaceId !== input.workspaceId || submission.projectId !== input.projectId
      || submission.ctoId !== input.ctoId || submission.workstreamId !== input.workstreamId
      || submission.taskId !== input.packet.packet.taskId || submission.packetRevision !== input.packet.packet.revision
      || submission.packetRecordSha256 !== packetDigest) return null;
    const acceptance = await readCtoTaskSourceAcceptanceForSubmission({ workspaceId: input.workspaceId, submission, state });
    await input.assertCurrent();
    if (!acceptance || acceptance.submissionId !== submission.submissionId || acceptance.commitSha !== submission.commitSha
      || acceptance.treeSha !== submission.treeSha || acceptance.workspaceId !== input.workspaceId
      || acceptance.projectId !== input.projectId || acceptance.ctoId !== input.ctoId
      || acceptance.workstreamId !== input.workstreamId || acceptance.taskId !== input.packet.packet.taskId
      || acceptance.packetRevision !== input.packet.packet.revision || acceptance.packetRecordSha256 !== packetDigest
      || instant(submission.submittedAt) === null || instant(acceptance.receivedAt) === null) return null;
    const submittedAt = instant(submission.submittedAt)!, receivedAt = instant(acceptance.receivedAt)!;
    const observedAt = instant(new Date().toISOString());
    const elapsed = receivedAt - submittedAt;
    if (observedAt === null || submittedAt > receivedAt || receivedAt > observedAt || !Number.isSafeInteger(elapsed) || elapsed < 0) return null;
    return elapsed;
  } catch { return null; }
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
  const track = (scope: Set<string>) => ({ ...platform, state: { ...platform.state, async get(key: SpsStateKey) {
    if (key.scopeKind !== "company" || key.scopeId !== workspaceId) throw new Error("Metrics escaped their Workspace.");
    const value = await platform.state.get(key);
    if (!key.stateKey.includes("-revision.v1.")) {
      const identity = JSON.stringify([key.namespace ?? "default", key.stateKey]), previous = heads.get(identity);
      if (previous && JSON.stringify(previous.value) !== JSON.stringify(value)) throw new Error("Metrics source changed.");
      if (!previous) heads.set(identity, { key, value: structuredClone(value) });
      scope.add(identity);
    }
    return value;
  } } });
  const check = async (scope: Iterable<string> = heads.keys()) => {
    for (const identity of scope) {
      const { key, value } = heads.get(identity)!;
      if (JSON.stringify(await platform.state.get(key)) !== JSON.stringify(value)) throw new Error("Metrics source changed.");
    }
  };
  try {
    const sharedScope = new Set<string>(), tracked = track(sharedScope);
    const board = await readWorkstreams(workspaceId, workspaceId, tracked), ctos = await readProjectCtos(workspaceId, workspaceId, tracked);
    if ((board?.revision.workstreams.length ?? 0) > 64 || ctos.ctos.length > 64) return { status: "unknown", reason: "metrics-scope-over-bound" };
    const runs: WorkerExecutionMetric[] = [], seenRuns = new Set<string>();
    for (const workstream of board?.revision.workstreams ?? []) {
      const ctoId = workstream.spec.assignedCtoId, workstreamId = workstream.spec.id;
      if (!ctos.ctos.some(cto => cto.ctoId === ctoId && cto.status !== "RETIRED")) throw new Error("Metrics CTO is not current.");
      const workstreamScope = new Set(sharedScope), workstreamPlatform = track(workstreamScope);
      const packets = await createTaskPacketStore(workspaceId, workspaceId, ctoId, workstreamId, workstreamPlatform.state).current();
      const registry = parseTaskWorkerRegistry(await workstreamPlatform.state.get({ scopeKind: "company", scopeId: workspaceId,
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
        const rowScope = new Set(workstreamScope), rowPlatform = track(rowScope);
        const assertCurrent = () => check(rowScope);
        const commitAcceptanceMs = worker.role === "worker" ? await currentCommitAcceptanceMs({ workspaceId,
          projectId: workspaceId, ctoId, workstreamId, packet, worker, packets: packets!.revision.packets,
          platform: rowPlatform, assertCurrent }) : null;
        const observation = await readTaskWorkerSessionRun({ platform: rowPlatform, binding, assertCurrent });
        const base = { ctoId, workstreamId, taskId: worker.taskId, role: worker.role, packetRevision: worker.packetRevision,
          requestId: observation.requestId, runId: observation.runId, commitAcceptanceMs };
        if (observation.status !== "observed") {
          runs.push({ ...base, runStatus: observation.status, normalEnded: false, timing: null, queueMs: null, executionMs: null, reason: observation.reason });
          continue;
        }
        if (seenRuns.has(observation.runId)) throw new Error("One Run is bound to multiple Worker records.");
        seenRuns.add(observation.runId);
        const current = await rowPlatform.agents.sessions.getRun(worker.sessionId, workspaceId, observation.runId);
        if (current.runId !== observation.runId || current.status !== observation.runStatus) throw new Error("Run changed during metrics read.");
        const timingObservedAt = new Date().toISOString();
        const timingField = Object.getOwnPropertyDescriptor(current, "timing");
        const parsed = timingField?.enumerable && Object.hasOwn(timingField, "value")
          ? readExecutionTiming(timingField.value, current.status, timingObservedAt) : null;
        runs.push({ ...base, runStatus: current.status, normalEnded: current.status === "succeeded" && current.cancellationRequested === false
          && current.termination === "not_applicable", timing: parsed?.timing ?? null, queueMs: parsed?.queueMs ?? null,
          executionMs: parsed?.executionMs ?? null, reason: parsed ? null : "host-run-timing-unavailable-or-inconsistent" });
      }
    }
    const observedAt = new Date().toISOString();
    // Recheck every observed mutable record once before returning the full projection.
    await check();
    const executions = runs.filter(run => run.executionMs !== null), queues = runs.filter(run => run.queueMs !== null);
    const acceptedCommits = runs.filter(run => run.commitAcceptanceMs !== null);
    const totalExecutionMs = executions.length ? executions.reduce((sum, run) => sum + run.executionMs!, 0) : null;
    const totalQueueMs = queues.length ? queues.reduce((sum, run) => sum + run.queueMs!, 0) : null;
    const totalCommitAcceptanceMs = acceptedCommits.length
      ? acceptedCommits.reduce((sum, run) => sum + run.commitAcceptanceMs!, 0) : null;
    if ([totalExecutionMs, totalQueueMs, totalCommitAcceptanceMs].some(time => time !== null && !Number.isSafeInteger(time))) {
      return { status: "unknown", reason: "metrics-duration-over-bound" };
    }
    return { status: "ready", workspaceId, projectId: workspaceId, observedAt,
      consistency: "rechecked-current-records-not-a-global-transaction", runs,
      summary: { observedRuns: runs.filter(run => run.runId !== null && !["unknown", "unsupported", "pending"].includes(run.runStatus)).length,
        normalEndedRuns: runs.filter(run => run.normalEnded).length, measuredRuns: executions.length,
        totalExecutionMs, totalQueueMs, commitAcceptanceCount: acceptedCommits.length, totalCommitAcceptanceMs },
      unmeasured: { taskCompletionMs: null, permissionWaitMs: null, integrationWaitMs: null, reworkCount: null, manualInterventionCount: null },
      completionAuthority: "not-established" };
  } catch { return { status: "unknown", reason: "metrics-current-scope-or-run-observation-unavailable" }; }
}
