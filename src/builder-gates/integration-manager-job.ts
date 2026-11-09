import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey, integrationManagerStateKey,
  parseIntegrationManagerBinding, parseIntegrationManagerSessionBinding } from "../domain/integration-manager.ts";
import { parseLeadAgentBinding } from "../domain/lead-agent.ts";
import { parseLeadSessions } from "../domain/lead-sessions.ts";
import { readProjectCtos } from "../project-cto-tools.ts";
import { exactToolRecord } from "../lead-tool-authority.ts";
import { WORKSTREAM_VERIFIED_EVENT, WORKSTREAM_VERIFIED_JOB, createWorkstreamVerificationPublication } from "./workstream-verification-publication.ts";
import { consumeVerifiedWorkstream, queueProtectedContinuationRecheck,
  readVerifiedWorkstreamReservation, reserveProtectedContinuation, startProtectedContinuation, finishProtectedContinuation,
  failProtectedContinuation,
  type ManagerDispatchRequest, type ProtectedContinuation, type VerifiedWorkstreamSnapshot } from "./workstream-verification-consumer.ts";
import { readWorkstreams } from "../workstream-tools.ts";
import type { RevisionPublicationGuard, RevisionState } from "../solution-revision-store.ts";
import type { IntegrationPlan } from "./integration-plan.ts";
import { INTEGRATION_MANAGER_SESSION_EXECUTION_POLICY } from "../session-execution-policy.ts";
import { hasConfirmedNotStartedSessionRequest } from "../session-request-diagnostic.ts";
import { consumeTaskQaProtectedTerminal } from "../task-qa-event-job.ts";

export const INTEGRATION_MANAGER_VERIFIED_READ_TOOL = "builder.read-verified-workstream";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ID = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const EVENT_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const MANAGER_REQUEST_NAMESPACE = Buffer.from("5b6e9b0e5a2d4f0184a7d32c40c4a91f", "hex");
const MAX_WORKSTREAMS = 128;
const MAX_TERMINAL_ATTEMPT_LOOKUPS = 512;
const MAX_MANAGER_TOOL_RESPONSE_BYTES = 40 * 1024;
const MANAGER_EXECUTION_TOOLS = INTEGRATION_MANAGER_SESSION_EXECUTION_POLICY.toolNames;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const BUILDER_PLUGIN_ID = "com.sonparkserver.my-plugin-builder";
const PROTECTED_TERMINAL_EVENT = "sps.protected-test.terminal";
const PROTECTED_RECHECK_EVENT = "sps.protected-test.continuation-recheck";
export const MANAGER_SESSION_TERMINAL_JOB = "agent-session-terminal";
const MANAGER_TERMINAL_EVENT = "agent.session.run.terminal";
type Host = SpsPlatformInvocationContext & {
  protectedTests?: { getRunV1?: (workspaceId: string, runId: string, subjectKeySha256: string) => Promise<unknown> };
  localFolders?: {
    matchWorkspaceSourceV1?: (folderKey: string, sourceId: string) => Promise<unknown>;
    readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown>;
  };
  agents: SpsPlatformInvocationContext["agents"] & {
    owned?: { get(input: { companyId: string; pluginAgentKey: string }): Promise<unknown> };
    sessions: SpsPlatformInvocationContext["agents"]["sessions"] & {
      list(agentId: string, companyId: string): Promise<unknown[]>;
      describePolicySupport?(sessionId: string, companyId: string): Promise<unknown>;
      getRequest(sessionId: string, companyId: string, requestId: string): Promise<unknown>;
      getRun(sessionId: string, companyId: string, runId: string): Promise<unknown>;
      dispatchProtectedEventV1?: (sessionId: string, companyId: string, input: { previousRunId: string; eventId: string;
        protectedRunId: string; guards: readonly RevisionPublicationGuard[] }) => Promise<{ requestId: string; runId: string; replayed: boolean }>;
      sendMessage(sessionId: string, companyId: string, options: { requestId: string; prompt: string; reason: string;
        executionPolicy: { mode: "plugin-tools-only-v1"; toolNames: readonly string[] } }): Promise<{ runId: string }>;
    };
  };
};
type Job = Readonly<{ jobKey: string; runId: string; trigger: string; eventId?: string; companyId?: string; event?: unknown }>;
type ManagerAuthority = Readonly<{ agentId: string; sessionId: string; taskKey: string }>;
export type VerifiedEventLookup =
  | Readonly<{ status: "current"; workstreamId: string; snapshot: VerifiedWorkstreamSnapshot }>
  | Readonly<{ status: "stale" | "unknown" | "conflict"; reason: string }>;
const stateKey = (workspaceId: string, stateKey: string) => ({ scopeKind: "company" as const,
  scopeId: workspaceId, namespace: "sonpark.my-builder" as const, stateKey });
const revisionState = (platform: Host) => platform.state as typeof platform.state & RevisionState;
const sha256Json = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

type CurrentIntegrationPlan = Readonly<{ revision: IntegrationPlan; sequence: number }>;
type IntegrationPrerequisite = Readonly<{ status: "ready" | "waiting-dependencies" | "unknown"; reason?: string }>;

async function readIntegrationReadiness(workspaceId: string, workstreamId: string, platform: Host): Promise<Readonly<{
  status: "ready"; plan: CurrentIntegrationPlan; planDigest: string;
}> | Readonly<{ status: "waiting-dependencies" | "unknown"; reason: string }>> {
  const integrationPlan = await import("./integration-plan.ts");
  const plan = await integrationPlan.readCurrentIntegrationPlan(workspaceId, platform);
  if (!plan || !Number.isSafeInteger(plan.sequence) || plan.sequence < 1) {
    return { status: "unknown", reason: "current-integration-plan-unavailable" };
  }
  const prerequisite: IntegrationPrerequisite = await integrationPlan.checkIntegrationPrerequisites(workspaceId, workstreamId, platform);
  if (prerequisite.status !== "ready") return { status: prerequisite.status,
    reason: prerequisite.reason ?? (prerequisite.status === "waiting-dependencies" ? "integration-dependencies-waiting" : "integration-prerequisites-unknown") };
  const latestPlan = await integrationPlan.readCurrentIntegrationPlan(workspaceId, platform);
  if (!latestPlan || sha256Json(latestPlan) !== sha256Json(plan)) {
    return { status: "unknown", reason: "integration-plan-changed-during-prerequisite-check" };
  }
  return { status: "ready", plan, planDigest: sha256Json(plan) };
}

function managerPrompt(request: ManagerDispatchRequest, plan: CurrentIntegrationPlan) {
  const payload = { schemaVersion: 1, type: "builder.verified-workstream.integration-request", requestId: request.requestId,
    eventId: request.eventId, evidenceDigest: request.evidenceDigest, scope: request.scope,
    approvedIntegrationPlan: plan.revision, verifiedEvidence: request.snapshot };
  const prompt = `Integrate only the current approved plan against this exact current verified Workstream evidence.\n${JSON.stringify(payload)}\n`
    + "Use builder.read-verified-workstream and builder.read-integration-progress before acting. "
    + "Record integration work only through builder.integrate-verified-task under the approved plan. "
    + "After all ready Tasks are integrated, request the current candidate's CI and E2E through builder.request-integration-validation when Main has pinned their Host template references. Read actual results through builder.read-integration-progress. "
    + (plan.revision.validationPlans?.regression ? "Request the pinned regression phase for the same current candidate too. " : "")
    + "Only when all evidence is current, hand it to Main using builder.publish-integration-packet with the current final-delivery journal head. Do not represent a queued test as passed. "
    + "This dispatch is admission only; it is not integration completion, CI success, or final delivery approval.";
  if (Buffer.byteLength(prompt, "utf8") > MAX_MANAGER_TOOL_RESPONSE_BYTES) throw new Error("manager-integration-request-exceeds-bounded-prompt");
  return prompt;
}

