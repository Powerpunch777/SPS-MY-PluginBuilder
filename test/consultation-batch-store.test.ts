import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { MAX_CONSULTATION_BATCHES, MAX_CONSULTATION_BATCH_INDEX_BYTES, MAX_CONSULTATION_CAS_WIRE_BYTES, createConsultationAnalysisSnapshot, readConsultationBatches, readProjectConsultationMessages, readProjectConsultationSources, receiveProjectConsultationMessage, receiveProjectConsultationSource, saveConsultationBatch } from "../src/consultation-import/batch.ts";

const W = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const rows = new Map<string, JsonValue>();
  let failNextIndexWrite = false;
  let failNextIndexAfterCommit = false;
  let conflictIndexCAS = false;
  let indexReadBarrier: Promise<void> | null = null;
  let releaseIndexReadBarrier: (() => void) | null = null;
  let indexReadWaiters = 0;
  const stateKey = (key: Record<string, unknown>) => `${key.scopeId}:${key.stateKey}`;
  const platform = { state: {
    async get(key: Record<string, unknown>) {
      if (key.stateKey === "consultation-batches.v1" && indexReadBarrier) {
        const barrier = indexReadBarrier;
        indexReadWaiters += 1;
        if (indexReadWaiters === 2) { indexReadBarrier = null; releaseIndexReadBarrier?.(); }
        await barrier;
      }
      const value = rows.get(stateKey(key)); return value === undefined ? null : structuredClone(value);
    },
    async set(key: Record<string, unknown>, value: JsonValue) { rows.set(stateKey(key), structuredClone(value)); },
    async compareAndSet(key: Record<string, unknown>, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const id = stateKey(key), present = rows.has(id), current = rows.get(id);
      if (key.stateKey === "consultation-batches.v1" && conflictIndexCAS) return { swapped: false };
      if (expected.exists ? !present || JSON.stringify(current) !== JSON.stringify(expected.value) : present) return { swapped: false };
      if (key.stateKey === "consultation-batches.v1" && failNextIndexWrite) { failNextIndexWrite = false; throw new Error("injected pre-commit failure"); }
      rows.set(id, structuredClone(value));
      if (key.stateKey === "consultation-batches.v1" && failNextIndexAfterCommit) { failNextIndexAfterCommit = false; throw new Error("injected lost response"); }
      return { swapped: true };
    },
  } } as unknown as SpsPlatformInvocationContext;
  return { rows, platform, failIndex: () => { failNextIndexWrite = true; }, loseIndexResponse: () => { failNextIndexAfterCommit = true; },
    conflictIndex: (value: boolean) => { conflictIndexCAS = value; }, rendezvousIndexReads: () => {
      indexReadWaiters = 0;
      indexReadBarrier = new Promise<void>(resolve => { releaseIndexReadBarrier = resolve; });
    } };
}
const input = { id: "33333333-3333-4333-8333-333333333333", sourceName: "copy", text: "원문\n다음 줄",
  fromLine: 1, throughLine: 1, createdAt: "2026-11-04T01:00:00.000Z" };
const summary = (id: string, sourceName = "x", sha = "a".repeat(64)) => ({ id, sourceId: `consultation-${id}`, sha256: sha, sourceName,
  suppliedAt: "UNKNOWN", lineCount: 1, selectedFromLine: 1, selectedThroughLine: 1, status: "incomplete",
  sender: "UNKNOWN", messageTimes: "UNKNOWN", attachments: "UNKNOWN", coverage: "UNKNOWN" });
function fullIndexRows(count: number, except: readonly string[] = []) {
  const result: ReturnType<typeof summary>[] = [];
  for (let i = 1; result.length < count; i += 1) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    if (!except.includes(id)) result.push(summary(id));
  }
  return result;
}

test("persists original, hash and selected lines in a Workspace record while listing only metadata", async () => {
  const { platform, rows } = fixture();
  const saved = await saveConsultationBatch(W, input, `consultation-${input.id}`, platform);
  assert.equal(saved.originalText, input.text); assert.equal(saved.selectedText, "원문");
  assert.equal(saved.sender, "UNKNOWN"); assert.equal(saved.messageTimes, "UNKNOWN");
  const list = await readConsultationBatches(W, platform);
  assert.equal(list[0]?.sourceId, saved.sourceId); assert.equal("originalText" in (list[0] ?? {}), false);
  assert.equal((await readConsultationBatches(B, platform)).length, 0);
  assert.equal(rows.has(`${B}:consultation-batches.v1`), false);
});

