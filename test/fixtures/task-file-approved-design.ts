import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SpsActionContext } from "@sonparkserver/plugin-sdk/platform";
import type { WorkstreamRecord } from "../../src/domain/workstreams.ts";
import { createDesignDraftStore } from "../../src/design-draft-store.ts";
import { createDesignBaselineStore, publishDesignBaseline } from "../../src/design-baseline-tools.ts";
import { publishTechnologyDecisions } from "../../src/technology-decision-tools.ts";
import { publishWorkstream } from "../../src/workstream-tools.ts";
import { approveFirstDesignReview, proposeFirstDesignReview } from "../../src/spec-assurance/review-first-design.ts";
import { fixture, W, A, S, R, ctx, now, key, mapKey } from "./cto-platform.ts";

const TURN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef";
const SOURCE = `lead-turn:${TURN}`;
const BODY = "Implement the scoped feature and verify the exact submitted source.";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Adds real Builder approval/publication records to a disposable CTO fixture.
 * The authenticated user and Core session transport remain synthetic; no model or provider executes. */
export async function prepareApprovedTaskFileDesign(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.baseline.projectId, W, "approved Task file fixture requires the same Workspace/project scope");
  assert.equal(f.params.projectId, W);
  const originalRuns = structuredClone(f.runs), originalSends = f.sends;
  f.values.set(mapKey(key(`lead-chat.turn.v1.${TURN}`)), {
    workspaceId: W, selectionRevision: 1, agentId: A, sessionId: S, channel: "main", schemaVersion: 1,
    requestId: TURN, previousRequestId: null, sequence: 0, text: BODY, createdAt: now,
    state: "submitted", runId: R, answer: null, outputState: "not_ready", cancellationRequested: false,
    termination: "not_applicable", inputKind: "user",
  });
  const drafts = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, f.state);
  const draft = { projectId: W, revisionId: "task-file-approved-draft", sourceIds: [SOURCE],
    specification: { revisionId: "task-file-draft-spec", productTier: "S" as const,
      requirements: [{ id: "REQ-1", description: "Feature", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["desktop" as const], dataPolicyRef: "local-policy" },
    graph: { graphRevisionId: "task-file-draft-graph", entities: [{ id: "feature", kind: "feature" as const, specRef: "REQ-1" }],
      relations: [], viewLayoutRef: "layout-1" }, questions: [] };
  assert.equal((await drafts.publish({ expectedBaseRevisionId: null, revision: { status: "draft", selectionRevision: 1,
    author: { agentId: A, sessionId: S, runId: R }, sourceDigests: [{ id: SOURCE, sha256: sha(BODY) }], createdAt: now, draft } })).status, "published");
  const proposed = await proposeFirstDesignReview({ projectId: W, expectedDraftRevisionId: draft.revisionId,
    expectedReviewHeadRevisionId: null,
    pack: { packId: "task-file-design", version: "1.0.0", applicability: {}, rules: [], transitions: [], exceptions: [], excludedCombinations: [] },
    sourcePins: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE }],
    designModel: { facts: [], rulesVersion: "task-file-design-v1", coverageRules: [], coverageTargets: [], scenarios: [],
      itemDecisions: [{ requirementId: "REQ-1", status: "RESOLVED", reason: "Exact user-reviewed scoped feature.", sourceIds: [SOURCE] }],
      acceptanceCriteria: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE, quote: BODY }] } }, ctx(), f.platform);
  assert(proposed.revision);
  const approved = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposed.revision.revisionId },
    { companyId: W, state: f.state, actor: { type: "user", companyId: W, userId: "synthetic-file-review-user" } } as unknown as SpsActionContext);
  assert("revision" in approved && approved.revision);
  const published = await publishDesignBaseline({ projectId: W, expectedBaseRevisionId: f.baseline.revisionId,
    sourceDraftRevisionId: draft.revisionId, revisionId: "task-file-approved-baseline",
    userSourceId: `first-design-review:${approved.revision.revisionId}`, interpretation: "Publish the exact scoped file fixture design." }, ctx(), f.platform);
  assert.equal((published.data as { status: string }).status, "published");
  const baseline = (await createDesignBaselineStore(W, W, f.state).current())!.revision;
  const technologyId = "task-file-approved-technology";
  const technology = await publishTechnologyDecisions({ projectId: W, expectedBaseRevisionId: "tech-1", register: {
    projectId: W, revisionId: technologyId, sourceBaselineRevisionId: baseline.revisionId,
    sourceSpecRevisionId: baseline.specification.revisionId, sourceGraphRevisionId: baseline.graph.graphRevisionId, entries: [],
  } }, ctx(), f.platform);
  assert.equal((technology.data as { status: string }).status, "published");
  const boardId = "task-file-approved-workstreams";
  const sourceSpec = { ...f.instruction.spec, revision: f.instruction.spec.revision + 1,
    sourceSpecRevisionId: baseline.specification.revisionId, technologyDecisionsRef: technologyId };
  const board = await publishWorkstream({ projectId: W, expectedBaseRevisionId: f.params.boardRevisionId,
    revisionId: boardId, spec: sourceSpec, change: { ...f.instruction.change, previousRevision: f.instruction.spec.revision,
      reason: "Bind this disposable file fixture to its exact authenticated review.", diff: "Use the current approved design and technology pins." } }, ctx(), f.platform);
  assert.equal((board.data as { status: string }).status, "published");
  const instruction = (board.data as unknown as { revision: { workstreams: WorkstreamRecord[] } }).revision.workstreams[0]!;
  assert.equal(instruction.sourceBaselineRevisionId, baseline.revisionId);
  assert.equal(instruction.baselineDigest, sha(JSON.stringify(baseline)));
  assert.equal(instruction.spec.sourceSpecRevisionId, baseline.specification.revisionId);
  assert.equal(instruction.spec.technologyDecisionsRef, technologyId);
  assert.deepEqual(f.runs, originalRuns, "design proposal, user review and publication must not dispatch a fixture Run");
  assert.equal(f.sends, originalSends);
  return { baseline, instruction, params: { ...f.params, specRevision: sourceSpec.revision, boardRevisionId: boardId },
    approvedDesign: { approvalRevisionId: approved.revision.revisionId, sourceId: SOURCE, sourceSha256: sha(BODY) } };
}