function safeRunReceipt(value: unknown, expectedRunId: string) {
  return exactObject(value) && value.runId === expectedRunId
    && ["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(String(value.status))
    && typeof value.cancellationRequested === "boolean"
    && ["not_applicable", "pending", "confirmed"].includes(String(value.termination));
}

function platformManagerDispatchPort(input: Readonly<{ workspaceId: string; workstreamId: string; eventId: string;
  authority: ManagerAuthority; planDigest: string; plan: CurrentIntegrationPlan; platform: Host }>) {
  let sendResultRunId: string | null = null;
  const { platform } = input;
  return Object.freeze({
    async dispatch(request: ManagerDispatchRequest) {
      if (request.eventId !== input.eventId || request.scope.workspaceId !== input.workspaceId
        || request.scope.workstreamId !== input.workstreamId || request.scope.projectId !== input.workspaceId) {
        throw new Error("manager-dispatch-request-scope-mismatch");
      }
      const current = await findCurrentEvent(input.workspaceId, input.eventId, platform);
      if (current.status !== "current" || current.workstreamId !== input.workstreamId
        || sha256Json(current.snapshot) !== sha256Json(request.snapshot)) throw new Error("verified-event-changed-before-manager-dispatch");
      const readiness = await readIntegrationReadiness(input.workspaceId, input.workstreamId, platform);
      if (readiness.status !== "ready") throw new Error("integration-plan-or-prerequisites-changed-before-manager-dispatch");
      if (readiness.planDigest !== input.planDigest) throw new Error("integration-plan-or-prerequisites-changed-before-manager-dispatch");
      const authority = await resolveCurrentIntegrationManagerAuthority(input.workspaceId, platform);
      if (authority.agentId !== input.authority.agentId || authority.sessionId !== input.authority.sessionId
        || authority.taskKey !== input.authority.taskKey) throw new Error("manager-authority-changed-before-dispatch");
      const policy = (await import("../session-execution-policy.ts")).INTEGRATION_MANAGER_SESSION_EXECUTION_POLICY;
      if (!policy || policy.mode !== "plugin-tools-only-v1"
        || JSON.stringify([...policy.toolNames].sort()) !== JSON.stringify(MANAGER_EXECUTION_TOOLS)) {
        throw new Error("manager-restricted-tool-policy-unavailable-or-mismatched");
      }
      const requestId = managerRequestUuidForLedgerKey(request.requestId);
      if (!REQUEST_ID.test(requestId)) throw new Error("manager-core-request-id-invalid");
      const prompt = managerPrompt(request, readiness.plan);
      const result = await platform.agents.sessions.sendMessage(authority.sessionId, input.workspaceId, {
        requestId, prompt, reason: "builder-workstream-verified-integration", executionPolicy: policy,
      });
      if (!result || !REQUEST_ID.test(result.runId)) throw new Error("manager-send-result-missing-run-receipt");
      sendResultRunId = result.runId;
    },
    async readReceipt(ledgerRequestId: string) {
      const requestId = managerRequestUuidForLedgerKey(ledgerRequestId);
      try {
        const receipt = await platform.agents.sessions.getRequest(input.authority.sessionId, input.workspaceId, requestId);
        // A null Host result is not sufficient evidence that an earlier admission never happened.
        if (!exactObject(receipt)) return { status: "uncertain" as const, reason: "manager-request-receipt-unavailable-or-absent" };
        if (receipt.requestId !== requestId || !["pending", "submitted", "uncertain"].includes(String(receipt.state))) {
          return { status: "uncertain" as const, reason: "manager-request-receipt-malformed" };
        }
        if (sendResultRunId !== null && receipt.runId === null) {
          return { status: "uncertain" as const, reason: "manager-send-and-request-receipts-disagree" };
        }
        if ((receipt.state === "pending" || receipt.state === "uncertain") && receipt.runId === null
          && await hasConfirmedNotStartedSessionRequest({ sessions: platform.agents.sessions,
            sessionId: input.authority.sessionId, workspaceId: input.workspaceId, requestId, async assertCurrent() {
              const current = await resolveCurrentIntegrationManagerAuthority(input.workspaceId, platform);
              if (current.agentId !== input.authority.agentId || current.sessionId !== input.authority.sessionId
                || current.taskKey !== input.authority.taskKey) throw new Error("manager-authority-changed-during-request-diagnostic");
            } })) return { status: "uncertain" as const, reason: "manager-request-confirmed-not-started-no-automatic-retry" };
        if (receipt.state === "pending") return receipt.runId === null
          ? { status: "pending" as const, requestId: ledgerRequestId }
          : { status: "uncertain" as const, reason: "manager-pending-receipt-has-run-id" };
        if (receipt.state === "uncertain") return receipt.runId === null
          ? { status: "uncertain" as const, reason: "manager-core-request-state-uncertain" }
          : { status: "uncertain" as const, reason: "manager-uncertain-receipt-has-run-id" };
        if (typeof receipt.runId !== "string" || !REQUEST_ID.test(receipt.runId)
          || sendResultRunId !== null && sendResultRunId !== receipt.runId) {
          return { status: "uncertain" as const, reason: "manager-submitted-run-id-mismatch" };
        }
        const run = await platform.agents.sessions.getRun(input.authority.sessionId, input.workspaceId, receipt.runId);
        if (!safeRunReceipt(run, receipt.runId)) return { status: "uncertain" as const, reason: "manager-run-observation-invalid" };
        return { status: "accepted" as const, requestId: ledgerRequestId, receiptId: requestId, runId: receipt.runId };
      } catch {
        return { status: "uncertain" as const, reason: "manager-request-or-run-read-unavailable" };
      }
    },
  });
}

export function managerRequestUuidForLedgerKey(value: string) {
  const bytes = createHash("sha256").update(MANAGER_REQUEST_NAMESPACE).update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

type ProtectedTerminalPayload = Readonly<{ schemaVersion: 1; kind: "protected-node-test-v1"; companyId: string;
  pluginId: string; pluginKey: string; runId: string; status: "succeeded" | "failed" | "cancelled";
  receiptDigest: string; subjectKeySha256: string; sourceEventId?: string }>;
type ProtectedTerminalFacts = Pick<ProtectedTerminalPayload, "runId" | "status" | "receiptDigest" | "subjectKeySha256">;
function parseProtectedTerminalPayload(value: unknown, recheck: boolean): ProtectedTerminalPayload | null {
  if (!exactObject(value)) return null;
  const expected = ["schemaVersion", "kind", "companyId", "pluginId", "pluginKey", "runId", "status", "receiptDigest", "subjectKeySha256",
    ...(recheck ? ["sourceEventId"] : [])];
  if (Reflect.ownKeys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || value.kind !== "protected-node-test-v1" || value.companyId === undefined
    || typeof value.companyId !== "string" || !UUID.test(value.companyId) || typeof value.pluginId !== "string" || !UUID.test(value.pluginId)
    || value.pluginKey !== BUILDER_PLUGIN_ID || typeof value.runId !== "string" || !UUID.test(value.runId)
    || !["succeeded", "failed", "cancelled"].includes(value.status as string)
    || typeof value.receiptDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.receiptDigest)
    || typeof value.subjectKeySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.subjectKeySha256)
    || recheck && (typeof value.sourceEventId !== "string" || !EVENT_ID.test(value.sourceEventId))) return null;
  return value as unknown as ProtectedTerminalPayload;
}

type ProtectedTerminalCandidate = Readonly<{ scope: { workspaceId: string; projectId: string; workstreamId: string; verifiedEventId: string };
  snapshot: VerifiedWorkstreamSnapshot; taskId: string; phase: "ci" | "e2e" | "regression";
  reference: NonNullable<NonNullable<import("./integration-progress.ts").IntegrationAttempt["validationRuns"]>["ci"]>;
  attempt: import("./integration-progress.ts").IntegrationAttempt; plan: CurrentIntegrationPlan }>;

async function findProtectedTerminalCandidate(workspaceId: string, payload: ProtectedTerminalFacts, platform: Host) {
  const board = await readWorkstreams(workspaceId, workspaceId, platform);
  if (!board || board.revision.workstreams.length > MAX_WORKSTREAMS) return { status: "unknown" as const, reason: "protected-terminal-workstream-board-unavailable-or-over-bound" };
  const publication = createWorkstreamVerificationPublication(revisionState(platform));
  const progress = await import("./integration-progress.ts");
  const candidates: ProtectedTerminalCandidate[] = [];
  let attemptLookups = 0;
  for (const workstream of board.revision.workstreams) {
    const latest = await publication.readLatestCurrent({ workspaceId, projectId: workspaceId, workstreamId: workstream.spec.id });
    if (latest.status === "unknown" && latest.reason !== "verified-head-unavailable") return { status: "unknown" as const,
      reason: "protected-terminal-current-verification-read-unavailable" };
    if (latest.status !== "current") continue;
    const taskPins = latest.snapshot.sourcePins.filter(pin => pin.sourceId.startsWith("builder-v1:task-packet:"));
    for (const pin of taskPins) {
      if (++attemptLookups > MAX_TERMINAL_ATTEMPT_LOOKUPS) return { status: "unknown" as const,
        reason: "protected-terminal-attempt-scan-over-bound" };
      const taskId = pin.sourceId.slice("builder-v1:task-packet:".length);
      const attempt = await progress.createIntegrationAttemptStore({ workspaceId, workstreamId: workstream.spec.id,
        eventId: latest.snapshot.eventId, taskId }, platform.state as typeof platform.state & RevisionState).current();
      if (!attempt || attempt.revision.stage !== "git-observed" || attempt.revision.planRevisionId === "") continue;
      for (const phase of ["ci", "e2e", "regression"] as const) {
        const reference = attempt.revision.validationRuns?.[phase];
        if (!reference || reference.runId !== payload.runId || reference.subjectKeySha256 !== payload.subjectKeySha256) continue;
        candidates.push({ scope: { workspaceId, projectId: workspaceId, workstreamId: workstream.spec.id,
          verifiedEventId: latest.snapshot.eventId }, snapshot: latest.snapshot, taskId, phase, reference,
          attempt: attempt.revision, plan: null as never });
      }
    }
  }
  if (candidates.length !== 1) return { status: candidates.length ? "conflict" as const : "stale" as const,
    reason: candidates.length ? "protected-terminal-run-matches-multiple-current-workstream-references"
      : "protected-terminal-run-is-not-referenced-by-current-verified-workstream" };
  let candidate = candidates[0]!;
  const readiness = await readIntegrationReadiness(workspaceId, candidate.scope.workstreamId, platform);
  if (readiness.status !== "ready") return { status: readiness.status === "waiting-dependencies" ? "waiting-dependencies" as const : "unknown" as const,
    reason: readiness.reason };
  const selected = readiness.plan.revision.validationPlans?.[candidate.phase];
  const git = candidate.attempt.git;
  const observedCommit = git?.status === "unchanged" ? git.headSha
    : git?.status === "integrated" || git?.status === "replayed" ? git.commitSha : null;
  const observedTree = git?.status === "integrated" || git?.status === "replayed" ? git.treeSha : candidate.reference.treeSha;
  if (!selected || candidate.attempt.planRevisionId !== readiness.plan.revision.revisionId
    || candidate.attempt.effect.sourceId !== readiness.plan.revision.sourceId
    || candidate.attempt.effect.folderKey !== readiness.plan.revision.folderKey
    || candidate.attempt.effect.branch !== readiness.plan.revision.candidateBranch
    || candidate.reference.approvalTemplateId !== selected.approvalTemplateId
    || candidate.reference.planSha256 !== selected.planSha256
    || candidate.reference.commitSha !== observedCommit || candidate.reference.treeSha !== observedTree) {
    return { status: "stale" as const, reason: "protected-terminal-plan-or-candidate-pins-changed" };
  }
  candidate = { ...candidate, plan: readiness.plan };
  return { status: "current" as const, candidate };
}

