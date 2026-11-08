import assert from "node:assert/strict";
import test from "node:test";
import { createBuilderPlatform } from "../src/platform.ts";
import { MANAGER_SESSION_TERMINAL_JOB } from "../src/builder-gates/integration-manager-job.ts";
import { workerResultFixture, runDto } from "./fixtures/cto-task-result-independent.ts";
import { A, C, CTO, W } from "./fixtures/cto-platform.ts";

const contract = () => createBuilderPlatform();
async function deliver(f: Awaited<ReturnType<typeof workerResultFixture>>, job = f.childJob()) {
  const registered = contract().jobs.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB);
  assert.ok(registered, "exercise the actual registered terminal job, not the consumer directly");
  await registered.handler(job as never, f.f.platform);
}
async function readChild(f: Awaited<ReturnType<typeof workerResultFixture>>, runId: string) {
  const tool = contract().tools.find(item => item.name === "builder.read-cto-workstream");
  assert.ok(tool);
  return tool.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1" },
    { companyId: W, projectId: W, agentId: A, sessionId: C, runId } as never, f.f.platform);
}

test("registered Worker result persists one pointer while CTO is active, then exact parent terminal admits one child", async () => {
  const f = await workerResultFixture();
  await deliver(f);
  assert.equal(f.dispatches.length, 0);
  const pending = await f.handoffs();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.phase, "pending");
  assert.equal(pending[0]!.sourceRunId, f.results[0]!.runId);
  assert.equal(pending[0]!.previousCtoRunId, f.parentRunId);
  assert.equal(pending[0]!.runId, null);
  await deliver(f);
  assert.deepEqual(await f.handoffs(), pending, "duplicate source event must not add another pending result");
  await deliver(f, f.terminalParent());
  assert.equal(f.dispatches.length, 1);
  const accepted = (await f.handoffs())[0]!;
  assert.equal(accepted.phase, "accepted");
  assert.equal(accepted.runId, f.dispatches[0]!.runId);
  assert.equal(f.dispatches[0]!.input.previousRunId, f.parentRunId);
  assert.equal(f.dispatches[0]!.input.eventId, f.results[0]!.eventId);
  assert.ok(f.dispatches[0]!.input.guards.length > 0);
  const run = await f.sessions.getRun(C, W, accepted.runId!);
  assert.equal(run.cancellationRequested, false); assert.equal(run.termination, "not_applicable");
  assert.deepEqual((run as any).systemEvent, { schemaVersion: 1, kind: "agent-session-terminal-event",
    requestId: accepted.requestId, previousRunId: f.parentRunId, eventId: f.results[0]!.eventId,
    sourceSessionId: f.results[0]!.worker.sessionId, sourceRunId: f.results[0]!.runId,
    resultSha256: f.results[0]!.payload.resultSha256 });
  assert.equal(Reflect.ownKeys((run as any).systemEvent).length, 8);
  await readChild(f, accepted.runId!);
  await deliver(f);
  await deliver(f, f.terminalParent(f.parentRunId));
  assert.equal(f.dispatches.length, 1, "duplicate old parent/source events cannot dispatch another child");
  assert.equal(f.f.sends, 1, "only the initial CTO planning send uses sendMessage; no prompt fallback");
});

test("registered multiple pending results advance deterministically across child terminals and exact lineage selection", async () => {
  const f = await workerResultFixture(2);
  await deliver(f, f.childJob(0)); await deliver(f, f.childJob(1));
  assert.equal((await f.handoffs()).filter(item => item.phase === "pending").length, 2);
  assert.equal(f.dispatches.length, 0);
  await deliver(f, f.terminalParent());
  assert.equal(f.dispatches.length, 1, "multiple pending results must make bounded progress, not reject the queue");
  const first = f.dispatches[0]!;
  assert.equal(first.input.eventId, [...f.results].sort((a, b) => a.eventId.localeCompare(b.eventId))[0]!.eventId);
  assert.equal((await f.handoffs()).find(item => item.phase === "pending")!.previousCtoRunId, first.runId);
  await readChild(f, first.runId);
  await deliver(f, f.terminalParent(first.runId));
  assert.equal(f.dispatches.length, 2);
  const second = f.dispatches[1]!;
  assert.notEqual(second.input.eventId, first.input.eventId);
  assert.equal(second.input.previousRunId, first.runId, "next result must use the actual child head, not the old root Run");
  await readChild(f, second.runId);
  assert.equal((await f.handoffs()).filter(item => item.phase === "accepted").length, 2);
  await deliver(f, f.terminalParent(first.runId));
  await deliver(f, f.childJob(0)); await deliver(f, f.childJob(1));
  assert.equal(f.dispatches.length, 2);
});

