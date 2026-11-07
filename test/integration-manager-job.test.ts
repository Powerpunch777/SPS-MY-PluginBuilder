import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createVerifiedWorkstreamManagerReadHandler, consumeVerifiedWorkstreamJob,
  consumeManagerSessionTerminalJob,
  INTEGRATION_MANAGER_VERIFIED_READ_TOOL, managerRequestUuidForLedgerKey, MANAGER_SESSION_TERMINAL_JOB,
  resolveCurrentIntegrationManagerAuthority, type VerifiedEventLookup } from "../src/builder-gates/integration-manager-job.ts";
import { consumeVerifiedWorkstream, type ManagerDispatchPort, type VerifiedSnapshotRead,
  type VerifiedWorkstreamSnapshot } from "../src/builder-gates/workstream-verification-consumer.ts";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey,
  integrationManagerStateKey } from "../src/domain/integration-manager.ts";
import { WORKSTREAM_VERIFIED_EVENT, WORKSTREAM_VERIFIED_JOB } from "../src/builder-gates/workstream-verification-publication.ts";
import { mapKey } from "./fixtures/cto-platform.ts";
import { validationFixture, validationTool, progressTool, MANAGER_RUN as FIXTURE_MANAGER_RUN } from "./fixtures/integration-manager-platform.ts";
import { createBuilderPlatform } from "../src/platform.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const MANAGER = "44444444-4444-4444-8444-444444444444";
const snapshot: VerifiedWorkstreamSnapshot = {
  eventId: "event-1", workspaceId: WORKSPACE, projectId: WORKSPACE, workstreamId: "ws-1", verificationStatus: "VERIFIED",
  sourcePins: [{ sourceId: "qa", revisionId: "qa-r1", sha256: "a".repeat(64) }],
  gateDecisions: [{ gateId: "G4", verdict: "PASS", evidenceRefs: [{ sourceId: "qa", revisionId: "qa-r1", sha256: "a".repeat(64) }] },
    { gateId: "G6", verdict: "PASS", evidenceRefs: [{ sourceId: "qa", revisionId: "qa-r1", sha256: "a".repeat(64) }] }],
  qaEvidence: [{ result: "passed", report: { sourceId: "qa", revisionId: "qa-r1", sha256: "a".repeat(64) } }],
};
const ledgerRequestId = `builder-ws-dispatch-v1:${"b".repeat(64)}`;
const requestUuid = managerRequestUuidForLedgerKey(ledgerRequestId);
const currentRead: VerifiedSnapshotRead = { status: "current", snapshot };
const currentLookup = async (): Promise<VerifiedEventLookup> => ({ status: "current", workstreamId: "ws-1", snapshot });
const requestKey = { scopeKind: "company" as const, scopeId: WORKSPACE, namespace: "sonpark.my-builder" as const,
  stateKey: `verified-consumption.v1.${createHash("sha256").update(`${WORKSPACE}\0ws-1`, "utf8").digest("hex")}` };
const taskKey = integrationManagerSessionTaskKey(WORKSPACE, WORKSPACE, MANAGER);

