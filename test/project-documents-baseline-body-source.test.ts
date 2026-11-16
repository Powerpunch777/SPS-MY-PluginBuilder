import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createBaselineBodySource } from "../src/project-documents/baseline-body-source.ts";
import { parseDesignBaseline } from "../src/domain/design-baseline.ts";
import { createRevisionJournal } from "../src/solution-revision-store.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const keyOf = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture() {
  const values = new Map<string, JsonValue>();
  const state = {
    async get(key: SpsStateKey): Promise<JsonValue | null> {
      const value = values.get(keyOf(key));
      return value === undefined ? null : structuredClone(value);
    },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const id = keyOf(key), current = values.get(id), exists = values.has(id);
      const matches = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (matches) values.set(id, structuredClone(value));
      return { swapped: matches };
    },
  };
  return { values, state };
}

function baseline(revisionId: string, suffix: string) {
  return parseDesignBaseline({
    projectId: PROJECT,
    revisionId,
    sourceDraftRevisionId: `draft-${suffix}`,
    draftDigest: hash(`draft-${suffix}`),
    createdAt: "2026-11-06T00:00:00.000Z",
    author: {
      agentId: "44444444-4444-4444-8444-444444444444",
      sessionId: "55555555-5555-4555-8555-555555555555",
      runId: "66666666-6666-4666-8666-666666666666",
      selectionRevision: 1,
    },
    userDecision: { sourceId: "lead-turn:77777777-7777-4777-8777-777777777777", sourceSha256: hash("user input"), interpretation: "Keep the workflow clear." },
    specification: {
      projectId: PROJECT, revisionId: `spec-${suffix}`, productTier: "M",
      requirements: [{ id: "REQ-1", description: "Keep the requested workflow intact.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"], dataPolicyRef: "policy-unreviewed", approvalEvidenceRef: "lead-turn:77777777-7777-4777-8777-777777777777",
    },
    graph: {
      approvedSpecRevisionId: `spec-${suffix}`, graphRevisionId: `graph-${suffix}`,
      entities: [{ id: "feature-1", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] }],
      relations: [{ id: "rel-1", sourceId: "feature-1", targetId: "feature-1", kind: "integrates_with", contractRef: "API-1" }],
      viewLayoutRef: "layout-unreviewed",
    },
  }, PROJECT);
}

async function publishBaseline(state: ReturnType<typeof fixture>["state"], revisionId: string, suffix: string, expectedBaseRevisionId: string | null) {
  const store = createRevisionJournal(WORKSPACE, PROJECT, state, {
    prefix: "design-baseline", parse: value => parseDesignBaseline(value, PROJECT), revisionId: value => value.revisionId,
  });
  return store.publish({
    expectedBaseRevisionId, revision: baseline(revisionId, suffix),
  });
}

test("publishes deterministic document bytes from the actual immutable Baseline and reads them with pins", async () => {
  const f = fixture();
  assert.equal((await publishBaseline(f.state, "baseline-r1", "r1", null)).status, "published");
  const source = createBaselineBodySource(WORKSPACE, PROJECT, f.state);
  const published = await source.publish({ documentRevisionId: "document-r1", expectedDocumentRevisionId: null,
    expectedBaselineRevisionId: "baseline-r1" });
  assert.equal(published.status, "published");
  if (published.status !== "published") return;
  assert.equal(published.document.sourceBaselineRevisionId, "baseline-r1");
  assert.equal(published.document.sourceBaselineSequence, 1);
  assert.equal(published.document.bodySha256, hash(published.document.body));
  assert.match(published.document.body, /Keep the requested workflow intact/);
  assert.match(published.document.body, /feature-1 \(feature\); requirement REQ-1; contracts API-1/);
  assert.equal(published.document.sourcePins.length, 5);
  assert.equal(published.document.sourcePins[0]?.sha256, hash(JSON.stringify(baseline("baseline-r1", "r1"))));
  assert.equal(published.document.inventory.status, "partial");
  assert.equal(published.document.historicalApproval.status, "unknown");
  const replay = await source.publish({ documentRevisionId: "document-r1", expectedDocumentRevisionId: null,
    expectedBaselineRevisionId: "baseline-r1" });
  assert.equal(replay.status, "published");
  if (replay.status !== "published") return;
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.document, published.document);

  const read = await source.read("document-r1");
  assert.equal(read.status, "available");
  assert.equal(read.source, "current");
  assert.equal(read.bodyAvailable, true);
  assert.equal(read.document?.bodySha256, hash(read.document!.body));
  assert.equal(read.historicalApproval?.status, "unknown");
  assert.equal((await source.current())?.revision.documentRevisionId, "document-r1");
});

