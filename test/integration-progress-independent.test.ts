import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createRevisionJournal, type RevisionState } from "../src/solution-revision-store.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { parseUiRevision } from "../src/ui-contracts/domain.ts";
import { createIntegrationPlanStore, parseIntegrationPlan } from "../src/builder-gates/integration-plan.ts";
import { consumeVerifiedWorkstreamJob } from "../src/builder-gates/integration-manager-job.ts";
import { parseTaskQaReport } from "../src/task-qa-reports.ts";
import { WORKSTREAM_VERIFIED_JOB } from "../src/builder-gates/workstream-verification-publication.ts";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey, integrationManagerStateKey } from "../src/domain/integration-manager.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { mapKey, W } from "./fixtures/cto-platform.ts";
import { setupVerifiedWorkstreamPlatform } from "./fixtures/verified-workstream-platform.ts";

const MANAGER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MANAGER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANAGER_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE = "99999999-9999-4999-8999-999999999999";
const BASE_COMMIT = "f".repeat(40), BASE_TREE = "a".repeat(40);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const textHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const integrationTool = () => createBuilderPlatform().tools.find(item => item.name === "builder.integrate-verified-task");

/** Host/Core-facing receipts in this file are deterministic DTO fixtures, not live AI or Git execution. */
async function preparedFixture() {
  const setup = await setupVerifiedWorkstreamPlatform();
  const f = setup.f;
  const verification = await setup.verify();
  assert.equal(verification.data.status, "published");
  const eventId = verification.data.eventId as string;
  const state = f.state as unknown as RevisionState;
  const baseline = (await createDesignBaselineStore(W, W, state).current())!.revision;

  const html = "<main>fixture UI evidence</main>";
  const ui = parseUiRevision({ projectId: W, revisionId: "fixture-formal-ui-r1",
    source: { kind: "baseline", revisionId: baseline.revisionId, digest: hash(baseline),
      specRevisionId: baseline.specification.revisionId, selectionRevision: null, agentId: null },
    previousRevisionId: null, sourceProposalRevisionId: "fixture-approved-proposal",
    approvalRevisionId: "fixture-user-approval", artifact: { artifactId: "fixture-html", html,
      htmlSha256: textHash(html), screenIds: ["main"], viewport: { width: 1280, height: 800 },
      sourceSessionId: "22222222-2222-4222-8222-222222222222", sourceSpecRevisionId: baseline.specification.revisionId },
    contract: { projectId: W, revisionId: "fixture-contract-r1", screenIds: ["main"], interactions: [] },
    publication: "formal", reviewByInteractionId: {} }, W);
  const uiJournal = createRevisionJournal(W, W, state, { prefix: "ui-contracts",
    parse: value => parseUiRevision(value, W), revisionId: value => value.revisionId });
  await uiJournal.publish({ expectedBaseRevisionId: null, revision: ui });

  const planContent = { schemaVersion: 1 as const, workspaceId: W, baselineRevisionId: baseline.revisionId,
    baselineDigest: hash(baseline), uiRevisionId: ui.revisionId, uiDigest: hash(ui), sourceId: SOURCE,
    folderKey: "project-source", baseBranch: "main", baseCommit: BASE_COMMIT, baseTree: BASE_TREE,
    candidateBranch: "builder/integration-candidate", author: { agentId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333", runId: "55555555-5555-4555-8555-555555555555", selectionRevision: 1 } };
  const plan = parseIntegrationPlan({ ...planContent, revisionId: `integration-plan-v1:${hash(planContent)}` });
  await createIntegrationPlanStore(W, state).publish({ expectedBaseRevisionId: null, revision: plan });

  const taskKey = integrationManagerSessionTaskKey(W, W, MANAGER);
  f.values.set(mapKey(integrationManagerStateKey(W)), { schemaVersion: 1, workspaceId: W, revision: 1, selectedAgentId: MANAGER } as never);
  f.values.set(mapKey(integrationManagerSessionStateKey(W, W, MANAGER)), { schemaVersion: 1, workspaceId: W,
    projectId: W, managerAgentId: MANAGER, sessionId: MANAGER_SESSION, taskKey } as never);
  const sessions = f.platform.agents.sessions as typeof f.platform.agents.sessions & Record<string, any>;
  const receipts = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  let sends = 0;
  sessions.list = async (agentId: string, companyId: string) => [{ observationVersion: 1, sessionId: MANAGER_SESSION,
    agentId, companyId, status: "active", taskKey, closedAt: null, contextState: "valid", managedAgentOwnership: "owned" }];
  sessions.sendMessage = async (sessionId: string, companyId: string, input: any) => {
    assert.equal(sessionId, MANAGER_SESSION); assert.equal(companyId, W);
    assert.deepEqual([...input.executionPolicy.toolNames], ["builder.integrate-verified-task", "builder.read-integration-progress",
      "builder.read-verified-workstream"]);
    const old = [...receipts.values()].find(item => item.requestId === input.requestId);
    if (old) return { runId: old.runId };
    sends++;
    receipts.set(`${sessionId}:${input.requestId}`, { requestId: input.requestId, state: "submitted", runId: MANAGER_RUN });
    return { runId: MANAGER_RUN };
  };
  sessions.getRequest = async (sessionId: string, companyId: string, requestId: string) => {
    assert.equal(sessionId, MANAGER_SESSION); assert.equal(companyId, W);
    return [...receipts.values()].find(item => item.requestId === requestId) ?? null;
  };
  sessions.getRun = async (_sessionId: string, _companyId: string, runId: string) => ({ runId,
    status: "running", cancellationRequested: false, termination: "not_applicable", errorCode: null, error: null });
  Object.assign(f.platform.agents, { owned: { async get() { return { status: "resolved", revision: 1,
    agent: { agentId: MANAGER, role: "integration-manager", status: "idle" } }; } },
  async list() { return [{ id: MANAGER, companyId: W, status: "idle" }]; } });
  Object.assign(f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      return { status: "current", sourceId, folderKey, branch, commitSha: BASE_COMMIT, treeSha: BASE_TREE, observedAt: "fixture" };
    },
    async integrateWorkspaceSourceCommitV1() { return { status: "unknown", reason: "not-used-in-dispatch-test" }; },
  } });

  const job = await consumeVerifiedWorkstreamJob({ jobKey: WORKSTREAM_VERIFIED_JOB, trigger: "event", eventId,
    companyId: W, runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, f.platform);
  return { f, eventId, plan, job, reportStore: setup.reportStore, get sends() { return sends; }, managerContext: { companyId: W, projectId: W,
    agentId: MANAGER, sessionId: MANAGER_SESSION, runId: MANAGER_RUN } };
}

