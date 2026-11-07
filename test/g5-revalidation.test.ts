import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskPacketBoard, parseTaskPacketRecord, taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { candidateIds, checkTaskDependencyPins, projectExactCandidateRecords, projectWorkstreamReadinessReceipt, readG5Revalidation } from "../src/g5-revalidation.ts";
import { assertCurrentCtoTaskG5Effect } from "../src/g5-change-impact-tools.ts";
import { parseDesignBaseline } from "../src/domain/design-baseline.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../src/technology-decision-tools.ts";
import { createUiContractStore } from "../src/ui-contracts/store.ts";
import { sha256Utf8 } from "../src/ui-contracts/domain.ts";
import { createRevisionJournal, type RevisionState } from "../src/solution-revision-store.ts";
import { parseWorkstreamBoard, type WorkstreamRecord } from "../src/domain/workstreams.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { validateG5Handoff } from "../src/workstream-tools.ts";
import { parseWorkstreamChange, parseWorkstreamSpec } from "../src/domain/workstreams.ts";
import { LEAD_CHANNELS } from "../src/domain/lead-sessions.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const MAIN = "66666666-6666-4666-8666-666666666666";
const RUN = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const CTO = "77777777-7777-4777-8777-777777777777";
const REQUEST = "88888888-8888-4888-8888-888888888888";

function taskRecord(taskId: string, revision: number, dependencies: readonly string[] = [], dependencyPins: readonly unknown[] = []) {
  return { packet: { projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", taskId, revision,
    kind: "development", title: taskId, goal: "goal", scopeNodeIds: ["node-1"], requirementIds: ["REQ-1"],
    dependencies, included: ["included"], excluded: [], constraints: [], acceptance: ["accept"],
    evidenceRequired: ["report"], reuse: [], testPlan: null },
    source: { requestId: REQUEST, workstreamId: "ws-1", specRevision: 1, instructionSha256: "a".repeat(64) },
    author: { agentId: AGENT, sessionId: MAIN, runId: RUN }, createdAtISO: "2026-11-06T00:00:00.000Z", dependencyPins };
}

function fixture() {
  const values = new Map<string, JsonValue>();
  const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: COMPANY,
    namespace: "sonpark.my-builder", stateKey });
  const address = (item: SpsStateKey) => JSON.stringify(item);
  const sessions = { main: MAIN, "ui-design": null, background: null, "cto-inbox": null, decisions: null,
    "integration-review": null };
  values.set(address(key("lead-agent.v1")), { workspaceId: COMPANY, revision: 1, selectedAgentId: AGENT });
  values.set(address(key("lead-sessions.v1.1")), { workspaceId: COMPANY, selectionRevision: 1, agentId: AGENT, sessions });
  let writes = 0;
  const state = { async get(stateKey: SpsStateKey) { return structuredClone(values.get(address(stateKey)) ?? null); },
    async compareAndSet() { writes += 1; return { swapped: false }; } };
  return { state, values, key, writes: () => writes, runContext: { companyId: COMPANY, agentId: AGENT, runId: RUN, sessionId: MAIN },
    platform: { state, events: {}, agents: {} } as unknown as SpsPlatformInvocationContext };
}

