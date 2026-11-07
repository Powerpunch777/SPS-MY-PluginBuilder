import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createFinalPacketStore, type FinalAtomicApprovalCommitter, type FinalEvidenceSnapshot, type FinalPacketJournalEvent } from "../src/delivery-evidence/final-packet.ts";
import { createRevisionJournal, type RevisionState } from "../src/solution-revision-store.ts";
import { readFinalReview } from "../src/delivery-evidence/final-review.ts";
import { createBuilderPlatform } from "../src/platform.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const MAIN_SESSION = "66666666-6666-4666-8666-666666666666";
const REVIEW_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stateKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture() {
  const values = new Map<string, JsonValue>();
  const state: RevisionState = {
    async get(key) { return structuredClone(values.get(stateKey(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      const keyId = stateKey(key), exists = values.has(keyId), current = values.get(keyId);
      const matches = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (matches) values.set(keyId, structuredClone(value));
      return { swapped: matches };
    },
  };
  const key = (stateKeyValue: string) => stateKey({ scopeKind: "company", scopeId: COMPANY,
    namespace: "sonpark.my-builder", stateKey: stateKeyValue });
  values.set(key("lead-agent.v1"), { workspaceId: COMPANY, revision: 1, selectedAgentId: AGENT });
  values.set(key("lead-sessions.v1.1"), { workspaceId: COMPANY, selectionRevision: 1, agentId: AGENT, sessions: {
    main: MAIN_SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": REVIEW_SESSION,
  } });
  const runReads: Array<{ sessionId: string; companyId: string; runId: string }> = [];
  const platform = { state, agents: { sessions: { async getRun(sessionId: string, companyId: string, runId: string) {
    runReads.push({ sessionId, companyId, runId });
    return { status: "succeeded", runId, cancellationRequested: false };
  } } }, events: {} } as unknown as SpsPlatformInvocationContext;
  const runContext = { companyId: COMPANY, agentId: AGENT, runId: RUN, sessionId: MAIN_SESSION };
  const reviewContext = { companyId: COMPANY, agentId: AGENT, runId: "abcdefab-cdef-4abc-8def-abcdefabcdee", sessionId: REVIEW_SESSION };
  const pin = (sourceId: string, revisionId: string) => ({ sourceId, revisionId, sha256: sha(sourceId + revisionId) });
  const commitObjectBytes = Buffer.from("tree 0123456789012345678901234567890123456789\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nfixture commit\n");
  const commitHeader = Buffer.from(`commit ${commitObjectBytes.byteLength}\0`, "ascii");
  const commitSha = createHash("sha1").update(commitHeader).update(commitObjectBytes).digest("hex");
  const outputBytes = Buffer.from("verified package bytes");
  const content = {
    packetId: "packet-1", packetRevisionId: "packet-rev-1", baseline: pin("baseline", "base-r1"),
    uiRevision: pin("ui", "ui-r1"), manifest: pin("manifest", "manifest-r1"),
    integration: { branch: "release/1", commitSha, build: pin("build", "build-r1"),
      ciEvidence: [pin("ci", "ci-r1")], e2eEvidence: [pin("e2e", "e2e-r1")] },
    files: [{ path: "dist/plugin.js", classification: "program", size: outputBytes.byteLength, sha256: sha(outputBytes.toString()) }],
    documents: [{ kind: "installation-guide" as const, pin: pin("install-guide", "doc-r1") },
      { kind: "user-guide" as const, pin: pin("user-guide", "doc-r2") }],
    qaEvidence: [pin("qa-report", "qa-r1")], g6Evidence: [pin("g6", "g6-r1")], g7Evidence: [pin("g7", "g7-r1")],
    limits: ["Host runtime source authority is externally verified"],
    changeHistory: [pin("change-history", "changes-r1")],
  };
  const packet = { ...content, packetSha256: sha(JSON.stringify(content)) };
  const currentPins = [content.baseline, content.uiRevision, content.manifest, content.integration.build,
    ...content.integration.ciEvidence, ...content.integration.e2eEvidence, ...content.documents.map(document => document.pin),
    ...content.qaEvidence, ...content.g6Evidence, ...content.g7Evidence, ...content.changeHistory,
    ...content.files.map(file => ({ sourceId: `file:${file.path}`, revisionId: content.packetRevisionId, sha256: file.sha256 }))]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.revisionId.localeCompare(b.revisionId) || a.sha256.localeCompare(b.sha256));
  const snapshot: FinalEvidenceSnapshot = {
    provenance: { adapter: "builder.final-packet-current-evidence.v1", operation: "readCurrent" },
    workspaceId: COMPANY, projectId: COMPANY, packet, commitObjectBytes,
    fileBytes: [{ path: "dist/plugin.js", bytes: outputBytes }], integrationCodeAuthority: "verified", hostRuntimeAuthority: "verified",
    g6: "PASS", g7: "PASS", qa: "PASS", currentPinsSha256: sha(JSON.stringify(currentPins)),
  };
  return { state, platform, runContext, reviewContext, snapshot, runReads,
    setLeadSelectionRevision(revision: number) {
      values.set(key("lead-agent.v1"), { workspaceId: COMPANY, revision, selectedAgentId: AGENT });
      values.set(key(`lead-sessions.v1.${revision}`), { workspaceId: COMPANY, selectionRevision: revision, agentId: AGENT, sessions: {
        main: MAIN_SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": REVIEW_SESSION,
      } });
    },
    store: (reader?: () => Promise<any>, committer?: FinalAtomicApprovalCommitter) =>
      createFinalPacketStore(COMPANY, COMPANY, state, reader, committer) };
}

test("unregistered evidence reader and UNKNOWN gates never publish a Main attestation", async () => {
  const f = fixture();
  const input = { eventId: "attest-packet-r1", requestId: f.snapshot.packet.packetRevisionId, expectedBaseRevisionId: null };
  const unregistered = await f.store().attestFinalPacket(input, f.runContext, f.platform);
  assert.equal(unregistered.status, "blocked");
  const unknown = await f.store(async () => ({ status: "available", value: { ...f.snapshot, g6: "UNKNOWN" } }))
    .attestFinalPacket(input, f.runContext, f.platform);
  assert.equal(unknown.status, "blocked");
});

test("missing or mismatched commit/file bytes block Main attestation even when status fields claim pass", async () => {
  const f = fixture();
  const noBytes = await f.store(async () => ({ status: "available", value: { ...f.snapshot, fileBytes: [] } }))
    .attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  assert.equal(noBytes.status, "blocked");
  const changedFile = await f.store(async () => ({ status: "available", value: { ...f.snapshot,
    fileBytes: [{ path: "dist/plugin.js", bytes: Buffer.from("different bytes") }] } }))
    .attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  assert.equal(changedFile.status, "blocked");
  const changedCommit = await f.store(async () => ({ status: "available", value: { ...f.snapshot,
    commitObjectBytes: Buffer.from("other commit object") } }))
    .attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  assert.equal(changedCommit.status, "blocked");
});

test("fixture: Main attests, only Integration Review posts request, authenticated user decides once", async () => {
  const f = fixture();
  const store = f.store(async () => ({ status: "available", value: f.snapshot }));
  const attested = await store.attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  assert.equal(attested.status, "attested");
  await assert.rejects(() => store.publishApprovalRequest({ eventId: "request-packet-r1", requestId: "packet-rev-1",
    expectedBaseRevisionId: "attest-packet-r1", attestationEventId: "attest-packet-r1" }, f.runContext, f.platform), /Only the current Lead Integration Review/);
  const published = await store.publishApprovalRequest({ eventId: "request-packet-r1", requestId: "packet-rev-1",
    expectedBaseRevisionId: "attest-packet-r1", attestationEventId: "attest-packet-r1" }, f.reviewContext, f.platform);
  assert.equal(published.status, "published");
  if (published.status !== "published") return;
  assert.equal(published.request.request?.packet.packetSha256, f.snapshot.packet.packetSha256);
  assert.equal(published.request.request?.packet.documents.length, 2);
  assert.equal(published.request.request?.attestationEventId, "attest-packet-r1");
  assert.equal(published.request.request?.integrationReviewSessionId, REVIEW_SESSION);
  const response = await store.respond({ eventId: "decision-event-1", requestId: "packet-rev-1",
    expectedBaseRevisionId: "request-packet-r1", action: "request-changes", reason: "Update guide" },
  { companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: "user-7" }, state: f.state });
  assert.equal(response.status, "recorded");
  assert.equal(response.decision?.userId, "user-7");
  await assert.rejects(() => store.respond({ eventId: "decision-event-2", requestId: "packet-rev-1",
    expectedBaseRevisionId: "decision-event-1", action: "hold", reason: "later" },
  { companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: "user-7" }, state: f.state }), /already has a user decision/);
});