async function validateProtectedTerminalReceipt(candidate: ProtectedTerminalCandidate, payload: ProtectedTerminalFacts, platform: Host) {
  const api = platform.protectedTests;
  if (typeof api?.getRunV1 !== "function") return { status: "unsupported" as const, reason: "protected-run-reader-unavailable" };
  const folders = platform.localFolders;
  if (typeof folders?.matchWorkspaceSourceV1 !== "function" || typeof folders.readWorkspaceSourceGitTipV1 !== "function") {
    return { status: "unsupported" as const, reason: "current-source-root-or-tip-reader-unavailable" };
  }
  const source = candidate.attempt.effect.sourceId, folder = candidate.attempt.effect.folderKey, branch = candidate.attempt.effect.branch;
  const checkSource = async () => {
    const root = await folders.matchWorkspaceSourceV1!(folder, source);
    const tip = await folders.readWorkspaceSourceGitTipV1!(source, folder, branch);
    return exactObject(root) && Reflect.ownKeys(root).length === 3 && root.folderKey === folder && root.workspaceSourceId === source && root.match === "same_root"
      && exactObject(tip) && tip.status === "current" && tip.sourceId === source && tip.folderKey === folder && tip.branch === branch
      && tip.commitSha === candidate.reference.commitSha && tip.treeSha === candidate.reference.treeSha;
  };
  try {
    if (!await checkSource()) return { status: "stale" as const, reason: "protected-terminal-source-root-or-branch-tip-changed" };
    const { parseProtectedRun } = await import("../task-protected-qa.ts");
    const { assertProtectedOutputMetadata, PROTECTED_OUTPUT_RECEIPT_FIELDS } = await import("../protected-test-output-metadata.ts");
    const run = parseProtectedRun(await api.getRunV1(candidate.scope.workspaceId, payload.runId, payload.subjectKeySha256));
    if (run.id !== candidate.reference.runId || run.pins.subjectKeySha256 !== payload.subjectKeySha256
      || run.pins.approvalId !== candidate.reference.approvalId || run.pins.sourceId !== candidate.attempt.effect.sourceId
      || run.pins.planSha256 !== candidate.reference.planSha256 || run.pins.commitSha !== candidate.reference.commitSha
      || run.pins.treeSha !== candidate.reference.treeSha || run.status !== payload.status || run.termination !== "confirmed"
      || !exactObject(run.receipt)) return { status: "unknown" as const, reason: "protected-terminal-core-run-pins-or-termination-invalid" };
    const required = ["digest", "status", "stdoutSha256", "stderrSha256", "stdoutBytes", "stderrBytes", "processExitCode", "timedOut",
      "cancelled", "outputLimit", "appContainerVerified", "capabilitiesCount", "childTerminationConfirmed", "jobEmpty",
      "profileCleanupSucceeded", "sandboxCleanupSucceeded", "fixtureMustBeRetained"];
    const receiptKeys = Reflect.ownKeys(run.receipt);
    if (required.some(key => !Object.hasOwn(run.receipt!, key))
      || receiptKeys.some(key => typeof key !== "string" || !required.includes(key) && !(PROTECTED_OUTPUT_RECEIPT_FIELDS as readonly string[]).includes(key))) {
      return { status: "unknown" as const, reason: "protected-terminal-core-receipt-malformed" };
    }
    assertProtectedOutputMetadata(run.receipt);
    if (run.receipt.digest !== payload.receiptDigest || typeof run.receipt.digest !== "string"
      || !/^[a-f0-9]{64}$/u.test(run.receipt.digest) || run.receipt.appContainerVerified !== true
      || run.receipt.capabilitiesCount !== 0 || run.receipt.childTerminationConfirmed !== true || run.receipt.jobEmpty !== true
      || run.receipt.profileCleanupSucceeded !== true || run.receipt.sandboxCleanupSucceeded !== true
      || run.receipt.fixtureMustBeRetained !== false
      || run.status === "succeeded" && (run.receipt.status !== "completed" || run.receipt.processExitCode !== 0
        || run.receipt.timedOut !== false || run.receipt.cancelled !== false || run.receipt.outputLimit !== false)) {
      return { status: "unknown" as const, reason: "protected-terminal-core-receipt-invariants-invalid" };
    }
    const latestEvent = await createWorkstreamVerificationPublication(revisionState(platform)).readCurrent({
      workspaceId: candidate.scope.workspaceId, projectId: candidate.scope.projectId,
      workstreamId: candidate.scope.workstreamId, eventId: candidate.scope.verifiedEventId });
    const latestPlan = await readIntegrationReadiness(candidate.scope.workspaceId, candidate.scope.workstreamId, platform);
    if (latestEvent.status !== "current" || sha256Json(latestEvent.snapshot) !== sha256Json(candidate.snapshot)
      || latestPlan.status !== "ready" || sha256Json(latestPlan.plan) !== sha256Json(candidate.plan)
      || !await checkSource()) return { status: "stale" as const, reason: "protected-terminal-evidence-changed-during-receipt-read" };
  return { status: "current" as const, run: { id: run.id, status: run.status, termination: run.termination,
      pins: run.pins, receipt: { digest: run.receipt.digest, status: run.receipt.status,
        processExitCode: run.receipt.processExitCode, timedOut: run.receipt.timedOut, cancelled: run.receipt.cancelled,
        outputLimit: run.receipt.outputLimit } } };
  } catch { return { status: "unknown" as const, reason: "protected-terminal-core-receipt-read-failed" };
  }
}

async function managerRequestRun(workspaceId: string, authority: ManagerAuthority, ledgerRequestId: string,
  expectedRunId: string | undefined, platform: Host) {
  return managerRequestRunByUuid(workspaceId, authority, managerRequestUuidForLedgerKey(ledgerRequestId), expectedRunId, platform);
}

async function managerRequestRunByUuid(workspaceId: string, authority: ManagerAuthority, requestUuid: string,
  expectedRunId: string | undefined, platform: Host) {
  if (!REQUEST_ID.test(requestUuid)) return { status: "unknown" as const, reason: "manager-core-request-id-invalid" };
  try {
    const request = await platform.agents.sessions.getRequest(authority.sessionId, workspaceId, requestUuid);
    if (!exactObject(request) || request.requestId !== requestUuid || request.state !== "submitted"
      || typeof request.runId !== "string" || !REQUEST_ID.test(request.runId)
      || expectedRunId !== undefined && request.runId !== expectedRunId) return { status: "unknown" as const,
      reason: "manager-core-request-receipt-unavailable-or-mismatched" };
    const run = await platform.agents.sessions.getRun(authority.sessionId, workspaceId, request.runId);
    if (!safeRunReceipt(run, request.runId)) return { status: "unknown" as const, reason: "manager-core-run-receipt-invalid" };
    return { status: "current" as const, requestUuid, runId: request.runId,
      active: ["queued", "running", "cancelling"].includes(String(run.status)) || run.cancellationRequested !== false || run.termination === "pending" };
  } catch { return { status: "unknown" as const, reason: "manager-core-request-or-run-read-failed" };
  }
}

function trackContinuationState(workspaceId: string, platform: Host) {
  const captured = new Map<string, RevisionPublicationGuard>();
  const guardId = (key: SpsStateKey) => JSON.stringify([key.namespace ?? "default", key.stateKey]);
  const state = { ...platform.state, async get(key: SpsStateKey) {
    if (key.scopeKind !== "company" || key.scopeId !== workspaceId) throw new Error("Manager continuation read escaped its Workspace.");
    const value = await platform.state.get(key);
    const identity = guardId(key);
    const previous = captured.get(identity);
    if (previous && JSON.stringify(previous.expectedValue) !== JSON.stringify(value)) {
      throw new Error("Manager continuation inputs changed during observation.");
    }
    if (value !== null) captured.set(identity, { stateKey: key.stateKey,
      ...(key.namespace === undefined ? {} : { namespace: key.namespace }), expectedValue: value });
    return value;
  } };
  return { platform: { ...platform, state } as Host, async refresh(key: SpsStateKey) {
    if (key.scopeKind !== "company" || key.scopeId !== workspaceId) throw new Error("Manager continuation guard escaped its Workspace.");
    const value = await platform.state.get(key);
    const identity = guardId(key);
    if (value === null) captured.delete(identity);
    else captured.set(identity, { stateKey: key.stateKey,
      ...(key.namespace === undefined ? {} : { namespace: key.namespace }), expectedValue: value });
  }, guards() {
    const guards = [...captured.values()].filter(item => !item.stateKey.includes("-revision.v1."));
    if (!guards.length || guards.length > 64 || Buffer.byteLength(JSON.stringify(guards), "utf8") > 200_000) {
      throw new Error("Manager continuation state guards unavailable or over bound.");
    }
    return guards;
  } };
}

async function readManagerLastRunId(workspaceId: string, authority: ManagerAuthority, platform: Host) {
  const observations = await platform.agents.sessions.list(authority.agentId, workspaceId);
  if (!Array.isArray(observations) || observations.length > 100) throw new Error("manager-session-observation-unavailable");
  const rows = observations.filter(item => exactObject(item) && item.sessionId === authority.sessionId);
  if (rows.length !== 1 || rows[0]!.agentId !== authority.agentId || rows[0]!.companyId !== workspaceId
    || rows[0]!.taskKey !== authority.taskKey || rows[0]!.status !== "active" || rows[0]!.closedAt !== null
    || rows[0]!.lastRunId !== null && (typeof rows[0]!.lastRunId !== "string" || !REQUEST_ID.test(rows[0]!.lastRunId))) {
    throw new Error("manager-current-last-run-unavailable-or-mismatched");
  }
  return rows[0]!.lastRunId as string | null;
}

async function currentManagerLastRunId(workspaceId: string, authority: ManagerAuthority, platform: Host) {
  const lastRunId = await readManagerLastRunId(workspaceId, authority, platform);
  if (lastRunId === null) throw new Error("manager-current-last-run-unavailable-or-mismatched");
  return lastRunId;
}

async function observeManagerSlot(workspaceId: string, authority: ManagerAuthority, platform: Host) {
  const lastRunId = await readManagerLastRunId(workspaceId, authority, platform);
  if (lastRunId === null) return { status: "available" as const, lastRunId };
  const run = await platform.agents.sessions.getRun(authority.sessionId, workspaceId, lastRunId);
  if (!safeRunReceipt(run, lastRunId) || await readManagerLastRunId(workspaceId, authority, platform) !== lastRunId) return { status: "unknown" as const };
  if (["queued", "running", "cancelling"].includes(String(run.status))) return { status: "busy" as const };
  if (run.status === "cancelled" && run.cancellationRequested === true && run.termination === "confirmed") return { status: "cancelled" as const };
  return run.cancellationRequested === false && run.termination === "not_applicable"
    ? { status: "available" as const, lastRunId } : { status: "unknown" as const };
}

function continuationScope(candidate: ProtectedTerminalCandidate) {
  return { workspaceId: candidate.scope.workspaceId, projectId: candidate.scope.projectId,
    workstreamId: candidate.scope.workstreamId, verifiedEventId: candidate.scope.verifiedEventId };
}

async function reconcileContinuation(scope: ReturnType<typeof continuationScope>, continuation: ProtectedContinuation,
  authority: ManagerAuthority, platform: Host) {
  if (!continuation.receipt) return { status: "uncertain" as const, reason: "manager-continuation-core-request-receipt-unavailable" };
  const observed = await managerRequestRunByUuid(scope.workspaceId, authority, continuation.receipt.receiptId,
    continuation.receipt?.runId, platform);
  if (observed.status !== "current") {
    if (continuation.status === "pending") await finishProtectedContinuation(scope, continuation, { status: "uncertain" }, platform.state);
    return { status: "uncertain" as const, reason: observed.reason };
  }
  if (continuation.status !== "accepted") {
    const saved = await finishProtectedContinuation(scope, continuation, { status: "accepted", receiptId: observed.requestUuid,
      runId: observed.runId }, platform.state);
    if (saved.status === "conflict" || saved.status === "unknown") return { status: "uncertain" as const, reason: saved.reason };
  }
  return { status: "accepted" as const, runId: observed.runId, active: observed.active };
}