async function pairedProjectionFixture(withTaskRecords = false) {
  const f = fixture();
  const address = (item: SpsStateKey) => JSON.stringify(item);
  let taskHeadReads = 0;
  let workstreamHeadReads = 0;
  let journalWrites = 0;
  let onThirdTaskHeadRead: (() => void) | null = null;
  const state = {
    async get(item: SpsStateKey) {
      if (item.stateKey.startsWith("workstreams-head.")) workstreamHeadReads += 1;
      if (item.stateKey.startsWith("task-packets-head.")) {
        taskHeadReads += 1;
        if (taskHeadReads === 3) onThirdTaskHeadRead?.();
      }
      return structuredClone(f.values.get(address(item)) ?? null);
    },
    async compareAndSet(item: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      journalWrites += 1;
      const id = address(item), exists = f.values.has(id), old = f.values.get(id);
      const swapped = expected.exists ? exists && JSON.stringify(old) === JSON.stringify(expected.value) : !exists;
      if (swapped) f.values.set(id, structuredClone(value));
      return { swapped };
    },
  };
  const platform = { ...f.platform, state } as unknown as SpsPlatformInvocationContext;
  const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const revisionState = state as unknown as RevisionState;
  const baselineStore = createDesignBaselineStore(COMPANY, COMPANY, revisionState);
  const sessions = { ...Object.fromEntries(LEAD_CHANNELS.map(channel => [channel, null])), main: MAIN,
    "integration-review": "99999999-9999-4999-8999-999999999999",
    "ui-design": "00000000-0000-4000-8000-000000000004" };
  f.values.set(address(f.key("lead-sessions.v1.1")), { workspaceId: COMPANY, selectionRevision: 1, agentId: AGENT, sessions });
  const uiRun = { ...f.runContext, sessionId: sessions["ui-design"] };
  const ui = createUiContractStore(COMPANY, COMPANY, revisionState);
  const publishBaseline = async (revisionId: string, expectedBaseRevisionId: string | null) => {
    const specification = { projectId: COMPANY, revisionId: `spec-${revisionId}`, productTier: "M",
      requirements: [{ id: "REQ-1", description: revisionId, acceptanceCriteriaIds: ["AC-1"] },
        { id: "REQ-2", description: "unchanged", acceptanceCriteriaIds: ["AC-2"] }], targets: ["sps-plugin"],
      dataPolicyRef: "policy-unreviewed", approvalEvidenceRef: `lead-turn:${RUN}` };
    const baseline = parseDesignBaseline({ projectId: COMPANY, revisionId, sourceDraftRevisionId: `draft-${revisionId}`,
      draftDigest: sha(revisionId), createdAt: "2026-11-06T00:00:00.000Z",
      author: { agentId: AGENT, sessionId: MAIN, runId: RUN, selectionRevision: 1 },
      userDecision: { sourceId: `lead-turn:${RUN}`, sourceSha256: sha(revisionId), interpretation: revisionId }, specification,
      graph: { approvedSpecRevisionId: specification.revisionId, graphRevisionId: `graph-${revisionId}`, entities: [], relations: [], viewLayoutRef: "layout" } }, COMPANY);
    return baselineStore.publish({ expectedBaseRevisionId, revision: baseline });
  };
  const publishFormalUi = async (revisionId: string, baselineRevisionId: string, expectedFormalRevisionId: string | null) => {
    const html = `<main>${revisionId}</main>`;
    const proposal = await ui.propose({ revisionId: `proposal-${revisionId}`,
      expectedBaseRevisionId: expectedFormalRevisionId ? "proposal-ui-old" : null,
      source: { kind: "baseline", revisionId: baselineRevisionId },
      artifact: { artifactId: `artifact-${revisionId}`, html, htmlSha256: sha256Utf8(html), screenIds: ["home"],
        viewport: { width: 1280, height: 800 }, sourceSessionId: sessions["ui-design"], sourceSpecRevisionId: `spec-${baselineRevisionId}` },
      contract: { projectId: COMPANY, revisionId: `contract-${revisionId}`, screenIds: ["home"], interactions: [
        { id: "interaction-1", screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [],
          preconditions: [], outcomes: [revisionId], prohibited: [], validationCriteria: ["verify exact pair"], status: "specified" },
      ] },
    }, uiRun, platform);
    assert.equal(proposal.status, "published");
    const approval = await ui.approveProposalAction({ revisionId: `approval-${revisionId}`,
      expectedBaseRevisionId: expectedFormalRevisionId ? "approval-ui-old" : null,
      proposalRevisionId: `proposal-${revisionId}`, htmlSha256: sha256Utf8(html), approvedInteractionIds: ["interaction-1"] },
    { companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: "22222222-2222-4222-8222-222222222222" }, state } as unknown as
      Pick<SpsActionContext, "companyId" | "actor"> & { state: SpsActionContext["state"] });
    assert.equal(approval.status, "published");
    const formal = await ui.publishFormal({ revisionId, expectedBaseRevisionId: expectedFormalRevisionId,
      proposalRevisionId: `proposal-${revisionId}`, approvalRevisionId: `approval-${revisionId}` }, f.runContext, platform);
    assert.equal(formal.status, "published");
  };
  await publishBaseline("base-old", null);
  await publishFormalUi("ui-old", "base-old", null);
  await publishBaseline("base-new", "base-old");
  await publishFormalUi("ui-new", "base-new", "ui-old");

  const technologyStore = createTechnologyDecisionStore(COMPANY, COMPANY, state as unknown as RevisionState);
  const publishTechnology = async (revisionId: string, baselineRevisionId: string, expectedBaseRevisionId: string | null) => {
    const baseline = (await baselineStore.publishedRevision(baselineRevisionId))!.revision;
    return technologyStore.publish({ expectedBaseRevisionId, revision: { register: { projectId: COMPANY, revisionId,
      sourceBaselineRevisionId: baselineRevisionId, sourceSpecRevisionId: baseline.specification.revisionId,
      sourceGraphRevisionId: baseline.graph.graphRevisionId, entries: [] }, author: { agentId: AGENT, sessionId: MAIN,
      runId: RUN, selectionRevision: 1 }, createdAt: "2026-11-06T00:00:00.000Z", baselineDigest: sha(JSON.stringify(baseline)) } });
  };
  await publishTechnology("tech-old", "base-old", null);
  await publishTechnology("tech-new", "base-new", "tech-old");

  const workstreamStore = createRevisionJournal(COMPANY, COMPANY, state, { prefix: "workstreams",
    parse: value => parseWorkstreamBoard(value, COMPANY), revisionId: value => value.revisionId });
  const instruction = (workstreamId: string, baselineRevisionId: string, technologyRevisionId: string) => {
    const baseline = baselineStore;
    return Promise.all([baseline.publishedRevision(baselineRevisionId), technologyStore.publishedRevision(technologyRevisionId)]);
  };
  const makeWorkstream = async (baselineRevisionId: string, technologyRevisionId: string) => {
    const [baselineEntry, technologyEntry] = await instruction("ws-1", baselineRevisionId, technologyRevisionId);
    const baseline = baselineEntry!.revision, technology = technologyEntry!.revision;
    return { spec: { projectId: COMPANY, id: "ws-1", revision: 1, sourceSpecRevisionId: baseline.specification.revisionId,
      assignedCtoId: CTO, title: "Fixture Workstream", goal: `Validate exact historical G5 source ${baselineRevisionId}.`, scopeNodeIds: ["node-1"],
      included: ["fixture scope"], excluded: [], dependencies: [], interfaceContracts: [], technologyDecisionsRef: technology.register.revisionId,
      reuseCandidates: [], acceptance: ["exact pair resolved"], evidenceRequired: ["publication pins"], openQuestions: [] },
      sourceBaselineRevisionId: baselineRevisionId, baselineDigest: sha(JSON.stringify(baseline)), technologyDigest: sha(JSON.stringify(technology)),
      ctoAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ctoSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      author: { agentId: AGENT, sessionId: MAIN, runId: RUN, selectionRevision: 1 }, createdAt: "2026-11-06T00:00:00.000Z",
      change: { previousRevision: null, reason: "Fixture", diff: "Initial", impactNodeIds: [], impactInterfaceContracts: [],
        impactTaskIds: [], effectiveFrom: "Fixture only" }, receipt: null };
  };
  const oldWorkstream = await makeWorkstream("base-old", "tech-old"), newWorkstream = await makeWorkstream("base-new", "tech-new");
  await workstreamStore.publish({ expectedBaseRevisionId: null, revision: { projectId: COMPANY, revisionId: "ws-old", workstreams: [oldWorkstream] } });
  await workstreamStore.publish({ expectedBaseRevisionId: "ws-old", revision: { projectId: COMPANY, revisionId: "ws-new", workstreams: [newWorkstream] } });
  const taskStore = createTaskPacketStore(COMPANY, COMPANY, CTO, "ws-1", state as unknown as RevisionState);
  const pairedTask = (workstream: WorkstreamRecord, requirementId: string) => parseTaskPacketRecord({
    ...taskRecord(requirementId === "REQ-1" ? "task-affected" : "task-unaffected", 1),
    packet: { ...taskRecord(requirementId === "REQ-1" ? "task-affected" : "task-unaffected", 1).packet, requirementIds: [requirementId] },
    source: { requestId: REQUEST, workstreamId: "ws-1", specRevision: workstream.spec.revision,
      instructionSha256: workstreamInstructionDigest(workstream) },
  }, COMPANY, CTO, "ws-1");
  await taskStore.publish({ expectedBaseRevisionId: null, revision: { projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "task-old",
    packets: withTaskRecords ? [pairedTask(oldWorkstream, "REQ-1"), pairedTask(oldWorkstream, "REQ-2")] : [] } });
  await taskStore.publish({ expectedBaseRevisionId: "task-old", revision: { projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "task-new",
    packets: withTaskRecords ? [pairedTask(newWorkstream, "REQ-1"), pairedTask(newWorkstream, "REQ-2")] : [] } });
  const params = { projectId: COMPANY, oldBaselineRevisionId: "base-old", newBaselineRevisionId: "base-new",
    oldUiRevisionId: "ui-old", newUiRevisionId: "ui-new", technology: { oldRevisionId: "tech-old", newRevisionId: "tech-new" },
    workstreams: { oldRevisionId: "ws-old", newRevisionId: "ws-new" },
    tasks: { ctoId: CTO, workstreamId: "ws-1", oldRevisionId: "task-old", newRevisionId: "task-new" } };
  return { ...f, platform, params, taskStore, workstreamStore, baselineStore, publishBaseline, pairedTask,
    journalWrites: () => journalWrites,
    onThirdTaskHeadRead(callback: () => void) { onThirdTaskHeadRead = callback; },
    resetPairReadCounts() { taskHeadReads = 0; workstreamHeadReads = 0; },
    get taskHeadReads() { return taskHeadReads; }, get workstreamHeadReads() { return workstreamHeadReads; } };
}

