import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDesignDraftStore } from "../src/design-draft-store.ts";
import { createDesignBaselineStore, publishDesignBaseline } from "../src/design-baseline-tools.ts";
import { approveFirstDesignReview, proposeFirstDesignReview } from "../src/spec-assurance/review-first-design.ts";
import { createUiContractStore } from "../src/ui-contracts/store.ts";
import { createTechnologyDecisionStore, publishTechnologyDecisions } from "../src/technology-decision-tools.ts";
import { createWorkstreamStore, acknowledgeWorkstream } from "../src/workstream-tools.ts";
import { readG5Revalidation } from "../src/g5-revalidation.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { prepareTaskWorker } from "../src/task-worker-tools.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../src/task-worker-runtime.ts";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { W, A, C, CTO, ctx, now, key, mapKey } from "./fixtures/cto-platform.ts";
import { fixture } from "./fixtures/cto-platform.ts";
import { prepareApprovedTaskFileDesign } from "./fixtures/task-file-approved-design.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", SOURCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NS = "sonpark.my-builder", METHOD = "localFolders.workspaceSourceFileEffectV1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

async function setup() {
  const f = await fixture(W);
  const design = await prepareApprovedTaskFileDesign(f);
  f.values.set(mapKey(key("qa-history.unrelated")), { records: [{ taskId: "another-task", verdict: "historical-only" }] });
  await dispatchCtoWorkstream(design.params, ctx(), f.platform);
  const delivery = (await f.deliveryStore().current())!.revision, ctoRun = [...f.runs.keys()][0]!;
  const record = { packet: { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-file-qa", revision: 1,
    kind: "development" as const, title: "Scoped file effect", goal: "Change only the assigned source.",
    scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies: [], included: ["src/feature.ts"], excluded: [],
    constraints: [], acceptance: ["The exact scoped change is inspectable"], evidenceRequired: ["Source bytes"], reuse: [], testPlan: null,
    sourceAccess: { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task-file-qa", expectedHead: "a".repeat(40),
      readPaths: ["src/feature.ts"], writePaths: ["src/feature.ts"], qaWritePaths: [] } },
    source: { requestId: delivery.requestId, workstreamId: "ws-1", specRevision: design.instruction.spec.revision,
      instructionSha256: workstreamInstructionDigest(design.instruction) }, author: { agentId: A, sessionId: C, runId: ctoRun },
    createdAtISO: now, dependencyPins: [] };
  const packets = createTaskPacketStore(W, W, CTO, "ws-1", f.state);
  assert.equal((await packets.publish({ expectedBaseRevisionId: null, revision: { projectId: W, ctoId: CTO,
    workstreamId: "ws-1", revisionId: "g5-file-qa-board-1", packets: [record] } })).status, "published");
  const pluginAgentKey = `builder-task-worker:${hash([W, "ws-1", "task-file-qa", "worker"])}`;
  Object.assign(f.platform.agents, {
    owned: { async get(input: { pluginAgentKey: string }) { return input.pluginAgentKey === pluginAgentKey
      ? { status: "resolved", revision: 1, agent: { agentId: AGENT, status: "idle" } } : { status: "missing" }; },
      async ensure() { assert.fail("The exact fixture-owned Worker identity must be reused"); } },
    async list() { return [{ id: A, companyId: W, status: "idle" }, { id: AGENT, companyId: W, status: "idle" }]; },
  });
  Object.assign(f.platform.agents.sessions, { async ensure() { return { sessionId: SESSION, created: true }; } });
  const prepared = await prepareTaskWorker({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-file-qa",
    packetRevision: 1, role: "worker" }, ctx(C, ctoRun), f.platform);
  assert.equal((prepared.data as { status: string }).status, "registered", JSON.stringify(prepared.data));
  const registry = parseTaskWorkerRegistry(await f.state.get(key(taskWorkerRegistryKey(W, CTO))), W, W, CTO);
  let currentRecord = record;
  let binding = deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO, packet: record,
    currentPackets: [record], worker: registry.records[0]! });
  const getCtoRun = f.platform.agents.sessions.getRun, getCtoRequest = f.platform.agents.sessions.getRequest;
  Object.assign(f.platform.agents.sessions, {
    async getRun(sessionId: string, workspaceId: string, runId: string) {
      if (sessionId === C) return getCtoRun(sessionId, workspaceId, runId);
      assert.equal(sessionId, SESSION); assert.equal(workspaceId, W); assert.equal(runId, RUN);
      return { runId: RUN, status: "running", cancellationRequested: false, termination: "not_applicable", error: null, errorCode: null };
    },
    async getRequest(sessionId: string, workspaceId: string, requestId: string) {
      if (sessionId === C) return getCtoRequest(sessionId, workspaceId, requestId);
      assert.equal(sessionId, SESSION); assert.equal(workspaceId, W); assert.equal(requestId, taskWorkerRequestId(binding));
      return { requestId, state: "submitted", runId: RUN };
    },
  });
  let effects = 0;
  let seenGuards: readonly { namespace?: string; stateKey: string; expectedValue: unknown }[] = [];
  let beforeEffect = async (_input: { guards: typeof seenGuards }) => {};
  const files = new Map([["src/feature.ts", "original"]]);
  Object.assign(f.platform, { hostSupport: { state: "reported", contractVersion: "1.0", operations: [METHOD] }, localFolders: {
    async status(folderKey: string) { return { folderKey, configured: true, access: "readWrite", readable: true, writable: true,
      healthy: true, requiredDirectories: [], requiredFiles: [], missingDirectories: [], missingFiles: [], checkedAt: now }; },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) { return { folderKey, workspaceSourceId, match: "same_root" }; },
    async workspaceSourceFileEffectV1(input: { sourceId: string; folderKey: string; relativePath: string;
      operation: "read" | "write" | "delete"; contents?: string;
      guards: readonly { namespace?: string; stateKey: string; expectedValue: unknown }[] }) {
      assert.equal(input.sourceId, SOURCE); assert.equal(input.folderKey, "project-source");
      assert.equal(input.relativePath, "src/feature.ts");
      seenGuards = input.guards;
      await beforeEffect(input);
      for (const guard of input.guards) assert.deepEqual(await f.state.get({ scopeKind: "company", scopeId: W,
        ...(guard.namespace === undefined ? {} : { namespace: guard.namespace }), stateKey: guard.stateKey }), guard.expectedValue);
      effects++;
      if (input.operation === "read") return { status: "read", text: files.get(input.relativePath) };
      if (input.operation === "write") { files.set(input.relativePath, input.contents!); return { status: "written" }; }
      files.delete(input.relativePath); return { status: "deleted" };
    },
  } });
  const tools = createBuilderPlatform().tools;
  const handler = tools.find(tool => tool.name === "builder.write-task-source-file")!;
  const context = { companyId: W, agentId: AGENT, sessionId: SESSION, runId: RUN };
  const call = (contents = "updated", extra = {}) => handler.handler({ relativePath: "src/feature.ts", contents, ...extra } as never,
    context as never, f.platform);
  return { f, design, record, packets, files, call, get effects() { return effects; }, get seenGuards() { return seenGuards; },
    async bindCurrentTask(nextRecord: typeof record, ctoRunId: string) {
      const result = await prepareTaskWorker({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: nextRecord.packet.taskId,
        packetRevision: nextRecord.packet.revision, role: "worker" }, ctx(C, ctoRunId), f.platform);
      assert.equal((result.data as { status: string }).status, "registered", JSON.stringify(result.data));
      currentRecord = nextRecord;
      const currentRegistry = parseTaskWorkerRegistry(await f.state.get(key(taskWorkerRegistryKey(W, CTO))), W, W, CTO);
      binding = deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO, packet: currentRecord,
        currentPackets: [currentRecord], worker: currentRegistry.records.find(row => row.packetRevision === nextRecord.packet.revision)! });
    },
    setBeforeEffect(fn: typeof beforeEffect) { beforeEffect = fn; } };
}