test("fixture: approve requires an operation-specific atomic writer and forwards exact snapshots", async () => {
  const f = fixture();
  const reader = async () => ({ status: "available" as const, value: f.snapshot });
  const store = f.store(reader);
  await store.attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  await store.publishApprovalRequest({ eventId: "request-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: "attest-packet-r1",
    attestationEventId: "attest-packet-r1" }, f.reviewContext, f.platform);
  const action = { eventId: "decision-event-1", requestId: "packet-rev-1", expectedBaseRevisionId: "request-packet-r1", action: "approve" };
  const context = { companyId: COMPANY, actor: { type: "user" as const, companyId: COMPANY, userId: "user-7" }, state: f.state };
  await assert.rejects(() => store.respond(action, context), /Atomic current-evidence approval writer is not registered/);
  const forwarded: Parameters<FinalAtomicApprovalCommitter>[0][] = [];
  const authorizedFixture = fixture();
  const journal = createRevisionJournal(COMPANY, COMPANY, authorizedFixture.state, { prefix: "final-delivery",
    parse: value => value as FinalPacketJournalEvent, revisionId: event => event.eventId });
  const atomicStore = authorizedFixture.store(async () => ({ status: "available", value: authorizedFixture.snapshot }),
    async input => {
      forwarded.push(input);
      const result = await journal.publish({ revision: input.decision, expectedBaseRevisionId: input.expectedJournalRevisionId });
      return result.status === "published" ? { status: "published", sequence: result.sequence } : { status: "stale" };
    });
  await atomicStore.attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null },
    authorizedFixture.runContext, authorizedFixture.platform);
  await atomicStore.publishApprovalRequest({ eventId: "request-packet-r1", requestId: "packet-rev-1",
    expectedBaseRevisionId: "attest-packet-r1", attestationEventId: "attest-packet-r1" }, authorizedFixture.reviewContext, authorizedFixture.platform);
  const approved = await atomicStore.respond(action, { ...context, state: authorizedFixture.state });
  assert.equal(approved.status, "recorded");
  assert.equal(forwarded[0]?.decision.decision?.action, "approve");
  assert.equal(forwarded[0]?.currentSnapshotSha256, sha(JSON.stringify(authorizedFixture.snapshot)));
  assert.equal(forwarded[0]?.requestSnapshotSha256, sha(JSON.stringify(authorizedFixture.snapshot)));
});

