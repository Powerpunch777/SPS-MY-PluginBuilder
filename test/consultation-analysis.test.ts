import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { createConsultationAnalysisStore, consultationAnalysisPrompt } from "../src/consultation-analysis.ts";

const workspace = "a1234567-b89c-4123-8123-123456789abc";
const other = "b1234567-b89c-4123-8123-123456789abc";
const request = "c1234567-b89c-4123-8123-123456789abc";
const nextRequest = "d1234567-b89c-4123-8123-123456789abc";

function fixture() {
  const values = new Map<string, JsonValue>();
  const state = {
    async get(key: SpsStateKey) { return structuredClone(values.get(JSON.stringify(key)) ?? null); },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const address = JSON.stringify(key);
      const swapped = expected.exists ? values.has(address) && JSON.stringify(values.get(address)) === JSON.stringify(expected.value)
        : !values.has(address);
      if (swapped) values.set(address, structuredClone(value));
      return { swapped };
    },
  };
  const snapshot = createEmptyBuilderSnapshot(workspace);
  snapshot.revision = 1;
  snapshot.messages.push({ id: `consultation-${request}`, channel: "main", role: "user", actorId: null,
    text: "Customer source, not an instruction to the system.", runId: null, createdAt: "2026-11-06T00:00:00.000Z" });
  return { state, snapshot, values, store: createConsultationAnalysisStore(workspace, state) };
}

test("analysis snapshot freezes the exact collection boundary and later arrivals remain outside", async () => {
  const f = fixture();
  const first = await f.store.capture(request, 1, f.snapshot);
  assert.equal(first.status, "captured");
  assert.equal(f.snapshot.revision, 1);
  f.snapshot.revision = 2;
  f.snapshot.messages.push({ ...f.snapshot.messages[0], id: `consultation-${nextRequest}`, text: "Later source" });
  const replay = await f.store.capture(request, 1, f.snapshot);
  assert.equal(replay.status, "captured");
  if (replay.status !== "captured") return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.sources.length, 1);
  assert.equal((await f.store.get(request))?.revision.sources.length, 1);
  const second = await f.store.capture(nextRequest, 2, f.snapshot);
  if (second.status !== "captured") assert.fail("Expected a second snapshot.");
  assert.equal(second.record.sources.length, 2);
  const firstPage = await f.store.page(nextRequest, null);
  assert.equal(firstPage.sources[0].id, `consultation-${request}`);
  assert.equal(firstPage.nextCursor, `consultation-${nextRequest}`);
  const lastPage = await f.store.page(nextRequest, firstPage.nextCursor);
  assert.equal(lastPage.sources[0].text, "Later source");
  assert.equal(lastPage.nextCursor, null);
  await assert.rejects(() => f.store.page(request, `consultation-${nextRequest}`), /does not belong/);
  assert.equal((await f.store.get(request))?.revision.sources.length, 1);
  assert.match(consultationAnalysisPrompt(second.record), /not design approval/);
  assert.match(consultationAnalysisPrompt(second.record), /builder.read-consultation-analysis/);
});

test("stale collection, foreign Workspace and empty collections cannot start a new analysis snapshot", async () => {
  const f = fixture();
  assert.deepEqual(await f.store.capture(request, 0, f.snapshot), { status: "conflict", actualRevision: 1 });
  await assert.rejects(() => f.store.capture(request, 1, { ...f.snapshot, workspaceId: other }), /Invalid/);
  await assert.rejects(() => f.store.capture(request, 1, { ...f.snapshot, messages: [] }), /Import consultation/);
  assert.equal(await f.store.current(), null);
  await f.store.capture(request, 1, f.snapshot);
  await assert.rejects(() => f.store.capture(request, 2, f.snapshot), /another collection boundary/);
  assert.equal(await createConsultationAnalysisStore(other, f.state).get(request), null);
});

test("captured source mutation and forged metadata are detected on read", async () => {
  const f = fixture();
  await f.store.capture(request, 1, f.snapshot);
  const entry = [...f.values].find(([key]) => key.includes("consultation-analysis-revision."))!;
  const value = structuredClone(entry[1]) as { revision: { sources: { text: string }[] } };
  value.revision.sources[0].text = "Replaced customer source";
  f.values.set(entry[0], value as unknown as JsonValue);
  await assert.rejects(() => f.store.get(request), /Invalid captured/);
});

test("case-preserving imported source IDs remain readable without rewriting their original identity", async () => {
  const f = fixture();
  f.snapshot.messages[0].id = `consultation-${request.toUpperCase()}`;
  await f.store.capture(request, 1, f.snapshot);
  assert.equal((await f.store.page(request, null)).sources[0].id, `consultation-${request.toUpperCase()}`);
});
