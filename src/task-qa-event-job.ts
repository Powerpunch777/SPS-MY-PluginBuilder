import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { readWorkstreams } from "./workstream-tools.ts";
import { createTaskPacketStore } from "./task-packet-tools.ts";
import { createTaskQaRunReferenceStore, recordDeferredTaskQaEvent, type TaskQaRunReference } from "./task-qa-run-references.ts";
import { createTaskQaReportStore } from "./task-qa-reports.ts";
import { readTaskQaEventOrigin } from "./task-worker-tools.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "./task-worker-runtime.ts";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "./domain/task-workers.ts";
import { readAcceptedTaskSourceForQa } from "./task-source-acceptance.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { parseProtectedRun } from "./task-protected-qa.ts";
import { readWorkspaceSourceGitTipProof } from "./workspace-source-git-tip.ts";
import type { RevisionState, RevisionPublicationGuard } from "./solution-revision-store.ts";

type Host = SpsPlatformInvocationContext & {
  protectedTests?: { getRunV1?: (companyId: string, runId: string, subjectKeySha256: string) => Promise<unknown> };
  localFolders?: { readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown> };
};
type Terminal = Readonly<{ runId: string; status: string; receiptDigest: string; subjectKeySha256: string }>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const key = (workspaceId: string, stateKey: string) => ({ scopeKind: "company" as const, scopeId: workspaceId,
  namespace: "sonpark.my-builder", stateKey });
const pending = (reason: string) => ({ status: "unknown" as const, reason });

async function references(workspaceId: string, platform: Host, match: (value: TaskQaRunReference) => boolean) {
  const board = await readWorkstreams(workspaceId, workspaceId, platform);
  if (!board || board.revision.workstreams.length > 128) throw new Error("Current Workstream board is unavailable or over bound.");
  const found: TaskQaRunReference[] = [];
  let scanned = 0;
  for (const workstream of board.revision.workstreams) {
    const ctoId = workstream.spec.assignedCtoId;
    if (!ctoId) continue;
    const tasks = await createTaskPacketStore(workspaceId, workspaceId, ctoId, workstream.spec.id, platform.state).current();
    for (const task of tasks?.revision.packets ?? []) {
      if (task.packet.kind !== "qa") continue;
      if (++scanned > 512) throw new Error("QA reference scan exceeds its observation bound.");
      const value = (await createTaskQaRunReferenceStore({ workspaceId, projectId: workspaceId, ctoId,
        workstreamId: workstream.spec.id, qaTaskId: task.packet.taskId }, platform.state).current())?.revision;
      if (value && match(value)) found.push(value);
    }
  }
  return found;
}

function trackedPlatform(workspaceId: string, platform: Host) {
  const captured = new Map<string, RevisionPublicationGuard>();
  const state = { ...platform.state, async get(selected: SpsStateKey) {
    if (selected.scopeKind !== "company" || selected.scopeId !== workspaceId) throw new Error("QA event read escaped its Workspace.");
    const value = await platform.state.get(selected);
    if (value !== null) {
      const id = JSON.stringify([selected.namespace ?? "default", selected.stateKey]);
      const prior = captured.get(id);
      if (prior && JSON.stringify(prior.expectedValue) !== JSON.stringify(value)) throw new Error("QA event inputs changed during observation.");
      captured.set(id, { stateKey: selected.stateKey, namespace: selected.namespace, expectedValue: value });
    }
    return value;
  } };
  return { platform: { ...platform, state } as Host, guards(writingReference = false) {
    const guards = [...captured.values()].filter(guard => !guard.stateKey.includes("-revision.v1.")
      && (!writingReference || !guard.stateKey.startsWith("task-protected-qa-runs-head.v1.")));
    if (!guards.length || guards.length > 64 || Buffer.byteLength(JSON.stringify(guards), "utf8") > 200_000) {
      throw new Error("QA event source guard inventory is unavailable or over bound.");
    }
    return guards;
  } };
}

