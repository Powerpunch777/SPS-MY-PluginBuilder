import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDesignBaselineStore, publishDesignBaseline } from "../../src/design-baseline-tools.ts";
import { createDesignDraftStore } from "../../src/design-draft-store.ts";
import { createTaskPacketStore, publishCtoTaskPacket } from "../../src/task-packet-tools.ts";
import { createUiContractStore } from "../../src/ui-contracts/store.ts";
import { acknowledgeWorkstream, createWorkstreamStore, publishWorkstream } from "../../src/workstream-tools.ts";
import { publishTechnologyDecisions } from "../../src/technology-decision-tools.ts";
import { dispatchCtoWorkstream } from "../../src/cto-workstream-delivery.ts";
import { approveFirstDesignReview, proposeFirstDesignReview, readFirstDesignReviewBundle } from "../../src/spec-assurance/review-first-design.ts";
import { readG5Revalidation } from "../../src/g5-revalidation.ts";
import { createBaselineBodySource } from "../../src/project-documents/baseline-body-source.ts";
import { publishTaskQaReport } from "../../src/task-qa-reports.ts";
import { A, C, CTO, W, ctx, key, mapKey } from "./cto-platform.ts";
import { setupVerifiedWorkstreamPlatform } from "./verified-workstream-platform.ts";

const UI = "91919191-9191-4191-8191-919191919191";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const status = (result: { data?: unknown }) => (result.data as { status: string }).status;
const taskScope = { projectId: W, ctoId: CTO, workstreamId: "ws-1" };

/** Reuses the real old source/acceptance/report producers, then the same public
 * Baseline/UI/Workstream/G5/ACK/Task sequence as the current-G5 fixture. All user,
 * Core session, Git and protected-test responses remain synthetic fixture DTOs. */