function assertNoUnboundDispatchAttempts(f: Awaited<ReturnType<typeof workerResultFixture>>) {
  for (const attempt of f.attempts) {
    const matching = f.dispatches.filter(({ input }) => input.eventId === attempt.eventId && input.previousRunId === attempt.previousRunId
      && input.sourceSessionId === attempt.sourceSessionId && input.sourceRunId === attempt.sourceRunId);
    assert.equal(matching.length, 1, "a repeated RPC may only use the exact already-admitted canonical request");
  }
}

test("registered replay adopts the exact child after Core accepted but its reply was lost", async t => {
  for (const replay of ["source", "parent"] as const) await t.test(replay, async () => {
    const f = await workerResultFixture();
    await deliver(f);
    const parentJob = f.terminalParent();
    const getRun = f.sessions.getRun.bind(f.sessions), getRequest = f.sessions.getRequest.bind(f.sessions);
    let replyLost = false, readbackAvailable = false, childRunReads = 0, childReceiptReads = 0;
    f.setAfterAdmission(async () => { replyLost = true; throw new Error("Injected lost response after child acceptance"); });
    f.sessions.getRun = async (sessionId, workspaceId, runId) => {
      if (runId === f.dispatches[0]?.runId) {
        if (!readbackAvailable) throw new Error("Injected child readback unavailable until replay");
        childRunReads++;
      }
      return getRun(sessionId, workspaceId, runId);
    };
    f.sessions.getRequest = async (sessionId, workspaceId, requestId) => {
      if (requestId === f.dispatches[0]?.requestId) childReceiptReads++;
      return getRequest(sessionId, workspaceId, requestId);
    };
    await assert.rejects(deliver(f, parentJob), /handoff unresolved/u);
    assert.equal(replyLost, true);
    assert.equal(f.dispatches.length, 1);
    assert.equal((await f.handoffs())[0]!.phase, "pending");
    const child = f.dispatches[0]!;
    readbackAvailable = true;
    await deliver(f, replay === "source" ? f.childJob() : parentJob);
    const handoff = (await f.handoffs())[0]!;
    assert.equal(handoff.phase, "accepted", `${replay} replay must adopt the admitted child instead of leaving the pointer pending`);
    assert.equal(handoff.requestId, child.requestId);
    assert.equal(handoff.runId, child.runId);
    assert.ok(childRunReads > 0, "recovery must read the child's actual eight-field Core lineage");
    assert.ok(childReceiptReads > 0, "recovery must read the child's submitted Core request receipt");
    assert.equal(f.dispatches.length, 1);
    assertNoUnboundDispatchAttempts(f);
    assert.equal(f.f.sends, 1);
  });
});