test("records missing coverage as incomplete and makes same-ID retries idempotent", async () => {
  const { platform } = fixture();
  const first = await saveConsultationBatch(W, input, `consultation-${input.id}`, platform);
  const retry = await saveConsultationBatch(W, input, `consultation-${input.id}`, platform);
  assert.equal(retry.sha256, first.sha256); assert.equal(retry.status, "incomplete");
  assert.equal(retry.coverage, "UNKNOWN"); assert.equal(retry.attachments, "UNKNOWN");
  await assert.rejects(saveConsultationBatch(W, { ...input, text: "changed" }, `consultation-${input.id}`, platform), /different original text, selected range, or metadata|conflicts with this immutable Batch ID/);
});

test("concurrent different IDs preserve both Workspace index entries through CAS", async () => {
  const { platform } = fixture();
  const rows = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
  await Promise.all(rows.map((id, index) => saveConsultationBatch(W, { ...input, id, text: `source ${index}` }, `consultation-${id}`, platform)));
  assert.deepEqual((await readConsultationBatches(W, platform)).map(item => item.id).sort(), rows.sort());
});

test("same ID with changed range or metadata is rejected while an exact retry is idempotent", async () => {
  const { platform, rows } = fixture();
  const secondLine = { ...input, text: "원문\n다음 줄", fromLine: 2, throughLine: 2 };
  const first = await saveConsultationBatch(W, { ...input, fromLine: 1, throughLine: 1 }, `consultation-${input.id}`, platform);
  const retry = await saveConsultationBatch(W, { ...input, fromLine: 1, throughLine: 1, createdAt: "2026-11-05T00:00:00.000Z" }, `consultation-${input.id}`, platform);
  assert.equal(retry.createdAt, first.createdAt);
  await assert.rejects(saveConsultationBatch(W, secondLine, `consultation-${input.id}`, platform), /different original text, selected range, or metadata|conflicts with this immutable Batch ID/);
  await assert.rejects(saveConsultationBatch(W, { ...input, sourceName: "other source" }, `consultation-${input.id}`, platform), /different original text, selected range, or metadata|conflicts with this immutable Batch ID/);
  const stored = rows.get(`${W}:consultation-batch.v1.${input.id}`) as Record<string, unknown>;
  assert.equal(stored.selectedThroughLine, 1);
  assert.equal(stored.sourceName, "copy");
});

test("concurrent same-ID requests with different selection cannot overwrite the winner", async () => {
  const { platform, rows } = fixture();
  const first = { ...input, fromLine: 1, throughLine: 1 };
  const second = { ...input, fromLine: 2, throughLine: 2 };
  const outcomes = await Promise.allSettled([
    saveConsultationBatch(W, first, `consultation-${input.id}`, platform),
    saveConsultationBatch(W, second, `consultation-${input.id}`, platform),
  ]);
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(value => value.status === "rejected").length, 1);
  const record = rows.get(`${W}:consultation-batch.v1.${input.id}`) as Record<string, unknown>;
  const index = await readConsultationBatches(W, platform);
  assert.equal(index.length, 1);
  assert.equal(index[0]?.selectedThroughLine, record.selectedThroughLine);
});

test("index write failure leaves a staged source and exact same-ID retry repairs the listing", async () => {
  const { platform, rows, failIndex } = fixture();
  failIndex();
  await assert.rejects(saveConsultationBatch(W, input, `consultation-${input.id}`, platform), /outcome is uncertain/);
  assert.ok(rows.has(`${W}:consultation-batch.v1.${input.id}`));
  assert.deepEqual(await readConsultationBatches(W, platform), []);
  await saveConsultationBatch(W, input, `consultation-${input.id}`, platform);
  assert.equal((await readConsultationBatches(W, platform))[0]?.id, input.id);
});

test("lost CAS response stays explicit and exact retry observes the committed index", async () => {
  const { platform, loseIndexResponse } = fixture();
  loseIndexResponse();
  await assert.rejects(saveConsultationBatch(W, input, `consultation-${input.id}`, platform), /outcome is uncertain/);
  assert.equal((await readConsultationBatches(W, platform))[0]?.id, input.id);
  const retry = await saveConsultationBatch(W, input, `consultation-${input.id}`, platform);
  assert.equal(retry.id, input.id);
});

