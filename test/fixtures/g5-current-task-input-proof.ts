import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SpsActionContext } from "@sonparkserver/plugin-sdk/platform";
import { workstreamInstructionDigest } from "../../src/cto-delivery-store.ts";
import { dispatchCtoWorkstream } from "../../src/cto-workstream-delivery.ts";
import { createDesignBaselineStore, publishDesignBaseline } from "../../src/design-baseline-tools.ts";
import { createDesignDraftStore } from "../../src/design-draft-store.ts";
import { taskPacketRecordDigest } from "../../src/domain/task-packets.ts";
import { readCurrentG5TaskInputProof } from "../../src/g5-change-impact-tools.ts";
import { createBuilderPlatform } from "../../src/platform.ts";
import { approveFirstDesignReview, proposeFirstDesignReview } from "../../src/spec-assurance/review-first-design.ts";
import { createTaskPacketStore, resolveCtoTaskAuthority } from "../../src/task-packet-tools.ts";
import { publishTechnologyDecisions } from "../../src/technology-decision-tools.ts";
import { createUiContractStore } from "../../src/ui-contracts/store.ts";
import { acknowledgeWorkstream, createWorkstreamStore, publishWorkstream } from "../../src/workstream-tools.ts";
import { A, C, CTO, W, ctx, fixture, key, mapKey } from "./cto-platform.ts";
import { prepareApprovedTaskFileDesign } from "./task-file-approved-design.ts";

