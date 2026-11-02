const encoder = new TextEncoder();
const MAX_ID_LENGTH = 160;
const MAX_TEXT_BYTES = 4_096;
const MAX_LIST_LENGTH = 128;
const MAX_SPEC_BYTES = 32 * 1024;
const MAX_BOARD_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export type WorkstreamSpec = Readonly<{
  projectId: string;
  id: string;
  revision: number;
  sourceSpecRevisionId: string;
  assignedCtoId: string;
  title: string;
  goal: string;
  scopeNodeIds: readonly string[];
  included: readonly string[];
  excluded: readonly string[];
  dependencies: readonly string[];
  interfaceContracts: readonly string[];
  technologyDecisionsRef: string;
  reuseCandidates: readonly string[];
  acceptance: readonly string[];
  evidenceRequired: readonly string[];
  openQuestions: readonly string[];
}>;

export type WorkstreamChange = Readonly<{
  previousRevision: number | null;
  reason: string;
  diff: string;
  impactNodeIds: readonly string[];
  impactInterfaceContracts: readonly string[];
  impactTaskIds: readonly string[];
  effectiveFrom: string;
}>;

export type WorkstreamRecord = Readonly<{
  spec: WorkstreamSpec;
  sourceBaselineRevisionId: string;
  baselineDigest: string;
  technologyDigest: string;
  ctoAgentId: string;
  ctoSessionId: string;
  author: Readonly<{
    agentId: string;
    sessionId: string;
    runId: string;
    selectionRevision: number;
  }>;
  createdAt: string;
  change: WorkstreamChange;
  receipt: null | Readonly<{
    revision: number;
    agentId: string;
    sessionId: string;
    runId: string;
    createdAt: string;
    readiness: "ready" | "needs-clarification" | "blocked";
    note: string;
  }>;
}>;

