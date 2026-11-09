import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { qaCarryForwardPin } from "../src/builder-gates/qa-carry-forward.ts";
import { verifyTaskQaReportForSnapshot } from "../src/builder-gates/verified-task-qa-report.ts";
import { createWorkstreamStore, readWorkstreams } from "../src/workstream-tools.ts";
import { integrationTool, preparedFixture, BASE_COMMIT, BASE_TREE, SOURCE, MANAGER, MANAGER_SESSION, MANAGER_RUN } from "./fixtures/integration-manager-platform.ts";
import { createCarriedTaskQaIndependentFixture } from "./fixtures/carried-task-qa-independent.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { parseUiRevision } from "../src/ui-contracts/domain.ts";
import { createRevisionJournal } from "../src/solution-revision-store.ts";
import { createIntegrationPlanStore, parseIntegrationPlan } from "../src/builder-gates/integration-plan.ts";
import { consumeVerifiedWorkstreamJob } from "../src/builder-gates/integration-manager-job.ts";
import { WORKSTREAM_VERIFIED_JOB } from "../src/builder-gates/workstream-verification-publication.ts";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey, integrationManagerStateKey } from "../src/domain/integration-manager.ts";
import { CTO, W, mapKey, now } from "./fixtures/cto-platform.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const sha = (char: string) => char.repeat(64);
const pin = (sourceId: string, revisionId: string, sha256: string) => ({ sourceId, revisionId, sha256 });

function fixture(carried = false) {
  const task = { packet: { taskId: "task-dev", workstreamId: "ws-1", revision: 3,
    sourceAccess: { sourceId: "source-1", folderKey: "project-source", branch: "worker" } } } as any;
  const qaTask = { packet: { taskId: "task-qa", workstreamId: "ws-1", revision: 2 } } as any;
  const handoff = { oldBaselineRevisionId: "b1", newBaselineRevisionId: "b2", oldUiRevisionId: "u1", newUiRevisionId: "u2",
    technology: null, workstreams: { oldRevisionId: "w1", newRevisionId: "w2" },
    tasks: { ctoId: "cto-1", workstreamId: "ws-1", oldRevisionId: "board-r1", newRevisionId: "board-r2" },
    workstreamImpactStatus: "CANDIDATES", taskImpactStatus: "CANDIDATES", affectedTaskIds: ["task-dev"], impactSha256: sha("a") };
  const report = { revisionId: "report-r1", verdict: "passed", coreStatus: "succeeded", reference: { revisionId: "ref-r1", binding: {
    implementationTaskId: "task-dev", implementationRevision: carried ? 1 : 3, implementationDigest: carried ? sha("1") : sha("3"),
    qaRevision: carried ? 1 : 2, qaDigest: carried ? sha("2") : sha("4"), sourceId: "source-1", folderKey: "project-source", branch: "worker",
    commitSha: "a".repeat(40), treeSha: "b".repeat(40) } } } as any;
  const reportPin = pin("builder-v1:task-qa-report:task-qa", report.revisionId, hash(report));
  const proof = { kind: "g5-task-qa-carry-forward-v1", taskId: "task-dev", qaTaskId: "task-qa", handoffSha256: hash(handoff),
    priorTaskBoardRevisionId: "board-r1", comparedTaskBoardRevisionId: "board-r2", currentTaskBoardRevisionId: "board-r3",
    task: { prior: sha("1"), compared: sha("5"), current: sha("3"), inputsSha256: sha("6") },
    qa: { prior: sha("2"), compared: sha("7"), current: sha("4"), inputsSha256: sha("8") } };
  const workstream = { change: { g5Handoff: handoff }, receipt: { readiness: "ready", revision: 4 }, spec: { revision: 4 } } as any;
  const qaEvidence = { result: "passed", report: reportPin, ...(carried ? { carryForward: proof } : {}) };
  const snapshot = { sourcePins: [pin("builder-v1:task-packet:task-dev", "task-dev:3", sha("3")),
    pin("builder-v1:task-packet:task-qa", "task-qa:2", sha("4")), pin("builder-v1:workstream:ws-1", "4", hash(workstream)), reportPin,
    pin("builder-v1:task-qa-run:task-qa", report.reference.revisionId, hash(report.reference)),
    ...(carried ? [qaCarryForwardPin(proof as any, reportPin)] : [])],
    qaEvidence: [qaEvidence] } as any;
  const input = { snapshot, task, taskDigest: sha("3"), qaTask, qaDigest: sha("4"), taskBoardRevisionId: "board-r3", workstream,
    report, reportPin };
  return { input, proof };
}

