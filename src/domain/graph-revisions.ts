/**
 * Pure domain validation for the v15 SolutionRevision/GraphPatch contract.
 * This does not authorize callers, persist data, provide atomic CAS, or
 * register/invoke an AI tool; those remain unimplemented integration work.
 */

export const GRAPH_ENTITY_KINDS = [
  "requirement", "feature", "component", "agent", "external-system",
  "data", "workflow", "test", "environment", "approval",
] as const;

export const GRAPH_RELATION_KINDS = [
  "implements", "depends_on", "data_flow", "triggers", "integrates_with",
  "tested_by", "deployed_to", "requires_approval",
] as const;

export type SolutionGraphEntity = Readonly<{
  id: string;
  kind: typeof GRAPH_ENTITY_KINDS[number];
  specRef?: string;
  contractRefs?: readonly string[];
}>;

export type SolutionGraphRelation = Readonly<{
  id: string;
  sourceId: string;
  targetId: string;
  kind: typeof GRAPH_RELATION_KINDS[number];
  contractRef?: string;
}>;

/** Mirrors the v15 conceptual SolutionRevision schema, not BuilderSnapshot.graph. */
export type SolutionRevision = Readonly<{
  approvedSpecRevisionId: string;
  graphRevisionId: string;
  entities: readonly SolutionGraphEntity[];
  relations: readonly SolutionGraphRelation[];
  viewLayoutRef: string;
}>;

export type LeadGraphPatch = Readonly<{
  expectedBaseRevisionId: string | null;
  revision: SolutionRevision;
}>;

export type LeadGraphPatchResult =
  | Readonly<{ status: "conflict"; expectedBaseRevisionId: string | null; actualBaseRevisionId: string | null }>
  | Readonly<{ status: "applied"; revision: SolutionRevision }>;

export type GraphExecutionStatus = "planned" | "running" | "verified" | "blocked";

export type GraphExecutionRecord = Readonly<{
  entityId: string;
  status: GraphExecutionStatus;
  evidenceRefs: readonly string[];
}>;

export type GraphExecutionUpdate = GraphExecutionRecord;

const ENTITY_KIND_SET: ReadonlySet<string> = new Set(GRAPH_ENTITY_KINDS);
const RELATION_KIND_SET: ReadonlySet<string> = new Set(GRAPH_RELATION_KINDS);
const EXECUTION_STATUS_SET: ReadonlySet<string> = new Set(["planned", "running", "verified", "blocked"]);
const MAX_ID = 160;
const MAX_ENTITIES = 20_000;
const MAX_RELATIONS = 40_000;
const MAX_REFERENCES = 1_000;

function record(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain record.`);
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key))
    || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data field.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    throw new TypeError(`${label} must be an array with at most ${maximum} entries.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) throw new TypeError(`${label} must be dense.`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} must be dense.`);
    return descriptor.value;
  });
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID || value.includes("\0")) {
    throw new TypeError(`${label} must be a nonempty identifier of at most ${MAX_ID} characters.`);
  }
  return value;
}

function optionalIdentifier(row: Record<string, unknown>, key: string, label: string): string | undefined {
  return Object.hasOwn(row, key) ? identifier(row[key], `${label}.${key}`) : undefined;
}

function stringList(value: unknown, label: string): readonly string[] {
  const values = list(value, MAX_REFERENCES, label).map((entry, index) => identifier(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicate references.`);
  return Object.freeze(values);
}

function parseEntity(value: unknown, index: number): SolutionGraphEntity {
  const label = `revision.entities[${index}]`;
  const row = record(value, ["id", "kind"], ["specRef", "contractRefs"], label);
  if (typeof row.kind !== "string" || !ENTITY_KIND_SET.has(row.kind)) throw new TypeError(`${label}.kind is unsupported.`);
  const entity = {
    id: identifier(row.id, `${label}.id`),
    kind: row.kind as SolutionGraphEntity["kind"],
    ...(optionalIdentifier(row, "specRef", label) === undefined ? {} : { specRef: row.specRef as string }),
    ...(Object.hasOwn(row, "contractRefs") ? { contractRefs: stringList(row.contractRefs, `${label}.contractRefs`) } : {}),
  };
  return Object.freeze(entity);
}

function parseRelation(value: unknown, index: number): SolutionGraphRelation {
  const label = `revision.relations[${index}]`;
  const row = record(value, ["id", "sourceId", "targetId", "kind"], ["contractRef"], label);
  if (typeof row.kind !== "string" || !RELATION_KIND_SET.has(row.kind)) throw new TypeError(`${label}.kind is unsupported.`);
  const contractRef = optionalIdentifier(row, "contractRef", label);
  return Object.freeze({
    id: identifier(row.id, `${label}.id`),
    sourceId: identifier(row.sourceId, `${label}.sourceId`),
    targetId: identifier(row.targetId, `${label}.targetId`),
    kind: row.kind as SolutionGraphRelation["kind"],
    ...(contractRef === undefined ? {} : { contractRef }),
  });
}

function assertUniqueIds(values: readonly { id: string }[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new TypeError(`${label} contains duplicate IDs.`);
    ids.add(value.id);
  }
  return ids;
}