test("candidate parsing rejects wrong dimension, malformed IDs, and duplicates", () => {
  assert.throws(() => candidateIds({ status: "CANDIDATES", candidates: [{ dimension: "tasks", recordId: "T-1" }] }, "ctoWorkstreams"), /dimension mismatch/);
  assert.throws(() => candidateIds({ status: "CANDIDATES", candidates: [{ dimension: "tasks", recordId: "T-1" },
    { dimension: "tasks", recordId: "T-1" }] }, "tasks"), /unique/);
  assert.throws(() => candidateIds({ status: "CANDIDATES", candidates: [{ dimension: "tasks", recordId: " " }] }, "tasks"), /bounded identifier/);
  assert.throws(() => candidateIds({ status: "NO_CANDIDATE_OBSERVED", candidates: [{ dimension: "tasks", recordId: "T-1" }] }, "tasks"), /status and exact candidate list disagree/);
  assert.throws(() => candidateIds({ status: "CANDIDATES", candidates: [] }, "tasks"), /status and exact candidate list disagree/);
});

test("UNKNOWN status is retained even when exact candidate IDs exist", () => {
  const candidates = candidateIds({ status: "UNKNOWN", candidates: [{ dimension: "tasks", recordId: "T-1" }] }, "tasks");
  const projection = projectExactCandidateRecords({ old: [{ packet: { taskId: "T-1" } }],
    current: [{ packet: { taskId: "T-1" } }], oldRevisionId: "old", newRevisionId: "new" }, candidates.ids,
  item => item.packet.taskId, candidates.status, "Task");
  assert.equal(projection[0]?.classification, "UNKNOWN");
  assert.equal(projection[0]?.oldRecord?.packet.taskId, "T-1");
});

