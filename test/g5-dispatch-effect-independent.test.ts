import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { SpsActionContext, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { fixture, key, W, A, C, R, CTO, ctx, now } from "./fixtures/cto-platform.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../src/technology-decision-tools.ts";
import { createUiContractStore } from "../src/ui-contracts/store.ts";
import { createRevisionJournal, type RevisionState } from "../src/solution-revision-store.ts";
import { parseWorkstreamBoard, parseWorkstreamSpec, parseWorkstreamChange, type WorkstreamRecord } from "../src/domain/workstreams.ts";
import { parseTaskPacketRecord } from "../src/domain/task-packets.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { readG5Revalidation } from "../src/g5-revalidation.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { acknowledgeWorkstream } from "../src/workstream-tools.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { LEAD_CHANNELS } from "../src/domain/lead-sessions.ts";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const LEAD = A, MAIN = "33333333-3333-4333-8333-333333333333";
const WORKER_AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID = "99999999-9999-4999-8999-999999999999";

function taskRecord(taskId: string, revision: number, instructionSha256: string, requestId: string, specRevision = 3) {
  return parseTaskPacketRecord({ packet: { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId, revision,
    kind: "development", title: "G5 affected task", goal: "Revalidate exact changed scope", scopeNodeIds: ["feature"],
    requirementIds: ["REQ-1"], dependencies: [], included: ["exact scope"], excluded: [], constraints: [],
    acceptance: ["record exact tests"], evidenceRequired: ["test evidence"], reuse: [], testPlan: null,
    sourceAccess: { sourceId: UUID, folderKey: "approved-source", branch: "feature/task", expectedHead: "1".repeat(40),
      readPaths: ["src/feature.ts"], writePaths: ["src/feature.ts"], qaWritePaths: [] } },
    source: { requestId, workstreamId: "ws-1", specRevision, instructionSha256 },
    author: { agentId: LEAD, sessionId: MAIN, runId: R }, createdAtISO: now, dependencyPins: [] }, W, CTO, "ws-1");
}

async function makeCurrentG5Fixture() {
  const f = await fixture(W);
  const state = f.state as unknown as RevisionState;
  const baselineStore = createDesignBaselineStore(W, W, state);
  const sessions = { ...Object.fromEntries(LEAD_CHANNELS.map(channel => [channel, null])), main: MAIN,
    "integration-review": "88888888-8888-4888-8888-888888888888",
    "ui-design": "77777777-7777-4777-8777-777777777777" };
  f.values.set(JSON.stringify(key("lead-sessions.v1.1")), { workspaceId: W, selectionRevision: 1, agentId: LEAD, sessions });
  const ui = createUiContractStore(W, W, state);
  const uiRun = { ...ctx(sessions["ui-design"]!), companyId: W };
  const publishBaseline = async (revisionId: string, expected: string | null) => {
    const sourceRequestId = randomUUID();
    const sourceText = `Approved G5 fixture baseline source: ${revisionId}`;
    f.values.set(JSON.stringify(key(`lead-chat.turn.v1.${sourceRequestId}`)), {
      workspaceId: W, selectionRevision: 1, agentId: LEAD, sessionId: MAIN, channel: "main", schemaVersion: 1,
      requestId: sourceRequestId, previousRequestId: null, sequence: 0, text: sourceText, createdAt: now,
      state: "submitted", runId: R, answer: null, outputState: "not_ready", cancellationRequested: false,
      termination: "not_applicable", inputKind: "user",
    });
    const specification = { projectId: W, revisionId: `spec-${revisionId}`, productTier: "M",
      requirements: [{ id: "REQ-1", description: revisionId, acceptanceCriteriaIds: ["AC-1"] }], targets: ["sps-plugin"],
      dataPolicyRef: "fixture-policy", approvalEvidenceRef: `lead-turn:${sourceRequestId}` };
    return baselineStore.publish({ expectedBaseRevisionId: expected, revision: {
      projectId: W, revisionId, sourceDraftRevisionId: `draft-${revisionId}`, draftDigest: sha(revisionId), createdAt: now,
      author: { agentId: LEAD, sessionId: MAIN, runId: R, selectionRevision: 1 },
      userDecision: { sourceId: `lead-turn:${sourceRequestId}`, sourceSha256: sha(sourceText), interpretation: revisionId }, specification,
      graph: { approvedSpecRevisionId: specification.revisionId, graphRevisionId: `graph-${revisionId}`,
        entities: [], relations: [], viewLayoutRef: "fixture-layout" } } });
  };
  const publishUi = async (revisionId: string, baselineId: string, expected: string | null) => {
    const html = `<main>${revisionId}</main>`;
    const sourceSpecRevisionId = (await baselineStore.publishedRevision(baselineId))!.revision.specification.revisionId;
    const proposal = await ui.propose({ revisionId: `proposal-${revisionId}`,
      expectedBaseRevisionId: expected ? "proposal-ui-old" : null, source: { kind: "baseline", revisionId: baselineId },
      artifact: { artifactId: `artifact-${revisionId}`, html, htmlSha256: sha(html), screenIds: ["home"],
        viewport: { width: 1280, height: 800 }, sourceSessionId: sessions["ui-design"], sourceSpecRevisionId },
      contract: { projectId: W, revisionId: `contract-${revisionId}`, screenIds: ["home"], interactions: [{ id: "i1",
        screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [],
        outcomes: [revisionId], prohibited: [], validationCriteria: ["verify exact scope"], status: "specified" }] },
    }, uiRun, f.platform);
    assert.equal(proposal.status, "published", JSON.stringify(proposal));
    const approval = await ui.approveProposalAction({ revisionId: `approval-${revisionId}`,
      expectedBaseRevisionId: expected ? "approval-ui-old" : null, proposalRevisionId: `proposal-${revisionId}`,
      htmlSha256: sha(html), approvedInteractionIds: ["i1"] }, { companyId: W,
      actor: { type: "user", companyId: W, userId: "66666666-6666-4666-8666-666666666666" }, state } as unknown as
        Pick<SpsActionContext, "companyId" | "actor"> & { state: SpsActionContext["state"] });
    assert.equal(approval.status, "published");
    assert.equal((await ui.publishFormal({ revisionId, expectedBaseRevisionId: expected,
      proposalRevisionId: `proposal-${revisionId}`, approvalRevisionId: `approval-${revisionId}` }, ctx(), f.platform)).status, "published");
  };
  await publishUi("ui-old", "baseline-1", null);
  await publishBaseline("base-new", "baseline-1"); await publishUi("ui-new", "base-new", "ui-old");
  const technologyStore = createTechnologyDecisionStore(W, W, state);
  const publishTechnology = async (revisionId: string, baselineId: string, expected: string | null) => {
    const baseline = (await baselineStore.publishedRevision(baselineId))!.revision;
    return technologyStore.publish({ expectedBaseRevisionId: expected, revision: { register: { projectId: W, revisionId,
      sourceBaselineRevisionId: baselineId, sourceSpecRevisionId: baseline.specification.revisionId,
      sourceGraphRevisionId: baseline.graph.graphRevisionId, entries: [] }, author: { agentId: LEAD, sessionId: MAIN,
      runId: R, selectionRevision: 1 }, createdAt: now, baselineDigest: sha(JSON.stringify(baseline)) } });
  };
  await publishTechnology("tech-new", "base-new", "tech-1");
  const workstreams = createRevisionJournal(W, W, state, { prefix: "workstreams",
    parse: value => parseWorkstreamBoard(value, W), revisionId: value => value.revisionId });
  const makeWorkstream = async (baselineId: string, techId: string): Promise<WorkstreamRecord> => {
    const baseline = (await baselineStore.publishedRevision(baselineId))!.revision;
    const tech = (await technologyStore.publishedRevision(techId))!.revision;
    return { spec: { projectId: W, id: "ws-1", revision: 1, sourceSpecRevisionId: baseline.specification.revisionId,
      assignedCtoId: CTO, title: "Fixture", goal: "Revalidate changed scope", scopeNodeIds: ["feature"], included: ["scope"],
      excluded: [], dependencies: [], interfaceContracts: [], technologyDecisionsRef: techId, reuseCandidates: [],
      acceptance: ["exact pair"], evidenceRequired: ["pins"], openQuestions: [] }, sourceBaselineRevisionId: baselineId,
      baselineDigest: sha(JSON.stringify(baseline)), technologyDigest: sha(JSON.stringify(tech)), ctoAgentId: A, ctoSessionId: C,
      author: { agentId: LEAD, sessionId: MAIN, runId: R, selectionRevision: 1 }, createdAt: now,
      change: { previousRevision: null, reason: "Initial", diff: "fixture", impactNodeIds: [], impactInterfaceContracts: [],
        impactTaskIds: [], effectiveFrom: "fixture" }, receipt: null };
  };
  const oldWs = f.instruction, newWs = await makeWorkstream("base-new", "tech-new");
  await workstreams.publish({ expectedBaseRevisionId: "board-1", revision: { projectId: W, revisionId: "ws-new", workstreams: [newWs] } });
  const tasks = createTaskPacketStore(W, W, CTO, "ws-1", state);
  const pairTask = (record: WorkstreamRecord) => taskRecord("task-affected", 1, workstreamInstructionDigest(record), UUID, 1);
  await tasks.publish({ expectedBaseRevisionId: null, revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "task-old", packets: [pairTask(oldWs)] } });
  await tasks.publish({ expectedBaseRevisionId: "task-old", revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "task-new", packets: [pairTask(newWs)] } });
  const g5 = await readG5Revalidation({ projectId: W, oldBaselineRevisionId: "baseline-1", newBaselineRevisionId: "base-new",
    oldUiRevisionId: "ui-old", newUiRevisionId: "ui-new", technology: { oldRevisionId: "tech-1", newRevisionId: "tech-new" },
    workstreams: { oldRevisionId: "board-1", newRevisionId: "ws-new" },
    tasks: { ctoId: CTO, workstreamId: "ws-1", oldRevisionId: "task-old", newRevisionId: "task-new" } }, ctx(), f.platform);
  const proposal = (g5.data as { g5WorkstreamHandoffProposals: Array<{ g5Handoff: Record<string, unknown> }> }).g5WorkstreamHandoffProposals[0]!.g5Handoff;
  const currentSpec = parseWorkstreamSpec({ ...newWs.spec, revision: 2 }, W);
  const currentChange = parseWorkstreamChange({ ...newWs.change, previousRevision: 1,
    impactTaskIds: proposal.affectedTaskIds, g5Handoff: proposal });
  const handoffWs = { ...newWs, spec: currentSpec, change: currentChange, receipt: null };
  await workstreams.publish({ expectedBaseRevisionId: "ws-new", revision: { projectId: W, revisionId: "ws-g5", workstreams: [handoffWs] } });
  const ctoParams = { projectId: W, workstreamId: "ws-1", specRevision: 2, boardRevisionId: "ws-g5" };
  await dispatchCtoWorkstream(ctoParams, ctx(), f.platform);
  const delivery = (await f.deliveryStore().current())!.revision;
  const ctoRunContext = ctx(C, delivery.runId!);
  await acknowledgeWorkstream({ projectId: W, ctoId: CTO, workstreamId: "ws-1", expectedBaseRevisionId: "ws-g5",
    revisionId: "ws-g5-ack", specRevision: 2, readiness: "ready", note: "Exact changed scope reviewed." }, ctoRunContext, f.platform);
  const currentWs = (await workstreams.current())!.revision.workstreams[0]!;
  const exactTask = taskRecord("task-affected", 2, workstreamInstructionDigest(currentWs), delivery.requestId, 2);
  await tasks.publish({ expectedBaseRevisionId: "task-new", revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "task-current", packets: [exactTask] } });
  return { f, state, workstreams, tasks, currentWs, exactTask, delivery, ctoRunContext };
}

