import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseLeadAgentBinding } from "./domain/lead-agent.ts";
import { resolveLeadContext, type LeadContextId } from "./domain/lead-contexts.ts";
import { LEAD_CHANNELS, parseLeadSessions } from "./domain/lead-sessions.ts";
import { readLeadContexts } from "./lead-context-store.ts";

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
  const resolve = async () => {
    const binding = await readBinding();
    if (!binding.selectedAgentId || binding.selectedAgentId !== context.agentId) {
      throw new Error("Only the current Builder Lead may use this tool.");
    }
    const contexts = await readLeadContexts(context.companyId, platform);
    if (contexts !== null) {
      // Once this selection has a v2 record, its five Host identities are the
      // only authority for that selection. An incomplete record must not fall
      // back to a v1 session, and a non-member v1 session must not regain
      // access merely because the v2 record is ready.
      if (contexts.status !== "ready" || !Object.values(contexts.contexts).includes(context.sessionId)) {
        throw new Error("The Host session is not an authorized ready Lead context.");
      }
      const logicalContext = resolveLeadContext(contexts, { workspaceId: context.companyId, agentId: context.agentId,
        sessionId: context.sessionId }, { selectionRevision: binding.revision, agentId: binding.selectedAgentId });
      return { binding, contexts, logicalContext, channel: null, sessions: null };
    }
    const sessions = await readSessions(binding);
    const channel = LEAD_CHANNELS.find(candidate => sessions.sessions[candidate] === context.sessionId);
    if (!channel) throw new Error("The tool requires a prepared current Lead session or context.");
    return { binding, contexts: null, logicalContext: null, channel, sessions };
  };
  const initial = await resolve();
  const check = async () => {
    const latest = await readBinding();
    if (latest.revision !== initial.binding.revision || latest.selectedAgentId !== initial.binding.selectedAgentId) {
      throw new Error("Lead Agent selection changed. Refresh without automatically retrying.");
    }
    const current = await resolve();
    if (current.binding.revision !== initial.binding.revision
      || current.binding.selectedAgentId !== initial.binding.selectedAgentId
      || current.channel !== initial.channel || current.logicalContext !== initial.logicalContext
      || JSON.stringify(current.contexts) !== JSON.stringify(initial.contexts)
      || (initial.sessions === null) !== (current.sessions === null)
      || initial.sessions !== null && current.sessions !== null
        && LEAD_CHANNELS.some(channel => current.sessions!.sessions[channel] !== initial.sessions!.sessions[channel])) {
      throw new Error("Lead tool authority changed. Refresh without automatically retrying.");
    }
  };
  return Object.freeze({ context, selectionRevision: initial.binding.revision, sessions: initial.sessions,
    contexts: initial.contexts,
    conversationSessions: initial.contexts ?? initial.sessions!,
    channel: initial.channel, logicalContext: initial.logicalContext, check });

  async function readSessions(binding: Awaited<ReturnType<typeof readBinding>>) {
    const raw = await platform.state.get(key(`lead-sessions.v1.${binding.revision}`));
    const sessions = parseLeadSessions(raw ?? { workspaceId: context.companyId, selectionRevision: binding.revision,
      agentId: binding.selectedAgentId, sessions: { main: null, "cto-inbox": null, decisions: null } }, context.companyId);
    if (sessions.selectionRevision !== binding.revision || sessions.agentId !== context.agentId) {
      throw new Error("Lead session selection does not match the saved Agent.");
    }
    return sessions;
  }
}

/** Formal specification/Graph, technology and Workstream publication is Main-only for both versions. */
export function requireLeadFormalPublicationAuthority(authority: { channel: string | null; logicalContext: LeadContextId | null }): void {
  if (authority.channel !== "main" && authority.logicalContext !== "user_conversation") {
    throw new Error("Only the Main Lead context may publish formal revisions.");
  }
}
