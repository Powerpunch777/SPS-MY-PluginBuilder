import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { TaskPacketRecord } from "./domain/task-packets.ts";
import { taskPacketRecordDigest } from "./domain/task-packets.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { createTaskQaRunReferenceStore } from "./task-qa-run-references.ts";
import type { RevisionState } from "./solution-revision-store.ts";
import type { TaskWorkerFileBinding } from "./task-worker-runtime.ts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const fail = () => new Error("The QA continuation does not match the exact current Task and Core event request.");
export type TaskQaContinuationAuthority = Readonly<{ runId: string; previousRunId: string; requestId: string;
  eventId: string; protectedRunId: string; receiptDigest: string }>;

/** A Core lineage observation alone is not QA authority. Bind it to the current immutable Task reference. */
export async function resolveTaskQaContinuationAuthority(input: Readonly<{
  binding: TaskWorkerFileBinding; packet: TaskPacketRecord; packets: readonly TaskPacketRecord[];
  originalRunId: string; activeRunId: string; activeRun: unknown; platform: SpsPlatformInvocationContext;
}>): Promise<TaskQaContinuationAuthority> {
  const { binding, packet, packets, platform } = input;
  if (binding.role !== "qa" || packet.packet.kind !== "qa" || input.originalRunId === input.activeRunId) throw fail();
  const run = exactToolRecord(input.activeRun, ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"],
    ["execution", "output", "timing", "systemEvent"]);
  const event = exactToolRecord(run.systemEvent, ["schemaVersion", "kind", "requestId", "previousRunId", "eventId",
    "protectedRunId", "receiptDigest", "subjectKeySha256"]);
  if (run.runId !== input.activeRunId || run.status !== "running" || run.cancellationRequested !== false
    || run.termination !== "not_applicable" || event.schemaVersion !== 1 || event.kind !== "protected-test-terminal-event"
    || event.previousRunId !== input.originalRunId
    || [event.requestId, event.previousRunId, event.protectedRunId].some(value => typeof value !== "string" || !uuid.test(value))
    || [event.receiptDigest, event.subjectKeySha256].some(value => typeof value !== "string" || !sha.test(value))) throw fail();
  const parts = typeof event.eventId === "string" ? event.eventId.split(":") : [];
  if (parts.length !== 5 || parts[0] !== "sps-protected-test-terminal-v1" || parts[1] !== event.protectedRunId
    || parts[2] !== event.receiptDigest || parts[3] !== event.subjectKeySha256 || !uuid.test(parts[4] ?? "")) throw fail();
  const sessions = platform.agents.sessions;
  const accepted = exactToolRecord(await sessions.getRequest(binding.sessionId, binding.workspaceId, event.requestId as string),
    ["requestId", "state", "runId"]);
  if (accepted.requestId !== event.requestId || accepted.state !== "submitted" || accepted.runId !== input.activeRunId) throw fail();
  const previous = exactToolRecord(await sessions.getRun(binding.sessionId, binding.workspaceId, input.originalRunId),
    ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"], ["execution", "output", "timing", "systemEvent"]);
  if (previous.runId !== input.originalRunId || !["succeeded", "failed", "interrupted", "timed_out"].includes(String(previous.status))
    || previous.cancellationRequested !== false || previous.termination !== "not_applicable") throw fail();
  const reference = (await createTaskQaRunReferenceStore({ workspaceId: binding.workspaceId, projectId: binding.projectId,
    ctoId: binding.ctoId, workstreamId: binding.workstreamId, qaTaskId: binding.taskId }, platform.state as RevisionState).current())?.revision;
  const pins = reference?.binding;
  if (!pins || pins.runId !== event.protectedRunId || pins.subjectKeySha256 !== event.subjectKeySha256
    || pins.qaAgentId !== binding.agentId || pins.qaSessionId !== binding.sessionId || pins.qaRevision !== binding.packetRevision
    || pins.qaDigest !== binding.packetRecordSha256 || pins.sourceId !== binding.sourceAccess.sourceId
    || pins.folderKey !== binding.sourceAccess.folderKey || pins.branch !== binding.sourceAccess.branch) throw fail();
  const implementation = packets.find(row => row.packet.taskId === pins.implementationTaskId);
  if (!implementation || implementation.packet.kind !== "development" || implementation.packet.revision !== pins.implementationRevision
    || taskPacketRecordDigest(implementation, binding.projectId, binding.ctoId, binding.workstreamId) !== pins.implementationDigest
    || !packet.dependencyPins.some(pin => pin.taskId === implementation.packet.taskId && pin.revision === pins.implementationRevision
      && pin.recordSha256 === pins.implementationDigest)) throw fail();
  return Object.freeze({ runId: input.activeRunId, previousRunId: input.originalRunId, requestId: event.requestId as string,
    eventId: event.eventId as string, protectedRunId: event.protectedRunId as string, receiptDigest: event.receiptDigest as string });
}
