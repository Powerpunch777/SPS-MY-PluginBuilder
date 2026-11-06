import { createHash } from "node:crypto";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export const INTEGRATION_MANAGER_OWNED_AGENT_KEY = "integration-manager";
export const INTEGRATION_MANAGER_SESSION_TASK_KEY = "plugin:com.sonparkserver.my-plugin-builder:session:integration-manager";

export const INTEGRATION_MANAGER_DEFAULT_PROFILE = Object.freeze({
  name: "Integration Manager",
  role: "integration-manager",
  instructions: "Integrate verified project work within the approved scope. Preserve source and QA evidence, recheck current revisions and permissions, route technical failures to the responsible CTO and design conflicts to Integration Review. Do not change approved designs or make user-only final delivery decisions.",
} as const);

export type IntegrationManagerBinding = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  revision: number;
  selectedAgentId: string | null;
}>;

export type ManagerDefaultDecision = Readonly<{
  status: "preserved" | "provision";
  reason: "already-configured" | "user-paused" | "default-profile-not-yet-bound";
  selectedAgentId: string | null;
  revision: number;
}>;

export function parseIntegrationManagerBinding(value: unknown, workspaceId: string): IntegrationManagerBinding {
  if (!UUID.test(workspaceId) || !value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Invalid Integration Manager binding.");
  }
  const keys = Reflect.ownKeys(value);
  const fields = ["schemaVersion", "workspaceId", "revision", "selectedAgentId"];
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError("Invalid Integration Manager binding fields.");
  }
  const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid Integration Manager binding data.");
    row[field] = descriptor.value;
  }
  if (row.schemaVersion !== 1 || row.workspaceId !== workspaceId || !Number.isSafeInteger(row.revision)
    || (row.revision as number) < 0 || row.selectedAgentId !== null
      && (typeof row.selectedAgentId !== "string" || !UUID.test(row.selectedAgentId))) {
    throw new TypeError("Invalid or cross-Workspace Integration Manager binding.");
  }
  return Object.freeze({ schemaVersion: 1, workspaceId, revision: row.revision as number,
    selectedAgentId: row.selectedAgentId as string | null });
}

export function decideManagerDefault(binding: IntegrationManagerBinding): ManagerDefaultDecision {
  if (binding.revision > 0 && binding.selectedAgentId !== null) {
    return Object.freeze({ status: "preserved", reason: "already-configured", selectedAgentId: binding.selectedAgentId,
      revision: binding.revision });
  }
  if (binding.revision > 0) {
    return Object.freeze({ status: "preserved", reason: "user-paused", selectedAgentId: null, revision: binding.revision });
  }
  return Object.freeze({ status: "provision", reason: "default-profile-not-yet-bound", selectedAgentId: null, revision: 0 });
}

export function integrationManagerStateKey(workspaceId: string): Readonly<{
  scopeKind: "company"; scopeId: string; namespace: "sonpark.my-builder"; stateKey: string;
}> {
  if (!UUID.test(workspaceId)) throw new TypeError("A valid Workspace is required.");
  return Object.freeze({ scopeKind: "company", scopeId: workspaceId, namespace: "sonpark.my-builder",
    stateKey: "integration-manager-agent.v1" });
}

export function integrationManagerSessionStateKey(workspaceId: string, projectId: string, managerAgentId: string): Readonly<{
  scopeKind: "company"; scopeId: string; namespace: "sonpark.my-builder"; stateKey: string;
}> {
  if (!UUID.test(workspaceId) || !isBuilderProjectId(projectId) || !UUID.test(managerAgentId)) {
    throw new TypeError("A valid Workspace, project, and Manager Agent are required.");
  }
  return Object.freeze({ scopeKind: "company", scopeId: workspaceId, namespace: "sonpark.my-builder",
    stateKey: `integration-manager-session.v1.${createProjectKey(projectId)}.${createAgentKey(managerAgentId)}` });
}

/** Existing project-only binding retained for exact same-Agent adoption; never overwritten or deleted. */
export function legacyIntegrationManagerSessionStateKey(workspaceId: string, projectId: string): Readonly<{
  scopeKind: "company"; scopeId: string; namespace: "sonpark.my-builder"; stateKey: string;
}> {
  if (!UUID.test(workspaceId) || !isBuilderProjectId(projectId)) throw new TypeError("A valid Workspace and project are required.");
  return Object.freeze({ scopeKind: "company", scopeId: workspaceId, namespace: "sonpark.my-builder",
    stateKey: `integration-manager-session.v1.${createProjectKey(projectId)}` });
}

export function integrationManagerSessionTaskKey(workspaceId: string, projectId: string, managerAgentId: string): string {
  if (!UUID.test(workspaceId) || !isBuilderProjectId(projectId) || !UUID.test(managerAgentId)) {
    throw new TypeError("A valid Workspace, project, and Manager Agent are required.");
  }
  return `${INTEGRATION_MANAGER_SESSION_TASK_KEY}:${createHash("sha256")
    .update(`${workspaceId}\0${projectId}\0${managerAgentId}`, "utf8").digest("hex")}`;
}

export function legacyIntegrationManagerSessionTaskKey(workspaceId: string, projectId: string): string {
  if (!UUID.test(workspaceId) || !isBuilderProjectId(projectId)) throw new TypeError("A valid Workspace and project are required.");
  return `${INTEGRATION_MANAGER_SESSION_TASK_KEY}:${createHash("sha256")
    .update(`${workspaceId}\0${projectId}`, "utf8").digest("hex")}`;
}

function createProjectKey(projectId: string): string {
  return createHash("sha256").update(projectId, "utf8").digest("hex");
}

function createAgentKey(agentId: string): string {
  return createHash("sha256").update(agentId, "utf8").digest("hex");
}

export type IntegrationManagerSessionBinding = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  managerAgentId: string;
  sessionId: string;
  taskKey?: string;
}>;

export function parseIntegrationManagerSessionBinding(value: unknown, workspaceId: string, projectId: string): IntegrationManagerSessionBinding {
  if (!UUID.test(workspaceId) || !isBuilderProjectId(projectId) || !value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid Integration Manager session binding.");
  const baseFields = ["schemaVersion", "workspaceId", "projectId", "managerAgentId", "sessionId"];
  const fields = Reflect.ownKeys(value).includes("taskKey") ? [...baseFields, "taskKey"] : baseFields;
  if (Reflect.ownKeys(value).length !== fields.length || Reflect.ownKeys(value).some(key => !fields.includes(String(key)))) {
    throw new TypeError("Invalid Integration Manager session binding fields.");
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || row.workspaceId !== workspaceId || row.projectId !== projectId
    || typeof row.managerAgentId !== "string" || !UUID.test(row.managerAgentId)
    || typeof row.sessionId !== "string" || !UUID.test(row.sessionId)
    || row.taskKey !== undefined && (typeof row.taskKey !== "string"
      || row.taskKey !== integrationManagerSessionTaskKey(workspaceId, projectId, row.managerAgentId as string)
        && row.taskKey !== legacyIntegrationManagerSessionTaskKey(workspaceId, projectId))) {
    throw new TypeError("Invalid or cross-scope Integration Manager session binding.");
  }
  return Object.freeze({ schemaVersion: 1, workspaceId, projectId, managerAgentId: row.managerAgentId, sessionId: row.sessionId,
    ...(typeof row.taskKey === "string" ? { taskKey: row.taskKey } : {}) });
}

export function isBuilderProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID.test(value);
}
