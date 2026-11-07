import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fixture, A, C, W, ctx } from "./fixtures/cto-platform.ts";
import { createRevisionJournal } from "../src/solution-revision-store.ts";
import { parseUiRevision, type UiRevision } from "../src/ui-contracts/domain.ts";
import { createIntegrationPlanStore, parseIntegrationPlan, publishIntegrationPlan, checkIntegrationPrerequisites } from "../src/builder-gates/integration-plan.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { INTEGRATION_MANAGER_SESSION_EXECUTION_POLICY, CTO_SESSION_EXECUTION_POLICY, LEAD_PLANNING_TOOL_NAMES, SESSION_POLICY_TOOL_LIMIT } from "../src/session-execution-policy.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", baseCommit = "1".repeat(40), baseTree = "2".repeat(40);

async function setup() {
  const f = await fixture(W);
  const html = "<main>Integration fixture</main>", specId = f.baseline.specification.revisionId;
  const ui = parseUiRevision({ projectId: W, revisionId: "formal-ui-1", source: { kind: "baseline", revisionId: f.baseline.revisionId,
    digest: hash(f.baseline), specRevisionId: specId, selectionRevision: null, agentId: null }, previousRevisionId: null,
  sourceProposalRevisionId: "proposal-ui-1", approvalRevisionId: "ui-approval-1", publication: "formal",
  artifact: { artifactId: "ui-artifact-1", html, htmlSha256: createHash("sha256").update(html).digest("hex"), screenIds: ["home"],
    viewport: { width: 1280, height: 720 }, sourceSessionId: C, sourceSpecRevisionId: specId },
  contract: { projectId: W, revisionId: "ui-contract-1", screenIds: ["home"], interactions: [] }, reviewByInteractionId: {} }, W);
  const journal = createRevisionJournal<UiRevision>(W, W, f.state, { prefix: "ui-contracts",
    parse: value => parseUiRevision(value, W), revisionId: value => value.revisionId });
  await journal.publish({ expectedBaseRevisionId: null, revision: ui });
  let hostCalls = 0;
  const platform = { ...f.platform, localFolders: { async matchWorkspaceSourceV1(folderKey: string, selectedSourceId: string) {
    hostCalls++; return { folderKey, workspaceSourceId: selectedSourceId, match: "same_root" };
  }, async readWorkspaceSourceGitTipV1(selectedSourceId: string, folderKey: string, branch: string) {
    hostCalls++; return { status: "current", sourceId: selectedSourceId, folderKey, branch, commitSha: baseCommit, treeSha: baseTree,
      observedAt: "2026-11-07T00:00:00.000Z" };
  } } } as unknown as typeof f.platform;
  const input = { expectedBaseRevisionId: null, sourceId, folderKey: "project-source", baseBranch: "main", baseCommit,
    candidateBranch: "integration/candidate-one" };
  return { ...f, ui, platform, input, get hostCalls() { return hostCalls; } };
}

test("Main pins the current design/UI and exact authorized Source base without creating a run or a Git grant", async () => {
  // TEST_FIXTURE_ONLY: source proof and formal UI are persisted contract fixtures.
  const f = await setup();
  const result = await publishIntegrationPlan(f.input, { ...ctx(), projectId: W }, f.platform);
  assert.equal(result.status, "published");
  assert.equal(result.executionStarted, false);
  assert.equal(result.technicalAuthority, "separate-host-grants-required");
  const saved = await createIntegrationPlanStore(W, f.state).current();
  assert.equal(saved!.revision.baseCommit, baseCommit);
  assert.equal(saved!.revision.uiRevisionId, f.ui.revisionId);
  assert.equal(saved!.revision.author.agentId, A);
  assert.equal(f.sent.length, 0);
  const readiness = await checkIntegrationPrerequisites(W, "ws-1", f.platform);
  assert.equal(readiness.status, "ready", JSON.stringify(readiness));
  const replay = await publishIntegrationPlan(f.input, { ...ctx(), projectId: W }, f.platform);
  assert.equal(replay.status, "conflict");
});