function managerHost(options: { selectedAgentId?: string; profileStatus?: string; sessionStatus?: string; pauseReason?: string;
  contextState?: string; includeContext?: boolean } = {}) {
  const values = new Map<string, JsonValue>([
    [integrationManagerStateKey(WORKSPACE).stateKey, { schemaVersion: 1, workspaceId: WORKSPACE, revision: 2,
      selectedAgentId: options.selectedAgentId ?? MANAGER }],
    [integrationManagerSessionStateKey(WORKSPACE, WORKSPACE, MANAGER).stateKey, { schemaVersion: 1,
      workspaceId: WORKSPACE, projectId: WORKSPACE, managerAgentId: MANAGER, sessionId: SESSION, taskKey }],
  ]);
  let coreRunStatus = "running";
  const calls: string[] = [];
  const host = {
    state: {
      async get(key: SpsStateKey) { return structuredClone(values.get(key.stateKey) ?? null); },
      async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
        const present = values.has(key.stateKey), old = values.get(key.stateKey);
        const swapped = expected.exists ? present && JSON.stringify(old) === JSON.stringify(expected.value) : !present;
        if (swapped) values.set(key.stateKey, structuredClone(value));
        return { swapped };
      },
    },
    agents: {
      owned: { async get() { return { status: "resolved", revision: 1, agent: { agentId: MANAGER,
        role: "integration-manager", status: options.profileStatus ?? "idle" } }; } },
      async list() { return [{ id: MANAGER, companyId: WORKSPACE, status: options.profileStatus ?? "idle",
        ...(options.profileStatus === "paused" ? { pauseReason: options.pauseReason ?? "system" } : {}) }]; },
      sessions: {
        async list() { return [{ observationVersion: 1, sessionId: SESSION, agentId: MANAGER, companyId: WORKSPACE,
          status: options.sessionStatus ?? "active", taskKey, closedAt: null, contextState: options.contextState ?? "valid",
          ...(options.includeContext ? { context: { projectId: WORKSPACE } } : {}), managedAgentOwnership: "owned" }]; },
        async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"],
          enforcement: "dispatch-and-run", readiness: "unknown", osIsolation: "not-certified" }; },
        async getRequest(_session: string, _workspace: string, id: string) {
          calls.push("getRequest");
          return id === requestUuid ? { requestId: id, state: "submitted", runId: RUN } : null;
        },
        async getRun(_session: string, _workspace: string, id: string) {
          calls.push("getRun");
          return { runId: id, status: coreRunStatus, cancellationRequested: false, termination: "not_applicable",
            errorCode: null, error: null };
        },
      },
    },
  } as unknown as SpsPlatformInvocationContext;
  return { host, values, calls, setRunStatus(status: string) { coreRunStatus = status; } };
}

function seedPending(f: ReturnType<typeof managerHost>) {
  f.values.set(requestKey.stateKey, { schemaVersion: 2, workspaceId: WORKSPACE, projectId: WORKSPACE,
    workstreamId: "ws-1", revision: 1, events: [{ eventId: snapshot.eventId, evidenceDigest: "c".repeat(64),
      requestId: ledgerRequestId, status: "pending", dispatchAttempts: 1, receipt: null }] });
}

function seedAccepted(f: ReturnType<typeof managerHost>, runId = RUN) {
  f.values.set(requestKey.stateKey, { schemaVersion: 2, workspaceId: WORKSPACE, projectId: WORKSPACE,
    workstreamId: "ws-1", revision: 2, events: [{ eventId: snapshot.eventId, evidenceDigest: "c".repeat(64),
      requestId: ledgerRequestId, status: "accepted", dispatchAttempts: 1, receipt: { receiptId: requestUuid, runId } }] });
}

test("event-only job rejects schedule/manual fallback before Workspace reads", async () => {
  let stateReads = 0;
  const platform = { state: { async get() { stateReads++; return null; } } } as unknown as SpsPlatformInvocationContext;
  const result = await consumeVerifiedWorkstreamJob({ jobKey: WORKSTREAM_VERIFIED_JOB, runId: RUN, trigger: "schedule",
    companyId: WORKSPACE, eventId: snapshot.eventId }, platform);
  assert.equal(result.reason, "event-job-context-incomplete-or-unsupported");
  assert.equal(stateReads, 0);
});