function installWorkerHost(f: Awaited<ReturnType<typeof fixture>>, admissionHook?: () => Promise<void>) {
  const profiles = new Map([["worker", { agentId: WORKER_AGENT, status: "idle" }]]);
  const sessions = new Map([["worker", WORKER_SESSION]]);
  let workerRequest: { requestId: string; state: "submitted"; runId: string } | null = null;
  Object.assign(f.platform.agents, { owned: {
    async get({ pluginAgentKey }: { pluginAgentKey: string }) {
      if (pluginAgentKey === "integration-manager") return { status: "missing" };
      if (pluginAgentKey.startsWith("builder-task-worker:")) return { status: "resolved", revision: 1,
        agent: profiles.get("worker") };
      return { status: "missing" };
    },
    async ensure({ companyId, pluginAgentKey }: { companyId: string; pluginAgentKey: string }) {
      assert.equal(companyId, W);
      const profile = profiles.get("worker")!;
      return { status: "created", revision: 1, agent: profile };
    } },
    async describeExecution() { return { agentId: A, adapterType: "fixture", state: "configured", adapterRegistration: "registered",
      executionOwner: "adapter", authorization: "recheck_on_dispatch", readiness: "unknown", node: null }; },
    async list({ companyId }: { companyId: string }) { return [{ id: WORKER_AGENT, companyId, status: "idle" }]; } });
  Object.assign(f.platform.agents.sessions, {
    async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run",
      readiness: "unknown", osIsolation: "not-certified" }; },
    async ensure(agentId: string, companyId: string, options: { taskKey: string }) { assert.equal(companyId, W);
      const sessionId = WORKER_SESSION; sessions.set(options.taskKey, sessionId); return { sessionId, created: true }; },
    async getRequest(sessionId: string, companyId: string, requestId: string) {
      assert.equal(companyId, W);
      if (sessionId === C) return structuredClone(f.receipts.get(requestId) ?? null);
      assert.equal(sessionId, WORKER_SESSION);
      return workerRequest?.requestId === requestId ? structuredClone(workerRequest) : null;
    },
    async sendMessage(sessionId: string, companyId: string, options: { requestId: string }) {
      assert.equal(sessionId, WORKER_SESSION); assert.equal(companyId, W);
      const runId = randomUUID(); workerRequest = { requestId: options.requestId, state: "submitted", runId };
      await admissionHook?.(); return { runId };
    },
  });
  Object.assign(f.platform, { localFolders: {
    async status(folderKey: string) { return { folderKey, configured: true, healthy: true, readable: true, writable: true }; },
    async matchWorkspaceSourceV1(folderKey: string, sourceId: string) { return { folderKey, workspaceSourceId: sourceId, match: "same_root" }; },
    async readWorkspaceSourceTextV1() { return ""; }, async writeWorkspaceSourceTextAtomicV1() {}, async deleteWorkspaceSourceFileV1() {},
  } });
  return { workerRequest: () => workerRequest, sessions };
}

