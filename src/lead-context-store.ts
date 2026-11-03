import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { LEAD_CONTEXTS, type BuilderLeadContexts } from "./domain/lead-contexts.ts";
import { parseLeadContexts } from "./domain/lead-contexts.ts";
import { parseLeadAgentBinding } from "./domain/lead-agent.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";

const key = (workspaceId: string, selectionRevision: number) => ({ scopeKind: "company" as const,
  scopeId: workspaceId, namespace: "sonpark.my-builder", stateKey: `lead-contexts.v2.${selectionRevision}` });
const bindingKey = (workspaceId: string) => ({ scopeKind: "company" as const,
  scopeId: workspaceId, namespace: "sonpark.my-builder", stateKey: "lead-agent.v1" });

async function currentBinding(workspaceId: string, platform: SpsPlatformInvocationContext) {
  const raw = await platform.state.get(bindingKey(workspaceId));
  return parseLeadAgentBinding(raw ?? { workspaceId, revision: 0, selectedAgentId: null }, workspaceId);
}

function checkReceiptIds(record: BuilderLeadContexts, hostIssuedSessionIds: readonly string[]) {
  const expectedIds = LEAD_CONTEXTS.flatMap(context => record.contexts[context] === null ? [] : [record.contexts[context]!]).sort();
  if (!Array.isArray(hostIssuedSessionIds) || hostIssuedSessionIds.length !== expectedIds.length
    || hostIssuedSessionIds.some(id => typeof id !== "string")
    || new Set(hostIssuedSessionIds).size !== expectedIds.length
    || [...hostIssuedSessionIds].sort().some((id, index) => id !== expectedIds[index])) {
    throw new Error("Lead context sessions must match the Host-issued session receipts.");
  }
}

function sameRecord(left: BuilderLeadContexts, right: BuilderLeadContexts): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireForwardProgress(previous: BuilderLeadContexts, next: BuilderLeadContexts): void {
  if (previous.status === "ready") throw new Error("Prepared Lead contexts cannot be replaced or regressed.");
  if (previous.selectionRevision !== next.selectionRevision || previous.agentId !== next.agentId
    || previous.requestId !== next.requestId
    || LEAD_CONTEXTS.some(context => previous.contexts[context] !== null
      && previous.contexts[context] !== next.contexts[context])) {
    throw new Error("Known Lead context session identities cannot be replaced or removed.");
  }
  if (previous.pendingContext === null) {
    throw new Error("A ready context record cannot be advanced.");
  }
  const resolvedPending = next.contexts[previous.pendingContext] !== null;
  if (LEAD_CONTEXTS.some(context => context !== previous.pendingContext
    && previous.contexts[context] !== next.contexts[context])) {
    throw new Error("Only the exact pending Host ensure may add a Lead context session ID.");
  }
  if (!resolvedPending && previous.pendingContext !== next.pendingContext) {
    throw new Error("An unresolved Lead context receipt cannot be abandoned.");
  }
  if (resolvedPending && next.status !== "uncertain") {
    const nextIndex = LEAD_CONTEXTS.indexOf(previous.pendingContext);
    const expectedPending = nextIndex === LEAD_CONTEXTS.length - 1 ? null : LEAD_CONTEXTS[nextIndex + 1]!;
    if (next.pendingContext !== expectedPending) {
      throw new Error("Lead context preparation must advance exactly one Host ensure at a time.");
    }
  }
  if (previous.status === "uncertain" && next.status === "preparing" && !resolvedPending) {
    throw new Error("An uncertain Host ensure cannot return to preparing without its direct Host result.");
  }
  if (next.status === "ready" && (!resolvedPending || next.pendingContext !== null
    || LEAD_CONTEXTS.some(context => next.contexts[context] === null))) {
    throw new Error("Lead contexts cannot become ready without resolving prior preparation progress.");
  }
  if (previous.status === "preparing" && next.status === "ready" && !resolvedPending) {
    throw new Error("Ready publication requires a previously persisted pending ensure result.");
  }
  if (next.status === "uncertain" && (next.pendingContext !== previous.pendingContext || resolvedPending)) {
    throw new Error("Uncertain status must retain the exact unresolved Host ensure.");
  }
  if (next.status === "preparing" && previous.status === "preparing" && !resolvedPending
    && next.pendingContext !== previous.pendingContext) {
    throw new Error("Preparation cannot move past an unresolved Host ensure.");
  }
}