test("Manager authority requires selected owned identity and a current independent session", async () => {
  const f = managerHost();
  assert.deepEqual(await resolveCurrentIntegrationManagerAuthority(WORKSPACE, f.host), { agentId: MANAGER, sessionId: SESSION, taskKey });
  const mismatch = managerHost({ selectedAgentId: "66666666-6666-4666-8666-666666666666" });
  await assert.rejects(resolveCurrentIntegrationManagerAuthority(WORKSPACE, mismatch.host), /manager-selected-agent-does-not-match-owned-role-profile/u);
  const inactive = managerHost({ sessionStatus: "inactive" });
  await assert.rejects(resolveCurrentIntegrationManagerAuthority(WORKSPACE, inactive.host), /manager-session-not-current-owned-independent/u);
  const systemPaused = managerHost({ profileStatus: "paused", pauseReason: "system" });
  assert.deepEqual(await resolveCurrentIntegrationManagerAuthority(WORKSPACE, systemPaused.host), { agentId: MANAGER, sessionId: SESSION, taskKey });
  const workspaceOnly = managerHost({ contextState: "none" });
  assert.deepEqual(await resolveCurrentIntegrationManagerAuthority(WORKSPACE, workspaceOnly.host), { agentId: MANAGER, sessionId: SESSION, taskKey });
  for (const options of [{ contextState: "unknown" }, { contextState: "none", includeContext: true }]) {
    const invalidContext = managerHost(options);
    await assert.rejects(resolveCurrentIntegrationManagerAuthority(WORKSPACE, invalidContext.host), /manager-session-not-current-owned-independent/u);
  }
  const userPaused = managerHost({ profileStatus: "paused", pauseReason: "user" });
  await assert.rejects(resolveCurrentIntegrationManagerAuthority(WORKSPACE, userPaused.host), /manager-workspace-membership-unavailable/u);
});

test("pending Core request authorizes Manager read before terminal run; terminal receipt then consumes ledger", async () => {
  const f = managerHost();
  seedPending(f);
  const readCurrent = async (): Promise<VerifiedEventLookup> => currentLookup();
  const readTool = createVerifiedWorkstreamManagerReadHandler(async () => ({ agentId: MANAGER, sessionId: SESSION, taskKey }), readCurrent);

  // Core's restricted ToolRunContext legitimately omits projectId.
  const observed = await readTool({ workstreamId: "ws-1", eventId: snapshot.eventId }, {
    companyId: WORKSPACE, agentId: MANAGER, sessionId: SESSION, runId: RUN,
  }, f.host);
  assert.equal((observed.data as { eventId: string }).eventId, snapshot.eventId);
  assert.deepEqual(f.calls, ["getRequest", "getRun"]);

  f.setRunStatus("succeeded");
  const port: ManagerDispatchPort = {
    async dispatch() { assert.fail("An existing request receipt must reconcile without redispatch."); },
    async readReceipt(id) {
      const mapped = managerRequestUuidForLedgerKey(id);
      const receipt = await (f.host as never as { agents: { sessions: { getRequest(session: string, workspace: string, id: string): Promise<unknown> } } })
        .agents.sessions.getRequest(SESSION, WORKSPACE, mapped) as { requestId: string; state: string; runId: string } | null;
      if (!receipt || receipt.requestId !== mapped) return { status: "uncertain", reason: "missing" };
      const run = await (f.host as never as { agents: { sessions: { getRun(session: string, workspace: string, id: string): Promise<unknown> } } })
        .agents.sessions.getRun(SESSION, WORKSPACE, receipt.runId) as { runId: string; status: string };
      if (run.runId !== receipt.runId) return { status: "uncertain", reason: "run-mismatch" };
      return run.status === "succeeded" ? { status: "accepted", requestId: id, receiptId: mapped, runId: run.runId }
        : { status: "pending", requestId: id };
    },
  };
  const consumed = await consumeVerifiedWorkstream({ workspaceId: WORKSPACE, projectId: WORKSPACE,
    workstreamId: "ws-1", eventId: snapshot.eventId }, f.host.state, async () => currentRead, port);
  assert.equal(consumed.status, "accepted");
  const ledger = f.values.get(requestKey.stateKey) as { events: Array<{ status: string; receipt: { runId: string } }> };
  assert.equal(ledger.events[0]?.status, "accepted");
  assert.equal(ledger.events[0]?.receipt.runId, RUN);
});