test("repeated known index CAS conflicts leave the source staged and report no confirmed listing", async () => {
  const { platform, rows, conflictIndex } = fixture();
  conflictIndex(true);
  await assert.rejects(saveConsultationBatch(W, input, `consultation-${input.id}`, platform), /changed repeatedly.*staged/);
  assert.ok(rows.has(`${W}:consultation-batch.v1.${input.id}`));
  assert.deepEqual(await readConsultationBatches(W, platform), []);
  conflictIndex(false);
  await saveConsultationBatch(W, input, `consultation-${input.id}`, platform);
  assert.equal((await readConsultationBatches(W, platform))[0]?.id, input.id);
});

test("CAS unsupported is explicit and leaves no Batch record", async () => {
  const rows = new Map<string, JsonValue>();
  const noCas = { state: {
    async get(key: Record<string, unknown>) { return rows.get(`${key.scopeId}:${key.stateKey}`) ?? null; },
    async set(key: Record<string, unknown>, value: JsonValue) { rows.set(`${key.scopeId}:${key.stateKey}`, value); },
  } } as unknown as SpsPlatformInvocationContext;
  await assert.rejects(saveConsultationBatch(W, input, `consultation-${input.id}`, noCas), /Unsupported Host: atomic state.compareAndSet/);
  assert.equal(rows.size, 0);
});

test("checks the full key, expected value and replacement value against the SDK wire limit", async () => {
  const { platform, rows } = fixture();
  const index = fullIndexRows(600);
  rows.set(`${W}:consultation-batches.v1`, index);
  await assert.rejects(saveConsultationBatch(W, input, `consultation-${input.id}`, platform), /262144-byte UTF-8 wire limit/);
  assert.ok(rows.has(`${W}:consultation-batch.v1.${input.id}`), "durable source is retained when only index CAS exceeds wire limit");
  assert.equal((await readConsultationBatches(W, platform)).length, 600);
});

test("analysis request snapshot binds explicit Workspace, project, request and source hashes immutably", async () => {
  const { platform } = fixture();
  const first = await receiveProjectConsultationSource({ workspaceId: W, projectId: B, ...input }, platform);
  const request = { workspaceId: W, projectId: B, requestId: "66666666-6666-4666-8666-666666666666",
    sources: [{ sourceId: first.sourceId, sha256: first.sha256 }] };
  const snapshot = await createConsultationAnalysisSnapshot(request, platform);
  const retry = await createConsultationAnalysisSnapshot(request, platform);
  assert.deepEqual(retry, snapshot);
  assert.equal(snapshot.projectId, B);

  const secondId = "77777777-7777-4777-8777-777777777777";
  const second = await receiveProjectConsultationSource({ workspaceId: W, projectId: B, ...input, id: secondId, text: "later source" }, platform);
  assert.deepEqual(await createConsultationAnalysisSnapshot(request, platform), snapshot,
    "new source receipt does not expand a prior analysis request");
  await assert.rejects(createConsultationAnalysisSnapshot({ ...request, sources: [{ sourceId: second.sourceId, sha256: second.sha256 }] }, platform), /different Workspace, project or source/);
  await assert.rejects(createConsultationAnalysisSnapshot({ ...request, projectId: "88888888-8888-4888-8888-888888888888" }, platform), /missing or its hash does not match/);
  await assert.rejects(createConsultationAnalysisSnapshot({ ...request, sources: [{ ...request.sources[0]!, sha256: "f".repeat(64) }] }, platform), /missing or its hash does not match/);
  await assert.rejects(createConsultationAnalysisSnapshot({ ...request, projectId: "88888888-8888-4888-8888-888888888888" }, platform), /missing or its hash does not match/);
  await assert.rejects(createConsultationAnalysisSnapshot({ ...request, workspaceId: B }, platform), /missing or its hash does not match/);
  const oldWorkspaceOnly = await saveConsultationBatch(W, { ...input, id: "99999999-9999-4999-8999-999999999999" },
    "consultation-99999999-9999-4999-8999-999999999999", platform);
  await assert.rejects(createConsultationAnalysisSnapshot({ ...request, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sources: [{ sourceId: oldWorkspaceOnly.sourceId, sha256: oldWorkspaceOnly.sha256 }] }, platform), /missing or its hash does not match/);
});