test("candidate absence emits no reapproval or no-impact verdict; it remains an empty projection only", () => {
  const candidates = candidateIds({ status: "NO_CANDIDATE_OBSERVED", candidates: [] }, "tasks");
  const projection = projectExactCandidateRecords({ old: [{ packet: { taskId: "T-1" } }],
    current: [{ packet: { taskId: "T-1" } }], oldRevisionId: "old", newRevisionId: "new" }, candidates.ids,
  item => item.packet.taskId, candidates.status, "Task");
  assert.deepEqual(projection, []);
  assert.equal(candidates.status, "NO_CANDIDATE_OBSERVED");
});

test("candidate must resolve to an exact published pair record", () => {
  const candidates = new Set(["forged"]);
  assert.throws(() => projectExactCandidateRecords({ old: [{ packet: { taskId: "T-1" } }],
    current: [{ packet: { taskId: "T-1" } }], oldRevisionId: "old", newRevisionId: "new" }, candidates,
  item => item.packet.taskId, "CANDIDATES", "Task"), /do not resolve/);
});

test("prior Task instruction is reusable only while every immutable dependency pin still matches", () => {
  const base = parseTaskPacketBoard({ projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "base",
    packets: [taskRecord("dep", 1)] }, COMPANY, CTO, "ws-1");
  const dep = base.packets[0]!;
  const depDigest = taskPacketRecordDigest(dep, COMPANY, CTO, "ws-1");
  const dependent = parseTaskPacketBoard({ projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "dependent",
    packets: [dep, taskRecord("task", 1, ["dep"], [{ taskId: "dep", revision: 1, recordSha256: depDigest }])] }, COMPANY, CTO, "ws-1");
  const task = dependent.packets.find(row => row.packet.taskId === "task")!;
  assert.deepEqual(checkTaskDependencyPins(task, dependent.packets, COMPANY, CTO, "ws-1").current, true);

  const changedDependency = parseTaskPacketBoard({ projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "changed",
    packets: [taskRecord("dep", 2), task] }, COMPANY, CTO, "ws-1");
  const stale = checkTaskDependencyPins(task, changedDependency.packets, COMPANY, CTO, "ws-1");
  assert.equal(stale.current, false);
  assert.equal(stale.pins[0]?.status, "STALE_OR_UNAVAILABLE");
  assert.equal(stale.pins[0]?.observedRevision, 2);
});

