import { randomUUID } from "node:crypto";
import { defineSpsPlatformContract } from "@sonparkserver/plugin-sdk/platform";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { BuilderSnapshot, BuilderLeadSessions } from "./domain/model.ts";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "./domain/snapshot.ts";
import { parseLeadAgentBinding, parseLeadAgentOptions } from "./domain/lead-agent.ts";
import { LEAD_CHANNELS, parseLeadSessions } from "./domain/lead-sessions.ts";
import type { LeadChannel } from "./domain/model.ts";
import { createLeadConversationStore } from "./lead-conversations.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_IMPORT_REQUEST_BYTES = 48 * 1024;
const MAX_INITIAL_SNAPSHOT_BYTES = 192 * 1024;
const queues = new Map<string, Promise<unknown>>();

function workspaceId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError("A trusted SPS Workspace is required.");
  return value;
}

function key(companyId: string) {
  return { scopeKind: "company" as const, scopeId: workspaceId(companyId), namespace: "sonpark.my-builder", stateKey: "snapshot.v1" };
}

export async function readBuilderSnapshot(companyId: string, platform: SpsPlatformInvocationContext): Promise<BuilderSnapshot> {
  const value = await platform.state.get(key(companyId));
  return value === null ? createEmptyBuilderSnapshot(companyId) : parseBuilderSnapshot(value, companyId);
}

