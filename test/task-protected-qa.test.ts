import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deriveProtectedTaskQaRequestIdentity, enqueueBoundProtectedTaskQa, readBoundProtectedTaskQa,
  type ProtectedTaskQaTarget } from "../src/task-protected-qa.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { READ_PROTECTED_TASK_QA_TOOL, REQUEST_PROTECTED_TASK_QA_TOOL } from "../src/task-packet-tool-declarations.mjs";
import { CTO_SESSION_EXECUTION_POLICY, TASK_WORKER_SESSION_EXECUTION_POLICY } from "../src/session-execution-policy.ts";

const W = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const APPROVAL = "33333333-3333-4333-8333-333333333333";
const QA_AGENT = "44444444-4444-4444-8444-444444444444";
const QA_SESSION = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const PLAN = "c".repeat(64);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const subjectHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

test("registers the admission only for Task Worker sessions and exposes CTO/QA read-only observation", () => {
  const names = createBuilderPlatform().tools.map(tool => tool.name);
  assert.ok(names.includes(REQUEST_PROTECTED_TASK_QA_TOOL.name));
  assert.ok(names.includes(READ_PROTECTED_TASK_QA_TOOL.name));
  assert.ok(TASK_WORKER_SESSION_EXECUTION_POLICY.toolNames.includes(REQUEST_PROTECTED_TASK_QA_TOOL.name));
  assert.ok(!CTO_SESSION_EXECUTION_POLICY.toolNames.includes(REQUEST_PROTECTED_TASK_QA_TOOL.name));
  assert.ok(TASK_WORKER_SESSION_EXECUTION_POLICY.toolNames.includes(READ_PROTECTED_TASK_QA_TOOL.name));
  assert.ok(CTO_SESSION_EXECUTION_POLICY.toolNames.includes(READ_PROTECTED_TASK_QA_TOOL.name));
  assert.deepEqual((REQUEST_PROTECTED_TASK_QA_TOOL.parametersSchema as { required: string[] }).required, ["approvalId", "planSha256"]);
});

function identity(overrides: Record<string, unknown> = {}) {
  return deriveProtectedTaskQaRequestIdentity({ workspaceId: W, projectId: "project", ctoId: "cto-one",
    workstreamId: "ws-1", implementationTaskId: "impl", implementationRevision: 3, implementationDigest: "d".repeat(64),
    qaTaskId: "qa", qaRevision: 2, qaDigest: "e".repeat(64), qaAgentId: QA_AGENT, qaSessionId: QA_SESSION,
    sourceId: SOURCE, folderKey: "project-source", branch: "feature/task", commitSha: COMMIT, treeSha: TREE,
    acceptanceId: "f".repeat(64), submissionId: "9".repeat(64), ...overrides } as Parameters<typeof deriveProtectedTaskQaRequestIdentity>[0]);
}

function target(assertCurrent: () => Promise<void> = async () => {}): ProtectedTaskQaTarget {
  const keys = identity();
  return { workspaceId: W, projectId: "project", ctoId: "cto-one", workstreamId: "ws-1",
    implementation: {} as ProtectedTaskQaTarget["implementation"], implementationDigest: "d".repeat(64),
    qa: {} as ProtectedTaskQaTarget["qa"], qaDigest: "e".repeat(64),
    qaWorker: {} as ProtectedTaskQaTarget["qaWorker"], qaRequestId: "qa-request", qaRunId: RUN,
    source: { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task" }, commitSha: COMMIT,
    treeSha: TREE, acceptanceId: "f".repeat(64), submissionId: "9".repeat(64), ...keys,
    approvalId: APPROVAL, planSha256: PLAN, tipCurrent: true, allowTerminalQaRun: false, assertCurrent };
}

function coreRun(subjectKeySha256: string, overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, kind: "protected-node-test-v1", id: RUN, status: "queued", termination: "not_applicable",
    pins: { approvalId: APPROVAL, sourceId: SOURCE, planSha256: PLAN, profileSha256: "1".repeat(64), commitSha: COMMIT,
      treeSha: TREE, manifestSha256: "2".repeat(64), inputTreeSha256: "3".repeat(64), nodeSha256: "4".repeat(64),
      subjectKeySha256, timeoutMs: 30_000 }, receipt: null, timestamps: { createdAt: "2026-11-07T00:00:00Z",
      claimedAt: null, startedAt: null, finishedAt: null }, qaVerdict: "not-established", ...overrides };
}

test("derives stable request and subject keys from exact Task, Worker, acceptance, source, and approved plan pins", () => {
  const base = identity();
  assert.deepEqual(identity(), base);
  assert.match(base.requestId, /^builder-task-qa-v1:[a-f0-9]{64}$/u);
  assert.equal(base.subjectKeySha256, subjectHash(base.subjectKey));
  for (const change of [{ qaSessionId: "77777777-7777-4777-8777-777777777777" },
    { acceptanceId: "8".repeat(64) }, { commitSha: "5".repeat(40) }, { qaTaskId: "qa-v2" }]) {
    assert.notEqual(identity(change).requestId, base.requestId);
  }
});

