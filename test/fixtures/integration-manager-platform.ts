import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRevisionJournal, type RevisionState } from "../../src/solution-revision-store.ts";
import { createDesignBaselineStore } from "../../src/design-baseline-tools.ts";
import { parseUiRevision } from "../../src/ui-contracts/domain.ts";
import { createIntegrationPlanStore, parseIntegrationPlan } from "../../src/builder-gates/integration-plan.ts";
import { consumeVerifiedWorkstreamJob } from "../../src/builder-gates/integration-manager-job.ts";
import { WORKSTREAM_VERIFIED_JOB } from "../../src/builder-gates/workstream-verification-publication.ts";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey, integrationManagerStateKey } from "../../src/domain/integration-manager.ts";
import { createBuilderPlatform } from "../../src/platform.ts";
import { mapKey, W } from "./cto-platform.ts";
import { setupVerifiedWorkstreamPlatform } from "./verified-workstream-platform.ts";

export const MANAGER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const MANAGER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const MANAGER_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const SOURCE = "99999999-9999-4999-8999-999999999999";
export const BASE_COMMIT = "f".repeat(40), BASE_TREE = "a".repeat(40);
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const textHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const integrationTool = () => createBuilderPlatform().tools.find(item => item.name === "builder.integrate-verified-task");
export const validationTool = () => createBuilderPlatform().tools.find(item => item.name === "builder.request-integration-validation")!;
export const progressTool = () => createBuilderPlatform().tools.find(item => item.name === "builder.read-integration-progress")!;

/** Host/Core-facing receipts in the caller are deterministic DTO fixtures, not live AI or Git execution. */
export async function preparedFixture(withValidation = false) {
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
    candidateBranch: "builder/integration-candidate", ...(withValidation ? { validationPlans: {
      ci: { approvalTemplateId: "12121212-1212-4212-8212-121212121212", planSha256: "a".repeat(64) },
      e2e: { approvalTemplateId: "13131313-1313-4313-8313-131313131313", planSha256: "b".repeat(64) },
    } } : {}), author: { agentId: "22222222-2222-4222-8222-222222222222",
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
      "builder.read-verified-workstream", "builder.request-integration-validation"]);
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

export async function validationFixture() {
  const fixture = await preparedFixture(true);
  let integrated = false, enqueueCalls = 0, loseReply = false, candidateMoved = false;
  const runs = new Map<string, any>(), requests: any[] = [];
  const folders = { async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
    if (branch !== fixture.plan.baseBranch && !integrated) return { status: "denied", reason: "branch_unavailable" };
    return { status: "current", sourceId, folderKey, branch,
      commitSha: branch === fixture.plan.baseBranch ? BASE_COMMIT : candidateMoved ? "9".repeat(40) : "b".repeat(40),
      treeSha: branch === fixture.plan.baseBranch ? BASE_TREE : "c".repeat(40), observedAt: "fixture" };
  }, async integrateWorkspaceSourceCommitV1() {
    integrated = true;
    return { status: "observed", git: { status: "integrated", commitSha: "b".repeat(40), treeSha: "c".repeat(40), changedPaths: ["src/feature.ts"] } };
  } };
  const api = { delegatedBranchInputVersion: 1, async enqueueApprovedV1(input: any) {
    enqueueCalls++; requests.push(structuredClone(input));
    if (loseReply) { loseReply = false; throw new Error("fixture lost admission reply"); }
    const id = input.planSha256 === "a".repeat(64) ? "14141414-1414-4414-8414-141414141414" : "15151515-1515-4515-8515-151515151515";
    const run = { schemaVersion: 1, kind: "protected-node-test-v1", id, status: "queued", termination: "not_applicable",
      pins: { approvalId: "16161616-1616-4616-8616-161616161616", sourceId: input.sourceId, planSha256: input.planSha256,
        profileSha256: "1".repeat(64), commitSha: input.commitSha, treeSha: input.treeSha, manifestSha256: "2".repeat(64),
        inputTreeSha256: "3".repeat(64), nodeSha256: "4".repeat(64), subjectKeySha256: textHash(input.subjectKey), timeoutMs: 1000 },
      receipt: null, timestamps: { createdAt: "fixture", claimedAt: null, startedAt: null, finishedAt: null }, qaVerdict: "not-established" };
    runs.set(id, run); return run;
  }, async getRunV1(_workspaceId: string, runId: string) { return runs.get(runId) ?? null; } };
  Object.assign(fixture.f.platform, { localFolders: folders, protectedTests: api });
  const input = { workstreamId: "ws-1", eventId: fixture.eventId, taskId: "task-dev" };
  const result = await integrationTool()!.handler(input, fixture.managerContext, fixture.f.platform) as any;
  assert.equal(result.data.status, "published", JSON.stringify(result));
  return { ...fixture, input, runs, requests, get enqueueCalls() { return enqueueCalls; }, loseNextReply() { loseReply = true; },
    moveCandidate() { candidateMoved = true; } };
}
