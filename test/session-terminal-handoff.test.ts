import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createBuilderPlatform } from "../src/platform.ts";
import { MANAGER_SESSION_TERMINAL_JOB } from "../src/builder-gates/integration-manager-job.ts";
import { fixture, A, W, key, mapKey, now } from "./fixtures/cto-platform.ts";

const MAIN_SESSION = "33333333-3333-4333-8333-333333333333";
const MAIN_RUN = "55555555-5555-4555-8555-555555555555";
const JOB_RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST = "66666666-6666-4666-8666-666666666666";
const eventId = `agent-session-terminal-v1:${"a".repeat(64)}`;

async function terminalFixture(status: "succeeded" | "failed" | "cancelled") {
  const f = await fixture(W);
  (f.platform.state as unknown as { set(key: Parameters<typeof mapKey>[0], value: JsonValue): Promise<void> }).set = async (address, value) => {
    f.values.set(mapKey(address), structuredClone(value));
  };
  const sessionsKey = key("lead-sessions.v1.1");
  f.values.set(mapKey(sessionsKey), { workspaceId: W, selectionRevision: 1, agentId: A, sessions: {
    main: MAIN_SESSION, "ui-design": null, background: null, decisions: null, "cto-inbox": null,
    "integration-review": "77777777-7777-4777-8777-777777777777",
  } });
  const scope = { workspaceId: W, selectionRevision: 1, agentId: A, sessionId: MAIN_SESSION, channel: "main" };
  f.values.set(mapKey(key(`lead-chat.turn.v1.${REQUEST}`)), { ...scope, schemaVersion: 1, requestId: REQUEST,
    previousRequestId: null, sequence: 0, text: "fixture turn", createdAt: now, state: "submitted", runId: MAIN_RUN,
    answer: null, outputState: "not_ready", cancellationRequested: false, termination: "not_applicable", inputKind: "user" });
  f.values.set(mapKey(key("lead-chat.index.v1.1.main.0")), { requestId: REQUEST });
  f.values.set(mapKey(key("lead-chat.head.v1.1.main")), { ...scope, schemaVersion: 1, totalTurns: 1,
    lastRequestId: REQUEST, activeRequestId: REQUEST });
  const sessionApi = f.platform.agents.sessions as typeof f.platform.agents.sessions & Record<string, any>;
  sessionApi.getRequest = async (_sessionId: string, _companyId: string, requestId: string) =>
    requestId === REQUEST ? { requestId: REQUEST, state: "submitted", runId: MAIN_RUN } : null;
  sessionApi.getRun = async (_sessionId: string, _companyId: string, runId: string) => ({ runId,
    status, cancellationRequested: status === "cancelled", termination: status === "cancelled" ? "confirmed" : "not_applicable",
    errorCode: status === "succeeded" ? null : "fixture-terminal", error: null,
    output: { state: "withheld", text: null, reason: "not_successful" } });
  return { f, sessionApi };
}

function terminalJob(status: "succeeded" | "failed" | "cancelled") {
  return { jobKey: MANAGER_SESSION_TERMINAL_JOB, trigger: "event", companyId: W, runId: JOB_RUN, eventId,
    event: { eventType: "agent.session.run.terminal", payload: { schemaVersion: 1, runId: MAIN_RUN,
      sessionId: MAIN_SESSION, requestId: REQUEST, status, resultSha256: "b".repeat(64), finishedAt: now } } };
}

test("failed/cancelled Main terminal receipts update the exact turn and never wake a replacement turn", async t => {
  for (const status of ["failed", "cancelled"] as const) await t.test(status, async () => {
    const f = await terminalFixture(status);
    const job = createBuilderPlatform().jobs.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB)!;
    await job.handler(terminalJob(status) as never, f.f.platform);
    const stored = f.f.values.get(mapKey(key(`lead-chat.turn.v1.${REQUEST}`))) as { state: string; runId: string };
    const head = f.f.values.get(mapKey(key("lead-chat.head.v1.1.main"))) as { activeRequestId: string | null };
    assert.equal(stored.state, status);
    assert.equal(stored.runId, MAIN_RUN);
    assert.equal(head.activeRequestId, null);
    assert.equal(f.f.sends, 0);
  });
});

test("successful unrelated Main DONE is not a generic wake; duplicate terminal delivery has no extra effect", async () => {
  const f = await terminalFixture("succeeded");
  const job = createBuilderPlatform().jobs.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB)!;
  await job.handler(terminalJob("succeeded") as never, f.f.platform);
  const snapshot = structuredClone([...f.f.values.entries()]);
  const restartedWorkerJob = createBuilderPlatform().jobs.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB)!;
  await restartedWorkerJob.handler(terminalJob("succeeded") as never, f.f.platform);
  assert.deepEqual([...f.f.values.entries()], snapshot);
  assert.equal(f.f.sends, 0);
});

test("late terminal event cannot override a still-running authoritative Main Run", async () => {
  const f = await terminalFixture("succeeded");
  f.sessionApi.getRun = async (_sessionId: string, _companyId: string, runId: string) => ({ runId,
    status: "running", cancellationRequested: false, termination: "not_applicable", errorCode: null, error: null,
    output: { state: "not_ready", text: null } });
  const job = createBuilderPlatform().jobs.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB)!;
  await assert.rejects(async () => { await job.handler(terminalJob("succeeded") as never, f.f.platform); },
    /handoff unresolved/u);
  const turn = f.f.values.get(mapKey(key(`lead-chat.turn.v1.${REQUEST}`))) as { state: string };
  assert.equal(turn.state, "submitted");
  assert.equal(f.f.sends, 0);
});

test("revoked Lead session terminal event cannot mutate the current conversation", async () => {
  const f = await terminalFixture("succeeded");
  f.f.values.set(mapKey(key("lead-agent.v1")), { workspaceId: W, revision: 2, selectedAgentId: A } as JsonValue);
  f.f.values.set(mapKey(key("lead-sessions.v1.2")), { workspaceId: W, selectionRevision: 2, agentId: A,
    sessions: { main: null, "ui-design": null, background: null, decisions: null, "cto-inbox": null,
      "integration-review": null } } as JsonValue);
  const job = createBuilderPlatform().jobs.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB)!;
  await assert.rejects(async () => { await job.handler(terminalJob("succeeded") as never, f.f.platform); });
  const turn = f.f.values.get(mapKey(key(`lead-chat.turn.v1.${REQUEST}`))) as { state: string };
  assert.equal(turn.state, "submitted");
  assert.equal(f.f.sends, 0);
});

test("D3 registered data route is Workspace-scoped and returns empty without a selected pack", async () => {
  const contract = createBuilderPlatform() as unknown as { data: Array<{ key: string;
    handler(params: Record<string, unknown>, platform: SpsPlatformInvocationContext): Promise<unknown> }> };
  const route = contract.data.find(item => item.key === "builder.current-baseline-spec-assurance-pack");
  assert.ok(route);
  const empty = await route.handler({ companyId: W }, {} as SpsPlatformInvocationContext);
  assert.deepEqual(empty, { status: "empty", workspaceId: W, projectId: W, packId: null });
  await assert.rejects(route.handler({ companyId: W, projectId: "foreign-project", packId: "pack-1" },
    {} as SpsPlatformInvocationContext), /Workspace project/u);
  assert.ok(createBuilderPlatform().actions.some(item => item.key === "builder.confirm-current-baseline-spec-assurance-pack"));
});
