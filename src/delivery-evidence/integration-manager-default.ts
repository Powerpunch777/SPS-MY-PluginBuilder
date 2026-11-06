import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import {
  decideManagerDefault,
  INTEGRATION_MANAGER_DEFAULT_PROFILE,
  INTEGRATION_MANAGER_OWNED_AGENT_KEY,
  legacyIntegrationManagerSessionTaskKey,
  integrationManagerSessionTaskKey,
  integrationManagerSessionStateKey,
  legacyIntegrationManagerSessionStateKey,
  integrationManagerStateKey,
  isBuilderProjectId,
  parseIntegrationManagerBinding,
  parseIntegrationManagerSessionBinding,
} from "../domain/integration-manager.ts";
import { parseLeadAgentBinding } from "../domain/lead-agent.ts";
import { parseLeadSessions } from "../domain/lead-sessions.ts";

type CompareAndSet = (key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => Promise<{ swapped: boolean }>;
type OwnedAgentClient = Readonly<{
  get(input: { companyId: string; pluginAgentKey: string }): Promise<unknown>;
  ensure(input: { companyId: string; pluginAgentKey: string; config: typeof INTEGRATION_MANAGER_DEFAULT_PROFILE;
    adapterPreference?: readonly string[] }): Promise<unknown>;
}>;
export type IntegrationManagerProfilePreparationScope = Readonly<{
  workspaceId: string;
  projectId?: string;
  state: Readonly<{ get(key: SpsStateKey): Promise<unknown>; compareAndSet?: CompareAndSet }>;
  agents: Readonly<{
    list(input: { companyId: string; limit: number }): Promise<readonly Readonly<{ id: string; companyId: string; status?: string }>[]>;
    describeExecution(agentId: string, companyId: string): Promise<unknown>;
    owned?: OwnedAgentClient;
    sessions: Readonly<{
      ensure(agentId: string, companyId: string, options: { taskKey: string; expectedSessionId?: string }): Promise<unknown>;
    }>;
  }>;
  /** Supplied by the Host-bound action/job registration; must revalidate its Workspace/project scope. */
  assertCurrentScope(): Promise<void>;
}>;
export type IntegrationManagerProfilePreparationInput = Readonly<{
  projectId: string;
  expectedManagerRevision: number;
}>;

type IntegrationManagerActionContext = Readonly<{
  companyId: string;
  actor: Readonly<{ type: string; userId?: string | null; companyId: string }>;
  state: IntegrationManagerProfilePreparationScope["state"];
  agents: IntegrationManagerProfilePreparationScope["agents"];
  projectId?: string;
  assertCurrentInvocation?: (companyId: string) => Promise<void>;
}>;

export type ManagerDefaultRead = Readonly<{
  status: "preserved" | "provisioned" | "conflict" | "unknown";
  reason: string;
  projectId: string;
  workspaceId: string;
  managerAgentId: string | null;
  managerSessionId: string | null;
  managerRevision: number;
  profileProvisioning: "created-or-resolved" | "already-present" | "not-required" | "not-attempted";
  sessionProvisioning: "created-or-resolved" | "already-present" | "not-required" | "not-attempted";
  profileStatus: string | null;
  executionReadiness: "unknown";
  aiRunStarted: false;
  authorityConsistency: "cross-key-reads-are-not-atomic";
}>;

/** Contract provenance is descriptive; source revisions are intentionally not guessed or embedded. */
export const INTEGRATION_MANAGER_OWNED_ADAPTER_CONTRACT = Object.freeze({
  sdkCapability: "agents.owned.manage",
  sdkOperations: Object.freeze(["agents.owned.get", "agents.owned.ensure"] as const),
  coreRpcOperations: Object.freeze(["agents.owned.get", "agents.owned.ensure"] as const),
  ensureSemantics: "workspace-plugin-key-is-idempotent-existing-profile-resolved-unchanged",
  creationState: "system-paused-heartbeat-disabled-wake-on-demand-disabled",
  executionAuthority: "independent-host-delegation-and-run-admission-required",
} as const);

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown) => value as JsonValue;
const CONSISTENCY = "cross-key-reads-are-not-atomic" as const;

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactData(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!plain(value) || Reflect.ownKeys(value).length !== fields.length
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !fields.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    result[field] = descriptor.value;
  }
  return result;
}