async function makeScopedG5Current(f: Awaited<ReturnType<typeof setup>>) {
  const { f: platformFixture, design } = f;
  const leadSessionsKey = key("lead-sessions.v1.1");
  const sessions = await platformFixture.state.get(leadSessionsKey) as Record<string, unknown>;
  platformFixture.values.set(mapKey(leadSessionsKey), { ...sessions,
    sessions: { ...(sessions.sessions as object), "ui-design": "77777777-7777-4777-8777-777777777777" } });
  const uiSession = "77777777-7777-4777-8777-777777777777";
  const uiStore = createUiContractStore(W, W, platformFixture.state);
  const publishUi = async (revisionId: string, baselineRevisionId: string, expectedProposal: string | null,
    expectedApproval: string | null, expectedFormal: string | null) => {
    const baseline = (await createDesignBaselineStore(W, W, platformFixture.state).publishedRevision(baselineRevisionId))!.revision;
    const html = `<main>${revisionId}</main>`;
    assert.equal((await uiStore.propose({ revisionId: `${revisionId}-proposal`, expectedBaseRevisionId: expectedProposal,
      source: { kind: "baseline", revisionId: baselineRevisionId }, artifact: { artifactId: `${revisionId}-artifact`, html,
        htmlSha256: createHash("sha256").update(html, "utf8").digest("hex"), screenIds: ["home"],
        viewport: { width: 1280, height: 800 }, sourceSessionId: uiSession,
        sourceSpecRevisionId: baseline.specification.revisionId }, contract: { projectId: W,
        revisionId: `${revisionId}-contract`, screenIds: ["home"], interactions: [{ id: "i1", screenId: "home",
          requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [], outcomes: [revisionId],
          prohibited: [], validationCriteria: ["Exact scoped UI"], status: "specified" }] } },
    { ...ctx(uiSession), companyId: W }, platformFixture.platform)).status, "published");
    assert.equal((await uiStore.approveProposalAction({ revisionId: `${revisionId}-approval`, expectedBaseRevisionId: expectedApproval,
      proposalRevisionId: `${revisionId}-proposal`, htmlSha256: createHash("sha256").update(html, "utf8").digest("hex"),
      approvedInteractionIds: ["i1"] }, { companyId: W, state: platformFixture.state,
        actor: { type: "user", companyId: W, userId: "synthetic-g5-ui-reviewer" } } as never)).status, "published");
    assert.equal((await uiStore.publishFormal({ revisionId, expectedBaseRevisionId: expectedFormal,
      proposalRevisionId: `${revisionId}-proposal`, approvalRevisionId: `${revisionId}-approval` }, ctx(), platformFixture.platform)).status,
    "published");
  };
  await publishUi("g5-ui-old", design.baseline.revisionId, null, null, null);

  const draftStore = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, platformFixture.state);
  const currentDraft = await draftStore.current(); assert(currentDraft);
  const sourceTurn = design.approvedDesign.sourceId.slice("lead-turn:".length);
  const originalSource = await platformFixture.state.get(key(`lead-chat.turn.v1.${sourceTurn}`)) as { text: string } | null;
  assert(originalSource);
  const draftId = "task-file-g5-draft-v2", specId = "task-file-g5-spec-v2", graphId = "task-file-g5-graph-v2";
  const nextDraft = { ...currentDraft.revision, draft: { ...currentDraft.revision.draft, revisionId: draftId,
    specification: { ...currentDraft.revision.draft.specification, revisionId: specId,
      requirements: currentDraft.revision.draft.specification.requirements.map(row => ({ ...row, description: `${row.description} revised` })) },
    graph: { ...currentDraft.revision.draft.graph, graphRevisionId: graphId } } };
  assert.equal((await draftStore.publish({ expectedBaseRevisionId: currentDraft.revision.draft.revisionId, revision: nextDraft })).status, "published");
  const proposal = await proposeFirstDesignReview({ projectId: W, expectedDraftRevisionId: draftId,
    expectedReviewHeadRevisionId: design.approvedDesign.approvalRevisionId, pack: { packId: "task-file-g5-review", version: "2.0.0", applicability: {}, rules: [],
      transitions: [], exceptions: [], excludedCombinations: [] },
    sourcePins: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: design.approvedDesign.sourceId }],
    designModel: { facts: [], rulesVersion: "task-file-g5-v2", coverageRules: [], coverageTargets: [], scenarios: [],
      itemDecisions: [{ requirementId: "REQ-1", status: "RESOLVED", reason: "Scoped G5 fixture review.",
        sourceIds: [design.approvedDesign.sourceId] }], acceptanceCriteria: [{ requirementId: "REQ-1", acId: "AC-1",
        sourceId: design.approvedDesign.sourceId, quote: originalSource.text }] } }, ctx(), platformFixture.platform);
  assert(proposal.revision);
  const approval = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposal.revision.revisionId },
    { companyId: W, state: platformFixture.state, actor: { type: "user", companyId: W, userId: "synthetic-g5-design-reviewer" } } as never);
  assert("revision" in approval && approval.revision);
  const baselineStore = createDesignBaselineStore(W, W, platformFixture.state);
  const baseline2Id = "task-file-g5-baseline-v2";
  assert.equal(((await publishDesignBaseline({ projectId: W, expectedBaseRevisionId: design.baseline.revisionId,
    sourceDraftRevisionId: draftId, revisionId: baseline2Id, userSourceId: `first-design-review:${approval.revision.revisionId}`,
    interpretation: "Publish the exact G5 fixture design update." }, ctx(), platformFixture.platform)).data as { status: string }).status, "published");
  const baseline2 = (await baselineStore.current())!.revision;
  await publishUi("g5-ui-current", baseline2Id, "g5-ui-old-proposal", "g5-ui-old-approval", "g5-ui-old");

  const technologyStore = createTechnologyDecisionStore(W, W, platformFixture.state);
  const techHead = (await technologyStore.current())!;
  const tech2Id = "task-file-g5-technology-v2";
  assert.equal(((await publishTechnologyDecisions({ projectId: W, expectedBaseRevisionId: techHead.revision.register.revisionId,
    register: { projectId: W, revisionId: tech2Id, sourceBaselineRevisionId: baseline2Id,
      sourceSpecRevisionId: baseline2.specification.revisionId, sourceGraphRevisionId: baseline2.graph.graphRevisionId, entries: [] } },
  ctx(), platformFixture.platform)).data as { status: string }).status, "published");

  const workstreams = createWorkstreamStore(W, W, platformFixture.state);
  const oldBoard = (await workstreams.current())!;
  const oldWs = oldBoard.revision.workstreams.find(row => row.spec.id === "ws-1")!;
  const pairedWs = { ...oldWs, spec: { ...oldWs.spec, revision: oldWs.spec.revision + 1,
    sourceSpecRevisionId: baseline2.specification.revisionId, technologyDecisionsRef: tech2Id },
    sourceBaselineRevisionId: baseline2Id, baselineDigest: hash(baseline2), technologyDigest: "pending" as string,
    change: { ...oldWs.change, previousRevision: oldWs.spec.revision }, receipt: null };
  const tech2 = await technologyStore.current(); assert(tech2);
  const paired = { ...pairedWs, technologyDigest: hash(tech2.revision) };
  const wsNewId = "task-file-g5-workstreams-v2";
  assert.equal((await workstreams.publish({ expectedBaseRevisionId: oldBoard.revision.revisionId,
    revision: { projectId: W, revisionId: wsNewId, workstreams: [paired] } })).status, "published");
  const tasks = f.packets;
  const oldTask = f.record;
  const task2 = { ...oldTask, packet: { ...oldTask.packet, revision: 2 }, source: { ...oldTask.source,
    specRevision: paired.spec.revision, instructionSha256: workstreamInstructionDigest(paired) } };
  assert.equal((await tasks.publish({ expectedBaseRevisionId: "g5-file-qa-board-1", revision: { projectId: W, ctoId: CTO,
    workstreamId: "ws-1", revisionId: "task-file-g5-tasks-v2", packets: [task2] } })).status, "published");
  const comparison = await readG5Revalidation({ projectId: W, oldBaselineRevisionId: design.baseline.revisionId,
    newBaselineRevisionId: baseline2Id, oldUiRevisionId: "g5-ui-old", newUiRevisionId: "g5-ui-current",
    technology: { oldRevisionId: techHead.revision.register.revisionId, newRevisionId: tech2Id },
    workstreams: { oldRevisionId: oldBoard.revision.revisionId, newRevisionId: wsNewId },
    tasks: { ctoId: CTO, workstreamId: "ws-1", oldRevisionId: "g5-file-qa-board-1", newRevisionId: "task-file-g5-tasks-v2" } },
  ctx(), platformFixture.platform);
  const handoff = (comparison.data as { g5WorkstreamHandoffProposals: Array<{ g5Handoff: Record<string, unknown> }> })
    .g5WorkstreamHandoffProposals[0]!.g5Handoff;
  const affected = handoff.affectedTaskIds as string[];
  const handoffWs = { ...paired, spec: { ...paired.spec, revision: paired.spec.revision + 1 }, change: {
    ...paired.change, previousRevision: paired.spec.revision, impactTaskIds: affected, g5Handoff: handoff }, receipt: null };
  const handoffBoardId = "task-file-g5-handoff";
  assert.equal((await workstreams.publish({ expectedBaseRevisionId: wsNewId,
    revision: { projectId: W, revisionId: handoffBoardId, workstreams: [handoffWs] } })).status, "published");
  const priorCtoRunId = [...platformFixture.runs.keys()][0]!;
  const priorCtoRun = platformFixture.runs.get(priorCtoRunId)!;
  platformFixture.runs.set(priorCtoRunId, { ...priorCtoRun, status: "failed", error: "Synthetic fixture Run closed before G5 re-dispatch.",
    errorCode: "synthetic-fixture-terminal" });
  await dispatchCtoWorkstream({ projectId: W, workstreamId: "ws-1", specRevision: handoffWs.spec.revision,
    boardRevisionId: handoffBoardId }, ctx(), platformFixture.platform);
  const delivery = (await platformFixture.deliveryStore().current())!.revision;
  const ack = await acknowledgeWorkstream({ projectId: W, ctoId: CTO, workstreamId: "ws-1", expectedBaseRevisionId: handoffBoardId,
    revisionId: "task-file-g5-ack", specRevision: handoffWs.spec.revision, readiness: "ready",
    note: "Exact scoped G5 Task reviewed." }, ctx(C, delivery.runId!), platformFixture.platform);
  assert.equal((ack.data as { status: string }).status, "published");
  const acknowledged = (await workstreams.current())!.revision.workstreams[0]!;
  const currentTask = { ...task2, packet: { ...task2.packet, revision: 3 }, source: { requestId: delivery.requestId,
    workstreamId: "ws-1", specRevision: acknowledged.spec.revision, instructionSha256: workstreamInstructionDigest(acknowledged) } };
  assert.equal((await tasks.publish({ expectedBaseRevisionId: "task-file-g5-tasks-v2", revision: { projectId: W, ctoId: CTO,
    workstreamId: "ws-1", revisionId: "task-file-g5-current", packets: [currentTask] } })).status, "published");
  await f.bindCurrentTask(currentTask, delivery.runId!);
  return { handoff, currentTask, delivery };
}

