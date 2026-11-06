import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createReuseFirstStore, parseReuseFirstRevision, type ReuseFirstScope, type ReuseFirstSourceReader, type ReuseFirstState } from "../src/reuse-first/index.ts";

const workspaceA = "a1234567-b89c-4123-8123-123456789abc";
const workspaceB = "b1234567-b89c-4123-8123-123456789abc";
const projectA = { workspaceId: workspaceA, projectId: "project-a" };
const projectB = { workspaceId: workspaceA, projectId: "project-b" };
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const excerptText = "A persisted Lead turn describing a proposed reusable component.";
const candidate = (change: Record<string, unknown> = {}) => ({ candidateId: "candidate-1", name: "Shared utility proposal",
  kind: "code", originUrl: "https://example.test/project", originVersion: "v1.2.3",
  source: { sourceId: "lead-turn-1", fromLine: 4, throughLine: 8 }, productTier: "M", route: "ASSEMBLY",
  deliveryTargets: ["web-api"], ...change });

function fixture() {
  const values = new Map<string, JsonValue>();
  const address = (key: SpsStateKey) => JSON.stringify(key);
  const state: ReuseFirstState = {
    async get(key) { const value = values.get(address(key)); return value === undefined ? null : structuredClone(value); },
    async compareAndSet(key, expected, next) {
      const keyAddress = address(key), old = values.get(keyAddress);
      const matches = expected.exists ? old !== undefined && JSON.stringify(old) === JSON.stringify(expected.value) : old === undefined;
      if (matches) values.set(keyAddress, structuredClone(next));
      return { swapped: matches };
    },
  };
  let readerScope: ReuseFirstScope = { ...projectA };
  let excerpt: any = { workspaceId: workspaceA, projectId: "project-a", sourceId: "lead-turn-1", fromLine: 4,
    throughLine: 8, sha256: hash(excerptText), text: excerptText };
  const reader: ReuseFirstSourceReader = {
    async currentScope() { return { ...readerScope }; },
    async readCurrentExcerpt() { return excerpt && structuredClone(excerpt); },
  };
  return { state, values, reader, setScope(value: ReuseFirstScope) { readerScope = value; }, setExcerpt(value: unknown) { excerpt = value; } };
}

test("publishes project-bound current-source evidence but never grants reuse from an unverified license", async () => {
  const f = fixture();
  const store = createReuseFirstStore(projectA, f.state, f.reader);
  const result = await store.publish({ expectedRevisionId: null, revisionId: randomUUID(), candidate: candidate() });
  assert.equal(result.status, "published");
  if (result.status !== "published") return;
  const saved = result.revision.candidates[0]!;
  assert.deepEqual(saved.scope, projectA);
  assert.equal(saved.source.sha256, hash(excerptText));
  assert.match(saved.source.quote, /persisted Lead turn/);
  assert.deepEqual(saved.license, { status: "unknown", evidenceRefs: [] });
  assert.deepEqual(saved.reuse, { status: "blocked-unverified", reusableAcrossProjects: false });
  assert.equal(saved.product.tier, "M");
  assert.equal(saved.product.route, "ASSEMBLY");
  assert.deepEqual(saved.product.deliveryTargets, ["web-api"]);
  assert.equal((await createReuseFirstStore(projectA, f.state, f.reader).current())?.revision.candidates.length, 1);
  assert.equal(await createReuseFirstStore(projectB, f.state, f.reader).current(), null);
});

test("rejects wrong Workspace/project provenance and caller-forged license or eligibility claims", async () => {
  const f = fixture();
  const store = createReuseFirstStore(projectA, f.state, f.reader);
  f.setScope(projectB);
  assert.deepEqual(await store.publish({ expectedRevisionId: null, revisionId: randomUUID(), candidate: candidate() }),
    { status: "unverified", reason: "source-scope-mismatch" });
  f.setScope(projectA);
  f.setExcerpt({ workspaceId: workspaceA, projectId: "project-b", sourceId: "lead-turn-1", fromLine: 4,
    throughLine: 8, sha256: "a".repeat(64), text: "foreign project" });
  assert.deepEqual(await store.publish({ expectedRevisionId: null, revisionId: randomUUID(), candidate: candidate() }),
    { status: "unverified", reason: "current-project-source-evidence-required" });
  await assert.rejects(() => store.publish({ expectedRevisionId: null, revisionId: randomUUID(),
    candidate: candidate({ licenseStatus: "permissive", reusableAcrossProjects: true }) }), /fields/);
  assert.equal(await store.current(), null);
});

