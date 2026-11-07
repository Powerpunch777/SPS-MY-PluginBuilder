import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey, integrationManagerStateKey,
  parseIntegrationManagerBinding, parseIntegrationManagerSessionBinding } from "../domain/integration-manager.ts";
import { parseLeadAgentBinding } from "../domain/lead-agent.ts";
import { parseLeadSessions } from "../domain/lead-sessions.ts";
import { readProjectCtos } from "../project-cto-tools.ts";
import { WORKSTREAM_VERIFIED_JOB, createWorkstreamVerificationPublication } from "./workstream-verification-publication.ts";
import { consumeVerifiedWorkstream, type ManagerDispatchRequest, type VerifiedWorkstreamSnapshot } from "./workstream-verification-consumer.ts";
import { readWorkstreams } from "../workstream-tools.ts";
import type { RevisionState } from "../solution-revision-store.ts";

export const INTEGRATION_MANAGER_VERIFIED_READ_TOOL = "builder.read-verified-workstream";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ID = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const MANAGER_REQUEST_NAMESPACE = Buffer.from("5b6e9b0e5a2d4f0184a7d32c40c4a91f", "hex");
const MAX_WORKSTREAMS = 128;
const MAX_MANAGER_TOOL_RESPONSE_BYTES = 40 * 1024;
const MANAGER_EXECUTION_TOOLS = Object.freeze([
  "builder.integrate-verified-task", "builder.read-integration-progress", INTEGRATION_MANAGER_VERIFIED_READ_TOOL,
  "builder.request-integration-validation",
].sort());
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
type Host = SpsPlatformInvocationContext & {
  agents: SpsPlatformInvocationContext["agents"] & {
    owned?: { get(input: { companyId: string; pluginAgentKey: string }): Promise<unknown> };
    sessions: SpsPlatformInvocationContext["agents"]["sessions"] & {
      list(agentId: string, companyId: string): Promise<unknown[]>;
      describePolicySupport?(sessionId: string, companyId: string): Promise<unknown>;
      getRequest(sessionId: string, companyId: string, requestId: string): Promise<unknown>;
      getRun(sessionId: string, companyId: string, runId: string): Promise<unknown>;
      sendMessage(sessionId: string, companyId: string, options: { requestId: string; prompt: string; reason: string;
        executionPolicy: { mode: "plugin-tools-only-v1"; toolNames: readonly string[] } }): Promise<{ runId: string }>;
    };
  };
};
type Job = Readonly<{ jobKey: string; runId: string; trigger: string; eventId?: string; companyId?: string }>;
type ManagerAuthority = Readonly<{ agentId: string; sessionId: string; taskKey: string }>;
export type VerifiedEventLookup =
  | Readonly<{ status: "current"; workstreamId: string; snapshot: VerifiedWorkstreamSnapshot }>
  | Readonly<{ status: "stale" | "unknown" | "conflict"; reason: string }>;
const stateKey = (workspaceId: string, stateKey: string) => ({ scopeKind: "company" as const,
  scopeId: workspaceId, namespace: "sonpark.my-builder" as const, stateKey });
const revisionState = (platform: Host) => platform.state as typeof platform.state & RevisionState;
const sha256Json = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

