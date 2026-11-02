import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseLeadAgentBinding } from "./domain/lead-agent.ts";
import { LEAD_CHANNELS, parseLeadSessions } from "./domain/lead-sessions.ts";

export function exactToolRecord(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid Builder tool input.");
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key))
    || keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) {
    throw new TypeError("Invalid Builder tool fields.");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid Builder tool field.");
    result[key] = descriptor.value;
  }
  return result;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function parseLeadToolContext(value: unknown) {
  const row = exactToolRecord(value, ["companyId", "agentId", "runId", "sessionId"], ["projectId"]);
  if (Object.values(row).some(id => typeof id !== "string" || !UUID.test(id))) {
    throw new TypeError("A verified current Host Agent run/session context is required.");
  }
  return Object.freeze({ companyId: row.companyId as string, agentId: row.agentId as string,
    runId: row.runId as string, sessionId: row.sessionId as string,
    ...(row.projectId === undefined ? {} : { projectId: row.projectId as string }) });
}

export async function resolveLeadToolAuthority(context: ReturnType<typeof parseLeadToolContext>, platform: SpsPlatformInvocationContext) {
  const key = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: context.companyId,
    namespace: "sonpark.my-builder", stateKey });
  const readBinding = async () => {
    const raw = await platform.state.get(key("lead-agent.v1"));
    return parseLeadAgentBinding(raw ?? { workspaceId: context.companyId, revision: 0, selectedAgentId: null }, context.companyId);
  };
  const binding = await readBinding();
  if (!binding.selectedAgentId || binding.selectedAgentId !== context.agentId) {
    throw new Error("Only the current Builder Lead may use this tool.");
  }
  const readSessions = async () => {
    const raw = await platform.state.get(key(`lead-sessions.v1.${binding.revision}`));
    const sessions = parseLeadSessions(raw ?? { workspaceId: context.companyId, selectionRevision: binding.revision,
      agentId: binding.selectedAgentId, sessions: { main: null, "cto-inbox": null, decisions: null } }, context.companyId);
    if (sessions.selectionRevision !== binding.revision || sessions.agentId !== context.agentId) {
      throw new Error("Lead session selection does not match the saved Agent.");
    }
    return sessions;
  };
  const sessions = await readSessions();
  if (!LEAD_CHANNELS.some(channel => sessions.sessions[channel] === context.sessionId)) {
    throw new Error("The tool requires a prepared current Lead session.");
  }
  const check = async () => {
    const latest = await readBinding();
    if (latest.revision !== binding.revision || latest.selectedAgentId !== binding.selectedAgentId) {
      throw new Error("Lead Agent selection changed. Refresh without automatically retrying.");
    }
    const current = await readSessions();
    if (LEAD_CHANNELS.some(channel => current.sessions[channel] !== sessions.sessions[channel])) {
      throw new Error("Lead tool session authority changed.");
    }
  };
  return Object.freeze({ context, selectionRevision: binding.revision, sessions, check });
}