test("accepted ledger admission still authorizes only its exact active Manager request/run", async t => {
  await t.test("exact accepted receipt remains readable while Manager run is active", async () => {
    const f = managerHost();
    seedAccepted(f);
    const readTool = createVerifiedWorkstreamManagerReadHandler(async () => ({ agentId: MANAGER, sessionId: SESSION, taskKey }), currentLookup);
    const observed = await readTool({ workstreamId: "ws-1", eventId: snapshot.eventId }, {
      companyId: WORKSPACE, projectId: WORKSPACE, agentId: MANAGER, sessionId: SESSION, runId: RUN,
    }, f.host);
    assert.equal((observed.data as { eventId: string }).eventId, snapshot.eventId);
    assert.deepEqual(f.calls, ["getRequest", "getRun"]);
  });
  await t.test("another run cannot borrow accepted ledger authority", async () => {
    const f = managerHost();
    seedAccepted(f);
    const readTool = createVerifiedWorkstreamManagerReadHandler(async () => ({ agentId: MANAGER, sessionId: SESSION, taskKey }), currentLookup);
    await assert.rejects(readTool({ workstreamId: "ws-1", eventId: snapshot.eventId }, {
      companyId: WORKSPACE, agentId: MANAGER, sessionId: SESSION, runId: "55555555-5555-4555-8555-555555555555",
    }, f.host), /[Aa]ccepted ledger receipt|exact Core request receipt/u);
  });
});

test("fixed namespace hash preserves canonical Host UUID across logical retries", () => {
  assert.equal(requestUuid, "7ee1257d-73ec-5abd-a54a-1b6a509df5ac");
  assert.equal(managerRequestUuidForLedgerKey(ledgerRequestId), requestUuid);
});

test("Manager read cannot use another project, another run, or a null request receipt", async () => {
  const f = managerHost();
  seedPending(f);
  const readTool = createVerifiedWorkstreamManagerReadHandler(async () => ({ agentId: MANAGER, sessionId: SESSION, taskKey }), currentLookup);
  await assert.rejects(readTool({ workstreamId: "ws-1", eventId: snapshot.eventId }, {
    companyId: WORKSPACE, projectId: "other-project", agentId: MANAGER, sessionId: SESSION, runId: RUN,
  }, f.host), /single-Workspace Manager tool context/u);
  await assert.rejects(readTool({ workstreamId: "ws-1", eventId: snapshot.eventId }, {
    companyId: WORKSPACE, agentId: MANAGER, sessionId: SESSION, runId: "55555555-5555-4555-8555-555555555555",
  }, f.host), /exact Core request receipt/u);
  assert.equal(INTEGRATION_MANAGER_VERIFIED_READ_TOOL, "builder.read-verified-workstream");
});