test("registered Task Worker dispatch admits exact acknowledged G5 Task only while scope remains current", async () => {
  const { f, state, workstreams, tasks, currentWs, exactTask, ctoRunContext } = await makeCurrentG5Fixture();
  const qaHistoryKey = key("independent-qa-history.fixture");
  const qaHistory = { schemaVersion: 1, records: [{ taskId: "unaffected-task", status: "passed", source: "historic-fixture" }] };
  await state.compareAndSet!(qaHistoryKey, { exists: false }, qaHistory);
  const host = installWorkerHost(f);
  const prepared = createBuilderPlatform().tools.find(tool => tool.name === "builder.prepare-task-worker")!;
  const prep = await prepared.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-affected", packetRevision: 2,
    role: "worker" }, ctoRunContext, f.platform);
  assert.equal((prep.data as { status: string }).status, "registered", JSON.stringify(prep.data));
  const dispatch = createBuilderPlatform().tools.find(tool => tool.name === "builder.dispatch-task-worker");
  assert(dispatch, "registered dispatch tool exists");
  const result = await dispatch.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-affected",
    packetRevision: 2, role: "worker" }, ctoRunContext, f.platform);
  assert.equal((result.data as { status: string }).status, "submitted");
  assert.equal((result.data as { qaVerdict: string }).qaVerdict, "not-established");
  assert.equal((result.data as { completion: string }).completion, "not-established");
  assert.deepEqual(await state.get(qaHistoryKey), qaHistory, "dispatch preserves prior unrelated QA history without treating it as current QA");

  const taskDrift = await makeCurrentG5Fixture();
  installWorkerHost(taskDrift.f);
  const taskPrep = await createBuilderPlatform().tools.find(tool => tool.name === "builder.prepare-task-worker")!.handler({ projectId: W,
    ctoId: CTO, workstreamId: "ws-1", taskId: "task-affected", packetRevision: 2, role: "worker" }, taskDrift.ctoRunContext, taskDrift.f.platform);
  assert.equal((taskPrep.data as { status: string }).status, "registered", JSON.stringify(taskPrep.data));
  const driftedBoard = (await taskDrift.tasks.current())!.revision;
  const driftedTask = { ...taskDrift.exactTask, packet: { ...taskDrift.exactTask.packet, title: "Changed after registration" } };
  await taskDrift.tasks.publish({ expectedBaseRevisionId: driftedBoard.revisionId, revision: { ...driftedBoard,
    revisionId: "task-changed-after-prepare", packets: [driftedTask] } });
  const taskDispatch = createBuilderPlatform().tools.find(tool => tool.name === "builder.dispatch-task-worker")!;
  await assert.rejects(async () => await taskDispatch.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-affected",
    packetRevision: 2, role: "worker" }, taskDrift.ctoRunContext, taskDrift.f.platform), /exact current prepared Task Worker role and identity/);

  const second = await makeCurrentG5Fixture();
  const crossed = installWorkerHost(second.f, async () => {
    const baselineStore = createDesignBaselineStore(W, W, second.state as unknown as RevisionState);
    const baseline = (await baselineStore.current())!.revision;
    await baselineStore.publish({ expectedBaseRevisionId: baseline.revisionId, revision: { ...baseline,
      revisionId: "base-after-admission", sourceDraftRevisionId: "draft-after", draftDigest: sha("after"),
      specification: { ...baseline.specification, revisionId: "spec-after" },
      graph: { ...baseline.graph, approvedSpecRevisionId: "spec-after" } } });
  });
  const prep2 = await createBuilderPlatform().tools.find(tool => tool.name === "builder.prepare-task-worker")!.handler({ projectId: W,
    ctoId: CTO, workstreamId: "ws-1", taskId: "task-affected", packetRevision: 2, role: "worker" }, second.ctoRunContext, second.f.platform);
  assert.equal((prep2.data as { status: string }).status, "registered");
  const raced = await dispatch.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-affected",
    packetRevision: 2, role: "worker" }, second.ctoRunContext, second.f.platform);
  assert.equal(crossed.workerRequest()?.state, "submitted", "the effect boundary did admit one immutable request");
  assert.equal((raced.data as { status: string }).status, "unknown", "stale approved baseline after admission is never reported as submitted/current");
  assert.equal((raced.data as { reason: string }).reason, "task-authority-changed-after-worker-dispatch");
  assert.equal((raced.data as { qaVerdict: string }).qaVerdict, "not-established");
  assert.deepEqual(await second.state.get(key("independent-qa-history.fixture")), null);
  void workstreams; void tasks; void currentWs; void exactTask;
});
