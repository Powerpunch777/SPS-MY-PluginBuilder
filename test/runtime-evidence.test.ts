import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeEvidenceAdapter } from "../src/builder-gates/runtime-evidence.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { C, P, R, S, W, ctx, fixture } from "./fixtures/cto-platform.ts";

const TASK_RUN = "88888888-8888-4888-8888-888888888888";
const scope = { workspaceId: W, projectId: P, workstreamId: "ws-1", taskId: "task-1" } as const;

// TEST_FIXTURE_ONLY: all state and run responses below are synthetic; no Host, customer data, or live auth is used.
async function prepared() {
  const f = await fixture();
  const packetStore = createTaskPacketStore(W, P, "cto-one", "ws-1", f.platform.state);
  const instructionSha256 = workstreamInstructionDigest(f.instruction);
  const board = {
    projectId: P,
    ctoId: "cto-one",
    workstreamId: "ws-1",
    revisionId: "task-board-1",
    packets: [{
      packet: { projectId: P, ctoId: "cto-one", workstreamId: "ws-1", taskId: "task-1", revision: 1,
        kind: "development", title: "Fixture task", goal: "Exercise read-only runtime observation.",
        scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies: [], included: ["Fixture scope"],
        excluded: ["Unrelated scope"], constraints: ["Do not infer test results."], acceptance: ["Reader remains fail-closed."],
        evidenceRequired: ["Independent report"], reuse: [], testPlan: null },
      source: { requestId: R, workstreamId: "ws-1", specRevision: 1, instructionSha256 },
      author: { agentId: "66666666-6666-4666-8666-666666666666", sessionId: C, runId: TASK_RUN },
      createdAtISO: "2026-11-06T00:00:00.000Z", dependencyPins: [],
    }],
  };
  await packetStore.publish({ expectedBaseRevisionId: null, revision: board });
  const calls: Array<{ sessionId: string; companyId: string; runId: string }> = [];
  const sessions = f.platform.agents.sessions;
  const originalGetRun = sessions.getRun.bind(sessions);
  sessions.getRun = async (sessionId, companyId, runId) => {
    calls.push({ sessionId, companyId, runId });
    return originalGetRun(sessionId, companyId, runId);
  };
  f.runs.set(TASK_RUN, { runId: TASK_RUN, status: "succeeded", cancellationRequested: false,
    termination: "not_applicable", error: null, errorCode: null, output: { state: "available", text: "synthetic QA PASS" } });
  const adapter = createRuntimeEvidenceAdapter({ ctoId: "cto-one", runContext: ctx(), platform: f.platform });
  return { f, calls, adapter };
}

test("observes only the exact current task-author run and never turns success into G4/G6 proof", async () => {
  const { calls, adapter } = await prepared();
  const read = await adapter.observe(scope);
  assert.equal(read.status, "observed");
  if (read.status !== "observed") return;
  assert.equal(read.task.taskId, scope.taskId);
  assert.equal(read.task.boardRevisionId, "task-board-1");
  assert.equal(read.taskAuthorRun.runId, TASK_RUN);
  assert.equal(read.taskAuthorRun.status, "succeeded");
  assert.equal(read.taskAuthorRun.outputState, "available");
  assert.equal("text" in read.taskAuthorRun, false);
  assert.equal(read.artifactEvidence.status, "unavailable");
  assert.equal(read.independentQa.status, "not-established");
  assert.equal(read.gateProof.status, "unknown");
  assert.deepEqual(calls, [{ sessionId: C, companyId: W, runId: TASK_RUN }]);
  assert.equal((await adapter.runtimeProof(scope)).status, "unknown");
});

test("a non-Main Lead session and a mismatched Workspace scope cannot read run state", async () => {
  const { f, calls } = await prepared();
  const current = f.values.get(JSON.stringify({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.1" })) as {
    workspaceId: string; selectionRevision: number; agentId: string; sessions: Record<string, string | null>;
  };
  f.values.set(JSON.stringify({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.1" }),
    { ...current, sessions: { ...current.sessions, "ui-design": "99999999-9999-4999-8999-999999999999" } });
  const nonMain = createRuntimeEvidenceAdapter({ ctoId: "cto-one",
    runContext: { ...ctx(), sessionId: "99999999-9999-4999-8999-999999999999" }, platform: f.platform });
  assert.equal((await nonMain.observe(scope)).status, "unknown");
  assert.equal((await nonMain.runtimeProof(scope)).status, "unknown");

  const main = createRuntimeEvidenceAdapter({ ctoId: "cto-one", runContext: ctx(), platform: f.platform });
  assert.equal((await main.observe({ ...scope, workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).status, "unknown");
  assert.equal(calls.length, 0);
});

test("changed current Workstream source invalidates the old Task Packet before getRun", async () => {
  const { f, calls, adapter } = await prepared();
  const store = createWorkstreamStore(W, P, f.platform.state);
  const head = (await store.current())!.revision;
  const record = head.workstreams[0]!;
  await store.publish({ expectedBaseRevisionId: head.revisionId, revision: { ...head, revisionId: "workstreams-2",
    workstreams: [{ ...record, spec: { ...record.spec, revision: 2 },
      change: { ...record.change, previousRevision: 1 } }] } });
  const read = await adapter.observe(scope);
  assert.equal(read.status, "unknown");
  if (read.status === "unknown") assert.equal(read.reason, "task-packet-workstream-source-is-not-current");
  assert.equal(calls.length, 0);
  assert.equal((await adapter.runtimeProof(scope)).status, "unknown");
});

test("a mismatched returned run identity and task author output do not create success evidence", async () => {
  const { f, adapter } = await prepared();
  const sessions = f.platform.agents.sessions;
  const original = sessions.getRun.bind(sessions);
  sessions.getRun = async () => ({ runId: R, status: "succeeded", cancellationRequested: false,
    termination: "not_applicable", error: null, errorCode: null, output: { state: "available", text: "PASS" } });
  const mismatched = await adapter.observe(scope);
  assert.equal(mismatched.status, "unknown");
  assert.equal((await adapter.runtimeProof(scope)).status, "unknown");
  sessions.getRun = original;
  const observed = await adapter.observe(scope);
  assert.equal(observed.status, "observed");
  if (observed.status === "observed") {
    assert.deepEqual(observed.taskAuthorRun, { runId: TASK_RUN, status: "succeeded",
      termination: "not_applicable", outputState: "available" });
    assert.equal(observed.gateProof.status, "unknown");
  }
});
