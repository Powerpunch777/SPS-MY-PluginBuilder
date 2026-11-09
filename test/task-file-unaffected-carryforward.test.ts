import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SpsActionContext } from "@sonparkserver/plugin-sdk/platform";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { createDesignBaselineStore, publishDesignBaseline } from "../src/design-baseline-tools.ts";
import { createDesignDraftStore } from "../src/design-draft-store.ts";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { readG5ChangeImpactCandidates } from "../src/g5-change-impact-tools.ts";
import { readG5Revalidation } from "../src/g5-revalidation.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { approveFirstDesignReview, proposeFirstDesignReview } from "../src/spec-assurance/review-first-design.ts";
import { createTaskPacketStore, publishCtoTaskPacket } from "../src/task-packet-tools.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../src/task-worker-runtime.ts";
import { prepareTaskWorker } from "../src/task-worker-tools.ts";
import { publishTechnologyDecisions } from "../src/technology-decision-tools.ts";
import { createUiContractStore } from "../src/ui-contracts/store.ts";
import { acknowledgeWorkstream, createWorkstreamStore, publishWorkstream } from "../src/workstream-tools.ts";
import { A, C, CTO, S, W, ctx, fixture, key, mapKey, now } from "./fixtures/cto-platform.ts";
import { prepareApprovedTaskFileDesign } from "./fixtures/task-file-approved-design.ts";

const WORKSTREAM = "ws-1", TASK = "carryforward-feature", PATH = "src/feature.ts";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORIGINAL_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", REBOUND_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccd";
const SOURCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", UI = "77777777-7777-4777-8777-777777777777";
const FILE_EFFECT = "localFolders.workspaceSourceFileEffectV1";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const status = (result: { data?: unknown }) => (result.data as { status: string }).status;

