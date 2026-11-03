/** The v2 logical Lead context index. V1 session records remain independent. */
export const LEAD_CONTEXTS = [
  "user_conversation",
  "ui_design",
  "background_planning",
  "question_intake",
  "question_discussion",
] as const;

export type LeadContextId = typeof LEAD_CONTEXTS[number];

export interface BuilderLeadContexts {
  schemaVersion: 2;
  workspaceId: string;
  selectionRevision: number;
  agentId: string;
  requestId: string | null;
  status: "preparing" | "uncertain" | "ready";
  pendingContext: LeadContextId | null;
  contexts: Record<LeadContextId, string | null>;
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function exactRecord(value: unknown, keys: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`Invalid ${label} record.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (keys.some(key => !Object.hasOwn(value, key))
    || ownKeys.some(key => typeof key !== "string" || ![...keys, ...optional].includes(key))) {
    throw new TypeError(`Invalid ${label} fields.`);
  }
  const result: Record<string, unknown> = {};
  for (const key of [...keys, ...optional].filter(key => Object.hasOwn(value, key))) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError(`Invalid ${label} field.`);
    result[key] = field.value;
  }
  return result;
}

/** Parse v2 preparation progress bound to the Host-selected Workspace. */
export function parseLeadContexts(value: unknown, workspaceId: string): BuilderLeadContexts {
  const row = exactRecord(value, ["schemaVersion", "workspaceId", "selectionRevision", "agentId", "status", "pendingContext", "contexts"],
    "Lead contexts", ["requestId"]);
  if (!UUID.test(workspaceId) || row.schemaVersion !== 2 || row.workspaceId !== workspaceId
    || !Number.isSafeInteger(row.selectionRevision) || (row.selectionRevision as number) < 1
    || typeof row.agentId !== "string" || !UUID.test(row.agentId)
    || row.requestId !== undefined && row.requestId !== null && (typeof row.requestId !== "string" || !UUID.test(row.requestId))
    || !["preparing", "uncertain", "ready"].includes(row.status as string)
    || row.pendingContext !== null && !LEAD_CONTEXTS.includes(row.pendingContext as LeadContextId)) {
    throw new TypeError("Invalid or cross-Workspace Lead contexts.");
  }
  const contexts = exactRecord(row.contexts, LEAD_CONTEXTS, "Lead context mapping");
  const ids = LEAD_CONTEXTS.map(context => contexts[context]);
  const presentIds = ids.filter((id): id is string => typeof id === "string");
  if (ids.some(id => id !== null && (typeof id !== "string" || !UUID.test(id)))
    || new Set(presentIds.map(id => id.toLowerCase())).size !== presentIds.length
    || ["preparing", "uncertain"].includes(row.status as string) && row.pendingContext === null
    || row.status === "ready" && (row.pendingContext !== null || presentIds.length !== LEAD_CONTEXTS.length)) {
    throw new TypeError("Invalid Lead context preparation progress or duplicate session IDs.");
  }
  return {
    schemaVersion: 2,
    workspaceId,
    selectionRevision: row.selectionRevision as number,
    agentId: row.agentId,
    requestId: row.requestId as string | null | undefined ?? null,
    status: row.status as BuilderLeadContexts["status"],
    pendingContext: row.pendingContext as LeadContextId | null,
    contexts: Object.fromEntries(LEAD_CONTEXTS.map(context => [context, contexts[context]])) as Record<LeadContextId, string | null>,
  };
}

/** Match trusted Host invocation metadata; caller-supplied project IDs are irrelevant. */
export function resolveLeadContext(value: unknown, host: { workspaceId: string; agentId: string; sessionId: string },
  current: { selectionRevision: number; agentId: string | null }): LeadContextId {
  const record = parseLeadContexts(value, host.workspaceId);
  if (record.status !== "ready" || record.selectionRevision !== current.selectionRevision || record.agentId !== current.agentId
    || host.agentId !== current.agentId) throw new Error("Lead context binding is stale.");
  const context = LEAD_CONTEXTS.find(candidate => record.contexts[candidate] === host.sessionId);
  if (!context) throw new Error("Host session is not an authorized Lead context.");
  return context;
}

/** Only Main may use existing formal Spec/Graph publication actions. */
export function mayPublishFormalRevision(context: LeadContextId): boolean {
  return context === "user_conversation";
}

