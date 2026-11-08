import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import { createTaskQaRunReferenceStore, parseTaskQaRunReference, recordDeferredTaskQaEvent,
  recordTaskQaRunReference, type TaskQaRunReference } from "../src/task-qa-run-references.ts";
import type { RevisionPublicationGuard, RevisionState } from "../src/solution-revision-store.ts";

const W = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const NEXT_RUN = "33333333-3333-4333-8333-333333333333";
const subjectKey = "builder-task-qa-v1:" + "a".repeat(64);
const selected = { workspaceId: W, projectId: W, ctoId: "cto-a", workstreamId: "ws-a", qaTaskId: "qa-a" };
function fixture(lostWrite = 0) {
  const rows = new Map<string, JsonValue>();
  const guardRows = new Map<string, JsonValue>();
  let writes = 0;
  let loseGuardReply = false;
  const keyOf = (key: { stateKey: string; namespace?: string }) => JSON.stringify([key.namespace, key.stateKey]);
  const state: RevisionState = {
    async get(key) { return structuredClone(rows.get(keyOf(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      const old = rows.get(keyOf(key)) ?? null;
      if (expected.exists ? JSON.stringify(old) !== JSON.stringify(expected.value) : old !== null) return { swapped: false };
      rows.set(keyOf(key), structuredClone(value)); writes++;
      if (writes === lostWrite) throw new Error("CAS reply lost");
      return { swapped: true };
    },
  };
  const installGuardedCas = () => {
    state.guardedCompareAndSet = async (key, expected, value) => {
      if (key.guards.some(guard => JSON.stringify(guardRows.get(keyOf(guard)) ?? null) !== JSON.stringify(guard.expectedValue))) {
        return { status: "conflict" };
      }
      const old = rows.get(keyOf(key)) ?? null;
      if (expected.exists ? JSON.stringify(old) !== JSON.stringify(expected.value) : old !== null) return { status: "conflict" };
      rows.set(keyOf(key), structuredClone(value));
      writes++;
      if (loseGuardReply) { loseGuardReply = false; throw new Error("Guarded CAS reply lost after commit"); }
      return { status: "committed" };
    };
  };
  const target = { ...selected, implementation: { packet: { taskId: "dev-a", revision: 1 } },
    implementationDigest: "b".repeat(64), qa: { packet: { taskId: "qa-a", revision: 1 } }, qaDigest: "c".repeat(64),
    qaWorker: { agentId: "44444444-4444-4444-8444-444444444444", sessionId: "55555555-5555-4555-8555-555555555555" },
    source: { sourceId: "66666666-6666-4666-8666-666666666666", folderKey: "workspace", branch: "workstream/a" },
    commitSha: "d".repeat(40), treeSha: "e".repeat(40), acceptanceId: "f".repeat(64), submissionId: "1".repeat(64),
    approvalId: "77777777-7777-4777-8777-777777777777", planSha256: "2".repeat(64), subjectKey,
    subjectKeySha256: createHash("sha256").update(subjectKey, "utf8").digest("hex"), requestId: subjectKey,
    async assertCurrent() {} };
  return { state, rows, guardRows, target, installGuardedCas,
    loseNextGuardReply() { loseGuardReply = true; }, get writes() { return writes; } };
}

const eventFor = (runId: string, receiptDigest = "6".repeat(64), subjectDigest = createHash("sha256")
  .update(subjectKey, "utf8").digest("hex")) => ({
  eventId: `sps-protected-test-terminal-v1:${runId}:${receiptDigest}:${subjectDigest}:88888888-8888-4888-8888-888888888888`,
  previousRunId: "99999999-9999-4999-8999-999999999999", receiptDigest,
});
const eventGuard: RevisionPublicationGuard = { namespace: "event-source", stateKey: "qa-current",
  expectedValue: { taskId: "qa-a", revision: 1, state: "pending" } };
const eventGuardKey = JSON.stringify([eventGuard.namespace, eventGuard.stateKey]);

function sameRunDifferentBinding(reference: TaskQaRunReference) {
  const body = { schemaVersion: 1 as const, scope: reference.scope,
    binding: { ...reference.binding, treeSha: "9".repeat(40) } };
  const digest = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
  return parseTaskQaRunReference({ ...body, revisionId: `task-qa-run-v1:${digest}` });
}

test("records only the exact Task-to-Core-run reference and replays without another entry", async () => {
  const f = fixture();
  const first = await recordTaskQaRunReference(f.state, f.target, RUN);
  assert.equal(first.status, "recorded");
  const repeated = await recordTaskQaRunReference(f.state, f.target, RUN);
  assert.equal(repeated.status, "existing");
  assert.equal(f.writes, 2);
  const stored = await createTaskQaRunReferenceStore(selected, f.state).findRun(RUN);
  assert.equal(stored.status, "found");
  if (stored.status !== "found") throw new Error("reference not found");
  assert.equal(stored.reference.binding.commitSha, f.target.commitSha);
  assert.equal("status" in stored.reference.binding, false, "Core execution state is not duplicated");
  assert.equal("qaVerdict" in stored.reference.binding, false, "a reference does not establish QA");
});

test("preserves an older run after a new QA packet/source revision and process recreation", async () => {
  const f = fixture();
  await recordTaskQaRunReference(f.state, f.target, RUN);
  await recordTaskQaRunReference(f.state, { ...f.target, qa: { packet: { taskId: "qa-a", revision: 2 } },
    qaDigest: "3".repeat(64), commitSha: "4".repeat(40), treeSha: "5".repeat(40) }, NEXT_RUN);
  const restored = createTaskQaRunReferenceStore({ qaTaskId: "qa-a", workstreamId: "ws-a", ctoId: "cto-a", projectId: W, workspaceId: W }, f.state);
  assert.equal((await restored.findRun(RUN)).status, "found");
  assert.equal((await restored.findRun(NEXT_RUN)).status, "found");
  assert.equal((await restored.current())?.sequence, 2);
});

test("does not rebind one Core run to different Task or source pins", async () => {
  const f = fixture();
  await recordTaskQaRunReference(f.state, f.target, RUN);
  assert.equal((await recordTaskQaRunReference(f.state, { ...f.target, treeSha: "9".repeat(40) }, RUN)).status, "conflict");
  assert.equal(f.writes, 2);
});

test("recovers a lost head-CAS reply without another Core operation or journal revision", async () => {
  const f = fixture(2);
  assert.equal((await recordTaskQaRunReference(f.state, f.target, RUN)).status, "existing");
  assert.equal((await recordTaskQaRunReference(f.state, f.target, RUN)).status, "existing");
  assert.equal(f.writes, 2);
});

test("keeps a staged entry after a lost entry reply and permits only exact reference reconciliation", async () => {
  const f = fixture(1);
  assert.equal((await recordTaskQaRunReference(f.state, f.target, RUN)).status, "unknown");
  assert.equal((await recordTaskQaRunReference(f.state, f.target, RUN)).status, "recorded");
  assert.equal((await createTaskQaRunReferenceStore(selected, f.state).current())?.sequence, 1);
});

test("rejects stale authority and a JSON-quoted subject digest before any reference write", async () => {
  const f = fixture();
  await assert.rejects(recordTaskQaRunReference(f.state, { ...f.target, async assertCurrent() { throw new Error("revoked"); } }, RUN), /revoked/);
  await assert.rejects(recordTaskQaRunReference(f.state, { ...f.target,
    subjectKeySha256: createHash("sha256").update(JSON.stringify(subjectKey)).digest("hex") }, RUN), /Invalid exact/);
  assert.equal(f.writes, 0);
});

test("records a guarded deferred event pointer without changing the Core run binding or legacy revision", async () => {
  const f = fixture();
  const base = await recordTaskQaRunReference(f.state, f.target, RUN);
  assert.equal(base.status, "recorded");
  if (base.status !== "recorded") throw new Error("base reference was not recorded");
  assert.equal(Object.hasOwn(base.reference, "deferredEvent"), false);

  f.installGuardedCas();
  f.guardRows.set(eventGuardKey, structuredClone(eventGuard.expectedValue));
  const event = eventFor(RUN, "6".repeat(64), f.target.subjectKeySha256);
  const linked = await recordDeferredTaskQaEvent(f.state, base.reference, event, [eventGuard]);
  assert.equal(linked.status, "recorded");
  if (linked.status !== "recorded") throw new Error("deferred event was not linked");
  assert.deepEqual(linked.reference.binding, base.reference.binding);
  assert.deepEqual(linked.reference.deferredEvent, event);

  const store = createTaskQaRunReferenceStore(selected, f.state);
  const history = await store.recent(2);
  assert.equal(history.revisions.length, 2);
  assert.equal(Object.hasOwn(history.revisions[1]!.revision, "deferredEvent"), false,
    "the original revision remains byte-compatible and field-free");
  assert.deepEqual(history.revisions[0]!.revision.binding, base.reference.binding);

  const replayedRun = await recordTaskQaRunReference(f.state, f.target, RUN);
  assert.equal(replayedRun.status, "existing");
  assert.deepEqual((await store.current())?.revision.deferredEvent, event,
    "an old run-reference replay must not replace or erase the event-linked head");
});

test("findRun returns the newest linked reference for an unchanged Core Run", async () => {
  const f = fixture();
  const base = await recordTaskQaRunReference(f.state, f.target, RUN);
  if (base.status !== "recorded") throw new Error("base reference was not recorded");
  f.installGuardedCas();
  f.guardRows.set(eventGuardKey, structuredClone(eventGuard.expectedValue));
  const event = eventFor(RUN, "6".repeat(64), f.target.subjectKeySha256);
  const linked = await recordDeferredTaskQaEvent(f.state, base.reference, event, [eventGuard]);
  if (linked.status !== "recorded") throw new Error("deferred event was not linked");

  const found = await createTaskQaRunReferenceStore(selected, f.state).findRun(RUN);
  assert.equal(found.status, "found");
  if (found.status !== "found") throw new Error("reference lookup did not find the run");
  assert.equal(found.reference.revisionId, linked.reference.revisionId);
  assert.deepEqual(found.reference.deferredEvent, event);
});

test("findRun conflicts when history attempts to attach one Core Run to another binding", async () => {
  const f = fixture();
  const base = await recordTaskQaRunReference(f.state, f.target, RUN);
  if (base.status !== "recorded") throw new Error("base reference was not recorded");
  const store = createTaskQaRunReferenceStore(selected, f.state);
  const head = await store.current();
  const conflictReference = sameRunDifferentBinding(base.reference);
  const published = await store.publish({ expectedBaseRevisionId: head!.revision.revisionId, revision: conflictReference });
  assert.equal(published.status, "published");
  assert.deepEqual(await store.findRun(RUN), { status: "conflict" });
});

test("does not publish a deferred pointer after guarded source drift", async () => {
  const f = fixture();
  const base = await recordTaskQaRunReference(f.state, f.target, RUN);
  if (base.status !== "recorded") throw new Error("base reference was not recorded");
  f.installGuardedCas();
  f.guardRows.set(eventGuardKey, { taskId: "qa-a", revision: 2, state: "pending" });
  const result = await recordDeferredTaskQaEvent(f.state, base.reference,
    eventFor(RUN, "6".repeat(64), f.target.subjectKeySha256), [eventGuard]);
  assert.equal(result.status, "conflict");
  const store = createTaskQaRunReferenceStore(selected, f.state);
  assert.equal((await store.current())?.revision.revisionId, base.reference.revisionId);
  assert.equal((await store.current())?.sequence, 1);
  if (result.status !== "conflict" || !("stagedRevisionId" in result) || typeof result.stagedRevisionId !== "string") {
    throw new Error("expected a staged guarded publication conflict");
  }
  assert.equal((await store.stagedRevision(result.stagedRevisionId, base.reference.revisionId)).status, "staged",
    "guard drift can leave only the immutable unpublished entry staged");
});

test("recovers a committed guarded-CAS lost reply and restart replay adds no duplicate revision", async () => {
  const f = fixture();
  const base = await recordTaskQaRunReference(f.state, f.target, RUN);
  if (base.status !== "recorded") throw new Error("base reference was not recorded");
  f.installGuardedCas();
  f.guardRows.set(eventGuardKey, structuredClone(eventGuard.expectedValue));
  f.loseNextGuardReply();
  const event = eventFor(RUN, "6".repeat(64), f.target.subjectKeySha256);
  const recovered = await recordDeferredTaskQaEvent(f.state, base.reference, event, [eventGuard]);
  assert.equal(recovered.status, "existing");
  if (recovered.status !== "existing") throw new Error("committed link was not reconciled");
  const writesAfterCommit = f.writes;

  const restartedStore = createTaskQaRunReferenceStore(selected, f.state);
  const head = await restartedStore.current();
  const repeated = await recordDeferredTaskQaEvent(f.state, head!.revision, event, [eventGuard]);
  assert.equal(repeated.status, "existing");
  assert.equal(f.writes, writesAfterCommit, "restart replay does not stage or publish another entry");
  assert.equal((await restartedStore.current())?.sequence, 2);
});

test("same deferred event is idempotent while a different event for that reference conflicts", async () => {
  const f = fixture();
  const base = await recordTaskQaRunReference(f.state, f.target, RUN);
  if (base.status !== "recorded") throw new Error("base reference was not recorded");
  f.installGuardedCas();
  f.guardRows.set(eventGuardKey, structuredClone(eventGuard.expectedValue));
  const event = eventFor(RUN, "6".repeat(64), f.target.subjectKeySha256);
  const linked = await recordDeferredTaskQaEvent(f.state, base.reference, event, [eventGuard]);
  if (linked.status !== "recorded") throw new Error("deferred event was not linked");
  const writesAfterLink = f.writes;
  assert.equal((await recordDeferredTaskQaEvent(f.state, linked.reference, event, [eventGuard])).status, "existing");
  assert.equal((await recordDeferredTaskQaEvent(f.state, linked.reference,
    eventFor(RUN, "7".repeat(64), f.target.subjectKeySha256), [eventGuard])).status, "conflict");
  assert.equal(f.writes, writesAfterLink);
});