test("retries only the same Core idempotency identity and never invents a second key", async () => {
  const bound = target(), sent: unknown[] = [];
  const enqueue = async (request: unknown) => { sent.push(request); return coreRun(bound.subjectKeySha256); };
  const first = await enqueueBoundProtectedTaskQa({ target: bound, enqueue });
  const retry = await enqueueBoundProtectedTaskQa({ target: bound, enqueue });
  assert.equal(first.status, "queued");
  assert.equal(retry.status, "queued");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal((sent[0] as { requestId: string }).requestId, bound.requestId);
  assert.equal(first.qaVerdict, "not-established");
});

test("stops before Core on target drift and preserves a received receipt when authority drifts afterward", async () => {
  const pre = target(async () => { throw new Error("dependency drift"); });
  let calls = 0;
  const stopped = await enqueueBoundProtectedTaskQa({ target: pre, enqueue: async () => { calls++; return null; } });
  assert.equal(stopped.status, "stale");
  assert.equal(calls, 0);

  let checks = 0;
  const post = target(async () => { if (++checks === 2) throw new Error("branch tip moved"); });
  const after = await enqueueBoundProtectedTaskQa({ target: post,
    enqueue: async () => coreRun(post.subjectKeySha256, { receipt: { status: "failed", processExitCode: 1 } }) });
  assert.equal(after.status, "stale");
  assert.deepEqual(after.receipt, { status: "failed", processExitCode: 1 });
  assert.equal(after.qaVerdict, "not-established");
});

test("an uncertain Core response stays unknown with the same derived identity and no hidden retry", async () => {
  const bound = target();
  let calls = 0;
  const result = await enqueueBoundProtectedTaskQa({ target: bound, enqueue: async request => {
    calls++;
    assert.equal((request as { requestId: string }).requestId, bound.requestId);
    throw new Error("response lost");
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, "unknown");
  assert.equal(result.requestId, bound.requestId);
  assert.equal(result.qaVerdict, "not-established");
});

test("reads only the exact deterministic Task subject and preserves revoked/cancelled technical closure", async () => {
  const bound = target();
  let observed: unknown[] = [];
  const result = await readBoundProtectedTaskQa({ target: bound, runId: RUN, getRun: async (...args) => {
    observed = args;
    return coreRun(bound.subjectKeySha256, { status: "cancelled", termination: "confirmed",
      receipt: { status: "cancelled", cancelled: true, childTerminationConfirmed: true } });
  } });
  assert.deepEqual(observed, [W, RUN, bound.subjectKeySha256]);
  assert.equal(result.technicalStatus, "cancelled");
  assert.equal(result.termination, "confirmed");
  assert.equal((result.receipt as { status: string }).status, "cancelled");
  assert.equal(result.qaVerdict, "not-established");
});

test("preserves a received Core receipt as stale if authority changes during read-only observation", async () => {
  let checks = 0;
  const bound = target(async () => { if (++checks === 2) throw new Error("Task revision changed"); });
  const result = await readBoundProtectedTaskQa({ target: bound, runId: RUN,
    getRun: async () => coreRun(bound.subjectKeySha256, { status: "succeeded", termination: "confirmed",
      receipt: { status: "completed", processExitCode: 0, childTerminationConfirmed: true } }) });
  assert.equal(result.status, "stale");
  assert.equal(result.technicalStatus, "succeeded");
  assert.deepEqual(result.receipt, { status: "completed", processExitCode: 0, childTerminationConfirmed: true });
  assert.equal(result.qaVerdict, "not-established");
});

test("marks a referenced run historical when the accepted commit is no longer the current branch tip", async () => {
  const bound = { ...target(), tipCurrent: false };
  const result = await readBoundProtectedTaskQa({ target: bound, runId: RUN,
    getRun: async () => coreRun(bound.subjectKeySha256, { status: "succeeded", termination: "confirmed" }) });
  assert.equal(result.status, "stale");
  assert.equal(result.sourceFreshness, "stale");
  assert.equal(result.technicalStatus, "succeeded");
  assert.equal(result.qaVerdict, "not-established");
});

test("rejects a Core receipt whose approved plan or Task subject pin differs", async () => {
  const bound = target();
  const mismatch = await enqueueBoundProtectedTaskQa({ target: bound,
    enqueue: async () => coreRun(bound.subjectKeySha256, { pins: { ...coreRun(bound.subjectKeySha256).pins, planSha256: "f".repeat(64) } }) });
  assert.equal(mismatch.status, "unknown");
  assert.equal(mismatch.requestId, bound.requestId);
});
