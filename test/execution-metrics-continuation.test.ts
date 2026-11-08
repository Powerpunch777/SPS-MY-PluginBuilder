import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readBuilderExecutionMetrics } from "../src/execution-metrics.ts";
import { createTaskQaRunReferenceStore, parseTaskQaRunReference } from "../src/task-qa-run-references.ts";
import { setupVerifiedWorkstreamPlatform } from "./fixtures/verified-workstream-platform.ts";
import { W, CTO, now } from "./fixtures/cto-platform.ts";

const QA_RUN = "88888888-8888-4888-8888-888888888888";
const CONTINUATION_RUN = "99999999-9999-4999-8999-999999999999";
const CONTINUATION_REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_NONCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const timing = { createdAt: "2026-11-07T00:00:00.000Z", startedAt: "2026-11-07T00:00:02.000Z",
  finishedAt: "2026-11-07T00:00:07.000Z" };

async function setupContinuation(options: Readonly<{ listAvailable?: boolean; sourceMoved?: boolean;
  receiptMismatch?: boolean; lastRunId?: string; invalidStatus?: boolean; referenceMismatch?: boolean }> = {}) {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const scope = { workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" };
  const store = createTaskQaRunReferenceStore(scope, f.state as never);
  const current = (await store.current())!.revision;
  const receiptDigest = "7".repeat(64);
  const eventId = `sps-protected-test-terminal-v1:${current.binding.runId}:${receiptDigest}:${current.binding.subjectKeySha256}:${EVENT_NONCE}`;
  const body = { schemaVersion: 1 as const, scope: current.scope, binding: current.binding,
    deferredEvent: { eventId, previousRunId: options.referenceMismatch ? "55555555-5555-4555-8555-555555555555" : QA_RUN, receiptDigest } };
  const revisionId = `task-qa-run-v1:${createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex")}`;
  const reference = parseTaskQaRunReference({ ...body, revisionId });
  const linked = await store.publish({ expectedBaseRevisionId: current.revisionId, revision: reference });
  assert.equal(linked.status, "published");

  const registryAddress = [...f.values.keys()].find(address => JSON.parse(address).stateKey?.startsWith("task-workers.v1."));
  assert.ok(registryAddress);
  const registry = f.values.get(registryAddress!) as unknown as { records: Array<Record<string, unknown>> };
  const qaWorker = registry.records.find(row => row.role === "qa")!;
  const session = f.platform.agents.sessions as typeof f.platform.agents.sessions & Record<string, any>;
  const originalGetRun = session.getRun.bind(session), originalGetRequest = session.getRequest.bind(session);
  session.getRequest = async (sessionId: string, workspaceId: string, requestId: string) => requestId === CONTINUATION_REQUEST
    ? { requestId, state: "submitted", runId: options.lastRunId ?? CONTINUATION_RUN }
    : originalGetRequest(sessionId, workspaceId, requestId);
  session.getRun = async (sessionId: string, workspaceId: string, runId: string) => {
    if (runId === CONTINUATION_RUN) {
      return { runId, status: options.invalidStatus ? "unexpected-status" : "succeeded", cancellationRequested: false,
        termination: "not_applicable", errorCode: null, error: null,
        timing, systemEvent: { schemaVersion: 1, kind: "protected-test-terminal-event", requestId: CONTINUATION_REQUEST,
          previousRunId: QA_RUN, eventId, protectedRunId: current.binding.runId,
          receiptDigest: options.receiptMismatch ? "f".repeat(64) : receiptDigest,
          subjectKeySha256: current.binding.subjectKeySha256 } };
    }
    return { ...await originalGetRun(sessionId, workspaceId, runId), status: "succeeded", cancellationRequested: false,
      termination: "not_applicable", timing };
  };
  if (options.listAvailable !== false) {
    session.list = async (agentId: string, workspaceId: string) => [{ sessionId: current.binding.qaSessionId,
      agentId, companyId: workspaceId, taskKey: `plugin:com.sonparkserver.my-plugin-builder:session:${qaWorker.pluginAgentKey}`,
      status: "active", closedAt: null, lastRunId: options.lastRunId ?? CONTINUATION_RUN }];
  } else (session as any).list = undefined;
  if (options.sourceMoved) {
    (f.platform as any).localFolders.readWorkspaceSourceGitTipV1 = async (sourceId: string, folderKey: string, branch: string) =>
      ({ status: "current", sourceId, folderKey, branch, commitSha: "f".repeat(40), treeSha: "e".repeat(40), observedAt: now });
  }
  return { f, eventId, receiptDigest, reference };
}

test("exact current QA Core lineage adds its own Run timing without replacing the original Run", async () => {
  const fixture = await setupContinuation();
  const result = await readBuilderExecutionMetrics(W, fixture.f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const qaRuns = result.runs.filter(run => run.role === "qa");
  assert.deepEqual(qaRuns.map(run => run.runId), [QA_RUN, CONTINUATION_RUN]);
  assert.equal(new Set(result.runs.filter(run => run.runId !== null).map(run => run.runId)).size, result.summary.observedRuns,
    "the original QA Run and continuation Run are each counted once");
  const continuation = qaRuns[1]!;
  assert.equal(continuation.requestId, CONTINUATION_REQUEST);
  assert.equal(continuation.runStatus, "succeeded");
  assert.equal(continuation.normalEnded, true);
  assert.equal(continuation.queueMs, 2000);
  assert.equal(continuation.executionMs, 5000);
  assert.equal(result.runs.find(run => run.role === "worker")?.taskId, "task-dev");
  assert.equal(result.completionAuthority, "not-established");
  assert.equal(result.unmeasured.taskCompletionMs, null);
});

test("unavailable or stale continuation lineage leaves its scope unmeasured and preserves other Task rows", async t => {
  for (const [name, options, expectedStatus, expectedReason] of [
    ["session registry API unavailable", { listAvailable: false }, "unsupported", "qa-continuation-session-registry-or-run-reader-unavailable"],
    ["stale deferred origin pin", { referenceMismatch: true }, "unknown", "qa-continuation-current-task-or-reference-mismatch"],
    ["Core receipt digest mismatch", { receiptMismatch: true }, "unknown", "qa-continuation-core-lineage-unavailable"],
    ["unrecognized Core Run status", { invalidStatus: true }, "unknown", "qa-continuation-run-status-invalid"],
    ["Source tip moved", { sourceMoved: true }, "unknown", "qa-continuation-source-changed"],
    ["lastRunId is still the original run", { lastRunId: QA_RUN }, "pending", "qa-continuation-run-not-yet-observed"],
  ] as const) await t.test(name, async () => {
    const fixture = await setupContinuation(options);
    const result = await readBuilderExecutionMetrics(W, fixture.f.platform);
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.ok(result.runs.some(run => run.role === "worker" && run.taskId === "task-dev"));
    assert.ok(result.runs.some(run => run.role === "qa" && run.runId === QA_RUN), "original QA Run remains present");
    const continuation = result.runs.find(run => run.role === "qa" && run.runId !== QA_RUN);
    assert.ok(continuation, "deferred continuation gets a separate observation row");
    assert.equal(continuation.runStatus, expectedStatus);
    assert.equal(continuation.reason, expectedReason);
    assert.equal(continuation.timing, null);
    assert.equal(continuation.queueMs, null);
    assert.equal(continuation.executionMs, null);
    assert.equal(continuation.normalEnded, false);
    assert.equal(result.completionAuthority, "not-established");
  });
});
