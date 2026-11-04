import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { confirmConsultationBatch, readBuilderSnapshot } from "../src/platform.ts";
import { MAX_CONSULTATION_BATCHES, previewConsultationBatch, readConsultationBatches } from "../src/consultation-import/batch.ts";

const W = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const fakeSummary = (id: string) => ({ id, sourceId: `consultation-${id}`, sha256: "a".repeat(64), sourceName: "existing",
  suppliedAt: "UNKNOWN", lineCount: 1, selectedFromLine: 1, selectedThroughLine: 1, status: "incomplete",
  sender: "UNKNOWN", messageTimes: "UNKNOWN", attachments: "UNKNOWN", coverage: "UNKNOWN" });
function fake() {
  const rows = new Map<string, JsonValue>();
  let failNextSnapshotWrite = false;
  const platform = { state: {
    async get(key: Record<string, unknown>) { return structuredClone(rows.get(`${key.scopeId}:${key.stateKey}`) ?? null); },
    async set(key: Record<string, unknown>, value: JsonValue) {
      if (key.stateKey === "snapshot.v1" && failNextSnapshotWrite) { failNextSnapshotWrite = false; throw new Error("injected Main write failure"); }
      rows.set(`${key.scopeId}:${key.stateKey}`, structuredClone(value));
    },
    async compareAndSet(key: Record<string, unknown>, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const id = `${key.scopeId}:${key.stateKey}`, exists = rows.has(id), current = rows.get(id);
      if (expected.exists ? !exists || JSON.stringify(current) !== JSON.stringify(expected.value) : exists) return { swapped: false };
      rows.set(id, structuredClone(value)); return { swapped: true };
    },
  }, agents: new Proxy({}, { get() { throw new Error("no AI invocation expected"); } }) } as unknown as SpsPlatformInvocationContext;
  return { platform, rows, failSnapshotWrite: () => { failNextSnapshotWrite = true; } };
}

test("preview hashes the original bytes and applies an explicit original-line range", () => {
  const p = previewConsultationBatch({ id: "33333333-3333-4333-8333-333333333333", text: "첫 줄\r\n둘째 줄\n셋째 줄", sourceName: "manual.txt", fromLine: 2, throughLine: 3 });
  assert.equal(p.selectedText, "둘째 줄\n셋째 줄");
  assert.equal(p.lineCount, 3);
  assert.match(p.sha256, /^[a-f0-9]{64}$/);
});

test("preview rejects invalid ranges, missing inputs, oversized sources and oversized Main selections", () => {
  const common = { id: "33333333-3333-4333-8333-333333333333", sourceName: "paste", text: "a\nb", fromLine: 1, throughLine: 2 };
  assert.throws(() => previewConsultationBatch({ ...common, fromLine: 0 }));
  assert.throws(() => previewConsultationBatch({ ...common, throughLine: 3 }));
  assert.throws(() => previewConsultationBatch({ ...common, text: "x".repeat(50_000), throughLine: 1 }));
  assert.throws(() => previewConsultationBatch({ ...common, text: "x".repeat(49_100), throughLine: 1 }));
});

test("confirmed Batch stores the same source ID in Main and Workspace and never dispatches AI", async () => {
  const { platform } = fake();
  const result = await confirmConsultationBatch(W, { id: "33333333-3333-4333-8333-333333333333", sourceName: "manual.txt",
    text: "원문\n둘째", fromLine: 1, throughLine: 2, allowDuplicate: false }, platform);
  assert.equal(result.saved, true); assert.equal(result.analysisStarted, false);
  assert.equal(result.sourceId, "consultation-33333333-3333-4333-8333-333333333333");
  const snapshot = await readBuilderSnapshot(W, platform);
  assert.equal(snapshot.messages[0]?.id, result.sourceId);
  assert.equal(snapshot.messages[0]?.text, "원문\n둘째");
  assert.equal((await readBuilderSnapshot(OTHER, platform)).messages.length, 0);
});

test("Main partial failure leaves the durable original and an exact retry resumes consumption", async () => {
  const { platform, rows, failSnapshotWrite } = fake();
  const input = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceName: "manual", text: "원문", fromLine: 1,
    throughLine: 1, allowDuplicate: false };
  failSnapshotWrite();
  await assert.rejects(confirmConsultationBatch(W, input, platform), /injected Main write failure/);
  assert.ok(rows.has(`${W}:consultation-batch.v1.${input.id}`));
  assert.equal((await readConsultationBatches(W, platform))[0]?.id, input.id);
  assert.equal((await readBuilderSnapshot(W, platform)).messages.length, 0);
  const retry = await confirmConsultationBatch(W, input, platform);
  assert.equal(retry.sourceId, `consultation-${input.id}`);
  assert.equal((await readBuilderSnapshot(W, platform)).messages[0]?.text, "원문");
  assert.equal((await readConsultationBatches(W, platform)).length, 1);
});

test("duplicate content requires explicit acknowledgement and changed ID cannot overwrite another source", async () => {
  const { platform } = fake();
  const payload = { sourceName: "manual", text: "같은 원문", fromLine: 1, throughLine: 1 };
  await confirmConsultationBatch(W, { ...payload, id: "33333333-3333-4333-8333-333333333333", allowDuplicate: false }, platform);
  await assert.rejects(confirmConsultationBatch(W, { ...payload, id: "44444444-4444-4444-8444-444444444444", allowDuplicate: false }, platform), /중복 저장 확인/);
  const result = await confirmConsultationBatch(W, { ...payload, id: "44444444-4444-4444-8444-444444444444", allowDuplicate: true }, platform);
  assert.equal(result.saved, true);
  await assert.rejects(confirmConsultationBatch(W, { ...payload, id: "33333333-3333-4333-8333-333333333333", text: "변경", allowDuplicate: true }, platform));
});

test("confirm wrapper rejects same ID with a changed selection before altering Workspace metadata", async () => {
  const { platform } = fake();
  const base = { id: "66666666-6666-4666-8666-666666666666", sourceName: "manual", text: "첫 줄\n둘째 줄", allowDuplicate: false };
  await confirmConsultationBatch(W, { ...base, fromLine: 1, throughLine: 1 }, platform);
  await assert.rejects(confirmConsultationBatch(W, { ...base, fromLine: 1, throughLine: 2 }, platform), /different original text, selected range, or metadata/);
  const list = await readConsultationBatches(W, platform);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.selectedThroughLine, 1);
});

test("full public index rejects a new wrapper import before Main or Batch state changes", async () => {
  const { platform, rows } = fake();
  const summaries = Array.from({ length: MAX_CONSULTATION_BATCHES }, (_, index) => fakeSummary(
    `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`));
  rows.set(`${W}:consultation-batches.v1`, summaries as unknown as JsonValue);
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await assert.rejects(confirmConsultationBatch(W, { id, sourceName: "new", text: "new source", fromLine: 1,
    throughLine: 1, allowDuplicate: false }, platform), /index is full.*no Main source was imported/);
  assert.equal((await readBuilderSnapshot(W, platform)).messages.length, 0);
  assert.equal(rows.has(`${W}:consultation-batch.v1.${id}`), false);
  assert.equal((await readConsultationBatches(W, platform)).length, MAX_CONSULTATION_BATCHES);
});
