import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createFreshnessHostConsumer, type FreshnessHostState } from "./host-store.ts";
import type { DocumentIdentity, FreshnessConsumerState, FreshnessEvent } from "./index.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const identity: DocumentIdentity = Object.freeze({ workspaceId, projectId: "project-1", documentId: "document-1",
  category: Object.freeze({ id: "category-1", sourceId: "category-source", mappingType: null, mappingVersion: null, mappingEvidenceRef: null }) });

function initialState(stateIdentity: DocumentIdentity = identity): FreshnessConsumerState {
  const freshness = Object.freeze({ identity: stateIdentity, evaluatedAgainst: Object.freeze({ oldRevisionId: "rev-0", newRevisionId: "rev-1" }),
    status: "UNKNOWN" as const, causes: Object.freeze(["authority-unverified"] as const), changedSourceIds: Object.freeze([]), traceDocumentRevisionId: null });
  return Object.freeze({ identity: stateIdentity, cursor: 0, evaluationId: "eval-0", freshness,
    approval: Object.freeze({ status: "approved", evidenceRef: "existing-approval" }), bodyRef: "body-r1",
    historyRefs: Object.freeze(["history-r1"]), processedEventIds: Object.freeze([]), processedEvents: Object.freeze([]) });
}

function event(eventId: string, evaluationId = "eval-1", evaluationIdentity: DocumentIdentity = identity): FreshnessEvent {
  const current = initialState();
  const evaluation = Object.freeze({ identity: evaluationIdentity, evaluatedAgainst: Object.freeze({ oldRevisionId: "rev-1", newRevisionId: "rev-2" }),
    status: "UNKNOWN" as const, causes: Object.freeze(["authority-unverified"] as const), changedSourceIds: Object.freeze(["spec-1"]),
    traceDocumentRevisionId: null });
  return Object.freeze({ eventId, workspaceId, projectId: "project-1", sequence: 1, expectedBaseSequence: 0,
    expectedEvaluationId: current.evaluationId, expectedOldRevisionId: "rev-1", expectedNewRevisionId: "rev-2",
    expectedBaseSourceRevisionId: "rev-1", sourceRevisionId: "rev-2", eventKind: "baseline", evaluationId, evaluation });
}

function host(options: Readonly<{ withoutCas?: boolean; failGet?: number }> = {}) {
  const values = new Map<string, JsonValue>();
  const keyReads: SpsStateKey[] = [];
  let failedGets = 0;
  const state: FreshnessHostState = {
    async get(key) {
      keyReads.push(key);
      if (failedGets < (options.failGet ?? 0)) { failedGets += 1; throw new Error("Host read unavailable"); }
      const value = values.get(key.stateKey);
      return value === undefined ? null : structuredClone(value);
    },
    ...(!options.withoutCas ? { async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const current = values.get(key.stateKey);
      const matches = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value) : current === undefined;
      if (!matches) return { swapped: false };
      values.set(key.stateKey, structuredClone(value));
      return { swapped: true };
    } } : {}),
  } as FreshnessHostState;
  return { state, values, keyReads };
}

function consumer(state: FreshnessHostState, maxCasAttempts?: number, verifyEvaluation: () => boolean = () => false) {
  return createFreshnessHostConsumer({ identity, state, maxCasAttempts, verifyEvaluation });
}

test("persists only UNKNOWN evaluation and preserves existing approval and body history", async () => {
  const fake = host();
  const first = consumer(fake.state);
  const initialized = await first.initialize(initialState());
  assert.equal(initialized.status, "ready");
  const rejected = await first.consume(event("evt-unverified"));
  assert.equal(rejected.status, "evaluation-unverified");
  assert.equal((await first.read()).status, "ready");

  const verifiedConsumer = createFreshnessHostConsumer({ identity, state: fake.state, verifyEvaluation: () => true });
  const appliedOrObserved = await verifiedConsumer.consume(event("evt-persisted"));
  assert.equal(appliedOrObserved.status, "applied");
  if (appliedOrObserved.status === "applied") {
    assert.equal(appliedOrObserved.state.cursor, 1);
    assert.equal(appliedOrObserved.state.freshness.status, "UNKNOWN");
    assert.deepEqual(appliedOrObserved.state.approval, initialState().approval);
    assert.equal(appliedOrObserved.state.bodyRef, "body-r1");
    assert.deepEqual(appliedOrObserved.state.historyRefs, ["history-r1"]);
  }
  assert.equal(fake.keyReads[0].scopeKind, "company");
  assert.equal(fake.keyReads[0].scopeId, workspaceId);
  assert.equal(fake.keyReads[0].namespace, "sonpark.my-builder");
  assert.equal(fake.values.size, 1);
});