async function consumeProtectedTerminalJob(job: Job, platform: Host, payload: ProtectedTerminalFacts, terminalEventId: string) {
  const tracked = trackContinuationState(job.companyId!, platform);
  platform = tracked.platform;
  const located = await findProtectedTerminalCandidate(job.companyId!, payload, platform);
  if (located.status !== "current") return { status: located.status, eventId: terminalEventId, reason: located.reason };
  const candidate = located.candidate;
  const validated = await validateProtectedTerminalReceipt(candidate, payload, platform);
  if (validated.status !== "current") return { status: validated.status, eventId: terminalEventId, reason: validated.reason };
  const scope = continuationScope(candidate);
  const identity = { terminalEventId, protectedRunId: payload.runId, receiptDigest: payload.receiptDigest,
    subjectKeySha256: payload.subjectKeySha256, phase: candidate.phase } as const;
  const reservation = await reserveProtectedContinuation(scope, identity, platform.state);
  if (reservation.status === "unknown" || reservation.status === "conflict") return { status: reservation.status, eventId: terminalEventId, reason: reservation.reason };
  const continuationKey = { scopeKind: "company" as const, scopeId: scope.workspaceId, namespace: "sonpark.my-builder",
    stateKey: `verified-consumption.v1.${createHash("sha256").update(`${scope.projectId}\0${scope.workstreamId}`, "utf8").digest("hex")}` };
  try { await tracked.refresh(continuationKey); }
  catch { return { status: "unknown" as const, eventId: terminalEventId, reason: "manager-continuation-reservation-readback-failed" }; }
  let continuation = reservation.continuation;
  const authority = await resolveCurrentIntegrationManagerAuthority(job.companyId!, platform);
  const original = await readVerifiedWorkstreamReservation(scope, platform.state);
  if (!original || original.status !== "accepted" || !original.receipt || !original.requestId) {
    return { status: "unknown" as const, eventId: terminalEventId, reason: "original-manager-request-receipt-unavailable" };
  }
  if (continuation.status === "accepted") {
    const reconciled = await reconcileContinuation(scope, continuation, authority, platform);
    if (reconciled.status !== "accepted") return { status: "unknown" as const, eventId: terminalEventId, reason: reconciled.reason };
    return { status: "accepted" as const, eventId: terminalEventId, requestId: continuation.requestId,
      receipt: { receiptId: continuation.receipt!.receiptId, runId: reconciled.runId },
      reason: "continuation-core-request-receipt-confirmed-not-completion" };
  }
  if (continuation.status === "uncertain" || continuation.status === "manager-failed") return { status: "unknown" as const,
    eventId: terminalEventId, reason: "manager-continuation-outcome-uncertain-or-terminal-no-replacement" };
  const originalRun = await managerRequestRun(job.companyId!, authority, original.requestId, original.receipt.runId, platform);
  if (originalRun.status !== "current") return { status: "unknown" as const, eventId: terminalEventId, reason: originalRun.reason };
  let activeManagerRun = originalRun.active;
  for (const prior of original.continuations ?? []) {
    if (prior.terminalEventId === identity.terminalEventId && prior.protectedRunId === identity.protectedRunId
      && prior.receiptDigest === identity.receiptDigest) continue;
    if (prior.status === "waiting") continue;
    const observed = await reconcileContinuation(scope, prior, authority, platform);
    if (observed.status !== "accepted") return { status: "unknown" as const, eventId: terminalEventId, reason: observed.reason };
    if (observed.active) activeManagerRun = true;
  }
  let currentLastRunId: string;
  try { currentLastRunId = await currentManagerLastRunId(job.companyId!, authority, platform); }
  catch { return { status: "unknown" as const, eventId: terminalEventId, reason: "manager-current-last-run-unavailable-or-mismatched" }; }
  let currentRun: unknown;
  try { currentRun = await platform.agents.sessions.getRun(authority.sessionId, job.companyId!, currentLastRunId); }
  catch { return { status: "unknown" as const, eventId: terminalEventId, reason: "manager-current-last-run-read-failed" }; }
  if (!safeRunReceipt(currentRun, currentLastRunId)) return { status: "unknown" as const, eventId: terminalEventId,
    reason: "manager-current-last-run-receipt-invalid" };
  const currentRunActive = ["queued", "running", "cancelling"].includes(String((currentRun as Record<string, unknown>).status))
    || (currentRun as Record<string, unknown>).cancellationRequested !== false
    || (currentRun as Record<string, unknown>).termination === "pending";
  activeManagerRun ||= currentRunActive;
  if (activeManagerRun) {
    if (continuation.recoveryWakeCount === 0) {
      const managerBinding = await platform.state.get(integrationManagerStateKey(job.companyId!));
      if (managerBinding === null) return { status: "unknown" as const, eventId: terminalEventId,
        reason: "manager-selection-binding-unavailable-for-recheck" };
      const wakeId = `builder-protected-recheck-v1:${sha256Json([terminalEventId, payload.runId, payload.receiptDigest])}`;
      const wake = { name: PROTECTED_RECHECK_EVENT, eventId: wakeId, jobKey: WORKSTREAM_VERIFIED_JOB,
        payload: { ...payload, sourceEventId: terminalEventId } as unknown as JsonValue };
      const queued = await queueProtectedContinuationRecheck(scope, identity, integrationManagerStateKey(job.companyId!),
        managerBinding, wake, platform.state as typeof platform.state & RevisionState);
      if (queued.status === "queued") continuation = queued.continuation;
      else if (queued.status === "conflict" || queued.status === "unknown") return { status: queued.status, eventId: terminalEventId, reason: queued.reason };
    }
    return { status: "waiting" as const, eventId: terminalEventId,
      reason: continuation.recoveryWakeCount === 1 ? "manager-active-bounded-recheck-queued-or-exhausted"
        : "manager-active-no-bounded-recheck-support", recoveryWakeCount: continuation.recoveryWakeCount };
  }

  const freshCandidate = await findProtectedTerminalCandidate(job.companyId!, payload, platform);
  if (freshCandidate.status !== "current" || freshCandidate.candidate.scope.verifiedEventId !== candidate.scope.verifiedEventId
    || freshCandidate.candidate.plan.revision.revisionId !== candidate.plan.revision.revisionId) {
    return { status: "stale" as const, eventId: terminalEventId, reason: "protected-terminal-target-changed-before-manager-continuation" };
  }
  const freshRun = await validateProtectedTerminalReceipt(freshCandidate.candidate, payload, platform);
  if (freshRun.status !== "current" || sha256Json(freshRun.run) !== sha256Json(validated.run)) {
    return { status: "stale" as const, eventId: terminalEventId, reason: "protected-terminal-receipt-changed-before-manager-continuation" };
  }
  const currentAuthority = await resolveCurrentIntegrationManagerAuthority(job.companyId!, platform);
  if (currentAuthority.agentId !== authority.agentId || currentAuthority.sessionId !== authority.sessionId
    || currentAuthority.taskKey !== authority.taskKey) return { status: "stale" as const, eventId: terminalEventId,
      reason: "manager-authority-changed-before-continuation" };
  const dispatchProtectedEvent = platform.agents.sessions.dispatchProtectedEventV1;
  if (typeof dispatchProtectedEvent !== "function") return { status: "unsupported" as const, eventId: terminalEventId,
    reason: "core-protected-event-dispatch-unavailable" };
  if (continuation.status === "pending" && !continuation.previousRunId) return { status: "unknown" as const,
    eventId: terminalEventId, reason: "manager-continuation-previous-run-pin-missing" };
  const pinnedPreviousRunId = continuation.status === "pending" ? continuation.previousRunId! : currentLastRunId;
  let dispatching = continuation;
  if (continuation.status === "waiting") {
    const started = await startProtectedContinuation(scope, identity, pinnedPreviousRunId, platform.state);
    if (started.status !== "updated") return { status: started.status, eventId: terminalEventId,
      reason: started.reason ?? "continuation-reservation-not-startable" };
    dispatching = started.continuation;
    try { await tracked.refresh(continuationKey); }
    catch { return { status: "unknown" as const, eventId: terminalEventId, reason: "manager-continuation-pin-readback-failed" }; }
  }
  let sent: { requestId: string; runId: string; replayed: boolean };
  const dispatchInput = { previousRunId: pinnedPreviousRunId, eventId: terminalEventId,
    protectedRunId: payload.runId, guards: tracked.guards() };
  try {
    sent = await dispatchProtectedEvent(authority.sessionId, job.companyId!, dispatchInput);
  } catch {
    try { sent = await dispatchProtectedEvent(authority.sessionId, job.companyId!, dispatchInput); }
    catch {
      await finishProtectedContinuation(scope, identity, { status: "uncertain" }, platform.state);
      return { status: "unknown" as const, eventId: terminalEventId, requestId: dispatching.requestId,
        reason: "manager-protected-event-dispatch-outcome-uncertain-no-fallback" };
    }
  }
  if (!sent || !REQUEST_ID.test(sent.requestId) || !REQUEST_ID.test(sent.runId) || typeof sent.replayed !== "boolean") {
    await finishProtectedContinuation(scope, identity, { status: "uncertain" }, platform.state);
    return { status: "unknown" as const, eventId: terminalEventId, requestId: dispatching.requestId,
      reason: "manager-protected-event-dispatch-receipt-invalid" };
  }
  if (continuation.status === "pending" && currentLastRunId !== pinnedPreviousRunId && sent.replayed !== true) {
    await finishProtectedContinuation(scope, identity, { status: "uncertain" }, platform.state);
    return { status: "unknown" as const, eventId: terminalEventId, requestId: dispatching.requestId,
      reason: "manager-pending-retry-not-confirmed-as-core-replay" };
  }
  const saved = await finishProtectedContinuation(scope, identity, { status: "accepted", receiptId: sent.requestId, runId: sent.runId }, platform.state);
  if ((saved.status !== "updated" && saved.status !== "existing") || saved.continuation.receipt?.receiptId !== sent.requestId
    || saved.continuation.receipt?.runId !== sent.runId) return { status: "unknown" as const, eventId: terminalEventId,
      requestId: dispatching.requestId, reason: saved.reason ?? "manager-continuation-receipt-persistence-mismatch" };
  return { status: "accepted" as const, eventId: terminalEventId, requestId: dispatching.requestId,
    receipt: { receiptId: sent.requestId, runId: sent.runId },
    reason: "continuation-core-request-receipt-confirmed-not-completion" };
}