test("explicit project receipt is immutable, ordered, project isolated and keeps missing message order uncertain", async () => {
  const { platform, rows } = fixture();
  const one = await receiveProjectConsultationSource({ workspaceId: W, projectId: B, ...input }, platform);
  const twoId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await receiveProjectConsultationSource({ workspaceId: W, projectId: B, ...input, id: twoId, text: "second" }, platform);
  assert.deepEqual((await readProjectConsultationSources(W, B, platform)).map(item => item.sourceId), [one.sourceId, `consultation-${twoId}`]);
  assert.deepEqual(await readProjectConsultationSources(W, "88888888-8888-4888-8888-888888888888", platform), []);
  assert.equal(one.workspaceId, W); assert.equal(one.projectId, B); assert.equal(one.messageTimes, "UNKNOWN");
  assert.equal(one.coverage, "UNKNOWN"); assert.equal(rows.has(`${W}:consultation-project.v1.${B}.source.${input.id}`), true);
  const retry = await receiveProjectConsultationSource({ workspaceId: W, projectId: B, ...input }, platform);
  assert.equal(retry.receivedAt, one.receivedAt);
  assert.equal((await readProjectConsultationSources(W, B, platform)).length, 2,
    "an exact same-ID retry does not append a duplicate index entry");
  await assert.rejects(receiveProjectConsultationSource({ workspaceId: W, projectId: B, ...input, text: "changed" }, platform), /different content or metadata/);
  const duplicateContentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const sameTextNewId = await receiveProjectConsultationSource({ workspaceId: W, projectId: B, ...input, id: duplicateContentId }, platform);
  assert.equal(sameTextNewId.sha256, one.sha256);
  assert.equal((await readProjectConsultationSources(W, B, platform)).length, 3,
    "separate source IDs with the same text remain separate original records");
  const otherProjectCopy = await receiveProjectConsultationSource({ workspaceId: W,
    projectId: "88888888-8888-4888-8888-888888888888", ...input }, platform);
  assert.equal(otherProjectCopy.sourceId, one.sourceId);
  assert.equal(otherProjectCopy.projectId, "88888888-8888-4888-8888-888888888888");
});

test("project source survives an uncertain index CAS and an exact retry repairs publication", async () => {
  const { platform: base } = fixture();
  let failIndex = true;
  const state = base.state as SpsPlatformInvocationContext["state"] & Record<string, unknown>;
  const platform = { ...base, state: {
    get: state.get.bind(state), set: state.set.bind(state),
    async compareAndSet(target: Parameters<NonNullable<typeof state.compareAndSet>>[0],
      expected: Parameters<NonNullable<typeof state.compareAndSet>>[1], value: Parameters<NonNullable<typeof state.compareAndSet>>[2]) {
      if (failIndex && target.stateKey === `consultation-project.v1.${B}.index`) { failIndex = false; throw new Error("injected project index failure"); }
      return state.compareAndSet!(target, expected, value);
    },
  } } as unknown as SpsPlatformInvocationContext;
  await assert.rejects(receiveProjectConsultationSource({ workspaceId: W, projectId: B, ...input }, platform), /outcome is uncertain/);
  assert.deepEqual(await readProjectConsultationSources(W, B, platform), []);
  const retry = await receiveProjectConsultationSource({ workspaceId: W, projectId: B, ...input }, platform);
  assert.equal(retry.id, input.id);
  assert.equal((await readProjectConsultationSources(W, B, platform))[0]?.sourceId, retry.sourceId);
});

