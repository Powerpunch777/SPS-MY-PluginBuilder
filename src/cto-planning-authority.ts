import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { resolveCtoDeliveryRun, workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { readPinnedWorkstreamSources, readWorkstreams, resolveCtoAuthority } from "./workstream-tools.ts";
import { parseLeadToolContext } from "./lead-tool-authority.ts";
import type { RevisionState } from "./solution-revision-store.ts";

/** Shared authorization for private CTO notes and explicit question proposals. */
export async function resolveCtoPlanningAuthority(projectId: string, ctoId: string, workstreamId: string,
  runContext: unknown, platform: SpsPlatformInvocationContext, toolName: string) {
  const context = parseLeadToolContext(runContext);
  const identity = await resolveCtoAuthority(projectId, ctoId, context, platform);
  const delivery = await resolveCtoDeliveryRun(context, projectId, ctoId, workstreamId, platform);
  if (!delivery || !delivery.executionPolicy.toolNames.some(name => name === toolName)) {
    throw new Error("CTO planning requires an explicitly permitted Core-bound delivery; no legacy fallback.");
  }
  const source = Object.freeze({ requestId: delivery.requestId, workstreamId,
    specRevision: delivery.instruction.spec.revision, sha256: workstreamInstructionDigest(delivery.instruction) });
  const check = async () => {
    await identity.check();
    const current = await resolveCtoDeliveryRun(context, projectId, ctoId, workstreamId, platform);
    if (!current || current.requestId !== source.requestId || workstreamInstructionDigest(current.instruction) !== source.sha256
      || !current.executionPolicy.toolNames.some(name => name === toolName)) throw new Error("CTO planning delivery authority changed.");
    const board = await readWorkstreams(context.companyId, projectId, platform);
    const assigned = board?.revision.workstreams.find(row => row.spec.id === workstreamId);
    if (!assigned || assigned.spec.assignedCtoId !== ctoId || assigned.ctoAgentId !== context.agentId
      || assigned.ctoSessionId !== context.sessionId) throw new Error("The Workstream is no longer assigned to this CTO.");
    const run = await platform.agents.sessions.getRun(context.sessionId, context.companyId, context.runId);
    if (run.runId !== context.runId || run.status !== "running" || run.cancellationRequested || run.termination !== "not_applicable") {
      throw new Error("CTO planning requires the active uncancelled Core run.");
    }
    await identity.check();
  };
  await check();
  const sources = await readPinnedWorkstreamSources(context.companyId, projectId, delivery.instruction, platform);
  await check();
  const state: RevisionState = {
    get: async key => { await check(); const value = await platform.state.get(key); await check(); return value; },
    compareAndSet: platform.state.compareAndSet ? async (...args) => {
      await check(); const value = await platform.state.compareAndSet!(...args); await check(); return value;
    } : undefined,
  };
  return { context, source, delivery, sources, check, state };
}
