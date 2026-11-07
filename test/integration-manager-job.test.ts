import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createVerifiedWorkstreamManagerReadHandler, consumeVerifiedWorkstreamJob,
  INTEGRATION_MANAGER_VERIFIED_READ_TOOL, managerRequestUuidForLedgerKey,
  resolveCurrentIntegrationManagerAuthority, type VerifiedEventLookup } from "../src/builder-gates/integration-manager-job.ts";
import { consumeVerifiedWorkstream, type ManagerDispatchPort, type VerifiedSnapshotRead,
  type VerifiedWorkstreamSnapshot } from "../src/builder-gates/workstream-verification-consumer.ts";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey,
  integrationManagerStateKey } from "../src/domain/integration-manager.ts";
import { WORKSTREAM_VERIFIED_JOB } from "../src/builder-gates/workstream-verification-publication.ts";

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

function managerHost(options: { selectedAgentId?: string; profileStatus?: string; sessionStatus?: string } = {}) {
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
      async list() { return [{ id: MANAGER, companyId: WORKSPACE, status: options.profileStatus ?? "idle" }]; },
      sessions: {
        async list() { return [{ observationVersion: 1, sessionId: SESSION, agentId: MANAGER, companyId: WORKSPACE,
          status: options.sessionStatus ?? "active", taskKey, closedAt: null, contextState: "valid", managedAgentOwnership: "owned" }]; },
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
  await assert.rejects(resolveCurrentIntegrationManagerAuthority(WORKSPACE, mismatch.host), /manager-profile-not-current-and-active/u);
  const inactive = managerHost({ sessionStatus: "inactive" });
  await assert.rejects(resolveCurrentIntegrationManagerAuthority(WORKSPACE, inactive.host), /manager-session-not-current-owned-independent/u);
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