async function preparedTerminalFixture(managerStatus: "running" | "succeeded" | "failed" | "cancelled" = "succeeded",
  phase: "ci" | "e2e" | "regression" = "ci", withRegression = false) {
  const validation = await validationFixture(withRegression);
  const fixture = validation.f;
  const admitted = await validationTool().handler({ ...validation.input, phase }, validation.managerContext, fixture.platform) as any;
  const reference = admitted.data.reference;
  const sessions = fixture.platform.agents.sessions as typeof fixture.platform.agents.sessions & Record<string, any>;
  const coreRequests = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const sends: Array<{ requestId: string; runId: string; prompt: string }> = [];
  let originalManagerStatus = managerStatus;
  const priorGetRequest = sessions.getRequest.bind(sessions);
  sessions.getRequest = async (sessionId: string, companyId: string, requestId: string) =>
    coreRequests.get(requestId) ?? priorGetRequest(sessionId, companyId, requestId);
  sessions.getRun = async (_sessionId: string, _companyId: string, runId: string) => ({ runId,
    status: runId === FIXTURE_MANAGER_RUN ? originalManagerStatus : "running", cancellationRequested: false,
    termination: "not_applicable",
    errorCode: null, error: null });
  sessions.sendMessage = async (_sessionId: string, _companyId: string, options: { requestId: string; prompt: string }) => {
    const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    sends.push({ requestId: options.requestId, runId, prompt: options.prompt });
    coreRequests.set(options.requestId, { requestId: options.requestId, state: "submitted", runId });
    return { runId };
  };
  const run = validation.runs.get(reference.runId)!;
  run.status = "succeeded"; run.termination = "confirmed";
  run.receipt = { digest: "a".repeat(64), status: "completed", stdoutSha256: "b".repeat(64), stderrSha256: null,
    stdoutBytes: 1, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false,
    appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true,
    profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
  const folders = (fixture.platform as unknown as { localFolders: Record<string, (...args: string[]) => Promise<unknown>> }).localFolders;
  folders.matchWorkspaceSourceV1 = async (folderKey, sourceId) => ({ folderKey, workspaceSourceId: sourceId, match: "same_root" });
  const payload = { schemaVersion: 1, kind: "protected-node-test-v1", companyId: WORKSPACE,
    pluginId: "com.sonparkserver.my-plugin-builder", pluginKey: "com.sonparkserver.my-plugin-builder",
    runId: reference.runId, status: run.status, receiptDigest: run.receipt.digest,
    subjectKeySha256: reference.subjectKeySha256 };
  const terminalEventId = `sps-protected-test-terminal-v1:${reference.runId}:${run.receipt.digest}:${reference.subjectKeySha256}:job`;
  assert.ok(terminalEventId.length > 160);
  return { fixture, eventId: validation.eventId, payload, terminalEventId, sends, coreRequests, reference,
    setOriginalManagerStatus(status: "running" | "succeeded" | "failed" | "cancelled") { originalManagerStatus = status; } };
}

for (const phase of ["ci", "e2e", "regression"] as const) test(`current ${phase} terminal receipt resumes the exact Manager session once`, async () => {
  const f = await preparedTerminalFixture("succeeded", phase, phase === "regression");
  const job = { jobKey: WORKSTREAM_VERIFIED_JOB, runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", trigger: "event",
    eventId: f.terminalEventId, companyId: WORKSPACE, event: { eventType: "sps.protected-test.terminal", payload: f.payload } };
  const first = await consumeVerifiedWorkstreamJob(job, f.fixture.platform);
  assert.equal(first.status, "accepted", JSON.stringify(first));
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0]!.prompt.includes(f.reference.runId));
  assert.ok(f.sends[0]!.prompt.includes("never as QA PASS or final approval"));
  const replay = await consumeVerifiedWorkstreamJob(job, f.fixture.platform);
  assert.equal(replay.status, "accepted");
  assert.equal(f.sends.length, 1, "receipt/event replay must not create another Manager request");

  const readTool = createVerifiedWorkstreamManagerReadHandler();
  const result = await readTool({ workstreamId: "ws-1", eventId: f.eventId }, {
    companyId: WORKSPACE, agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runId: f.sends[0]!.runId,
  }, f.fixture.platform);
  assert.equal((result.data as { eventId: string }).eventId, f.eventId);
  await assert.rejects(readTool({ workstreamId: "ws-1", eventId: f.eventId }, {
    companyId: WORKSPACE, agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  }, f.fixture.platform), /exact Core request receipt/u);
});

test("changed current candidate tip or terminal subject pin blocks Manager continuation", async t => {
  await t.test("Source branch tip moved", async () => {
    const f = await preparedTerminalFixture();
    const folders = (f.fixture.platform as unknown as { localFolders: Record<string, (...args: string[]) => Promise<any>> }).localFolders;
    const prior = folders.readWorkspaceSourceGitTipV1;
    folders.readWorkspaceSourceGitTipV1 = async (...args) => {
      const tip = await prior!(...args);
      return { ...tip, commitSha: "9".repeat(40) };
    };
    const result = await consumeVerifiedWorkstreamJob({ jobKey: WORKSTREAM_VERIFIED_JOB,
      runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", trigger: "event", eventId: f.terminalEventId,
      companyId: WORKSPACE, event: { eventType: "sps.protected-test.terminal", payload: f.payload } }, f.fixture.platform);
    assert.equal(result.status, "stale");
    assert.equal(f.sends.length, 0);
  });
  await t.test("different subject digest", async () => {
    const f = await preparedTerminalFixture();
    const result = await consumeVerifiedWorkstreamJob({ jobKey: WORKSTREAM_VERIFIED_JOB,
      runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", trigger: "event", eventId: f.terminalEventId,
      companyId: WORKSPACE, event: { eventType: "sps.protected-test.terminal",
        payload: { ...f.payload, subjectKeySha256: "f".repeat(64) } } }, f.fixture.platform);
    assert.equal(result.status, "stale");
    assert.equal(f.sends.length, 0);
  });
  await t.test("Core succeeded status with a contradictory receipt is unknown", async () => {
    const f = await preparedTerminalFixture();
    const run = (await (f.fixture.platform as any).protectedTests.getRunV1(WORKSPACE, f.reference.runId, f.reference.subjectKeySha256)) as any;
    run.receipt.status = "failed";
    const result = await consumeVerifiedWorkstreamJob({ jobKey: WORKSTREAM_VERIFIED_JOB,
      runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", trigger: "event", eventId: f.terminalEventId,
      companyId: WORKSPACE, event: { eventType: "sps.protected-test.terminal", payload: f.payload } }, f.fixture.platform);
    assert.equal(result.status, "unknown");
    assert.equal(f.sends.length, 0);
  });
});

