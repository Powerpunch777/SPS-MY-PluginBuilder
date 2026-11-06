import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_RECORDS = 128;
const MAX_REGISTRY_BYTES = 256 * 1024;

export type TaskWorkerRole = "worker" | "qa";
export type TaskWorkerRecord = Readonly<{
  workstreamId: string;
  taskId: string;
  packetRevision: number;
  packetRecordSha256: string;
  role: TaskWorkerRole;
  agentId: string;
  sessionId: string;
  pluginAgentKey: string;
  source: Readonly<{ requestId: string; specRevision: number; instructionSha256: string }>;
  registeredAtISO: string;
}>;
export type TaskWorkerRegistry = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  ctoId: string;
  revision: number;
  records: readonly TaskWorkerRecord[];
}>;

function plain(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const keys = Reflect.ownKeys(value), allowed = new Set(fields);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label}.${key} must be a data field.`);
    result[key] = descriptor.value;
  }
  return result;
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier.`);
  }
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} must be a positive safe integer.`);
  return value as number;
}

function parseWorker(value: unknown, index: number): TaskWorkerRecord {
  const row = plain(value, ["workstreamId", "taskId", "packetRevision", "packetRecordSha256", "role", "agentId", "sessionId", "pluginAgentKey", "source", "registeredAtISO"], `taskWorkers.records[${index}]`);
  if (row.role !== "worker" && row.role !== "qa") throw new TypeError(`taskWorkers.records[${index}].role is unsupported.`);
  if (typeof row.packetRecordSha256 !== "string" || !DIGEST.test(row.packetRecordSha256)) throw new TypeError("packetRecordSha256 must be a lowercase SHA-256 digest.");
  if (typeof row.agentId !== "string" || !UUID.test(row.agentId) || typeof row.sessionId !== "string" || !UUID.test(row.sessionId)) {
    throw new TypeError("Task Worker Agent and session IDs must be canonical UUIDs.");
  }
  if (typeof row.pluginAgentKey !== "string" || !/^builder-task-(worker|qa):[a-f0-9]{64}$/u.test(row.pluginAgentKey)) {
    throw new TypeError("Task Worker profile key is invalid.");
  }
  const source = plain(row.source, ["requestId", "specRevision", "instructionSha256"], "taskWorker.source");
  if (typeof source.requestId !== "string" || !UUID.test(source.requestId)
    || typeof source.instructionSha256 !== "string" || !DIGEST.test(source.instructionSha256)) throw new TypeError("Task Worker source pins are invalid.");
  const registeredAtISO = row.registeredAtISO;
  if (typeof registeredAtISO !== "string" || !Number.isFinite(Date.parse(registeredAtISO))
    || new Date(registeredAtISO).toISOString() !== registeredAtISO) throw new TypeError("registeredAtISO must be canonical ISO time.");
  const expectedPrefix = row.role === "worker" ? "builder-task-worker:" : "builder-task-qa:";
  if (!(row.pluginAgentKey as string).startsWith(expectedPrefix)) throw new TypeError("Task Worker profile key does not match its role.");
  const workstreamId = boundedId(row.workstreamId, "workstreamId"), taskId = boundedId(row.taskId, "taskId");
  return Object.freeze({ workstreamId, taskId,
    packetRevision: positive(row.packetRevision, "packetRevision"), packetRecordSha256: row.packetRecordSha256,
    role: row.role, agentId: row.agentId, sessionId: row.sessionId, pluginAgentKey: row.pluginAgentKey,
    source: Object.freeze({ requestId: source.requestId, specRevision: positive(source.specRevision, "source.specRevision"),
      instructionSha256: source.instructionSha256 }), registeredAtISO });
}

export function parseTaskWorkerRegistry(value: unknown, workspaceId: string, projectId: string, ctoId: string): TaskWorkerRegistry {
  const row = plain(value, ["schemaVersion", "workspaceId", "projectId", "ctoId", "revision", "records"], "taskWorkers");
  if (row.schemaVersion !== 1 || row.workspaceId !== workspaceId || row.projectId !== projectId || row.ctoId !== ctoId) {
    throw new TypeError("Task Worker registry scope does not match.");
  }
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) throw new TypeError("Task Worker registry revision is invalid.");
  if (!Array.isArray(row.records) || Object.getPrototypeOf(row.records) !== Array.prototype || row.records.length > MAX_RECORDS
    || Reflect.ownKeys(row.records).length !== row.records.length + 1) throw new TypeError("Task Worker history is invalid or full.");
  const records: TaskWorkerRecord[] = [];
  for (let index = 0; index < row.records.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(row.records, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Task Worker history must be dense data.");
    records.push(parseWorker(descriptor.value, index));
  }
  for (const record of records) {
    const expectedKey = `builder-task-${record.role}:${createHash("sha256").update(JSON.stringify([projectId,
      record.workstreamId, record.taskId, record.role]), "utf8").digest("hex")}`;
    if (record.pluginAgentKey !== expectedKey) throw new TypeError("Task Worker profile key does not match its project/task/role scope.");
  }
  if ((row.revision === 0) !== (records.length === 0)) throw new TypeError("Task Worker registry revision and history disagree.");
  const identityKeys = records.map(item => JSON.stringify([item.workstreamId, item.taskId, item.packetRevision, item.role]));
  if (new Set(identityKeys).size !== identityKeys.length) throw new TypeError("Task Worker history contains duplicate task roles.");
  const logicalIdentities = new Map<string, TaskWorkerRecord>();
  const agents = new Map<string, string>(), sessions = new Map<string, string>();
  for (const item of records) {
    const logicalKey = JSON.stringify([item.workstreamId, item.taskId, item.role]);
    const prior = logicalIdentities.get(logicalKey);
    if (prior && (prior.agentId !== item.agentId || prior.sessionId !== item.sessionId || prior.pluginAgentKey !== item.pluginAgentKey)) {
      throw new TypeError("A task role must preserve its Agent and session identity across packet revisions.");
    }
    const agentOwner = agents.get(item.agentId), sessionOwner = sessions.get(item.sessionId);
    if (agentOwner && agentOwner !== logicalKey || sessionOwner && sessionOwner !== logicalKey) {
      throw new TypeError("Worker and QA identities must be distinct across task roles.");
    }
    logicalIdentities.set(logicalKey, prior ?? item);
    agents.set(item.agentId, logicalKey);
    sessions.set(item.sessionId, logicalKey);
  }
  const registry = Object.freeze({ schemaVersion: 1 as const, workspaceId, projectId, ctoId,
    revision: row.revision as number, records: Object.freeze(records) });
  if (Buffer.byteLength(JSON.stringify(registry), "utf8") > MAX_REGISTRY_BYTES) throw new TypeError("Task Worker registry exceeds its size limit.");
  return registry;
}

export function taskWorkerRegistryKey(projectId: string, ctoId: string): string {
  return `task-workers.v1.${createHash("sha256").update(JSON.stringify([projectId, ctoId]), "utf8").digest("hex")}`;
}