test("a claimed atomic approval receipt is insufficient without the exact journal event", async () => {
  const f = fixture();
  const store = f.store(async () => ({ status: "available", value: f.snapshot }), async () => ({ status: "published", sequence: 3 }));
  await store.attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  await store.publishApprovalRequest({ eventId: "request-packet-r1", requestId: "packet-rev-1",
    expectedBaseRevisionId: "attest-packet-r1", attestationEventId: "attest-packet-r1" }, f.reviewContext, f.platform);
  await assert.rejects(store.respond({ eventId: "unwritten-decision", requestId: "packet-rev-1",
    expectedBaseRevisionId: "request-packet-r1", action: "approve" },
  { companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: "user-7" }, state: f.state }), /did not match the stored user decision/);
});

test("lost approval response replays only the exact stored decision after restart, even if evidence changed", async () => {
  const f = fixture();
  let evidenceReads = 0, commitCalls = 0, admitted = 0;
  const journal = createRevisionJournal(COMPANY, COMPANY, f.state, { prefix: "final-delivery",
    parse: value => value as FinalPacketJournalEvent, revisionId: event => event.eventId });
  const store = f.store(async () => {
    evidenceReads++;
    return { status: "available" as const, value: f.snapshot };
  }, async input => {
    commitCalls++;
    const result = await journal.publish({ expectedBaseRevisionId: input.expectedJournalRevisionId, revision: input.decision });
    assert.equal(result.status, "published");
    throw new Error("response lost after publication");
  });
  await store.attestFinalPacket({ eventId: "attestation", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  await store.publishApprovalRequest({ eventId: "request", requestId: "packet-rev-1", expectedBaseRevisionId: "attestation",
    attestationEventId: "attestation" }, f.reviewContext, f.platform);
  const input = { eventId: "decision", requestId: "packet-rev-1", expectedBaseRevisionId: "request", action: "approve" };
  const context = { companyId: COMPANY, actor: { type: "user" as const, companyId: COMPANY, userId: "user-7" }, state: f.state };
  await assert.rejects(store.respond(input, context, async () => { admitted++; }), /response lost/);
  const readCount = evidenceReads;
  const restarted = f.store(async () => { evidenceReads++; return { status: "unknown", reason: "source-changed" }; });
  const forbiddenAdmission = async () => { throw new Error("must not start a new decision"); };
  const saved = await journal.publishedRevision(input.eventId);
  const replay = await restarted.respond(input, context, forbiddenAdmission);
  assert.deepEqual(replay, { status: "recorded", sequence: saved?.sequence, decision: saved?.revision.decision, replayed: true });
  assert.equal(evidenceReads, readCount);
  assert.equal(commitCalls, 1);
  assert.equal(admitted, 1);
  assert.equal((await journal.current())?.sequence, 3);
  for (const altered of [{ ...input, requestId: "other" }, { ...input, expectedBaseRevisionId: null },
    { ...input, action: "hold", reason: "Changed" }, { ...input, reason: "Different" }]) {
    await assert.rejects(restarted.respond(altered, context, forbiddenAdmission), /different immutable content/);
  }
  await assert.rejects(restarted.respond(input, { ...context, actor: { ...context.actor, userId: "user-8" } }, forbiddenAdmission),
    /different immutable content/);
  await assert.rejects(restarted.respond({ ...input, eventId: "new" }, context, forbiddenAdmission), /must not start a new decision/);
});

test("registered review exposes no bytes or approval eligibility from historical evidence", async () => {
  const f = fixture();
  const reader = async () => ({ status: "available" as const, value: f.snapshot });
  const store = f.store(reader);
  await store.attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  await store.publishApprovalRequest({ eventId: "request-packet-r1", requestId: "packet-rev-1",
    expectedBaseRevisionId: "attest-packet-r1", attestationEventId: "attest-packet-r1" }, f.reviewContext, f.platform);
  const contract = createBuilderPlatform();
  const read = contract.data.find(item => item.key === "builder.final-review")!.handler;
  const view = await read({ companyId: COMPANY }, f.platform) as { status: string; snapshot: Record<string, unknown>;
    approvalEligibility: { status: string }; mainReceipt: { runId: string } | null };
  assert.equal(view.status, "ready");
  assert.equal(view.snapshot.g7, "UNKNOWN");
  assert.equal(view.approvalEligibility.status, "unknown");
  assert.equal(view.mainReceipt?.runId, RUN);
  assert.deepEqual(f.runReads.map(value => value.sessionId), [MAIN_SESSION, REVIEW_SESSION]);
  const sessions = { workspaceId: COMPANY, selectionRevision: 1, agentId: AGENT,
    sessions: { main: MAIN_SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": REVIEW_SESSION } };
  const active = await readFinalReview(store, sessions, f.platform);
  assert.equal(active.status, "ready");
  if (active.status !== "ready") throw new Error("Unexpected fixture view.");
  assert.equal(active.approvalEligibility.status, "blocked");
  assert.equal(Object.hasOwn(active.snapshot, "fileBytes"), false);
  assert.equal(Object.hasOwn(active.snapshot, "commitObjectBytes"), false);

  const action = contract.actions.find(item => item.key === "builder.final-review-decision")!.handler;
  const ctx = { ...f.platform, companyId: COMPANY, actor: { type: "user" as const, companyId: COMPANY, userId: "user-7" } };
  const decision = { eventId: "user-decision-1", requestId: "packet-rev-1", expectedBaseRevisionId: "request-packet-r1" };
  await assert.rejects(async () => action({ ...decision, action: "approve" }, ctx), /not eligible/);
  f.setLeadSelectionRevision(2);
  await assert.rejects(async () => action({ ...decision, action: "hold", reason: "Wait" }, ctx), /receipts could not be verified/);
  f.setLeadSelectionRevision(1);
  const recorded = await action({ ...decision, action: "hold", reason: "Wait" }, ctx) as { status: string };
  assert.equal(recorded.status, "recorded");
});

test("Integration Review cannot post an attestation from a prior Lead selection", async () => {
  const f = fixture();
  const store = f.store(async () => ({ status: "available" as const, value: f.snapshot }));
  await store.attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  f.setLeadSelectionRevision(2);
  const result = await store.publishApprovalRequest({ eventId: "request-packet-r1", requestId: "packet-rev-1",
    expectedBaseRevisionId: "attest-packet-r1", attestationEventId: "attest-packet-r1" }, f.reviewContext, f.platform);
  assert.deepEqual(result, { status: "blocked", reason: "main-attestation-is-not-from-the-current-same-lead-selection" });
});

test("stale evidence and non-user actors cannot confirm the packet", async () => {
  const f = fixture();
  let changed = false;
  const store = f.store(async () => ({ status: "available", value: changed ? { ...f.snapshot, currentPinsSha256: sha("new pins") } : f.snapshot }));
  await store.attestFinalPacket({ eventId: "attest-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: null }, f.runContext, f.platform);
  await store.publishApprovalRequest({ eventId: "request-packet-r1", requestId: "packet-rev-1", expectedBaseRevisionId: "attest-packet-r1",
    attestationEventId: "attest-packet-r1" }, f.reviewContext, f.platform);
  changed = true;
  await assert.rejects(() => store.respond({ eventId: "decision-event-1", requestId: "packet-rev-1",
    expectedBaseRevisionId: "request-packet-r1", action: "approve" },
  { companyId: COMPANY, actor: { type: "agent", companyId: COMPANY, agentId: AGENT }, state: f.state }), /authenticated Workspace user/);
  await assert.rejects(() => store.respond({ eventId: "decision-event-2", requestId: "packet-rev-1",
    expectedBaseRevisionId: "request-packet-r1", action: "approve" },
  { companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: "user-7" }, state: f.state }), /stale, unavailable, or UNKNOWN/);
});
