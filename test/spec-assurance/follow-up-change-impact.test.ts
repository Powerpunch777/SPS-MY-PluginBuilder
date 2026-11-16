import assert from "node:assert/strict";
import test from "node:test";
import { compareFollowUpDraftImpact } from "../../src/spec-assurance/follow-up-change-impact.ts";

const projectId = "project-1";
const digest = "a".repeat(64);

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    projectId, revisionId: "baseline-r01", sourceDraftRevisionId: "draft-prior", draftDigest: digest,
    createdAt: "2026-11-02T01:02:03.004Z",
    author: { agentId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333", selectionRevision: 1 },
    userDecision: { sourceId: "lead-turn:44444444-4444-4444-8444-444444444444", sourceSha256: digest,
      interpretation: "Prior approved design." },
    specification: { projectId, revisionId: "spec-prior", productTier: "M",
      requirements: [{ id: "REQ-1", description: "Old requirement", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["desktop"], dataPolicyRef: "policy-r01", approvalEvidenceRef: "lead-turn:44444444-4444-4444-8444-444444444444" },
    graph: { approvedSpecRevisionId: "spec-prior", graphRevisionId: "graph-prior",
      entities: [{ id: "feature-1", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] }],
      relations: [], viewLayoutRef: "layout-prior" },
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    projectId, revisionId: "draft-pending", sourceIds: ["lead-turn:55555555-5555-4555-8555-555555555555"],
    specification: { revisionId: "spec-pending", productTier: "M",
      requirements: [{ id: "REQ-1", description: "Changed requirement", acceptanceCriteriaIds: ["AC-1", "AC-2"] }],
      targets: ["desktop"], dataPolicyRef: "policy-r02" },
    graph: { graphRevisionId: "graph-pending",
      entities: [{ id: "feature-1", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] }],
      relations: [], viewLayoutRef: "layout-prior" },
    questions: [],
    ...overrides,
  };
}

test("compares a prior Baseline with a pending Draft and reports only validated requirement/Graph candidates", () => {
  const result = compareFollowUpDraftImpact({ projectId, priorBaseline: baseline(), pendingDraft: draft() });
  assert.equal(result.overallStatus, "UNKNOWN");
  assert.equal(result.dimensions.requirements.status, "CANDIDATES");
  assert.deepEqual(result.dimensions.requirements.candidates.map(item => item.recordId), ["REQ-1"]);
  assert.equal(result.dimensions.graph.status, "CANDIDATES");
  assert.deepEqual(result.dimensions.graph.candidates.map(item => item.recordId), ["feature-1"]);
  assert.equal(result.dimensions.ui.status, "UNKNOWN");
  assert.equal(result.dimensions.technology.status, "UNKNOWN");
  assert.equal(result.dimensions.ctoWorkstreams.status, "UNKNOWN");
  assert.equal(result.dimensions.tasks.status, "UNKNOWN");
  assert.equal(result.dimensions.scheduleProductScope.status, "UNKNOWN");
  assert.equal(result.sourceIdentity.journalBinding, "NOT_VERIFIED_BY_PURE_HELPER");
  assert.equal(result.completeness.noCandidateMeaning, "NO_CANDIDATE_OBSERVED_IN_THIS_DIMENSION_ONLY_NOT_NO_IMPACT");
  assert.equal(result.approvalCreated, false);
  assert.equal(result.baselinePublished, false);
  assert.equal(result.executionAuthorized, false);
});

test("uses NO_CANDIDATE_OBSERVED only for complete local dimensions and leaves overall impact UNKNOWN", () => {
  const unchanged = baseline();
  const pending = draft({ specification: { ...draft().specification, requirements: baseline().specification.requirements },
    graph: { ...draft().graph, entities: baseline().graph.entities } });
  const result = compareFollowUpDraftImpact({ projectId, priorBaseline: unchanged, pendingDraft: pending });
  assert.equal(result.dimensions.requirements.status, "NO_CANDIDATE_OBSERVED");
  assert.equal(result.dimensions.graph.status, "NO_CANDIDATE_OBSERVED");
  assert.equal(result.overallStatus, "UNKNOWN");
  assert.equal(result.dimensions.ui.status, "UNKNOWN");
});

test("rejects cross-project and same-revision mutated evidence rather than comparing it", () => {
  assert.throws(() => compareFollowUpDraftImpact({ projectId, priorBaseline: baseline({ projectId: "project-2" }), pendingDraft: draft() }),
    /does not match the expected project/u);
  const sameRevisionDraft = draft({ specification: { ...draft().specification, revisionId: "spec-prior" } });
  assert.throws(() => compareFollowUpDraftImpact({ projectId, priorBaseline: baseline(), pendingDraft: sameRevisionDraft }),
    /reused one immutable revision ID/u);
  const sameGraphRevisionDraft = draft({ graph: { ...draft().graph, graphRevisionId: "graph-prior", viewLayoutRef: "layout-mutated" } });
  assert.throws(() => compareFollowUpDraftImpact({ projectId, priorBaseline: baseline(), pendingDraft: sameGraphRevisionDraft }),
    /reused one immutable revision ID/u);
});

test("rejects malformed or caller-extended inputs", () => {
  assert.throws(() => compareFollowUpDraftImpact({ projectId, priorBaseline: baseline(), pendingDraft: draft(), approved: true }),
    /unknown or missing fields/u);
  assert.throws(() => compareFollowUpDraftImpact({ projectId, priorBaseline: baseline(), pendingDraft: { ...draft(), extra: true } }));
});