test("verified event dispatches one restricted Manager request and stores admission, not integration completion", async () => {
  const fixture = await preparedFixture();
  assert.equal(fixture.job.status, "accepted", JSON.stringify(fixture.job));
  assert.equal(fixture.sends, 1);
  assert.ok(fixture.job.receipt?.runId === MANAGER_RUN);
  assert.equal(fixture.job.reason, "manager-acceptance-receipt-confirmed-not-completion");
});

test("registered integration tool sends exact current report pins through guarded Core Git DTO and never claims CI", async () => {
  const fixture = await preparedFixture();
  assert.equal(fixture.job.status, "accepted");
  let gitCalls = 0, received: any;
  Object.assign(fixture.f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      if (branch === fixture.plan.baseBranch) return { status: "current", sourceId, folderKey, branch,
        commitSha: BASE_COMMIT, treeSha: BASE_TREE, observedAt: "fixture" };
      return { status: "denied", reason: "branch_unavailable" };
    },
    async integrateWorkspaceSourceCommitV1(input: unknown) {
      gitCalls++; received = structuredClone(input);
      return { status: "observed", git: { status: "integrated", commitSha: "b".repeat(40), treeSha: "c".repeat(40),
        changedPaths: ["src/feature.ts"] } };
    },
  } });
  const tool = integrationTool();
  assert.ok(tool);
  const result = await tool.handler({ workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" },
    fixture.managerContext, fixture.f.platform) as any;
  assert.equal(result.data.status, "published", JSON.stringify(result.data));
  assert.equal(result.data.integrationStatus, "INTEGRATING");
  assert.equal(result.data.attempt.validation, "not-executed");
  assert.equal(gitCalls, 1);
  assert.deepEqual({ sourceId: received.sourceId, folderKey: received.folderKey, branch: received.branch,
    expectedHead: received.expectedHead, incomingCommit: received.incomingCommit, incomingTree: received.incomingTree,
    initializeIfMissing: received.initializeIfMissing }, { sourceId: SOURCE, folderKey: "project-source", branch: fixture.plan.candidateBranch,
    expectedHead: BASE_COMMIT, incomingCommit: "d".repeat(40), incomingTree: "e".repeat(40), initializeIfMissing: true });
  assert.equal(received.incomingProof.sourceIdPath.join("."), "revision.reference.binding.sourceId");
  assert.equal(received.incomingProof.commitShaPath.join("."), "revision.reference.binding.commitSha");
  const replay = await tool.handler({ workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" },
    fixture.managerContext, fixture.f.platform) as any;
  assert.equal(replay.data.status, "existing");
  assert.equal(replay.data.integrationStatus, "INTEGRATING");
  assert.equal(gitCalls, 1, "observed result replay must not perform another Git effect");
});