type CurrentIntegrationPlan = Readonly<{ revision: unknown; sequence: number }>;
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
  if (observation.observationVersion !== 1 || observation.agentId !== binding.selectedAgentId
    || observation.companyId !== workspaceId || observation.status !== "active" || observation.closedAt !== null
    || observation.contextState !== "valid" || observation.managedAgentOwnership !== "owned"
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
type EventConsumeResult = Readonly<{ status: "accepted" | "pending" | "uncertain" | "stale" | "unknown" | "unsupported" | "conflict" | "waiting-dependencies";
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
  return consumeVerifiedWorkstream(scope, platform.state, readCurrent, port);
}

/** Event-only Workspace job consumer. Core owns active invocation and lease checks. */
export async function consumeVerifiedWorkstreamJob(job: Job, platformInput: SpsPlatformInvocationContext) {
  const platform = platformInput as Host;
  if (job.jobKey !== WORKSTREAM_VERIFIED_JOB || job.trigger !== "event" || !job.eventId
    || !ID.test(job.eventId) || !job.companyId || !UUID.test(job.companyId) || !job.runId || !ID.test(job.runId)) {
    return { status: "unknown" as const, reason: "event-job-context-incomplete-or-unsupported" };
  }
  const located = await findCurrentEvent(job.companyId, job.eventId, platform);
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
  const unresolved = dependentOutcomes.find(item => !["accepted", "waiting-dependencies", "stale"].includes(item.status));
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
  if (current.status !== "current" || current.workstreamId !== params.workstreamId) throw new Error("This verified Workstream event is not current.");
  const ledgerKey = { scopeKind: "company" as const, scopeId: workspaceId, namespace: "sonpark.my-builder" as const,
    stateKey: `verified-consumption.v1.${createHash("sha256").update(`${workspaceId}\0${current.workstreamId}`, "utf8").digest("hex")}` };
  const ledger = await platform.state.get(ledgerKey);
  if (!exactObject(ledger) || ledger.schemaVersion !== 2 || !Array.isArray(ledger.events)) throw new Error("Manager dispatch ledger is unavailable.");
  const row = ledger.events.find(event => exactObject(event) && event.eventId === params.eventId);
  if (!exactObject(row) || !["pending", "accepted"].includes(String(row.status)) || typeof row.requestId !== "string"
    || !/^builder-ws-dispatch-v1:[a-f0-9]{64}$/u.test(row.requestId)) {
    throw new Error("This verification event has no current effect-bound Manager request.");
  }
  const requestId = managerRequestUuidForLedgerKey(row.requestId);
  if (row.status === "accepted") {
    if (!exactObject(row.receipt) || row.receipt.receiptId !== requestId || row.receipt.runId !== runContext.runId) {
      throw new Error("Accepted ledger receipt does not match this exact Manager run.");
    }
  } else if (row.receipt !== null) throw new Error("Pending Manager reservation has an unexpected receipt.");
  const requestReceipt = await platform.agents.sessions.getRequest(authority.sessionId, workspaceId, requestId);
  if (!exactObject(requestReceipt) || requestReceipt.requestId !== requestId || requestReceipt.state !== "submitted"
    || requestReceipt.runId !== runContext.runId) throw new Error("Manager tool run does not match the exact Core request receipt.");
  const run = await platform.agents.sessions.getRun(authority.sessionId, workspaceId, runContext.runId as string);
  if (!exactObject(run) || run.runId !== runContext.runId || run.status !== "running"
    || run.cancellationRequested !== false || run.termination !== "not_applicable") {
    throw new Error("Manager tool requires the exact active, non-cancelling Core run.");
  }
  const latest = await resolveAuthority(workspaceId, platform);
  if (latest.agentId !== authority.agentId || latest.sessionId !== authority.sessionId) throw new Error("Manager authority changed during evidence read.");
  const latestEvent = await readCurrent(workspaceId, params.eventId, platform);
  if (latestEvent.status !== "current" || latestEvent.workstreamId !== params.workstreamId
    || sha256Json(latestEvent.snapshot) !== sha256Json(current.snapshot)) throw new Error("Verified event changed during Manager evidence read.");
  const data = { eventId: current.snapshot.eventId, workspaceId, projectId: workspaceId, workstreamId: current.workstreamId,
    verificationStatus: "VERIFIED", evidence: current.snapshot };
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_MANAGER_TOOL_RESPONSE_BYTES) throw new Error("verified-evidence-exceeds-bounded-tool-response");
  return { content: "Current guarded verification facts only. This is not Git integration or completion evidence.",
    data: data as unknown as JsonValue };
  };
}

export const readVerifiedWorkstreamForManager = createVerifiedWorkstreamManagerReadHandler();
