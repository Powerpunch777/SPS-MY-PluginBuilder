import { G5_DIMENSIONS, produceG5ChangeImpactCandidates, type G5Candidate, type G5Dimension } from "../domain/g5-change-impact.ts";
import { parseDesignBaseline } from "../domain/design-baseline.ts";
import { parseDesignDraft } from "../domain/design-drafts.ts";

export type FollowUpDimensionResult = Readonly<{
  status: "CANDIDATES" | "NO_CANDIDATE_OBSERVED" | "UNKNOWN";
  priorRevisionId: string | null;
  pendingRevisionId: string | null;
  candidates: readonly G5Candidate[];
  scope: "dimension-local" | "not-produced-for-pending-draft";
}>;

export type FollowUpChangeImpactReport = Readonly<{
  projectId: string;
  sourceIdentity: Readonly<{ priorBaselineRevisionId: string; priorSpecRevisionId: string; priorGraphRevisionId: string;
    pendingDraftRevisionId: string; pendingSpecRevisionId: string; pendingGraphRevisionId: string;
    journalBinding: "NOT_VERIFIED_BY_PURE_HELPER" }>;
  overallStatus: "UNKNOWN";
  dimensions: Readonly<Record<G5Dimension, FollowUpDimensionResult>>;
  completeness: Readonly<{ localComparisonsUseValidatedContent: true; unsupportedDimensions: readonly G5Dimension[];
    noCandidateMeaning: "NO_CANDIDATE_OBSERVED_IN_THIS_DIMENSION_ONLY_NOT_NO_IMPACT" }>;
  approvalCreated: false;
  baselinePublished: false;
  executionAuthorized: false;
}>;

function exactInput(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Follow-up impact input must be a plain record.");
  }
  const keys = ["projectId", "priorBaseline", "pendingDraft"];
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError("Follow-up impact input has unknown or missing fields.");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`Follow-up impact input.${key} must be a data field.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requirementRecords(specification: { requirements: readonly Readonly<{
  id: string; description: string; acceptanceCriteriaIds: readonly string[];
}>[] }) {
  return specification.requirements.map(requirement => ({ ...requirement }));
}

function graphRecords(graph: { entities: readonly Readonly<{ id: string; specRef?: string; contractRefs?: readonly string[] }>[];
  relations: readonly Readonly<{ id: string; sourceId: string; targetId: string; contractRef?: string }>[];
  viewLayoutRef: string }) {
  const records = [
    ...graph.entities.map(entity => ({ ...entity, ...(entity.specRef ? { requirementRefs: [entity.specRef] } : {}) })),
    ...graph.relations.map(relation => ({ ...relation, graphRefs: [relation.sourceId, relation.targetId],
      ...(relation.contractRef ? { uiRefs: [relation.contractRef] } : {}) })),
  ];
  const ids = new Set(records.map(record => record.id));
  let layoutRecordId = "__follow_up_impact_view_layout__";
  while (ids.has(layoutRecordId)) layoutRecordId = `_${layoutRecordId}`;
  return [
    ...records,
    { id: layoutRecordId, viewLayoutRef: graph.viewLayoutRef },
  ];
}

/**
 * Pure pre-approval comparison for a caller-supplied prior Baseline and pending Draft.
 * It validates content, but cannot establish journal publication, current-draft identity,
 * Main/Review authorship, source authority, approval, publication, or execution permission.
 * A consumer must obtain exact current sources through its existing authoritative reader
 * and recheck those bindings before presenting or acting on this projection.
 */
export function compareFollowUpDraftImpact(value: unknown): FollowUpChangeImpactReport {
  const input = exactInput(value);
  if (typeof input.projectId !== "string" || !input.projectId.trim() || input.projectId.length > 160
    || /[\u0000-\u001f\u007f]/u.test(input.projectId)) {
    throw new TypeError("Follow-up impact projectId must be a bounded identifier.");
  }
  const projectId = input.projectId;
  const priorBaseline = parseDesignBaseline(input.priorBaseline, projectId);
  const pendingDraft = parseDesignDraft(input.pendingDraft, projectId);
  const compared = produceG5ChangeImpactCandidates({ projectId, dimensions: {
    requirements: { old: { projectId, revisionId: priorBaseline.specification.revisionId,
      records: requirementRecords(priorBaseline.specification) },
    new: { projectId, revisionId: pendingDraft.specification.revisionId, records: requirementRecords(pendingDraft.specification) } },
    graph: { old: { projectId, revisionId: priorBaseline.graph.graphRevisionId,
      records: graphRecords(priorBaseline.graph) },
    new: { projectId, revisionId: pendingDraft.graph.graphRevisionId, records: graphRecords(pendingDraft.graph) } },
  } });

  const dimensions = Object.create(null) as Record<G5Dimension, FollowUpDimensionResult>;
  for (const dimension of G5_DIMENSIONS) {
    const result = compared.dimensions[dimension];
    const supported = dimension === "requirements" || dimension === "graph";
    dimensions[dimension] = Object.freeze({
      status: !supported ? "UNKNOWN" : result.candidates.length ? "CANDIDATES" : "NO_CANDIDATE_OBSERVED",
      priorRevisionId: supported ? result.oldRevisionId : null,
      pendingRevisionId: supported ? result.newRevisionId : null,
      candidates: supported ? result.candidates : Object.freeze([]),
      scope: supported ? "dimension-local" : "not-produced-for-pending-draft",
    });
  }
  return Object.freeze({
    projectId,
    sourceIdentity: Object.freeze({ priorBaselineRevisionId: priorBaseline.revisionId,
      priorSpecRevisionId: priorBaseline.specification.revisionId, priorGraphRevisionId: priorBaseline.graph.graphRevisionId,
      pendingDraftRevisionId: pendingDraft.revisionId, pendingSpecRevisionId: pendingDraft.specification.revisionId,
      pendingGraphRevisionId: pendingDraft.graph.graphRevisionId, journalBinding: "NOT_VERIFIED_BY_PURE_HELPER" as const }),
    overallStatus: "UNKNOWN" as const,
    dimensions: Object.freeze(dimensions),
    completeness: Object.freeze({ localComparisonsUseValidatedContent: true,
      unsupportedDimensions: Object.freeze(G5_DIMENSIONS.filter(dimension => dimension !== "requirements" && dimension !== "graph")),
      noCandidateMeaning: "NO_CANDIDATE_OBSERVED_IN_THIS_DIMENSION_ONLY_NOT_NO_IMPACT" as const }),
    approvalCreated: compared.approvalCreated,
    baselinePublished: false as const,
    executionAuthorized: compared.executionAuthorized,
  });
}