/** Consumer for Core's durable Manager-session terminal notification. */
export async function consumeManagerSessionTerminalJob(job: Job, platformInput: SpsPlatformInvocationContext) {
  const platform = platformInput as Host;
  if (job.jobKey !== MANAGER_SESSION_TERMINAL_JOB || job.trigger !== "event" || !job.eventId || !EVENT_ID.test(job.eventId)
    || !job.companyId || !UUID.test(job.companyId) || !job.runId || !UUID.test(job.runId)) {
    return { status: "unsupported" as const, reason: "manager-terminal-event-context-incomplete-or-unsupported" };
  }
  if (!exactObject(job.event) || Reflect.ownKeys(job.event).length !== 2 || typeof job.event.eventType !== "string") {
    return { status: "unknown" as const, eventId: job.eventId, reason: "sanitized-job-event-context-malformed" };
  }
  if (job.event.eventType !== MANAGER_TERMINAL_EVENT) return { status: "ignored" as const, eventId: job.eventId,
    reason: "unrelated-workspace-event" };
  let payload: Record<string, unknown>;
  try { payload = exactToolRecord(job.event.payload, ["schemaVersion", "runId", "sessionId", "requestId", "status", "resultSha256", "finishedAt"]); }
  catch { return { status: "unknown" as const, eventId: job.eventId, reason: "manager-terminal-event-payload-invalid" };
  }
  if (payload.schemaVersion !== 1 || typeof payload.runId !== "string" || !UUID.test(payload.runId)
    || typeof payload.sessionId !== "string" || !UUID.test(payload.sessionId)
    || typeof payload.requestId !== "string" || !REQUEST_ID.test(payload.requestId)
    || !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(payload.status as string)
    || typeof payload.resultSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(payload.resultSha256)
    || typeof payload.finishedAt !== "string" || !Number.isFinite(Date.parse(payload.finishedAt))) {
    return { status: "unknown" as const, eventId: job.eventId, reason: "manager-terminal-event-payload-invalid" };
  }
  let authority: ManagerAuthority;
  try { authority = await resolveCurrentIntegrationManagerAuthority(job.companyId, platform); }
  catch { return { status: "unknown" as const, eventId: job.eventId, reason: "current-manager-authority-unavailable" };
  }
  if (authority.sessionId !== payload.sessionId) return { status: "ignored" as const, eventId: job.eventId,
    reason: "terminal-event-is-not-from-current-manager-session" };
  const sessionRequest = await platform.agents.sessions.getRequest(authority.sessionId, job.companyId, payload.requestId);
  if (!exactObject(sessionRequest) || sessionRequest.requestId !== payload.requestId || sessionRequest.state !== "submitted"
    || sessionRequest.runId !== payload.runId) return { status: "ignored" as const, eventId: job.eventId,
    reason: "terminal-event-does-not-match-current-manager-request-receipt" };
  const sessionRun = await platform.agents.sessions.getRun(authority.sessionId, job.companyId, payload.runId);
  if (!safeRunReceipt(sessionRun, payload.runId) || sessionRun.status !== payload.status
    || !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(sessionRun.status))) {
    return { status: "unknown" as const, eventId: job.eventId, reason: "manager-terminal-core-run-does-not-match-terminal-event" };
  }
  if (["failed", "cancelled", "timed_out", "interrupted"].includes(payload.status as string)) {
    const closed = await closeFailedManagerContinuations(job.companyId, payload.requestId, payload.runId,
      payload.status === "cancelled" ? "cancelled" : "failed", job.eventId, platform);
    if (closed.status === "unknown" || payload.status === "cancelled" || sessionRun.cancellationRequested !== false
      || sessionRun.termination !== "not_applicable") return closed;
    const drained = await drainUnattemptedManagerWork(job.companyId, payload.runId, authority, platform);
    return drained ? { ...drained, priorTerminalStatus: payload.status } : closed;
  }
  if (sessionRun.cancellationRequested !== false || sessionRun.termination !== "not_applicable") return { status: "unknown" as const, eventId: job.eventId,
    reason: "manager-terminal-success-is-cancellation-marked" };
  const board = await readWorkstreams(job.companyId, job.companyId, platform);
  if (!board || board.revision.workstreams.length > MAX_WORKSTREAMS) return { status: "unknown" as const,
    eventId: job.eventId, reason: "manager-terminal-workstream-board-unavailable-or-over-bound" };
  const outcomes: Array<Readonly<{ eventId: string; status: string; reason: string }>> = [];
  let continuationScans = 0;
  for (const workstream of board.revision.workstreams) {
    const latest = await createWorkstreamVerificationPublication(revisionState(platform)).readLatestCurrent({
      workspaceId: job.companyId, projectId: job.companyId, workstreamId: workstream.spec.id });
    if (latest.status === "unknown" && latest.reason !== "verified-head-unavailable") return { status: "unknown" as const,
      eventId: job.eventId, reason: "manager-terminal-current-workstream-read-unavailable" };
    if (latest.status !== "current") continue;
    const reservation = await readVerifiedWorkstreamReservation({ workspaceId: job.companyId, projectId: job.companyId,
      workstreamId: workstream.spec.id, verifiedEventId: latest.snapshot.eventId }, platform.state);
    if (!reservation || reservation.status !== "accepted" || !reservation.requestId || !reservation.receipt) continue;
    for (const continuation of reservation.continuations ?? []) {
      if (++continuationScans > MAX_TERMINAL_ATTEMPT_LOOKUPS) return { status: "unknown" as const,
        eventId: job.eventId, reason: "manager-terminal-continuation-scan-over-bound" };
      const continuationMatches = continuation.receipt?.receiptId === payload.requestId
        && continuation.receipt.runId === payload.runId;
      const pendingReplay = continuation.status === "pending" && typeof continuation.previousRunId === "string";
      if (!continuationMatches && continuation.status !== "waiting" && !pendingReplay) continue;
      const protectedApi = platform.protectedTests;
      if (typeof protectedApi?.getRunV1 !== "function") return { status: "unsupported" as const, eventId: job.eventId,
        reason: "protected-run-reader-unavailable" };
      const runValue = await protectedApi.getRunV1(job.companyId, continuation.protectedRunId, continuation.subjectKeySha256);
      const { parseProtectedRun } = await import("../task-protected-qa.ts");
      let protectedRun: ReturnType<typeof parseProtectedRun>;
      try { protectedRun = parseProtectedRun(runValue); }
      catch { return { status: "unknown" as const, eventId: job.eventId, reason: "referenced-protected-run-receipt-invalid" };
      }
      if (protectedRun.status !== "succeeded" && protectedRun.status !== "failed" && protectedRun.status !== "cancelled"
        || protectedRun.termination !== "confirmed"
        || !exactObject(protectedRun.receipt) || typeof protectedRun.receipt.digest !== "string"
        || protectedRun.receipt.digest !== continuation.receiptDigest) continue;
      const protectedStatus = protectedRun.status as ProtectedTerminalPayload["status"];
      const terminalPayload: ProtectedTerminalFacts = { runId: continuation.protectedRunId, status: protectedStatus,
        receiptDigest: continuation.receiptDigest, subjectKeySha256: continuation.subjectKeySha256 };
      const result = await consumeProtectedTerminalJob({ ...job, jobKey: WORKSTREAM_VERIFIED_JOB,
        eventId: continuation.terminalEventId, event: { eventType: PROTECTED_TERMINAL_EVENT, payload: terminalPayload } },
      platform, terminalPayload, continuation.terminalEventId);
      outcomes.push({ eventId: continuation.terminalEventId, status: result.status, reason: result.reason });
    }
  }
  if (!outcomes.length) {
    const drained = await drainUnattemptedManagerWork(job.companyId, payload.runId, authority, platform);
    return drained ?? { status: "ignored" as const, eventId: job.eventId,
      reason: "manager-terminal-run-has-no-current-protected-continuation-or-queued-work" };
  }
  const unresolved = outcomes.find(item => !["accepted", "stale", "waiting"].includes(item.status));
  if (unresolved) return { status: "unknown" as const, eventId: job.eventId,
    reason: "manager-terminal-continuation-not-confirmed", continuations: outcomes };
  if (outcomes.some(item => item.status === "waiting")) return { status: "waiting" as const, eventId: job.eventId,
    reason: "manager-terminal-continuation-still-waiting", continuations: outcomes };
  const drained = await drainUnattemptedManagerWork(job.companyId, payload.runId, authority, platform);
  if (drained) return { ...drained, continuations: outcomes };
  if (outcomes.every(item => item.status === "stale")) return { status: "stale" as const, eventId: job.eventId,
    reason: "manager-terminal-target-no-longer-current", continuations: outcomes };
  return { status: "accepted" as const, eventId: job.eventId, reason: "manager-terminal-notification-consumed",
    continuations: outcomes };
}

async function closeFailedManagerContinuations(workspaceId: string, requestId: string, runId: string,
  terminalStatus: "failed" | "cancelled", eventId: string, platform: Host) {
  const board = await readWorkstreams(workspaceId, workspaceId, platform);
  if (!board || board.revision.workstreams.length > MAX_WORKSTREAMS) return { status: "unknown" as const,
    eventId, reason: "failed-manager-terminal-workstream-board-unavailable-or-over-bound" };
  let scans = 0;
  const closed: Array<{ workstreamId: string; requestId: string }> = [];
  for (const workstream of board.revision.workstreams) {
    const latest = await createWorkstreamVerificationPublication(revisionState(platform)).readLatestCurrent({
      workspaceId, projectId: workspaceId, workstreamId: workstream.spec.id });
    if (latest.status === "unknown" && latest.reason !== "verified-head-unavailable") return { status: "unknown" as const,
      eventId, reason: "failed-manager-terminal-current-workstream-read-unavailable" };
    if (latest.status !== "current") continue;
    const scope = { workspaceId, projectId: workspaceId, workstreamId: workstream.spec.id,
      verifiedEventId: latest.snapshot.eventId };
    const reservation = await readVerifiedWorkstreamReservation(scope, platform.state);
    if (!reservation || reservation.status !== "accepted" || !reservation.receipt || !reservation.requestId) continue;
    const originalMatches = managerRequestUuidForLedgerKey(reservation.requestId) === requestId
      && reservation.receipt.runId === runId;
    for (const continuation of reservation.continuations ?? []) {
      if (++scans > MAX_TERMINAL_ATTEMPT_LOOKUPS) return { status: "unknown" as const, eventId,
        reason: "failed-manager-terminal-continuation-scan-over-bound" };
      const continuationMatches = continuation.receipt?.receiptId === requestId && continuation.receipt.runId === runId;
      if (!continuationMatches && !(originalMatches && continuation.status === "waiting")) continue;
      if (["accepted", "waiting", "pending", "uncertain"].includes(continuation.status)) {
        const result = await failProtectedContinuation(scope, continuation, terminalStatus, platform.state);
        if (result.status === "unknown" || result.status === "conflict") return { status: "unknown" as const,
          eventId, reason: result.reason ?? "failed-manager-continuation-close-unconfirmed" };
        closed.push({ workstreamId: workstream.spec.id, requestId: continuation.requestId });
      }
    }
  }
  return closed.length ? { status: "failed" as const, eventId, terminalStatus,
    continuations: closed, reason: "manager-terminal-failure-recorded-no-replacement-session" }
    : { status: "ignored" as const, eventId, reason: "failed-manager-terminal-has-no-current-continuation" };
}

