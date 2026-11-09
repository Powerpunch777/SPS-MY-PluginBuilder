import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SpsActionContext } from "@sonparkserver/plugin-sdk/platform";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { createDesignBaselineStore, publishDesignBaseline } from "../src/design-baseline-tools.ts";
import { createDesignDraftStore, type AuthoredDesignDraft } from "../src/design-draft-store.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { approveFirstDesignReview, proposeFirstDesignReview } from "../src/spec-assurance/review-first-design.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { publishTechnologyDecisions } from "../src/technology-decision-tools.ts";
import { createUiContractStore } from "../src/ui-contracts/store.ts";
import { publishWorkstream } from "../src/workstream-tools.ts";
import { A, C, CTO, R, S, W, ctx, fixture, key, mapKey, now } from "./fixtures/cto-platform.ts";

const UI = "77777777-7777-4777-8777-777777777777";
const scope = { projectId: W, ctoId: CTO, workstreamId: "ws-1" };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const status = (result: { data?: unknown }) => (result.data as { status: string }).status;
const pack = { packId: "g5-fixture", version: "1.0.0", applicability: { all: ["feature.enabled"] },
  rules: [{ id: "check-feature", requirementIds: ["REQ-1"], appliesWhen: {}, requiresCheck: true }],
  transitions: [], exceptions: [], excludedCombinations: [] };

