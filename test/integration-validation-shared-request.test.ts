import assert from "node:assert/strict";
import test from "node:test";
import { integrationValidationReservation } from "../src/builder-gates/integration-validation.ts";
import { parseIntegrationPlan } from "../src/builder-gates/integration-plan.ts";
import { createIntegrationAttemptStore } from "../src/builder-gates/integration-progress.ts";
import { selectLogicalValidationRun } from "../src/delivery-evidence/integration-candidate.ts";
import { W } from "./fixtures/cto-platform.ts";
import { hash, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

test("new plan derives one Host request for the same candidate and phase across distinct Workstreams", async () => {
  const f = await validationFixture(true, false, true);
  const plan = f.plan;
  assert.equal(plan.validationRequestScope, "candidate-v2");
  const { revisionId: _old, validationRequestScope: _scope, ...legacy } = plan;
  const oldPlan = parseIntegrationPlan({ ...legacy, revisionId: `integration-plan-v1:${hash(legacy)}` });
  const first = { workspaceId: W, ...f.input };
  const second = { workspaceId: W, workstreamId: "ws-2", taskId: "task-2", eventId: "verified-2" };
  const commit = "b".repeat(40), tree = "c".repeat(40);
  const request = integrationValidationReservation(plan, first, "ci", commit, tree);
  assert.deepEqual(request, integrationValidationReservation(plan, second, "ci", commit, tree));
  assert.match(request.subjectKey, /^builder-integration-ci-v1:[a-f0-9]{64}$/u);
  assert.notEqual(request.requestId, integrationValidationReservation(plan, second, "e2e", commit, tree).requestId);
  assert.notEqual(request.requestId, integrationValidationReservation(plan, second, "regression", commit, tree).requestId);
  assert.notEqual(request.requestId, integrationValidationReservation(plan, second, "ci", "9".repeat(40), tree).requestId);
  assert.throws(() => integrationValidationReservation(plan, { ...second, workspaceId: f.plan.sourceId }, "ci", commit, tree));
  const prior = integrationValidationReservation(oldPlan, first, "ci", commit, tree);
  assert.equal(prior.requestId, `builder-integration-ci-v1:${hash(["builder-integration-validation-v1", first,
    oldPlan.revisionId, "ci", oldPlan.sourceId, oldPlan.candidateBranch, commit, tree, oldPlan.validationPlans!.ci])}`);
  assert.notEqual(prior.requestId, integrationValidationReservation(oldPlan, second, "ci", commit, tree).requestId);
  const input = { ...f.input, phase: "ci" };
  const result = await validationTool().handler(input, f.managerContext, f.f.platform);
  assert.equal((result.data as { admission: string }).admission, "confirmed");
  assert.equal((result.data as { executionStarted: unknown }).executionStarted, null);
  assert.equal(f.requests[0].requestId, request.requestId);
  assert.equal(f.requests[0].subjectKey, request.subjectKey);
  const replay = await validationTool().handler(input, f.managerContext, f.f.platform);
  assert.equal((replay.data as { status: string }).status, "existing");
  assert.equal(f.enqueueCalls, 1);
});

test("one Core receipt may satisfy both local references, while competing Core receipts are ambiguous", async () => {
  const f = await validationFixture();
  const scope = { workspaceId: W, ...f.input };
  const { revision: attempt } = (await createIntegrationAttemptStore(scope, f.f.platform.state).current())!;
  const other = { ...attempt, scope: { ...scope, workstreamId: "ws-2", taskId: "task-2", eventId: "verified-2" } };
  const reservation = integrationValidationReservation(f.plan, scope, "ci", "b".repeat(40), "c".repeat(40));
  const reference = { ...reservation, runId: "14141414-1414-4414-8414-141414141414", approvalId: "16161616-1616-4616-8616-161616161616" };
  assert.deepEqual(selectLogicalValidationRun([{ attempt, reference: reservation }, { attempt: other, reference }]),
    { status: "selected", attempt: other, reference });
  assert.equal(selectLogicalValidationRun([{ attempt, reference }, { attempt: other, reference }]).status, "selected");
  assert.deepEqual(selectLogicalValidationRun([{ attempt, reference },
    { attempt: other, reference: { ...reference, runId: "15151515-1515-4515-8515-151515151515" } }]), { status: "ambiguous" });
  assert.deepEqual(selectLogicalValidationRun([{ attempt, reference },
    { attempt: other, reference: integrationValidationReservation(f.plan, other.scope, "ci", "b".repeat(40), "c".repeat(40)) }]), { status: "ambiguous" });
});

test("a candidate moved after the reservation is not enqueued under the old Commit/Tree", async () => {
  const f = await validationFixture(false, false, true);
  f.f.setAfterCas(async key => {
    if (key.stateKey.startsWith("integration-attempts-head.v1.")) f.moveCandidate();
  });
  const result = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform);
  assert.deepEqual(result.data, { status: "stale", reason: "integration-candidate-tip-changed", executionStarted: false });
  assert.equal(f.enqueueCalls, 0);
  const scope = { workspaceId: W, ...f.input };
  const { revision } = (await createIntegrationAttemptStore(scope, f.f.platform.state).current())!;
  assert.equal(revision.validationRuns?.ci?.commitSha, "b".repeat(40));
  assert.equal(revision.validationRuns?.ci?.runId, null);
});