export async function createCarriedTaskQaIndependentFixture(options: { latestFailed?: boolean; qaPlanChanged?: boolean } = {}) {
  const setup = await setupVerifiedWorkstreamPlatform(), { f } = setup;
  const baselines = createDesignBaselineStore(W, W, f.state), oldBaseline = (await baselines.current())!.revision;
  const workstreams = createWorkstreamStore(W, W, f.state), oldBoard = (await workstreams.current())!.revision;
  const oldWorkstream = oldBoard.workstreams[0]!;
  const tasks = createTaskPacketStore(W, W, CTO, "ws-1", f.state), prior = (await tasks.current())!;
  const oldReport = (await setup.reportStore().current())!.revision;
  const sessions = f.platform.agents.sessions, getRun = sessions.getRun.bind(sessions), closed = new Set<string>();
  let authorStatus = options.latestFailed ? "running" : "succeeded";
  sessions.getRun = async (sessionId, workspaceId, runId) => {
    const run = await getRun(sessionId, workspaceId, runId);
    if (runId === oldReport.author.runId) return { ...run, status: authorStatus, termination: "not_applicable" };
    return closed.has(runId) ? { ...run, status: "succeeded", termination: "not_applicable" } : run;
  };
  if (options.latestFailed) {
    const binding = oldReport.reference.binding;
    const failed = await publishTaskQaReport({ ...taskScope, qaTaskId: "task-qa", approvalId: binding.approvalId,
      planSha256: binding.planSha256, runId: binding.runId, expectedBaseRevisionId: oldReport.revisionId,
      checks: oldReport.checks.map(check => ({ criterionId: check.criterionId, verdict: "failed", note: "Later fixture finding." })),
      summary: "Latest exact report is failed; the old passing assessment must not be selected." },
    { companyId: W, projectId: W, ...oldReport.author }, f.platform);
    assert.equal(failed.status, "published"); authorStatus = "succeeded";
  }
  const leadKey = key("lead-sessions.v1.1"), lead = await f.state.get(leadKey) as any;
  f.values.set(mapKey(leadKey), { ...lead, sessions: { ...lead.sessions, "ui-design": UI } });
  const actor = { ...f.platform, companyId: W, actor: { type: "user" as const, companyId: W, userId: "synthetic-carry-review-user" } };
  const ui = createUiContractStore(W, W, f.state);
  async function formalUi(revisionId: string, baseline: typeof oldBaseline, previous: string | null) {
    const html = "<main>Unchanged approved feature</main>", htmlSha256 = sha(html);
    const proposalRevisionId = `${revisionId}-proposal`, approvalRevisionId = `${revisionId}-approval`;
    assert.equal((await ui.propose({ revisionId: proposalRevisionId, expectedBaseRevisionId: previous && `${previous}-proposal`,
      source: { kind: "baseline", revisionId: baseline.revisionId }, artifact: { artifactId: `${revisionId}-html`, html, htmlSha256,
        screenIds: ["home"], viewport: { width: 1280, height: 800 }, sourceSessionId: UI, sourceSpecRevisionId: baseline.specification.revisionId },
      contract: { projectId: W, revisionId: `${revisionId}-contract`, screenIds: ["home"], interactions: [{ id: "feature-ui", screenId: "home",
        requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [], outcomes: ["Feature works"],
        prohibited: [], validationCriteria: ["Feature visible"], status: "specified" }] } }, ctx(UI), f.platform)).status, "published");
    assert.equal((await ui.approveProposalAction({ revisionId: approvalRevisionId, expectedBaseRevisionId: previous && `${previous}-approval`,
      proposalRevisionId, htmlSha256, approvedInteractionIds: ["feature-ui"] }, actor as never)).status, "published");
    assert.equal((await ui.publishFormal({ revisionId, expectedBaseRevisionId: previous, proposalRevisionId, approvalRevisionId },
      ctx(), f.platform)).status, "published");
  }
  await formalUi("carry-old-ui", oldBaseline, null);
  const drafts = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, f.state), oldDraft = (await drafts.current())!.revision;
  const oldReview = await readFirstDesignReviewBundle(W, W, f.state); assert(oldReview?.designModel);
  const turnId = "92929292-9292-4292-8292-929292929292", sourceId = `lead-turn:${turnId}`, text = "Add disconnected documentation.";
  const originalTurn = await f.state.get(setup.sourceTurnKey) as any;
  f.values.set(mapKey(key(`lead-chat.turn.v1.${turnId}`)), { ...originalTurn, requestId: turnId,
    previousRequestId: originalTurn.requestId, sequence: originalTurn.sequence + 1, text });
  const draft = { ...oldDraft.draft, revisionId: "carry-design-draft-new", sourceIds: [...oldDraft.draft.sourceIds, sourceId],
    specification: { ...oldDraft.draft.specification, revisionId: "carry-spec-new", requirements: [...oldDraft.draft.specification.requirements,
      { id: "REQ-DOC", description: "Independent documentation", acceptanceCriteriaIds: ["AC-DOC"] }] },
    graph: { ...oldDraft.draft.graph, graphRevisionId: "carry-graph-new",
      entities: [...oldDraft.draft.graph.entities, { id: "documentation", kind: "feature" as const, specRef: "REQ-DOC" }] } };
  assert.equal((await drafts.publish({ expectedBaseRevisionId: oldDraft.draft.revisionId,
    revision: { ...oldDraft, draft, sourceDigests: [...oldDraft.sourceDigests, { id: sourceId, sha256: sha(text) }] } })).status, "published");
  const { identity: _identity, ...pack } = oldReview.pack, model = oldReview.designModel;
  const proposed = await proposeFirstDesignReview({ projectId: W, expectedDraftRevisionId: draft.revisionId,
    expectedReviewHeadRevisionId: oldReview.revisionId, pack,
    sourcePins: [...oldReview.sourcePins.map(({ requirementId, acId, sourceId }) => ({ requirementId, acId, sourceId })),
      { requirementId: "REQ-DOC", acId: "AC-DOC", sourceId }],
    designModel: { facts: model.facts, rulesVersion: model.rulesManifest.rulesVersion, coverageRules: model.rulesManifest.rules,
      coverageTargets: model.rulesManifest.targets, scenarios: model.scenarios,
      itemDecisions: [...model.itemDecisions, { requirementId: "REQ-DOC", status: "RESOLVED", reason: "Approved separate documentation.", sourceIds: [sourceId] }],
      acceptanceCriteria: [...model.acceptanceCriteria.map(({ requirementId, acId, sourceId, text }) => ({ requirementId, acId, sourceId, quote: text })),
        { requirementId: "REQ-DOC", acId: "AC-DOC", sourceId, quote: text }] } }, ctx(), f.platform);
  assert(proposed.revision);
  const approved = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposed.revision.revisionId }, actor as never);
  assert("revision" in approved && approved.revision);
  assert.equal(status(await publishDesignBaseline({ projectId: W, expectedBaseRevisionId: oldBaseline.revisionId,
    sourceDraftRevisionId: draft.revisionId, revisionId: "carry-baseline-new", userSourceId: `first-design-review:${approved.revision.revisionId}`,
    interpretation: "Exact user-reviewed independent documentation." }, ctx(), f.platform)), "published");
  const baseline = (await baselines.current())!.revision;
  await formalUi("carry-new-ui", baseline, "carry-old-ui");
  assert.equal(status(await publishTechnologyDecisions({ projectId: W, expectedBaseRevisionId: oldWorkstream.spec.technologyDecisionsRef,
    register: { projectId: W, revisionId: "carry-technology-new", sourceBaselineRevisionId: baseline.revisionId,
      sourceSpecRevisionId: baseline.specification.revisionId, sourceGraphRevisionId: baseline.graph.graphRevisionId, entries: [] } }, ctx(), f.platform)), "published");
  async function dispatch(boardRevisionId: string, specRevision: number) {
    const runId = (await f.deliveryStore().current())!.revision.runId; assert(runId); closed.add(runId);
    assert.equal(status(await dispatchCtoWorkstream({ projectId: W, workstreamId: "ws-1", boardRevisionId, specRevision }, ctx(), f.platform)), "submitted");
    return (await f.deliveryStore().current())!.revision;
  }
  async function group(revision: number, runId: string, revisionId: string, changePlan = false) {
    const packets = prior.revision.packets.map(record => ({ ...record.packet, revision,
      ...(record.packet.kind === "qa" && changePlan ? { testPlan: { ...record.packet.testPlan!, steps: ["New QA procedure"] } } : {}) }));
    const result = await publishCtoTaskPacket({ ...taskScope, expectedBaseRevisionId: (await tasks.current())!.revision.revisionId,
      revisionId, packet: packets[0], additionalPackets: packets.slice(1) }, ctx(C, runId), f.platform);
    assert.equal(status(result), "published", JSON.stringify(result));
    return (await tasks.current())!;
  }
  const pairedSpec = { ...oldWorkstream.spec, revision: 2, sourceSpecRevisionId: baseline.specification.revisionId,
    technologyDecisionsRef: "carry-technology-new" };
  assert.equal(status(await publishWorkstream({ projectId: W, expectedBaseRevisionId: oldBoard.revisionId, revisionId: "carry-workstreams-compared",
    spec: pairedSpec, change: { ...oldWorkstream.change, previousRevision: 1 } }, ctx(), f.platform)), "published");
  const comparedDelivery = await dispatch("carry-workstreams-compared", 2);
  const compared = await group(2, comparedDelivery.runId!, "carry-tasks-compared");
  const pair = { projectId: W, oldBaselineRevisionId: oldBaseline.revisionId, newBaselineRevisionId: baseline.revisionId,
    oldUiRevisionId: "carry-old-ui", newUiRevisionId: "carry-new-ui",
    technology: { oldRevisionId: oldWorkstream.spec.technologyDecisionsRef, newRevisionId: "carry-technology-new" },
    workstreams: { oldRevisionId: oldBoard.revisionId, newRevisionId: "carry-workstreams-compared" },
    tasks: { ctoId: CTO, workstreamId: "ws-1", oldRevisionId: prior.revision.revisionId, newRevisionId: compared.revision.revisionId } };
  const revalidation = (await readG5Revalidation(pair, ctx(), f.platform)).data as any;
  const handoff = revalidation.g5WorkstreamHandoffProposals[0]?.g5Handoff; assert(handoff);
  assert.equal(status(await publishWorkstream({ projectId: W, expectedBaseRevisionId: "carry-workstreams-compared", revisionId: "carry-workstreams-handoff",
    spec: { ...pairedSpec, revision: 3 }, change: { ...oldWorkstream.change, previousRevision: 2,
      g5Handoff: handoff, impactTaskIds: handoff.affectedTaskIds } }, ctx(), f.platform)), "published");
  const currentDelivery = await dispatch("carry-workstreams-handoff", 3);
  const context = ctx(C, currentDelivery.runId!);
  assert.equal(status(await acknowledgeWorkstream({ ...taskScope, expectedBaseRevisionId: "carry-workstreams-handoff", revisionId: "carry-workstreams-ack",
    specRevision: 3, readiness: "ready", note: "Exact G5-scoped current inputs acknowledged." }, context, f.platform)), "published");
  const current = await group(3, currentDelivery.runId!, "carry-tasks-current", options.qaPlanChanged);
  const docs = createBaselineBodySource(W, W, f.state), previousDocument = (await docs.current())!.revision;
  assert.equal((await docs.publish({ documentRevisionId: "carry-current-baseline-document", expectedDocumentRevisionId: previousDocument.documentRevisionId,
    expectedBaselineRevisionId: baseline.revisionId })).status, "published");
  return { ...setup, context, prior, compared, current, handoff, oldReport, pair, baseline, tasks, workstreams,
    setAuthorStatus(status: string) { authorStatus = status; } };
}