export type WorkstreamBoard = Readonly<{
  projectId: string;
  revisionId: string;
  workstreams: readonly WorkstreamRecord[];
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

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a standard array.`);
  }
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length > MAX_LIST_LENGTH) {
    throw new TypeError(`${label} must have at most ${MAX_LIST_LENGTH} entries.`);
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

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank identifier of at most ${MAX_ID_LENGTH} characters without ASCII controls.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical UUID.`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${label} must be 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function text(value: unknown, label: string, maximum = MAX_TEXT_BYTES): string {
  if (typeof value !== "string" || value.trim().length === 0 || encoder.encode(value).byteLength > maximum) {
    throw new TypeError(`${label} must be nonblank and at most ${maximum} UTF-8 bytes.`);
  }
  return value;
}

function stringList(
  value: unknown,
  label: string,
  mode: "id" | "text",
  required: boolean,
  unique: boolean,
): readonly string[] {
  const values = list(value, label).map((entry, index) => mode === "id"
    ? identifier(entry, `${label}[${index}]`)
    : text(entry, `${label}[${index}]`));
  if (required && values.length === 0) throw new TypeError(`${label} must not be empty.`);
  if (unique && new Set(values).size !== values.length) throw new TypeError(`${label} must contain unique values.`);
  return Object.freeze(values);
}

function canonicalIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

const SPEC_FIELDS = [
  "projectId", "id", "revision", "sourceSpecRevisionId", "assignedCtoId", "title", "goal",
  "scopeNodeIds", "included", "excluded", "dependencies", "interfaceContracts",
  "technologyDecisionsRef", "reuseCandidates", "acceptance", "evidenceRequired", "openQuestions",
] as const;

function parseSpec(value: unknown, expectedProjectId: string): WorkstreamSpec {
  const row = record(value, SPEC_FIELDS, "workstreamSpec");
  const projectId = identifier(row.projectId, "workstreamSpec.projectId");
  if (projectId !== expectedProjectId) throw new TypeError("workstreamSpec.projectId does not match the expected project.");

  const spec: WorkstreamSpec = Object.freeze({
    projectId,
    id: identifier(row.id, "workstreamSpec.id"),
    revision: positiveSafeInteger(row.revision, "workstreamSpec.revision"),
    sourceSpecRevisionId: identifier(row.sourceSpecRevisionId, "workstreamSpec.sourceSpecRevisionId"),
    assignedCtoId: identifier(row.assignedCtoId, "workstreamSpec.assignedCtoId"),
    title: text(row.title, "workstreamSpec.title", 512),
    goal: text(row.goal, "workstreamSpec.goal"),
    scopeNodeIds: stringList(row.scopeNodeIds, "workstreamSpec.scopeNodeIds", "id", true, true),
    included: stringList(row.included, "workstreamSpec.included", "text", true, true),
    excluded: stringList(row.excluded, "workstreamSpec.excluded", "text", false, false),
    dependencies: stringList(row.dependencies, "workstreamSpec.dependencies", "text", false, false),
    interfaceContracts: stringList(row.interfaceContracts, "workstreamSpec.interfaceContracts", "id", false, true),
    technologyDecisionsRef: identifier(row.technologyDecisionsRef, "workstreamSpec.technologyDecisionsRef"),
    reuseCandidates: stringList(row.reuseCandidates, "workstreamSpec.reuseCandidates", "text", false, false),
    acceptance: stringList(row.acceptance, "workstreamSpec.acceptance", "text", true, true),
    evidenceRequired: stringList(row.evidenceRequired, "workstreamSpec.evidenceRequired", "text", true, true),
    openQuestions: stringList(row.openQuestions, "workstreamSpec.openQuestions", "id", false, true),
  });
  if (encoder.encode(JSON.stringify(spec)).byteLength > MAX_SPEC_BYTES) {
    throw new TypeError(`workstreamSpec exceeds the ${MAX_SPEC_BYTES}-byte limit.`);
  }
  return spec;
}

export function parseWorkstreamSpec(value: unknown, projectId: string): WorkstreamSpec {
  return parseSpec(value, identifier(projectId, "projectId"));
}

export function parseWorkstreamChange(value: unknown): WorkstreamChange {
  const row = record(value, [
    "previousRevision", "reason", "diff", "impactNodeIds", "impactInterfaceContracts", "impactTaskIds", "effectiveFrom",
  ], "workstreamChange");
  const previousRevision = row.previousRevision === null
    ? null
    : positiveSafeInteger(row.previousRevision, "workstreamChange.previousRevision");
  return Object.freeze({
    previousRevision,
    reason: text(row.reason, "workstreamChange.reason"),
    diff: text(row.diff, "workstreamChange.diff"),
    impactNodeIds: stringList(row.impactNodeIds, "workstreamChange.impactNodeIds", "id", false, true),
    impactInterfaceContracts: stringList(row.impactInterfaceContracts, "workstreamChange.impactInterfaceContracts", "id", false, true),
    impactTaskIds: stringList(row.impactTaskIds, "workstreamChange.impactTaskIds", "id", false, true),
    effectiveFrom: text(row.effectiveFrom, "workstreamChange.effectiveFrom"),
  });
}

function parseReceipt(value: unknown, spec: WorkstreamSpec, ctoAgentId: string, ctoSessionId: string): WorkstreamRecord["receipt"] {
  if (value === null) return null;
  const row = record(value, ["revision", "agentId", "sessionId", "runId", "createdAt", "readiness", "note"], "workstreamRecord.receipt");
  const revision = positiveSafeInteger(row.revision, "receipt.revision");
  const agentId = uuid(row.agentId, "receipt.agentId");
  const sessionId = uuid(row.sessionId, "receipt.sessionId");
  if (revision !== spec.revision) throw new TypeError("receipt.revision must match spec.revision.");
  if (agentId !== ctoAgentId || sessionId !== ctoSessionId) throw new TypeError("receipt CTO identity must match the record.");
  if (row.readiness !== "ready" && row.readiness !== "needs-clarification" && row.readiness !== "blocked") {
    throw new TypeError("receipt.readiness is unsupported.");
  }
  return Object.freeze({
    revision,
    agentId,
    sessionId,
    runId: uuid(row.runId, "receipt.runId"),
    createdAt: canonicalIso(row.createdAt, "receipt.createdAt"),
    readiness: row.readiness,
    note: text(row.note, "receipt.note"),
  });
}

function parseWorkstreamRecord(value: unknown, projectId: string): WorkstreamRecord {
  const row = record(value, [
    "spec", "sourceBaselineRevisionId", "baselineDigest", "technologyDigest", "ctoAgentId", "ctoSessionId",
    "author", "createdAt", "change", "receipt",
  ], "workstreamRecord");
  const spec = parseSpec(row.spec, projectId);
  const ctoAgentId = uuid(row.ctoAgentId, "workstreamRecord.ctoAgentId");
  const ctoSessionId = uuid(row.ctoSessionId, "workstreamRecord.ctoSessionId");
  const authorRow = record(row.author, ["agentId", "sessionId", "runId", "selectionRevision"], "workstreamRecord.author");
  const author = Object.freeze({
    agentId: uuid(authorRow.agentId, "author.agentId"),
    sessionId: uuid(authorRow.sessionId, "author.sessionId"),
    runId: uuid(authorRow.runId, "author.runId"),
    selectionRevision: positiveSafeInteger(authorRow.selectionRevision, "author.selectionRevision"),
  });
  const change = parseWorkstreamChange(row.change);
  const expectedPrevious = spec.revision === 1 ? null : spec.revision - 1;
  if (change.previousRevision !== expectedPrevious) {
    throw new TypeError("change.previousRevision must be null for revision 1, otherwise spec.revision - 1.");
  }

  return Object.freeze({
    spec,
    sourceBaselineRevisionId: identifier(row.sourceBaselineRevisionId, "sourceBaselineRevisionId"),
    baselineDigest: digest(row.baselineDigest, "baselineDigest"),
    technologyDigest: digest(row.technologyDigest, "technologyDigest"),
    ctoAgentId,
    ctoSessionId,
    author,
    createdAt: canonicalIso(row.createdAt, "createdAt"),
    change,
    receipt: parseReceipt(row.receipt, spec, ctoAgentId, ctoSessionId),
  });
}

export function parseWorkstreamBoard(value: unknown, projectId: string): WorkstreamBoard {
  const expectedProjectId = identifier(projectId, "projectId");
  const row = record(value, ["projectId", "revisionId", "workstreams"], "workstreamBoard");
  const actualProjectId = identifier(row.projectId, "workstreamBoard.projectId");
  if (actualProjectId !== expectedProjectId) throw new TypeError("workstreamBoard.projectId does not match the expected project.");
  const rawWorkstreams = list(row.workstreams, "workstreamBoard.workstreams");
  const workstreams = rawWorkstreams.map(item => parseWorkstreamRecord(item, expectedProjectId));
  if (new Set(workstreams.map(item => item.spec.id)).size !== workstreams.length) {
    throw new TypeError("workstreamBoard.workstreams must have unique spec.id values.");
  }
  const owners = new Map<string, string>();
  for (const item of workstreams) {
    for (const nodeId of item.spec.scopeNodeIds) {
      const owner = owners.get(nodeId);
      if (owner !== undefined && owner !== item.spec.assignedCtoId) {
        throw new TypeError("Each Graph node must have one responsible CTO.");
      }
      owners.set(nodeId, item.spec.assignedCtoId);
    }
  }

  const board: WorkstreamBoard = Object.freeze({
    projectId: actualProjectId,
    revisionId: identifier(row.revisionId, "workstreamBoard.revisionId"),
    workstreams: Object.freeze(workstreams),
  });
  if (encoder.encode(JSON.stringify(board)).byteLength > MAX_BOARD_BYTES) {
    throw new TypeError(`workstreamBoard exceeds the ${MAX_BOARD_BYTES}-byte limit.`);
  }
  return board;
}
