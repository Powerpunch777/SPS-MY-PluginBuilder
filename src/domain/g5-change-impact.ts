/**
 * Pure G5 candidate derivation. This module consumes snapshots; it does not
 * authenticate a reader, prove publication/approval, or authorize execution.
 */
export const G5_DIMENSIONS = [
  "requirements", "ui", "technology", "graph", "ctoWorkstreams", "tasks", "scheduleProductScope",
] as const;

export type G5Dimension = typeof G5_DIMENSIONS[number];
export type G5Record = Readonly<Record<string, unknown> & { id: string }>;
export type G5Snapshot = Readonly<{
  projectId: string;
  revisionId: string;
  records: readonly G5Record[];
}>;
export type G5DimensionPair = Readonly<{ old: G5Snapshot | null; new: G5Snapshot | null }>;
export type G5Input = Readonly<{
  projectId: string;
  dimensions: Readonly<Partial<Record<G5Dimension, G5DimensionPair>>>;
}>;
export type G5Candidate = Readonly<{
  dimension: G5Dimension;
  recordId: string;
  basis: "direct-revision-diff" | "derived-reference";
  via: readonly string[];
}>;
export type G5DimensionResult = Readonly<{
  status: "CANDIDATES" | "NO_CANDIDATE_OBSERVED" | "UNKNOWN";
  oldRevisionId: string | null;
  newRevisionId: string | null;
  candidates: readonly G5Candidate[];
}>;

const REF_FIELDS = [
  "requirementRefs", "uiRefs", "technologyRefs", "graphRefs", "workstreamRefs", "taskRefs",
  "ctoRefs", "scheduleRefs", "productScopeRefs", "scopeNodeIds", "dependencies", "references",
] as const;
const MAX_RECORDS = 20_000;
const MAX_REFERENCES = 10_000;

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} has a symbol key.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label}.${key} must be a data field.`);
    result[key] = descriptor.value;
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier.`);
  }
  return value;
}

function snapshot(value: unknown, projectId: string, label: string): G5Snapshot {
  const row = plainRecord(value, label);
  const actualProject = identifier(row.projectId, `${label}.projectId`);
  if (actualProject !== projectId) throw new TypeError(`${label} belongs to another project.`);
  const revisionId = identifier(row.revisionId, `${label}.revisionId`);
  if (!Array.isArray(row.records) || Object.getPrototypeOf(row.records) !== Array.prototype
    || row.records.length > MAX_RECORDS || Reflect.ownKeys(row.records).length !== row.records.length + 1) {
    throw new TypeError(`${label}.records must be a dense bounded array.`);
  }
  const records = row.records.map((raw, index) => {
    const record = plainRecord(raw, `${label}.records[${index}]`);
    record.id = identifier(record.id, `${label}.records[${index}].id`);
    return Object.freeze(record) as G5Record;
  });
  if (new Set(records.map(item => item.id)).size !== records.length) throw new TypeError(`${label}.records contains duplicate IDs.`);
  return Object.freeze({ projectId, revisionId, records: Object.freeze(records) });
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stable(row[key])}`).join(",")}}`;
}

function references(row: G5Record): readonly string[] {
  const result: string[] = [];
  for (const field of REF_FIELDS) {
    const value = row[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > MAX_REFERENCES) throw new TypeError(`Record ${row.id}.${field} must be a bounded reference array.`);
    for (const item of value) result.push(identifier(item, `Record ${row.id}.${field} reference`));
  }
  return result;
}

