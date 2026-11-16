import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignDraftStore, type AuthoredDesignDraft } from "../src/design-draft-store.ts";
import { createDesignBaselineStore, publishDesignBaseline } from "../src/design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../src/technology-decision-tools.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { parseTaskPacketRecord } from "../src/domain/task-packets.ts";
import { parseWorkstreamBoard, type WorkstreamRecord } from "../src/domain/workstreams.ts";
import { approveFirstDesignReview, proposeFirstDesignReview } from "../src/spec-assurance/review-first-design.ts";
import { createUiContractStore } from "../src/ui-contracts/store.ts";
import { readG5Revalidation } from "../src/g5-revalidation.ts";
import { assertTaskWorkerFileDesignAuthority } from "../src/task-worker-file-design-authority.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";

const W = "11111111-1111-4111-8111-111111111111", A = "22222222-2222-4222-8222-222222222222";
const MAIN = "33333333-3333-4333-8333-333333333333", CTO_SESSION = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555", TURN = "66666666-6666-4666-8666-666666666666";
const UI = "77777777-7777-4777-8777-777777777777", CTO = "cto-one";
const SOURCE = `lead-turn:${TURN}`, BODY = "Keep the feature and the independent other feature precisely scoped.";
const now = "2026-11-08T01:02:03.004Z";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey });
const identity = (input: SpsStateKey) => JSON.stringify(input);

