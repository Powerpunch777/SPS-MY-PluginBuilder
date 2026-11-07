import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createFinalPacketAtomicApprovalCommitter } from "../src/delivery-evidence/final-packet-atomic-approval.ts";
import { createFinalPacketStore, finalPacketPinsDigest, sealFinalPacket, type FinalEvidenceSnapshot,
  type FinalPacketJournalEvent } from "../src/delivery-evidence/final-packet.ts";
import { integrationPacketDigest } from "../src/delivery-evidence/integration-packet-evidence.ts";
import { createRevisionJournal, type RevisionState } from "../src/solution-revision-store.ts";
import { mainG7ReviewFixture } from "./fixtures/main-g7-review-fixture.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const LEAD_AGENT = "33333333-3333-4333-8333-333333333333";
const FOREIGN_AGENT = "44444444-4444-4444-8444-444444444444";
const MAIN_SESSION = "55555555-5555-4555-8555-555555555555";
const REVIEW_SESSION = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-11-07T10:00:00.000Z";
const HOST_SUPPORT = { state: "reported", contractVersion: "1.0", operations: ["state.guardedGitRefCompareAndSetV1"] };
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const keyString = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace ?? "default", key.stateKey]);
const stateKey = (value: string) => ({ scopeKind: "company" as const, scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: value });

