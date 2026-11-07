import assert from "node:assert/strict";
import test from "node:test";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { createIntegrationPlanStore, parseIntegrationPlan } from "../src/builder-gates/integration-plan.ts";
import { createIntegrationAttemptStore } from "../src/builder-gates/integration-progress.ts";
import { parseTaskQaReport } from "../src/task-qa-reports.ts";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey, integrationManagerStateKey } from "../src/domain/integration-manager.ts";
import { mapKey, W } from "./fixtures/cto-platform.ts";
import { BASE_COMMIT, BASE_TREE, MANAGER_RUN, SOURCE, hash, integrationTool, preparedFixture,
  progressTool, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

test("verified event dispatches one restricted Manager request and stores admission, not integration completion", async () => {
  const fixture = await preparedFixture();
  assert.equal(fixture.job.status, "accepted", JSON.stringify(fixture.job));
  assert.equal(fixture.sends, 1);
  assert.ok(fixture.job.receipt?.runId === MANAGER_RUN);
  assert.equal(fixture.job.reason, "manager-acceptance-receipt-confirmed-not-completion");
});

test("registered Manager CI request pins the observed candidate and preserves Core child approval separately from the Host template", async () => {
  const f = await validationFixture();
  const result = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
  assert.equal(result.data.status, "published", JSON.stringify(result));
  assert.equal(result.data.technicalValidation, "pending");
  assert.equal(result.data.qaVerdict, "not-established");
  assert.equal(f.enqueueCalls, 1);
  assert.equal(f.requests[0].branch, f.plan.candidateBranch);
  assert.equal(f.requests[0].commitSha, "b".repeat(40));
  assert.equal(f.requests[0].treeSha, "c".repeat(40));
  assert.equal(f.requests[0].approvalId, f.plan.validationPlans!.ci.approvalTemplateId);
  assert.notEqual(result.data.reference.approvalId, f.requests[0].approvalId);
  const replay = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
  assert.equal(replay.data.status, "existing");
  assert.equal(f.enqueueCalls, 1);
  const progress = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  assert.equal(progress.data.technicalValidation[0].status, "pending");
  assert.equal(progress.data.integrationStatus, "INTEGRATING");
  assert.equal(f.enqueueCalls, 1, "read must not enqueue");
});

test("unknown validation admission reconciles the same persisted request without changing pins", async () => {
  const f = await validationFixture(); f.loseNextReply();
  const first = await validationTool().handler({ ...f.input, phase: "e2e" }, f.managerContext, f.f.platform) as any;
  assert.equal(first.data.status, "unknown");
  const retried = await validationTool().handler({ ...f.input, phase: "e2e" }, f.managerContext, f.f.platform) as any;
  assert.equal(retried.data.status, "published", JSON.stringify(retried));
  assert.deepEqual(f.requests[0], f.requests[1]);
  assert.equal(f.enqueueCalls, 2);
});

test("an older protected-test client returns unsupported before reservation or enqueue", async () => {
  const f = await validationFixture();
  delete (f.f.platform as any).protectedTests.delegatedBranchInputVersion;
  const result = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
  assert.equal(result.data.status, "unsupported");
  assert.equal(result.data.executionStarted, false);
  assert.equal(f.enqueueCalls, 0);
  const view = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  assert.equal(view.data.attempts[0].validationRuns, undefined);
});

test("current candidate drift blocks new CI and incomplete protected receipts never become a pass", async () => {
  const f = await validationFixture();
  await assert.rejects(async () => validationTool().handler({ ...f.input, phase: "ci", passed: true }, f.managerContext, f.f.platform));
  const queued = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
  const run = f.runs.get(queued.data.reference.runId);
  run.status = "succeeded"; run.termination = "confirmed";
  const incomplete = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  assert.equal(incomplete.data.technicalValidation[0].status, "unknown");
  run.receipt = { digest: "a".repeat(64), status: "completed", stdoutSha256: "b".repeat(64), stderrSha256: null,
    stdoutBytes: 1, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false,
    appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true,
    profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
  const complete = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  assert.equal(complete.data.technicalValidation[0].status, "passed");
  assert.equal(complete.data.technicalValidation[0].qaVerdict, "not-established");
  assert.equal(complete.data.integrationStatus, "INTEGRATING");
  f.moveCandidate();
  const drifted = await validationTool().handler({ ...f.input, phase: "e2e" }, f.managerContext, f.f.platform) as any;
  assert.equal(drifted.data.status, "stale");
  const historical = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  assert.equal(historical.data.technicalValidation[0].status, "stale");
  assert.equal(f.enqueueCalls, 1);
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

test("a confirmed competing candidate update retries once with the same verified incoming objects", async () => {
  const fixture = await preparedFixture();
  const inputs: Array<Record<string, unknown>> = [];
  const competingHead = "9".repeat(40);
  Object.assign(fixture.f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      if (branch === fixture.plan.baseBranch) return { status: "current", sourceId, folderKey, branch,
        commitSha: BASE_COMMIT, treeSha: BASE_TREE, observedAt: "fixture" };
      return inputs.length === 0 ? { status: "denied", reason: "branch_unavailable" }
        : { status: "current", sourceId, folderKey, branch, commitSha: competingHead, treeSha: "8".repeat(40), observedAt: "fixture" };
    },
    async integrateWorkspaceSourceCommitV1(input: Record<string, unknown>) {
      inputs.push(structuredClone(input));
      return { status: "observed", git: inputs.length === 1 ? { status: "conflict", reason: "head_changed", actualHead: competingHead }
        : { status: "integrated", commitSha: "b".repeat(40), treeSha: "c".repeat(40), changedPaths: ["src/feature.ts"] } };
    },
  } });
  const tool = integrationTool()!;
  const input = { workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" };
  const result = await tool.handler(input, fixture.managerContext, fixture.f.platform) as any;
  assert.equal(result.data.status, "published");
  assert.equal(result.data.attempt.git.status, "integrated");
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.expectedHead, BASE_COMMIT);
  assert.equal(inputs[0]?.initializeIfMissing, true);
  assert.equal(inputs[1]?.expectedHead, competingHead);
  assert.equal(Object.hasOwn(inputs[1]!, "initializeIfMissing"), false);
  assert.equal(inputs[1]?.incomingCommit, inputs[0]?.incomingCommit);
  assert.equal(inputs[1]?.incomingTree, inputs[0]?.incomingTree);
  assert.notDeepEqual(inputs[1]?.reservation, inputs[0]?.reservation);
  const history = await createIntegrationAttemptStore({ workspaceId: W, ...input }, fixture.f.platform.state).recent(4);
  assert.deepEqual(history.revisions.map(row => [row.sequence, row.revision.git?.status ?? "reserved"]),
    [[4, "integrated"], [3, "reserved"], [2, "conflict"], [1, "reserved"]]);
  assert.equal((await tool.handler(input, fixture.managerContext, fixture.f.platform) as any).data.status, "existing");
  assert.equal(inputs.length, 2);
});

test("real merge conflicts and a second competing update stay held without repeated Git effects", async t => {
  for (const reason of ["merge_conflict", "head_changed"] as const) await t.test(reason, async () => {
    const fixture = await preparedFixture();
    let calls = 0;
    Object.assign(fixture.f.platform, { localFolders: {
      async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
        return { status: "current", sourceId, folderKey, branch, observedAt: "fixture",
          commitSha: branch === fixture.plan.baseBranch || calls === 0 ? BASE_COMMIT : "9".repeat(40),
          treeSha: BASE_TREE };
      },
      async integrateWorkspaceSourceCommitV1() {
        calls++;
        return { status: "observed", git: { status: "conflict", reason, actualHead: (calls === 1 ? "9" : "8").repeat(40) } };
      },
    } });
    const tool = integrationTool()!;
    const input = { workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" };
    assert.equal((await tool.handler(input, fixture.managerContext, fixture.f.platform) as any).data.integrationStatus, "INTEGRATION_HOLD");
    assert.equal((await tool.handler(input, fixture.managerContext, fixture.f.platform) as any).data.status, "existing");
    assert.equal(calls, reason === "head_changed" ? 2 : 1);
  });
});

test("the retry does not follow an unconfirmed newer candidate head", async () => {
  const fixture = await preparedFixture();
  let calls = 0;
  Object.assign(fixture.f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      return { status: "current", sourceId, folderKey, branch, observedAt: "fixture",
        commitSha: branch === fixture.plan.baseBranch || calls === 0 ? BASE_COMMIT : "8".repeat(40), treeSha: BASE_TREE };
    },
    async integrateWorkspaceSourceCommitV1() {
      calls++;
      return { status: "observed", git: { status: "conflict", reason: "head_changed", actualHead: "9".repeat(40) } };
    },
  } });
  const input = { workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" };
  const result = await integrationTool()!.handler(input, fixture.managerContext, fixture.f.platform);
  assert.deepEqual(result.data, { status: "stale", reason: "integration-candidate-changed-after-confirmed-head-race" });
  assert.equal(calls, 1);
  const head = await createIntegrationAttemptStore({ workspaceId: W, ...input }, fixture.f.platform.state).current();
  assert.equal(head?.sequence, 2);
  assert.deepEqual(head?.revision.git, { status: "conflict", reason: "head_changed", actualHead: "9".repeat(40) });
});