function assertDependsOnDag(entities: readonly SolutionGraphEntity[], relations: readonly SolutionGraphRelation[]): void {
  const indegree = new Map(entities.map(entity => [entity.id, 0]));
  const outgoing = new Map(entities.map(entity => [entity.id, [] as string[]]));
  for (const relation of relations) {
    if (relation.kind !== "depends_on") continue;
    outgoing.get(relation.sourceId)!.push(relation.targetId);
    indegree.set(relation.targetId, indegree.get(relation.targetId)! + 1);
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const sourceId = ready.pop()!;
    visited += 1;
    for (const targetId of outgoing.get(sourceId)!) {
      const next = indegree.get(targetId)! - 1;
      indegree.set(targetId, next);
      if (next === 0) ready.push(targetId);
    }
  }
  if (visited !== entities.length) throw new TypeError("revision.depends_on relations must form a DAG.");
}

function parseRevision(value: unknown): SolutionRevision {
  const row = record(value, ["approvedSpecRevisionId", "graphRevisionId", "entities", "relations", "viewLayoutRef"], [], "revision");
  const entities = Object.freeze(list(row.entities, MAX_ENTITIES, "revision.entities").map(parseEntity));
  const relations = Object.freeze(list(row.relations, MAX_RELATIONS, "revision.relations").map(parseRelation));
  const entityIds = assertUniqueIds(entities, "revision.entities");
  assertUniqueIds(relations, "revision.relations");
  for (const relation of relations) {
    if (!entityIds.has(relation.sourceId) || !entityIds.has(relation.targetId)) {
      throw new TypeError(`Relation ${relation.id} references an entity outside the revision.`);
    }
  }
  assertDependsOnDag(entities, relations);
  return Object.freeze({
    approvedSpecRevisionId: identifier(row.approvedSpecRevisionId, "revision.approvedSpecRevisionId"),
    graphRevisionId: identifier(row.graphRevisionId, "revision.graphRevisionId"),
    entities,
    relations,
    viewLayoutRef: identifier(row.viewLayoutRef, "revision.viewLayoutRef"),
  });
}

/** Applies a full v15 SolutionRevision only when its expected base is current. */
export function applyLeadGraphPatch(currentValue: unknown, patchValue: unknown): LeadGraphPatchResult {
  const current = currentValue === null ? null : parseRevision(currentValue);
  const patch = record(patchValue, ["expectedBaseRevisionId", "revision"], [], "patch");
  const expected = patch.expectedBaseRevisionId === null
    ? null
    : identifier(patch.expectedBaseRevisionId, "patch.expectedBaseRevisionId");
  const actual = current?.graphRevisionId ?? null;
  if (expected !== actual) return Object.freeze({ status: "conflict", expectedBaseRevisionId: expected, actualBaseRevisionId: actual });

  const revision = parseRevision(patch.revision);
  if (revision.graphRevisionId === actual) throw new TypeError("revision.graphRevisionId must identify a new revision.");
  return Object.freeze({ status: "applied", revision });
}

/**
 * Applies only CTO execution-state updates, separately from Lead design revisions.
 * The caller must authorize the CTO scope before invoking this pure function.
 */
export function applyCtoExecutionUpdates(
  solutionRevision: SolutionRevision,
  currentValue: unknown,
  updatesValue: unknown,
): readonly GraphExecutionRecord[] {
  const revision = parseRevision(solutionRevision);
  const entityIds = new Set(revision.entities.map(entity => entity.id));
  const current = list(currentValue, MAX_ENTITIES, "executionState").map(parseExecutionRecord);
  const updates = list(updatesValue, MAX_ENTITIES, "updates").map(parseExecutionRecord);
  const currentById = new Map(current.map(record => [record.entityId, record]));
  if (currentById.size !== current.length) throw new TypeError("executionState contains duplicate entity IDs.");
  const updateIds = new Set<string>();
  for (const update of updates) {
    if (!entityIds.has(update.entityId)) throw new TypeError(`Execution update references unknown entity ${update.entityId}.`);
    if (updateIds.has(update.entityId)) throw new TypeError("updates contains duplicate entity IDs.");
    updateIds.add(update.entityId);
  }
  for (const existing of current) {
    if (!entityIds.has(existing.entityId)) throw new TypeError(`Execution state references unknown entity ${existing.entityId}.`);
  }
  for (const update of updates) currentById.set(update.entityId, update);
  return Object.freeze([...currentById.values()].map(record => Object.freeze({
    entityId: record.entityId,
    status: record.status,
    evidenceRefs: Object.freeze([...record.evidenceRefs]),
  })));
}

function parseExecutionRecord(value: unknown): GraphExecutionRecord {
  const row = record(value, ["entityId", "status", "evidenceRefs"], [], "execution record");
  if (typeof row.status !== "string" || !EXECUTION_STATUS_SET.has(row.status)) throw new TypeError("execution record.status is unsupported.");
  const evidenceRefs = stringList(row.evidenceRefs, "execution record.evidenceRefs");
  if (row.status === "verified" && evidenceRefs.length === 0) {
    throw new TypeError("Verified execution status requires evidence.");
  }
  return Object.freeze({
    entityId: identifier(row.entityId, "execution record.entityId"),
    status: row.status as GraphExecutionStatus,
    evidenceRefs,
  });
}