test("only an exact unchanged Workstream record carries its CTO readiness receipt, never a G5 ACK", () => {
  const record = ({ spec: { id: "ws-1", revision: 2 }, receipt: { revision: 2, readiness: "ready" } } as unknown as NonNullable<Parameters<typeof projectWorkstreamReadinessReceipt>[0]>);
  const carried = projectWorkstreamReadinessReceipt(record, structuredClone(record));
  assert.equal(carried.status, "CURRENT_CTO_READINESS_ONLY");
  assert.equal(carried.carryForward, "CARRY_EXACT_CTO_READINESS_ONLY");
  assert.equal(carried.g5Acknowledgment, "UNKNOWN_NO_G5_ACK_SOURCE");

  const changed = projectWorkstreamReadinessReceipt(record, { ...record, spec: { ...record.spec, revision: 3 } });
  assert.equal(changed.carryForward, "DO_NOT_CARRY");
  assert.match(changed.carryForwardReason, /historical/);
});

test("source reader rejects caller snapshots before reads and writes nothing", async () => {
  const f = fixture();
  const params = { projectId: COMPANY, oldBaselineRevisionId: "b0", newBaselineRevisionId: "b1",
    oldUiRevisionId: "u0", newUiRevisionId: "u1", workstreams: { oldRevisionId: "w0", newRevisionId: "w1" },
    tasks: { ctoId: "cto", workstreamId: "ws", oldRevisionId: "t0", newRevisionId: "t1" }, snapshots: {} };
  await assert.rejects(() => readG5Revalidation(params, f.runContext, f.platform), /Invalid Builder tool fields/);
  assert.equal(f.writes(), 0);
});

test("only Main or Integration Review can request the projection", async () => {
  const f = fixture();
  const context = { ...f.runContext, sessionId: "00000000-0000-4000-8000-000000000009" };
  const params = { projectId: COMPANY, oldBaselineRevisionId: "b0", newBaselineRevisionId: "b1",
    oldUiRevisionId: "u0", newUiRevisionId: "u1", workstreams: { oldRevisionId: "w0", newRevisionId: "w1" },
    tasks: { ctoId: "cto", workstreamId: "ws", oldRevisionId: "t0", newRevisionId: "t1" } };
  await assert.rejects(() => readG5Revalidation(params, context, f.platform), /prepared current Lead session/);
  assert.equal(f.writes(), 0);
});