async function setup(undecided = false) {
  const values = new Map<string, JsonValue>();
  let onRead = async (_key: SpsStateKey) => {};
  const state: RevisionState = {
    async get(input) { const value = structuredClone(values.get(identity(input)) ?? null); await onRead(input); return value; },
    async compareAndSet(input, expected, value) {
      const id = identity(input), current = values.get(id);
      const swapped = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value) : current === undefined;
      if (swapped) values.set(id, structuredClone(value));
      return { swapped };
    },
  };
  const put = (stateKey: string, value: unknown) => values.set(identity(key(stateKey)), structuredClone(value) as JsonValue);
  put("lead-agent.v1", { workspaceId: W, revision: 1, selectedAgentId: A });
  put("lead-sessions.v1.1", { workspaceId: W, selectionRevision: 1, agentId: A,
    sessions: { main: MAIN, "ui-design": UI, background: null, "cto-inbox": null, decisions: null, "integration-review": null } });
  put(`lead-chat.turn.v1.${TURN}`, { workspaceId: W, selectionRevision: 1, agentId: A, sessionId: MAIN,
    channel: "main", schemaVersion: 1, requestId: TURN, previousRequestId: null, sequence: 0, text: BODY, createdAt: now,
    state: "submitted", runId: RUN, answer: null, outputState: "not_ready", cancellationRequested: false, termination: "not_applicable", inputKind: "user" });
  const platform = { state, agents: {} } as unknown as SpsPlatformInvocationContext;
  const context = { companyId: W, agentId: A, sessionId: MAIN, runId: RUN };
  const baselineStore = createDesignBaselineStore(W, W, state);
  const drafts = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, state);
  let draftHead: string | null = null, reviewHead: string | null = null, baselineHead: string | null = null;
  const draftFor = (version: number): AuthoredDesignDraft => ({ status: "draft", selectionRevision: 1,
    author: { agentId: A, sessionId: MAIN, runId: RUN }, createdAt: now, sourceDigests: [{ id: SOURCE, sha256: sha(BODY) }],
    draft: { projectId: W, revisionId: `draft-${version}`, sourceIds: [SOURCE], specification: { revisionId: `draft-spec-${version}`,
      productTier: "M", requirements: [{ id: "REQ-1", description: version === 1 ? "Feature" : "Changed feature", acceptanceCriteriaIds: ["AC-1"] },
        { id: "REQ-2", description: "Other feature", acceptanceCriteriaIds: ["AC-2"] }], targets: ["sps-plugin"], dataPolicyRef: "policy" },
    graph: { graphRevisionId: `draft-graph-${version}`, entities: [{ id: "feature", kind: "feature", specRef: "REQ-1" },
      { id: "other", kind: "feature", specRef: "REQ-2" }], relations: [], viewLayoutRef: "layout" }, questions: [] } });
  const proposeDesign = async (version: number) => {
    const authored = draftFor(version);
    assert.equal((await drafts.publish({ expectedBaseRevisionId: draftHead, revision: authored })).status, "published");
    draftHead = authored.draft.revisionId;
    const proposed = await proposeFirstDesignReview({ projectId: W, expectedDraftRevisionId: draftHead,
      expectedReviewHeadRevisionId: reviewHead, pack: { packId: "file-design", version: `${version}.0.0`, applicability: {},
        rules: [], transitions: [], exceptions: [], excludedCombinations: [] },
      sourcePins: [1, 2].map(id => ({ requirementId: `REQ-${id}`, acId: `AC-${id}`, sourceId: SOURCE })),
      designModel: { facts: [], rulesVersion: `design-${version}`, coverageRules: [], coverageTargets: [], scenarios: [],
        itemDecisions: [1, 2].map(id => ({ requirementId: `REQ-${id}`, status: undecided && id === 1 ? "UNDECIDED" : "RESOLVED",
          reason: "Synthetic authenticated design-review fixture", sourceIds: [SOURCE] })),
        acceptanceCriteria: [1, 2].map(id => ({ requirementId: `REQ-${id}`, acId: `AC-${id}`, sourceId: SOURCE, quote: BODY })) } },
    context, platform);
    assert(proposed.revision);
    reviewHead = proposed.revision.revisionId;
    return proposed.revision;
  };
  const publishDesign = async (version: number) => {
    const proposal = await proposeDesign(version);
    const approved = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposal.revisionId },
      { companyId: W, state, actor: { type: "user", companyId: W, userId: "synthetic-user" } } as unknown as SpsActionContext);
    assert("revision" in approved && approved.revision);
    reviewHead = approved.revision.revisionId;
    const published = await publishDesignBaseline({ projectId: W, expectedBaseRevisionId: baselineHead,
      sourceDraftRevisionId: draftHead, revisionId: `baseline-${version}`, userSourceId: `first-design-review:${reviewHead}`,
      interpretation: "Publish the exact synthetic user-reviewed design." }, context, platform);
    assert.equal((published.data as { status: string }).status, "published");
    baselineHead = `baseline-${version}`;
    return (await baselineStore.current())!.revision;
  };
  await publishDesign(1);
  const technology = createTechnologyDecisionStore(W, W, state);
  const publishTechnology = async (version: number) => {
    const baseline = (await baselineStore.publishedRevision(`baseline-${version}`))!.revision;
    assert.equal((await technology.publish({ expectedBaseRevisionId: version === 1 ? null : `tech-${version - 1}`, revision: {
      register: { projectId: W, revisionId: `tech-${version}`, sourceBaselineRevisionId: baseline.revisionId,
        sourceSpecRevisionId: baseline.specification.revisionId, sourceGraphRevisionId: baseline.graph.graphRevisionId, entries: [] },
      baselineDigest: digest(baseline), author: baseline.author, createdAt: now } })).status, "published");
  };
  await publishTechnology(1);
  const workstreams = createWorkstreamStore(W, W, state), tasks = createTaskPacketStore(W, W, CTO, "ws-1", state);
  const workstreamFor = async (version: number): Promise<WorkstreamRecord> => {
    const baseline = (await baselineStore.publishedRevision(`baseline-${version}`))!.revision;
    const tech = (await technology.publishedRevision(`tech-${version}`))!.revision;
    return { spec: { projectId: W, id: "ws-1", revision: 1, sourceSpecRevisionId: baseline.specification.revisionId,
      assignedCtoId: CTO, title: "Scoped Workstream", goal: "Maintain exact scoped instructions", scopeNodeIds: ["feature", "other"],
      included: ["features"], excluded: [], dependencies: [], interfaceContracts: [], technologyDecisionsRef: `tech-${version}`,
      reuseCandidates: [], acceptance: ["Exact source"], evidenceRequired: ["Pins"], openQuestions: [] },
    sourceBaselineRevisionId: baseline.revisionId, baselineDigest: digest(baseline), technologyDigest: digest(tech),
    ctoAgentId: A, ctoSessionId: CTO_SESSION, author: baseline.author, createdAt: now,
    change: { previousRevision: null, reason: "Initial", diff: "Exact scoped design", impactNodeIds: [], impactInterfaceContracts: [],
      impactTaskIds: [], effectiveFrom: "After acknowledgement" }, receipt: null };
  };
  const taskFor = (workstream: WorkstreamRecord, taskId = "task-affected", revision = 1) => parseTaskPacketRecord({
    packet: { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId, revision, kind: "development", title: taskId,
      goal: "Maintain exact task scope", scopeNodeIds: [taskId === "task-other" ? "other" : "feature"],
      requirementIds: [taskId === "task-other" ? "REQ-2" : "REQ-1"], dependencies: [], included: ["assigned file"], excluded: [],
      constraints: [], acceptance: ["Exact result"], evidenceRequired: ["Evidence"], reuse: [], testPlan: null },
    source: { requestId: RUN, workstreamId: "ws-1", specRevision: workstream.spec.revision,
      instructionSha256: workstreamInstructionDigest(workstream) }, author: { agentId: A, sessionId: CTO_SESSION, runId: RUN },
    createdAtISO: now, dependencyPins: [] }, W, CTO, "ws-1");
  const ws = await workstreamFor(1), task = taskFor(ws), other = taskFor(ws, "task-other");
  await workstreams.publish({ expectedBaseRevisionId: null, revision: { projectId: W, revisionId: "ws-old", workstreams: [ws] } });
  await tasks.publish({ expectedBaseRevisionId: null, revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "tasks-old", packets: [task, other] } });
  put("qa-history.fixture", { records: [{ taskId: "task-other", verdict: "historical-only" }] });
  const check = (taskRecord = task, selectedPlatform = platform) => assertTaskWorkerFileDesignAuthority({ workspaceId: W,
    projectId: W, ctoId: CTO, workstreamId: "ws-1", taskRecord, platform: selectedPlatform });
  return { values, state, platform, context, baselineStore, publishDesign, proposeDesign, publishTechnology,
    workstreams, tasks, workstreamFor, taskFor, task, other, check, setOnRead(hook: typeof onRead) { onRead = hook; } };
}