function evidenceFixture(options: { requestReviewAgentId?: string; mainRunStatus?: string; reviewRunStatus?: string } = {}) {
  const values = new Map<string, JsonValue>();
  let plainHeadWrites = 0;
  const state: RevisionState & { guardedGitRefCompareAndSetV1?: (input: any) => Promise<any> } = {
    async get(key) { return structuredClone(values.get(keyString(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      if (key.stateKey.startsWith("final-delivery-head.v1.")) plainHeadWrites++;
      const identity = keyString(key), current = values.get(identity), exists = values.has(identity);
      const matches = expected.exists ? exists && json(current) === json(expected.value) : !exists;
      if (matches) values.set(identity, structuredClone(value));
      return { swapped: matches };
    },
  };
  const commitObjectBytes = Buffer.from("tree 0123456789012345678901234567890123456789\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\natomic approval fixture\n");
  const commitSha = createHash("sha1").update(Buffer.from(`commit ${commitObjectBytes.length}\0`, "ascii")).update(commitObjectBytes).digest("hex");
  const treeSha = "c".repeat(40);
  const outputBytes = Buffer.from("verified release bytes\n");
  const pin = (sourceId: string, revisionId: string) => ({ sourceId, revisionId, sha256: sha(`${sourceId}\0${revisionId}`) });
  const packet = sealFinalPacket({ packetId: "workspace-delivery", packetRevisionId: "final-packet-rev-1",
    baseline: pin("baseline", "baseline-r1"), uiRevision: pin("ui", "ui-r1"), manifest: pin("manifest", "manifest-r1"),
    integration: { branch: "release/1", commitSha, build: pin("build", "build-r1"), ciEvidence: [pin("ci", "ci-r1")],
      e2eEvidence: [pin("e2e", "e2e-r1")] },
    files: [{ path: "dist/app.js", classification: "program", size: outputBytes.length, sha256: sha(outputBytes) }],
    documents: [{ kind: "installation-guide", pin: pin("install-guide", "guide-r1") },
      { kind: "user-guide", pin: pin("user-guide", "guide-r1") }],
    qaEvidence: [pin("qa", "qa-r1")], g6Evidence: [pin("g6", "g6-r1")], g7Evidence: [pin("g7", "g7-r1")],
    limits: ["Fixture only"], changeHistory: [] });
  const snapshot: FinalEvidenceSnapshot = { provenance: { adapter: "builder.final-packet-current-evidence.v1", operation: "readCurrent" },
    workspaceId: WORKSPACE, projectId: WORKSPACE, packet, commitObjectBytes, fileBytes: [{ path: "dist/app.js", bytes: outputBytes }],
    integrationCodeAuthority: "verified", hostRuntimeAuthority: "verified", g6: "PASS", g7: "PASS", qa: "PASS",
    currentPinsSha256: finalPacketPinsDigest(packet) };
  const snapshotSha256 = sha(json(snapshot));
  const managerEvidence = { workspaceId: WORKSPACE, projectId: WORKSPACE,
    candidate: { sourceId: SOURCE, folderKey: "project-source", branch: packet.integration.branch, commitSha, treeSha },
    candidateEvidenceSha256: "a".repeat(64), plan: pin("plan", "plan-r1"), baseline: { ...pin("baseline", "baseline-r1"), sequence: 1 },
    ui: pin("ui", "ui-r1"), boardRevisionId: "board-r1", workstreams: [],
    tasks: [], scope: [], validation: [], buildOutputs: null,
    manifest: { path: "manifest.json", sha256: "b".repeat(64), sourceTreeManifestSha256: "e".repeat(64) },
    files: [], documentRevisionId: "documents-r1",
    documents: [], finalReadiness: "main-g7-required" as const, deliveryAuthority: "not-established" as const };
  const managerSha256 = integrationPacketDigest(managerEvidence);
  const managerRequestId = `integration-packet-v1:${managerSha256}`;
  const managerEventId = `integration-packet-event-v1:${sha(json([managerRequestId, null]))}`;
  const managerRead = { status: "available" as const, eventId: managerEventId, packetRevisionId: managerRequestId,
    sequence: 1, approvalEligibility: "not-established" as const,
    packet: { evidence: managerEvidence, sha256: managerSha256, agentId: "manager-agent", sessionId: "manager-session", runId: "manager-run" } };
  const mainReview = mainG7ReviewFixture(packet, snapshot.currentPinsSha256);
  const attestationEvent: FinalPacketJournalEvent = { eventId: "main-attestation-r1", expectedBaseRevisionId: managerEventId,
    kind: "main-attestation", requestId: packet.packetRevisionId,
    attestation: { packet, snapshotSha256, currentPinsSha256: snapshot.currentPinsSha256, attestedAt: NOW,
      mainLeadAgentId: LEAD_AGENT, mainLeadSelectionRevision: 1, mainLeadRunId: "main-run", mainLeadSessionId: MAIN_SESSION, mainReview },
    request: null, decision: null };
  const approvalRequest: FinalPacketJournalEvent = { eventId: "approval-request-r1", expectedBaseRevisionId: attestationEvent.eventId,
    kind: "approval-request", requestId: packet.packetRevisionId, attestation: null,
    request: { packet, snapshotSha256, currentPinsSha256: snapshot.currentPinsSha256, requestedAt: NOW,
      attestationEventId: attestationEvent.eventId, mainLeadAgentId: LEAD_AGENT, mainLeadSelectionRevision: 1,
      mainLeadRunId: "main-run", mainLeadSessionId: MAIN_SESSION, integrationReviewAgentId: options.requestReviewAgentId ?? LEAD_AGENT,
      integrationReviewRunId: "review-run", integrationReviewSessionId: REVIEW_SESSION }, decision: null };
  const managerEvent: FinalPacketJournalEvent = { eventId: managerEventId, expectedBaseRevisionId: null, kind: "manager-packet",
    requestId: managerRequestId, managerPacket: managerRead.packet, attestation: null, request: null, decision: null };
  const journal = createRevisionJournal<FinalPacketJournalEvent>(WORKSPACE, WORKSPACE, state,
    { prefix: "final-delivery", parse: value => value as FinalPacketJournalEvent, revisionId: event => event.eventId });
  const seed = async () => {
    await journal.publish({ expectedBaseRevisionId: null, revision: managerEvent });
    await journal.publish({ expectedBaseRevisionId: managerEvent.eventId, revision: attestationEvent });
    await journal.publish({ expectedBaseRevisionId: attestationEvent.eventId, revision: approvalRequest });
    plainHeadWrites = 0;
  };
  values.set(keyString(stateKey("evidence.mutable-head")), { revision: 1 });
  values.set(keyString(stateKey("manager.mutable-head")), { revision: 1 });
  values.set(keyString(stateKey("lead-agent.v1")), { workspaceId: WORKSPACE, revision: 1, selectedAgentId: LEAD_AGENT });
  values.set(keyString(stateKey("lead-sessions.v1.1")), { workspaceId: WORKSPACE, selectionRevision: 1, agentId: LEAD_AGENT,
    sessions: { main: MAIN_SESSION, "ui-design": "77777777-7777-4777-8777-777777777777",
      background: "88888888-8888-4888-8888-888888888888", "cto-inbox": "99999999-9999-4999-8999-999999999999",
      decisions: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "integration-review": REVIEW_SESSION } });
  const currentSource = { sourceId: SOURCE, folderKey: "project-source", branch: packet.integration.branch, commitSha, treeSha };
  const calls: any[] = [];
  const runObservations: Array<{ sessionId: string; runId: string }> = [];
  let changeEvidenceAfterRead = false;
  let changeGitAfterRead = false;
  let changeLeadBeforeCas = false;
  const platform = { state, agents: { sessions: { async getRun(sessionId: string, _workspaceId: string, runId: string) {
    runObservations.push({ sessionId, runId });
    return { runId, status: runId === "main-run" ? options.mainRunStatus ?? "succeeded" : options.reviewRunStatus ?? "succeeded",
      cancellationRequested: false, termination: "not_applicable" };
  } } } } as unknown as SpsPlatformInvocationContext;
  state.guardedGitRefCompareAndSetV1 = async input => {
    calls.push(structuredClone(input));
    if (changeLeadBeforeCas) {
      values.set(keyString(stateKey("lead-agent.v1")), { workspaceId: WORKSPACE, revision: 2, selectedAgentId: FOREIGN_AGENT });
      values.set(keyString(stateKey("lead-sessions.v1.2")), { workspaceId: WORKSPACE, selectionRevision: 2, agentId: FOREIGN_AGENT,
        sessions: { main: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ui-design": null, background: null, "cto-inbox": null,
          decisions: null, "integration-review": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } });
    }
    if (json({ sourceId: input.sourceId, folderKey: input.folderKey, branch: input.branch,
      commitSha: input.expectedCommit, treeSha: input.expectedTree }) !== json(currentSource)) {
      return { status: "conflict", reason: "git-pin-changed" };
    }
    for (const guard of input.guards) {
      const key = { ...stateKey(guard.stateKey), ...(guard.namespace === undefined ? {} : { namespace: guard.namespace }) };
      if (!values.has(keyString(key)) || json(values.get(keyString(key))) !== json(guard.expectedValue)) {
        return { status: "conflict", reason: "database-guard" };
      }
    }
    const target = { scopeKind: input.scopeKind, scopeId: input.scopeId, namespace: input.namespace, stateKey: input.stateKey };
    const key = keyString(target), old = values.get(key), exists = values.has(key);
    const matches = input.expected.exists ? exists && json(old) === json(input.expected.value) : !exists;
    if (!matches) return { status: "conflict", reason: "database-guard" };
    values.set(key, structuredClone(input.value));
    return { status: "committed", proof: { sourceId: currentSource.sourceId, folderKey: currentSource.folderKey,
      branch: currentSource.branch, commitSha: currentSource.commitSha, treeSha: currentSource.treeSha } };
  };
  const committer = createFinalPacketAtomicApprovalCommitter(WORKSPACE, WORKSPACE, platform, HOST_SUPPORT, {
    async readCurrentEvidence(selectedPlatform) {
      await selectedPlatform.state.get(stateKey("evidence.mutable-head"));
      if (changeEvidenceAfterRead) values.set(keyString(stateKey("evidence.mutable-head")), { revision: 2 });
      return { status: "available", value: snapshot };
    },
    async readCurrentManagerPacket(selectedPlatform) {
      await selectedPlatform.state.get(stateKey("manager.mutable-head"));
      if (changeGitAfterRead) currentSource.commitSha = "d".repeat(40);
      return managerRead as any;
    },
  });
  if (!committer) throw new Error("The test Host fixture must advertise the guarded Git-ref operation.");
  const approval = { eventId: "user-decision-r1", expectedBaseRevisionId: approvalRequest.eventId,
    kind: "user-decision", requestId: packet.packetRevisionId, attestation: null, request: null,
    decision: { action: "approve", userId: "authenticated-user", reason: null, decidedAt: NOW, sourceSnapshotSha256: snapshotSha256 } } as FinalPacketJournalEvent;
  return { values, state, platform, plainHeadWrites: () => plainHeadWrites, snapshot, snapshotSha256, managerRead, approvalRequest,
    approval, committer, calls, currentSource, runObservations, seed,
    changeEvidenceDuringRead: () => { changeEvidenceAfterRead = true; },
    changeGitDuringRead: () => { changeGitAfterRead = true; },
    changeLeadBeforeCas: () => { changeLeadBeforeCas = true; } };
}

test("approves only the current raw snapshot and commits the same final-delivery head through guarded Core Git CAS", async () => {
  const f = evidenceFixture();
  await f.seed();
  const result = await f.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE, requestId: f.approval.requestId,
    expectedJournalRevisionId: f.approvalRequest.eventId, requestSnapshotSha256: f.snapshotSha256,
    currentSnapshotSha256: f.snapshotSha256, decision: f.approval });
  assert.deepEqual(result, { status: "published", sequence: 4 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].sourceId, f.currentSource.sourceId);
  assert.equal(f.calls[0].folderKey, f.currentSource.folderKey);
  assert.equal(f.calls[0].branch, f.currentSource.branch);
  assert.equal(f.calls[0].expectedCommit, f.currentSource.commitSha);
  assert.equal(f.calls[0].expectedTree, f.currentSource.treeSha);
  assert.equal(f.calls[0].guards.length, 4);
  assert.deepEqual(f.runObservations, [{ sessionId: MAIN_SESSION, runId: "main-run" },
    { sessionId: REVIEW_SESSION, runId: "review-run" }]);
  assert.ok(f.calls[0].guards.some((guard: any) => guard.stateKey === "lead-agent.v1"));
  assert.ok(f.calls[0].guards.some((guard: any) => guard.stateKey === "lead-sessions.v1.1"));
  assert.equal("actor" in f.calls[0], false, "actor identity must stay invocation-held in Core");
  assert.equal(f.plainHeadWrites(), 0, "the final-delivery head never uses plain CAS");
  const current = await createFinalPacketStore(WORKSPACE, WORKSPACE, f.state).current();
  assert.equal(current.revisions[0]?.revision.eventId, f.approval.eventId);
  assert.deepEqual(current.revisions[0]?.revision, f.approval);
});

test("unknown or unadvertised Host support leaves atomic approval unavailable", () => {
  const f = evidenceFixture();
  const withoutSupport = createFinalPacketAtomicApprovalCommitter(WORKSPACE, WORKSPACE, f.platform, undefined);
  const malformedSupport = createFinalPacketAtomicApprovalCommitter(WORKSPACE, WORKSPACE, f.platform,
    { state: "reported", contractVersion: "1.0", operations: ["state.guardedGitRefCompareAndSetV1", "state.guardedGitRefCompareAndSetV1"] });
  const otherOperation = createFinalPacketAtomicApprovalCommitter(WORKSPACE, WORKSPACE, f.platform,
    { state: "reported", contractVersion: "1.0", operations: ["state.compareAndSet"] });
  assert.equal(withoutSupport, undefined);
  assert.equal(malformedSupport, undefined);
  assert.equal(otherOperation, undefined);
  assert.equal(f.calls.length, 0, "support discovery never executes the writer");
});

test("current Lead selection, both author runs, and request author identity are required", async () => {
  const foreignLead = evidenceFixture();
  await foreignLead.seed();
  foreignLead.values.set(keyString(stateKey("lead-agent.v1")), { workspaceId: WORKSPACE, revision: 2, selectedAgentId: FOREIGN_AGENT });
  await assert.rejects(foreignLead.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE, requestId: foreignLead.approval.requestId,
    expectedJournalRevisionId: foreignLead.approvalRequest.eventId, requestSnapshotSha256: foreignLead.snapshotSha256,
    currentSnapshotSha256: foreignLead.snapshotSha256, decision: foreignLead.approval }), /current Lead selection/u);
  assert.equal(foreignLead.calls.length, 0);
  assert.deepEqual(foreignLead.runObservations, []);

  const wrongCurrentSessions = evidenceFixture();
  await wrongCurrentSessions.seed();
  wrongCurrentSessions.values.set(keyString(stateKey("lead-sessions.v1.1")), { workspaceId: WORKSPACE, selectionRevision: 1,
    agentId: LEAD_AGENT, sessions: { main: FOREIGN_AGENT, "ui-design": "77777777-7777-4777-8777-777777777777",
      background: "88888888-8888-4888-8888-888888888888", "cto-inbox": "99999999-9999-4999-8999-999999999999",
      decisions: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "integration-review": REVIEW_SESSION } });
  await assert.rejects(wrongCurrentSessions.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE,
    requestId: wrongCurrentSessions.approval.requestId, expectedJournalRevisionId: wrongCurrentSessions.approvalRequest.eventId,
    requestSnapshotSha256: wrongCurrentSessions.snapshotSha256, currentSnapshotSha256: wrongCurrentSessions.snapshotSha256,
    decision: wrongCurrentSessions.approval }), /current Lead Main and Integration Review authority/u);
  assert.equal(wrongCurrentSessions.calls.length, 0);

  const wrongReviewAuthor = evidenceFixture({ requestReviewAgentId: FOREIGN_AGENT });
  await wrongReviewAuthor.seed();
  await assert.rejects(wrongReviewAuthor.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE,
    requestId: wrongReviewAuthor.approval.requestId, expectedJournalRevisionId: wrongReviewAuthor.approvalRequest.eventId,
    requestSnapshotSha256: wrongReviewAuthor.snapshotSha256, currentSnapshotSha256: wrongReviewAuthor.snapshotSha256,
    decision: wrongReviewAuthor.approval }), /current Lead Main and Integration Review authority/u);
  assert.equal(wrongReviewAuthor.calls.length, 0);

  for (const options of [{ mainRunStatus: "cancelled" }, { reviewRunStatus: "failed" }]) {
    const badRun = evidenceFixture(options);
    await badRun.seed();
    await assert.rejects(badRun.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE, requestId: badRun.approval.requestId,
      expectedJournalRevisionId: badRun.approvalRequest.eventId, requestSnapshotSha256: badRun.snapshotSha256,
      currentSnapshotSha256: badRun.snapshotSha256, decision: badRun.approval }), /successful immutable Core terminal run/u);
    assert.equal(badRun.calls.length, 0);
  }
});

