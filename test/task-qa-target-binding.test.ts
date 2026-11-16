import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { taskPacketRecordDigest, parseTaskPacketRecord } from "../src/domain/task-packets.ts";
import { bindAcceptedCommitToQaTask } from "../src/task-qa-target-binding.ts";

const W = "11111111-1111-4111-8111-111111111111";
const P = "project-one";
const CTO = "cto-one";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
const WORKER_SESSION = "44444444-4444-4444-8444-444444444444";
const QA = "55555555-5555-4555-8555-555555555555";
const QA_SESSION = "66666666-6666-4666-8666-666666666666";
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const HEAD = "c".repeat(40);
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const requestId = "77777777-7777-4777-8777-777777777777";
const author = { agentId: "88888888-8888-4888-8888-888888888888", sessionId: "99999999-9999-4999-8999-999999999999",
  runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

function setup() {
  const sourceAccess = { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task", expectedHead: HEAD,
    readPaths: ["src/impl.ts", "test/impl.test.ts"], writePaths: ["src/impl.ts"], qaWritePaths: [] as string[] };
  const implementation = parseTaskPacketRecord({ packet: { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "impl",
    revision: 4, kind: "development", title: "Implementation", goal: "Implement source", scopeNodeIds: ["feature"],
    requirementIds: ["REQ-1"], dependencies: [], included: ["implementation"], excluded: [], constraints: [], acceptance: ["Works"],
    evidenceRequired: ["Commit receipt"], reuse: [], testPlan: null, sourceAccess },
    source: { requestId, workstreamId: "ws-1", specRevision: 2, instructionSha256: "d".repeat(64) }, author,
    createdAtISO: "2026-11-07T00:00:00.000Z", dependencyPins: [] }, P, CTO, "ws-1");
  const implDigest = taskPacketRecordDigest(implementation, P, CTO, "ws-1");
  const qaPacket = parseTaskPacketRecord({ packet: { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "qa",
    revision: 2, kind: "qa", title: "QA", goal: "Test exact accepted source", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"],
    dependencies: ["impl"], included: ["Independent QA checks"], excluded: ["src/impl.ts"], constraints: [], acceptance: ["Checks pass"],
    evidenceRequired: ["Protected receipt"], reuse: [], testPlan: { environment: "protected Node", steps: ["Test"],
      expectedResults: ["Exact source checked"], passCriteria: ["Criteria checked"] },
    sourceAccess: { ...sourceAccess, writePaths: [], qaWritePaths: ["test/impl.test.ts"] } },
    source: implementation.source, author, createdAtISO: "2026-11-07T00:01:00.000Z",
    dependencyPins: [{ taskId: "impl", revision: 4, recordSha256: implDigest }] }, P, CTO, "ws-1");
  const qaDigest = taskPacketRecordDigest(qaPacket, P, CTO, "ws-1");
  const acceptance = { schemaVersion: 1, acceptanceId: "", submissionId: "e".repeat(64), workspaceId: W, projectId: P,
    ctoId: CTO, workstreamId: "ws-1", taskId: "impl", packetRevision: 4, packetRecordSha256: implDigest,
    dependencyPins: [], source: { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task", expectedHead: HEAD },
    commitSha: COMMIT, treeSha: TREE, changedPaths: ["src/impl.ts"], receivedBy: { agentId: author.agentId,
      sessionId: author.sessionId, runId: author.runId }, receivedAt: "2026-11-07T00:02:00.000Z",
    meaning: "cto-received-exact-submitted-commit" as const };
  acceptance.acceptanceId = sha256(["builder-task-source-acceptance-v1", acceptance.submissionId]);
  const roleKey = `builder-task-qa:${sha256([P, "ws-1", "qa", "qa"])}`;
  const worker = { workstreamId: "ws-1", taskId: "qa", packetRevision: 2, packetRecordSha256: qaDigest, role: "qa",
    agentId: QA, sessionId: QA_SESSION, pluginAgentKey: roleKey,
    source: { requestId, specRevision: 2, instructionSha256: "d".repeat(64) }, registeredAtISO: "2026-11-07T00:03:00.000Z" };
  const workerRegistry = { schemaVersion: 1, workspaceId: W, projectId: P, ctoId: CTO, revision: 1, records: [worker] };
  const base = { acceptance, implementationPacket: implementation, qaPacket, currentPackets: [implementation, qaPacket], workerRegistry };
  return { acceptance, implementation, qaPacket, workerRegistry, base,
    root: { sourceId: SOURCE, folderKey: "project-source", match: "same_root" },
    tip: { sourceId: SOURCE, branch: "feature/task", commitSha: COMMIT, treeSha: TREE },
    protectedReceipt: { schemaVersion: 1, kind: "protected-node-test-v1", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "succeeded", termination: "confirmed", pins: { approvalId: "plan-approval", sourceId: SOURCE,
        planSha256: "1".repeat(64), profileSha256: "2".repeat(64), commitSha: COMMIT, treeSha: TREE,
        manifestSha256: "3".repeat(64), inputTreeSha256: "4".repeat(64), nodeSha256: "5".repeat(64),
        subjectKeySha256: "6".repeat(64), timeoutMs: 30_000 }, qaVerdict: "not-established" } };
}

test("binds accepted exact commit and tree to the current QA Task's exact implementation dependency", () => {
  const f = setup();
  const result = bindAcceptedCommitToQaTask({ ...f.base, currentSourceRoot: f.root, currentBranchTip: f.tip, protectedReceipt: null });
  assert.equal(result.status, "unsupported");
  assert.equal(result.reason, "exact-protected-qa-receipt-unavailable");
  assert.deepEqual(result.target, { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task", commitSha: COMMIT,
    treeSha: TREE, implementationTaskId: "impl", implementationPacketRevision: 4,
    implementationPacketRecordSha256: taskPacketRecordDigest(f.implementation, P, CTO, "ws-1"), qaTaskId: "qa",
    qaPacketRevision: 2, qaPacketRecordSha256: taskPacketRecordDigest(f.qaPacket, P, CTO, "ws-1"),
    qaWorkerAgentId: QA, qaWorkerSessionId: QA_SESSION });
  assert.equal(result.scheduleAllowed, false);
  assert.equal(result.qaExecution, "not-started");
  assert.equal(result.qaVerdict, "not-established");
});

test("does not schedule when exact root, current tip, or protected receipt is unavailable", () => {
  const f = setup();
  const absentRoot = bindAcceptedCommitToQaTask({ ...f.base, currentSourceRoot: null, currentBranchTip: f.tip,
    protectedReceipt: f.protectedReceipt });
  assert.equal(absentRoot.status, "unsupported");
  assert.equal(absentRoot.scheduleAllowed, false);
  const absentTip = bindAcceptedCommitToQaTask({ ...f.base, currentSourceRoot: f.root, currentBranchTip: null,
    protectedReceipt: f.protectedReceipt });
  assert.equal(absentTip.reason, "current-branch-tip-proof-unavailable");
  assert.equal(absentTip.scheduleAllowed, false);
  const absentReceipt = bindAcceptedCommitToQaTask({ ...f.base, currentSourceRoot: f.root, currentBranchTip: f.tip, protectedReceipt: null });
  assert.equal(absentReceipt.reason, "exact-protected-qa-receipt-unavailable");
  assert.equal(absentReceipt.scheduleAllowed, false);
});

test("rejects changed branch tip, different SourceRoot, or mismatched QA dependency", () => {
  const f = setup();
  const changedTip = bindAcceptedCommitToQaTask({ ...f.base, currentSourceRoot: f.root,
    currentBranchTip: { ...f.tip, commitSha: "f".repeat(40) }, protectedReceipt: f.protectedReceipt });
  assert.equal(changedTip.reason, "accepted-commit-is-not-the-current-branch-tip");
  assert.equal(changedTip.scheduleAllowed, false);
  const changedRoot = bindAcceptedCommitToQaTask({ ...f.base, currentSourceRoot: { ...f.root, match: "different_root" },
    currentBranchTip: f.tip, protectedReceipt: f.protectedReceipt });
  assert.equal(changedRoot.reason, "current-source-root-does-not-match-accepted-source");

  const changedQa = structuredClone(f.qaPacket);
  const changedDependency = { ...changedQa, dependencyPins: [{ taskId: "impl", revision: 3, recordSha256: "9".repeat(64) }] };
  const drift = bindAcceptedCommitToQaTask({ ...f.base, qaPacket: changedDependency, currentPackets: [f.implementation, changedDependency],
    currentSourceRoot: f.root, currentBranchTip: f.tip, protectedReceipt: f.protectedReceipt });
  assert.equal(drift.reason, "qa-dependency-or-accepted-dependency-pins-drifted");
});

test("never treats an unlinked protected Node receipt as this QA Task's authoritative run", () => {
  const f = setup();
  const result = bindAcceptedCommitToQaTask({ ...f.base, currentSourceRoot: f.root, currentBranchTip: f.tip,
    protectedReceipt: f.protectedReceipt });
  assert.equal(result.status, "unsupported");
  assert.equal(result.reason, "protected-run-subject-is-not-authoritatively-bound-to-this-qa-task");
  assert.equal(result.scheduleAllowed, false);
  assert.equal(result.qaVerdict, "not-established");
});
