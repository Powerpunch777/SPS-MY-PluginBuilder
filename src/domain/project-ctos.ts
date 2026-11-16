export type ProjectCto = Readonly<{
  ctoId: string;
  displayName: string;
  agentId: string;
  sessionId: string | null;
  status: "AVAILABLE" | "ACTIVE" | "RETIRED";
  createdAt: string;
  createdBy: Readonly<{
    agentId: string;
    sessionId: string;
    runId: string;
    selectionRevision: number;
  }>;
}>;

export type ProjectCtoRegistry = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  revision: number;
  ctos: readonly ProjectCto[];
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STATUSES = new Set(["AVAILABLE", "ACTIVE", "RETIRED"]);
const MAX_ID_LENGTH = 160;
const MAX_DISPLAY_NAME_BYTES = 512;
const encoder = new TextEncoder();

function record(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain record.`);
  }

  const keys = Reflect.ownKeys(value);
  const allowed = new Set(required);
  if (required.some(key => !keys.includes(key))
    || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data field.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a standard array.`);
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length > maximum) {
    throw new TypeError(`${label} must have at most ${maximum} entries.`);
  }
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw new TypeError(`${label} must be dense and have no extra properties.`);
  }

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must be dense data.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank identifier of at most ${MAX_ID_LENGTH} characters without ASCII controls.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical lowercase UUID.`);
  }
  return value;
}

function parseCto(value: unknown, index: number): ProjectCto {
  const label = `projectCtos.ctos[${index}]`;
  const row = record(value, ["ctoId", "displayName", "agentId", "sessionId", "status", "createdAt", "createdBy"], label);
  const displayName = row.displayName;
  if (typeof displayName !== "string" || displayName.trim().length === 0
    || /[\u0000-\u001f\u007f]/u.test(displayName)
    || encoder.encode(displayName).byteLength > MAX_DISPLAY_NAME_BYTES) {
    throw new TypeError(`${label}.displayName must be nonblank, contain no ASCII controls, and be at most ${MAX_DISPLAY_NAME_BYTES} UTF-8 bytes.`);
  }

  const sessionId = row.sessionId;
  if (sessionId !== null) uuid(sessionId, `${label}.sessionId`);
  if (typeof row.status !== "string" || !STATUSES.has(row.status)) {
    throw new TypeError(`${label}.status is unsupported.`);
  }
  const createdAt = row.createdAt;
  if (typeof createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt)
    || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    throw new TypeError(`${label}.createdAt must be a canonical ISO timestamp.`);
  }

  const creator = record(row.createdBy, ["agentId", "sessionId", "runId", "selectionRevision"], `${label}.createdBy`);
  if (!Number.isSafeInteger(creator.selectionRevision) || (creator.selectionRevision as number) <= 0) {
    throw new TypeError(`${label}.createdBy.selectionRevision must be a positive safe integer.`);
  }

  return Object.freeze({
    ctoId: identifier(row.ctoId, `${label}.ctoId`),
    displayName,
    agentId: uuid(row.agentId, `${label}.agentId`),
    sessionId: sessionId as string | null,
    status: row.status as ProjectCto["status"],
    createdAt,
    createdBy: Object.freeze({
      agentId: uuid(creator.agentId, `${label}.createdBy.agentId`),
      sessionId: uuid(creator.sessionId, `${label}.createdBy.sessionId`),
      runId: uuid(creator.runId, `${label}.createdBy.runId`),
      selectionRevision: creator.selectionRevision as number,
    }),
  });
}

/** Validates and returns an immutable detached snapshot scoped to the expected workspace and project. */
export function parseProjectCtos(value: unknown, workspaceId: string, projectId: string): ProjectCtoRegistry {
  const expectedWorkspaceId = uuid(workspaceId, "workspaceId");
  const expectedProjectId = identifier(projectId, "projectId");
  const row = record(value, ["schemaVersion", "workspaceId", "projectId", "revision", "ctos"], "projectCtos");

  const actualWorkspaceId = uuid(row.workspaceId, "projectCtos.workspaceId");
  const actualProjectId = identifier(row.projectId, "projectCtos.projectId");
  if (row.schemaVersion !== 1 || actualWorkspaceId !== expectedWorkspaceId || actualProjectId !== expectedProjectId) {
    throw new TypeError("Invalid or cross-workspace/project CTO registry.");
  }
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) {
    throw new TypeError("projectCtos.revision must be a nonnegative safe integer.");
  }

  const ctos = list(row.ctos, 100, "projectCtos.ctos").map(parseCto);
  if (row.revision === 0 && ctos.length !== 0 || (row.revision as number) > 0 && ctos.length === 0) {
    throw new TypeError("projectCtos revision and CTO collection are inconsistent.");
  }
  if (new Set(ctos.map(cto => cto.ctoId)).size !== ctos.length) {
    throw new TypeError("projectCtos.ctos contains duplicate CTO IDs.");
  }
  const sessionIds = ctos.flatMap(cto => cto.sessionId === null ? [] : [cto.sessionId]);
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new TypeError("projectCtos.ctos contains duplicate non-null session IDs.");
  }

  return Object.freeze({
    schemaVersion: 1,
    workspaceId: actualWorkspaceId,
    projectId: actualProjectId,
    revision: row.revision as number,
    ctos: Object.freeze(ctos),
  });
}