test("Lead selection changed at the guarded effect boundary conflicts atomically", async () => {
  const f = evidenceFixture();
  await f.seed();
  f.changeLeadBeforeCas();
  const result = await f.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE, requestId: f.approval.requestId,
    expectedJournalRevisionId: f.approvalRequest.eventId, requestSnapshotSha256: f.snapshotSha256,
    currentSnapshotSha256: f.snapshotSha256, decision: f.approval });
  assert.deepEqual(result, { status: "stale" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.plainHeadWrites(), 0);
});

test("reconciles an exact committed event after a lost Core response and never retries the Core write", async () => {
  const f = evidenceFixture();
  await f.seed();
  const core = f.state.guardedGitRefCompareAndSetV1!;
  let lost = true;
  f.state.guardedGitRefCompareAndSetV1 = async input => {
    const result = await core(input);
    if (lost) { lost = false; throw new Error("simulated lost reply after commit"); }
    return result;
  };
  const input = { workspaceId: WORKSPACE, projectId: WORKSPACE, requestId: f.approval.requestId,
    expectedJournalRevisionId: f.approvalRequest.eventId, requestSnapshotSha256: f.snapshotSha256,
    currentSnapshotSha256: f.snapshotSha256, decision: f.approval };
  assert.deepEqual(await f.committer(input), { status: "published", sequence: 4 });
  assert.deepEqual(await f.committer(input), { status: "published", sequence: 4 });
  assert.equal(f.calls.length, 1);
});

