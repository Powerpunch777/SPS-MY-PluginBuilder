import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import { createTaskQaRunReferenceStore, recordTaskQaRunReference } from "../src/task-qa-run-references.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";

const W = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const NEXT_RUN = "33333333-3333-4333-8333-333333333333";
const subjectKey = "builder-task-qa-v1:" + "a".repeat(64);
const selected = { workspaceId: W, projectId: W, ctoId: "cto-a", workstreamId: "ws-a", qaTaskId: "qa-a" };
function fixture(lostWrite = 0) {
  const rows = new Map<string, JsonValue>();
  let writes = 0;
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
  const target = { ...selected, implementation: { packet: { taskId: "dev-a", revision: 1 } },
    implementationDigest: "b".repeat(64), qa: { packet: { taskId: "qa-a", revision: 1 } }, qaDigest: "c".repeat(64),
    qaWorker: { agentId: "44444444-4444-4444-8444-444444444444", sessionId: "55555555-5555-4555-8555-555555555555" },
    source: { sourceId: "66666666-6666-4666-8666-666666666666", folderKey: "workspace", branch: "workstream/a" },
    commitSha: "d".repeat(40), treeSha: "e".repeat(40), acceptanceId: "f".repeat(64), submissionId: "1".repeat(64),
    approvalId: "77777777-7777-4777-8777-777777777777", planSha256: "2".repeat(64), subjectKey,
    subjectKeySha256: createHash("sha256").update(subjectKey, "utf8").digest("hex"), requestId: subjectKey,
    async assertCurrent() {} };
  return { state, rows, target, get writes() { return writes; } };
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
