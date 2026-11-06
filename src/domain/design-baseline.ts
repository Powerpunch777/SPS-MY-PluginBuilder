import { applyLeadGraphPatch, type SolutionRevision } from "./graph-revisions.ts";
import { parseApprovedSpecRevision, type ApprovedSpecRevision } from "./specification-revisions.ts";

export type DesignBaseline = Readonly<{
  projectId: string;
  revisionId: string;
  sourceDraftRevisionId: string;
  draftDigest: string;
  createdAt: string;
  author: Readonly<{
    agentId: string;
    sessionId: string;
    runId: string;
    selectionRevision: number;
  }>;
  userDecision: Readonly<{
    sourceId: string;
    sourceSha256: string;
    interpretation: string;
  }>;
  specification: ApprovedSpecRevision;
  graph: SolutionRevision;
}>;

const encoder = new TextEncoder();
const MAX_ID_LENGTH = 160;
const MAX_TOTAL_BYTES = 160 * 1024;
const HEX_256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty identifier of at most ${MAX_ID_LENGTH} characters without ASCII controls.`);
  }
  return value;
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical UUID.`);
  return value;
}

function canonicalIso(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("createdAt must be a canonical ISO timestamp.");
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError("createdAt must be a canonical ISO timestamp.");
  }
  return value;
}

/**
 * Validates a Lead-recorded internal interpretation of a user design decision.
 * It does not verify source existence, legal approval, authorization, persistence, or execution.
 */
export function parseDesignBaseline(value: unknown, projectId: string): DesignBaseline {
  const expectedProjectId = identifier(projectId, "projectId");
  const row = record(value, [
    "projectId", "revisionId", "sourceDraftRevisionId", "draftDigest", "createdAt",
    "author", "userDecision", "specification", "graph",
  ], "designBaseline");

  const actualProjectId = identifier(row.projectId, "designBaseline.projectId");
  if (actualProjectId !== expectedProjectId) throw new TypeError("designBaseline.projectId does not match the expected project.");

  const revisionId = identifier(row.revisionId, "designBaseline.revisionId");
  const sourceDraftRevisionId = identifier(row.sourceDraftRevisionId, "designBaseline.sourceDraftRevisionId");
  if (revisionId === sourceDraftRevisionId) throw new TypeError("Baseline and source draft revision IDs must differ.");
  if (typeof row.draftDigest !== "string" || !HEX_256.test(row.draftDigest)) {
    throw new TypeError("draftDigest must be 64 lowercase hexadecimal characters.");
  }
  const createdAt = canonicalIso(row.createdAt);

  const authorRow = record(row.author, ["agentId", "sessionId", "runId", "selectionRevision"], "author");
  const selectionRevision = authorRow.selectionRevision;
  if (typeof selectionRevision !== "number" || !Number.isSafeInteger(selectionRevision) || selectionRevision <= 0) {
    throw new TypeError("author.selectionRevision must be a positive safe integer.");
  }
  const author = Object.freeze({
    agentId: canonicalUuid(authorRow.agentId, "author.agentId"),
    sessionId: canonicalUuid(authorRow.sessionId, "author.sessionId"),
    runId: canonicalUuid(authorRow.runId, "author.runId"),
    selectionRevision,
  });

  const decisionRow = record(row.userDecision, ["sourceId", "sourceSha256", "interpretation"], "userDecision");
  const sourceId = decisionRow.sourceId;
  if (typeof sourceId !== "string" || !/^lead-turn:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sourceId)) {
    throw new TypeError("userDecision.sourceId must be a lead-turn ID with a canonical UUID.");
  }
  if (typeof decisionRow.sourceSha256 !== "string" || !HEX_256.test(decisionRow.sourceSha256)) {
    throw new TypeError("userDecision.sourceSha256 must be 64 lowercase hexadecimal characters.");
  }
  if (typeof decisionRow.interpretation !== "string" || decisionRow.interpretation.trim().length === 0
    || encoder.encode(decisionRow.interpretation).byteLength > 8192) {
    throw new TypeError("userDecision.interpretation must be nonblank and at most 8192 UTF-8 bytes.");
  }
  const userDecision = Object.freeze({
    sourceId,
    sourceSha256: decisionRow.sourceSha256,
    interpretation: decisionRow.interpretation,
  });

  const specification = parseApprovedSpecRevision(row.specification, expectedProjectId);
  if (specification.approvalEvidenceRef !== userDecision.sourceId) {
    throw new TypeError("specification.approvalEvidenceRef must match userDecision.sourceId.");
  }

  const graphResult = applyLeadGraphPatch(null, {
    expectedBaseRevisionId: null,
    revision: row.graph,
  });
  if (graphResult.status !== "applied") throw new TypeError("Graph revision could not be validated.");
  const graph = graphResult.revision;
  if (graph.approvedSpecRevisionId !== specification.revisionId) {
    throw new TypeError("graph.approvedSpecRevisionId must match specification.revisionId.");
  }
  if (graph.graphRevisionId === specification.revisionId) {
    throw new TypeError("Graph and specification revision IDs must differ.");
  }
  const requirementIds = new Set(specification.requirements.map(requirement => requirement.id));
  for (const entity of graph.entities) {
    if (entity.specRef !== undefined && !requirementIds.has(entity.specRef)) {
      throw new TypeError(`Graph entity ${entity.id} references an undeclared requirement.`);
    }
  }

  const baseline: DesignBaseline = Object.freeze({
    projectId: actualProjectId,
    revisionId,
    sourceDraftRevisionId,
    draftDigest: row.draftDigest,
    createdAt,
    author,
    userDecision,
    specification,
    graph,
  });
  if (encoder.encode(JSON.stringify(baseline)).byteLength > MAX_TOTAL_BYTES) {
    throw new TypeError(`designBaseline exceeds the ${MAX_TOTAL_BYTES}-byte validated JSON limit.`);
  }
  return baseline;
}