test("uncertain Core Git reply retries the exact same reservation input and recorded results are not repeated", async () => {
  const fixture = await preparedFixture();
  let calls = 0, firstInput: unknown;
  Object.assign(fixture.f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      if (branch === fixture.plan.baseBranch) return { status: "current", sourceId, folderKey, branch,
        commitSha: BASE_COMMIT, treeSha: BASE_TREE, observedAt: "fixture" };
      return { status: "denied", reason: "branch_unavailable" };
    },
    async integrateWorkspaceSourceCommitV1(input: unknown) {
      calls++;
      if (calls === 1) { firstInput = structuredClone(input); throw new Error("fixture response lost after unknown Host boundary"); }
      assert.deepEqual(input, firstInput, "reconciliation must reuse exact reservation, guards and incoming proof");
      return { status: "observed", git: { status: "replayed", commitSha: "b".repeat(40), treeSha: "c".repeat(40),
        changedPaths: ["src/feature.ts"] } };
    },
  } });
  const tool = integrationTool(); assert.ok(tool);
  const input = { workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" };
  const first = await tool.handler(input, fixture.managerContext, fixture.f.platform) as any;
  assert.equal(first.data.status, "uncertain");
  const retry = await tool.handler(input, fixture.managerContext, fixture.f.platform) as any;
  assert.equal(retry.data.status, "published", JSON.stringify(retry.data));
  assert.equal(retry.data.integrationStatus, "INTEGRATING");
  assert.equal(retry.data.attempt.validation, "not-executed");
  assert.equal(calls, 2);
  const repeated = await tool.handler(input, fixture.managerContext, fixture.f.platform) as any;
  assert.equal(repeated.data.status, "existing");
  assert.equal(calls, 2);
});

test("changed Manager binding denies the registered integration effect", async () => {
  const fixture = await preparedFixture();
  let gitCalls = 0;
  Object.assign(fixture.f.platform, { localFolders: { async integrateWorkspaceSourceCommitV1() { gitCalls++; } } });
  fixture.f.values.set(mapKey(integrationManagerStateKey(W)), { schemaVersion: 1, workspaceId: W, revision: 2,
    selectedAgentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } as never);
  const tool = integrationTool(); assert.ok(tool);
  await assert.rejects(async () => tool.handler({ workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" },
    fixture.managerContext, fixture.f.platform));
  assert.equal(gitCalls, 0);
});

test("base branch drift before reservation does not call the Core Git effect", async () => {
  const fixture = await preparedFixture();
  let gitCalls = 0;
  Object.assign(fixture.f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      return { status: "current", sourceId, folderKey, branch, commitSha: "9".repeat(40), treeSha: "8".repeat(40), observedAt: "fixture" };
    },
    async integrateWorkspaceSourceCommitV1() { gitCalls++; return { status: "unknown" }; },
  } });
  const tool = integrationTool(); assert.ok(tool);
  const result = await tool.handler({ workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" },
    fixture.managerContext, fixture.f.platform) as any;
  assert.equal(result.data.status, "stale");
  assert.equal(gitCalls, 0);
});

test("newer QA report head invalidates the admitted verification before Git", async () => {
  const fixture = await preparedFixture();
  const current = (await fixture.reportStore().current())!.revision;
  const content = { schemaVersion: 1 as const, reference: current.reference, coreReceiptDigest: current.coreReceiptDigest,
    coreStatus: current.coreStatus, author: current.author, checks: current.checks,
    summary: "Changed report head fixture.", verdict: current.verdict };
  const changed = parseTaskQaReport({ ...content, revisionId: `task-qa-report-v1:${hash(content)}` });
  await fixture.reportStore().publish({ expectedBaseRevisionId: current.revisionId, revision: changed });
  let gitCalls = 0;
  Object.assign(fixture.f.platform, { localFolders: { async integrateWorkspaceSourceCommitV1() { gitCalls++; } } });
  const tool = integrationTool(); assert.ok(tool);
  await assert.rejects(async () => tool.handler({ workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" },
    fixture.managerContext, fixture.f.platform));
  assert.equal(gitCalls, 0);
});

test("plan drift after uncertain reservation is stale and never creates a replacement attempt", async () => {
  const fixture = await preparedFixture();
  let gitCalls = 0;
  Object.assign(fixture.f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      if (branch === fixture.plan.baseBranch) return { status: "current", sourceId, folderKey, branch,
        commitSha: BASE_COMMIT, treeSha: BASE_TREE, observedAt: "fixture" };
      return { status: "denied", reason: "branch_unavailable" };
    },
    async integrateWorkspaceSourceCommitV1() { gitCalls++; throw new Error("fixture lost response"); },
  } });
  const tool = integrationTool(); assert.ok(tool);
  const input = { workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" };
  const first = await tool.handler(input, fixture.managerContext, fixture.f.platform) as any;
  assert.equal(first.data.status, "uncertain");
  const { revisionId: _oldRevisionId, ...oldContent } = fixture.plan;
  const changedContent = { ...oldContent, candidateBranch: "builder/changed-candidate" };
  const changedPlan = parseIntegrationPlan({ ...changedContent, revisionId: `integration-plan-v1:${hash(changedContent)}` });
  await createIntegrationPlanStore(W, fixture.f.state as unknown as RevisionState).publish({
    expectedBaseRevisionId: fixture.plan.revisionId, revision: changedPlan });
  const retry = await tool.handler(input, fixture.managerContext, fixture.f.platform) as any;
  assert.equal(retry.data.status, "stale");
  assert.equal(gitCalls, 1);
});