test("registered handler checks the approved design and forwards scoped observed heads to the synthetic Core boundary", async () => {
  const f = await setup();
  const result = await f.call() as { data: { status: string } };
  assert.equal(result.data.status, "written");
  assert.equal(f.files.get("src/feature.ts"), "updated");
  assert.equal(f.effects, 1);
  assert.equal(f.f.runs.size, 1, "only CTO fixture dispatch exists; no model or Worker execution was started");
});

test("a newer unapproved draft does not block the exact previously approved Task", async () => {
  const f = await setup();
  const drafts = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, f.f.state);
  const current = await drafts.current();
  assert(current);
  const pending = { ...current.revision, draft: { ...current.revision.draft, revisionId: "task-file-pending-draft",
    specification: { ...current.revision.draft.specification, revisionId: "task-file-pending-spec" },
    graph: { ...current.revision.draft.graph, graphRevisionId: "task-file-pending-graph" } } };
  assert.equal((await drafts.publish({ expectedBaseRevisionId: current.revision.draft.revisionId, revision: pending })).status, "published");
  const before = structuredClone(f.f.values);
  const result = await f.call("still-current") as { data: { status: string } };
  assert.equal(result.data.status, "written");
  assert.equal(f.files.get("src/feature.ts"), "still-current");
  assert.equal(f.effects, 1);
  assert.deepEqual([...f.f.values.entries()].filter(([value]) => value.includes("qa-history")),
    [...before.entries()].filter(([value]) => value.includes("qa-history")));
});