async function publishedPair(change: "disconnected" | "linked-node" | "test-plan" | "stale-dependency" | "failed-batch") {
  const f = await fixture(W);
  const tools = createBuilderPlatform().tools;
  const publishTask = tools.find(tool => tool.name === "builder.publish-task-packet")!.handler;
  const readImpact = tools.find(tool => tool.name === "builder.read-change-impact")!.handler;
  const actor = { companyId: W, state: f.state, actor: { type: "user", companyId: W, userId: "synthetic-g5-reviewer" } } as unknown as SpsActionContext;
  const leadKey = key("lead-sessions.v1.1");
  const lead = await f.state.get(leadKey) as { sessions: Record<string, string | null> };
  f.values.set(mapKey(leadKey), { ...lead, sessions: { ...lead.sessions, "ui-design": UI } });
  const sources = ["66666666-6666-4666-8666-666666666661", "66666666-6666-4666-8666-666666666662"]
    .map((requestId, index) => ({ requestId, id: `lead-turn:${requestId}`,
      text: index === 0 ? "Keep the feature and verify the linked data path." : "Add disconnected documentation." }));
  sources.forEach(({ requestId, text }, sequence) => f.values.set(mapKey(key(`lead-chat.turn.v1.${requestId}`)), {
    workspaceId: W, selectionRevision: 1, agentId: A, sessionId: S, channel: "main", schemaVersion: 1,
    requestId, previousRequestId: sources[sequence - 1]?.requestId ?? null, sequence, text, createdAt: now, state: "submitted",
    runId: R, answer: null, outputState: "not_ready", cancellationRequested: false, termination: "not_applicable", inputKind: "user",
  }));

  const drafts = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, f.state);
  const baselines = createDesignBaselineStore(W, W, f.state);
  const ui = createUiContractStore(W, W, f.state);
  const tasks = createTaskPacketStore(W, W, CTO, scope.workstreamId, f.state);
  let reviewHead: string | null = null, taskHead: string | null = null;
  const basePacket = { ...scope, title: "Scoped feature", goal: "Verify REQ-1", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"],
    included: ["Scoped feature"], excluded: [], constraints: [], acceptance: ["Exact scoped behavior"],
    evidenceRequired: ["Scoped evidence"], reuse: [] };

  async function publishSide(version: 1 | 2) {
    const old = version === 1, previous = version - 1, prefix = `g5-inputs-${version}`;
    const draftId = `${prefix}-draft`, baselineId = `${prefix}-baseline`, technologyId = `${prefix}-tech`, workstreamId = `${prefix}-ws`;
    const selectedSources = sources.slice(0, version);
    const requirements = selectedSources.map((_, i) => ({ id: `REQ-${i + 1}`, description: i ? "Documentation" : "Scoped feature",
      acceptanceCriteriaIds: [`AC-${i + 1}`] }));
    const material: AuthoredDesignDraft = { status: "draft", selectionRevision: 1, author: { agentId: A, sessionId: S, runId: R },
      createdAt: now, sourceDigests: selectedSources.map(({ id, text }) => ({ id, sha256: sha(text) })),
      draft: { projectId: W, revisionId: draftId, sourceIds: selectedSources.map(row => row.id),
        specification: { revisionId: `${prefix}-spec`, productTier: "S", requirements, targets: ["desktop"], dataPolicyRef: "local-policy" },
        graph: { graphRevisionId: `${prefix}-graph`, viewLayoutRef: "layout-1", entities: [
          { id: "feature", kind: "feature", specRef: "REQ-1" }, { id: "bridge", kind: "component" },
          { id: "leaf", kind: !old && change === "linked-node" ? "environment" : "data" },
          ...(old ? [] : [{ id: "documentation", kind: "feature" as const, specRef: "REQ-2" }]),
        ], relations: [
          { id: "feature-bridge", sourceId: "feature", targetId: "bridge", kind: "depends_on" },
          { id: "bridge-leaf", sourceId: "bridge", targetId: "leaf", kind: "depends_on" },
        ] }, questions: [] } };
    assert.equal((await drafts.publish({ expectedBaseRevisionId: old ? null : `g5-inputs-${previous}-draft`, revision: material })).status, "published");
    const criteria = selectedSources.map(({ id, text }, i) => ({ requirementId: `REQ-${i + 1}`, acId: `AC-${i + 1}`, sourceId: id, quote: text }));
    const proposed = await proposeFirstDesignReview({ projectId: W, expectedDraftRevisionId: draftId, expectedReviewHeadRevisionId: reviewHead,
      pack, sourcePins: criteria.map(({ requirementId, acId, sourceId }) => ({ requirementId, acId, sourceId })),
      designModel: { facts: ["feature.enabled"], rulesVersion: "g5-model-v1", scenarios: [],
        coverageRules: [{ id: "check-feature", requiresCheck: true, requiredEvidenceKinds: ["source"] }],
        coverageTargets: [{ targetKind: "requirement", targetId: "REQ-1", ruleIds: ["check-feature"] }],
        itemDecisions: criteria.map(({ requirementId, sourceId }) => ({ requirementId, status: "RESOLVED",
          reason: "Keep this exact source requirement.", sourceIds: [sourceId] })), acceptanceCriteria: criteria } }, ctx(), f.platform);
    assert(proposed.revision);
    const approved = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposed.revision.revisionId }, actor);
    assert("revision" in approved && approved.revision);
    reviewHead = approved.revision.revisionId;
    assert.equal(status(await publishDesignBaseline({ projectId: W, expectedBaseRevisionId: old ? f.baseline.revisionId : `g5-inputs-${previous}-baseline`,
      sourceDraftRevisionId: draftId, revisionId: baselineId, userSourceId: `first-design-review:${reviewHead}`,
      interpretation: "Publish this exact source-reviewed design." }, ctx(), f.platform)), "published");
    const baseline = (await baselines.current())!.revision;
    assert.equal(status(await publishTechnologyDecisions({ projectId: W, expectedBaseRevisionId: old ? "tech-1" : `g5-inputs-${previous}-tech`,
      register: { projectId: W, revisionId: technologyId, sourceBaselineRevisionId: baselineId,
        sourceSpecRevisionId: baseline.specification.revisionId, sourceGraphRevisionId: baseline.graph.graphRevisionId, entries: [] } },
    ctx(), f.platform)), "published");

    const uiId = `${prefix}-ui`, proposalRevisionId = `${uiId}-proposal`, approvalRevisionId = `${uiId}-approval`;
    const priorUi = old ? null : `g5-inputs-${previous}-ui`;
    const html = "<main>Scoped feature</main>", htmlSha256 = sha(html), screenIds = ["home"];
    assert.equal((await ui.propose({ revisionId: proposalRevisionId, expectedBaseRevisionId: priorUi && `${priorUi}-proposal`,
      source: { kind: "baseline", revisionId: baselineId }, artifact: { artifactId: `${uiId}-html`, html, htmlSha256, screenIds,
        viewport: { width: 1280, height: 800 }, sourceSessionId: UI, sourceSpecRevisionId: baseline.specification.revisionId },
      contract: { projectId: W, revisionId: `${uiId}-contract`, screenIds, interactions: [{ id: "feature-ui", screenId: "home",
        requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [], outcomes: ["Feature shown"],
        prohibited: [], validationCriteria: ["Feature visible"], status: "specified" }] } }, ctx(UI), f.platform)).status, "published");
    assert.equal((await ui.approveProposalAction({ revisionId: approvalRevisionId, expectedBaseRevisionId: priorUi && `${priorUi}-approval`,
      proposalRevisionId, htmlSha256, approvedInteractionIds: ["feature-ui"] }, actor)).status, "published");
    assert.equal((await ui.publishFormal({ revisionId: uiId, expectedBaseRevisionId: priorUi, proposalRevisionId, approvalRevisionId },
      ctx(), f.platform)).status, "published");

    const spec = { ...f.instruction.spec, revision: version + 1, sourceSpecRevisionId: baseline.specification.revisionId,
      technologyDecisionsRef: technologyId };
    assert.equal(status(await publishWorkstream({ projectId: W, expectedBaseRevisionId: old ? f.params.boardRevisionId : `g5-inputs-${previous}-ws`,
      revisionId: workstreamId, spec, change: { ...f.instruction.change, previousRevision: version } }, ctx(), f.platform)), "published");
    const priorRun = (await f.deliveryStore().current())?.revision.runId;
    if (priorRun) f.runs.set(priorRun, { ...f.runs.get(priorRun)!, status: "failed", error: "Fixture planning ended.", errorCode: "fixture-ended" });
    assert.equal(status(await dispatchCtoWorkstream({ projectId: W, workstreamId: scope.workstreamId, specRevision: spec.revision,
      boardRevisionId: workstreamId }, ctx(), f.platform)), "submitted");
    const ctoRun = (await f.deliveryStore().current())!.revision.runId!;
    async function publishPackets(revisionId: string, packet: object, additionalPackets?: object[]) {
      const result = await publishTask({ ...scope, expectedBaseRevisionId: taskHead, revisionId, packet,
        ...(additionalPackets === undefined ? {} : { additionalPackets }) } as never, ctx(C, ctoRun) as never, f.platform);
      assert.equal(status(result), "published", JSON.stringify(result.data));
      taskHead = revisionId;
    }
    const implementation = { ...basePacket, taskId: "implementation", revision: version, kind: "development", dependencies: [], testPlan: null };
    const qaPacket = { ...basePacket, taskId: "qa", revision: version, kind: "qa", dependencies: ["implementation"],
      testPlan: { environment: "protected fixture", steps: [!old && change === "test-plan" ? "Check revised expectation" : "Check exact feature"],
        expectedResults: ["Feature works"], passCriteria: ["Scoped check succeeds"] } };
    const taskBoardId = `${prefix}-tasks`;
    if (old) {
      await publishPackets(`${prefix}-implementation`, implementation);
      await publishPackets(taskBoardId, qaPacket);
    } else {
      if (change === "failed-batch") {
        const before = structuredClone(f.values), rejected = `${prefix}-rejected`;
        await assert.rejects(() => publishPackets(rejected, implementation, [{ ...qaPacket, dependencies: ["missing-dependency"] }]),
          /missing-dependency/i);
        assert.deepEqual(f.values, before, "a bad companion must not leave a primary write or an orphan record");
        assert.equal(await tasks.publishedRevision(rejected), null);
      }
      // The primary QA packet depends on its companion; the batch resolves both together.
      await publishPackets(taskBoardId, qaPacket, [implementation]);
      if (change === "stale-dependency") await publishPackets(`${prefix}-stale`, { ...implementation, revision: version + 1 });
    }
    const board = (await tasks.current())!.revision;
    const qa = board.packets.find(row => row.packet.taskId === "qa")!;
    const impl = board.packets.find(row => row.packet.taskId === "implementation")!;
    const recordDigest = (record: typeof qa) => taskPacketRecordDigest(record, W, CTO, scope.workstreamId);
    assert.equal(qa.dependencyPins[0]!.revision, !old && change === "stale-dependency" ? impl.packet.revision - 1 : impl.packet.revision);
    if (qa.dependencyPins[0]!.revision === impl.packet.revision) assert.equal(qa.dependencyPins[0]!.recordSha256, recordDigest(impl));
    return { baselineId, uiId, technologyId, workstreamId, taskBoardId: board.revisionId, qaDigest: recordDigest(qa), qaPacket: qa.packet };
  }
  const before = await publishSide(1), after = await publishSide(2);
  const pins = (oldRevisionId: string, newRevisionId: string) => ({ oldRevisionId, newRevisionId });
  const pair = { projectId: W, oldBaselineRevisionId: before.baselineId, newBaselineRevisionId: after.baselineId,
    oldUiRevisionId: before.uiId, newUiRevisionId: after.uiId, technology: pins(before.technologyId, after.technologyId),
    workstreams: pins(before.workstreamId, after.workstreamId), tasks: { ctoId: CTO, workstreamId: scope.workstreamId,
      ...pins(before.taskBoardId, after.taskBoardId) } };
  const projection = (await readImpact({ ...pair, projection: "revalidation" } as never, ctx() as never, f.platform)).data as unknown as {
    recordedTaskInputs: { taskId: string; kind: string; previousDigest: string; comparedDigest: string;
      status: string; reason: string | null; inputsSha256: string | null }[];
    completeness: { reapprovalAuthorized: boolean; priorExecutionEvidenceReuse: string };
  };
  const qa = projection.recordedTaskInputs.find(row => row.taskId === "qa")!;
  assert(qa);
  assert.equal(qa.kind, "qa");
  assert.equal(qa.previousDigest, before.qaDigest);
  assert.equal(qa.comparedDigest, after.qaDigest);
  assert.notEqual(qa.previousDigest, qa.comparedDigest);
  if (change !== "test-plan") assert.deepEqual({ ...after.qaPacket, revision: before.qaPacket.revision }, before.qaPacket);
  assert.equal(projection.completeness.reapprovalAuthorized, false);
  assert.equal(projection.completeness.priorExecutionEvidenceReuse, "UNKNOWN_NO_RUN_RESULT_READER");
  if (change === "disconnected") {
    const impact = (await readImpact(pair as never, ctx() as never, f.platform)).data as unknown as {
      recordedTaskInputs: unknown; executionAuthorized: boolean; approvalCreated: boolean };
    assert.deepEqual(impact.recordedTaskInputs, projection.recordedTaskInputs);
    assert.equal(impact.executionAuthorized, false);
    assert.equal(impact.approvalCreated, false);
  }
  return qa;
}

test("authenticated G5 compares unchanged recorded QA inputs across a disconnected approved addition", async () => {
  const qa = await publishedPair("disconnected");
  assert.equal(qa.status, "unchanged-recorded-inputs", qa.reason ?? "");
  assert.equal(qa.reason, null);
  assert.match(qa.inputsSha256 ?? "", /^[0-9a-f]{64}$/);
});

test("an invalid companion leaves no Task board write and a later valid batch can publish", async () => {
  const qa = await publishedPair("failed-batch");
  assert.equal(qa.status, "unchanged-recorded-inputs", qa.reason ?? "");
});

for (const change of ["linked-node", "test-plan", "stale-dependency"] as const) {
  test(`authenticated G5 does not carry forward recorded QA inputs with a ${change} change`, async () => {
    const qa = await publishedPair(change);
    assert.equal(qa.status, change === "stale-dependency" ? "unknown" : "changed", qa.reason ?? "");
    assert.equal(qa.reason, change === "stale-dependency"
      ? "task-dependency-or-design-material-incomplete" : "recorded-qa-inputs-differ");
    assert.equal(qa.inputsSha256, null);
  });
}
