import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import {
  integrationManagerSessionStateKey,
  integrationManagerStateKey,
  isBuilderProjectId,
  parseIntegrationManagerBinding,
  parseIntegrationManagerSessionBinding,
} from "./domain/integration-manager.ts";
import { parseLeadAgentBinding } from "./domain/lead-agent.ts";
import { ensureIntegrationManagerDefaultProfile } from "./delivery-evidence/integration-manager-default.ts";
import type { IntegrationManagerProfilePreparationScope } from "./delivery-evidence/integration-manager-default.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const EMPTY_BINDING = (workspaceId: string) => ({ schemaVersion: 1, workspaceId, revision: 0, selectedAgentId: null });

export type IntegrationManagerSettings = Readonly<{
  workspaceId: string;
  revision: number;
  selectedAgentId: string | null;
  agents: readonly Readonly<{ id: string; name: string; status: string }>[];
  sessionId: string | null;
  executionReadiness: "unknown";
  aiRunStarted: false;
}>;

type CasState = Readonly<{
  get(key: SpsStateKey): Promise<JsonValue | null>;
  compareAndSet?: (key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, next: JsonValue) => Promise<unknown>;
}>;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== keys.length
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError("Invalid Integration Manager settings input.");
  }
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid Integration Manager settings input.");
    record[key] = descriptor.value;
  }
  return record;
}

function bindingOrDefault(value: JsonValue | null, workspaceId: string) {
  return parseIntegrationManagerBinding(value === null ? EMPTY_BINDING(workspaceId) : value, workspaceId);
}

function jsonSafeAgent(row: Record<string, JsonValue>, workspaceId: string) {
  if (row.companyId !== workspaceId) throw new TypeError("Host Agent belongs to a different Workspace.");
  const id = row.id;
  if (typeof id !== "string" || !UUID.test(id)) throw new TypeError("Invalid Host Agent ID.");
  if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 500) throw new TypeError("Invalid Host Agent name.");
  if (typeof row.status !== "string" || !/^[a-z_]{1,80}$/u.test(row.status)) throw new TypeError("Invalid Host Agent status.");
  return { id: row.id, name: row.name, status: row.status };
}

export function parseIntegrationManagerSettings(value: unknown, workspaceId: string): IntegrationManagerSettings {
  const row = exactRecord(value, ["workspaceId", "revision", "selectedAgentId", "agents", "sessionId", "executionReadiness", "aiRunStarted"]);
  if (row.workspaceId !== workspaceId || !UUID.test(workspaceId) || !Number.isSafeInteger(row.revision)
    || (row.revision as number) < 0 || row.selectedAgentId !== null
      && (typeof row.selectedAgentId !== "string" || !UUID.test(row.selectedAgentId))
    || !Array.isArray(row.agents) || row.agents.length > 100
    || row.sessionId !== null && (typeof row.sessionId !== "string" || !UUID.test(row.sessionId))
    || row.executionReadiness !== "unknown" || row.aiRunStarted !== false) throw new TypeError("Invalid Integration Manager settings DTO.");
  const ids = new Set<string>();
  const agents = row.agents.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "id,name,status") throw new TypeError("Invalid Integration Manager Agent option.");
    const agent = value as Record<string, unknown>;
    if (typeof agent.id !== "string" || !UUID.test(agent.id) || ids.has(agent.id)
      || typeof agent.name !== "string" || !agent.name.trim() || agent.name.length > 500
      || typeof agent.status !== "string" || !/^[a-z_]{1,80}$/u.test(agent.status)) throw new TypeError("Invalid Integration Manager Agent option.");
    ids.add(agent.id);
    return Object.freeze({ id: agent.id, name: agent.name, status: agent.status });
  });
  return Object.freeze({ workspaceId, revision: row.revision as number, selectedAgentId: row.selectedAgentId as string | null,
    agents: Object.freeze(agents), sessionId: row.sessionId as string | null, executionReadiness: "unknown", aiRunStarted: false });
}

export async function readIntegrationManagerOptions(workspaceId: string, platform: SpsPlatformInvocationContext, projectId = workspaceId) {
  if (!isBuilderProjectId(workspaceId) || !isBuilderProjectId(projectId) || projectId !== workspaceId) {
    throw new TypeError("Integration Manager settings require the authenticated Workspace project.");
  }
  const binding = bindingOrDefault(await platform.state.get(integrationManagerStateKey(workspaceId)), workspaceId);
  const rows = await platform.agents.list({ companyId: workspaceId, limit: 100 });
  if (!Array.isArray(rows) || rows.length > 100) throw new TypeError("Invalid Host Agent list.");
  const agents = rows.map(row => jsonSafeAgent(row, workspaceId));
  if (new Set(agents.map(agent => agent.id)).size !== agents.length) throw new TypeError("Duplicate Host Agent entry.");
  let sessionId: string | null = null;
  const rawSession = binding.selectedAgentId === null ? null
    : await platform.state.get(integrationManagerSessionStateKey(workspaceId, projectId, binding.selectedAgentId));
  if (rawSession !== null && binding.selectedAgentId !== null) {
    try {
      const session = parseIntegrationManagerSessionBinding(rawSession, workspaceId, projectId);
      if (session.managerAgentId === binding.selectedAgentId) sessionId = session.sessionId;
    } catch { /* Invalid or stale session bindings are not exposed. */ }
  }
  return parseIntegrationManagerSettings({ workspaceId, revision: binding.revision, selectedAgentId: binding.selectedAgentId,
    agents, sessionId, executionReadiness: "unknown", aiRunStarted: false }, workspaceId);
}