test("a relevant design head race is rejected before the synthetic file effect and preserves unrelated QA history", async () => {
  const f = await setup();
  const before = structuredClone(f.f.values);
  f.setBeforeEffect(async input => {
    const guard = input.guards.find(item => item.namespace === NS && item.stateKey.startsWith("design-baseline-head.v1."));
    assert(guard, "the exact current approved Baseline head must be observed");
    const encoded = JSON.stringify(key(guard.stateKey));
    const value = f.f.values.get(encoded);
    assert(value);
    f.f.values.set(encoded, { ...value as object, raced: true });
  });
  const result = await f.call("must-not-write") as { data: { status: string; reason?: string } };
  assert.equal(result.data.status, "unknown");
  assert.equal(f.files.get("src/feature.ts"), "original");
  assert.equal(f.effects, 0);
  assert.deepEqual([...f.f.values.entries()].filter(([key]) => key.includes("qa-history")),
    [...before.entries()].filter(([key]) => key.includes("qa-history")));
});

test("guards carry current Baseline and Lead selection, while this non-G5 scope does not require a UI head", async () => {
  const f = await setup();
  const result = await f.call("guard-check") as { data: { status: string } };
  assert.equal(result.data.status, "written");
  const keys = new Set(f.seenGuards.filter(item => item.namespace === NS).map(item => item.stateKey));
  const rawHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  for (const expected of [taskWorkerRegistryKey(W, CTO), `project-ctos.v1.${rawHash(W)}`,
    `workstreams-head.v1.${rawHash(W)}`, `task-packets-head.v1.${rawHash(`packets:${hash([W, CTO, "ws-1"])}`)}`,
    `cto-delivery-head.v1.${rawHash(`cto:${hash([W, CTO])}`)}`, `design-baseline-head.v1.${rawHash(W)}`, "lead-agent.v1"])
    assert(keys.has(expected), `expected captured current head ${expected}`);
  assert(![...keys].some(value => value.startsWith("ui-contracts-head.v1.")), "unscoped G5 must not add a global UI head guard");
  assert(f.seenGuards.every(item => !item.stateKey.includes("-revision.v1.")));
});