test("active Manager terminal race records waiting and queues only one bounded recheck", async () => {
  const f = await preparedTerminalFixture("running");
  const state = f.fixture.state as typeof f.fixture.state & { guardedCompareAndSetWithJobWakeV1?: (...args: any[]) => Promise<unknown> };
  const wakes: any[] = [];
  state.guardedCompareAndSetWithJobWakeV1 = async (address: any, expected: any, value: JsonValue, wake: unknown) => {
    const target = mapKey({ scopeKind: address.scopeKind, scopeId: address.scopeId, namespace: address.namespace, stateKey: address.stateKey });
    for (const guard of address.guards) {
      const guardKey = mapKey({ scopeKind: "company", scopeId: address.scopeId, namespace: guard.namespace, stateKey: guard.stateKey });
      if (JSON.stringify(f.fixture.values.get(guardKey)) !== JSON.stringify(guard.expectedValue)) return { status: "conflict" };
    }
    const old = f.fixture.values.get(target);
    if (expected.exists ? JSON.stringify(old) !== JSON.stringify(expected.value) : old !== undefined) return { status: "conflict" };
    f.fixture.values.set(target, structuredClone(value)); wakes.push(structuredClone(wake)); return { status: "committed" };
  };
  const job = { jobKey: WORKSTREAM_VERIFIED_JOB, runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", trigger: "event",
    eventId: f.terminalEventId, companyId: WORKSPACE, event: { eventType: "sps.protected-test.terminal", payload: f.payload } };
  const waiting = await consumeVerifiedWorkstreamJob(job, f.fixture.platform);
  if (waiting.status !== "waiting") throw new Error(JSON.stringify(waiting));
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].name, "sps.protected-test.continuation-recheck");
  assert.equal(Object.keys(wakes[0].payload).length, 10, JSON.stringify(wakes[0].payload));
  assert.equal(f.sends.length, 0);
  const again = await consumeVerifiedWorkstreamJob({ ...job, eventId: wakes[0].eventId,
    event: { eventType: wakes[0].name, payload: wakes[0].payload } }, f.fixture.platform);
  if (again.status !== "waiting") throw new Error(JSON.stringify(again));
  assert.equal(again.status, "waiting");
  assert.equal(wakes.length, 1, "active Manager must not cause an unbounded wake loop");
  assert.equal(f.sends.length, 0);
  f.setOriginalManagerStatus("succeeded");
  const row = f.fixture.values.get(mapKey(requestKey)) as { events: Array<{ requestId: string }> };
  const originalRequestId = managerRequestUuidForLedgerKey(row.events[0]!.requestId);
  const resumed = await consumeManagerSessionTerminalJob({ jobKey: "agent-session-terminal",
    runId: "99999999-9999-4999-8999-999999999999", trigger: "event", eventId: `agent-session-terminal-v1:${"a".repeat(64)}`,
    companyId: WORKSPACE, event: { eventType: "agent.session.run.terminal", payload: { schemaVersion: 1,
      runId: FIXTURE_MANAGER_RUN, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", requestId: originalRequestId,
      status: "succeeded", resultSha256: "c".repeat(64), finishedAt: "2026-11-07T01:00:00.000Z" } } }, f.fixture.platform);
  assert.equal(resumed.status, "accepted", JSON.stringify(resumed));
  assert.equal(f.sends.length, 1, "durable Manager terminal notification should resume the same session once");
  const replay = await consumeManagerSessionTerminalJob({ jobKey: MANAGER_SESSION_TERMINAL_JOB,
    runId: "99999999-9999-4999-8999-999999999999", trigger: "event", eventId: `agent-session-terminal-v1:${"a".repeat(64)}`,
    companyId: WORKSPACE, event: { eventType: "agent.session.run.terminal", payload: { schemaVersion: 1,
      runId: FIXTURE_MANAGER_RUN, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", requestId: originalRequestId,
      status: "succeeded", resultSha256: "c".repeat(64), finishedAt: "2026-11-07T01:00:00.000Z" } } }, f.fixture.platform);
  assert.equal(replay.status, "ignored", JSON.stringify(replay));
  assert.equal(f.sends.length, 1, "replayed terminal event must use the durable continuation receipt");
});

