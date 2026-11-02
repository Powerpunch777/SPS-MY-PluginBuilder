import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const MAX_ID_LENGTH = 160;
const MAX_TEXT_BYTES = 4_096;
const MAX_PACKET_BYTES = 48 * 1_024;
const MAX_BOARD_BYTES = 192 * 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export type TaskPacket = Readonly<{
  projectId: string;
  ctoId: string;
  workstreamId: string;
  taskId: string;
  revision: number;
  kind: "development" | "qa";
  title: string;
  goal: string;
  scopeNodeIds: readonly string[];
  requirementIds: readonly string[];
  dependencies: readonly string[];
  included: readonly string[];
  excluded: readonly string[];
  constraints: readonly string[];
  acceptance: readonly string[];
  evidenceRequired: readonly string[];
  reuse: readonly TaskPacketReuse[];
  testPlan: null | TaskPacketTestPlan;
}>;

export type TaskPacketReuse = Readonly<{
  id: string;
  sourceUrl: string;
  licenseStatus: "unreviewed" | "reviewed" | "restricted";
  licenseExpression: string | null;
  evidenceRefs: readonly string[];
  compatibilityStatus: "not-verified" | "verified" | "incompatible";
  reuseScope: string;
  doNotRebuild: string;
}>;

export type TaskPacketTestPlan = Readonly<{
  environment: string;
  steps: readonly string[];
  expectedResults: readonly string[];
  passCriteria: readonly string[];
}>;

export type TaskPacketRecord = Readonly<{
  packet: TaskPacket;
  source: Readonly<{
    requestId: string;
    workstreamId: string;
    specRevision: number;
    instructionSha256: string;
  }>;
  author: Readonly<{ agentId: string; sessionId: string; runId: string }>;
  createdAtISO: string;
  dependencyPins: readonly TaskPacketDependencyPin[];
}>;

export type TaskPacketDependencyPin = Readonly<{
  taskId: string;
  revision: number;
  recordSha256: string;
}>;