test("registered file handler forwards the current scoped G5 UI head with its other observed Core guards", async () => {
  const f = await setup();
  const scoped = await makeScopedG5Current(f);
  const result = await f.call("g5-scoped-write") as { data: { status: string } };
  assert.equal(result.data.status, "written");
  assert.equal(f.files.get("src/feature.ts"), "g5-scoped-write");
  assert.equal(f.effects, 1);
  assert((scoped.handoff.affectedTaskIds as string[]).includes("task-file-qa"), "the current file Task is pinned by the exact G5 handoff");
  const uiHead = f.seenGuards.find(item => item.namespace === NS && item.stateKey.startsWith("ui-contracts-head.v1."));
  assert(uiHead, "scoped G5 must pass the exact observed UI journal head to Core");
  assert.deepEqual(await f.f.state.get(key(uiHead.stateKey)), uiHead.expectedValue);
});

test("a scoped G5 UI head race is rejected by the Core guard before file mutation", async () => {
  const f = await setup();
  await makeScopedG5Current(f);
  f.setBeforeEffect(async input => {
    const uiHead = input.guards.find(item => item.namespace === NS && item.stateKey.startsWith("ui-contracts-head.v1."));
    assert(uiHead, "the registered file call must provide the scoped G5 UI guard");
    const encoded = JSON.stringify(key(uiHead.stateKey));
    const current = f.f.values.get(encoded);
    assert(current);
    f.f.values.set(encoded, { ...(current as object), raced: true });
  });
  const result = await f.call("must-not-mutate") as { data: { status: string; reason?: string } };
  assert.equal(result.data.status, "unknown");
  assert.equal(result.data.reason, "task-source-file-effect-outcome-uncertain");
  assert.equal(f.files.get("src/feature.ts"), "original");
  assert.equal(f.effects, 0);
  assert.deepEqual(await f.f.state.get(key("qa-history.unrelated")),
    { records: [{ taskId: "another-task", verdict: "historical-only" }] });
});