test("CTO cannot publish integration scope and same base/candidate branch is rejected", async () => {
  const f = await setup();
  await assert.rejects(() => publishIntegrationPlan(f.input, { companyId: W, projectId: W, agentId: f.cto.agentId,
    sessionId: f.cto.sessionId, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, f.platform));
  await assert.rejects(() => publishIntegrationPlan({ ...f.input, candidateBranch: "main" }, ctx(), f.platform), /integration plan/iu);
  assert.equal(await createIntegrationPlanStore(W, f.state).current(), null);
});

test("integration plan digest binds all source/design pins and rejects fabricated completion or authority fields", async () => {
  const f = await setup();
  await publishIntegrationPlan(f.input, ctx(), f.platform);
  const plan = (await createIntegrationPlanStore(W, f.state).current())!.revision;
  assert.throws(() => parseIntegrationPlan({ ...plan, baseTree: "0".repeat(40) }), /digest/);
  assert.throws(() => parseIntegrationPlan({ ...plan, gitGranted: true }), /fields/);
  assert.throws(() => parseIntegrationPlan({ ...plan, integrationStatus: "INTEGRATED" }), /fields/);
});

test("registered integration roles cannot impersonate one another or final approval", () => {
  const tools = createBuilderPlatform().tools.map(tool => tool.name);
  for (const name of ["builder.publish-integration-plan", ...INTEGRATION_MANAGER_SESSION_EXECUTION_POLICY.toolNames]) assert.ok(tools.includes(name));
  assert.equal(LEAD_PLANNING_TOOL_NAMES.includes("builder.publish-integration-plan"), SESSION_POLICY_TOOL_LIMIT > 32);
  assert.ok(!CTO_SESSION_EXECUTION_POLICY.toolNames.includes("builder.publish-integration-plan"));
  assert.ok(INTEGRATION_MANAGER_SESSION_EXECUTION_POLICY.toolNames.every(name => !name.includes("approve") && !name.includes("publish-design")));
});

test("Main pins both validation templates without issuing technical approval or creating a run", async () => {
  const f = await setup();
  const plans = { ci: { approvalTemplateId: "11111111-1111-4111-8111-111111111111", planSha256: "a".repeat(64) },
    e2e: { approvalTemplateId: "22222222-2222-4222-8222-222222222222", planSha256: "b".repeat(64) } };
  const result = await publishIntegrationPlan({ ...f.input, validationPlans: plans }, ctx(), f.platform);
  assert.equal(result.status, "published");
  assert.equal(result.executionStarted, false);
  assert.equal(result.technicalAuthority, "separate-host-grants-required");
  const saved = (await createIntegrationPlanStore(W, f.state).current())!.revision;
  assert.deepEqual(saved.validationPlans, plans);
  assert.equal(saved.validationRequestScope, "candidate-v2");
  assert.ok(Object.isFrozen(saved.validationPlans!.ci));
  assert.equal(f.sent.length, 0);
  assert.throws(() => parseIntegrationPlan({ ...saved, validationPlans: { ...plans,
    ci: { ...plans.ci, planSha256: "c".repeat(64) } } }), /digest/);
  assert.throws(() => parseIntegrationPlan({ ...saved, validationPlans: { ...plans,
    e2e: { ...plans.e2e, approvalTemplateId: plans.ci.approvalTemplateId } } }), /digest/);
});

test("incomplete or caller-asserted validation authority never enters the Main plan", async () => {
  const f = await setup();
  const ci = { approvalTemplateId: "11111111-1111-4111-8111-111111111111", planSha256: "a".repeat(64) };
  for (const plans of [{ ci }, { ci, e2e: { ...ci, approved: true } }, { ci, e2e: { ...ci, command: "npm test" } },
    { ci, e2e: { ...ci, planSha256: "not-a-hash" } }, { ci, e2e: { ...ci, approvalTemplateId: "other-workspace" } },
    { ci, e2e: ci, regression: { ...ci, passed: true } }, null]) {
    await assert.rejects(() => publishIntegrationPlan({ ...f.input, validationPlans: plans }, ctx(), f.platform));
  }
  assert.equal(await createIntegrationPlanStore(W, f.state).current(), null);
  assert.equal(f.hostCalls, 0);
});

test("Main binds the optional regression plan to the immutable workflow revision", async () => {
  const f = await setup();
  const validationPlans = { ci: { approvalTemplateId: "11111111-1111-4111-8111-111111111111", planSha256: "a".repeat(64) },
    e2e: { approvalTemplateId: "22222222-2222-4222-8222-222222222222", planSha256: "b".repeat(64) },
    regression: { approvalTemplateId: "33333333-3333-4333-8333-333333333333", planSha256: "c".repeat(64) } };
  const result = await publishIntegrationPlan({ ...f.input, validationPlans }, ctx(), f.platform);
  assert.equal(result.status, "published");
  assert.equal(result.executionStarted, false);
  const saved = (await createIntegrationPlanStore(W, f.state).current())!.revision;
  assert.deepEqual(saved.validationPlans, validationPlans);
  assert.throws(() => parseIntegrationPlan({ ...saved, validationPlans: { ...validationPlans,
    regression: { ...validationPlans.regression, planSha256: "d".repeat(64) } } }), /digest/);
});

test("legacy integration plans retain their exact serialized identity without validation configuration", async () => {
  const f = await setup();
  await publishIntegrationPlan(f.input, ctx(), f.platform);
  const saved = (await createIntegrationPlanStore(W, f.state).current())!.revision;
  assert.equal(Object.hasOwn(saved, "validationPlans"), false);
  assert.equal(Object.hasOwn(saved, "validationRequestScope"), false);
  const { revisionId, ...content } = saved;
  assert.equal(revisionId, `integration-plan-v1:${hash(content)}`);
  assert.deepEqual(parseIntegrationPlan(saved), saved);
});

test("Main refuses branch names that cannot be used as Git refs", async () => {
  const f = await setup();
  for (const candidateBranch of [".hidden", "integration/", "integration/.hidden", "integration/a.lock", "integration/a..b"])
    await assert.rejects(() => publishIntegrationPlan({ ...f.input, candidateBranch }, ctx(), f.platform), /integration plan/iu);
  assert.equal(await createIntegrationPlanStore(W, f.state).current(), null);
});
