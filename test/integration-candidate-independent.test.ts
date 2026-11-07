import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readIntegrationCandidate } from "../src/delivery-evidence/integration-candidate.ts";
import { createIntegrationPlanStore, parseIntegrationPlan, readCurrentIntegrationPlan } from "../src/builder-gates/integration-plan.ts";
import { createIntegrationAttemptStore, withIntegrationValidationReferences } from "../src/builder-gates/integration-progress.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { readWorkstreams, createWorkstreamStore } from "../src/workstream-tools.ts";
import { CTO, W } from "./fixtures/cto-platform.ts";
import { validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

async function setup() {
  const f = await validationFixture();
  const folders = (f.f.platform as any).localFolders as { readWorkspaceSourceGitTipV1(...args: string[]): Promise<Record<string, unknown>> };
  const originalTip = folders.readWorkspaceSourceGitTipV1.bind(folders);
  folders.readWorkspaceSourceGitTipV1 = async (...args) => {
    const tip = await originalTip(...args);
    return tip.status === "current" ? { ...tip, observedAt: "2026-11-07T12:00:00.000Z" } : tip;
  };
  const complete = async (phase: "ci" | "e2e", outcome: "passed" | "failed" | "cancelled" = "passed") => {
    const result = await validationTool().handler({ ...f.input, phase }, f.managerContext, f.f.platform);
    const reference = (result.data as { reference: { runId: string } }).reference;
    const run = f.runs.get(reference.runId)!;
    run.status = outcome === "passed" ? "succeeded" : outcome;
    run.termination = "confirmed";
    run.receipt = { digest: "a".repeat(64), status: "completed", stdoutSha256: null, stderrSha256: null,
      stdoutBytes: 0, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: outcome === "cancelled",
      outputLimit: false, appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true,
      jobEmpty: true, profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
    return reference.runId;
  };
  const store = () => createIntegrationAttemptStore({ workspaceId: W, workstreamId: f.input.workstreamId,
    eventId: f.eventId, taskId: f.input.taskId }, f.f.state as never);
  return { f, folders, complete, store, read: () => readIntegrationCandidate(W, f.f.platform) };
}

test("candidate requires the exact current CI/E2E template, candidate commit/tree and plan digests", async () => {
  const { complete, store, read } = await setup();
  await complete("ci");
  await complete("e2e");
  const current = (await store().current())!.revision;
  const ci = current.validationRuns!.ci!;
  const altered = withIntegrationValidationReferences(current, { ...current.validationRuns!,
    ci: Object.freeze({ ...ci, approvalTemplateId: "18181818-1818-4818-8818-181818181818" }) });
  const saved = await store().publish({ expectedBaseRevisionId: current.revisionId, revision: altered });
  assert.equal(saved.status, "published");
  assert.deepEqual(await read(), { status: "pending", reason: "integration-ci-run-not-unique-or-unavailable" });
});

test("a Core run with a different immutable commit pin cannot satisfy current CI", async () => {
  const { f, complete, read } = await setup();
  const ciRunId = await complete("ci");
  await complete("e2e");
  const run = f.runs.get(ciRunId)!;
  run.pins.commitSha = "9".repeat(40);
  assert.deepEqual(await read(), { status: "unknown", reason: "integration-ci-not-passed" });
});

test("cancelled or incomplete technical completion never satisfies a required E2E phase", async () => {
  const { complete, read } = await setup();
  await complete("ci");
  await complete("e2e", "cancelled");
  assert.deepEqual(await read(), { status: "failed", reason: "integration-e2e-not-passed" });
});

test("publishing another Workstream invalidates the old verification guard instead of omitting it", async () => {
  const { f, read } = await setup();
  const boardStore = createWorkstreamStore(W, W, f.f.state as never);
  const board = (await readWorkstreams(W, W, f.f.platform))!.revision;
  const original = board.workstreams[0]!;
  const second = { ...original, spec: { ...original.spec, id: "ws-second", revision: 1, dependencies: [] } };
  const published = await boardStore.publish({ expectedBaseRevisionId: board.revisionId,
    revision: { projectId: W, revisionId: "candidate-independent-two-workstreams", workstreams: [...board.workstreams, second] } });
  assert.equal(published.status, "published");
  assert.deepEqual(await read(), { status: "stale", reason: "workstream-verification-changed" });
});

test("publishing another development Task invalidates the prior snapshot before the aggregate can pass", async () => {
  const { f, read } = await setup();
  const taskStore = createTaskPacketStore(W, W, CTO, f.input.workstreamId, f.f.state as never);
  const current = (await taskStore.current())!.revision;
  const dev = current.packets.find(row => row.packet.kind === "development")!;
  const secondDev = { ...structuredClone(dev), packet: { ...dev.packet, taskId: "task-dev-2", title: "task-dev-2" } };
  const next = await taskStore.publish({ expectedBaseRevisionId: current.revisionId,
    revision: { projectId: W, ctoId: CTO, workstreamId: f.input.workstreamId,
      revisionId: "candidate-independent-two-task-inventory", packets: [...current.packets, secondDev] } });
  assert.equal(next.status, "published");
  assert.notEqual(taskPacketRecordDigest(secondDev as never, W, CTO, f.input.workstreamId), taskPacketRecordDigest(dev as never, W, CTO, f.input.workstreamId));
  assert.deepEqual(await read(), { status: "stale", reason: "workstream-verification-changed" });
});

test("plan revision changed while Core validation is read makes the final candidate stale", async () => {
  const { f, complete, read } = await setup();
  await complete("ci");
  await complete("e2e");
  const api = (f.f.platform as any).protectedTests as { getRunV1(workspace: string, runId: string, subjectHash: string): Promise<unknown> };
  const originalGet = api.getRunV1.bind(api);
  let changed = false;
  api.getRunV1 = async (...args) => {
    if (!changed) {
      changed = true;
      const current = (await readCurrentIntegrationPlan(W, f.f.platform))!.revision;
      const { revisionId: _old, ...body } = current;
      const nextBody = { ...body, validationPlans: { ...body.validationPlans!, ci: {
        ...body.validationPlans!.ci, planSha256: "e".repeat(64),
      } } };
      const revision = parseIntegrationPlan({ ...nextBody,
        revisionId: "integration-plan-v1:" + digest(nextBody) });
      const saved = await createIntegrationPlanStore(W, f.f.state as never).publish({
        expectedBaseRevisionId: current.revisionId, revision,
      });
      assert.equal(saved.status, "published");
    }
    return originalGet(...args);
  };
  assert.deepEqual(await read(), { status: "stale", reason: "integration-candidate-changed-during-read" });
});

test("attempt CAS changed during validation is not reported as a current aggregate", async () => {
  const { f, complete, store, read } = await setup();
  await complete("ci");
  await complete("e2e");
  const api = (f.f.platform as any).protectedTests as { getRunV1(workspace: string, runId: string, subjectHash: string): Promise<unknown> };
  const originalGet = api.getRunV1.bind(api);
  let changed = false;
  api.getRunV1 = async (...args) => {
    if (!changed) {
      changed = true;
      const current = (await store().current())!.revision;
      const next = withIntegrationValidationReferences(current, { ...current.validationRuns!,
        ci: Object.freeze({ ...current.validationRuns!.ci!, requestId: current.validationRuns!.ci!.requestId + ".observed" }) });
      const saved = await store().publish({ expectedBaseRevisionId: current.revisionId, revision: next });
      assert.equal(saved.status, "published");
    }
    return originalGet(...args);
  };
  assert.deepEqual(await read(), { status: "stale", reason: "integration-attempt-changed-during-read" });
});

test("Git branch authority revoked during current CI observation fails closed", async () => {
  const { folders, complete, read } = await setup();
  await complete("ci");
  await complete("e2e");
  const original = folders.readWorkspaceSourceGitTipV1.bind(folders);
  let calls = 0;
  folders.readWorkspaceSourceGitTipV1 = async (...args) => {
    calls += 1;
    if (calls >= 3) return { status: "denied", reason: "branch_not_authorized" };
    return original(...args);
  };
  const value = await read();
  assert.ok(value.status === "unknown" || value.status === "stale");
  assert.notEqual(value.status, "observed");
});

test("the only positive candidate fixture remains explicitly one Workstream and one Task", async () => {
  const { f, complete, read } = await setup();
  const ci = await complete("ci"), e2e = await complete("e2e");
  const result = await read();
  assert.equal(result.status, "observed");
  if (result.status !== "observed") return;
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.snapshots[0]?.eventId, f.eventId);
  assert.equal(result.attempts[0]?.scope.taskId, "task-dev");
  assert.equal(result.ci.runId, ci);
  assert.equal(result.e2e.runId, e2e);
  assert.equal(result.deliveryAuthority, "not-established");
});