test("an exact G5 handoff for a change outside the Task scope does not renew a stale Worker file grant", async () => {
  const f = await fixture(W);
  const design = await prepareApprovedTaskFileDesign(f);
  const actor = { companyId: W, state: f.state,
    actor: { type: "user", companyId: W, userId: "synthetic-carryforward-reviewer" } } as unknown as SpsActionContext;
  const scope = { projectId: W, ctoId: CTO, workstreamId: WORKSTREAM };
  const taskStore = createTaskPacketStore(W, W, CTO, WORKSTREAM, f.state);
  const wsStore = createWorkstreamStore(W, W, f.state);
  const packet = { ...scope, taskId: TASK, revision: 1, kind: "development", title: "Scoped feature", goal: "Implement REQ-1",
    scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies: [], included: [PATH], excluded: [],
    constraints: [], acceptance: ["Keep the exact REQ-1 behavior"], evidenceRequired: ["Scoped source bytes"], reuse: [], testPlan: null,
    sourceAccess: { sourceId: SOURCE, folderKey: "project-source", branch: "feature/carryforward", expectedHead: "a".repeat(40),
      readPaths: [PATH], writePaths: [PATH], qaWritePaths: [] } };

  async function dispatchCto(boardRevisionId: string, specRevision: number) {
    const prior = (await f.deliveryStore().current())?.revision.runId;
    if (prior) f.runs.set(prior, { ...f.runs.get(prior)!, status: "failed", error: "Fixture planning Run ended.", errorCode: "fixture-ended" });
    const result = await dispatchCtoWorkstream({ projectId: W, workstreamId: WORKSTREAM, boardRevisionId, specRevision }, ctx(), f.platform);
    assert.equal(status(result), "submitted", JSON.stringify(result.data));
    return (await f.deliveryStore().current())!.revision.runId!;
  }
  async function publishTask(revisionId: string, expectedBaseRevisionId: string | null, revision: number, ctoRun: string) {
    const result = await publishCtoTaskPacket({ ...scope, revisionId, expectedBaseRevisionId, packet: { ...packet, revision } },
      ctx(C, ctoRun), f.platform);
    assert.equal(status(result), "published", JSON.stringify(result.data));
    return (await taskStore.current())!.revision.packets[0]!;
  }

  const originalCtoRun = await dispatchCto(design.params.boardRevisionId, design.params.specRevision);
  const original = await publishTask("carryforward-tasks-old", null, 1, originalCtoRun);
  const pluginAgentKey = `builder-task-worker:${digest([W, WORKSTREAM, TASK, "worker"])}`;
  Object.assign(f.platform.agents, {
    owned: { async get(input: { pluginAgentKey: string }) { return input.pluginAgentKey === pluginAgentKey
      ? { status: "resolved", revision: 1, agent: { agentId: AGENT, status: "idle" } } : { status: "missing" }; },
      async ensure() { assert.fail("Reuse the fixture-owned Worker identity."); } },
    async list() { return [{ id: A, companyId: W, status: "idle" }, { id: AGENT, companyId: W, status: "idle" }]; },
  });
  const sessions = f.platform.agents.sessions;
  const getCtoRun = sessions.getRun, getCtoRequest = sessions.getRequest;
  const workerRequests = new Map<string, string>();
  Object.assign(sessions, {
    async ensure() { return { sessionId: SESSION, created: true }; },
    async getRun(sessionId: string, workspaceId: string, runId: string) {
      if (sessionId === C) return getCtoRun(sessionId, workspaceId, runId);
      assert.equal(sessionId, SESSION); assert.equal(workspaceId, W);
      assert([...workerRequests.values()].includes(runId));
      return { runId, status: "running", cancellationRequested: false, termination: "not_applicable", error: null, errorCode: null };
    },
    async getRequest(sessionId: string, workspaceId: string, requestId: string) {
      if (sessionId === C) return getCtoRequest(sessionId, workspaceId, requestId);
      assert.equal(sessionId, SESSION); assert.equal(workspaceId, W);
      const runId = workerRequests.get(requestId);
      return runId ? { requestId, state: "submitted", runId } : null;
    },
  });
  async function register(record: typeof original, ctoRun: string, fixtureRun: string) {
    const result = await prepareTaskWorker({ ...scope, taskId: TASK, packetRevision: record.packet.revision, role: "worker" },
      ctx(C, ctoRun), f.platform);
    assert.equal(status(result), "registered", JSON.stringify(result.data));
    const registry = parseTaskWorkerRegistry(await f.state.get(key(taskWorkerRegistryKey(W, CTO))), W, W, CTO);
    const worker = registry.records.find(row => row.packetRevision === record.packet.revision)!;
    const binding = deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO, packet: record, currentPackets: [record], worker });
    const requestId = taskWorkerRequestId(binding);
    workerRequests.set(requestId, fixtureRun);
    return { binding, requestId };
  }
  const before = await register(original, originalCtoRun, ORIGINAL_RUN);
  let bytes = "initial", effects = 0;
  Object.assign(f.platform, { hostSupport: { state: "reported", contractVersion: "1.0", operations: [FILE_EFFECT] }, localFolders: {
    async status(folderKey: string) { return { folderKey, configured: true, access: "readWrite", readable: true, writable: true,
      healthy: true, requiredDirectories: [], requiredFiles: [], missingDirectories: [], missingFiles: [], checkedAt: now }; },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) { return { folderKey, workspaceSourceId, match: "same_root" }; },
    async workspaceSourceFileEffectV1(input: { sourceId: string; folderKey: string; relativePath: string; operation: string; contents: string;
      guards: readonly { namespace?: string; stateKey: string; expectedValue: unknown }[] }) {
      assert.equal(input.sourceId, SOURCE); assert.equal(input.folderKey, "project-source");
      assert.equal(input.relativePath, PATH); assert.equal(input.operation, "write");
      assert(input.guards.some(guard => guard.stateKey.startsWith("design-baseline-head.v1.")));
      for (const guard of input.guards) assert.deepEqual(await f.state.get({ scopeKind: "company", scopeId: W,
        ...(guard.namespace === undefined ? {} : { namespace: guard.namespace }), stateKey: guard.stateKey }), guard.expectedValue);
      bytes = input.contents;
      effects++;
      return { status: "written" };
    },
  } });
  const handler = createBuilderPlatform().tools.find(tool => tool.name === "builder.write-task-source-file")!;
  const write = async (runId: string, contents: string) => handler.handler({ relativePath: PATH, contents } as never,
    { companyId: W, agentId: AGENT, sessionId: SESSION, runId } as never, f.platform);
  assert.equal(status(await write(ORIGINAL_RUN, "prior work")), "written");
  assert.equal(effects, 1);

  const leadKey = key("lead-sessions.v1.1"), lead = await f.state.get(leadKey) as { sessions: Record<string, string | null> };
  f.values.set(mapKey(leadKey), { ...lead, sessions: { ...lead.sessions, "ui-design": UI } });
  const ui = createUiContractStore(W, W, f.state);
  async function formalUi(revisionId: string, baseline: typeof design.baseline, prior: string | null) {
    const html = "<main>Unchanged feature UI</main>";
    const htmlSha256 = sha(html), proposalRevisionId = `${revisionId}-proposal`, approvalRevisionId = `${revisionId}-approval`;
    assert.equal((await ui.propose({ revisionId: proposalRevisionId, expectedBaseRevisionId: prior ? `${prior}-proposal` : null,
      source: { kind: "baseline", revisionId: baseline.revisionId }, artifact: { artifactId: `${revisionId}-artifact`, html, htmlSha256,
        screenIds: ["home"], viewport: { width: 1280, height: 800 }, sourceSessionId: UI, sourceSpecRevisionId: baseline.specification.revisionId },
      contract: { projectId: W, revisionId: `${revisionId}-contract`, screenIds: ["home"], interactions: [{ id: "feature-ui",
        screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [],
        outcomes: ["Unchanged feature"], prohibited: [], validationCriteria: ["Unchanged scoped UI"], status: "specified" }] } },
    ctx(UI), f.platform)).status, "published");
    assert.equal((await ui.approveProposalAction({ revisionId: approvalRevisionId, expectedBaseRevisionId: prior ? `${prior}-approval` : null,
      proposalRevisionId, htmlSha256, approvedInteractionIds: ["feature-ui"] }, actor)).status, "published");
    assert.equal((await ui.publishFormal({ revisionId, expectedBaseRevisionId: prior, proposalRevisionId, approvalRevisionId },
      ctx(), f.platform)).status, "published");
  }
  const oldUi = "carryforward-ui-old", newUi = "carryforward-ui-new";
  await formalUi(oldUi, design.baseline, null);

  const drafts = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, f.state);
  const prior = (await drafts.current())!.revision;
  const turn = "66666666-6666-4666-8666-666666666666", newSource = `lead-turn:${turn}`;
  const priorTurn = await f.state.get(key(`lead-chat.turn.v1.${design.approvedDesign.sourceId.slice("lead-turn:".length)}`)) as {
    text: string; sequence: number;
  };
  const otherText = "Add independent documentation without changing the feature.";
  f.values.set(mapKey(key(`lead-chat.turn.v1.${turn}`)), { ...priorTurn, requestId: turn,
    previousRequestId: design.approvedDesign.sourceId.slice("lead-turn:".length), sequence: priorTurn.sequence + 1, text: otherText, sessionId: S });
  const draft = { ...prior.draft, revisionId: "carryforward-draft-new", sourceIds: [...prior.draft.sourceIds, newSource],
    specification: { ...prior.draft.specification, revisionId: "carryforward-spec-new",
      requirements: [...prior.draft.specification.requirements, { id: "REQ-2", description: "Independent documentation", acceptanceCriteriaIds: ["AC-2"] }] },
    graph: { ...prior.draft.graph, graphRevisionId: "carryforward-graph-new",
      entities: [...prior.draft.graph.entities, { id: "documentation", kind: "feature" as const, specRef: "REQ-2" }] } };
  assert.equal((await drafts.publish({ expectedBaseRevisionId: prior.draft.revisionId,
    revision: { ...prior, draft, sourceDigests: [...prior.sourceDigests, { id: newSource, sha256: sha(otherText) }] } })).status, "published");
  const criteria = [
    { requirementId: "REQ-1", acId: "AC-1", sourceId: design.approvedDesign.sourceId, quote: priorTurn.text },
    { requirementId: "REQ-2", acId: "AC-2", sourceId: newSource, quote: otherText },
  ];
  const proposal = await proposeFirstDesignReview({ projectId: W, expectedDraftRevisionId: draft.revisionId,
    expectedReviewHeadRevisionId: design.approvedDesign.approvalRevisionId, pack: { packId: "carryforward-review", version: "2.0.0",
      applicability: {}, rules: [], transitions: [], exceptions: [], excludedCombinations: [] },
    sourcePins: criteria.map(({ requirementId, acId, sourceId }) => ({ requirementId, acId, sourceId })),
    designModel: { facts: [], rulesVersion: "carryforward-v2", coverageRules: [], coverageTargets: [], scenarios: [],
      itemDecisions: criteria.map(({ requirementId, sourceId }) => ({ requirementId, status: "RESOLVED", reason: "Exact source review", sourceIds: [sourceId] })),
      acceptanceCriteria: criteria } }, ctx(), f.platform);
  assert(proposal.revision);
  const approval = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposal.revision.revisionId }, actor);
  assert("revision" in approval && approval.revision);
  const nextBaseline = "carryforward-baseline-new";
  assert.equal(status(await publishDesignBaseline({ projectId: W, expectedBaseRevisionId: design.baseline.revisionId,
    sourceDraftRevisionId: draft.revisionId, revisionId: nextBaseline, userSourceId: `first-design-review:${approval.revision.revisionId}`,
    interpretation: "Approve REQ-2 documentation without changing REQ-1." }, ctx(), f.platform)), "published");
  const baseline = (await createDesignBaselineStore(W, W, f.state).current())!.revision;
  assert.deepEqual(baseline.specification.requirements.filter(row => packet.requirementIds.includes(row.id)), design.baseline.specification.requirements);
  assert.deepEqual(baseline.graph.entities.filter(row => packet.scopeNodeIds.includes(row.id)), design.baseline.graph.entities);
  await formalUi(newUi, baseline, oldUi);
  await assert.rejects(() => write(ORIGINAL_RUN, "must not write after approval"), /Task file design scope is stale/);
  assert.equal(effects, 1);
  assert.equal(bytes, "prior work");

  const oldTech = design.instruction.spec.technologyDecisionsRef, newTech = "carryforward-tech-new";
  assert.equal(status(await publishTechnologyDecisions({ projectId: W, expectedBaseRevisionId: oldTech,
    register: { projectId: W, revisionId: newTech, sourceBaselineRevisionId: baseline.revisionId,
      sourceSpecRevisionId: baseline.specification.revisionId, sourceGraphRevisionId: baseline.graph.graphRevisionId, entries: [] } },
  ctx(), f.platform)), "published");
  const pairedBoard = "carryforward-ws-pair", pairedTaskBoard = "carryforward-task-pair";
  const pairedSpec = { ...design.instruction.spec, revision: design.instruction.spec.revision + 1,
    sourceSpecRevisionId: baseline.specification.revisionId, technologyDecisionsRef: newTech };
  const pairedChange = { ...design.instruction.change, previousRevision: design.instruction.spec.revision,
    reason: "Refresh the approved source pins; REQ-1 and its file scope are unchanged.", impactNodeIds: ["documentation"] };
  assert.equal(status(await publishWorkstream({ projectId: W, expectedBaseRevisionId: design.params.boardRevisionId,
    revisionId: pairedBoard, spec: pairedSpec, change: pairedChange }, ctx(), f.platform)), "published");
  const pairedTask = await publishTask(pairedTaskBoard, "carryforward-tasks-old", 2, await dispatchCto(pairedBoard, pairedSpec.revision));
  assert.deepEqual({ ...pairedTask.packet, revision: 1 }, original.packet);

  const pair = { projectId: W, oldBaselineRevisionId: design.baseline.revisionId, newBaselineRevisionId: baseline.revisionId,
    oldUiRevisionId: oldUi, newUiRevisionId: newUi, technology: { oldRevisionId: oldTech, newRevisionId: newTech },
    workstreams: { oldRevisionId: design.params.boardRevisionId, newRevisionId: pairedBoard },
    tasks: { ctoId: CTO, workstreamId: WORKSTREAM, oldRevisionId: "carryforward-tasks-old", newRevisionId: pairedTaskBoard } };
  const impact = (await readG5ChangeImpactCandidates(pair, ctx(), f.platform)).data as unknown as {
    sourcePins: Record<string, unknown>; dimensions: Record<string, { status: string; candidates: { recordId: string; basis: string }[] }>;
    executionAuthorized: boolean;
  };
  for (const [field, value] of Object.entries(pair)) if (field !== "projectId") assert.deepEqual(impact.sourcePins[field], value);
  const directChanges = (dimension: string) => impact.dimensions[dimension]!.candidates
    .filter(row => row.basis === "direct-revision-diff").map(row => row.recordId);
  assert.deepEqual(directChanges("requirements"), ["REQ-2"]);
  assert.deepEqual(directChanges("graph"), ["documentation"]);
  assert.deepEqual(directChanges("ui"), []);
  assert.equal(impact.executionAuthorized, false);
  const revalidation = (await readG5Revalidation(pair, ctx(), f.platform)).data as unknown as {
    g5WorkstreamHandoffProposals: { workstreamId: string; g5Handoff: { impactSha256: string; affectedTaskIds: string[] } }[];
    affectedTasks: { id: string; priorExecutionEvidenceReuse: { status: string } }[];
  };
  const handoff = revalidation.g5WorkstreamHandoffProposals.find(row => row.workstreamId === WORKSTREAM)!.g5Handoff;
  assert.equal(handoff.impactSha256, digest({ sourcePins: impact.sourcePins, dimensions: impact.dimensions }));
  assert.equal(revalidation.affectedTasks.find(row => row.id === TASK)?.priorExecutionEvidenceReuse.status, "UNKNOWN",
    "this fixture has no immutable Run artifact or independent QA evidence to carry forward");
  const handoffBoard = "carryforward-ws-handoff", handoffSpec = { ...pairedSpec, revision: pairedSpec.revision + 1 };
  assert.equal(status(await publishWorkstream({ projectId: W, expectedBaseRevisionId: pairedBoard, revisionId: handoffBoard,
    spec: handoffSpec, change: { ...pairedChange, previousRevision: pairedSpec.revision, impactTaskIds: handoff.affectedTaskIds, g5Handoff: handoff } },
  ctx(), f.platform)), "published");
  const handoffRun = await dispatchCto(handoffBoard, handoffSpec.revision);
  assert.equal(status(await acknowledgeWorkstream({ ...scope, expectedBaseRevisionId: handoffBoard, revisionId: "carryforward-ws-ready",
    specRevision: handoffSpec.revision, readiness: "ready", note: "Acknowledge the exact G5 published pair." }, ctx(C, handoffRun), f.platform)), "published");
  const currentWs = (await wsStore.current())!.revision.workstreams[0]!;
  assert.equal(currentWs.receipt?.readiness, "ready");
  await assert.rejects(() => write(ORIGINAL_RUN, "must not write on a stale grant"), /active Worker registration does not match/);
  assert.equal(effects, 1);
  assert.equal(bytes, "prior work");

  const rebound = await publishTask("carryforward-tasks-rebound", pairedTaskBoard, 3, handoffRun);
  assert.deepEqual({ ...rebound.packet, revision: 1 }, original.packet);
  assert.equal(rebound.source.instructionSha256, workstreamInstructionDigest(currentWs));
  assert.notEqual(rebound.source.instructionSha256, original.source.instructionSha256);
  const fresh = await register(rebound, handoffRun, REBOUND_RUN);
  assert.notEqual(fresh.binding.packetRecordSha256, before.binding.packetRecordSha256);
  assert.notEqual(fresh.requestId, before.requestId);
  // A fresh grant allows work; it does not establish reuse of the original Run or QA evidence.
  assert.equal(status(await write(REBOUND_RUN, "fresh binding")), "written");
  assert.equal(effects, 2);
  assert.equal(bytes, "fresh binding");
});