const UI = "77777777-7777-4777-8777-777777777777";
const scope = { projectId: W, ctoId: CTO, workstreamId: "ws-1" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const status = (result: { data?: unknown }) => (result.data as { status: string }).status;
type Variant = "same" | "no-ack" | "old-source" | "linked-design" | "qa-plan" | "dependency-plan";

/** Real Builder journals and producers; Core requests/Runs and the user actor
 * are synthetic. No Worker, protected test, model or OS process is executed. */
export async function createCurrentG5TaskInputFixture(variant: Variant = "same") {
  const f = await fixture(W), design = await prepareApprovedTaskFileDesign(f);
  const tools = createBuilderPlatform().tools;
  const publishTask = tools.find(tool => tool.name === "builder.publish-task-packet")!.handler;
  const readImpact = tools.find(tool => tool.name === "builder.read-change-impact")!.handler;
  const workstreams = createWorkstreamStore(W, W, f.state), tasks = createTaskPacketStore(W, W, CTO, "ws-1", f.state);
  const actor = { companyId: W, state: f.state, actor: { type: "user", companyId: W, userId: "synthetic-proof-reviewer" } } as unknown as SpsActionContext;
  const leadKey = key("lead-sessions.v1.1"), lead = await f.state.get(leadKey) as { sessions: Record<string, string | null> };
  f.values.set(mapKey(leadKey), { ...lead, sessions: { ...lead.sessions, "ui-design": UI } });
  const ui = createUiContractStore(W, W, f.state);
  async function publishUi(revisionId: string, baseline: typeof design.baseline, prior: string | null) {
    const html = "<main>Exact feature</main>", htmlSha256 = sha(html), proposalRevisionId = `${revisionId}-proposal`, approvalRevisionId = `${revisionId}-approval`;
    assert.equal((await ui.propose({ revisionId: proposalRevisionId, expectedBaseRevisionId: prior && `${prior}-proposal`,
      source: { kind: "baseline", revisionId: baseline.revisionId }, artifact: { artifactId: `${revisionId}-html`, html, htmlSha256,
        screenIds: ["home"], viewport: { width: 1280, height: 800 }, sourceSessionId: UI, sourceSpecRevisionId: baseline.specification.revisionId },
      contract: { projectId: W, revisionId: `${revisionId}-contract`, screenIds: ["home"], interactions: [{ id: "feature-ui", screenId: "home",
        requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [], outcomes: ["Feature works"],
        prohibited: [], validationCriteria: ["Feature visible"], status: "specified" }] } }, ctx(UI), f.platform)).status, "published");
    assert.equal((await ui.approveProposalAction({ revisionId: approvalRevisionId, expectedBaseRevisionId: prior && `${prior}-approval`,
      proposalRevisionId, htmlSha256, approvedInteractionIds: ["feature-ui"] }, actor)).status, "published");
    assert.equal((await ui.publishFormal({ revisionId, expectedBaseRevisionId: prior, proposalRevisionId, approvalRevisionId }, ctx(), f.platform)).status, "published");
  }
  async function dispatch(boardRevisionId: string, specRevision: number) {
    const prior = (await f.deliveryStore().current())?.revision.runId;
    if (prior) f.runs.set(prior, { ...f.runs.get(prior)!, status: "failed", error: "Fixture planning ended.", errorCode: "fixture-ended" });
    assert.equal(status(await dispatchCtoWorkstream({ projectId: W, workstreamId: "ws-1", boardRevisionId, specRevision }, ctx(), f.platform)), "submitted");
    return (await f.deliveryStore().current())!.revision;
  }
  const base = { ...scope, title: "Feature", goal: "Implement the feature", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"],
    included: ["Feature"], excluded: [], constraints: [], acceptance: ["Exact feature"], evidenceRequired: ["Source"], reuse: [] };
  async function publishGroup(version: number, ctoRun: string, expected: string | null, drift: Variant = "same") {
    const revisionId = `proof-tasks-${version}`;
    const packet = { ...base, taskId: "qa", revision: version, kind: "qa", dependencies: ["implementation"],
      testPlan: { environment: "fixture", steps: [drift === "qa-plan" ? "Changed QA plan" : "Check exact feature"],
        expectedResults: ["Feature works"], passCriteria: ["Exact scoped result"] } };
    const additionalPackets = [
      { ...base, taskId: "implementation", revision: version, kind: "development", dependencies: ["support"], testPlan: null },
      { ...base, taskId: "support", revision: version, kind: "development", dependencies: [], testPlan: null,
        goal: drift === "dependency-plan" ? "Changed transitive dependency" : base.goal },
    ];
    assert.equal(status(await publishTask({ ...scope, expectedBaseRevisionId: expected, revisionId, packet, additionalPackets } as never,
      ctx(C, ctoRun) as never, f.platform)), "published");
    return (await tasks.current())!;
  }
  await publishUi("proof-ui-old", design.baseline, null);
  const initialDelivery = await dispatch(design.params.boardRevisionId, design.params.specRevision);
  const prior = await publishGroup(1, initialDelivery.runId!, null);

  const drafts = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, f.state), draftHead = (await drafts.current())!.revision;
  const originalTurn = await f.state.get(key(`lead-chat.turn.v1.${design.approvedDesign.sourceId.slice("lead-turn:".length)}`)) as {
    text: string; sequence: number; requestId: string;
  };
  const requestId = "66666666-6666-4666-8666-666666666666", sourceId = `lead-turn:${requestId}`, text = "Add independent documentation.";
  f.values.set(mapKey(key(`lead-chat.turn.v1.${requestId}`)), { ...originalTurn, requestId,
    previousRequestId: originalTurn.requestId, sequence: originalTurn.sequence + 1, text });
  const draft = { ...draftHead.draft, revisionId: "proof-draft-new", sourceIds: [...draftHead.draft.sourceIds, sourceId],
    specification: { ...draftHead.draft.specification, revisionId: "proof-spec-new", requirements: [...draftHead.draft.specification.requirements,
      { id: "REQ-2", description: "Documentation", acceptanceCriteriaIds: ["AC-2"] }] },
    graph: { ...draftHead.draft.graph, graphRevisionId: "proof-graph-new",
      entities: [...draftHead.draft.graph.entities, { id: "documentation", kind: "feature" as const, specRef: "REQ-2" }],
      relations: variant === "linked-design" ? [{ id: "new-link", sourceId: "feature", targetId: "documentation", kind: "depends_on" as const }] : [] } };
  assert.equal((await drafts.publish({ expectedBaseRevisionId: draftHead.draft.revisionId,
    revision: { ...draftHead, draft, sourceDigests: [...draftHead.sourceDigests, { id: sourceId, sha256: sha(text) }] } })).status, "published");
  const criteria = [{ requirementId: "REQ-1", acId: "AC-1", sourceId: design.approvedDesign.sourceId, quote: originalTurn.text },
    { requirementId: "REQ-2", acId: "AC-2", sourceId, quote: text }];
  const proposal = await proposeFirstDesignReview({ projectId: W, expectedDraftRevisionId: draft.revisionId,
    expectedReviewHeadRevisionId: design.approvedDesign.approvalRevisionId,
    pack: { packId: "task-file-design", version: "1.0.0", applicability: {}, rules: [], transitions: [], exceptions: [], excludedCombinations: [] },
    sourcePins: criteria.map(({ requirementId, acId, sourceId }) => ({ requirementId, acId, sourceId })),
    designModel: { facts: [], rulesVersion: "task-file-design-v1", coverageRules: [], coverageTargets: [], scenarios: [],
      itemDecisions: criteria.map(({ requirementId, sourceId }) => ({ requirementId, status: "RESOLVED",
        reason: "Exact user-reviewed scoped feature.", sourceIds: [sourceId] })), acceptanceCriteria: criteria } }, ctx(), f.platform);
  assert(proposal.revision);
  const approval = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposal.revision.revisionId }, actor);
  assert("revision" in approval && approval.revision);
  assert.equal(status(await publishDesignBaseline({ projectId: W, expectedBaseRevisionId: design.baseline.revisionId,
    sourceDraftRevisionId: draft.revisionId, revisionId: "proof-baseline-new", userSourceId: `first-design-review:${approval.revision.revisionId}`,
    interpretation: "Approve exact disconnected documentation." }, ctx(), f.platform)), "published");
  const baseline = (await createDesignBaselineStore(W, W, f.state).current())!.revision;
  await publishUi("proof-ui-new", baseline, "proof-ui-old");
  const techId = "proof-tech-new";
  assert.equal(status(await publishTechnologyDecisions({ projectId: W, expectedBaseRevisionId: design.instruction.spec.technologyDecisionsRef,
    register: { projectId: W, revisionId: techId, sourceBaselineRevisionId: baseline.revisionId,
      sourceSpecRevisionId: baseline.specification.revisionId, sourceGraphRevisionId: baseline.graph.graphRevisionId, entries: [] } }, ctx(), f.platform)), "published");
  const pairedSpec = { ...design.instruction.spec, revision: design.instruction.spec.revision + 1,
    sourceSpecRevisionId: baseline.specification.revisionId, technologyDecisionsRef: techId };
  assert.equal(status(await publishWorkstream({ projectId: W, expectedBaseRevisionId: design.params.boardRevisionId,
    revisionId: "proof-ws-pair", spec: pairedSpec, change: { ...design.instruction.change, previousRevision: design.instruction.spec.revision } },
  ctx(), f.platform)), "published");
  const pairedDelivery = await dispatch("proof-ws-pair", pairedSpec.revision);
  const compared = await publishGroup(2, pairedDelivery.runId!, prior.revision.revisionId);
  const pair = { projectId: W, oldBaselineRevisionId: design.baseline.revisionId, newBaselineRevisionId: baseline.revisionId,
    oldUiRevisionId: "proof-ui-old", newUiRevisionId: "proof-ui-new",
    technology: { oldRevisionId: design.instruction.spec.technologyDecisionsRef, newRevisionId: techId },
    workstreams: { oldRevisionId: design.params.boardRevisionId, newRevisionId: "proof-ws-pair" },
    tasks: { ctoId: CTO, workstreamId: "ws-1", oldRevisionId: prior.revision.revisionId, newRevisionId: compared.revision.revisionId } };
  const projected = (await readImpact({ ...pair, projection: "revalidation" } as never, ctx() as never, f.platform)).data as unknown as {
    g5WorkstreamHandoffProposals: { g5Handoff: { impactSha256: string; affectedTaskIds: string[] } }[];
  };
  const handoff = projected.g5WorkstreamHandoffProposals[0]!.g5Handoff;
  const handoffSpec = { ...pairedSpec, revision: pairedSpec.revision + 1 };
  assert.equal(status(await publishWorkstream({ projectId: W, expectedBaseRevisionId: "proof-ws-pair", revisionId: "proof-ws-handoff",
    spec: handoffSpec, change: { ...design.instruction.change, previousRevision: pairedSpec.revision,
      g5Handoff: handoff, impactTaskIds: handoff.affectedTaskIds } }, ctx(), f.platform)), "published");
  const currentDelivery = await dispatch("proof-ws-handoff", handoffSpec.revision);
  if (variant !== "no-ack") assert.equal(status(await acknowledgeWorkstream({ ...scope, expectedBaseRevisionId: "proof-ws-handoff",
    revisionId: "proof-ws-ack", specRevision: handoffSpec.revision, readiness: "ready", note: "Exact G5 scope reviewed." },
  ctx(C, currentDelivery.runId!), f.platform)), "published");
  if (variant !== "old-source") await publishGroup(3, currentDelivery.runId!, compared.revision.revisionId, variant);
  const authority = await resolveCtoTaskAuthority(W, CTO, "ws-1", ctx(C, currentDelivery.runId!), f.platform, "builder.verify-workstream");
  const workstream = (await workstreams.current())!.revision.workstreams[0]!;
  const current = (await tasks.current())!, taskRecord = current.revision.packets.find(row => row.packet.taskId === "implementation")!;
  const input = { workspaceId: W, ...scope, taskId: "implementation", qaTaskId: "qa", workstream, taskRecord,
    currentRequestId: authority.source.requestId, assertCurrent: authority.check, state: f.state };
  return { f, input, prior, compared, current, handoff, workstreams, tasks, currentDelivery,
    read: () => readCurrentG5TaskInputProof(input), publishGroup };
}
