import assert from "node:assert/strict";
import test from "node:test";
import { readIntegrationCandidate } from "../src/delivery-evidence/integration-candidate.ts";
import { W } from "./fixtures/cto-platform.ts";
import { progressTool, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

// Fixture Host responses exercise the existing journals and registered producer tools.
async function setup() {
  const f = await validationFixture();
  const { localFolders: folders } = f.f.platform as unknown as { localFolders: {
    readWorkspaceSourceGitTipV1(...args: string[]): Promise<Record<string, unknown>>;
  } };
  const original = folders.readWorkspaceSourceGitTipV1.bind(folders);
  folders.readWorkspaceSourceGitTipV1 = async (...args) => {
    const tip = await original(...args);
    return tip.status === "current" ? { ...tip, observedAt: "2026-11-07T12:00:00.000Z" } : tip;
  };
  const complete = async (phase: "ci" | "e2e", processExitCode = 0) => {
    const result = await validationTool().handler({ ...f.input, phase }, f.managerContext, f.f.platform);
    const data = result.data as unknown as { reference: { runId: string } };
    const run = f.runs.get(data.reference.runId);
    run.status = processExitCode ? "failed" : "succeeded";
    run.termination = "confirmed";
    run.receipt = { digest: "a".repeat(64), status: "completed", stdoutSha256: null, stderrSha256: null, stdoutBytes: 0, stderrBytes: 0,
      processExitCode, timedOut: false, cancelled: false, outputLimit: false, appContainerVerified: true, capabilitiesCount: 0,
      childTerminationConfirmed: true, jobEmpty: true, profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
    return data.reference.runId;
  };
  return { f, folders, complete, read: () => readIntegrationCandidate(W, f.f.platform) };
}

test("joins the current verified task and exact candidate Git and CI/E2E observations without final approval", async () => {
  const { f, complete, read } = await setup();
  assert.deepEqual(await read(), { status: "pending", reason: "integration-ci-run-not-unique-or-unavailable" });
  const ci = await complete("ci");
  assert.deepEqual(await read(), { status: "pending", reason: "integration-e2e-run-not-unique-or-unavailable" });
  const e2e = await complete("e2e");
  const value = await read();
  assert.equal(value.status, "observed");
  if (value.status !== "observed") return;
  assert.equal(value.snapshots[0]?.eventId, f.eventId);
  assert.equal(value.attempts[0]?.scope.taskId, "task-dev");
  assert.equal(value.candidate.commitSha, "b".repeat(40));
  assert.equal(value.ci.runId, ci);
  assert.equal(value.e2e.runId, e2e);
  assert.equal(value.deliveryAuthority, "not-established");
  const input = { workstreamId: f.input.workstreamId, eventId: f.eventId, projection: "candidate" };
  const shown = await progressTool().handler(input, f.managerContext, f.f.platform);
  assert.deepEqual(shown.data, { status: "observed", candidate: value.candidate, planRevisionId: value.plan.revisionId,
    boardRevisionId: value.boardRevisionId, workstreamCount: 1, taskCount: 1, ciRunId: ci, e2eRunId: e2e,
    deliveryAuthority: "not-established" });
  await assert.rejects(async () => await progressTool().handler(input, { ...f.managerContext, runId: f.managerContext.sessionId },
    f.f.platform), /receipt|run|Manager/iu);
  assert.equal(f.enqueueCalls, 2, "the aggregate read must not enqueue another run");
  f.moveCandidate();
  assert.deepEqual(await read(), { status: "stale", reason: "integration-candidate-does-not-match-observed-effects" });
});

test("a failed current technical test is not replaced by another passed phase", async () => {
  const { complete, read } = await setup();
  await complete("ci");
  await complete("e2e", 1);
  assert.deepEqual(await read(), { status: "failed", reason: "integration-e2e-not-passed" });
});

test("lost Git authorization does not preserve a previously observed candidate", async () => {
  const { folders, complete, read } = await setup();
  await complete("ci");
  await complete("e2e");
  assert.equal((await read()).status, "observed");
  folders.readWorkspaceSourceGitTipV1 = async () => ({ status: "denied", reason: "branch_not_authorized" });
  assert.deepEqual(await read(), { status: "unknown", reason: "integration-candidate-read-unconfirmed" });
});