test("late Manager terminal notification waits for authoritative run state and preserves the continuation", async () => {
  const f = await preparedTerminalFixture("running");
  const protectedJob = { jobKey: WORKSTREAM_VERIFIED_JOB, runId: RUN, trigger: "event", eventId: f.terminalEventId,
    companyId: WORKSPACE, event: { eventType: "sps.protected-test.terminal", payload: f.payload } };
  assert.equal((await consumeVerifiedWorkstreamJob(protectedJob, f.fixture.platform)).status, "waiting");
  const row = f.fixture.values.get(mapKey(requestKey)) as { events: Array<{ requestId: string }> };
  const originalRequestId = managerRequestUuidForLedgerKey(row.events[0]!.requestId);
  const terminalJob = { jobKey: MANAGER_SESSION_TERMINAL_JOB, runId: RUN, trigger: "event",
    eventId: `agent-session-terminal-v1:${"b".repeat(64)}`, companyId: WORKSPACE,
    event: { eventType: "agent.session.run.terminal", payload: { schemaVersion: 1,
      runId: FIXTURE_MANAGER_RUN, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", requestId: originalRequestId,
      status: "succeeded", resultSha256: "e".repeat(64), finishedAt: "2026-11-07T01:00:00.000Z" } } };
  const sessions = f.fixture.platform.agents.sessions as any;
  const getRun = sessions.getRun;
  sessions.getRun = async (...args: any[]) => ({ ...await getRun(...args), status: "running" });
  const early = await consumeManagerSessionTerminalJob(terminalJob, f.fixture.platform);
  assert.equal(early.status, "unknown");
  assert.equal(f.sends.length, 0);
  sessions.getRun = getRun;
  f.setOriginalManagerStatus("succeeded");
  const late = await consumeManagerSessionTerminalJob(terminalJob, f.fixture.platform);
  assert.equal(late.status, "accepted", JSON.stringify(late));
  assert.equal(f.sends.length, 1);
});

