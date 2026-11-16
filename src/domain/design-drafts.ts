import { parseApprovedSpecRevision, type DeliveryTarget, type ProductTier } from "./specification-revisions.ts";
import { applyLeadGraphPatch, type SolutionGraphEntity, type SolutionGraphRelation } from "./graph-revisions.ts";

export type DesignDraftSpecification = Readonly<{
  revisionId: string;
  productTier: ProductTier;
  requirements: readonly Readonly<{ id: string; description: string; acceptanceCriteriaIds: readonly string[] }>[];
  targets: readonly DeliveryTarget[];
  dataPolicyRef: string;
}>;

export type DesignDraftGraph = Readonly<{
  graphRevisionId: string;
  entities: readonly SolutionGraphEntity[];
  relations: readonly SolutionGraphRelation[];
  viewLayoutRef: string;
}>;

export type DesignDraftQuestionOption = Readonly<{ id: string; label: string; tradeoff: string }>;
export type DesignDraftQuestion = Readonly<{
  id: string;
  title: string;
  text: string;
  options: readonly DesignDraftQuestionOption[];
  recommendation: string | null;
}>;

export type DesignDraft = Readonly<{
  projectId: string;
  revisionId: string;
  sourceIds: readonly string[];
  specification: DesignDraftSpecification;
  graph: DesignDraftGraph;
  questions: readonly DesignDraftQuestion[];
}>;