export async function resolveCurrentIntegrationManagerAuthority(workspaceId: string,
  platformInput: SpsPlatformInvocationContext): Promise<ManagerAuthority> {
  const platform = platformInput as Host;
  const binding = parseIntegrationManagerBinding(await platform.state.get(integrationManagerStateKey(workspaceId)), workspaceId);
  if (!binding.selectedAgentId) throw new Error("manager-selection-unavailable");
  const owned = platform.agents.owned;
  if (!owned || typeof owned.get !== "function") throw new Error("manager-owned-profile-api-unavailable");
  const receipt = await owned.get({ companyId: workspaceId, pluginAgentKey: "integration-manager" });
  if (!exactObject(receipt) || receipt.status !== "created" && receipt.status !== "resolved"
    || !Number.isSafeInteger(receipt.revision) || (receipt.revision as number) < 1 || !exactObject(receipt.agent)) {
    throw new Error("manager-owned-profile-unavailable");
  }
  const profile = receipt.agent;
  if (profile.agentId !== binding.selectedAgentId) throw new Error("manager-selected-agent-does-not-match-owned-role-profile");
  if (profile.role !== "integration-manager" || !["idle", "running", "paused"].includes(String(profile.status))) {
    throw new Error("manager-profile-not-current-and-active");
  }
  const agents = await platform.agents.list({ companyId: workspaceId, limit: 100 });
  const memberMatches = Array.isArray(agents) && agents.length <= 100 && !agents.some(agent => agent.companyId !== workspaceId)
    ? agents.filter(agent => agent.id === binding.selectedAgentId) : [];
  const member = memberMatches.length === 1 ? memberMatches[0] : null;
  const statusAllowed = profile.status === "idle" || profile.status === "running"
    || profile.status === "paused" && exactObject(member) && member.pauseReason === "system";
  if (!member || member.status !== profile.status || !statusAllowed) {
    throw new Error("manager-workspace-membership-unavailable");
  }
  const lead = parseLeadAgentBinding(await platform.state.get(stateKey(workspaceId, "lead-agent.v1")) ?? {
    workspaceId, revision: 0, selectedAgentId: null,
  }, workspaceId);
  if (lead.selectedAgentId === binding.selectedAgentId) throw new Error("manager-is-current-lead");
  let leadSessionIds: readonly (string | null)[] = [];
  if (lead.selectedAgentId) {
    const leadSessions = parseLeadSessions(await platform.state.get(stateKey(workspaceId, `lead-sessions.v1.${lead.revision}`)) ?? {
      workspaceId, selectionRevision: lead.revision, agentId: lead.selectedAgentId,
      sessions: { main: null, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null },
    }, workspaceId);
    if (Object.values(leadSessions.sessions).includes(binding.selectedAgentId)) throw new Error("manager-is-lead-session-agent");
    leadSessionIds = Object.values(leadSessions.sessions);
  }
  const ctos = await readProjectCtos(workspaceId, workspaceId, platform);
  if (ctos.ctos.some(cto => cto.agentId === binding.selectedAgentId)) {
    throw new Error("manager-identity-conflicts-with-project-cto");
  }
  const sessionKey = integrationManagerSessionStateKey(workspaceId, workspaceId, binding.selectedAgentId);
  const sessionBinding = parseIntegrationManagerSessionBinding(await platform.state.get(sessionKey), workspaceId, workspaceId);
  if (sessionBinding.managerAgentId !== binding.selectedAgentId
    || sessionBinding.taskKey !== integrationManagerSessionTaskKey(workspaceId, workspaceId, binding.selectedAgentId)) {
    throw new Error("manager-session-binding-not-current");
  }
  if (leadSessionIds.includes(sessionBinding.sessionId) || ctos.ctos.some(cto => cto.sessionId === sessionBinding.sessionId)) {
    throw new Error("manager-session-is-not-independent");
  }
  const observations = await platform.agents.sessions.list(binding.selectedAgentId, workspaceId);
  if (!Array.isArray(observations) || observations.length > 100) throw new Error("manager-session-observation-unavailable");
  const session = observations.filter(item => exactObject(item) && item.sessionId === sessionBinding.sessionId);
  if (session.length !== 1) throw new Error("manager-session-observation-not-unique");
  const observation = session[0]!;
  const contextState = observation.contextState as string;
  const explicitWorkspaceOnly = contextState === "none" && !Object.hasOwn(observation, "context");
  if (observation.observationVersion !== 1 || observation.agentId !== binding.selectedAgentId
    || observation.companyId !== workspaceId || observation.status !== "active" || observation.closedAt !== null
    || contextState !== "valid" && !explicitWorkspaceOnly || contextState === "none" && Object.hasOwn(observation, "context")
    || observation.managedAgentOwnership !== "owned"
    || observation.taskKey !== sessionBinding.taskKey) throw new Error("manager-session-not-current-owned-independent");
  if (typeof platform.agents.sessions.describePolicySupport !== "function") throw new Error("manager-policy-support-api-unavailable");
  const support = await platform.agents.sessions.describePolicySupport(sessionBinding.sessionId, workspaceId);
  if (!exactObject(support) || support.schemaVersion !== 1 || support.enforcement !== "dispatch-and-run"
    || support.readiness !== "unknown" || support.osIsolation !== "not-certified" || !Array.isArray(support.modes)
    || !support.modes.includes("plugin-tools-only-v1")) throw new Error("manager-plugin-tools-only-policy-unavailable");
  const latest = parseIntegrationManagerBinding(await platform.state.get(integrationManagerStateKey(workspaceId)), workspaceId);
  if (latest.revision !== binding.revision || latest.selectedAgentId !== binding.selectedAgentId) {
    throw new Error("manager-selection-changed-during-authority-check");
  }
  return { agentId: binding.selectedAgentId, sessionId: sessionBinding.sessionId, taskKey: sessionBinding.taskKey };
}

async function findCurrentEvent(workspaceId: string, eventId: string, platform: Host): Promise<VerifiedEventLookup> {
  const board = await readWorkstreams(workspaceId, workspaceId, platform);
  if (!board || board.revision.workstreams.length > MAX_WORKSTREAMS) return { status: "unknown" as const, reason: "workstream-board-unavailable-or-over-bound" };
  const publication = createWorkstreamVerificationPublication(revisionState(platform));
  const matches: Array<{ workstreamId: string; snapshot: VerifiedWorkstreamSnapshot }> = [];
  let stale = false;
  let unknown: string | undefined;
  for (const workstream of board.revision.workstreams) {
    const read = await publication.readCurrent({ workspaceId, projectId: workspaceId,
      workstreamId: workstream.spec.id, eventId });
    if (read.status === "current") matches.push({ workstreamId: workstream.spec.id, snapshot: read.snapshot });
    else if (read.status === "stale") stale = true;
    else if (read.reason !== "verified-event-not-published") unknown ??= read.reason;
  }
  if (matches.length > 1) return { status: "conflict" as const, reason: "event-id-matches-multiple-workstreams" };
  if (matches.length === 1) return { status: "current" as const, ...matches[0]! };
  return stale ? { status: "stale" as const, reason: "verified-event-is-no-longer-current" }
    : { status: "unknown" as const, reason: unknown ?? "verified-event-not-found-in-current-workstream-board" };
}

type CurrentEvent = Extract<VerifiedEventLookup, { status: "current" }>;
type EventConsumeResult = Readonly<{ status: "accepted" | "pending" | "uncertain" | "stale" | "unknown" | "unsupported" | "conflict" | "waiting-dependencies" | "waiting-manager";
  eventId: string; reason: string; waitingDependencies?: true; requestId?: string; receipt?: Readonly<{ receiptId: string; runId: string }> }>;

async function consumeCurrentEvent(workspaceId: string, located: CurrentEvent, platform: Host): Promise<EventConsumeResult> {
  const scope = { workspaceId, projectId: workspaceId, workstreamId: located.workstreamId, eventId: located.snapshot.eventId };
  const readCurrent = async (currentScope: { workspaceId: string; projectId: string; workstreamId: string; eventId: string }) =>
    createWorkstreamVerificationPublication(revisionState(platform)).readCurrent(currentScope);
  let readiness: Awaited<ReturnType<typeof readIntegrationReadiness>>;
  try { readiness = await readIntegrationReadiness(workspaceId, located.workstreamId, platform); }
  catch { return { status: "unknown", eventId: scope.eventId, reason: "integration-plan-or-prerequisite-reader-unavailable" }; }
  if (readiness.status === "unknown") return { status: "unknown", eventId: scope.eventId, reason: readiness.reason };
  if (readiness.status === "waiting-dependencies") {
    const waiting = await consumeVerifiedWorkstream(scope, platform.state, readCurrent);
    return { status: "waiting-dependencies", waitingDependencies: true, eventId: scope.eventId, reason: readiness.reason,
      ...(waiting.requestId ? { requestId: waiting.requestId } : {}) };
  }

  const sessions = platform.agents.sessions;
  if (typeof sessions.sendMessage !== "function" || typeof sessions.getRequest !== "function" || typeof sessions.getRun !== "function") {
    const unsupported = await consumeVerifiedWorkstream(scope, platform.state, readCurrent);
    return { ...unsupported, reason: "manager-session-dispatch-or-receipt-api-unavailable" };
  }
  let authority: ManagerAuthority;
  try { authority = await resolveCurrentIntegrationManagerAuthority(workspaceId, platform); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "manager-current-authority-unavailable";
    return { status: reason === "manager-selected-agent-does-not-match-owned-role-profile" ? "unsupported" : "unknown",
      eventId: scope.eventId, reason: reason.slice(0, 200) };
  }
  let policy: { mode: string; toolNames: readonly string[] } | null;
  try { policy = (await import("../session-execution-policy.ts")).INTEGRATION_MANAGER_SESSION_EXECUTION_POLICY; }
  catch { return { status: "unknown", eventId: scope.eventId, reason: "manager-restricted-tool-policy-unavailable" }; }
  if (!policy || policy.mode !== "plugin-tools-only-v1"
    || JSON.stringify([...policy.toolNames].sort()) !== JSON.stringify(MANAGER_EXECUTION_TOOLS)) {
    return { status: "unknown", eventId: scope.eventId, reason: "manager-restricted-tool-policy-unavailable-or-mismatched" };
  }
  if (readiness.status !== "ready") return { status: "unknown", eventId: scope.eventId, reason: "integration-readiness-state-invalid" };
  const port = platformManagerDispatchPort({ workspaceId, workstreamId: located.workstreamId,
    eventId: scope.eventId, authority, planDigest: readiness.planDigest, plan: readiness.plan, platform });
  const reservation = await readVerifiedWorkstreamReservation({ ...scope, verifiedEventId: scope.eventId }, platform.state);
  if (!reservation?.requestId) {
    const slot = await observeManagerSlot(workspaceId, authority, platform);
    const protectedWaiting = slot.status === "available" && slot.lastRunId !== null
      && await hasPendingProtectedManagerWork(workspaceId, platform);
    if (slot.status === "busy" || protectedWaiting) {
      // The existing zero-attempt reservation is the durable queue. A waiting
      // event must not take a slot released while the reservation is being
      // saved. The terminal handler first reconciles any protected continuation.
      const parked = await consumeVerifiedWorkstream(scope, platform.state, readCurrent);
      if (parked.status !== "pending" || parked.requestId) return parked;
      return { status: "waiting-manager", eventId: scope.eventId,
        reason: protectedWaiting ? "manager-protected-continuation-has-priority" : "manager-session-has-an-active-run" };
    }
    if (slot.status !== "available") return { status: "unknown", eventId: scope.eventId,
      reason: slot.status === "cancelled" ? "manager-session-was-cancelled" : "manager-session-slot-not-authoritative" };
    if (await readManagerLastRunId(workspaceId, authority, platform) !== slot.lastRunId) {
      return { status: "unknown", eventId: scope.eventId, reason: "manager-session-head-changed-before-reservation" };
    }
  }
  return consumeVerifiedWorkstream(scope, platform.state, readCurrent, port);
}

