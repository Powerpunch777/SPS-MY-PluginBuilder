import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readProtectedTaskQaHistory } from "../src/task-protected-qa-history.ts";
import { recordTaskQaRunReference } from "../src/task-qa-run-references.ts";
import { createTaskQaRunReferenceStore } from "../src/task-qa-run-references.ts";
import { createTaskQaReportStore, taskQaCriteria } from "../src/task-qa-reports.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { fixture, W, P, CTO, A, C, ctx, now } from "./fixtures/cto-platform.ts";

const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
async function setup() {
  const f = await fixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const runId = [...f.runs.keys()][0]!;
  const runContext = ctx(C, runId);
  const current = (await f.deliveryStore().current())!.revision;
  const source = { requestId: current.requestId, workstreamId: "ws-1", specRevision: 1,
    instructionSha256: workstreamInstructionDigest(f.instruction) };
  const packet = (taskId: string, kind: "development" | "qa") => ({ projectId: P, ctoId: CTO, workstreamId: "ws-1",
    taskId, revision: 1, kind, title: taskId, goal: "Assigned scope", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"],
    dependencies: kind === "qa" ? ["dev-1"] : [], included: ["Assigned paths"], excluded: [], constraints: [],
    acceptance: ["Acceptance checked"], evidenceRequired: ["Exact evidence"], reuse: [], testPlan: kind === "qa"
      ? { environment: "fixture", steps: ["Check"], expectedResults: ["Pass"], passCriteria: ["Pass"] } : null });
  const implementation = { packet: packet("dev-1", "development"), source,
    author: { agentId: A, sessionId: C, runId }, createdAtISO: now, dependencyPins: [] };
  const implementationDigest = taskPacketRecordDigest(implementation, P, CTO, "ws-1");
  const qa = { packet: packet("qa-1", "qa"), source, author: { agentId: A, sessionId: C, runId }, createdAtISO: now,
    dependencyPins: [{ taskId: "dev-1", revision: 1, recordSha256: implementationDigest }] };
  const taskStore = createTaskPacketStore(W, P, CTO, "ws-1", f.state);
  await taskStore.publish({ expectedBaseRevisionId: null, revision: { projectId: P, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "tasks-1", packets: [implementation, qa] } });
  const subjectKey = "builder-task-qa-v1:" + "1".repeat(64);
  const subjectKeySha256 = createHash("sha256").update(subjectKey, "utf8").digest("hex");
  const target = { workspaceId: W, projectId: P, ctoId: CTO, workstreamId: "ws-1", implementation, implementationDigest,
    qa, qaDigest: taskPacketRecordDigest(qa, P, CTO, "ws-1"), qaWorker: {
      agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
    source: { sourceId: SOURCE, folderKey: "workspace", branch: "task/one" }, commitSha: "2".repeat(40), treeSha: "3".repeat(40),
    acceptanceId: "4".repeat(64), submissionId: "5".repeat(64), approvalId: PLAN, planSha256: "6".repeat(64),
    requestId: subjectKey, subjectKey, subjectKeySha256, async assertCurrent() {} };
  await recordTaskQaRunReference(f.state, target, RUN);
  const coreReceipt = { schemaVersion: 1, kind: "protected-node-test-v1", id: RUN, status: "succeeded", termination: "confirmed",
    pins: { approvalId: PLAN, sourceId: SOURCE, planSha256: target.planSha256, profileSha256: "7".repeat(64),
      commitSha: target.commitSha, treeSha: target.treeSha, manifestSha256: "8".repeat(64), inputTreeSha256: "9".repeat(64),
      nodeSha256: "a".repeat(64), subjectKeySha256, timeoutMs: 120000 }, timestamps: {}, qaVerdict: "not-established",
    receipt: { digest: "b".repeat(64), status: "completed", stdoutSha256: null, stderrSha256: null, stdoutBytes: 0, stderrBytes: 0,
      processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false, appContainerVerified: true, capabilitiesCount: 0,
      childTerminationConfirmed: true, jobEmpty: true, profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false } };
  let coreCalls = 0;
  Object.assign(f.platform, { protectedTests: { async getRunV1(companyId: string, runId: string, hash: string) {
    coreCalls++; assert.equal(companyId, W); assert.equal(runId, RUN); assert.equal(hash, subjectKeySha256);
    return structuredClone(coreReceipt);
  } }, localFolders: { async readWorkspaceSourceGitTipV1() { return { status: "current", sourceId: SOURCE, folderKey: "workspace",
    branch: "task/one", commitSha: target.commitSha, treeSha: target.treeSha, observedAt: now }; } } });
  const params = { projectId: P, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "qa-1" };
  const read = () => readProtectedTaskQaHistory(params, runContext, f.platform);
  return { f, target, taskStore, coreReceipt, read, runContext, params, get coreCalls() { return coreCalls; } };
}

test("history reads a completed technical run without waking its original QA session or granting a QA pass", async () => {
  const f = await setup();
  const sends = f.f.sends;
  const page = await f.read();
  assert.equal(page.entries[0]?.freshness, "current");
  assert.equal(page.entries[0]?.core.status, "available");
  assert.equal(page.entries[0]?.qaVerdict, "not-established");
  assert.equal(page.executionStarted, false);
  assert.equal(f.f.sends, sends);
  assert.equal(f.coreCalls, 1);
});

test("history preserves the prior Core receipt when the QA packet changes", async () => {
  const f = await setup();
  const board = (await f.taskStore.current())!.revision;
  await f.taskStore.publish({ expectedBaseRevisionId: board.revisionId, revision: { ...board, revisionId: "tasks-2",
    packets: board.packets.map(row => row.packet.taskId === "qa-1" ? { ...row, packet: { ...row.packet, revision: 2 } } : row) } });
  const page = await f.read();
  assert.equal(page.entries[0]?.freshness, "stale");
  assert.equal(page.entries[0]?.core.status, "available");
  assert.equal(page.entries[0]?.reference.binding.qaRevision, 1);
});

test("revoked Git access does not erase historical Core evidence or turn unknown freshness into current", async () => {
  const f = await setup();
  Object.assign(f.f.platform, { localFolders: { async readWorkspaceSourceGitTipV1() { throw new Error("Git grant revoked"); } } });
  const page = await f.read();
  assert.equal(page.entries[0]?.freshness, "unknown");
  assert.equal(page.entries[0]?.core.status, "available");
});

test("permission errors and mismatched Core pins remain unavailable and never become QA PASS", async () => {
  const f = await setup();
  f.coreReceipt.pins.treeSha = "f".repeat(40);
  let page = await f.read();
  assert.equal(page.entries[0]?.core.status, "unavailable");
  Object.assign(f.f.platform, { protectedTests: { async getRunV1() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); } } });
  page = await f.read();
  assert.equal(page.entries[0]?.core.status, "unavailable");
  assert.equal(JSON.stringify(page).includes("PRIVATE_PATH_MUST_NOT_LEAK"), false);
  assert.equal(page.qaVerdict, "not-established");
});