const encoder = new TextEncoder();
const MAX_ID = 160;
const MAX_SOURCE_IDS = 32;
const MAX_QUESTIONS = 50;
const MAX_OPTIONS = 8;
const MAX_TOTAL_BYTES = 128 * 1024;
const SOURCE_ID = /^(?:consultation-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|lead-turn:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const DRAFT_APPROVAL_PLACEHOLDER = "builder-internal-draft-structure-only";

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain record.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain record.`);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label}.${key} must be an enumerable data field.`);
    result[key] = descriptor.value;
  }
  return result;
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a standard array.`);
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length > maximum) throw new TypeError(`${label} must have at most ${maximum} entries.`);
  if (keys.length !== length + 1 || !keys.includes("length")) throw new TypeError(`${label} must be dense and have no extra properties.`);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} must contain dense data.`);
    result.push(descriptor.value);
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty identifier of at most ${MAX_ID} characters without ASCII controls.`);
  }
  return value;
}

function boundedText(value: unknown, maximumBytes: number, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(`${label} must be nonempty and at most ${maximumBytes} UTF-8 bytes.`);
  }
  return value;
}

function parseSpecification(value: unknown, projectId: string): DesignDraftSpecification {
  const row = record(value, ["revisionId", "productTier", "requirements", "targets", "dataPolicyRef"], "specification");
  // This private placeholder invokes structural validation only; it is never returned or treated as evidence.
  const validated = parseApprovedSpecRevision({
    projectId,
    revisionId: row.revisionId,
    productTier: row.productTier,
    requirements: row.requirements,
    targets: row.targets,
    dataPolicyRef: row.dataPolicyRef,
    approvalEvidenceRef: DRAFT_APPROVAL_PLACEHOLDER,
  }, projectId);
  return Object.freeze({
    revisionId: validated.revisionId,
    productTier: validated.productTier,
    requirements: validated.requirements,
    targets: validated.targets,
    dataPolicyRef: validated.dataPolicyRef,
  });
}

function parseGraph(value: unknown, specificationRevisionId: string): DesignDraftGraph {
  const row = record(value, ["graphRevisionId", "entities", "relations", "viewLayoutRef"], "graph");
  // applyLeadGraphPatch validates graph shape, unique IDs, endpoints, and dependency cycles.
  const result = applyLeadGraphPatch(null, {
    expectedBaseRevisionId: null,
    revision: { approvedSpecRevisionId: specificationRevisionId, ...row },
  });
  if (result.status !== "applied") throw new TypeError("Draft graph could not be validated.");
  identifier(result.revision.graphRevisionId, "graph.graphRevisionId");
  identifier(result.revision.viewLayoutRef, "graph.viewLayoutRef");
  for (const entity of result.revision.entities) {
    identifier(entity.id, "graph entity.id");
    if (entity.specRef !== undefined) identifier(entity.specRef, "graph entity.specRef");
    entity.contractRefs?.forEach((reference, index) => identifier(reference, `graph entity.contractRefs[${index}]`));
  }
  for (const relation of result.revision.relations) {
    identifier(relation.id, "graph relation.id");
    identifier(relation.sourceId, "graph relation.sourceId");
    identifier(relation.targetId, "graph relation.targetId");
    if (relation.contractRef !== undefined) identifier(relation.contractRef, "graph relation.contractRef");
  }
  return Object.freeze({
    graphRevisionId: result.revision.graphRevisionId,
    entities: result.revision.entities,
    relations: result.revision.relations,
    viewLayoutRef: result.revision.viewLayoutRef,
  });
}

function parseQuestion(value: unknown, index: number): DesignDraftQuestion {
  const label = `questions[${index}]`;
  const row = record(value, ["id", "title", "text", "options", "recommendation"], label);
  const options = list(row.options, MAX_OPTIONS, `${label}.options`).map((value, optionIndex) => {
    const optionLabel = `${label}.options[${optionIndex}]`;
    const option = record(value, ["id", "label", "tradeoff"], optionLabel);
    return Object.freeze({
      id: identifier(option.id, `${optionLabel}.id`),
      label: boundedText(option.label, 256, `${optionLabel}.label`),
      tradeoff: boundedText(option.tradeoff, 2 * 1024, `${optionLabel}.tradeoff`),
    });
  });
  if (new Set(options.map(option => option.id)).size !== options.length) throw new TypeError(`${label}.options contains duplicate IDs.`);
  const recommendation = row.recommendation === null ? null : identifier(row.recommendation, `${label}.recommendation`);
  if (recommendation !== null && !options.some(option => option.id === recommendation)) {
    throw new TypeError(`${label}.recommendation must identify one of its options.`);
  }
  return Object.freeze({
    id: identifier(row.id, `${label}.id`),
    title: boundedText(row.title, 256, `${label}.title`),
    text: boundedText(row.text, 8 * 1024, `${label}.text`),
    options: Object.freeze(options),
    recommendation,
  });
}

/** Validates and deeply freezes an unapproved Builder draft. References are validated for shape, not existence or authority. */
export function parseDesignDraft(value: unknown, expectedProjectId: string): DesignDraft {
  const expectedId = identifier(expectedProjectId, "expectedProjectId");
  const row = record(value, ["projectId", "revisionId", "sourceIds", "specification", "graph", "questions"], "designDraft");
  const projectId = identifier(row.projectId, "designDraft.projectId");
  if (projectId !== expectedId) throw new TypeError("designDraft.projectId does not match the expected project.");
  const revisionId = identifier(row.revisionId, "designDraft.revisionId");
  const sourceIds = list(row.sourceIds, MAX_SOURCE_IDS, "designDraft.sourceIds").map((source, index) => {
    const sourceId = identifier(source, `designDraft.sourceIds[${index}]`);
    if (!SOURCE_ID.test(sourceId)) throw new TypeError(`designDraft.sourceIds[${index}] has an unsupported source ID format.`);
    return sourceId;
  });
  if (sourceIds.length === 0) throw new TypeError("designDraft.sourceIds must contain at least one source ID.");
  if (new Set(sourceIds).size !== sourceIds.length) throw new TypeError("designDraft.sourceIds contains duplicate IDs.");

  const specification = parseSpecification(row.specification, projectId);
  if (specification.requirements.length === 0 || specification.targets.length === 0) {
    throw new TypeError("Draft specification must contain at least one requirement and one target.");
  }
  const graph = parseGraph(row.graph, specification.revisionId);
  const requirementIds = new Set(specification.requirements.map(requirement => requirement.id));
  for (const entity of graph.entities) {
    if (entity.specRef !== undefined && !requirementIds.has(entity.specRef)) {
      throw new TypeError(`Graph entity ${entity.id} references an undeclared requirement.`);
    }
  }

  const questions = list(row.questions, MAX_QUESTIONS, "designDraft.questions").map(parseQuestion);
  if (new Set(questions.map(question => question.id)).size !== questions.length) throw new TypeError("designDraft.questions contains duplicate IDs.");
  const snapshot: DesignDraft = Object.freeze({ projectId, revisionId, sourceIds: Object.freeze(sourceIds), specification, graph, questions: Object.freeze(questions) });
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_TOTAL_BYTES) {
    throw new TypeError(`designDraft exceeds the ${MAX_TOTAL_BYTES}-byte validated JSON limit.`);
  }
  return snapshot;
}