test("a lost CAS response is observed as a duplicate after recreating the consumer", async () => {
  const fake = host();
  const first = consumer(fake.state);
  await first.initialize(initialState());
  const compareAndSet = fake.state.compareAndSet!;
  let loseResponse = true;
  const lossyState: FreshnessHostState = { get: fake.state.get, compareAndSet: async (key, expected, value) => {
    const receipt = await compareAndSet(key, expected, value);
    if (receipt.swapped && loseResponse) { loseResponse = false; throw new Error("response lost after durable CAS"); }
    return receipt;
  } };
  const trusted = createFreshnessHostConsumer({ identity, state: lossyState, verifyEvaluation: () => true });
  const result = await trusted.consume(event("evt-lost-response"));
  assert.equal(result.status, "duplicate");
  const restarted = createFreshnessHostConsumer({ identity, state: fake.state, verifyEvaluation: () => true });
  const read = await restarted.read();
  assert.equal(read.status, "ready");
  if (read.status === "ready") assert.equal(read.state.cursor, 1);
});

test("concurrent same-event consumers persist one transition and return applied or duplicate", async () => {
  const fake = host();
  const first = consumer(fake.state);
  await first.initialize(initialState());
  const trustedA = createFreshnessHostConsumer({ identity, state: fake.state, verifyEvaluation: () => true });
  const trustedB = createFreshnessHostConsumer({ identity, state: fake.state, verifyEvaluation: () => true });
  const [left, right] = await Promise.all([trustedA.consume(event("evt-race")), trustedB.consume(event("evt-race"))]);
  assert.deepEqual([left.status, right.status].sort(), ["applied", "duplicate"]);
  const final = await trustedA.read();
  assert.equal(final.status, "ready");
  if (final.status === "ready") assert.equal(final.state.cursor, 1);
});

test("different events racing on the same base permit one CAS winner and stale the loser", async () => {
  const fake = host();
  await consumer(fake.state).initialize(initialState());
  const compareAndSet = fake.state.compareAndSet!;
  let callers = 0;
  let release!: () => void;
  const bothAtCas = new Promise<void>(resolve => { release = resolve; });
  const racingState: FreshnessHostState = {
    get: fake.state.get,
    compareAndSet: async (key, expected, value) => {
      callers += 1;
      if (callers === 2) release();
      if (callers <= 2) await bothAtCas;
      return compareAndSet(key, expected, value);
    },
  };
  const left = createFreshnessHostConsumer({ identity, state: racingState, verifyEvaluation: () => true });
  const right = createFreshnessHostConsumer({ identity, state: racingState, verifyEvaluation: () => true });
  const [first, second] = await Promise.all([
    left.consume(event("evt-left", "eval-left")),
    right.consume(event("evt-right", "eval-right")),
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["applied", "stale"]);
  const final = await left.read();
  assert.equal(final.status, "ready");
  if (final.status === "ready") {
    assert.equal(final.state.cursor, 1);
    assert.equal(final.state.processedEventIds.length, 1);
    assert(["evt-left", "evt-right"].includes(final.state.processedEventIds[0]));
  }
});

test("CAS-less Hosts are unsupported and transient reads recover without fallback writes", async () => {
  const noCas = host({ withoutCas: true });
  assert.equal((await consumer(noCas.state).initialize(initialState())).status, "unsupported-host");
  assert.equal(noCas.values.size, 0);

  const intermittent = host({ failGet: 1 });
  const service = consumer(intermittent.state);
  assert.equal((await service.initialize(initialState())).status, "unavailable");
  assert.equal(intermittent.values.size, 0);
  assert.equal((await service.initialize(initialState())).status, "ready");
});

test("malformed scoped Host state fails closed", async () => {
  const fake = host();
  const service = consumer(fake.state);
  const initialized = await service.initialize(initialState());
  assert.equal(initialized.status, "ready");
  const [key] = fake.keyReads;
  fake.values.set(key.stateKey, { schemaVersion: 1, workspaceId: "other", projectId: "project-1", documentId: "document-1", state: {} });
  assert.equal((await service.read()).status, "corrupt-state");
  assert.equal((await service.consume(event("evt-corrupt"))).status, "corrupt-state");
});

test("legacy category state normalizes to UNKNOWN and recovers through a verified in-place CAS", async () => {
  const fake = host();
  const service = consumer(fake.state);
  assert.equal((await service.read()).status, "empty");
  const key = fake.keyReads[0];
  const legacy = initialState();
  const legacyCategory = { id: "category-1", sourceId: "category-source", sourceRevisionId: "category-r1",
    scope: { id: "scope-1", revisionId: "scope-r1", approval: "approved", evidenceRef: "old-approval" },
    allowedCategoryIds: ["category-1"], listCompleteness: "complete", listEvidenceRef: "old-list" };
  const legacyIdentity = { workspaceId, projectId: "project-1", documentId: "document-1", category: legacyCategory };
  const raw: JsonValue = { schemaVersion: 1, workspaceId, projectId: "project-1", documentId: "document-1",
    state: { ...legacy, identity: legacyIdentity, freshness: { ...legacy.freshness, identity: legacyIdentity,
      status: "CURRENT", causes: [] } } as unknown as JsonValue };
  fake.values.set(key.stateKey, raw);
  const read = await service.read();
  assert.equal(read.status, "ready");
  if (read.status === "ready") {
    assert.equal(read.state.freshness.status, "UNKNOWN");
    assert(read.state.freshness.causes.includes("category-unverified"));
    assert.equal(read.state.identity.category.mappingVersion, null);
  }
  const mappedIdentity: DocumentIdentity = Object.freeze({ ...identity, category: Object.freeze({
    id: "category-1", sourceId: "category-source", mappingType: "workstream", mappingVersion: "mapping-v1", mappingEvidenceRef: "mapping-evidence-v1",
  }) });
  const rejected = await consumer(fake.state).consume(event("evt-unverified-mapping", "eval-unverified", mappedIdentity));
  assert.equal(rejected.status, "evaluation-unverified");
  const verifiedConsumer = createFreshnessHostConsumer({ identity, state: fake.state, verifyEvaluation: () => true });
  const recoveryEvent = event("evt-persisted", "eval-1", mappedIdentity);
  const applied = await verifiedConsumer.consume(recoveryEvent);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") {
    assert.equal(applied.state.cursor, 1);
    assert.deepEqual(applied.state.identity.category, mappedIdentity.category);
    assert.deepEqual(applied.state.approval, legacy.approval);
    assert.equal(applied.state.bodyRef, legacy.bodyRef);
    assert.deepEqual(applied.state.historyRefs, legacy.historyRefs);
  }
  const persisted = fake.values.get(key.stateKey) as unknown as { state: FreshnessConsumerState };
  assert.deepEqual(persisted.state.identity.category, mappedIdentity.category);
  assert.equal(persisted.state.cursor, 1);
  assert.deepEqual(persisted.state.processedEventIds, ["evt-persisted"]);
  assert.equal((await verifiedConsumer.consume(recoveryEvent)).status, "duplicate");
  const restarted = createFreshnessHostConsumer({ identity, state: fake.state, verifyEvaluation: () => true });
  const restartedRead = await restarted.read();
  assert.equal(restartedRead.status, "ready");
  if (restartedRead.status === "ready") {
    assert.deepEqual(restartedRead.state.identity.category, mappedIdentity.category);
    assert.deepEqual(restartedRead.state.approval, legacy.approval);
    assert.equal(restartedRead.state.bodyRef, legacy.bodyRef);
    assert.deepEqual(restartedRead.state.historyRefs, legacy.historyRefs);
  }
});