test("stale raw snapshots, changed state heads, and Git-ref conflicts fail closed", async () => {
  const wrongSnapshot = evidenceFixture();
  await wrongSnapshot.seed();
  await assert.rejects(wrongSnapshot.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE,
    requestId: wrongSnapshot.approval.requestId, expectedJournalRevisionId: wrongSnapshot.approvalRequest.eventId,
    requestSnapshotSha256: wrongSnapshot.snapshotSha256, currentSnapshotSha256: "f".repeat(64), decision: wrongSnapshot.approval }));
  assert.equal(wrongSnapshot.calls.length, 0);

  const changedGuard = evidenceFixture();
  await changedGuard.seed();
  changedGuard.changeEvidenceDuringRead();
  const changed = await changedGuard.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE, requestId: changedGuard.approval.requestId,
    expectedJournalRevisionId: changedGuard.approvalRequest.eventId, requestSnapshotSha256: changedGuard.snapshotSha256,
    currentSnapshotSha256: changedGuard.snapshotSha256, decision: changedGuard.approval });
  assert.deepEqual(changed, { status: "stale" });
  assert.equal(changedGuard.calls.length, 0, "state drift after the evidence read is rejected before Core CAS");
  assert.equal(changedGuard.plainHeadWrites(), 0);

  const changedGit = evidenceFixture();
  await changedGit.seed();
  changedGit.changeGitDuringRead();
  const gitConflict = await changedGit.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE,
    requestId: changedGit.approval.requestId, expectedJournalRevisionId: changedGit.approvalRequest.eventId,
    requestSnapshotSha256: changedGit.snapshotSha256, currentSnapshotSha256: changedGit.snapshotSha256,
    decision: changedGit.approval });
  assert.deepEqual(gitConflict, { status: "stale" });
  assert.equal(changedGit.calls.length, 1, "Core's locked Git ref comparison rejects drift at the effect boundary");
  assert.equal(changedGit.plainHeadWrites(), 0);
});