function readOwnedAgent(receipt: unknown, statuses: readonly string[]) {
  const row = exactData(receipt, ["status", "revision", "agent"]);
  const agent = row && exactData(row.agent, ["agentId", "name", "role", "title", "icon", "capabilities", "adapterType", "status", "instructions", "executionDefaults"]);
  if (!row || !agent || typeof row.status !== "string" || !statuses.includes(row.status)
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1
    || typeof agent.agentId !== "string" || !UUID.test(agent.agentId) || typeof agent.status !== "string") return null;
  return { agentId: agent.agentId, status: agent.status, receiptStatus: row.status };
}

function ownedStatus(receipt: unknown): string | null {
  if (!plain(receipt)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(receipt, "status");
  return descriptor?.enumerable && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string"
    ? descriptor.value : null;
}

function result(input: { status: ManagerDefaultRead["status"]; reason: string; projectId: string; workspaceId: string;
  managerAgentId?: string | null; managerSessionId?: string | null; managerRevision: number;
  profileProvisioning?: ManagerDefaultRead["profileProvisioning"]; sessionProvisioning?: ManagerDefaultRead["sessionProvisioning"];
  profileStatus?: string | null }): ManagerDefaultRead {
  return Object.freeze({ status: input.status, reason: input.reason, projectId: input.projectId, workspaceId: input.workspaceId,
    managerAgentId: input.managerAgentId ?? null, managerSessionId: input.managerSessionId ?? null,
    managerRevision: input.managerRevision, profileProvisioning: input.profileProvisioning ?? "not-attempted",
    sessionProvisioning: input.sessionProvisioning ?? "not-attempted", profileStatus: input.profileStatus ?? null,
    executionReadiness: "unknown", aiRunStarted: false, authorityConsistency: CONSISTENCY });
}

function requestInput(input: unknown): { projectId: string; expectedManagerRevision: number } {
  const row = exactData(input, ["projectId", "expectedManagerRevision"]);
  if (!row || !isBuilderProjectId(row.projectId) || !Number.isSafeInteger(row.expectedManagerRevision)
    || (row.expectedManagerRevision as number) < 0) throw new TypeError("Invalid Integration Manager preparation input.");
  return { projectId: row.projectId, expectedManagerRevision: row.expectedManagerRevision as number };
}

/** Shared action/job producer. The caller must inject a current Host-bound scope assertion. */
export async function prepareIntegrationManagerDefaultProfile(input: unknown,
  scope: IntegrationManagerProfilePreparationScope): Promise<ManagerDefaultRead> {
  const request = requestInput(input);
  if (!scope || !UUID.test(scope.workspaceId) || scope.projectId !== undefined && scope.projectId !== request.projectId
    || request.projectId !== scope.workspaceId) {
    return result({ status: "unknown", reason: "integration-manager-requires-the-authenticated-single-project-workspace",
      projectId: request.projectId, workspaceId: scope?.workspaceId ?? "", managerRevision: 0 });
  }
  const assertCurrent = async () => {
    await scope.assertCurrentScope();
    if (scope.projectId !== undefined && scope.projectId !== request.projectId) throw new Error("Manager preparation scope changed.");
  };
  await assertCurrent();
  const managerKey = integrationManagerStateKey(scope.workspaceId);
  const raw = await scope.state.get(managerKey) as JsonValue | null;
  const binding = parseIntegrationManagerBinding(raw ?? { schemaVersion: 1, workspaceId: scope.workspaceId,
    revision: 0, selectedAgentId: null }, scope.workspaceId);
  if (binding.revision !== request.expectedManagerRevision) return result({ status: "unknown", reason: "manager-selection-revision-changed",
    projectId: request.projectId, workspaceId: scope.workspaceId, managerAgentId: binding.selectedAgentId, managerRevision: binding.revision });

  const decision = decideManagerDefault(binding);
  if (decision.status === "preserved" && decision.selectedAgentId === null) return result({ status: "preserved", reason: decision.reason,
    projectId: request.projectId, workspaceId: scope.workspaceId, managerRevision: binding.revision,
    profileProvisioning: "not-required", sessionProvisioning: "not-required" });

  let managerAgentId = decision.selectedAgentId;
  let profileStatus: string | null = null;
  let profileProvisioning: ManagerDefaultRead["profileProvisioning"] = "not-required";
  if (decision.status === "provision") {
    const owned = scope.agents.owned;
    if (!owned || typeof owned.get !== "function" || typeof owned.ensure !== "function") return result({ status: "unknown",
      reason: "host-owned-agent-api-or-agents-owned-manage-unavailable", projectId: request.projectId,
      workspaceId: scope.workspaceId, managerRevision: binding.revision });
    if (typeof scope.state.compareAndSet !== "function") return result({ status: "unknown", reason: "host-state-cas-unavailable",
      projectId: request.projectId, workspaceId: scope.workspaceId, managerRevision: binding.revision });
    try {
      await assertCurrent();
      const read = await owned.get({ companyId: scope.workspaceId, pluginAgentKey: INTEGRATION_MANAGER_OWNED_AGENT_KEY });
      const readRow = exactData(read, ["status"]);
      const existing = readRow?.status === "missing" ? null : readOwnedAgent(read, ["created", "resolved"]);
      if (existing) {
        managerAgentId = existing.agentId;
        profileStatus = existing.status;
        profileProvisioning = "already-present";
      } else if (readRow?.status === "missing") {
        const leadKey = { ...managerKey, stateKey: "lead-agent.v1" };
        const leadRaw = await scope.state.get(leadKey) as JsonValue | null;
        const lead = leadRaw === null ? null : parseLeadAgentBinding(leadRaw, scope.workspaceId);
        if (!lead?.selectedAgentId || lead.selectedAgentId === managerAgentId) return result({ status: "unknown",
          reason: "current-lead-adapter-selection-unavailable", projectId: request.projectId,
          workspaceId: scope.workspaceId, managerRevision: binding.revision });
        const leadAgents = await scope.agents.list({ companyId: scope.workspaceId, limit: 100 });
        if (!Array.isArray(leadAgents) || leadAgents.length > 100 || leadAgents.some(agent => agent.companyId !== scope.workspaceId)
          || !leadAgents.some(agent => agent.id === lead.selectedAgentId)) return result({ status: "unknown",
          reason: "current-lead-workspace-membership-unavailable", projectId: request.projectId,
          workspaceId: scope.workspaceId, managerRevision: binding.revision });
        if (typeof scope.agents.describeExecution !== "function") return result({ status: "unknown",
          reason: "current-lead-adapter-observation-unavailable", projectId: request.projectId,
          workspaceId: scope.workspaceId, managerRevision: binding.revision });
        await assertCurrent();
        let leadExecutionRaw: unknown;
        try {
          leadExecutionRaw = await scope.agents.describeExecution(lead.selectedAgentId, scope.workspaceId);
        } catch {
          return result({ status: "unknown", reason: "current-lead-adapter-observation-unavailable",
            projectId: request.projectId, workspaceId: scope.workspaceId, managerRevision: binding.revision });
        }
        const leadExecution = exactData(leadExecutionRaw,
          ["agentId", "adapterType", "state", "adapterRegistration", "executionOwner", "authorization", "readiness", "node"]);
        if (!leadExecution || leadExecution.agentId !== lead.selectedAgentId || typeof leadExecution.adapterType !== "string"
          || !leadExecution.adapterType.trim() || leadExecution.state !== "configured"
          || leadExecution.adapterRegistration !== "registered" || leadExecution.executionOwner !== "adapter") return result({ status: "unknown",
          reason: "current-lead-adapter-selection-unconfirmed", projectId: request.projectId,
          workspaceId: scope.workspaceId, managerRevision: binding.revision });
        const latestLead = parseLeadAgentBinding(await scope.state.get(leadKey), scope.workspaceId);
        if (latestLead.revision !== lead.revision || latestLead.selectedAgentId !== lead.selectedAgentId) return result({
          status: "conflict", reason: "current-lead-selection-changed-before-manager-profile-create",
          projectId: request.projectId, workspaceId: scope.workspaceId, managerRevision: binding.revision });
        await assertCurrent();
        const ensured = await owned.ensure({ companyId: scope.workspaceId, pluginAgentKey: INTEGRATION_MANAGER_OWNED_AGENT_KEY,
          config: INTEGRATION_MANAGER_DEFAULT_PROFILE, adapterPreference: [leadExecution.adapterType] });
        if (ownedStatus(ensured) === "uncertain") return result({ status: "unknown",
          reason: "host-owned-profile-ensure-uncertain-after-adapter-preference",
          projectId: request.projectId, workspaceId: scope.workspaceId, managerRevision: binding.revision });
        const created = readOwnedAgent(ensured, ["created", "resolved"]);
        if (!created) return result({ status: "unknown", reason: "host-owned-profile-not-created-or-resolved",
          projectId: request.projectId, workspaceId: scope.workspaceId, managerRevision: binding.revision });
        if (created.receiptStatus === "created" && created.status !== "paused") return result({ status: "unknown",
          reason: "host-owned-created-profile-not-paused",
          projectId: request.projectId, workspaceId: scope.workspaceId, managerRevision: binding.revision });
        managerAgentId = created.agentId;
        profileStatus = created.status;
        profileProvisioning = "created-or-resolved";
      } else return result({ status: "unknown", reason: "host-owned-agent-get-unsupported-or-uncertain",
        projectId: request.projectId, workspaceId: scope.workspaceId, managerRevision: binding.revision });
      await assertCurrent();
    } catch {
      return result({ status: "unknown", reason: "host-owned-agent-operation-uncertain",
        projectId: request.projectId, workspaceId: scope.workspaceId, managerRevision: binding.revision });
    }
  }

  if (!managerAgentId) return result({ status: "unknown", reason: "manager-selection-unavailable", projectId: request.projectId,
    workspaceId: scope.workspaceId, managerRevision: binding.revision });
  const leadRaw = await scope.state.get({ ...managerKey, stateKey: "lead-agent.v1" });
  const lead = leadRaw === null ? null : parseLeadAgentBinding(leadRaw, scope.workspaceId);
  if (lead?.selectedAgentId === managerAgentId) return result({ status: "unknown", reason: "manager-agent-matches-current-lead",
    projectId: request.projectId, workspaceId: scope.workspaceId, managerAgentId, managerRevision: binding.revision,
    profileProvisioning, profileStatus });
  const leadSessionsRaw = lead && lead.selectedAgentId !== null
    ? await scope.state.get({ ...managerKey, stateKey: `lead-sessions.v1.${lead.revision}` }) : null;
  const leadSessions = lead && leadSessionsRaw !== null ? parseLeadSessions(leadSessionsRaw, scope.workspaceId) : null;
  if (leadSessions && Object.values(leadSessions.sessions).includes(managerAgentId)) return result({ status: "unknown",
    reason: "manager-agent-matches-current-lead-session", projectId: request.projectId, workspaceId: scope.workspaceId,
    managerAgentId, managerRevision: binding.revision, profileProvisioning, profileStatus });

  const agents = await scope.agents.list({ companyId: scope.workspaceId, limit: 100 });
  if (!Array.isArray(agents) || agents.length > 100 || agents.some(agent => agent.companyId !== scope.workspaceId)
    || !agents.some(agent => agent.id === managerAgentId)) return result({ status: "unknown", reason: "manager-workspace-membership-unavailable",
      projectId: request.projectId, workspaceId: scope.workspaceId, managerAgentId, managerRevision: binding.revision,
      profileProvisioning, profileStatus });
  await assertCurrent();

  let managerRevision = binding.revision;
  if (decision.status === "provision") {
    const next = { schemaVersion: 1, workspaceId: scope.workspaceId, revision: binding.revision + 1,
      selectedAgentId: managerAgentId } as JsonValue;
    try {
      const expected = raw === null ? { exists: false as const } : { exists: true as const, value: raw };
      const saved = await scope.state.compareAndSet!(managerKey, expected, next);
      if (!saved || saved.swapped !== true) return result({ status: "conflict", reason: "manager-binding-cas-conflict",
        projectId: request.projectId, workspaceId: scope.workspaceId, managerAgentId, managerRevision: binding.revision,
        profileProvisioning, profileStatus });
      const confirmed = parseIntegrationManagerBinding(await scope.state.get(managerKey), scope.workspaceId);
      if (confirmed.revision !== binding.revision + 1 || confirmed.selectedAgentId !== managerAgentId) return result({ status: "unknown",
        reason: "manager-binding-readback-mismatch", projectId: request.projectId, workspaceId: scope.workspaceId,
        managerAgentId: confirmed.selectedAgentId, managerRevision: confirmed.revision, profileProvisioning, profileStatus });
      managerRevision = confirmed.revision;
    } catch {
      return result({ status: "unknown", reason: "manager-binding-cas-uncertain", projectId: request.projectId,
        workspaceId: scope.workspaceId, managerAgentId, managerRevision: binding.revision, profileProvisioning, profileStatus });
    }
  }

  const sessionKey = integrationManagerSessionStateKey(scope.workspaceId, request.projectId, managerAgentId);
  const legacySessionKey = legacyIntegrationManagerSessionStateKey(scope.workspaceId, request.projectId);
  let sessionRaw: JsonValue | null;
  let existingSession: ReturnType<typeof parseIntegrationManagerSessionBinding> | null = null;
  let legacySession: ReturnType<typeof parseIntegrationManagerSessionBinding> | null = null;
  let legacySessionRaw: JsonValue | null = null;
  try {
    sessionRaw = await scope.state.get(sessionKey) as JsonValue | null;
    if (sessionRaw !== null) existingSession = parseIntegrationManagerSessionBinding(sessionRaw, scope.workspaceId, request.projectId);
    if (sessionRaw === null) {
      legacySessionRaw = await scope.state.get(legacySessionKey) as JsonValue | null;
      if (legacySessionRaw !== null) {
        try {
          const parsedLegacy = parseIntegrationManagerSessionBinding(legacySessionRaw, scope.workspaceId, request.projectId);
          if (parsedLegacy.managerAgentId === managerAgentId) legacySession = parsedLegacy;
        } catch { /* Preserve malformed legacy evidence; never adopt it. */ }
      }
    }
  } catch {
    return result({ status: "unknown", reason: "manager-session-registry-invalid", projectId: request.projectId,
      workspaceId: scope.workspaceId, managerAgentId, managerRevision, profileProvisioning, profileStatus });
  }
  if (existingSession && existingSession.managerAgentId !== managerAgentId) return result({ status: "conflict",
    reason: "manager-session-registry-agent-changed", projectId: request.projectId, workspaceId: scope.workspaceId,
    managerAgentId, managerSessionId: existingSession.sessionId, managerRevision, profileProvisioning,
    sessionProvisioning: "already-present", profileStatus });
  try {
    await assertCurrent();
    const currentManagerRaw = await scope.state.get(managerKey) as JsonValue | null;
    const currentManager = parseIntegrationManagerBinding(currentManagerRaw ?? { schemaVersion: 1,
      workspaceId: scope.workspaceId, revision: 0, selectedAgentId: null }, scope.workspaceId);
    if (currentManager.revision !== managerRevision || currentManager.selectedAgentId !== managerAgentId) return result({
      status: "conflict", reason: "manager-selection-changed-before-session-ensure", projectId: request.projectId,
      workspaceId: scope.workspaceId, managerAgentId: currentManager.selectedAgentId, managerRevision: currentManager.revision,
      profileProvisioning, profileStatus });
    const adoptedLegacy = !existingSession && legacySession !== null;
    const sessionTaskKey = existingSession?.taskKey ?? (adoptedLegacy
      ? legacyIntegrationManagerSessionTaskKey(scope.workspaceId, request.projectId)
      : integrationManagerSessionTaskKey(scope.workspaceId, request.projectId, managerAgentId));
    const ensured = await scope.agents.sessions.ensure(managerAgentId, scope.workspaceId, {
      taskKey: sessionTaskKey,
      ...((existingSession ?? legacySession) ? { expectedSessionId: (existingSession ?? legacySession)!.sessionId } : {}),
    });
    const sessionReceipt = exactData(ensured, ["sessionId", "created"]);
    if (!sessionReceipt || typeof sessionReceipt.sessionId !== "string" || !UUID.test(sessionReceipt.sessionId)
      || typeof sessionReceipt.created !== "boolean"
      || (existingSession ?? legacySession) && (sessionReceipt.sessionId !== (existingSession ?? legacySession)!.sessionId || sessionReceipt.created !== false)
      || leadSessions && Object.values(leadSessions.sessions).includes(sessionReceipt.sessionId)) {
      return result({ status: "unknown", reason: "host-manager-session-ensure-invalid-or-shared",
        projectId: request.projectId, workspaceId: scope.workspaceId, managerAgentId, managerRevision,
        profileProvisioning, profileStatus });
    }
    await assertCurrent();
    const sessionId = sessionReceipt.sessionId;
    const afterEnsureRaw = await scope.state.get(managerKey) as JsonValue | null;
    const afterEnsure = parseIntegrationManagerBinding(afterEnsureRaw ?? { schemaVersion: 1,
      workspaceId: scope.workspaceId, revision: 0, selectedAgentId: null }, scope.workspaceId);
    if (afterEnsure.revision !== managerRevision || afterEnsure.selectedAgentId !== managerAgentId) return result({
      status: "conflict", reason: "manager-selection-changed-during-session-ensure", projectId: request.projectId,
      workspaceId: scope.workspaceId, managerAgentId: afterEnsure.selectedAgentId, managerSessionId: sessionId,
      managerRevision: afterEnsure.revision, profileProvisioning,
      sessionProvisioning: existingSession || legacySession ? "already-present" : "created-or-resolved", profileStatus });
    if (!existingSession) {
      if (typeof scope.state.compareAndSet !== "function") return result({ status: "unknown", reason: "host-state-cas-unavailable-after-session-ensure",
        projectId: request.projectId, workspaceId: scope.workspaceId, managerAgentId, managerSessionId: sessionId,
        managerRevision, profileProvisioning, sessionProvisioning: "created-or-resolved", profileStatus });
      const nextSession = { schemaVersion: 1, workspaceId: scope.workspaceId, projectId: request.projectId,
        managerAgentId, sessionId, taskKey: sessionTaskKey } as JsonValue;
      const saved = await scope.state.compareAndSet(sessionKey, sessionRaw === null
        ? { exists: false } : { exists: true, value: sessionRaw }, nextSession);
      if (!saved || saved.swapped !== true) return result({ status: "conflict", reason: "manager-session-binding-cas-conflict",
        projectId: request.projectId, workspaceId: scope.workspaceId, managerAgentId, managerSessionId: sessionId,
        managerRevision, profileProvisioning, sessionProvisioning: "created-or-resolved", profileStatus });
    }
    const confirmed = parseIntegrationManagerSessionBinding(await scope.state.get(sessionKey), scope.workspaceId, request.projectId);
    if (confirmed.managerAgentId !== managerAgentId || confirmed.sessionId !== sessionId) return result({ status: "unknown",
      reason: "manager-session-binding-readback-mismatch", projectId: request.projectId, workspaceId: scope.workspaceId,
      managerAgentId, managerSessionId: sessionId, managerRevision, profileProvisioning,
       sessionProvisioning: existingSession || legacySession ? "already-present" : "created-or-resolved", profileStatus });
    await assertCurrent();
    const finalManager = parseIntegrationManagerBinding(await scope.state.get(managerKey), scope.workspaceId);
    if (finalManager.revision !== managerRevision || finalManager.selectedAgentId !== managerAgentId) return result({
      status: "conflict", reason: "manager-selection-changed-during-session-binding", projectId: request.projectId,
      workspaceId: scope.workspaceId, managerAgentId: finalManager.selectedAgentId, managerSessionId: sessionId,
      managerRevision: finalManager.revision, profileProvisioning,
      sessionProvisioning: existingSession || legacySession ? "already-present" : "created-or-resolved", profileStatus });
    return result({ status: decision.status === "provision" ? "provisioned" : "preserved",
      reason: decision.status === "provision" ? "paused-profile-and-independent-keyed-session-prepared" : decision.reason,
      projectId: request.projectId, workspaceId: scope.workspaceId, managerAgentId, managerSessionId: sessionId, managerRevision,
      profileProvisioning, sessionProvisioning: existingSession || legacySession ? "already-present" : "created-or-resolved", profileStatus });
  } catch {
    return result({ status: "unknown", reason: "host-manager-session-ensure-uncertain",
      projectId: request.projectId, workspaceId: scope.workspaceId, managerAgentId, managerRevision,
      profileProvisioning, profileStatus });
  }
}

/** Host registration can adapt an authenticated action or automatic job to the same scope-checked producer. */
export function createIntegrationManagerProfilePreparationHandler<THostContext>(
  resolveScope: (input: unknown, hostContext: THostContext) => Promise<IntegrationManagerProfilePreparationScope>,
): (input: unknown, hostContext: THostContext) => Promise<ManagerDefaultRead> {
  return async (input: unknown, hostContext: THostContext) => prepareIntegrationManagerDefaultProfile(input,
    await resolveScope(input, hostContext));
}

/** Existing user-action entry point; automation should use the exported common handler factory. */
export async function ensureIntegrationManagerDefaultProfile(input: unknown, context: IntegrationManagerActionContext): Promise<ManagerDefaultRead> {
  if (context.actor?.type !== "user" || !context.actor.userId?.trim() || context.actor.companyId !== context.companyId) {
    throw new Error("A Host-authenticated user action is required.");
  }
  const request = requestInput(input);
  const scope: IntegrationManagerProfilePreparationScope = {
    workspaceId: context.companyId,
    ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
    state: context.state as IntegrationManagerProfilePreparationScope["state"],
    agents: context.agents as unknown as IntegrationManagerProfilePreparationScope["agents"],
    assertCurrentScope: async () => {
      if (context.assertCurrentInvocation) await context.assertCurrentInvocation(context.companyId);
      if (context.actor.companyId !== context.companyId || context.projectId !== undefined && context.projectId !== request.projectId) {
        throw new Error("The authenticated Manager preparation scope changed.");
      }
    },
  };
  return prepareIntegrationManagerDefaultProfile(input, scope);
}

export type IntegrationManagerPlatformContext = SpsPlatformInvocationContext;