/** Derives candidates only from exact old/new source snapshots and explicit record references. */
export function produceG5ChangeImpactCandidates(value: unknown): Readonly<{
  projectId: string;
  dimensions: Readonly<Record<G5Dimension, G5DimensionResult>>;
  approvalCreated: false;
  executionAuthorized: false;
}> {
  const input = plainRecord(value, "g5Input");
  const projectId = identifier(input.projectId, "g5Input.projectId");
  const rawDimensions = plainRecord(input.dimensions, "g5Input.dimensions");
  if (Reflect.ownKeys(rawDimensions).some(key => typeof key !== "string" || !G5_DIMENSIONS.includes(key as G5Dimension))) {
    throw new TypeError("g5Input.dimensions contains an unsupported dimension.");
  }

  const source = new Map<G5Dimension, { old: G5Snapshot | null; current: G5Snapshot | null; changed: Set<string> }>();
  for (const dimension of G5_DIMENSIONS) {
    const raw = rawDimensions[dimension];
    if (raw === undefined) { source.set(dimension, { old: null, current: null, changed: new Set() }); continue; }
    const pair = plainRecord(raw, `g5Input.dimensions.${dimension}`);
    if (!Object.hasOwn(pair, "old") || !Object.hasOwn(pair, "new")) throw new TypeError(`${dimension} requires exact old and new snapshots.`);
    const old = pair.old === null ? null : snapshot(pair.old, projectId, `${dimension}.old`);
    const current = pair.new === null ? null : snapshot(pair.new, projectId, `${dimension}.new`);
    if (!old || !current) { source.set(dimension, { old, current, changed: new Set() }); continue; }
    if (old.revisionId === current.revisionId && stable(old.records) !== stable(current.records)) {
      throw new TypeError(`${dimension} reused one immutable revision ID for different records.`);
    }
    const before = new Map(old.records.map(record => [record.id, stable(record)]));
    const after = new Map(current.records.map(record => [record.id, stable(record)]));
    const changed = new Set([...before.keys(), ...after.keys()].filter(id => before.get(id) !== after.get(id)));
    source.set(dimension, { old, current, changed });
  }

  const results = Object.create(null) as Record<G5Dimension, G5DimensionResult>;
  const inventoryIncomplete = [...source.values()].some(pair => !pair.old || !pair.current);
  for (const dimension of G5_DIMENSIONS) {
    const pair = source.get(dimension)!;
    if (!pair.old || !pair.current) {
      results[dimension] = Object.freeze({ status: "UNKNOWN", oldRevisionId: pair.old?.revisionId ?? null,
        newRevisionId: pair.current?.revisionId ?? null, candidates: Object.freeze([]) });
      continue;
    }
    const direct = new Set(pair.changed);
    const candidates = new Map<string, G5Candidate>();
    for (const id of direct) candidates.set(id, Object.freeze({ dimension, recordId: id,
      basis: "direct-revision-diff", via: Object.freeze([id]) }));
    const changedRefs = new Set<string>();
    for (const [changedDimension, changedPair] of source) {
      for (const id of changedPair.changed) {
        changedRefs.add(id);
        for (const row of [...(changedPair.old?.records ?? []), ...(changedPair.current?.records ?? [])]) {
          if (row.id === id) references(row).forEach(reference => changedRefs.add(reference));
        }
      }
    }
    const oldRecords = new Map(pair.old.records.map(row => [row.id, row]));
    const newRecords = new Map(pair.current.records.map(row => [row.id, row]));
    for (const [id, row] of [...oldRecords, ...newRecords]) {
      if (direct.has(id) || !references(row).some(reference => changedRefs.has(reference))) continue;
      const prior = candidates.get(id);
      const via = [...new Set([...(prior?.via ?? []), ...references(row).filter(reference => changedRefs.has(reference))])].sort();
      candidates.set(id, Object.freeze({ dimension, recordId: id, basis: "derived-reference", via: Object.freeze(via) }));
    }
    const list = Object.freeze([...candidates.values()].sort((a, b) => a.recordId.localeCompare(b.recordId)));
    results[dimension] = Object.freeze({ status: inventoryIncomplete ? "UNKNOWN"
      : list.length ? "CANDIDATES" : "NO_CANDIDATE_OBSERVED",
      oldRevisionId: pair.old.revisionId, newRevisionId: pair.current.revisionId, candidates: list });
  }
  return Object.freeze({ projectId, dimensions: Object.freeze(results), approvalCreated: false, executionAuthorized: false });
}