for (const terminalStatus of ["failed", "cancelled"] as const) test(`current ${terminalStatus} Manager terminal closes waiting continuation without retry`, async () => {
  const f = await preparedTerminalFixture("running");
  const protectedJob = { jobKey: WORKSTREAM_VERIFIED_JOB, runId: RUN, trigger: "event", eventId: f.terminalEventId,
    companyId: WORKSPACE, event: { eventType: "sps.protected-test.terminal", payload: f.payload } };
  const waiting = await consumeVerifiedWorkstreamJob(protectedJob, f.fixture.platform);
  assert.equal(waiting.status, "waiting");
  const row = f.fixture.values.get(mapKey(requestKey)) as { events: Array<{ requestId: string; continuations: Array<Record<string, unknown>> }> };
  const originalRequestId = managerRequestUuidForLedgerKey(row.events[0]!.requestId);
  f.setOriginalManagerStatus(terminalStatus);
  const terminalJob = { jobKey: MANAGER_SESSION_TERMINAL_JOB, runId: RUN, trigger: "event",
    eventId: `agent-session-terminal-v1:${terminalStatus}`, companyId: WORKSPACE,
    event: { eventType: "agent.session.run.terminal", payload: { schemaVersion: 1,
      runId: FIXTURE_MANAGER_RUN, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", requestId: originalRequestId,
      status: terminalStatus, resultSha256: "d".repeat(64), finishedAt: "2026-11-07T01:00:00.000Z" } } };
  const closed = await consumeManagerSessionTerminalJob(terminalJob, f.fixture.platform);
  assert.equal(closed.status, "failed", JSON.stringify(closed));
  const after = f.fixture.values.get(mapKey(requestKey)) as { events: Array<{ continuations: Array<Record<string, unknown>> }> };
  assert.equal(after.events[0]!.continuations[0]!.status, "manager-failed");
  assert.equal(after.events[0]!.continuations[0]!.managerTerminalStatus, terminalStatus);
  assert.equal(f.sends.length, 0);
  const replay = await consumeManagerSessionTerminalJob(terminalJob, f.fixture.platform);
  assert.equal(replay.status, "ignored");
  assert.equal(f.sends.length, 0, "terminal failure must not create a replacement request");
});

test("registered terminal jobs route typed events and ignore unrelated events without state reads", async () => {
  let reads = 0;
  const platform = { state: { async get() { reads++; return null; } } } as unknown as SpsPlatformInvocationContext;
  const contract = createBuilderPlatform() as unknown as { jobs: Array<{ jobKey: string; handler(job: any, platform: any): Promise<unknown> }> };
  const registered = new Set(contract.jobs.map(job => job.jobKey));
  assert.ok(registered.has(WORKSTREAM_VERIFIED_JOB));
  assert.ok(registered.has(MANAGER_SESSION_TERMINAL_JOB));
  const manifestSource = await readFile(new URL("../src/manifest.mjs", import.meta.url), "utf8");
  assert.match(manifestSource, /jobKey: "agent-session-terminal"[^\n]+scope: "workspace"/u);
  for (const jobKey of [WORKSTREAM_VERIFIED_JOB, MANAGER_SESSION_TERMINAL_JOB]) {
    const job = contract.jobs.find(item => item.jobKey === jobKey)!;
    await job.handler({ jobKey, runId: RUN, trigger: "event", eventId: "unrelated",
      companyId: WORKSPACE, event: { eventType: "unrelated.event", payload: {} } }, platform);
  }
  assert.equal(reads, 0);
});

test("unrelated and legacy untyped events are filtered before verified-event reads", async () => {
  let reads = 0;
  const platform = { state: { async get() { reads++; return null; } } } as unknown as SpsPlatformInvocationContext;
  const base = { jobKey: WORKSTREAM_VERIFIED_JOB, runId: RUN, trigger: "event", companyId: WORKSPACE };
  const ignored = await consumeVerifiedWorkstreamJob({ ...base, eventId: "other-event",
    event: { eventType: "unrelated.event", payload: {} } }, platform);
  assert.equal(ignored.status, "ignored");
  const legacy = await consumeVerifiedWorkstreamJob({ ...base, eventId: "x".repeat(235) }, platform);
  assert.equal(legacy.status, "unsupported");
  assert.equal(reads, 0);
  const verified = await consumeVerifiedWorkstreamJob({ ...base, eventId: "x".repeat(235),
    event: { eventType: WORKSTREAM_VERIFIED_EVENT, payload: {} } }, platform);
  assert.equal(verified.reason, "verified-event-id-invalid");
  assert.equal(reads, 0);
});

test("unrelated typed Manager-terminal event is ignored before Workspace reads", async () => {
  let reads = 0;
  const platform = { state: { async get() { reads++; return null; } } } as unknown as SpsPlatformInvocationContext;
  const result = await consumeManagerSessionTerminalJob({ jobKey: "agent-session-terminal",
    runId: RUN, trigger: "event", eventId: "agent-session-terminal-v1:fixture", companyId: WORKSPACE,
    event: { eventType: "unrelated.event", payload: {} } }, platform);
  assert.equal(result.status, "ignored");
  assert.equal(reads, 0);
});