test("verified task QA accepts exact current pins or a bound historical report, and rejects drift", () => {
  const ordinary = fixture();
  assert.equal(verifyTaskQaReportForSnapshot(ordinary.input), true);
  const currentDrift = fixture();
  currentDrift.input.taskDigest = sha("9");
  assert.equal(verifyTaskQaReportForSnapshot(currentDrift.input), false);

  const carried = fixture(true);
  assert.equal(verifyTaskQaReportForSnapshot(carried.input), true);
  const boardDrift = fixture(true);
  boardDrift.input.taskBoardRevisionId = "board-r4";
  assert.equal(verifyTaskQaReportForSnapshot(boardDrift.input), false);
  const handoffDrift = fixture(true);
  handoffDrift.input.workstream.change.g5Handoff.impactSha256 = sha("f");
  assert.equal(verifyTaskQaReportForSnapshot(handoffDrift.input), false);
  const olderBoardDrift = fixture(true);
  const changed = { ...olderBoardDrift.proof, priorTaskBoardRevisionId: "other-prior-board" };
  olderBoardDrift.input.snapshot.qaEvidence[0].carryForward = changed;
  olderBoardDrift.input.snapshot.sourcePins.pop();
  olderBoardDrift.input.snapshot.sourcePins.push(qaCarryForwardPin(changed as any, olderBoardDrift.input.reportPin));
  assert.equal(verifyTaskQaReportForSnapshot(olderBoardDrift.input), false);
});

test("registered Manager integration fails closed when the Workstream head moves after guarded snapshot read", async () => {
  const fixture = await preparedFixture();
  let moved = false, gitCalls = 0;
  Object.assign(fixture.f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      if (!moved) {
        moved = true;
        const board = (await readWorkstreams(W, W, fixture.f.platform))!;
        const extra = { ...board.revision.workstreams[0]!, spec: { ...board.revision.workstreams[0]!.spec,
          id: "ws-unrelated", dependencies: [] } };
        await createWorkstreamStore(W, W, fixture.f.state as never).publish({ expectedBaseRevisionId: board.revision.revisionId,
          revision: { projectId: W, revisionId: "manager-qa-head-race", workstreams: [...board.revision.workstreams, extra] } });
      }
      return { status: "current", sourceId, folderKey, branch, commitSha: BASE_COMMIT, treeSha: BASE_TREE, observedAt: "fixture" };
    },
    async integrateWorkspaceSourceCommitV1() { gitCalls++; return { status: "unknown" }; },
  } });
  const tool = integrationTool(); assert.ok(tool);
  const run = () => tool.handler({ workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" },
    fixture.managerContext, fixture.f.platform);
  const result = await run() as any;
  assert.notEqual(result.data.status, "published");
  assert.equal(gitCalls, 0);
});