// A dedicated Core Workspace Worker owns writes. This serializes its handlers;
// it is not a cross-process database transaction or a replacement execution queue.
async function serialize<T>(companyId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(companyId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(companyId, current);
  try { return await current; } finally { if (queues.get(companyId) === current) queues.delete(companyId); }
}

export async function importConsultation(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  if (Object.keys(params).sort().join(",") !== "requestId,text" || typeof params.requestId !== "string"
    || !UUID.test(params.requestId) || typeof params.text !== "string" || !params.text.trim()
    || Buffer.byteLength(JSON.stringify(params), "utf8") > MAX_IMPORT_REQUEST_BYTES) {
    throw new TypeError("Consultation import requires one request ID and selected text within a 48 KiB request.");
  }
  const requestId = params.requestId;
  const text = params.text;
  return serialize(companyId, async () => {
    const snapshot = await readBuilderSnapshot(companyId, platform);
    const messageId = `consultation-${requestId}`;
    const existing = snapshot.messages.find(message => message.id === messageId);
    if (existing) {
      if (existing.text !== text || existing.role !== "user" || existing.channel !== "main") {
        throw new Error("The import request ID already refers to different input.");
      }
      return { saved: true, analysisStarted: false, revision: snapshot.revision };
    }
    const now = new Date().toISOString();
    snapshot.messages.push({ id: messageId, channel: "main", actorId: null, role: "user", text, createdAt: now, runId: null });
    snapshot.activity.push({ id: randomUUID(), actorId: null, label: "Consultation text imported", createdAt: now, evidenceRef: null });
    snapshot.revision += 1;
    const validated = parseBuilderSnapshot(snapshot, companyId);
    // Keep this initial record readable through bounded Native UI responses.
    // Paginated conversations/revisions replace this record before AI execution.
    if (Buffer.byteLength(JSON.stringify(validated), "utf8") > MAX_INITIAL_SNAPSHOT_BYTES) {
      throw new TypeError("The initial Builder record is full; existing input has not been changed.");
    }
    await platform.state.set(key(companyId), validated as unknown as JsonValue);
    return { saved: true, analysisStarted: false, revision: validated.revision };
  });
}

function leadAgentKey(companyId: string) {
  return { ...key(companyId), stateKey: "lead-agent.v1" };
}

async function readLeadAgentBinding(companyId: string, platform: SpsPlatformInvocationContext) {
  const value = await platform.state.get(leadAgentKey(companyId));
  return parseLeadAgentBinding(value === null ? { workspaceId: companyId, revision: 0, selectedAgentId: null } : value, companyId);
}

export async function readLeadAgentOptions(companyId: string, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  const binding = await readLeadAgentBinding(companyId, platform);
  const rows = await platform.agents.list({ companyId, limit: 100 });
  if (!Array.isArray(rows) || rows.length > 100) throw new TypeError("Invalid Host Agent list.");
  const agents = rows.map(row => {
    if (!row || row.companyId !== companyId) throw new TypeError("Host Agent belongs to a different Workspace.");
    // Never return adapter configuration, credentials or filesystem paths to UI.
    return { id: row.id, name: row.name, status: row.status };
  });
  return parseLeadAgentOptions({ ...binding, agents }, companyId);
}

export async function selectLeadAgent(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  if (Object.keys(params).sort().join(",") !== "agentId,expectedRevision"
    || params.agentId !== null && (typeof params.agentId !== "string" || !UUID.test(params.agentId))
    || !Number.isSafeInteger(params.expectedRevision) || (params.expectedRevision as number) < 0) {
    throw new TypeError("Lead Agent selection requires an Agent ID and the displayed revision.");
  }
  return serialize(companyId, async () => {
    const stored = await platform.state.get(leadAgentKey(companyId));
    const current = parseLeadAgentBinding(stored === null
      ? { workspaceId: companyId, revision: 0, selectedAgentId: null }
      : stored, companyId);
    if (current.revision !== params.expectedRevision) throw new Error("Lead Agent selection changed. Refresh before saving.");
    if (params.agentId !== null) {
      const options = await readLeadAgentOptions(companyId, platform);
      const agent = options.agents.find(agent => agent.id === params.agentId);
      if (!agent || !["idle", "running"].includes(agent.status)) throw new Error("Select an available Agent from this Workspace.");
    }
    if (current.selectedAgentId === params.agentId) return { saved: true, executionStarted: false, revision: current.revision };
    const updated = parseLeadAgentBinding({ ...current, selectedAgentId: params.agentId, revision: current.revision + 1 }, companyId);
    const state = platform.state as typeof platform.state & {
      compareAndSet?: (key: ReturnType<typeof leadAgentKey>, expected: { exists: false } | { exists: true; value: JsonValue },
        value: JsonValue) => Promise<unknown>;
    };
    if (!("compareAndSet" in platform.state) || typeof state.compareAndSet !== "function") {
      throw new Error("Unsupported Host: atomic state.compareAndSet is required to select a Lead Agent.");
    }
    const receipt = await state.compareAndSet(leadAgentKey(companyId), stored === null
      ? { exists: false }
      : { exists: true, value: stored }, updated as unknown as JsonValue);
    const receiptDescriptor = receipt && typeof receipt === "object" && !Array.isArray(receipt)
      && Object.getPrototypeOf(receipt) === Object.prototype && Reflect.ownKeys(receipt).length === 1
      && Reflect.ownKeys(receipt)[0] === "swapped"
      ? Object.getOwnPropertyDescriptor(receipt, "swapped")
      : undefined;
    if (!receiptDescriptor || !receiptDescriptor.enumerable || !("value" in receiptDescriptor)
      || typeof receiptDescriptor.value !== "boolean") {
      throw new TypeError("Invalid Host state.compareAndSet receipt.");
    }
    if (!receiptDescriptor.value) {
      throw new Error("Lead Agent selection changed. Refresh before saving.");
    }
    return { saved: true, executionStarted: false, revision: updated.revision };
  });
}

async function leadSessionsFor(companyId: string, binding: Awaited<ReturnType<typeof readLeadAgentBinding>>,
  platform: SpsPlatformInvocationContext): Promise<BuilderLeadSessions> {
  const stored = binding.selectedAgentId === null ? null : await platform.state.get({
    ...key(companyId), stateKey: `lead-sessions.v1.${binding.revision}`,
  });
  const value = parseLeadSessions(stored ?? { workspaceId: companyId, selectionRevision: binding.revision,
    agentId: binding.selectedAgentId, sessions: { main: null, "cto-inbox": null, decisions: null } }, companyId);
  if (value.selectionRevision !== binding.revision || value.agentId !== binding.selectedAgentId) {
    throw new Error("Lead session selection does not match the saved Agent.");
  }
  return value;
}

async function assertLeadSelection(companyId: string, binding: Awaited<ReturnType<typeof readLeadAgentBinding>>,
  platform: SpsPlatformInvocationContext) {
  const current = await readLeadAgentBinding(companyId, platform);
  if (current.revision !== binding.revision || current.selectedAgentId !== binding.selectedAgentId) {
    throw new Error("Lead Agent selection changed. Refresh before preparing sessions.");
  }
}

export async function readLeadSessions(companyId: string, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  const binding = await readLeadAgentBinding(companyId, platform);
  const result = await leadSessionsFor(companyId, binding, platform);
  await assertLeadSelection(companyId, binding, platform);
  return result;
}

export async function prepareLeadSessions(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  if (Object.keys(params).sort().join(",") !== "agentId,expectedRevision"
    || typeof params.agentId !== "string" || !UUID.test(params.agentId)
    || !Number.isSafeInteger(params.expectedRevision) || (params.expectedRevision as number) < 0) {
    throw new TypeError("Lead session preparation requires the displayed Agent selection.");
  }
  return serialize(companyId, async () => {
    const binding = await readLeadAgentBinding(companyId, platform);
    if (binding.revision !== params.expectedRevision || binding.selectedAgentId !== params.agentId) {
      throw new Error("Lead Agent selection changed. Refresh before preparing sessions.");
    }
    const options = await readLeadAgentOptions(companyId, platform);
    if (!options.agents.some(agent => agent.id === params.agentId && ["idle", "running"].includes(agent.status))) {
      throw new Error("Select an available Agent from this Workspace.");
    }
    let current = await leadSessionsFor(companyId, binding, platform);
    const stateKey = { ...key(companyId), stateKey: `lead-sessions.v1.${binding.revision}` };
    for (const channel of LEAD_CHANNELS) {
      await assertLeadSelection(companyId, binding, platform);
      const knownId = current.sessions[channel];
      // Core owns atomic key recovery; never emulate ensure with create/list or send.
      const result = await platform.agents.sessions.ensure(params.agentId as string, companyId, {
        taskKey: `plugin:com.sonparkserver.my-plugin-builder:session:lead:${binding.revision}:${channel}`,
        ...(knownId === null ? {} : { expectedSessionId: knownId }),
      });
      if (!result || Object.keys(result).sort().join(",") !== "created,sessionId" || typeof result.created !== "boolean"
        || typeof result.sessionId !== "string" || !UUID.test(result.sessionId)
        || knownId !== null && (result.sessionId !== knownId || result.created !== false)) throw new Error("Invalid Host session ensure result.");
      await assertLeadSelection(companyId, binding, platform);
      const updated = parseLeadSessions({ ...current, sessions: { ...current.sessions, [channel]: result.sessionId } }, companyId);
      if (knownId === null) await platform.state.set(stateKey, updated as unknown as JsonValue);
      current = updated;
    }
    await assertLeadSelection(companyId, binding, platform);
    return { saved: true, executionStarted: false, sessionsReady: true };
  });
}

function conversationInput(params: Record<string, unknown>, extra: readonly string[] = []) {
  const keys = ["channel", ...extra];
  if (Object.keys(params).sort().join(",") !== [...keys].sort().join(",")
    || typeof params.channel !== "string" || !LEAD_CHANNELS.includes(params.channel as LeadChannel)) {
    throw new TypeError("Lead conversation requires a supported channel and exact fields.");
  }
  return params.channel as LeadChannel;
}

async function withConversation<T>(companyId: string, platform: SpsPlatformInvocationContext,
  action: (store: ReturnType<typeof createLeadConversationStore>) => Promise<T>) {
  workspaceId(companyId);
  return serialize(companyId, async () => {
    const binding = await readLeadAgentBinding(companyId, platform);
    const sessions = await leadSessionsFor(companyId, binding, platform);
    const check = async () => {
      await assertLeadSelection(companyId, binding, platform);
      const current = await leadSessionsFor(companyId, binding, platform);
      if (LEAD_CHANNELS.some(channel => current.sessions[channel] !== sessions.sessions[channel])) {
        throw new Error("Lead session binding changed. Refresh without automatically resending.");
      }
    };
    await check();
    const beforeDispatch = async () => {
      await check();
      const options = await readLeadAgentOptions(companyId, platform);
      if (!options.agents.some(agent => agent.id === binding.selectedAgentId && ["idle", "running"].includes(agent.status))) {
        throw new Error("The selected Lead Agent is unavailable. Existing history has been kept.");
      }
      await check();
    };
    return action(createLeadConversationStore(platform, sessions, check, beforeDispatch));
  });
}

export async function readLeadConversation(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params, ["cursor"]);
  if (params.cursor !== null && (typeof params.cursor !== "string" || !UUID.test(params.cursor))) throw new TypeError("Invalid conversation cursor.");
  return withConversation(companyId, platform, store => store.page(channel, params.cursor as string | null));
}
export async function sendLeadMessage(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params, ["requestId", "text"]);
  if (channel === "cto-inbox") throw new Error("The internal Lead intake channel does not accept user messages.");
  if (typeof params.requestId !== "string" || !UUID.test(params.requestId) || typeof params.text !== "string") throw new TypeError("Invalid Lead message.");
  return withConversation(companyId, platform, store => store.send(channel, params.requestId as string, params.text as string));
}
export async function refreshLeadConversation(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params);
  return withConversation(companyId, platform, store => store.refresh(channel));
}
export async function cancelLeadMessage(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params);
  return withConversation(companyId, platform, store => store.cancel(channel));
}
export async function resumePreparedLeadMessage(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params, ["requestId"]);
  if (channel === "cto-inbox" || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new TypeError("Invalid prepared message.");
  return withConversation(companyId, platform, store => store.resumePrepared(channel, params.requestId as string));
}