test("exact selected historical G5, Workstream, and Task pairs remain readable after later unrelated publications", async () => {
  const f = await pairedProjectionFixture();
  await f.workstreamStore.publish({ expectedBaseRevisionId: "ws-new", revision: {
    projectId: COMPANY, revisionId: "ws-later-unrelated", workstreams: [],
  } });
  await f.taskStore.publish({ expectedBaseRevisionId: "task-new", revision: {
    projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "task-later-unrelated", packets: [],
  } });
  const result = await readG5Revalidation(f.params, f.runContext, f.platform);
  const data = result.data as { sourcePins: { workstreams: { oldRevisionId: string; newRevisionId: string };
    tasks: { oldRevisionId: string; newRevisionId: string }; g5: { sourcePins: { oldBaselineRevisionId: string; newBaselineRevisionId: string } };
    }; completeness: { crossJournalAtomic: boolean } };
  assert.equal(data.sourcePins.g5.sourcePins.oldBaselineRevisionId, "base-old");
  assert.equal(data.sourcePins.g5.sourcePins.newBaselineRevisionId, "base-new");
  assert.deepEqual(data.sourcePins.workstreams, { oldRevisionId: "ws-old", newRevisionId: "ws-new" });
  assert.deepEqual(data.sourcePins.tasks, { oldRevisionId: "task-old", newRevisionId: "task-new" });
  assert.equal(data.completeness.crossJournalAtomic, false);
});

test("registered change-impact tool keeps its default and dispatches exact revalidation for Main and Integration Review", async () => {
  const f = await pairedProjectionFixture();
  const tool = createBuilderPlatform().tools.find(item => item.name === "builder.read-change-impact");
  assert(tool, "the registered tool must exist");
  for (const sessionId of [MAIN, "99999999-9999-4999-8999-999999999999"]) {
    const context = { ...f.runContext, sessionId };
    const defaultResult = await tool.handler(f.params, context, f.platform);
    assert.equal((defaultResult.data as { sourcePins?: unknown }).sourcePins === undefined, false,
      "omitted projection must retain the existing G5 comparison result");
    const result = await tool.handler({ ...f.params, projection: "revalidation" }, context, f.platform);
    const data = result.data as { sourcePins: { tasks: { oldRevisionId: string; newRevisionId: string } };
      completeness: { priorExecutionEvidenceReuse: string; g5Acknowledgment: string; reapprovalAuthorized: boolean } };
    assert.deepEqual(data.sourcePins.tasks, { oldRevisionId: "task-old", newRevisionId: "task-new" });
    assert.equal(data.completeness.priorExecutionEvidenceReuse, "UNKNOWN_NO_RUN_RESULT_READER");
    assert.equal(data.completeness.g5Acknowledgment, "UNKNOWN_NO_ACK_SOURCE");
    assert.equal(data.completeness.reapprovalAuthorized, false);
  }
  const otherLead = { ...f.runContext, sessionId: "00000000-0000-4000-8000-000000000004" };
  await assert.rejects(async () => { await tool.handler({ ...f.params, projection: "revalidation" }, otherLead, f.platform); }, /limited to Main or Integration Review/);
  await assert.rejects(async () => { await tool.handler({ ...f.params, projection: "other" }, f.runContext, f.platform); }, /Unsupported G5 change-impact projection/);
});

test("Lead selection changed during additional Task reads is rejected before projection returns", async () => {
  const f = await pairedProjectionFixture();
  f.onThirdTaskHeadRead(() => {
    f.values.set(JSON.stringify(f.key("lead-agent.v1")), { workspaceId: COMPANY, revision: 2,
      selectedAgentId: "22222222-2222-4222-8222-222222222222" });
  });
  await assert.rejects(() => readG5Revalidation(f.params, f.runContext, f.platform), /Lead Agent selection changed/);
  assert(f.taskHeadReads >= 3, "the fixture flips authority after candidate comparison, during projection journal reads");
});

test("unauthorized Lead channel is rejected before any Workstream or Task pair reads", async () => {
  const f = await pairedProjectionFixture();
  f.resetPairReadCounts();
  const runContext = { ...f.runContext, sessionId: "00000000-0000-4000-8000-000000000004" };
  await assert.rejects(() => readG5Revalidation(f.params, runContext, f.platform), /limited to Main or Integration Review/);
  assert.equal(f.workstreamHeadReads, 0);
  assert.equal(f.taskHeadReads, 0);
});