test("message receipts persist UTF-8 originals, receipt order, provider order gaps and duplicate conflicts", async () => {
  const { platform } = fixture();
  const projectId = "builder project: alpha";
  const receive = (messageId: string, text: string, sourceOrder: number | null) => receiveProjectConsultationMessage({
    workspaceId: W, projectId, sourceId: "connector-account-7", messageId, text, sourceOrder,
    sender: "buyer", sourceMessageAt: null,
  }, platform);
  const first = await receive("msg-1", "안녕🙂", 3);
  const second = await receive("msg-2", "두 번째", 5);
  const late = await receive("msg-3", "늦게 도착한 원문", 4);
  assert.equal(first.originalText, "안녕🙂");
  assert.equal(first.sha256, createHash("sha256").update("안녕🙂", "utf8").digest("hex"));
  assert.deepEqual([first.receivedOrder, second.receivedOrder, late.receivedOrder], [1, 2, 3]);
  assert.equal(first.orderStatus, "UNKNOWN", "a first observed provider cursor does not imply full prior coverage");
  assert.equal(second.orderStatus, "GAP"); assert.equal(second.coverage, "GAP");
  assert.equal(late.orderStatus, "OUT_OF_ORDER"); assert.equal(late.coverage, "OUT_OF_ORDER");
  const index = await readProjectConsultationMessages(W, projectId, platform);
  assert.deepEqual(index.map(item => item.messageId), ["msg-1", "msg-2", "msg-3"]);
  assert.equal(index[1]?.receivedOrder, 2);
  assert.equal(index[1]?.sourceOrder, 5);

  const duplicate = await receive("msg-2", "두 번째", 5);
  assert.equal(duplicate.receivedOrder, 2);
  assert.equal((await readProjectConsultationMessages(W, projectId, platform)).length, 3);
  await assert.rejects(receive("msg-2", "변경된 원문", 5), /different content or source metadata/);
  const sameTextDifferentId = await receive("msg-4", "두 번째", 6);
  assert.equal(sameTextDifferentId.sha256, second.sha256);
  const unknownOrder = await receive("msg-5", "순서 메타데이터 없음", null);
  assert.equal(unknownOrder.orderStatus, "UNKNOWN"); assert.equal(unknownOrder.coverage, "UNKNOWN");
  assert.equal((await readProjectConsultationMessages(W, projectId, platform)).length, 5);
  assert.deepEqual(await readProjectConsultationMessages(W, "builder project: beta", platform), []);
  await assert.rejects(receiveProjectConsultationMessage({ workspaceId: W, projectId: " ", sourceId: "x", messageId: "x", text: "x" }, platform), /explicit scope and IDs/);
  await assert.rejects(receiveProjectConsultationMessage({ workspaceId: W, projectId: "p".repeat(161), sourceId: "x", messageId: "x", text: "x" }, platform), /explicit scope and IDs/);
});

test("analysis snapshot accepts only same-project message hashes and stays fixed while messages arrive", async () => {
  const { platform } = fixture();
  const projectId = "project with spaces";
  const first = await receiveProjectConsultationMessage({ workspaceId: W, projectId, sourceId: "connector-x",
    messageId: "one", text: "first", sourceOrder: null }, platform);
  const request = { workspaceId: W, projectId, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sources: [{ sourceId: first.snapshotSourceId, sha256: first.sha256 }] };
  const snapshot = await createConsultationAnalysisSnapshot(request, platform);
  await receiveProjectConsultationMessage({ workspaceId: W, projectId, sourceId: "connector-x",
    messageId: "two", text: "later", sourceOrder: null }, platform);
  assert.deepEqual(await createConsultationAnalysisSnapshot(request, platform), snapshot);
  await assert.rejects(createConsultationAnalysisSnapshot({ ...request, projectId: "other project" }, platform), /missing or its hash does not match/);
  await assert.rejects(createConsultationAnalysisSnapshot({ ...request, sources: [{ sourceId: first.snapshotSourceId,
    sha256: "f".repeat(64) }] }, platform), /missing or its hash does not match/);
});

test("lost message receipt response is recovered by the same ID without changing its receive order", async () => {
  const { platform: base } = fixture();
  let lose = true;
  const state = base.state as SpsPlatformInvocationContext["state"] & Record<string, unknown>;
  const projectId = "project-message-retry";
  const indexKey = `consultation-project.v1.${projectId}.messages.index`;
  const platform = { ...base, state: {
    get: state.get.bind(state), set: state.set.bind(state),
    async compareAndSet(target: Parameters<NonNullable<typeof state.compareAndSet>>[0],
      expected: Parameters<NonNullable<typeof state.compareAndSet>>[1], value: Parameters<NonNullable<typeof state.compareAndSet>>[2]) {
      const result = await state.compareAndSet!(target, expected, value);
      if (lose && target.stateKey === indexKey) { lose = false; throw new Error("injected lost receipt response"); }
      return result;
    },
  } } as unknown as SpsPlatformInvocationContext;
  const input = { workspaceId: W, projectId, sourceId: "connector-y", messageId: "message-1", text: "durable message", sourceOrder: 1 };
  await assert.rejects(receiveProjectConsultationMessage(input, platform), /outcome is uncertain/);
  const retry = await receiveProjectConsultationMessage(input, platform);
  assert.equal(retry.receivedOrder, 1);
  assert.equal((await readProjectConsultationMessages(W, projectId, platform)).length, 1);
});