test("separates customer evidence journals and prevents stale concurrent publish", async () => {
  const f = fixture();
  const a = createReuseFirstStore(projectA, f.state, f.reader);
  const b = createReuseFirstStore(projectB, f.state, f.reader);
  const [left, right] = await Promise.all([
    a.publish({ expectedRevisionId: null, revisionId: randomUUID(), candidate: candidate() }),
    a.publish({ expectedRevisionId: null, revisionId: randomUUID(), candidate: candidate({ candidateId: "candidate-2" }) }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), ["conflict", "published"]);
  assert.equal((await a.current())?.revision.candidates.length, 1);
  f.setScope(projectB);
  f.setExcerpt({ workspaceId: workspaceA, projectId: "project-b", sourceId: "lead-turn-1", fromLine: 4,
    throughLine: 8, sha256: hash("A separate synthetic customer project source."), text: "A separate synthetic customer project source." });
  const separate = await b.publish({ expectedRevisionId: null, revisionId: randomUUID(), candidate: candidate({ candidateId: "candidate-b" }) });
  assert.equal(separate.status, "published");
  assert.equal((await a.current())?.revision.candidates[0]?.candidateId === "candidate-b", false);
  assert.equal((await b.current())?.revision.candidates[0]?.scope.projectId, "project-b");
  const otherCustomerScope = { workspaceId: workspaceB, projectId: "project-a" };
  f.setScope(otherCustomerScope);
  f.setExcerpt({ workspaceId: workspaceB, projectId: "project-a", sourceId: "lead-turn-1", fromLine: 4,
    throughLine: 8, sha256: hash("Another synthetic customer's isolated source."), text: "Another synthetic customer's isolated source." });
  const otherCustomer = await createReuseFirstStore(otherCustomerScope, f.state, f.reader)
    .publish({ expectedRevisionId: null, revisionId: randomUUID(), candidate: candidate({ candidateId: "other-customer-item" }) });
  assert.equal(otherCustomer.status, "published");
  assert.equal((await createReuseFirstStore(otherCustomerScope, f.state, f.reader).current())?.revision.candidates[0]?.scope.workspaceId, workspaceB);
});

test("requires bounded safe inputs and fails closed when atomic CAS is unavailable", async () => {
  const f = fixture();
  const store = createReuseFirstStore(projectA, f.state, f.reader);
  await assert.rejects(() => store.publish({ expectedRevisionId: null, revisionId: randomUUID(),
    candidate: candidate({ originUrl: "http://example.test" }) }), /HTTPS/);
  await assert.rejects(() => store.publish({ expectedRevisionId: null, revisionId: randomUUID(),
    candidate: candidate({ deliveryTargets: ["web-api", "web-api"] }) }), /Duplicate/);
  const accessorTargets = ["web-api"];
  Object.defineProperty(accessorTargets, "0", { enumerable: true, get: () => "web-api" });
  await assert.rejects(() => store.publish({ expectedRevisionId: null, revisionId: randomUUID(),
    candidate: candidate({ deliveryTargets: accessorTargets }) }), /delivery targets/);
  assert.throws(() => createReuseFirstStore(projectA, { get: f.state.get }, f.reader), /compareAndSet/);
  assert.equal(await store.current(), null);
});

test("server rejects an excerpt whose bytes do not match the stored source digest", async () => {
  const f = fixture();
  const result = await createReuseFirstStore(projectA, f.state, f.reader)
    .publish({ expectedRevisionId: null, revisionId: randomUUID(), candidate: candidate() });
  assert.equal(result.status, "published");
  if (result.status !== "published") throw new Error("Publication did not return the stored revision.");
  const tampered = { ...result.revision, candidates: result.revision.candidates.map(item =>
    ({ ...item, source: { ...item.source, quote: "Different bytes, same reported hash." } })) };
  assert.throws(() => parseReuseFirstRevision(tampered, projectA), /source evidence is invalid/);
});

test("the store accepts an exact 32 KiB excerpt and rejects the next byte without publication", async () => {
  const input = candidate({ source: { sourceId: "lead-turn-1", fromLine: 1, throughLine: 1 } });
  for (const size of [32 * 1024, 32 * 1024 + 1]) {
    const f = fixture();
    const quote = "x".repeat(size);
    f.setExcerpt({ ...projectA, sourceId: "lead-turn-1", fromLine: 1, throughLine: 1, text: quote, sha256: hash(quote) });
    const store = createReuseFirstStore(projectA, f.state, f.reader);
    const result = await store.publish({ expectedRevisionId: null, revisionId: randomUUID(), candidate: input });
    assert.equal(result.status, size === 32 * 1024 ? "published" : "unverified");
    if (size > 32 * 1024) assert.equal(await store.current(), null);
  }
});