function userActionInput(params: Record<string, unknown>, context: { companyId: string; actor: { type: string; companyId: string } }) {
  if (context.actor.type !== "user" || context.actor.companyId !== context.companyId) {
    throw new Error("Builder settings and input require an authenticated user action.");
  }
  if (Object.hasOwn(params, "companyId") && params.companyId !== context.companyId) {
    throw new Error("Action metadata must match the trusted Workspace.");
  }
  const input = { ...params };
  delete input.companyId;
  return input;
}

export function createBuilderPlatform() {
  return defineSpsPlatformContract({
    capabilities: ["plugin.state.read", "plugin.state.write", "agents.read", "agent.sessions.create",
      "agent.sessions.send", "agent.sessions.read", "agent.sessions.cancel"],
    data: [{ key: "builder.snapshot", handler: async (params, platform) =>
      await readBuilderSnapshot(workspaceId(params.companyId), platform) as unknown as JsonValue },
    { key: "builder.lead-agents", handler: async (params, platform) =>
      await readLeadAgentOptions(workspaceId(params.companyId), platform) as unknown as JsonValue },
    { key: "builder.lead-sessions", handler: async (params, platform) =>
      await readLeadSessions(workspaceId(params.companyId), platform) as unknown as JsonValue },
    { key: "builder.lead-conversation", handler: async (params, platform) => {
      // renderEnvironment is Host UI envelope metadata, not conversation input
      // or authority. It must not enter the strict domain payload or storage.
      const { companyId, renderEnvironment: _renderEnvironment, ...input } = params;
      return await readLeadConversation(workspaceId(companyId), input, platform) as unknown as JsonValue;
    } }],
    actions: [{ key: "builder.import-consultation", handler: async (params, context) => {
      // Core includes its authorized companyId in action parameters. It is
      // envelope metadata, never a user-selected destination or domain field.
      return importConsultation(context.companyId, userActionInput(params, context), context);
    } }, { key: "builder.select-lead-agent", handler: async (params, context) =>
      selectLeadAgent(context.companyId, userActionInput(params, context), context) },
    { key: "builder.prepare-lead-sessions", handler: async (params, context) =>
      prepareLeadSessions(context.companyId, userActionInput(params, context), context) },
    { key: "builder.send-lead-message", handler: async (params, context) =>
      sendLeadMessage(context.companyId, userActionInput(params, context), context) },
    { key: "builder.refresh-lead-conversation", handler: async (params, context) =>
      refreshLeadConversation(context.companyId, userActionInput(params, context), context) },
    { key: "builder.cancel-lead-message", handler: async (params, context) =>
      cancelLeadMessage(context.companyId, userActionInput(params, context), context) },
    { key: "builder.resume-prepared-lead-message", handler: async (params, context) =>
      resumePreparedLeadMessage(context.companyId, userActionInput(params, context), context) }],
  });
}
