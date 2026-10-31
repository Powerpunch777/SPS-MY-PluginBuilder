import { randomUUID } from "node:crypto";
import { defineSpsPlatformContract } from "@sonparkserver/plugin-sdk/platform";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { BuilderSnapshot } from "./domain/model.ts";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "./domain/snapshot.ts";

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

export function createBuilderPlatform() {
  return defineSpsPlatformContract({
    capabilities: ["plugin.state.read", "plugin.state.write"],
    data: [{ key: "builder.snapshot", handler: async (params, platform) =>
      await readBuilderSnapshot(workspaceId(params.companyId), platform) as unknown as JsonValue }],
    actions: [{ key: "builder.import-consultation", handler: async (params, context) => {
      if (context.actor.type !== "user" || context.actor.companyId !== context.companyId) {
        throw new Error("Selected consultation input requires an authenticated user action.");
      }
      return importConsultation(context.companyId, params, context);
    } }],
  });
}
