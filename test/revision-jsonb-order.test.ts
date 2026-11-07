import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createRevisionJournal, type RevisionState } from "../src/solution-revision-store.ts";

const W = "11111111-1111-4111-8111-111111111111", P = "jsonb-project";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const keyId = (key: SpsStateKey) => JSON.stringify([key.scopeId, key.namespace, key.stateKey]);
function jsonb(value: any): any {
  if (Array.isArray(value)) return value.map(jsonb);
  return value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonb(value[key])])) : value;
}
type Revision = { revisionId: string; payload: Record<string, unknown> };
function fixture() {
  const values = new Map<string, JsonValue>();
  let blockHead = false;
  const state: RevisionState = {
    async get(key) { return values.has(keyId(key)) ? jsonb(values.get(keyId(key))) : null; },
    async compareAndSet(key, expected, value) {
      const id = keyId(key), prior = values.get(id);
      const matches = expected.exists ? values.has(id) && JSON.stringify(jsonb(prior)) === JSON.stringify(jsonb(expected.value)) : !values.has(id);
      const swapped = matches && !(blockHead && key.stateKey.startsWith("jsonb-head"));
      if (swapped) values.set(id, jsonb(value));
      return { swapped };
    },
  };
  const store = () => createRevisionJournal<Revision>(W, P, state, { prefix: "jsonb", revisionId: value => value.revisionId,
    parse(value) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, "revisionId") || !Object.hasOwn(value, "payload")) throw new TypeError("Invalid test revision");
      return value as Revision;
    } });
  return { values, state, store, block(value: boolean) { blockHead = value; } };
}
const revision = (id: string) => ({ revisionId: id, payload: { z: { omega: 2, alpha: 1 }, a: [{ right: 1, left: 2 }],
  "__literal__": { "10": "ten", "2": "two", value: "line\nquote\"" } } });

test("new journal entries retain exact revision JSON across reordered JSONB, restart and history", async () => {
  const f = fixture(), first = revision("one");
  assert.equal((await f.store().publish({ expectedBaseRevisionId: null, revision: first })).status, "published");
  const loaded = await f.store().current();
  assert.equal(JSON.stringify(loaded!.revision), JSON.stringify(first));
  assert.equal((await f.store().publish({ expectedBaseRevisionId: "one", revision: revision("two") })).status, "published");
  const page = await f.store().publishedPage(null, 1);
  const next = await f.store().publishedPage(page.nextCursor, 1);
  assert.equal(JSON.stringify(page.revisions[0]!.revision), JSON.stringify(first));
  assert.equal(next.revisions[0]!.revision.revisionId, "two");
  const stored = [...f.values.values()].find((row: any) => row.schemaVersion === 2) as any;
  assert.ok(stored.revision.payload, "existing Core proof paths retain the object-shaped revision");
  assert.equal(typeof stored.revisionJson, "undefined", "ordering metadata does not duplicate all revision values");
});

test("staged-entry reconciliation preserves original revision bytes after a lost or rejected head write", async () => {
  const f = fixture(), input = revision("one");
  f.block(true);
  assert.equal((await f.store().publish({ expectedBaseRevisionId: null, revision: input })).status, "conflict");
  const staged = await f.store().stagedRevision("one", null);
  assert.equal(staged.status, "staged");
  if (staged.status === "staged") assert.equal(JSON.stringify(staged.revision), JSON.stringify(input));
  f.block(false);
  assert.equal((await f.store().publish({ expectedBaseRevisionId: null, revision: input })).status, "published");
  assert.equal(JSON.stringify((await f.store().current())!.revision), JSON.stringify(input));
});

test("ordering corruption and accessors are rejected without invoking getters or repairing state", async () => {
  const f = fixture();
  await f.store().publish({ expectedBaseRevisionId: null, revision: revision("one") });
  const [entryKey, original] = [...f.values].find(([, row]: any) => row.schemaVersion === 2)!;
  for (const mutation of [(row: any) => { row.revisionOrder[0].reverse(); },
    (row: any) => { row.revisionOrder.push([]); }, (row: any) => { row.revisionOrder[0][0] = "missing"; },
    (row: any) => { row.revision.payload.z.omega = 99; }]) {
    const corrupted = structuredClone(original) as any;
    mutation(corrupted); f.values.set(entryKey, corrupted);
    await assert.rejects(() => f.store().current(), /revision|order/);
    assert.equal(f.values.get(entryKey), corrupted);
  }
  let reads = 0;
  const corrupted = structuredClone(original) as any;
  Object.defineProperty(corrupted.revisionOrder, "0", { enumerable: true, get() { reads++; return []; } });
  // Bypass the JSONB fixture's own serializer to target the journal's decoder.
  const state = { ...f.state, async get(key: SpsStateKey) { return keyId(key) === entryKey ? corrupted : f.state.get(key); } };
  const store = createRevisionJournal<Revision>(W, P, state, { prefix: "jsonb", revisionId: row => row.revisionId, parse: row => row as Revision });
  await assert.rejects(() => store.current(), /revision|order/);
  assert.equal(reads, 0);
});

test("legacy v1 bytes remain readable without rewriting their digest, IDs or storage keys", async () => {
  const f = fixture(), first = revision("legacy");
  const body = { schemaVersion: 1, workspaceId: W, projectId: P, sequence: 1, parent: null, revision: first };
  const digest = sha(JSON.stringify(body));
  const head = { revisionId: first.revisionId, sequence: 1, digest };
  const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey });
  const entries = new Map<string, unknown>([[keyId(key(`jsonb-head.v1.${sha(P)}`)), head],
    [keyId(key(`jsonb-revision.v1.${sha(P)}.${sha(first.revisionId)}`)), { ...body, digest }]]);
  let writes = 0;
  const state: RevisionState = { async get(key) { return structuredClone(entries.get(keyId(key)) ?? null) as JsonValue | null; },
    async compareAndSet() { writes++; return { swapped: false }; } };
  const store = createRevisionJournal<Revision>(W, P, state, { prefix: "jsonb", revisionId: row => row.revisionId, parse: row => row as Revision });
  assert.equal(JSON.stringify((await store.current())!.revision), JSON.stringify(first));
  assert.equal(writes, 0); assert.equal(head.digest, digest);
});