async function observeOrigin(reference: TaskQaRunReference, platform: Host) {
  const { scope, binding } = reference;
  const current = (await createTaskQaRunReferenceStore(scope, platform.state).current())?.revision;
  if (current?.revisionId !== reference.revisionId) throw new Error("QA run reference is no longer current.");
  const board = await createTaskPacketStore(scope.workspaceId, scope.projectId, scope.ctoId, scope.workstreamId, platform.state).current();
  const packet = board?.revision.packets.find(row => row.packet.taskId === scope.qaTaskId);
  const rawRegistry = await platform.state.get(key(scope.workspaceId, taskWorkerRegistryKey(scope.projectId, scope.ctoId)));
  const registry = parseTaskWorkerRegistry(rawRegistry, scope.workspaceId, scope.projectId, scope.ctoId);
  const workers = registry.records.filter(row => row.role === "qa" && row.sessionId === binding.qaSessionId && row.agentId === binding.qaAgentId
    && row.taskId === scope.qaTaskId && row.workstreamId === scope.workstreamId && row.packetRecordSha256 === binding.qaDigest);
  if (!packet || !board || workers.length !== 1) throw new Error("Current QA Task and registration do not match the event reference.");
  const workerBinding = deriveTaskWorkerFileBinding({ workspaceId: scope.workspaceId, projectId: scope.projectId,
    ctoId: scope.ctoId, packet, currentPackets: board.revision.packets, worker: workers[0]! });
  const request = exactToolRecord(await platform.agents.sessions.getRequest(binding.qaSessionId, scope.workspaceId, taskWorkerRequestId(workerBinding)),
    ["requestId", "state", "runId"]);
  if (request.state !== "submitted" || request.requestId !== taskWorkerRequestId(workerBinding)
    || typeof request.runId !== "string" || !uuid.test(request.runId)) throw new Error("Original QA request is unavailable.");
  const context = { companyId: scope.workspaceId, projectId: scope.projectId, agentId: binding.qaAgentId,
    sessionId: binding.qaSessionId, runId: request.runId };
  const origin = await readTaskQaEventOrigin(context, platform);
  const implementation = origin.currentPackets.find(row => row.packet.taskId === binding.implementationTaskId);
  if (!implementation || origin.binding.packetRecordSha256 !== binding.qaDigest) throw new Error("QA event Task pins changed.");
  const assertCurrent = async () => { await readTaskQaEventOrigin(context, platform); };
  const accepted = await readAcceptedTaskSourceForQa({ workspaceId: scope.workspaceId, projectId: scope.projectId,
    ctoId: scope.ctoId, workstreamId: scope.workstreamId, task: implementation, packets: origin.currentPackets,
    workerRecords: origin.workerRecords, state: platform.state, platform, assertCurrent });
  if (accepted.status !== "accepted" || accepted.acceptance.acceptanceId !== binding.acceptanceId
    || accepted.submission.submissionId !== binding.submissionId || accepted.submission.commitSha !== binding.commitSha
    || accepted.submission.treeSha !== binding.treeSha) throw new Error("QA event accepted Source is stale or unavailable.");
  if (typeof platform.localFolders?.readWorkspaceSourceGitTipV1 !== "function") throw new Error("Current Source Git reader is unavailable.");
  const tip = readWorkspaceSourceGitTipProof(await platform.localFolders.readWorkspaceSourceGitTipV1(binding.sourceId, binding.folderKey, binding.branch));
  if (tip.status !== "current" || tip.sourceId !== binding.sourceId || tip.folderKey !== binding.folderKey || tip.branch !== binding.branch
    || tip.commitSha !== binding.commitSha || tip.treeSha !== binding.treeSha) throw new Error("QA event Source Commit or Tree changed.");
  const run = await platform.agents.sessions.getRun(binding.qaSessionId, scope.workspaceId, request.runId);
  return { context, active: run.status === "running", assertCurrent };
}

async function hasRecordedAssessment(reference: TaskQaRunReference, receiptDigest: string, platform: Host) {
  const report = (await createTaskQaReportStore(reference.scope, platform.state).current())?.revision;
  return report?.reference.binding.runId === reference.binding.runId
    && report.coreReceiptDigest === receiptDigest;
}