async function* currentManagerReservations(workspaceId: string, platform: Host) {
  const board = await readWorkstreams(workspaceId, workspaceId, platform);
  if (!board || board.revision.workstreams.length > MAX_WORKSTREAMS) throw new Error("manager-queued-workstream-board-unavailable-or-over-bound");
  const publication = createWorkstreamVerificationPublication(revisionState(platform));
  for (const { spec } of board.revision.workstreams) {
    const latest = await publication.readLatestCurrent({ workspaceId, projectId: workspaceId, workstreamId: spec.id });
    if (latest.status !== "current") {
      if (latest.status === "unknown" && latest.reason !== "verified-head-unavailable") {
        throw new Error("manager-queued-verified-head-unavailable");
      }
      continue;
    }
    const reservation = await readVerifiedWorkstreamReservation({ workspaceId, projectId: workspaceId, workstreamId: spec.id,
      verifiedEventId: latest.snapshot.eventId }, platform.state);
    if (reservation) yield { reservation, snapshot: latest.snapshot, workstreamId: spec.id };
  }
}

async function hasPendingProtectedManagerWork(workspaceId: string, platform: Host) {
  let scanned = 0;
  for await (const { reservation } of currentManagerReservations(workspaceId, platform)) {
    scanned += reservation.continuations?.length ?? 0;
    if (scanned > MAX_TERMINAL_ATTEMPT_LOOKUPS) throw new Error("manager-protected-priority-scan-over-bound");
    if (reservation.status === "accepted" && reservation.continuations?.some(item => ["waiting", "pending", "uncertain"].includes(item.status))) return true;
  }
  return false;
}

async function drainUnattemptedManagerWork(workspaceId: string, terminalRunId: string, authority: ManagerAuthority, platform: Host) {
  // A replay of an old terminal event may not advance a newer session head.
  if (await readManagerLastRunId(workspaceId, authority, platform) !== terminalRunId) return null;
  for await (const { reservation, snapshot, workstreamId } of currentManagerReservations(workspaceId, platform)) {
    if (!reservation || reservation.requestId !== null || reservation.status !== "pending" || reservation.dispatchAttempts !== 0) continue;
    if (await readManagerLastRunId(workspaceId, authority, platform) !== terminalRunId) return null;
    const consumed = await consumeCurrentEvent(workspaceId, { status: "current", workstreamId, snapshot }, platform);
    if (consumed.status !== "waiting-dependencies" && consumed.status !== "stale") return consumed;
  }
  return null;
}

/** Event-only Workspace job consumer. Core owns active invocation and lease checks. */
export async function consumeVerifiedWorkstreamJob(job: Job, platformInput: SpsPlatformInvocationContext) {
  const platform = platformInput as Host;
  if (job.jobKey !== WORKSTREAM_VERIFIED_JOB || job.trigger !== "event" || !job.eventId
    || !job.companyId || !UUID.test(job.companyId) || !job.runId || !UUID.test(job.runId)) {
    return { status: "unknown" as const, reason: "event-job-context-incomplete-or-unsupported" };
  }
  if (job.event !== undefined) {
    if (!exactObject(job.event) || Reflect.ownKeys(job.event).length !== 2 || typeof job.event.eventType !== "string") {
      return { status: "unknown" as const, eventId: job.eventId, reason: "sanitized-job-event-context-malformed" };
    }
    if (job.event.eventType === PROTECTED_TERMINAL_EVENT || job.event.eventType === PROTECTED_RECHECK_EVENT) {
      const recheck = job.event.eventType === PROTECTED_RECHECK_EVENT;
      const payload = parseProtectedTerminalPayload(job.event.payload, recheck);
      if (!EVENT_ID.test(job.eventId) || !payload || payload.companyId !== job.companyId) {
        return { status: "unknown" as const, eventId: job.eventId, reason: "protected-terminal-event-payload-invalid" };
      }
      if (recheck && job.eventId !== `builder-protected-recheck-v1:${sha256Json([payload.sourceEventId, payload.runId, payload.receiptDigest])}`) {
        return { status: "unknown" as const, eventId: job.eventId, reason: "protected-terminal-recheck-identity-mismatch" };
      }
      const terminalEventId = recheck ? payload.sourceEventId! : job.eventId;
      if (!recheck) {
        const qa = await consumeTaskQaProtectedTerminal(job.companyId, terminalEventId, payload, platform);
        if (qa.status !== "not-applicable") return qa;
      }
      return consumeProtectedTerminalJob(job, platform, payload, terminalEventId);
    }
    if (job.event.eventType !== WORKSTREAM_VERIFIED_EVENT) {
      return { status: "ignored" as const, eventId: job.eventId, reason: "unrelated-workspace-event" };
    }
  } else if (job.eventId.length > 160) {
    return { status: "unsupported" as const, eventId: job.eventId, reason: "protected-terminal-event-context-unavailable-on-legacy-sdk" };
  }
  if (!ID.test(job.eventId)) return { status: "unknown" as const, eventId: job.eventId, reason: "verified-event-id-invalid" };
  const located = await findCurrentEvent(job.companyId, job.eventId, platform);
  if (located.status === "unknown" && located.reason === "verified-event-not-found-in-current-workstream-board") {
    return { status: "ignored" as const, eventId: job.eventId, reason: "unrelated-or-no-longer-indexed-event" };
  }
  if (located.status !== "current") return located;
  const main = await consumeCurrentEvent(job.companyId, located, platform);
  if (main.status === "stale" || main.status === "unknown" || main.status === "unsupported" || main.status === "conflict") return main;

  const board = await readWorkstreams(job.companyId, job.companyId, platform);
  if (!board || board.revision.workstreams.length > MAX_WORKSTREAMS) {
    return { status: "unknown" as const, eventId: job.eventId, reason: "dependent-workstream-board-unavailable-or-over-bound" };
  }
  const publication = createWorkstreamVerificationPublication(revisionState(platform));
  const dependentOutcomes: EventConsumeResult[] = [];
  for (const workstream of board.revision.workstreams) {
    if (!workstream.spec.dependencies.includes(located.workstreamId)) continue;
    const latest = await publication.readLatestCurrent({ workspaceId: job.companyId, projectId: job.companyId,
      workstreamId: workstream.spec.id });
    if (latest.status === "unknown" && latest.reason === "verified-head-unavailable") continue;
    if (latest.status === "unknown") return { status: "unknown" as const, eventId: job.eventId,
      reason: "dependent-verified-head-unavailable" };
    if (latest.status === "stale") continue;
    const dependent = await consumeCurrentEvent(job.companyId, { status: "current", workstreamId: workstream.spec.id,
      snapshot: latest.snapshot }, platform);
    dependentOutcomes.push(dependent);
  }
  const unresolved = dependentOutcomes.find(item => !["accepted", "waiting-dependencies", "waiting-manager", "stale"].includes(item.status));
  if (unresolved) return { status: "unknown" as const, eventId: unresolved.eventId,
    reason: `dependent-workstream-dispatch-${unresolved.status}:${unresolved.reason}` };
  return { ...main, dependencyRescans: dependentOutcomes.map(item => ({ eventId: item.eventId, status: item.status, reason: item.reason })) };
}