test("mapping updates require a bound verifier and cannot change persisted document or category identity", async () => {
  const fake = host();
  const v1: DocumentIdentity = Object.freeze({ ...identity, category: Object.freeze({
    id: "category-1", sourceId: "category-source", mappingType: "workstream", mappingVersion: "mapping-v1", mappingEvidenceRef: "mapping-evidence-v1",
  }) });
  const v2: DocumentIdentity = Object.freeze({ ...identity, category: Object.freeze({ ...v1.category,
    mappingVersion: "mapping-v2", mappingEvidenceRef: "mapping-evidence-v2" }) });
  const stateV1 = initialState(v1);
  assert.equal((await consumer(fake.state).initialize(stateV1)).status, "ready");
  const rejected = await consumer(fake.state, undefined, () => false).consume(event("evt-untrusted-v2", "eval-untrusted", v2));
  assert.equal(rejected.status, "evaluation-unverified");
  const afterReject = await consumer(fake.state).read();
  assert.equal(afterReject.status, "ready");
  if (afterReject.status === "ready") {
    assert.equal(afterReject.state.identity.category.mappingVersion, "mapping-v1");
    assert.equal(afterReject.state.cursor, 0);
  }

  const wrongDocument = Object.freeze({ ...v2, documentId: "another-document" });
  assert.equal((await consumer(fake.state, undefined, () => true).consume(event("evt-wrong-document", "eval-wrong-document", wrongDocument))).status, "wrong-scope");
  const wrongCategory = Object.freeze({ ...v2, category: Object.freeze({ ...v2.category, id: "another-category" }) });
  assert.equal((await consumer(fake.state, undefined, () => true).consume(event("evt-wrong-category", "eval-wrong-category", wrongCategory))).status, "wrong-scope");
  const wrongSource = Object.freeze({ ...v2, category: Object.freeze({ ...v2.category, sourceId: "another-source" }) });
  assert.equal((await consumer(fake.state, undefined, () => true).consume(event("evt-wrong-source", "eval-wrong-source", wrongSource))).status, "wrong-scope");

  const applied = await consumer(fake.state, undefined, () => true).consume(event("evt-trusted-v2", "eval-v2", v2));
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") {
    assert.equal(applied.state.identity.category.mappingVersion, "mapping-v2");
    assert.equal(applied.state.cursor, 1);
    assert.deepEqual(applied.state.approval, stateV1.approval);
    assert.equal(applied.state.bodyRef, stateV1.bodyRef);
    assert.deepEqual(applied.state.historyRefs, stateV1.historyRefs);
  }
});