test("G5 handoff proposal is derived from exact published pairs and a current CTO receipt acknowledges only that scoped instruction", async () => {
  const f = await pairedProjectionFixture();
  const first = await readG5Revalidation(f.params, f.runContext, f.platform);
  const initial = first.data as unknown as { g5WorkstreamHandoffProposals: readonly { workstreamId: string; g5Handoff: Record<string, unknown> }[] };
  const proposal = initial.g5WorkstreamHandoffProposals.find(item => item.workstreamId === "ws-1");
  assert(proposal, "the exact changed Workstream should have an actionable G5 handoff proposal");
  assert.equal(proposal.g5Handoff.taskImpactStatus, "UNKNOWN", "missing G5 dimensions remain explicit in the handoff");
  const original = (await f.workstreamStore.publishedRevision("ws-new"))!.revision.workstreams[0]!;
  const nextSpec = parseWorkstreamSpec({ ...original.spec, revision: 2 }, COMPANY);
  const linkedChange = parseWorkstreamChange({ ...original.change, previousRevision: 1,
    impactTaskIds: proposal.g5Handoff.affectedTaskIds,
    g5Handoff: proposal.g5Handoff });
  await validateG5Handoff(COMPANY, COMPANY, nextSpec, linkedChange, f.runContext, f.platform);
  await assert.rejects(() => validateG5Handoff(COMPANY, COMPANY, nextSpec,
    parseWorkstreamChange({ ...linkedChange, g5Handoff: { ...proposal.g5Handoff, impactSha256: "f".repeat(64) } }),
    f.runContext, f.platform), /impact digest does not match/);

  const acknowledged = { ...original, spec: nextSpec, change: linkedChange,
    receipt: { revision: 2, agentId: original.ctoAgentId, sessionId: original.ctoSessionId, runId: RUN,
      createdAt: "2026-11-07T00:00:00.000Z", readiness: "ready" as const,
      note: "Fixture: exact G5-scoped Workstream instruction reviewed." } };
  const saved = await f.workstreamStore.publish({ expectedBaseRevisionId: "ws-new", revision: {
    projectId: COMPANY, revisionId: "ws-g5-acknowledged", workstreams: [acknowledged],
  } });
  assert.equal(saved.status, "published");
  const after = await readG5Revalidation(f.params, f.runContext, f.platform);
  const data = after.data as unknown as { g5WorkstreamHandoffAcceptance: readonly { workstreamId: string; status: string }[];
    affectedTasks: readonly unknown[]; completeness: { priorExecutionEvidenceReuse: string } };
  assert.deepEqual(data.g5WorkstreamHandoffAcceptance.map(item => [item.workstreamId, item.status]), [["ws-1", "ACKNOWLEDGED_SCOPED_HANDOFF"]]);
  assert.deepEqual(data.affectedTasks, [], "an empty exact Task candidate set stays empty, not proof of no wider impact");
  assert.equal(data.completeness.priorExecutionEvidenceReuse, "UNKNOWN_NO_RUN_RESULT_READER");

  await f.taskStore.publish({ expectedBaseRevisionId: "task-new", revision: {
    projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "task-current-drift", packets: [],
  } });
  const drifted = await readG5Revalidation(f.params, f.runContext, f.platform);
  const driftedData = drifted.data as unknown as { g5WorkstreamHandoffAcceptance: readonly { status: string }[] };
  assert.equal(driftedData.g5WorkstreamHandoffAcceptance[0]?.status, "STALE_TASK_SCOPE");
});

