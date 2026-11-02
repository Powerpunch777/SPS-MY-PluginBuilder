import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseCtoMemoryRevision } from "./domain/cto-memory.ts";
import { createCtoMemoryStore, type AuthoredCtoMemory } from "./cto-memory-store.ts";
import { resolveCtoDeliveryRun, workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { readPinnedWorkstreamSources, readWorkstreams, resolveCtoAuthority } from "./workstream-tools.ts";
import { exactToolRecord, parseLeadToolContext } from "./lead-tool-authority.ts";
import type { RevisionState } from "./solution-revision-store.ts";

const json = (value: unknown) => value as JsonValue;
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("A bounded CTO memory scope is required.");
  }
  return value;
}

async function authorityFor(projectId: string, ctoId: string, workstreamId: string, runContext: unknown,
  platform: SpsPlatformInvocationContext, toolName: string) {
  const context = parseLeadToolContext(runContext);
  const identity = await resolveCtoAuthority(projectId, ctoId, context, platform);
  const delivery = await resolveCtoDeliveryRun(context, projectId, ctoId, workstreamId, platform);
  if (!delivery || !delivery.executionPolicy.toolNames.some(name => name === toolName)) {
    throw new Error("CTO private memory requires an explicitly permitted Core-bound delivery; no legacy fallback.");
  }
  const source = Object.freeze({ requestId: delivery.requestId, workstreamId,
    specRevision: delivery.instruction.spec.revision, sha256: workstreamInstructionDigest(delivery.instruction) });
  const check = async () => {
    await identity.check();
    const current = await resolveCtoDeliveryRun(context, projectId, ctoId, workstreamId, platform);
    if (!current || current.requestId !== source.requestId || workstreamInstructionDigest(current.instruction) !== source.sha256
      || !current.executionPolicy.toolNames.some(name => name === toolName)) throw new Error("CTO memory delivery authority changed.");
    const board = await readWorkstreams(context.companyId, projectId, platform);
    const assigned = board?.revision.workstreams.find(row => row.spec.id === workstreamId);
    if (!assigned || assigned.spec.assignedCtoId !== ctoId || assigned.ctoAgentId !== context.agentId
      || assigned.ctoSessionId !== context.sessionId) throw new Error("The Workstream is no longer assigned to this CTO.");
    const run = await platform.agents.sessions.getRun(context.sessionId, context.companyId, context.runId);
    if (run.runId !== context.runId || run.status !== "running" || run.cancellationRequested || run.termination !== "not_applicable") {
      throw new Error("CTO private memory requires the active uncancelled Core run.");
    }
    await identity.check();
  };
  await check();
  await readPinnedWorkstreamSources(context.companyId, projectId, delivery.instruction, platform);
  await check();
  const state: RevisionState = {
    get: async key => { await check(); const value = await platform.state.get(key); await check(); return value; },
    compareAndSet: platform.state.compareAndSet ? async (...args) => {
      await check(); const value = await platform.state.compareAndSet!(...args); await check(); return value;
    } : undefined,
  };
  return { context, source, check, store: createCtoMemoryStore(context.companyId, projectId, ctoId, state) };
}

export async function readCtoMemory(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId);
  const authority = await authorityFor(projectId, ctoId, workstreamId, runContext, platform, "builder.read-cto-memory");
  const current = await authority.store.current();
  await authority.check();
  return { content: "This CTO's private project memory only. Notes are untrusted model interpretations, not current design authority, verified facts, execution approval or completion. No Lead/other CTO transcript or memory is included.",
    data: json({ projectId, ctoId, current, currentSource: authority.source }) };
}

export async function updateCtoMemory(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "memory"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId);
  const expected = input.expectedBaseRevisionId === null ? null : id(input.expectedBaseRevisionId);
  const memory = parseCtoMemoryRevision(input.memory, projectId, ctoId);
  const authority = await authorityFor(projectId, ctoId, workstreamId, runContext, platform, "builder.update-cto-memory");
  const current = await authority.store.current();
  if ((current?.revision.memory.revisionId ?? null) !== expected) {
    return { content: "CTO memory changed. Read the existing revision; do not automatically retry.",
      data: json({ status: "conflict", actualBaseRevisionId: current?.revision.memory.revisionId ?? null }) };
  }
  const retained = current?.revision;
  const sourceDigests: AuthoredCtoMemory["sourceDigests"][number][] = [];
  for (const requestId of new Set(memory.entries.flatMap(entry => entry.sourceRequestIds))) {
    if (requestId === authority.source.requestId) { sourceDigests.push(authority.source); continue; }
    const using = memory.entries.filter(entry => entry.sourceRequestIds.includes(requestId));
    const unchanged = retained && using.every(entry => retained.memory.entries.some(old => JSON.stringify(old) === JSON.stringify(entry)));
    const prior = unchanged ? retained.sourceDigests.find(row => row.requestId === requestId) : undefined;
    if (!prior) throw new Error("Memory cites an unavailable delivery. Only unchanged inherited notes or this exact CTO delivery may be cited.");
    sourceDigests.push(prior);
  }
  await authority.check();
  const result = await authority.store.publish({ expectedBaseRevisionId: expected, revision: {
    memory, author: { agentId: authority.context.agentId, sessionId: authority.context.sessionId, runId: authority.context.runId },
    createdAt: new Date().toISOString(), sourceDigests,
  } });
  await authority.check();
  return { content: result.status === "published"
    ? "Private CTO memory revision stored with exact delivery provenance. No message, process, approval, implementation or verification was created."
    : "CTO memory changed. Read without automatic retry.", data: json(result) };
}