test("missing guarded Git-ref API and mismatched decision pins never fall back to ordinary CAS", async () => {
  const f = evidenceFixture();
  await f.seed();
  const call = f.state.guardedGitRefCompareAndSetV1;
  delete f.state.guardedGitRefCompareAndSetV1;
  await assert.rejects(f.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE, requestId: f.approval.requestId,
    expectedJournalRevisionId: f.approvalRequest.eventId, requestSnapshotSha256: f.snapshotSha256,
    currentSnapshotSha256: f.snapshotSha256, decision: f.approval }), /unsupported|not permitted|guarded Git-ref/u);
  assert.equal(f.plainHeadWrites(), 0);
  f.state.guardedGitRefCompareAndSetV1 = call;

  const altered = { ...f.approval, decision: { ...f.approval.decision!, sourceSnapshotSha256: "e".repeat(64) } } as FinalPacketJournalEvent;
  await assert.rejects(f.committer({ workspaceId: WORKSPACE, projectId: WORKSPACE, requestId: altered.requestId,
    expectedJournalRevisionId: altered.expectedBaseRevisionId, requestSnapshotSha256: f.snapshotSha256,
    currentSnapshotSha256: f.snapshotSha256, decision: altered }), /exact authenticated approve decision/u);
  assert.equal(f.calls.length, 0);
});