test("registered Manager integrates a publication-verified carried QA report with exact current task and effect guards", async () => {
  const f = await createCarriedTaskQaIndependentFixture();
  const verification = await f.verifyTool.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1" },
    f.context, f.f.platform) as any;
  assert.equal(verification.data.status, "published", JSON.stringify(verification.data));
  const eventId = verification.data.eventId as string;
  const baseline = (await createDesignBaselineStore(W, W, f.f.state as never).current())!.revision;
  const ui = (await createRevisionJournal(W, W, f.f.state as never, { prefix: "ui-contracts",
    parse: value => parseUiRevision(value, W), revisionId: value => value.revisionId }).current())!.revision;
  const planContent = { schemaVersion: 1 as const, workspaceId: W, baselineRevisionId: baseline.revisionId,
    baselineDigest: hash(baseline), uiRevisionId: ui.revisionId, uiDigest: hash(ui), sourceId: SOURCE,
    folderKey: "project-source", baseBranch: "main", baseCommit: "d".repeat(40), baseTree: "e".repeat(40),
    candidateBranch: "builder/integration-candidate", author: { agentId: MANAGER, sessionId: MANAGER_SESSION,
      runId: MANAGER_RUN, selectionRevision: 1 } };
  const plan = parseIntegrationPlan({ ...planContent, revisionId: `integration-plan-v1:${hash(planContent)}` });
  await createIntegrationPlanStore(W, f.f.state as never).publish({ expectedBaseRevisionId: null, revision: plan });
  const taskKey = integrationManagerSessionTaskKey(W, W, MANAGER);
  f.f.values.set(mapKey(integrationManagerStateKey(W)), { schemaVersion: 1, workspaceId: W, revision: 1, selectedAgentId: MANAGER } as never);
  f.f.values.set(mapKey(integrationManagerSessionStateKey(W, W, MANAGER)), { schemaVersion: 1, workspaceId: W,
    projectId: W, managerAgentId: MANAGER, sessionId: MANAGER_SESSION, taskKey } as never);
  const receipts = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const sessions = f.f.platform.agents.sessions as typeof f.f.platform.agents.sessions & Record<string, any>;
  sessions.list = async (agentId: string, companyId: string) => [{ observationVersion: 1, sessionId: MANAGER_SESSION,
    agentId, companyId, status: "active", taskKey, closedAt: null, createdAt: now, updatedAt: now,
    lastRunId: null, lastError: null, contextState: "valid", managedAgentOwnership: "owned" }];
  sessions.sendMessage = async (_sessionId: string, _companyId: string, input: any) => {
    receipts.set(input.requestId, { requestId: input.requestId, state: "submitted", runId: MANAGER_RUN });
    return { runId: MANAGER_RUN };
  };
  sessions.getRequest = async (_sessionId: string, _companyId: string, requestId: string) => receipts.get(requestId) ?? null;
  sessions.getRun = async (_sessionId: string, _companyId: string, runId: string) => ({ runId, status: "running",
    cancellationRequested: false, termination: "not_applicable", errorCode: null, error: null });
  Object.assign(f.f.platform.agents, { owned: { async get() { return { status: "resolved", revision: 1,
    agent: { agentId: MANAGER, role: "integration-manager", status: "idle" } }; } }, async list() { return [{ id: MANAGER, status: "idle", companyId: W }]; } });
  const dispatch = await consumeVerifiedWorkstreamJob({ jobKey: WORKSTREAM_VERIFIED_JOB, trigger: "event", eventId,
    companyId: W, runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, f.f.platform);
  assert.equal(dispatch.status, "accepted", JSON.stringify(dispatch));
  let gitCalls = 0, received: any;
  Object.assign(f.f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      if (branch === plan.baseBranch) return { status: "current", sourceId, folderKey, branch,
        commitSha: plan.baseCommit, treeSha: plan.baseTree, observedAt: now };
      return { status: "denied", reason: "branch_unavailable" };
    },
    async integrateWorkspaceSourceCommitV1(input: unknown) {
      gitCalls++; received = structuredClone(input);
      return { status: "observed", git: { status: "integrated", commitSha: "b".repeat(40), treeSha: "c".repeat(40), changedPaths: ["src/feature.ts"] } };
    },
  } });
  const tool = integrationTool(); assert.ok(tool);
  const result = await tool.handler({ workstreamId: "ws-1", eventId, taskId: "task-dev" },
    { companyId: W, projectId: W, agentId: MANAGER, sessionId: MANAGER_SESSION, runId: MANAGER_RUN }, f.f.platform) as any;
  assert.equal(result.data.status, "published", JSON.stringify(result.data));
  assert.equal(gitCalls, 1);
  assert.equal(received.incomingCommit, "d".repeat(40));
  assert.equal(received.incomingTree, "e".repeat(40));
  assert.equal(received.guards.some((guard: any) => guard.stateKey.startsWith("workstream-verification-head.v1.")
    && guard.expectedValue.revisionId === eventId), true);
  assert.equal(received.guards[received.incomingProof.guardIndex].stateKey.startsWith("task-qa-reports-revision.v1."), true);
});