/** Internal only: receipt-ID consistency is not proof of Host receipt provenance.
 * The trusted preparation caller must obtain IDs from the real Host ensure path.
 * Never expose this storage primitive as an action accepting arbitrary IDs. */
async function saveContexts(workspaceId: string, record: BuilderLeadContexts, platform: SpsPlatformInvocationContext) {
  if (typeof platform.state.compareAndSet !== "function") {
    throw new Error("Unsupported Host: atomic state.compareAndSet is required for Lead contexts.");
  }
  const binding = await currentBinding(workspaceId, platform);
  if (!binding.selectedAgentId || record.selectionRevision !== binding.revision || record.agentId !== binding.selectedAgentId) {
    throw new Error("Lead contexts do not match the current Host Lead.");
  }
  const stateKey = key(workspaceId, binding.revision);
  const stored = await platform.state.get(stateKey);
  if (stored !== null) {
    const previous = parseLeadContexts(stored, workspaceId);
    if (sameRecord(previous, record)) {
      await assertCurrent();
      return record;
    }
    requireForwardProgress(previous, record);
  } else if (record.status !== "preparing" || record.pendingContext === null) {
    throw new Error("Lead context preparation must begin with a durable pending Host ensure.");
  }
  await assertCurrent();
  const receipt = exactToolRecord(await platform.state.compareAndSet(stateKey,
    stored === null ? { exists: false } : { exists: true, value: stored }, record as unknown as JsonValue), ["swapped"]);
  if (typeof receipt.swapped !== "boolean") throw new TypeError("Invalid Host conditional state receipt.");
  if (!receipt.swapped) {
    const latest = await platform.state.get(stateKey);
    if (latest === null || !sameRecord(parseLeadContexts(latest, workspaceId), record)) {
      throw new Error("Lead context progress changed concurrently. Refresh without automatically retrying.");
    }
  }
  await assertCurrent();
  return record;

  async function assertCurrent() {
    const latest = await currentBinding(workspaceId, platform);
    if (latest.revision !== binding.revision || latest.selectedAgentId !== binding.selectedAgentId) {
      throw new Error("Lead context selection changed during save.");
    }
  }
}

/** Read a v2 record only under its exact trusted Workspace and current selection. */
export async function readLeadContexts(workspaceId: string, platform: SpsPlatformInvocationContext): Promise<BuilderLeadContexts | null> {
  const binding = await currentBinding(workspaceId, platform);
  if (!binding.selectedAgentId) return null;
  const stored = await platform.state.get(key(workspaceId, binding.revision));
  if (stored === null) return null;
  const record = parseLeadContexts(stored, workspaceId);
  if (record.selectionRevision !== binding.revision || record.agentId !== binding.selectedAgentId) {
    throw new Error("Lead context selection does not match the current Host Lead.");
  }
  const latest = await currentBinding(workspaceId, platform);
  if (latest.revision !== binding.revision || latest.selectedAgentId !== binding.selectedAgentId) {
    throw new Error("Lead context selection changed. Refresh before continuing.");
  }
  return record;
}