test("registered early first-child terminal cannot lose the next pending Worker result before handoff CAS", async () => {
  const f = await workerResultFixture(2);
  await deliver(f, f.childJob(0)); await deliver(f, f.childJob(1));
  assert.equal((await f.handoffs()).filter(row => row.phase === "pending").length, 2);
  let early: { job: ReturnType<typeof f.terminalParent>; outcome: PromiseSettledResult<void>; acceptedCount: number } | undefined;
  f.setAfterAdmission(async first => {
    if (f.dispatches.length !== 1) return;
    // Core has installed the child as session head, but the first dispatch RPC has not returned to the Builder CAS.
    assert.equal((await f.handoffs()).filter(row => row.phase === "accepted").length, 0);
    const job = f.terminalParent(first.runId);
    const [outcome] = await Promise.allSettled([deliver(f, job)]);
    early = { job, outcome: outcome!, acceptedCount: f.dispatches.length };
  });
  const [parent] = await Promise.allSettled([deliver(f, f.terminalParent())]);
  assert.ok(early, "the child's terminal must arrive before the first dispatch response");
  const first = f.dispatches[0]!;
  if (early.outcome.status === "rejected") {
    assert.match(String(early.outcome.reason), /handoff unresolved/u);
    await deliver(f, early.job);
  } else {
    assert.equal(early.acceptedCount, 2, "a delivered child terminal must advance the next pending result or explicitly request retry");
  }
  if (parent?.status === "rejected") assert.match(String(parent.reason), /handoff unresolved/u);
  assert.equal(f.dispatches.length, 2);
  const second = f.dispatches[1]!;
  assert.notEqual(second.input.eventId, first.input.eventId);
  assert.equal(second.input.previousRunId, first.runId);
  assert.equal(new Set(f.dispatches.map(row => row.requestId)).size, 2);
  assert.equal(new Set(f.dispatches.map(row => row.runId)).size, 2);
  assert.deepEqual((await f.handoffs()).map(row => ({ phase: row.phase, runId: row.runId })).sort((a, b) => String(a.runId).localeCompare(String(b.runId))),
    f.dispatches.map(row => ({ phase: "accepted", runId: row.runId })).sort((a, b) => a.runId.localeCompare(b.runId)));
  await deliver(f, early.job);
  assert.equal(f.dispatches.length, 2);
  assertNoUnboundDispatchAttempts(f);
  assert.equal(f.f.sends, 1);
});

for (const kind of ["source-tip", "Task", "CTO", "source-receipt"] as const) {
  test(`registered pending Worker result refuses changed ${kind} before parent-terminal dispatch`, async () => {
    const f = await workerResultFixture();
    await deliver(f);
    if (kind === "source-tip") f.tips.set(f.results[0]!.packet.packet.sourceAccess!.branch!, { commitSha: "f".repeat(40), treeSha: "e".repeat(40) });
    if (kind === "CTO") f.retireCto();
    if (kind === "source-receipt") f.sourceReceipts.set(`${f.results[0]!.worker.sessionId}:${f.results[0]!.requestId}`,
      { requestId: f.results[0]!.requestId, state: "uncertain", runId: null });
    if (kind === "Task") {
      const current = (await f.packetStore.current())!.revision;
      assert.equal((await f.packetStore.publish({ expectedBaseRevisionId: current.revisionId,
        revision: { ...current, revisionId: "changed-independent-packets", packets: current.packets.map(row =>
          ({ ...row, packet: { ...row.packet, revision: row.packet.revision + 1 } })) } })).status, "published");
    }
    await deliver(f, f.terminalParent()).catch(error => assert.match(String(error), /handoff unresolved/u));
    assert.equal(f.dispatches.length, 0);
    assert.equal((await f.handoffs())[0]!.phase, "pending");
    assert.equal(f.f.sends, 1);
  });
}

test("registered pending result refuses a state-guard revocation at fake admission", async () => {
  const f = await workerResultFixture(); await deliver(f);
  f.setBeforeDispatch(async () => { f.retireCto(); });
  await assert.rejects(deliver(f, f.terminalParent()), /handoff unresolved/u);
  assert.equal(f.dispatches.length, 0);
  assert.equal((await f.handoffs())[0]!.phase, "pending");
});

test("registered parent terminal does not borrow an active, unknown or cancelled parent Run", async t => {
  for (const kind of ["active", "unknown", "cancelled"] as const) await t.test(kind, async () => {
    const f = await workerResultFixture(); await deliver(f);
    const job = f.terminalParent(f.parentRunId, kind === "cancelled" ? "cancelled" : "succeeded");
    if (kind === "active") f.f.runs.set(f.parentRunId, runDto(f.parentRunId) as never);
    if (kind === "unknown") f.f.runs.delete(f.parentRunId);
    if (kind === "cancelled") await deliver(f, job);
    else await assert.rejects(deliver(f, job), /handoff unresolved/u);
    assert.equal(f.dispatches.length, 0);
    assert.equal((await f.handoffs())[0]!.phase, "pending");
  });
});

test("legacy fixed SDK missing the optional new method is surfaced by the registered Worker job without fallback", async () => {
  const f = await workerResultFixture(); delete f.sessions.dispatchSessionTerminalEventV1;
  await assert.rejects(deliver(f), /handoff unresolved: session-terminal-event-dispatch-unavailable/u);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.f.sends, 1);
});
