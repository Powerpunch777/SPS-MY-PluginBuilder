import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createFreshnessHostConsumer, type FreshnessHostState } from "./host-store.ts";
import type { DocumentIdentity, FreshnessConsumerState, FreshnessEvent } from "./index.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const identity: DocumentIdentity = Object.freeze({ workspaceId, projectId: "project-1", documentId: "document-1",
  category: Object.freeze({ id: "category-1", sourceId: "category-source", sourceRevisionId: "category-r1",
    scope: Object.freeze({ id: "scope-1", revisionId: "scope-r1", approval: "unknown", evidenceRef: null }),
    allowedCategoryIds: Object.freeze(["category-1"]), listCompleteness: "unknown", listEvidenceRef: null }) });

function initialState(): FreshnessConsumerState {
  const freshness = Object.freeze({ identity, evaluatedAgainst: Object.freeze({ oldRevisionId: "rev-0", newRevisionId: "rev-1" }),
    status: "UNKNOWN" as const, causes: Object.freeze(["authority-unverified"] as const), changedSourceIds: Object.freeze([]), traceDocumentRevisionId: null });
  return Object.freeze({ identity, cursor: 0, evaluationId: "eval-0", freshness,
    approval: Object.freeze({ status: "approved", evidenceRef: "existing-approval" }), bodyRef: "body-r1",
    historyRefs: Object.freeze(["history-r1"]), processedEventIds: Object.freeze([]), processedEvents: Object.freeze([]) });
}

function event(eventId: string, evaluationId = "eval-1"): FreshnessEvent {
  const current = initialState();
  const evaluation = Object.freeze({ identity, evaluatedAgainst: Object.freeze({ oldRevisionId: "rev-1", newRevisionId: "rev-2" }),
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

function consumer(state: FreshnessHostState, maxCasAttempts?: number) {
  return createFreshnessHostConsumer({ identity, state, maxCasAttempts, verifyEvaluation: () => false });
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