/** Uses the existing event Job and Task reference journal; never sends a user prompt. */
export async function consumeTaskQaProtectedTerminal(workspaceId: string, eventId: string, payload: Terminal, platformInput: SpsPlatformInvocationContext) {
  const platform = platformInput as Host;
  const matches = await references(workspaceId, platform, ref => ref.binding.runId === payload.runId
    && ref.binding.subjectKeySha256 === payload.subjectKeySha256);
  if (!matches.length) return { status: "not-applicable" as const };
  if (matches.length !== 1) return pending("protected-event-matches-multiple-qa-references");
  let reference = matches[0]!;
  const api = platform.protectedTests;
  if (typeof api?.getRunV1 !== "function") return { status: "unsupported" as const, reason: "protected-run-reader-unavailable" };
  const core = parseProtectedRun(await api.getRunV1(workspaceId, payload.runId, payload.subjectKeySha256));
  const receipt = core.receipt as { digest?: unknown } | null;
  const b = reference.binding;
  if (core.id !== b.runId || core.status !== payload.status || core.termination !== "confirmed" || receipt?.digest !== payload.receiptDigest
    || core.pins.sourceId !== b.sourceId || core.pins.approvalId !== b.approvalId || core.pins.planSha256 !== b.planSha256
    || core.pins.commitSha !== b.commitSha || core.pins.treeSha !== b.treeSha || core.pins.subjectKeySha256 !== b.subjectKeySha256) {
    return pending("protected-event-core-receipt-or-source-pins-disagree");
  }
  if (await hasRecordedAssessment(reference, payload.receiptDigest, platform)) {
    return { status: "ignored" as const, reason: "qa-assessment-already-recorded-no-wake" };
  }
  const initial = trackedPlatform(workspaceId, platform);
  const origin = await observeOrigin(reference, initial.platform);
  const linked = await recordDeferredTaskQaEvent(platform.state as RevisionState, reference,
    { eventId, previousRunId: origin.context.runId, receiptDigest: payload.receiptDigest }, initial.guards(true));
  if (linked.status !== "recorded" && linked.status !== "existing") return pending("qa-event-reference-link-unconfirmed");
  reference = linked.reference;
  const current = trackedPlatform(workspaceId, platform);
  const ready = await observeOrigin(reference, current.platform);
  if (ready.active) return { status: "waiting" as const, reason: "qa-origin-still-running-wait-for-system-terminal-event" };
  if (await hasRecordedAssessment(reference, payload.receiptDigest, current.platform)) {
    return { status: "ignored" as const, reason: "qa-assessment-already-recorded-no-wake" };
  }
  const sessions = platform.agents.sessions as typeof platform.agents.sessions & {
    dispatchProtectedEventV1?: (sessionId: string, companyId: string, input: { previousRunId: string; eventId: string;
      protectedRunId: string; guards: readonly RevisionPublicationGuard[] }) => Promise<{ requestId: string; runId: string; replayed: boolean }>;
  };
  if (typeof sessions.dispatchProtectedEventV1 !== "function") return { status: "unsupported" as const, reason: "core-protected-event-dispatch-unavailable" };
  const sent = await sessions.dispatchProtectedEventV1(b.qaSessionId, workspaceId, { previousRunId: ready.context.runId,
    eventId, protectedRunId: b.runId, guards: current.guards() });
  if (!sent || !uuid.test(sent.requestId) || !uuid.test(sent.runId) || typeof sent.replayed !== "boolean") return pending("qa-event-dispatch-receipt-invalid");
  return { status: "accepted" as const, eventId, reason: "core-qa-event-request-accepted-not-qa-completion",
    requestId: sent.requestId, runId: sent.runId, receipt: { receiptId: sent.requestId, runId: sent.runId } };
}

/** A protected event arriving before the QA turn closes is resumed by its real terminal event. */
export async function consumeTaskQaOriginTerminal(workspaceId: string, payload: { sessionId: string; runId: string; requestId: string },
  platformInput: SpsPlatformInvocationContext) {
  const platform = platformInput as Host;
  const matches = await references(workspaceId, platform, ref => ref.binding.qaSessionId === payload.sessionId
    && ref.deferredEvent?.previousRunId === payload.runId);
  if (!matches.length) return { status: "not-applicable" as const };
  if (matches.length !== 1) return pending("qa-terminal-origin-matches-multiple-current-references");
  const reference = matches[0]!, event = reference.deferredEvent!;
  const request = await platform.agents.sessions.getRequest(payload.sessionId, workspaceId, payload.requestId);
  if (request?.state !== "submitted" || request.runId !== payload.runId) return pending("qa-terminal-origin-request-does-not-match-core");
  const raw = await platform.protectedTests?.getRunV1?.(workspaceId, reference.binding.runId, reference.binding.subjectKeySha256);
  const core = parseProtectedRun(raw);
  return consumeTaskQaProtectedTerminal(workspaceId, event.eventId, { runId: core.id, status: core.status,
    receiptDigest: event.receiptDigest, subjectKeySha256: reference.binding.subjectKeySha256 }, platform);
}