test("Host consumer rejects partially present category mappings even when the verifier returns true", async () => {
  const fake = host();
  const initial = initialState();
  const service = consumer(fake.state);
  assert.equal((await service.initialize(initial)).status, "ready");
  const [key] = fake.keyReads;
  const before = structuredClone(fake.values.get(key.stateKey));
  let verifierCalls = 0;
  const partialIdentity: DocumentIdentity = Object.freeze({ ...identity, category: Object.freeze({
    id: "category-1", sourceId: "category-source", mappingType: "workstream", mappingVersion: "mapping-v1", mappingEvidenceRef: null,
  }) });
  const trusted = createFreshnessHostConsumer({ identity, state: fake.state, verifyEvaluation() {
    verifierCalls += 1;
    return true;
  } });

  const result = await trusted.consume(event("evt-partial-mapping", "eval-partial", partialIdentity));
  assert.equal(result.status, "evaluation-unverified");
  assert.equal(verifierCalls, 0);
  assert.deepEqual(fake.values.get(key.stateKey), before);
  const read = await trusted.read();
  assert.equal(read.status, "ready");
  if (read.status === "ready") {
    assert.equal(read.state.cursor, 0);
    assert.deepEqual(read.state.approval, initial.approval);
    assert.equal(read.state.bodyRef, initial.bodyRef);
    assert.deepEqual(read.state.historyRefs, initial.historyRefs);
  }
});

test("legacy evaluation category mismatch is corrupt instead of being silently normalized", async () => {
  const fake = host();
  const service = consumer(fake.state);
  await service.read();
  const [key] = fake.keyReads;
  const legacyCategory = { id: "category-1", sourceId: "category-source", sourceRevisionId: "category-r1",
    scope: { id: "scope-1", revisionId: "scope-r1", approval: "approved", evidenceRef: "old-approval" },
    allowedCategoryIds: ["category-1"], listCompleteness: "complete", listEvidenceRef: "old-list" };
  const otherCategory = { ...legacyCategory, id: "different-category", allowedCategoryIds: ["different-category"] };
  const row = initialState();
  const raw: JsonValue = { schemaVersion: 1, workspaceId, projectId: "project-1", documentId: "document-1",
    state: { ...row, identity: { ...identity, category: legacyCategory }, freshness: { ...row.freshness,
      identity: { ...identity, category: otherCategory } } } as unknown as JsonValue };
  fake.values.set(key.stateKey, raw);
  assert.equal((await service.read()).status, "corrupt-state");
  assert.deepEqual(fake.values.get(key.stateKey), raw);
});

test("oversized consumer state is rejected before any Host CAS write", async () => {
  const fake = host();
  const service = consumer(fake.state);
  const oversized = Object.freeze({ ...initialState(), historyRefs: Object.freeze(Array.from({ length: 3_000 }, (_, index) => `history-${index}-${"x".repeat(80)}`)) });
  await assert.rejects(service.initialize(oversized), /exceeds 192 KiB/u);
  assert.equal(fake.values.size, 0);
});

test("an oversized but otherwise valid persisted Host state fails closed on read and consume", async () => {
  const fake = host();
  const service = consumer(fake.state);
  assert.equal((await service.read()).status, "empty");
  const key = fake.keyReads[0];
  const oversized = Object.freeze({ ...initialState(), historyRefs: Object.freeze(Array.from(
    { length: 3_000 }, (_, index) => `history-${index}-${"x".repeat(80)}`)) });
  const raw: JsonValue = { schemaVersion: 1, workspaceId, projectId: "project-1", documentId: "document-1",
    state: oversized as unknown as JsonValue };
  assert(Buffer.byteLength(JSON.stringify(raw), "utf8") > 192 * 1024);
  fake.values.set(key.stateKey, raw);
  assert.equal((await service.read()).status, "corrupt-state");
  assert.equal((await service.consume(event("evt-overlarge"))).status, "corrupt-state");
});

test("initial CURRENT assertions are rejected without source-backed event verification", async () => {
  const fake = host();
  const service = consumer(fake.state);
  const current = Object.freeze({ ...initialState(), freshness: Object.freeze({ ...initialState().freshness,
    status: "CURRENT" as const, causes: Object.freeze([]) }) });
  await assert.rejects(service.initialize(current), /initialize as UNKNOWN/u);
  assert.equal(fake.values.size, 0);
});
