import type { BuilderLeadAgentOptions } from "./model.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function parseLeadAgentBinding(value: unknown, workspaceId: string): Omit<BuilderLeadAgentOptions, "agents"> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "revision,selectedAgentId,workspaceId") {
    throw new TypeError("Invalid Builder Lead Agent binding.");
  }
  const binding = value as Record<string, unknown>;
  if (binding.workspaceId !== workspaceId || !UUID.test(workspaceId)
    || !Number.isSafeInteger(binding.revision) || (binding.revision as number) < 0
    || binding.selectedAgentId !== null && (typeof binding.selectedAgentId !== "string" || !UUID.test(binding.selectedAgentId))) {
    throw new TypeError("Invalid or cross-Workspace Lead Agent binding.");
  }
  return { workspaceId, revision: binding.revision as number, selectedAgentId: binding.selectedAgentId as string | null };
}

export function parseLeadAgentOptions(value: unknown, workspaceId: string): BuilderLeadAgentOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "agents,revision,selectedAgentId,workspaceId") {
    throw new TypeError("Invalid Lead Agent options.");
  }
  const { agents, ...binding } = value as Record<string, unknown>;
  const parsed = parseLeadAgentBinding(binding, workspaceId);
  if (!Array.isArray(agents) || agents.length > 100) throw new TypeError("Invalid Lead Agent list.");
  const seen = new Set<string>();
  const options = agents.map(value => {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "id,name,status"
      || typeof value.id !== "string" || !UUID.test(value.id) || seen.has(value.id)
      || typeof value.name !== "string" || !value.name.trim() || value.name.length > 500
      || typeof value.status !== "string" || !/^[a-z_]{1,80}$/.test(value.status)) {
      throw new TypeError("Invalid Lead Agent list entry.");
    }
    seen.add(value.id);
    return { id: value.id, name: value.name, status: value.status };
  });
  return { ...parsed, agents: options };
}
