import assert from "node:assert/strict";
import test from "node:test";
import { readIntegrationCandidate } from "../src/delivery-evidence/integration-candidate.ts";
import { setupTwoWorkstreamCandidate } from "./fixtures/integration-two-workstreams.ts";
import { W } from "./fixtures/cto-platform.ts";
import { createIntegrationAttemptStore } from "../src/builder-gates/integration-progress.ts";
import { readIntegrationValidationRuns } from "../src/builder-gates/integration-validation.ts";
import { createWorkstreamStore, readWorkstreams } from "../src/workstream-tools.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { mapKey } from "./fixtures/cto-platform.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { WORKSTREAM_VERIFIED_EVENT, WORKSTREAM_VERIFIED_JOB } from "../src/builder-gates/workstream-verification-publication.ts";
import { MANAGER_SESSION_TERMINAL_JOB } from "../src/builder-gates/integration-manager-job.ts";
import { readVerifiedWorkstreamReservation, reserveProtectedContinuation } from "../src/builder-gates/workstream-verification-consumer.ts";

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

for (const scenario of ["succeeded", "failed", "cancelled", "interrupted", "timed_out", "changed-before-terminal", "cancelled-during-park", "protected-already-waiting"] as const) {
  test(`second VERIFIED stays unattempted while Manager is busy: ${scenario}`, async () => {
    const f = await setupTwoWorkstreamCandidate({ omitSecondEffect: true });
    const platform = f.f.platform;
    const handlers = createBuilderPlatform().jobs;
    const verified = handlers.find(item => item.jobKey === WORKSTREAM_VERIFIED_JOB)!;
    const terminal = handlers.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB)!;
    const scope = { workspaceId: W, projectId: W, workstreamId: f.secondInput.workstreamId, verifiedEventId: f.secondEventId };
    const firstScope = { ...scope, workstreamId: f.input.workstreamId, verifiedEventId: f.eventId };
    const first = (await readVerifiedWorkstreamReservation(firstScope, platform.state))!;
    assert(first.receipt);
    const previousRun = first.receipt.runId, previousRequest = first.receipt.receiptId;
    const sessionId = f.managerContext.sessionId;
    const nextRun = "eaeaeaea-eaea-4aea-8aea-eaeaeaeaeaea";
    const sessions = platform.agents.sessions;
    const list = sessions.list.bind(sessions), readRequest = sessions.getRequest.bind(sessions);
    let lastRunId = previousRun, previousStatus: string = "running", nextRequest: string | null = null;
    let sends = 0;
    sessions.list = async (...args) => (await list(...args)).map(row => row.observationVersion === 1 && row.sessionId === sessionId
      ? { ...row, lastRunId } : row);
    sessions.getRun = async (session, workspace, runId) => {
      assert.equal(session, sessionId); assert.equal(workspace, W);
      const status = runId === previousRun ? previousStatus : "running";
      return { runId, status, cancellationRequested: status === "cancelled", termination: status === "cancelled" ? "confirmed" : "not_applicable",
        error: null, errorCode: null };
    };
    sessions.getRequest = async (session, workspace, request) => nextRequest && request === nextRequest
      ? { requestId: request, state: "submitted", runId: nextRun } : readRequest(session, workspace, request);
    sessions.sendMessage = async (session, workspace, options) => {
      assert.equal(session, sessionId); assert.equal(workspace, W);
      assert.notEqual(previousStatus, "running", "must not send while the first Run owns the session");
      assert.match(options.prompt, /"workstreamId":"ws-two"/u);
      assert(options.requestId);
      sends++; nextRequest = options.requestId; lastRunId = nextRun;
      return { runId: nextRun };
    };
    const wake = { jobKey: WORKSTREAM_VERIFIED_JOB, companyId: W, trigger: "event", runId: "abababab-abab-4bab-8bab-abababababab",
      eventId: f.secondEventId, event: { eventType: WORKSTREAM_VERIFIED_EVENT, payload: {} } } as never;
    if (scenario === "cancelled-during-park") {
      const cas = platform.state.compareAndSet!.bind(platform.state);
      platform.state.compareAndSet = async (key, expected, value) => {
        const result = await cas(key, expected, value);
        const row = value as { events?: { eventId?: string; requestId?: string | null }[] };
        if (result.swapped && row.events?.some(item => item.eventId === f.secondEventId && item.requestId === null)) previousStatus = "cancelled";
        return result;
      };
    }
    if (scenario === "protected-already-waiting") {
      const queued = await reserveProtectedContinuation(firstScope, { terminalEventId: "protected-terminal-fixture",
        protectedRunId: "dcdcdcdc-dcdc-4cdc-8cdc-dcdcdcdcdcdc", receiptDigest: "c".repeat(64),
        subjectKeySha256: "d".repeat(64), phase: "ci" }, platform.state);
      assert.equal(queued.status, "reserved");
      previousStatus = "succeeded";
    }
    await verified.handler(wake, platform);
    if (scenario !== "cancelled-during-park") await verified.handler(wake, platform);
    const parked = (await readVerifiedWorkstreamReservation(scope, platform.state))!;
    assert.deepEqual([parked.status, parked.requestId, parked.dispatchAttempts], ["pending", null, 0]);
    assert.equal(sends, 0);
    if (scenario === "protected-already-waiting") return;
    if (scenario === "cancelled-during-park") assert.equal(previousStatus, "cancelled", "the CAS hook must actually close the prior Run");

    if (scenario === "changed-before-terminal") {
      const board = (await readWorkstreams(W, W, platform))!.revision;
      const workstreams = board.workstreams.map(item => item.spec.id === scope.workstreamId
        ? { ...item, spec: { ...item.spec, title: "Changed after reservation" } } : item);
      const changed = await createWorkstreamStore(W, W, platform.state).publish({ expectedBaseRevisionId: board.revisionId,
        revision: { ...board, revisionId: "changed-while-manager-busy", workstreams } });
      assert.equal(changed.status, "published");
    }
    const terminalStatus = scenario === "changed-before-terminal" ? "succeeded" : scenario === "cancelled-during-park" ? "cancelled" : scenario;
    previousStatus = terminalStatus;
    const event = { jobKey: MANAGER_SESSION_TERMINAL_JOB, companyId: W, trigger: "event", runId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      eventId: `agent-session-terminal-v1:${"d".repeat(64)}`, event: { eventType: "agent.session.run.terminal", payload: {
        schemaVersion: 1, runId: previousRun, sessionId, requestId: previousRequest, status: terminalStatus,
        resultSha256: "a".repeat(64), finishedAt: "2026-11-07T12:00:00.000Z" } } } as never;
    await Promise.all([terminal.handler(event, platform), terminal.handler(event, platform)]);
    const drained = (await readVerifiedWorkstreamReservation(scope, platform.state))!;
    if (terminalStatus === "cancelled" || scenario === "changed-before-terminal") {
      assert.equal(sends, 0, "cancellation and stale queued evidence do not wake a replacement");
      assert.deepEqual(drained, parked);
    } else {
      assert.equal(sends, 1);
      assert.deepEqual([drained.status, drained.dispatchAttempts, drained.receipt?.runId], ["accepted", 1, nextRun]);
      await verified.handler(wake, platform);
      assert.equal(sends, 1, "verified-event replay only reconciles its existing Core receipt");
    }
  });
}