export type TaskPacketBoard = Readonly<{
  projectId: string;
  ctoId: string;
  workstreamId: string;
  revisionId: string;
  packets: readonly TaskPacketRecord[];
}>;

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain record.`);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
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
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length > maximum) {
    throw new TypeError(`${label} must have at most ${maximum} entries.`);
  }
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw new TypeError(`${label} must be dense and have no extra properties.`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must contain dense data fields.`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function safeString(value: unknown, label: string, maximumBytes?: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be nonblank and contain no control characters.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contains invalid Unicode.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains invalid Unicode.`);
    }
  }
  if (maximumBytes !== undefined && encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(`${label} must be at most ${maximumBytes} UTF-8 bytes.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = safeString(value, label);
  if (result.length > MAX_ID_LENGTH) throw new TypeError(`${label} must be at most ${MAX_ID_LENGTH} characters.`);
  return result;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical UUID.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function text(value: unknown, label: string, maximumBytes = MAX_TEXT_BYTES): string {
  return safeString(value, label, maximumBytes);
}

function stringList(
  value: unknown,
  label: string,
  maximum: number,
  minimum: number,
  mode: "id" | "text",
  unique = false,
): readonly string[] {
  const values = list(value, maximum, label).map((item, index) => mode === "id"
    ? identifier(item, `${label}[${index}]`)
    : text(item, `${label}[${index}]`));
  if (values.length < minimum) throw new TypeError(`${label} must contain at least ${minimum} entries.`);
  if (unique && new Set(values).size !== values.length) throw new TypeError(`${label} must contain unique values.`);
  return Object.freeze(values);
}

function parseReuse(value: unknown, index: number): TaskPacketReuse {
  const label = `packet.reuse[${index}]`;
  const row = record(value, [
    "id", "sourceUrl", "licenseStatus", "licenseExpression", "evidenceRefs", "compatibilityStatus", "reuseScope", "doNotRebuild",
  ], label);
  const sourceUrl = text(row.sourceUrl, `${label}.sourceUrl`);
  let parsedUrl: URL;
  try { parsedUrl = new URL(sourceUrl); } catch { throw new TypeError(`${label}.sourceUrl must be an HTTPS URL without credentials.`); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new TypeError(`${label}.sourceUrl must be an HTTPS URL without credentials.`);
  }
  if (row.licenseStatus !== "unreviewed" && row.licenseStatus !== "reviewed" && row.licenseStatus !== "restricted") {
    throw new TypeError(`${label}.licenseStatus is unsupported.`);
  }
  const licenseExpression = row.licenseExpression === null ? null : text(row.licenseExpression, `${label}.licenseExpression`, 512);
  const evidenceRefs = stringList(row.evidenceRefs, `${label}.evidenceRefs`, 32, 0, "id", true);
  if (row.licenseStatus === "reviewed" && (licenseExpression === null || evidenceRefs.length === 0)) {
    throw new TypeError(`${label} reviewed license requires an expression and evidence references.`);
  }
  if (row.licenseStatus === "unreviewed" && licenseExpression !== null) {
    throw new TypeError(`${label} unreviewed license must have a null expression.`);
  }
  if (row.compatibilityStatus !== "not-verified" && row.compatibilityStatus !== "verified" && row.compatibilityStatus !== "incompatible") {
    throw new TypeError(`${label}.compatibilityStatus is unsupported.`);
  }
  if (row.compatibilityStatus === "verified" && evidenceRefs.length === 0) {
    throw new TypeError(`${label} verified compatibility requires evidence references.`);
  }
  return Object.freeze({
    id: identifier(row.id, `${label}.id`), sourceUrl, licenseStatus: row.licenseStatus,
    licenseExpression, evidenceRefs, compatibilityStatus: row.compatibilityStatus,
    reuseScope: text(row.reuseScope, `${label}.reuseScope`), doNotRebuild: text(row.doNotRebuild, `${label}.doNotRebuild`),
  });
}

function parseTestPlan(value: unknown): TaskPacketTestPlan | null {
  if (value === null) return null;
  const row = record(value, ["environment", "steps", "expectedResults", "passCriteria"], "packet.testPlan");
  return Object.freeze({
    environment: text(row.environment, "packet.testPlan.environment"),
    steps: stringList(row.steps, "packet.testPlan.steps", 32, 1, "text"),
    expectedResults: stringList(row.expectedResults, "packet.testPlan.expectedResults", 32, 1, "text"),
    passCriteria: stringList(row.passCriteria, "packet.testPlan.passCriteria", 32, 1, "text"),
  });
}

const PACKET_FIELDS = [
  "projectId", "ctoId", "workstreamId", "taskId", "revision", "kind", "title", "goal", "scopeNodeIds",
  "requirementIds", "dependencies", "included", "excluded", "constraints", "acceptance", "evidenceRequired", "reuse", "testPlan",
] as const;

export function parseTaskPacket(value: unknown, projectId: string, ctoId: string, workstreamId: string): TaskPacket {
  const expectedProjectId = identifier(projectId, "projectId");
  const expectedCtoId = identifier(ctoId, "ctoId");
  const expectedWorkstreamId = identifier(workstreamId, "workstreamId");
  const row = record(value, PACKET_FIELDS, "packet");
  const actualProjectId = identifier(row.projectId, "packet.projectId");
  const actualCtoId = identifier(row.ctoId, "packet.ctoId");
  const actualWorkstreamId = identifier(row.workstreamId, "packet.workstreamId");
  if (actualProjectId !== expectedProjectId || actualCtoId !== expectedCtoId || actualWorkstreamId !== expectedWorkstreamId) {
    throw new TypeError("packet project, CTO, or workstream does not match the expected scope.");
  }
  if (row.kind !== "development" && row.kind !== "qa") throw new TypeError("packet.kind is unsupported.");
  const dependencies = stringList(row.dependencies, "packet.dependencies", 64, 0, "id", true);
  const taskId = identifier(row.taskId, "packet.taskId");
  if (dependencies.includes(taskId)) throw new TypeError("packet.dependencies must not include its own taskId.");
  const reuse = list(row.reuse, 16, "packet.reuse").map(parseReuse);
  if (new Set(reuse.map(item => item.id)).size !== reuse.length) throw new TypeError("packet.reuse IDs must be unique.");
  const testPlan = parseTestPlan(row.testPlan);
  if (row.kind === "qa" && testPlan === null) throw new TypeError("QA packets require a testPlan.");
  const packet: TaskPacket = Object.freeze({
    projectId: actualProjectId, ctoId: actualCtoId, workstreamId: actualWorkstreamId, taskId,
    revision: positiveInteger(row.revision, "packet.revision"), kind: row.kind,
    title: text(row.title, "packet.title", 512), goal: text(row.goal, "packet.goal"),
    scopeNodeIds: stringList(row.scopeNodeIds, "packet.scopeNodeIds", 64, 1, "id", true),
    requirementIds: stringList(row.requirementIds, "packet.requirementIds", 64, 1, "id", true),
    dependencies,
    included: stringList(row.included, "packet.included", 32, 1, "text"),
    excluded: stringList(row.excluded, "packet.excluded", 32, 0, "text"),
    constraints: stringList(row.constraints, "packet.constraints", 32, 0, "text"),
    acceptance: stringList(row.acceptance, "packet.acceptance", 32, 1, "text"),
    evidenceRequired: stringList(row.evidenceRequired, "packet.evidenceRequired", 32, 1, "text"),
    reuse: Object.freeze(reuse), testPlan,
  });
  if (encoder.encode(JSON.stringify(packet)).byteLength > MAX_PACKET_BYTES) {
    throw new TypeError(`packet exceeds the ${MAX_PACKET_BYTES}-byte limit.`);
  }
  return packet;
}

export function parseTaskPacketRecord(
  value: unknown,
  projectId: string,
  ctoId: string,
  workstreamId: string,
): TaskPacketRecord {
  const row = record(value, ["packet", "source", "author", "createdAtISO", "dependencyPins"], "taskPacketRecord");
  const packet = parseTaskPacket(row.packet, projectId, ctoId, workstreamId);
  const sourceRow = record(row.source, ["requestId", "workstreamId", "specRevision", "instructionSha256"], "taskPacketRecord.source");
  const sourceWorkstreamId = identifier(sourceRow.workstreamId, "taskPacketRecord.source.workstreamId");
  if (sourceWorkstreamId !== packet.workstreamId) throw new TypeError("source.workstreamId must match packet.workstreamId.");
  const instructionSha256 = sourceRow.instructionSha256;
  if (typeof instructionSha256 !== "string" || !DIGEST.test(instructionSha256)) {
    throw new TypeError("source.instructionSha256 must be 64 lowercase hexadecimal characters.");
  }
  const source = Object.freeze({
    requestId: uuid(sourceRow.requestId, "source.requestId"), workstreamId: sourceWorkstreamId,
    specRevision: positiveInteger(sourceRow.specRevision, "source.specRevision"), instructionSha256,
  });
  const authorRow = record(row.author, ["agentId", "sessionId", "runId"], "taskPacketRecord.author");
  const author = Object.freeze({
    agentId: uuid(authorRow.agentId, "author.agentId"), sessionId: uuid(authorRow.sessionId, "author.sessionId"),
    runId: uuid(authorRow.runId, "author.runId"),
  });
  const createdAtISO = row.createdAtISO;
  if (typeof createdAtISO !== "string" || !Number.isFinite(Date.parse(createdAtISO)) || new Date(createdAtISO).toISOString() !== createdAtISO) {
    throw new TypeError("createdAtISO must be a canonical ISO timestamp.");
  }
  const dependencyPins = list(row.dependencyPins, 64, "taskPacketRecord.dependencyPins").map((item, index) => {
    const label = `taskPacketRecord.dependencyPins[${index}]`;
    const pinRow = record(item, ["taskId", "revision", "recordSha256"], label);
    const recordSha256 = pinRow.recordSha256;
    if (typeof recordSha256 !== "string" || !DIGEST.test(recordSha256)) {
      throw new TypeError(`${label}.recordSha256 must be 64 lowercase hexadecimal characters.`);
    }
    return Object.freeze({
      taskId: identifier(pinRow.taskId, `${label}.taskId`),
      revision: positiveInteger(pinRow.revision, `${label}.revision`),
      recordSha256,
    });
  });
  if (new Set(dependencyPins.map(pin => pin.taskId)).size !== dependencyPins.length) {
    throw new TypeError("taskPacketRecord.dependencyPins taskIds must be unique.");
  }
  if (dependencyPins.length !== packet.dependencies.length
    || dependencyPins.some(pin => !packet.dependencies.includes(pin.taskId))) {
    throw new TypeError("taskPacketRecord.dependencyPins must match packet.dependencies exactly.");
  }
  return Object.freeze({ packet, source, author, createdAtISO, dependencyPins: Object.freeze(dependencyPins) });
}

export function taskPacketRecordDigest(
  value: unknown,
  projectId: string,
  ctoId: string,
  workstreamId: string,
): string {
  const parsed = parseTaskPacketRecord(value, projectId, ctoId, workstreamId);
  return createHash("sha256").update(JSON.stringify(parsed), "utf8").digest("hex");
}

export function parseTaskPacketBoard(
  value: unknown,
  projectId: string,
  ctoId: string,
  workstreamId: string,
): TaskPacketBoard {
  const expectedProjectId = identifier(projectId, "projectId");
  const expectedCtoId = identifier(ctoId, "ctoId");
  const expectedWorkstreamId = identifier(workstreamId, "workstreamId");
  const row = record(value, ["projectId", "ctoId", "workstreamId", "revisionId", "packets"], "taskPacketBoard");
  const actualProjectId = identifier(row.projectId, "board.projectId");
  const actualCtoId = identifier(row.ctoId, "board.ctoId");
  const actualWorkstreamId = identifier(row.workstreamId, "board.workstreamId");
  if (actualProjectId !== expectedProjectId || actualCtoId !== expectedCtoId || actualWorkstreamId !== expectedWorkstreamId) {
    throw new TypeError("board project, CTO, or workstream does not match the expected scope.");
  }
  const packets = list(row.packets, 64, "board.packets").map(item =>
    parseTaskPacketRecord(item, expectedProjectId, expectedCtoId, expectedWorkstreamId));
  const byTaskId = new Map<string, TaskPacketRecord>();
  for (const item of packets) {
    if (byTaskId.has(item.packet.taskId)) throw new TypeError("board.packets must contain only the latest record for each taskId.");
    byTaskId.set(item.packet.taskId, item);
  }
  for (const item of packets) {
    for (const pin of item.dependencyPins) {
      const target = byTaskId.get(pin.taskId);
      if (!target) throw new TypeError(`Task dependency ${pin.taskId} is missing from the board.`);
      if (target.source.specRevision !== item.source.specRevision
        || target.source.instructionSha256 !== item.source.instructionSha256) {
        throw new TypeError(`Task dependency ${pin.taskId} must use the same specification revision and instruction digest.`);
      }
      if (pin.revision > target.packet.revision) {
        throw new TypeError(`Task dependency pin ${pin.taskId}@${pin.revision} is newer than the target revision.`);
      }
      if (pin.revision === target.packet.revision
        && pin.recordSha256 !== taskPacketRecordDigest(target, expectedProjectId, expectedCtoId, expectedWorkstreamId)) {
        throw new TypeError(`Task dependency pin ${pin.taskId}@${pin.revision} does not match the target record digest.`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new TypeError("board task dependencies must form a DAG without cycles.");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byTaskId.get(taskId)!.packet.dependencies) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of byTaskId.keys()) visit(taskId);

  const board: TaskPacketBoard = Object.freeze({
    projectId: actualProjectId, ctoId: actualCtoId, workstreamId: actualWorkstreamId,
    revisionId: identifier(row.revisionId, "board.revisionId"), packets: Object.freeze(packets),
  });
  if (encoder.encode(JSON.stringify(board)).byteLength > MAX_BOARD_BYTES) {
    throw new TypeError(`taskPacketBoard exceeds the ${MAX_BOARD_BYTES}-byte limit.`);
  }
  return board;
}