test("expected Baseline and document heads are CAS guards; an older intact snapshot reads stale", async () => {
  const f = fixture();
  await publishBaseline(f.state, "baseline-r1", "r1", null);
  const source = createBaselineBodySource(WORKSPACE, PROJECT, f.state);
  assert.equal((await source.publish({ documentRevisionId: "document-r1", expectedDocumentRevisionId: null,
    expectedBaselineRevisionId: "not-current" })).status, "conflict");
  assert.equal(await source.current(), null);
  assert.equal((await source.publish({ documentRevisionId: "document-r1", expectedDocumentRevisionId: null,
    expectedBaselineRevisionId: "baseline-r1" })).status, "published");
  await publishBaseline(f.state, "baseline-r2", "r2", "baseline-r1");
  const stale = await source.read("document-r1");
  assert.equal(stale.status, "available");
  assert.equal(stale.source, "stale");
  assert.equal(stale.currentBaselineRevisionId, "baseline-r2");

  assert.equal((await source.publish({ documentRevisionId: "document-r2", expectedDocumentRevisionId: null,
    expectedBaselineRevisionId: "baseline-r1" })).status, "conflict");
  assert.equal((await source.publish({ documentRevisionId: "document-r2", expectedDocumentRevisionId: "document-r1",
    expectedBaselineRevisionId: "baseline-r2" })).status, "published");
  assert.equal((await source.publish({ documentRevisionId: "document-r3", expectedDocumentRevisionId: null,
    expectedBaselineRevisionId: "baseline-r2" })).status, "conflict");
});

test("missing pinned historical Baseline bytes produce unavailable, not approval or freshness success", async () => {
  const f = fixture();
  await publishBaseline(f.state, "baseline-r1", "r1", null);
  const source = createBaselineBodySource(WORKSPACE, PROJECT, f.state);
  assert.equal((await source.publish({ documentRevisionId: "document-r1", expectedDocumentRevisionId: null,
    expectedBaselineRevisionId: "baseline-r1" })).status, "published");
  await publishBaseline(f.state, "baseline-r2", "r2", "baseline-r1");
  const historicalKey = [...f.values.keys()].find(key => key.includes("design-baseline-revision.v1."));
  assert.ok(historicalKey);
  f.values.delete(historicalKey);
  const read = await source.read("document-r1");
  assert.equal(read.status, "unavailable");
  assert.equal(read.source, "unknown");
  assert.equal(read.bodyAvailable, false);
  assert.equal(read.currentBaselineRevisionId, "baseline-r2");
});

test("lost document entry or head CAS receipts recover the same immutable body after a restart", async () => {
  for (const boundary of ["revision.v1.", "head.v1."]) {
    const f = fixture();
    await publishBaseline(f.state, "baseline-r1", "r1", null);
    const originalCas = f.state.compareAndSet;
    let injected = false;
    f.state.compareAndSet = async (key, expected, value) => {
      const receipt = await originalCas(key, expected, value);
      if (!injected && receipt.swapped && key.stateKey.includes(`project-document-baseline-${boundary}`)) {
        injected = true;
        throw new Error("Document CAS receipt lost");
      }
      return receipt;
    };
    const input = { documentRevisionId: "document-r1", expectedDocumentRevisionId: null, expectedBaselineRevisionId: "baseline-r1" };
    await assert.rejects(() => createBaselineBodySource(WORKSPACE, PROJECT, f.state).publish(input), /receipt lost/);
    assert.equal(injected, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    const restarted = createBaselineBodySource(WORKSPACE, PROJECT, f.state);
    assert.equal((await restarted.publish(input)).status, "published");
    assert.equal((await restarted.current())?.sequence, 1);
    assert.equal((await restarted.read("document-r1")).source, "current");
    assert.equal([...f.values.keys()].filter(key => key.includes("project-document-baseline-revision.v1.")).length, 1);
  }
});