async function makeCurrentG5() {
  const f = await setup(), ui = createUiContractStore(W, W, f.state);
  const publishUi = async (version: number) => {
    const html = `<main>UI ${version}</main>`, baselineId = `baseline-${version}`;
    const specId = (await f.baselineStore.publishedRevision(baselineId))!.revision.specification.revisionId;
    assert.equal((await ui.propose({ revisionId: `ui-proposal-${version}`,
      expectedBaseRevisionId: version === 1 ? null : `ui-proposal-${version - 1}`, source: { kind: "baseline", revisionId: baselineId },
      artifact: { artifactId: `html-${version}`, html, htmlSha256: sha(html), screenIds: ["home"], viewport: { width: 1280, height: 800 },
        sourceSessionId: UI, sourceSpecRevisionId: specId }, contract: { projectId: W, revisionId: `contract-${version}`,
        screenIds: ["home"], interactions: [{ id: "i1", screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: [],
          stateRefs: [], apiRefs: [], preconditions: [], outcomes: [`UI ${version}`], prohibited: [], validationCriteria: ["Exact scope"], status: "specified" }] } },
    { ...f.context, sessionId: UI }, f.platform)).status, "published");
    assert.equal((await ui.approveProposalAction({ revisionId: `ui-approval-${version}`,
      expectedBaseRevisionId: version === 1 ? null : `ui-approval-${version - 1}`, proposalRevisionId: `ui-proposal-${version}`,
      htmlSha256: sha(html), approvedInteractionIds: ["i1"] }, { companyId: W, state: f.state,
        actor: { type: "user", companyId: W, userId: "synthetic-user" } } as never)).status, "published");
    assert.equal((await ui.publishFormal({ revisionId: `ui-${version}`, expectedBaseRevisionId: version === 1 ? null : `ui-${version - 1}`,
      proposalRevisionId: `ui-proposal-${version}`, approvalRevisionId: `ui-approval-${version}` }, f.context, f.platform)).status, "published");
  };
  await publishUi(1); await f.publishDesign(2); await publishUi(2); await f.publishTechnology(2);
  const paired = await f.workstreamFor(2);
  await f.workstreams.publish({ expectedBaseRevisionId: "ws-old", revision: { projectId: W, revisionId: "ws-new", workstreams: [paired] } });
  await f.tasks.publish({ expectedBaseRevisionId: "tasks-old", revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "tasks-new", packets: [f.taskFor(paired), f.taskFor(paired, "task-other")] } });
  const comparison = await readG5Revalidation({ projectId: W, oldBaselineRevisionId: "baseline-1", newBaselineRevisionId: "baseline-2",
    oldUiRevisionId: "ui-1", newUiRevisionId: "ui-2", technology: { oldRevisionId: "tech-1", newRevisionId: "tech-2" },
    workstreams: { oldRevisionId: "ws-old", newRevisionId: "ws-new" },
    tasks: { ctoId: CTO, workstreamId: "ws-1", oldRevisionId: "tasks-old", newRevisionId: "tasks-new" } }, f.context, f.platform);
  const handoff = (comparison.data as unknown as { g5WorkstreamHandoffProposals: { g5Handoff: unknown }[] }).g5WorkstreamHandoffProposals[0]!.g5Handoff;
  const affectedIds = (handoff as { affectedTaskIds: string[] }).affectedTaskIds;
  const acknowledged = parseWorkstreamBoard({ projectId: W, revisionId: "ws-g5-ack", workstreams: [{ ...paired,
    spec: { ...paired.spec, revision: 2 }, change: { ...paired.change, previousRevision: 1, impactTaskIds: affectedIds, g5Handoff: handoff },
    receipt: { revision: 2, agentId: A, sessionId: CTO_SESSION, runId: RUN, createdAt: now, readiness: "ready", note: "Synthetic exact CTO acknowledgement" } }] }, W);
  await f.workstreams.publish({ expectedBaseRevisionId: "ws-new", revision: acknowledged });
  const ws = acknowledged.workstreams[0]!, currentTask = f.taskFor(ws, "task-affected", 2);
  await f.tasks.publish({ expectedBaseRevisionId: "tasks-new", revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "tasks-current", packets: [currentTask, f.taskFor(ws, "task-other", 2)] } });
  return { ...f, currentTask, comparison };
}