export async function selectIntegrationManager(workspaceId: string, params: unknown, context: SpsActionContext) {
  const input = exactRecord(params, ["agentId", "expectedRevision"]);
  if (!isBuilderProjectId(workspaceId) || context.companyId !== workspaceId || context.actor.type !== "user"
    || context.actor.companyId !== workspaceId || !context.actor.userId?.trim()) throw new Error("An authenticated Workspace user action is required.");
  if (input.agentId !== null && (typeof input.agentId !== "string" || !UUID.test(input.agentId))
    || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) {
    throw new TypeError("Integration Manager selection requires an Agent ID and displayed revision.");
  }
  const state = context.state as CasState;
  const bindingKey = integrationManagerStateKey(workspaceId);
  const stored = await state.get(bindingKey);
  const binding = bindingOrDefault(stored, workspaceId);
  if (binding.revision !== input.expectedRevision) throw new Error("Integration Manager selection changed. Refresh before saving.");
  if (input.agentId !== null) {
    // The Lead binding is a separate CAS key; this guard is not a cross-key transaction.
    const leadRaw = await state.get({ ...bindingKey, stateKey: "lead-agent.v1" });
    if (leadRaw !== null && parseLeadAgentBinding(leadRaw, workspaceId).selectedAgentId === input.agentId) {
      throw new Error("The current Lead Agent cannot also be the Integration Manager.");
    }
    const rows = await context.agents.list({ companyId: workspaceId, limit: 100 });
    if (!Array.isArray(rows) || rows.length > 100) throw new TypeError("Invalid Host Agent list.");
    const candidates = rows.map(row => jsonSafeAgent(row, workspaceId));
    if (new Set(candidates.map(agent => agent.id)).size !== candidates.length) throw new TypeError("Duplicate Host Agent entry.");
    const agent = candidates.find(candidate => candidate.id === input.agentId);
    if (!agent || !["paused", "idle", "running"].includes(agent.status)) {
      throw new Error("Select an available Agent from this Workspace.");
    }
  }
  if (binding.selectedAgentId === input.agentId && (input.agentId !== null || binding.revision > 0)) {
    return { saved: true, executionStarted: false, revision: binding.revision };
  }
  if (typeof state.compareAndSet !== "function") throw new Error("Unsupported Host: atomic state.compareAndSet is required to select an Integration Manager.");
  const updated = { schemaVersion: 1, workspaceId, revision: binding.revision + 1, selectedAgentId: input.agentId };
  const receipt = await state.compareAndSet(bindingKey, stored === null ? { exists: false } : { exists: true, value: stored }, updated);
  const descriptor = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    && Object.getPrototypeOf(receipt) === Object.prototype && Reflect.ownKeys(receipt).length === 1
    && Reflect.ownKeys(receipt)[0] === "swapped" ? Object.getOwnPropertyDescriptor(receipt, "swapped") : undefined;
  if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "boolean") {
    throw new TypeError("Invalid Host state.compareAndSet receipt.");
  }
  if (!descriptor.value) throw new Error("Integration Manager selection changed. Refresh before saving.");
  return { saved: true, executionStarted: false, revision: updated.revision };
}

export async function prepareIntegrationManager(workspaceId: string, params: unknown, context: SpsActionContext) {
  const input = exactRecord(params, ["projectId", "expectedManagerRevision"]);
  if (!isBuilderProjectId(workspaceId) || context.companyId !== workspaceId || context.actor.type !== "user"
    || context.actor.companyId !== workspaceId || !context.actor.userId?.trim()) throw new Error("An authenticated Workspace user action is required.");
  if (!isBuilderProjectId(input.projectId) || input.projectId !== workspaceId
    || !Number.isSafeInteger(input.expectedManagerRevision) || (input.expectedManagerRevision as number) < 0) {
    throw new TypeError("Integration Manager preparation requires the authenticated Workspace project and current selection revision.");
  }
  const publicAgents: IntegrationManagerProfilePreparationScope["agents"] = {
    list: async input => {
      const rows = await context.agents.list(input);
      if (!Array.isArray(rows) || rows.length > 100) throw new TypeError("Invalid Host Agent list for Manager preparation.");
      return rows.map(row => {
        if (typeof row.id !== "string" || !UUID.test(row.id) || row.companyId !== workspaceId
          || row.status !== undefined && typeof row.status !== "string") {
          throw new TypeError("Invalid or cross-Workspace Host Agent list entry for Manager preparation.");
        }
        return { id: row.id, companyId: workspaceId,
          ...(typeof row.status === "string" ? { status: row.status } : {}) };
      });
    },
    describeExecution: context.agents.describeExecution.bind(context.agents),
    sessions: { ensure: context.agents.sessions.ensure.bind(context.agents.sessions) },
  };
  let ownedValue: unknown;
  try { ownedValue = Reflect.get(context.agents, "owned"); } catch { /* Missing or unreadable optional Host extension. */ }
  if (ownedValue !== null && typeof ownedValue === "object" && !Array.isArray(ownedValue)) {
    try {
      const get = Reflect.get(ownedValue, "get");
      const ensure = Reflect.get(ownedValue, "ensure");
      if (typeof get === "function" && typeof ensure === "function") {
        Object.assign(publicAgents, { owned: { get: get.bind(ownedValue), ensure: ensure.bind(ownedValue) } });
      }
    } catch { /* Optional extension is unavailable; the helper returns UNKNOWN when needed. */ }
  }
  return ensureIntegrationManagerDefaultProfile(input, {
    ...context,
    projectId: workspaceId,
    agents: publicAgents,
    assertCurrentInvocation: async (currentWorkspaceId: string) => {
      if (currentWorkspaceId !== workspaceId || context.companyId !== workspaceId
        || context.actor.type !== "user" || context.actor.companyId !== workspaceId) {
        throw new Error("The authenticated Integration Manager scope changed.");
      }
    },
  });
}