/** Persist one explicit, request-keyed v2 start before invoking Host ensure. */
export async function beginLeadContextPreparation(workspaceId: string, agentId: string, selectionRevision: number,
  requestId: string, platform: SpsPlatformInvocationContext): Promise<BuilderLeadContexts> {
  const binding = await currentBinding(workspaceId, platform);
  if (!binding.selectedAgentId || binding.selectedAgentId !== agentId || binding.revision !== selectionRevision) {
    throw new Error("Lead context start does not match the current Host Lead selection.");
  }
  const stateKey = key(workspaceId, selectionRevision);
  const stored = await platform.state.get(stateKey);
  if (stored !== null) {
    const existing = parseLeadContexts(stored, workspaceId);
    if (existing.selectionRevision !== selectionRevision || existing.agentId !== agentId) {
      throw new Error("A different Lead context preparation is already recorded; unresolved work was kept.");
    }
    await assertBinding();
    if (existing.status === "ready") return existing;
    if (existing.requestId !== requestId) {
      throw new Error("A different Lead context preparation is already recorded; unresolved work was kept.");
    }
    return existing;
  }
  if (typeof platform.state.compareAndSet !== "function") {
    throw new Error("Unsupported Host: atomic state.compareAndSet is required for Lead contexts.");
  }
  const initial = parseLeadContexts({ schemaVersion: 2, workspaceId, selectionRevision, agentId, requestId,
    status: "preparing", pendingContext: LEAD_CONTEXTS[0],
    contexts: Object.fromEntries(LEAD_CONTEXTS.map(context => [context, null])) }, workspaceId);
  await assertBinding();
  const receipt = exactToolRecord(await platform.state.compareAndSet(stateKey, { exists: false },
    initial as unknown as JsonValue), ["swapped"]);
  if (typeof receipt.swapped !== "boolean") throw new TypeError("Invalid Host conditional state receipt.");
  if (!receipt.swapped) {
    const latest = await platform.state.get(stateKey);
    if (latest === null || !sameRecord(parseLeadContexts(latest, workspaceId), initial)) {
      throw new Error("Another Lead context start won this selection; inspect its durable request before continuing.");
    }
  }
  await assertBinding();
  return initial;

  async function assertBinding() {
    const latest = await currentBinding(workspaceId, platform);
    if (latest.revision !== binding.revision || latest.selectedAgentId !== binding.selectedAgentId) {
      throw new Error("Lead context selection changed during explicit preparation.");
    }
  }
}

/** Persist resumable v2 progress before/after each Host ensure call. */
export async function writeLeadContextProgress(workspaceId: string, value: unknown,
  hostIssuedSessionIds: readonly string[], platform: SpsPlatformInvocationContext): Promise<BuilderLeadContexts> {
  const record = parseLeadContexts(value, workspaceId);
  if (record.status === "ready") throw new Error("Use complete preparation publication for ready Lead contexts.");
  checkReceiptIds(record, hostIssuedSessionIds);
  return saveContexts(workspaceId, record, platform);
}

/** Internal storage primitive; the caller passes the direct sessionId receipts returned by Host ensure calls. */
export async function writeLeadContexts(workspaceId: string, value: unknown, hostIssuedSessionIds: readonly string[],
  platform: SpsPlatformInvocationContext): Promise<BuilderLeadContexts> {
  const record = parseLeadContexts(value, workspaceId);
  if (record.status !== "ready" || record.pendingContext !== null) throw new Error("Only complete Lead context preparation can be published.");
  checkReceiptIds(record, hostIssuedSessionIds);
  const binding = await currentBinding(workspaceId, platform);
  if (!binding.selectedAgentId || record.selectionRevision !== binding.revision || record.agentId !== binding.selectedAgentId) {
    throw new Error("Lead contexts do not match the current Host Lead.");
  }
  const stored = await platform.state.get(key(workspaceId, record.selectionRevision));
  if (stored === null) throw new Error("Ready Lead contexts require previously persisted preparation progress.");
  const previous = parseLeadContexts(stored, workspaceId);
  if (previous.status === "ready") {
    if (!sameRecord(previous, record)) throw new Error("Prepared Lead contexts cannot be replaced or regressed.");
  } else if (previous.requestId === null || previous.requestId !== record.requestId || previous.pendingContext === null
    || LEAD_CONTEXTS.filter(context => previous.contexts[context] !== null).length !== LEAD_CONTEXTS.length - 1
    || previous.contexts[previous.pendingContext] !== null) {
    throw new Error("Ready publication requires durable prior progress and one exact pending Host ensure.");
  }
  return saveContexts(workspaceId, record, platform);
}

