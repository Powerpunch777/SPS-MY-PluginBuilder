import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey, integrationManagerStateKey,
  parseIntegrationManagerBinding, parseIntegrationManagerSessionBinding } from "../domain/integration-manager.ts";
import { parseLeadAgentBinding } from "../domain/lead-agent.ts";
import { parseLeadSessions } from "../domain/lead-sessions.ts";
import { readProjectCtos } from "../project-cto-tools.ts";
import { WORKSTREAM_VERIFIED_JOB, createWorkstreamVerificationPublication } from "./workstream-verification-publication.ts";
import { consumeVerifiedWorkstream, type VerifiedWorkstreamSnapshot } from "./workstream-verification-consumer.ts";
import { readWorkstreams } from "../workstream-tools.ts";
import type { RevisionState } from "../solution-revision-store.ts";

export const INTEGRATION_MANAGER_VERIFIED_READ_TOOL = "builder.read-verified-workstream";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ID = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const MANAGER_REQUEST_NAMESPACE = Buffer.from("5b6e9b0e5a2d4f0184a7d32c40c4a91f", "hex");
const MAX_WORKSTREAMS = 128;
const MAX_MANAGER_TOOL_RESPONSE_BYTES = 40 * 1024;
type Host = SpsPlatformInvocationContext & {
  agents: SpsPlatformInvocationContext["agents"] & {
    owned?: { get(input: { companyId: string; pluginAgentKey: string }): Promise<unknown> };
    sessions: SpsPlatformInvocationContext["agents"]["sessions"] & {
      list(agentId: string, companyId: string): Promise<unknown[]>;
      describePolicySupport?(sessionId: string, companyId: string): Promise<unknown>;
      getRequest(sessionId: string, companyId: string, requestId: string): Promise<unknown>;
      getRun(sessionId: string, companyId: string, runId: string): Promise<unknown>;
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
  if (!exactObject(receipt) || !["created", "resolved"].includes(String(receipt.status))
    || !Number.isSafeInteger(receipt.revision) || (receipt.revision as number) < 1 || !exactObject(receipt.agent)) {
    throw new Error("manager-owned-profile-unavailable");
  }
  const profile = receipt.agent;
  if (profile.agentId !== binding.selectedAgentId || profile.role !== "integration-manager"
    || !["idle", "running"].includes(String(profile.status))) {
    throw new Error("manager-profile-not-current-and-active");
  }
  const agents = await platform.agents.list({ companyId: workspaceId, limit: 100 });
  if (!Array.isArray(agents) || agents.length > 100 || agents.some(agent => agent.companyId !== workspaceId)
    || !agents.some(agent => agent.id === binding.selectedAgentId && ["idle", "running"].includes(String(agent.status)))) {
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

/** Event-only Workspace job consumer. Core owns active invocation and lease checks. */
export async function consumeVerifiedWorkstreamJob(job: Job, platformInput: SpsPlatformInvocationContext) {
  const platform = platformInput as Host;
  if (job.jobKey !== WORKSTREAM_VERIFIED_JOB || job.trigger !== "event" || !job.eventId
    || !ID.test(job.eventId) || !job.companyId || !UUID.test(job.companyId) || !job.runId || !ID.test(job.runId)) {
    return { status: "unknown" as const, reason: "event-job-context-incomplete-or-unsupported" };
  }
  const located = await findCurrentEvent(job.companyId, job.eventId, platform);
  if (located.status !== "current") return located;
  // No approved Git/CI IntegrationTask Runner contract exists in the public
  // Builder/Core SDK surface yet. Reserve as pending with zero effect attempts.
  const result = await consumeVerifiedWorkstream({ workspaceId: job.companyId, projectId: job.companyId,
    workstreamId: located.workstreamId, eventId: job.eventId }, platform.state, async scope => {
      const read = await createWorkstreamVerificationPublication(revisionState(platform)).readCurrent(scope);
      return read;
    });
  return result;
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
  if (!exactObject(row) || row.status !== "pending" || typeof row.requestId !== "string"
    || !/^builder-ws-dispatch-v1:[a-f0-9]{64}$/u.test(row.requestId)) {
    throw new Error("This verification event has no pending effect-bound Manager request.");
  }
  const requestId = managerRequestUuidForLedgerKey(row.requestId);
  const requestReceipt = await platform.agents.sessions.getRequest(authority.sessionId, workspaceId, requestId);
  if (!exactObject(requestReceipt) || requestReceipt.requestId !== requestId || requestReceipt.state !== "submitted"
    || requestReceipt.runId !== runContext.runId) throw new Error("Manager tool run does not match the exact pending Core request receipt.");
  const run = await platform.agents.sessions.getRun(authority.sessionId, workspaceId, runContext.runId as string);
  if (!exactObject(run) || run.runId !== runContext.runId || run.status !== "running" || run.cancellationRequested !== false) {
    throw new Error("Manager tool requires the exact active, non-cancelling Core run.");
  }
  const latest = await resolveAuthority(workspaceId, platform);
  if (latest.agentId !== authority.agentId || latest.sessionId !== authority.sessionId) throw new Error("Manager authority changed during evidence read.");
  const data = { eventId: current.snapshot.eventId, workspaceId, projectId: workspaceId, workstreamId: current.workstreamId,
    verificationStatus: "VERIFIED", evidence: current.snapshot };
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_MANAGER_TOOL_RESPONSE_BYTES) throw new Error("verified-evidence-exceeds-bounded-tool-response");
  return { content: "Current guarded verification facts only. This is not Git integration or completion evidence.",
    data: data as unknown as JsonValue };
  };
}

export const readVerifiedWorkstreamForManager = createVerifiedWorkstreamManagerReadHandler();
