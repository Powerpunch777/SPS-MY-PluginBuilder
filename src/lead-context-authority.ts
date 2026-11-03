import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseLeadAgentBinding } from "./domain/lead-agent.ts";
import { mayPublishFormalRevision, resolveLeadContext, type LeadContextId } from "./domain/lead-contexts.ts";
import { readLeadContexts } from "./lead-context-store.ts";
import { parseLeadToolContext } from "./lead-tool-authority.ts";

/** Resolve only Host-supplied invocation identity; projectId is never a selector. */
export async function resolveLogicalLeadContext(value: unknown, platform: SpsPlatformInvocationContext) {
  const host = parseLeadToolContext(value);
  const bindingKey = { scopeKind: "company" as const, scopeId: host.companyId,
    namespace: "sonpark.my-builder", stateKey: "lead-agent.v1" };

  async function resolve(): Promise<{ context: LeadContextId; identity: string }> {
    const raw = await platform.state.get(bindingKey);
    const binding = parseLeadAgentBinding(raw ?? { workspaceId: host.companyId, revision: 0, selectedAgentId: null }, host.companyId);
    if (binding.selectedAgentId !== host.agentId) throw new Error("Only the current Host-selected Builder Lead may use this context.");
    const record = await readLeadContexts(host.companyId, platform);
    if (!record) throw new Error("The current Lead context record is unavailable.");
    const context = resolveLeadContext(record, { workspaceId: host.companyId, agentId: host.agentId, sessionId: host.sessionId },
      { selectionRevision: binding.revision, agentId: binding.selectedAgentId });
    const latestRaw = await platform.state.get(bindingKey);
    const latest = parseLeadAgentBinding(latestRaw ?? { workspaceId: host.companyId, revision: 0, selectedAgentId: null }, host.companyId);
    if (latest.revision !== binding.revision || latest.selectedAgentId !== binding.selectedAgentId) {
      throw new Error("Lead context selection changed. Refresh without retrying.");
    }
    return { context, identity: JSON.stringify(record) };
  }

  const initial = await resolve();
  const check = async () => {
    const current = await resolve();
    if (current.context !== initial.context || current.identity !== initial.identity) {
      throw new Error("Lead context authority changed. Refresh without retrying.");
    }
  };
  return Object.freeze({ context: initial.context, mayPublishFormalRevision: mayPublishFormalRevision(initial.context), check });
}

export function requireFormalRevisionAuthority(context: LeadContextId): void {
  if (!mayPublishFormalRevision(context)) throw new Error("Only the Main Lead context may publish a formal Spec or Graph revision.");
}

