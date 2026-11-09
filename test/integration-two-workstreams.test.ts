import assert from "node:assert/strict";
import test from "node:test";
import { readIntegrationCandidate } from "../src/delivery-evidence/integration-candidate.ts";
import { setupTwoWorkstreamCandidate } from "./fixtures/integration-two-workstreams.ts";
import { W } from "./fixtures/cto-platform.ts";
import { createIntegrationAttemptStore } from "../src/builder-gates/integration-progress.ts";
import { readIntegrationValidationRuns } from "../src/builder-gates/integration-validation.ts";
import { readWorkstreams } from "../src/workstream-tools.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { mapKey } from "./fixtures/cto-platform.ts";

test("one Workstream without its registered integration effect remains required", async () => {
  const fixture = await setupTwoWorkstreamCandidate({ omitSecondEffect: true });
  assert.deepEqual(await readIntegrationCandidate(W, fixture.f.platform), {
    status: "pending", reason: "workstream-task-integration-not-observed",
  });
});

test("registered integration rejects a QA run reference pinned to a different Source", async () => {
  await assert.rejects(() => setupTwoWorkstreamCandidate({ mismatchSecondQaSource: true }),
    /The exact current or publication-verified carried QA binding is unavailable/u);
});

test("candidate requires both independent Workstream Task+QA chains and aggregates their sequential Git effects", async () => {
  const fixture = await setupTwoWorkstreamCandidate();
  assert.ok("validationResults" in fixture);
  const board = (await readWorkstreams(W, W, fixture.f.platform))!.revision;
  const firstWs = board.workstreams.find(row => row.spec.id === "ws-1")!;
  const secondWs = board.workstreams.find(row => row.spec.id === "ws-two")!;
  assert.notEqual(firstWs.spec.assignedCtoId, secondWs.spec.assignedCtoId);
  assert.notEqual(firstWs.ctoAgentId, secondWs.ctoAgentId);
  assert.notEqual(firstWs.ctoSessionId, secondWs.ctoSessionId);
  const secondPackets = (await createTaskPacketStore(W, W, fixture.secondOwnership.ctoId, "ws-two", fixture.f.state as never).current())!.revision;
  assert.equal(secondPackets.packets[0]?.author.agentId, secondWs.ctoAgentId);
  assert.equal(secondPackets.packets[1]?.author.agentId, secondWs.ctoAgentId);
  const registryKey = mapKey({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder",
    stateKey: taskWorkerRegistryKey(W, fixture.secondOwnership.ctoId) });
  const registry = fixture.f.values.get(registryKey) as { records: Array<{ role: string; agentId: string; sessionId: string }> };
  const worker = registry.records.find(row => row.role === "worker")!, qa = registry.records.find(row => row.role === "qa")!;
  assert.notEqual(worker.agentId, qa.agentId);
  assert.notEqual(worker.sessionId, qa.sessionId);
  assert.equal(worker.agentId, fixture.secondOwnership.workerAgentId);
  assert.equal(qa.agentId, fixture.secondOwnership.qaAgentId);
  assert.deepEqual(fixture.validationResults.map(row => row.data.status), ["published", "published"], JSON.stringify(fixture.validationResults));
  const attempts = await Promise.all([
    createIntegrationAttemptStore({ workspaceId: W, workstreamId: fixture.input.workstreamId,
      eventId: fixture.eventId, taskId: fixture.input.taskId }, fixture.f.state as never).current(),
    createIntegrationAttemptStore({ workspaceId: W, workstreamId: "ws-two", eventId: fixture.secondEventId,
      taskId: "task-two-dev" }, fixture.f.state as never).current(),
  ]);
  assert.ok(attempts.every(item => item?.revision.stage === "git-observed"), JSON.stringify(attempts));
  assert.deepEqual((await readIntegrationValidationRuns(attempts.map(item => item!.revision), fixture.f.platform)).map(row => row.status),
    ["passed", "passed"], "both registered validation references must resolve to synthetic completed Core DTOs");
  const result = await readIntegrationCandidate(W, fixture.f.platform);
  assert.equal(result.status, "observed", JSON.stringify(result));
  if (result.status !== "observed") return;
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(new Set(result.snapshots.map(row => row.workstreamId)), new Set(["ws-1", "ws-two"]));
  assert.deepEqual(new Set(result.attempts.map(row => row.scope.taskId)), new Set(["task-dev", "task-two-dev"]));
  assert.equal(result.attempts[0]?.git?.status, "integrated");
  assert.equal(result.attempts[1]?.git?.status, "integrated");
  assert.equal(result.attempts[0]?.effect.expectedHead, "f".repeat(40));
  assert.equal(result.attempts[1]?.effect.expectedHead, result.attempts[0]?.git?.commitSha);
  assert.equal(result.attempts[0]?.effect.sourceId, result.attempts[1]?.effect.sourceId);
  assert.notEqual(result.attempts[0]?.effect.incomingCommit, result.attempts[1]?.effect.incomingCommit);
  assert.equal(result.attempts[1]?.effect.incomingCommit, "6".repeat(40));
  assert.notEqual(result.attempts[0]?.git?.commitSha, result.attempts[1]?.git?.commitSha);
  assert.equal(result.candidate.commitSha, result.attempts[1]?.git?.commitSha);
  assert.deepEqual(result.ci.status, "passed");
  assert.deepEqual(result.e2e.status, "passed");
  assert.equal(result.scopeTrace.requirements.find(row => row.requirementId === "REQ-1")?.tasks.length, 2);
  assert.equal(result.deliveryAuthority, "not-established");
  assert.match(fixture.syntheticEvidence, /fixture DTOs/u);
});