test("independent ESM clients share atomic CAS: successes are published and same-ID conflicts preserve the winner", async () => {
  const moduleA = await import(new URL("../src/consultation-import/batch.ts?audit-worker=a", import.meta.url).href) as typeof import("../src/consultation-import/batch.ts");
  const moduleB = await import(new URL("../src/consultation-import/batch.ts?audit-worker=b", import.meta.url).href) as typeof import("../src/consultation-import/batch.ts");
  const { platform, rows } = fixture();
  const distinctIds = ["77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"];
  const published = await Promise.all(distinctIds.map((id, index) => (index === 0 ? moduleA : moduleB).saveConsultationBatch(
    W, { ...input, id, text: `independent source ${index}` }, `consultation-${id}`, platform)));
  const listing = await moduleA.readConsultationBatches(W, platform);
  assert.deepEqual(listing.map(row => row.id).sort(), distinctIds.sort());
  assert.ok(published.every(record => listing.some(row => row.id === record.id && row.sha256 === record.sha256)));
  assert.ok(distinctIds.every(id => rows.has(`${W}:consultation-batch.v1.${id}`)));

  const sharedId = "99999999-9999-4999-8999-999999999999";
  const rangeOne = { ...input, id: sharedId, sourceName: "source-a", fromLine: 1, throughLine: 1 };
  const rangeTwo = { ...input, id: sharedId, sourceName: "source-b", fromLine: 2, throughLine: 2 };
  const sameIdRace = await Promise.allSettled([
    moduleA.saveConsultationBatch(W, rangeOne, `consultation-${sharedId}`, platform),
    moduleB.saveConsultationBatch(W, rangeTwo, `consultation-${sharedId}`, platform),
  ]);
  assert.equal(sameIdRace.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(sameIdRace.filter(result => result.status === "rejected").length, 1);
  const raw = rows.get(`${W}:consultation-batch.v1.${sharedId}`) as Record<string, unknown>;
  const winningInput = raw.selectedFromLine === 1 ? rangeOne : rangeTwo;
  const exactRetry = await moduleB.saveConsultationBatch(W, winningInput, `consultation-${sharedId}`, platform);
  assert.equal(exactRetry.originalText, input.text);
  const conflictingRange = winningInput.fromLine === 1
    ? { ...winningInput, fromLine: 2, throughLine: 2 } : { ...winningInput, fromLine: 1, throughLine: 1 };
  await assert.rejects(moduleB.saveConsultationBatch(W, { ...winningInput, text: "different original" }, `consultation-${sharedId}`, platform), /different original text|conflicts with this immutable Batch ID/);
  await assert.rejects(moduleB.saveConsultationBatch(W, conflictingRange, `consultation-${sharedId}`, platform), /different original text|conflicts with this immutable Batch ID/);
  await assert.rejects(moduleB.saveConsultationBatch(W, { ...winningInput, sourceName: "different metadata" }, `consultation-${sharedId}`, platform), /different original text|conflicts with this immutable Batch ID/);
  const after = await moduleA.readConsultationBatches(W, platform);
  assert.equal(after.filter(row => row.id === sharedId).length, 1);
  assert.equal(after.find(row => row.id === sharedId)?.sha256, exactRetry.sha256);
  assert.equal((rows.get(`${W}:consultation-batch.v1.${sharedId}`) as Record<string, unknown>).originalText, input.text);
});

test("full 1000-entry index rejects new IDs without evicting entries and accepts only an indexed exact retry", async () => {
  const { platform, rows } = fixture();
  const existing = await saveConsultationBatch(W, input, `consultation-${input.id}`, platform);
  const prior = await readConsultationBatches(W, platform);
  rows.set(`${W}:consultation-batches.v1`, [prior[0]!, ...fullIndexRows(MAX_CONSULTATION_BATCHES - 1, [input.id])]);
  const before = (await readConsultationBatches(W, platform)).map(entry => entry.id).sort();
  assert.equal(before.length, MAX_CONSULTATION_BATCHES);

  const exact = await saveConsultationBatch(W, input, `consultation-${input.id}`, platform);
  assert.equal(exact.originalText, existing.originalText);
  await assert.rejects(saveConsultationBatch(W, { ...input, sourceName: "changed metadata" }, `consultation-${input.id}`, platform), /different original text, selected range, or metadata|conflicts with this immutable Batch ID/);

  const newId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const newInput = { ...input, id: newId, text: "new source" };
  await assert.rejects(saveConsultationBatch(W, newInput, `consultation-${newId}`, platform), /index is full.*not published/);
  await assert.rejects(saveConsultationBatch(W, newInput, `consultation-${newId}`, platform), /index is full.*not published/);
  assert.equal(rows.has(`${W}:consultation-batch.v1.${newId}`), false);
  assert.deepEqual((await readConsultationBatches(W, platform)).map(entry => entry.id).sort(), before);
});

test("last-slot cross-instance race publishes only the winner and leaves the loser staged, never successful", async () => {
  const moduleA = await import(new URL("../src/consultation-import/batch.ts?audit-last-slot=a", import.meta.url).href) as typeof import("../src/consultation-import/batch.ts");
  const moduleB = await import(new URL("../src/consultation-import/batch.ts?audit-last-slot=b", import.meta.url).href) as typeof import("../src/consultation-import/batch.ts");
  const { platform, rows, rendezvousIndexReads } = fixture();
  const firstId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", secondId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const firstSummary = summary(firstId, input.sourceName, "b".repeat(64));
  const secondSummary = summary(secondId, input.sourceName, "c".repeat(64));
  const wireBytes = (old: readonly ReturnType<typeof summary>[], next: readonly ReturnType<typeof summary>[]) =>
    Buffer.byteLength(JSON.stringify({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder",
      stateKey: "consultation-batches.v1", expected: { exists: true, value: old }, value: next }), "utf8");
  let priorCount = MAX_CONSULTATION_BATCHES - 1;
  while (priorCount > 0 && wireBytes(fullIndexRows(priorCount), [...fullIndexRows(priorCount), firstSummary]) > MAX_CONSULTATION_CAS_WIRE_BYTES) priorCount -= 1;
  const prior = fullIndexRows(priorCount);
  assert.ok(wireBytes(prior, [...prior, firstSummary]) <= MAX_CONSULTATION_CAS_WIRE_BYTES);
  assert.ok(wireBytes(prior, [...prior, firstSummary, secondSummary]) > MAX_CONSULTATION_CAS_WIRE_BYTES);
  rows.set(`${W}:consultation-batches.v1`, prior);
  rendezvousIndexReads();
  const results = await Promise.allSettled([
    moduleA.saveConsultationBatch(W, { ...input, id: firstId, text: "slot A" }, `consultation-${firstId}`, platform),
    moduleB.saveConsultationBatch(W, { ...input, id: secondId, text: "slot B" }, `consultation-${secondId}`, platform),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1,
    JSON.stringify(results.map(result => result.status === "rejected" ? String(result.reason) : `published ${result.value.id}`)));
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const listing = await readConsultationBatches(W, platform);
  assert.equal(listing.length, priorCount + 1);
  assert.ok(prior.every(old => listing.some(row => row.id === old.id)));
  const winner = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof saveConsultationBatch>>>;
  assert.ok(listing.some(row => row.id === winner.value.id && row.sha256 === winner.value.sha256));
  const loserId = winner.value.id === firstId ? secondId : firstId;
  assert.ok(rows.has(`${W}:consultation-batch.v1.${loserId}`), "losing raw is staged after both clients observed the last slot");
  await assert.rejects(moduleB.saveConsultationBatch(W, { ...input, id: loserId, text: loserId === firstId ? "slot A" : "slot B" }, `consultation-${loserId}`, platform), /index is full|Host state limit|wire limit/);
  assert.equal((await readConsultationBatches(W, platform)).length, priorCount + 1);
});

test("raw staged before capacity fills cannot make a retry report published success", async () => {
  const { platform, rows, failIndex } = fixture();
  failIndex();
  await assert.rejects(saveConsultationBatch(W, input, `consultation-${input.id}`, platform), /outcome is uncertain/);
  assert.ok(rows.has(`${W}:consultation-batch.v1.${input.id}`));
  rows.set(`${W}:consultation-batches.v1`, fullIndexRows(MAX_CONSULTATION_BATCHES, [input.id]));
  const before = (await readConsultationBatches(W, platform)).map(entry => entry.id).sort();
  await assert.rejects(saveConsultationBatch(W, input, `consultation-${input.id}`, platform), /index is full/);
  assert.deepEqual((await readConsultationBatches(W, platform)).map(entry => entry.id).sort(), before);
  assert.ok(rows.has(`${W}:consultation-batch.v1.${input.id}`));
});