test("server-only G5 dispatch guard binds current approved scope and exact revalidated Task without upgrading historical QA", async () => {
  const f = await pairedProjectionFixture(true);
  const comparison = await readG5Revalidation(f.params, f.runContext, f.platform);
  const data = comparison.data as unknown as { g5WorkstreamHandoffProposals: readonly { workstreamId: string; g5Handoff: Record<string, unknown> }[] };
  const proposal = data.g5WorkstreamHandoffProposals.find(item => item.workstreamId === "ws-1")!.g5Handoff;
  assert.equal(proposal.taskImpactStatus, "UNKNOWN", "missing inventory stays unknown even when exact candidate IDs exist");
  const paired = (await f.workstreamStore.publishedRevision("ws-new"))!.revision.workstreams[0]!;
  const spec = parseWorkstreamSpec({ ...paired.spec, revision: 2 }, COMPANY);
  const change = parseWorkstreamChange({ ...paired.change, previousRevision: 1,
    impactTaskIds: proposal.affectedTaskIds, g5Handoff: proposal });
  const acknowledged = { ...paired, spec, change, receipt: { revision: 2, agentId: paired.ctoAgentId,
    sessionId: paired.ctoSessionId, runId: RUN, createdAt: "2026-11-07T00:00:00.000Z", readiness: "ready" as const,
    note: "Fixture: acknowledged exact scoped handoff." } };
  await f.workstreamStore.publish({ expectedBaseRevisionId: "ws-new", revision: {
    projectId: COMPANY, revisionId: "ws-g5-current", workstreams: [acknowledged],
  } });
  const currentWorkstream = (await f.workstreamStore.current())!.revision.workstreams[0]!;
  const latestTask = parseTaskPacketRecord({ ...f.pairedTask(paired, "REQ-1"), packet: {
    ...f.pairedTask(paired, "REQ-1").packet, revision: 2,
  }, source: { requestId: REQUEST, workstreamId: "ws-1", specRevision: 2,
    instructionSha256: workstreamInstructionDigest(currentWorkstream) } }, COMPANY, CTO, "ws-1");
  await f.taskStore.publish({ expectedBaseRevisionId: "task-new", revision: {
    projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "task-current", packets: [latestTask],
  } });
  const currentTask = (await f.taskStore.current())!.revision.packets[0]!;
  const read = (workstream = currentWorkstream, taskRecord = currentTask, assertCurrent = async () => {}) =>
    assertCurrentCtoTaskG5Effect({ workspaceId: COMPANY, projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1",
      taskId: "task-affected", workstream, taskRecord, assertCurrent, state: f.platform.state as unknown as RevisionState });

  const writesBeforeRead = f.journalWrites();
  assert.deepEqual(await read(), { status: "candidate", impactStatus: "UNKNOWN" },
    "the exact candidate remains dispatchable only as a revalidation task; incomplete G5 inventory stays UNKNOWN");
  assert.equal(f.journalWrites(), writesBeforeRead, "the server-only G5 scope reader never writes journals");
  await assert.rejects(() => read({ ...currentWorkstream,
    receipt: { ...currentWorkstream.receipt!, readiness: "blocked" } }), /current scoped Workstream acknowledgement/);
  await assert.rejects(() => read(currentWorkstream, { ...currentTask,
    packet: { ...currentTask.packet, title: "changed after snapshot" } }), /changed during effect-scope resolution/);

  let checks = 0;
  await assert.rejects(() => read(currentWorkstream, currentTask, async () => {
    checks += 1;
    if (checks === 3) await f.taskStore.publish({ expectedBaseRevisionId: "task-current", revision: {
      projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "task-raced",
      packets: [{ ...currentTask, packet: { ...currentTask.packet, revision: 4, title: "concurrent Task change" } }],
    } });
  }), /changed during dispatch preflight/);

  const changedHandoff = { ...currentWorkstream, spec: { ...currentWorkstream.spec, revision: 3 },
    change: parseWorkstreamChange({ ...currentWorkstream.change, previousRevision: 2, g5Handoff: {
      ...currentWorkstream.change.g5Handoff!, impactSha256: "f".repeat(64),
    } }),
    receipt: { ...currentWorkstream.receipt!, revision: 3 } };
  await f.workstreamStore.publish({ expectedBaseRevisionId: "ws-g5-current", revision: {
    projectId: COMPANY, revisionId: "ws-g5-impact-changed", workstreams: [changedHandoff],
  } });
  const currentAfterImpactChange = (await f.workstreamStore.current())!.revision.workstreams[0]!;
  const racedTask = (await f.taskStore.current())!.revision.packets[0]!;
  const taskAfterImpactChange = parseTaskPacketRecord({ ...racedTask, packet: { ...racedTask.packet, revision: 5 }, source: {
    requestId: REQUEST, workstreamId: "ws-1", specRevision: 3,
    instructionSha256: workstreamInstructionDigest(currentAfterImpactChange),
  } }, COMPANY, CTO, "ws-1");
  await f.taskStore.publish({ expectedBaseRevisionId: "task-raced", revision: {
    projectId: COMPANY, ctoId: CTO, workstreamId: "ws-1", revisionId: "task-current-after-impact-change",
    packets: [taskAfterImpactChange],
  } });
  const taskAfterImpact = (await f.taskStore.current())!.revision.packets[0]!;
  await assert.rejects(() => read(currentAfterImpactChange, taskAfterImpact),
    /impact digest no longer matches/);
  await f.publishBaseline("base-after", "base-new");
  await assert.rejects(() => read(currentAfterImpactChange, taskAfterImpact), /current approved Baseline, formal UI/);
});
