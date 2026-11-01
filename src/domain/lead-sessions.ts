import type { BuilderLeadSessions } from "./model.ts";

export const LEAD_CHANNELS = ["main", "cto-inbox", "decisions"] as const;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid Lead session record.");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError("Invalid Lead session fields.");
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError("Invalid Lead session field.");
    result[key] = field.value;
  }
  return result;
}

export function parseLeadSessions(value: unknown, workspaceId: string): BuilderLeadSessions {
  const row = record(value, ["workspaceId", "selectionRevision", "agentId", "sessions"]);
  if (!UUID.test(workspaceId) || row.workspaceId !== workspaceId
    || !Number.isSafeInteger(row.selectionRevision) || (row.selectionRevision as number) < 0
    || row.agentId !== null && (typeof row.agentId !== "string" || !UUID.test(row.agentId))) {
    throw new TypeError("Invalid or cross-Workspace Lead sessions.");
  }
  const channels = record(row.sessions, LEAD_CHANNELS);
  const seen = new Set<string>();
  for (const channel of LEAD_CHANNELS) {
    const id = channels[channel];
    if (id === null) continue;
    if (row.agentId === null || typeof id !== "string" || !UUID.test(id) || seen.has(id.toLowerCase())) {
      throw new TypeError("Invalid or duplicate Lead session ID.");
    }
    seen.add(id.toLowerCase());
  }
  return { workspaceId, selectionRevision: row.selectionRevision as number, agentId: row.agentId as string | null,
    sessions: Object.fromEntries(LEAD_CHANNELS.map(channel => [channel, channels[channel]])) as BuilderLeadSessions["sessions"] };
}