/** Read capability for an already-dispatched, exact active Manager run. */
export function createVerifiedWorkstreamManagerReadHandler(
  resolveAuthority: typeof resolveCurrentIntegrationManagerAuthority = resolveCurrentIntegrationManagerAuthority,
  readCurrent: typeof findCurrentEvent = findCurrentEvent) {
  return async function readVerifiedWorkstreamForManager(params: unknown, runContext: unknown,
    platformInput: SpsPlatformInvocationContext) {
  const platform = platformInput as Host;
  if (!exactObject(params) || Reflect.ownKeys(params).length !== 2 || typeof params.workstreamId !== "string"
    || !ID.test(params.workstreamId) || typeof params.eventId !== "string" || !ID.test(params.eventId)
    || !exactObject(runContext)) throw new TypeError("Exact Workstream and event IDs are required.");
  const workspaceId = runContext.companyId;
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId)
    || runContext.projectId !== undefined && runContext.projectId !== workspaceId
    || [runContext.agentId, runContext.sessionId, runContext.runId].some(value => typeof value !== "string" || !UUID.test(value))) {
    throw new Error("Authenticated single-Workspace Manager tool context is required.");
  }
  const authority = await resolveAuthority(workspaceId, platform);
  if (runContext.agentId !== authority.agentId || runContext.sessionId !== authority.sessionId) throw new Error("Only the current Manager session may read verified Workstream evidence.");
  const current = await readCurrent(workspaceId, params.eventId, platform);
  if (current.status !== "current" || current.workstreamId !== params.workstreamId || current.snapshot.eventId !== params.eventId
    || current.snapshot.workspaceId !== workspaceId || current.snapshot.projectId !== workspaceId
    || current.snapshot.workstreamId !== params.workstreamId || current.snapshot.verificationStatus !== "VERIFIED") {
    throw new Error("This verified Workstream event is not current.");
  }
  const row = await readVerifiedWorkstreamReservation({ workspaceId, projectId: workspaceId,
    workstreamId: current.workstreamId, verifiedEventId: params.eventId }, platform.state);
  if (!row || !["pending", "accepted"].includes(String(row.status)) || typeof row.requestId !== "string"
    || !/^builder-ws-dispatch-v1:[a-f0-9]{64}$/u.test(row.requestId)) {
    throw new Error("This verification event has no current effect-bound Manager request.");
  }
  let ledgerRequestId: string | null = null, requestId: string | null = null, storedReceipt: unknown = null;
  let pendingContinuation: ProtectedContinuation | null = null;
  let acceptedContinuation: ProtectedContinuation | null = null;
  let initialPendingRequest = false;
  let pendingLineage: NonNullable<ReturnType<typeof parseProtectedContinuationLineage>> | null = null;
  const initialUuid = managerRequestUuidForLedgerKey(row.requestId);
  if (row.status === "pending") {
    initialPendingRequest = true;
    ledgerRequestId = row.requestId; requestId = initialUuid;
  } else if (row.status === "accepted" && row.receipt?.receiptId === initialUuid && row.receipt.runId === runContext.runId) {
    ledgerRequestId = row.requestId; requestId = row.receipt.receiptId; storedReceipt = row.receipt;
  } else {
    const continuation = row.continuations?.find(item => {
      if (!(["pending", "accepted"].includes(item.status))) return false;
      return item.status === "accepted" && item.receipt !== null && item.receipt.runId === runContext.runId
        && REQUEST_ID.test(item.receipt.receiptId);
    });
    if (continuation) { acceptedContinuation = continuation; ledgerRequestId = continuation.requestId;
      requestId = continuation.receipt!.receiptId; storedReceipt = continuation.receipt; }
    else if (row.status === "accepted") {
      const observedRun = await platform.agents.sessions.getRun(authority.sessionId, workspaceId, runContext.runId as string);
      if (!exactActiveManagerRun(observedRun, runContext.runId as string)) {
        throw new Error("Manager tool requires the exact active, non-cancelling Core run.");
      }
      const lineage = parseProtectedContinuationLineage(runSystemEvent(observedRun));
      const candidates = lineage ? (row.continuations ?? []).filter(item => item.status === "pending"
        && continuationMatchesLineage(item, lineage)) : [];
      if (candidates.length === 1) {
        pendingContinuation = candidates[0]!;
        pendingLineage = lineage!;
        ledgerRequestId = pendingContinuation.requestId;
        requestId = pendingLineage.requestId;
      }
    }
  }
  if (!ledgerRequestId || !requestId) throw new Error("Manager run is not authorized by an exact Core request receipt or accepted ledger receipt.");
  if (storedReceipt !== null && (!exactObject(storedReceipt) || storedReceipt.receiptId !== requestId || storedReceipt.runId !== runContext.runId)) {
    throw new Error("Accepted ledger receipt does not match this exact Manager run.");
  }
  const requestReceipt = await platform.agents.sessions.getRequest(authority.sessionId, workspaceId, requestId);
  if (!exactObject(requestReceipt) || requestReceipt.requestId !== requestId || requestReceipt.state !== "submitted"
    || requestReceipt.runId !== runContext.runId) throw new Error("Manager tool run does not match the exact Core request receipt.");
  const run = await platform.agents.sessions.getRun(authority.sessionId, workspaceId, runContext.runId as string);
  if (!exactActiveManagerRun(run, runContext.runId as string)) {
    throw new Error("Manager tool requires the exact active, non-cancelling Core run.");
  }
  if (pendingLineage && !sameProtectedContinuationLineage(parseProtectedContinuationLineage(runSystemEvent(run)), pendingLineage)) {
    throw new Error("Pending Manager continuation Core lineage changed during evidence read.");
  }
  const latest = await resolveAuthority(workspaceId, platform);
  if (latest.agentId !== authority.agentId || latest.sessionId !== authority.sessionId || latest.taskKey !== authority.taskKey) {
    throw new Error("Manager authority changed during evidence read.");
  }
  const latestEvent = await readCurrent(workspaceId, params.eventId, platform);
  if (latestEvent.status !== "current" || latestEvent.workstreamId !== params.workstreamId
    || sha256Json(latestEvent.snapshot) !== sha256Json(current.snapshot)) throw new Error("Verified event changed during Manager evidence read.");
  const latestRow = await readVerifiedWorkstreamReservation({ workspaceId, projectId: workspaceId,
    workstreamId: current.workstreamId, verifiedEventId: params.eventId }, platform.state);
  if (!sameManagerReservationBase(row, latestRow, { allowInitialAcceptance: initialPendingRequest, requestId, runId: runContext.runId as string })
    || acceptedContinuation && !acceptedContinuationStillCurrent(latestRow, acceptedContinuation, requestId, runContext.runId as string)
    || pendingContinuation && !pendingContinuationStillCurrent(latestRow, pendingContinuation, pendingLineage!, runContext.runId as string, initialUuid)) {
    throw new Error("Manager verification reservation changed during evidence read.");
  }
  const data = { eventId: current.snapshot.eventId, workspaceId, projectId: workspaceId, workstreamId: current.workstreamId,
    verificationStatus: "VERIFIED", evidence: current.snapshot };
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_MANAGER_TOOL_RESPONSE_BYTES) throw new Error("verified-evidence-exceeds-bounded-tool-response");
  return { content: "Current guarded verification facts only. This is not Git integration or completion evidence.",
    data: data as unknown as JsonValue };
  };
}

function exactActiveManagerRun(value: unknown, runId: string) {
  return exactObject(value) && value.runId === runId && value.status === "running"
    && value.cancellationRequested === false && value.termination === "not_applicable";
}

function runSystemEvent(value: unknown): unknown {
  return exactObject(value) ? value.systemEvent : undefined;
}

function parseProtectedContinuationLineage(value: unknown) {
  if (!exactObject(value) || Reflect.ownKeys(value).length !== 8
    || value.schemaVersion !== 1 || value.kind !== "protected-test-terminal-event"
    || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)
    || typeof value.previousRunId !== "string" || !REQUEST_ID.test(value.previousRunId)
    || typeof value.eventId !== "string" || !EVENT_ID.test(value.eventId)
    || typeof value.protectedRunId !== "string" || !REQUEST_ID.test(value.protectedRunId)
    || typeof value.receiptDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.receiptDigest)
    || typeof value.subjectKeySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.subjectKeySha256)) return null;
  return value as Readonly<{ schemaVersion: 1; kind: "protected-test-terminal-event"; requestId: string;
    previousRunId: string; eventId: string; protectedRunId: string; receiptDigest: string; subjectKeySha256: string }>;
}

function continuationMatchesLineage(continuation: ProtectedContinuation,
  lineage: NonNullable<ReturnType<typeof parseProtectedContinuationLineage>>) {
  return continuation.status === "pending" && continuation.dispatchAttempts === 1 && continuation.receipt === null
    && continuation.terminalEventId === lineage.eventId && continuation.protectedRunId === lineage.protectedRunId
    && continuation.receiptDigest === lineage.receiptDigest && continuation.subjectKeySha256 === lineage.subjectKeySha256
    && continuation.previousRunId === lineage.previousRunId;
}

function sameProtectedContinuationLineage(left: ReturnType<typeof parseProtectedContinuationLineage>,
  right: NonNullable<ReturnType<typeof parseProtectedContinuationLineage>>) {
  return left !== null && left !== undefined && left.schemaVersion === right.schemaVersion && left.kind === right.kind
    && left.requestId === right.requestId && left.previousRunId === right.previousRunId && left.eventId === right.eventId
    && left.protectedRunId === right.protectedRunId && left.receiptDigest === right.receiptDigest
    && left.subjectKeySha256 === right.subjectKeySha256;
}

function sameManagerReservationBase(before: Awaited<ReturnType<typeof readVerifiedWorkstreamReservation>>,
  after: Awaited<ReturnType<typeof readVerifiedWorkstreamReservation>>,
  options: Readonly<{ allowInitialAcceptance: boolean; requestId: string; runId: string }>) {
  if (!before || !after || before.eventId !== after.eventId || before.evidenceDigest !== after.evidenceDigest
    || before.requestId !== after.requestId) return false;
  if (before.status === after.status) return JSON.stringify(before.receipt) === JSON.stringify(after.receipt);
  return options.allowInitialAcceptance && before.status === "pending" && before.receipt === null
    && after.status === "accepted" && after.receipt?.receiptId === options.requestId && after.receipt.runId === options.runId;
}

function continuationIdentityMatches(current: ProtectedContinuation, before: ProtectedContinuation) {
  return current.requestId === before.requestId && current.terminalEventId === before.terminalEventId
    && current.protectedRunId === before.protectedRunId && current.receiptDigest === before.receiptDigest
    && current.subjectKeySha256 === before.subjectKeySha256 && current.phase === before.phase
    && current.previousRunId === before.previousRunId && current.dispatchAttempts === before.dispatchAttempts
    && current.recoveryWakeCount === before.recoveryWakeCount;
}

function acceptedContinuationStillCurrent(row: Awaited<ReturnType<typeof readVerifiedWorkstreamReservation>>,
  before: ProtectedContinuation, requestId: string, runId: string) {
  if (!row) return false;
  const matches = row.continuations?.filter(item => continuationIdentityMatches(item, before)) ?? [];
  return matches.length === 1 && matches[0]!.status === "accepted"
    && matches[0]!.receipt?.receiptId === requestId && matches[0]!.receipt.runId === runId;
}

function pendingContinuationStillCurrent(row: Awaited<ReturnType<typeof readVerifiedWorkstreamReservation>>,
  before: ProtectedContinuation, lineage: NonNullable<ReturnType<typeof parseProtectedContinuationLineage>>,
  runId: string, initialUuid: string) {
  if (!row || row.status !== "accepted" || row.receipt?.receiptId !== initialUuid) return false;
  const matches = row.continuations?.filter(item => continuationIdentityMatches(item, before)) ?? [];
  if (matches.length !== 1) return false;
  const current = matches[0]!;
  return current.status === "pending" && current.receipt === null
    || current.status === "accepted" && current.receipt?.receiptId === lineage.requestId && current.receipt.runId === runId;
}

export const readVerifiedWorkstreamForManager = createVerifiedWorkstreamManagerReadHandler();