test("wrong CTO context and malformed cursors are denied before reading a Core run", async () => {
  const f = await setup();
  await assert.rejects(readProtectedTaskQaHistory(f.params, ctx(), f.f.platform));
  await assert.rejects(readProtectedTaskQaHistory({ ...f.params, cursor: 3 }, f.runContext, f.f.platform), /cursor/);
  assert.equal(f.coreCalls, 0);
});

test("authored QA verdict, its Core receipt match and the author turn are separate historical facts", async () => {
  const f = await setup();
  const scope = { workspaceId: W, projectId: P, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "qa-1" };
  const found = await createTaskQaRunReferenceStore(scope, f.f.state).findRun(RUN);
  if (found.status !== "found") throw new Error("fixture reference missing");
  const authorRunId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const content = { schemaVersion: 1, reference: found.reference, coreReceiptDigest: f.coreReceipt.receipt.digest,
    coreStatus: "succeeded", author: { agentId: f.target.qaWorker.agentId, sessionId: f.target.qaWorker.sessionId, runId: authorRunId },
    checks: taskQaCriteria(["Assigned QA acceptance"], ["All checks pass"]).map(criterion => ({ ...criterion,
      verdict: "passed", note: "Fixture criterion assessment." })), summary: "Fixture report only.", verdict: "passed" };
  const revisionId = "task-qa-report-v1:" + createHash("sha256").update(JSON.stringify(content), "utf8").digest("hex");
  await createTaskQaReportStore(scope, f.f.state).publish({ expectedBaseRevisionId: null, revision: { ...content, revisionId } });
  const getRun = f.f.platform.agents.sessions.getRun;
  let authorStatus = "running";
  Object.assign(f.f.platform.agents.sessions, { async getRun(sessionId: string, companyId: string, runId: string) {
    if (sessionId === f.target.qaWorker.sessionId && runId === authorRunId) return { runId, status: authorStatus,
      cancellationRequested: false, termination: "not_applicable", errorCode: null, error: null };
    return getRun(sessionId, companyId, runId);
  } });
  let page = await f.read();
  assert.deepEqual(page.entries[0]?.qaReports[0], { revisionId, authoredVerdict: "passed", coreReceiptMatches: true,
    authorRun: "running", checkedCriteria: 2, failedCriteria: 0, untestedCriteria: 0 });
  assert.equal(page.qaVerdict, "not-established");
  authorStatus = "succeeded";
  page = await f.read();
  assert.equal(page.entries[0]?.qaReports[0]?.authorRun, "succeeded");
  assert.equal(page.qaVerdict, "not-established", "neither a finished model turn nor a report publishes CTO VERIFIED");
});