test("initial current approved design passes read-only and a pending unapproved proposal does not stop it", async () => {
  const f = await setup();
  const before = structuredClone(f.values);
  assert.equal((await f.check()).g5.status, "not-scoped");
  assert.deepEqual(f.values, before);
  await f.proposeDesign(2);
  assert.equal((await f.check()).baselineRevisionId, "baseline-1");
  assert.deepEqual(await f.state.get(key("qa-history.fixture")), { records: [{ taskId: "task-other", verdict: "historical-only" }] });
});

test("an approved Baseline change without current Task/Workstream revalidation rejects only that scope", async () => {
  const f = await setup(); await f.publishDesign(2);
  const before = structuredClone(f.values);
  await assert.rejects(f.check(), /stale.*unaffected carry-forward proof/u);
  assert.deepEqual(f.values, before, "no Task, old approval or unrelated QA history is rewritten");
});

test("an affected Task with exact current approved G5 handoff and acknowledgement can be validated", async () => {
  const f = await makeCurrentG5();
  const captured = new Set<string>();
  const platform = { ...f.platform, state: { ...f.state, async get(input: SpsStateKey) {
    const value = await f.state.get(input); if (value !== null) captured.add(input.stateKey); return value;
  } } } as SpsPlatformInvocationContext;
  const before = structuredClone(f.values), result = await f.check(f.currentTask, platform);
  assert.equal(result.baselineRevisionId, "baseline-2"); assert.equal(result.g5.status, "candidate");
  assert.equal(result.g5.impactStatus, "UNKNOWN", "incomplete seven-dimension inventory never becomes unaffected proof");
  for (const prefix of ["design-baseline-head.v1.", "workstreams-head.v1.", "task-packets-head.v1.", "ui-contracts-head.v1."])
    assert([...captured].some(stateKey => stateKey.startsWith(prefix)), `caller guard collector observes ${prefix}`);
  assert.deepEqual(f.values, before);
});

test("another Task changing under the same approved design does not invalidate the unchanged Task or its QA history", async () => {
  const f = await setup();
  const changed = { ...f.other, packet: { ...f.other.packet, title: "Other Task replanned", revision: 2 } };
  await f.tasks.publish({ expectedBaseRevisionId: "tasks-old", revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "tasks-other-changed", packets: [f.task, changed] } });
  const before = structuredClone(f.values);
  assert.equal((await f.check()).baselineRevisionId, "baseline-1");
  assert.deepEqual(f.values, before);
});

test("design-model UNDECIDED is Task-scoped and does not block an unrelated resolved requirement", async () => {
  const f = await setup(true);
  await assert.rejects(f.check(), /explicitly UNDECIDED/u);
  assert.equal((await f.check(f.other)).baselineRevisionId, "baseline-1");
});

test("a current head changing during validation is rejected without writing or approving anything", async () => {
  const f = await setup();
  let reads = 0, injected = false;
  f.setOnRead(async input => {
    if (!input.stateKey.startsWith("task-packets-head.v1.") || ++reads !== 2) return;
    injected = true;
    await f.tasks.publish({ expectedBaseRevisionId: "tasks-old", revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
      revisionId: "tasks-raced", packets: [f.task, f.other] } });
  });
  await assert.rejects(f.check(), /heads changed during validation/u);
  assert.equal(injected, true, "the actual journal head read hook must execute");
});
