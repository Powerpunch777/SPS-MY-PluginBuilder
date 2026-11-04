import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeFreshnessEvent,
  evaluateDocumentFreshness,
  recommendAffectedDocument,
  type DocumentFreshnessInput,
  type DocumentSourcePin,
  type FreshnessConsumerState,
  type FreshnessEvaluation,
  type FreshnessEvent,
  type FreshnessEvaluationClaim,
  type FreshnessEvidenceClaim,
} from "./index.ts";

const category = Object.freeze({
  id: "category-from-documents", sourceId: "category-source",
  mappingType: "workstream", mappingVersion: "test-mapping-v1", mappingEvidenceRef: "mapping:workstream:v1",
});
const identity = Object.freeze({ workspaceId: "w-1", projectId: "p-1", documentId: "d-1", category });
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const pinA: DocumentSourcePin = Object.freeze({ sourceId: "spec", revisionId: "r1", sourceSha256: hashA });
const pinB: DocumentSourcePin = Object.freeze({ sourceId: "spec", revisionId: "r2", sourceSha256: hashB });
const snapshot = (revisionId: string, pins: readonly DocumentSourcePin[]) => ({
  revisionId, pins,
  source: { status: "available" as const, evidenceRef: `${revisionId}:source` },
  access: { status: "granted" as const, evidenceRef: `${revisionId}:access` },
  coverage: { status: "complete" as const, evidenceRef: `${revisionId}:coverage` },
});

function input(overrides: Partial<DocumentFreshnessInput> = {}): DocumentFreshnessInput {
  return {
    identity,
    authority: { evidenceRef: "authority:1" },
    revisions: { old: snapshot("old", [pinA]), new: snapshot("new", [pinA]) },
    trace: { documentId: "d-1", categoryId: category.id, documentRevisionId: "doc-r1", availability: "complete", evidenceRef: "trace:1", dependencies: [pinA] },
    ...overrides,
  };
}
const verify = (value = input(), verifier: (claim: FreshnessEvidenceClaim) => boolean = () => true) => evaluateDocumentFreshness(value, verifier);

function baseState(): FreshnessConsumerState {
  return Object.freeze({
    identity, cursor: 0, evaluationId: "eval-0", freshness: verify(),
    approval: Object.freeze({ status: "approved", evidenceRef: "approval:existing" }),
    bodyRef: "body:old", historyRefs: Object.freeze(["history:1"]), processedEventIds: Object.freeze([]), processedEvents: Object.freeze([]),
  });
}
function event(state: FreshnessConsumerState, sequence: number, eventId: string, evaluation?: FreshnessEvaluation): FreshnessEvent {
  const oldRevisionId = state.freshness.evaluatedAgainst.newRevisionId;
  const boundEvaluation = evaluation ?? { ...state.freshness, evaluatedAgainst: { oldRevisionId, newRevisionId: oldRevisionId } };
  const newRevisionId = boundEvaluation.evaluatedAgainst.newRevisionId;
  return {
    eventId, workspaceId: "w-1", projectId: "p-1", sequence,
    expectedBaseSequence: state.cursor, expectedEvaluationId: state.evaluationId,
    expectedOldRevisionId: oldRevisionId, expectedNewRevisionId: newRevisionId,
    expectedBaseSourceRevisionId: oldRevisionId, sourceRevisionId: newRevisionId,
    eventKind: "analysis", evaluationId: `eval-${sequence}`, evaluation: boundEvaluation,
  };
}
const trustedTestVerifier = (_claim: FreshnessEvaluationClaim) => true;

test("complete trace proves unaffected; a changed traced pin yields a review recommendation", () => {
  assert.equal(verify().status, "CURRENT");
  const changed = verify(input({ revisions: { old: snapshot("old", [pinA]), new: snapshot("new", [pinB]) } }));
  assert.equal(changed.status, "AFFECTED");
  assert.deepEqual(changed.changedSourceIds, ["spec"]);
  assert.equal(recommendAffectedDocument(changed, { status: "approved", evidenceRef: "approval:old" })?.action, "review");
  assert.equal(recommendAffectedDocument(verify(), { status: "pending", evidenceRef: null }), null);
});

test("missing trace, authority, access, source, and index evidence stay UNKNOWN", () => {
  assert.equal(verify(input({ trace: null })).status, "UNKNOWN");
  assert.equal(verify(input({ authority: { evidenceRef: null } })).status, "UNKNOWN");
  for (const availability of ["access-denied", "source-unavailable", "index-incomplete", "missing"] as const) {
    assert.equal(verify(input({ trace: { documentId: "d-1", categoryId: category.id, documentRevisionId: "doc-r1", availability, evidenceRef: "trace:1", dependencies: [pinA] } })).status, "UNKNOWN");
  }
});

test("logical category tags need a verified server mapping, not user approval or a complete registry", () => {
  assert.equal(verify().status, "CURRENT");
  const missingMapping = { ...category, mappingType: null, mappingVersion: null, mappingEvidenceRef: null };
  const missing = verify(input({ identity: { ...identity, category: missingMapping } }));
  assert.equal(missing.status, "UNKNOWN");
  assert(missing.causes.includes("category-unverified"));

  const claims: FreshnessEvidenceClaim[] = [];
  const mismatched = verify(input(), claim => { claims.push(claim); return claim.kind !== "category-mapping"; });
  assert.equal(mismatched.status, "UNKNOWN");
  const mapping = claims.find(claim => claim.kind === "category-mapping");
  assert(mapping && mapping.kind === "category-mapping");
  assert.equal(mapping.documentRevisionId, "doc-r1");
  assert.equal(mapping.sourceId, "category-source");
  assert.equal(mapping.type, "workstream");
  assert.equal(mapping.mappingVersion, "test-mapping-v1");
});

test("a verified complete empty trace proves unaffected despite unrelated changes", () => {
  const result = verify(input({ revisions: { old: snapshot("old", [pinA]), new: snapshot("new", [pinB]) }, trace: {
    documentId: "d-1", categoryId: category.id, documentRevisionId: "doc-r1", availability: "complete", evidenceRef: "trace:empty", dependencies: [],
  } }));
  assert.equal(result.status, "CURRENT");
  assert.deepEqual(result.changedSourceIds, ["spec"]);
});

test("duplicate pins and stale dependency pins cannot prove freshness", () => {
  assert.throws(() => verify(input({ revisions: { old: snapshot("old", [pinA, pinA]), new: snapshot("new", [pinA]) } })), /duplicate source IDs/u);
  const result = verify(input({ revisions: { old: snapshot("old", [pinA]), new: snapshot("new", [pinB]) }, trace: {
    documentId: "d-1", categoryId: category.id, documentRevisionId: "doc-r1", availability: "complete", evidenceRef: "trace:stale", dependencies: [{ ...pinA, sourceSha256: "c".repeat(64) }],
  } }));
  assert.equal(result.status, "UNKNOWN");
});

test("verifier claims bind exact category, snapshots, trace, and compared revisions", () => {
  const claims: FreshnessEvidenceClaim[] = [];
  assert.equal(verify(input(), claim => { claims.push(claim); return true; }).status, "CURRENT");
  const snapshotClaim = claims.find(claim => claim.kind === "snapshot-source" && claim.side === "old");
  assert(snapshotClaim && snapshotClaim.kind === "snapshot-source");
  assert.equal(snapshotClaim.revisionId, "old");
  assert.deepEqual(snapshotClaim.pins, [pinA]);
  const traceClaim = claims.find(claim => claim.kind === "document-trace");
  assert(traceClaim && traceClaim.kind === "document-trace");
  assert.equal(traceClaim.workspaceId, "w-1");
  assert.equal(traceClaim.oldRevisionId, "old");
  assert.equal(traceClaim.newRevisionId, "new");
  assert.deepEqual(traceClaim.dependencies, [pinA]);
  assert.equal(verify(input(), claim => claim.kind !== "snapshot-coverage").status, "UNKNOWN");
});

test("event consumer handles CAS, ordering, duplicate payload fingerprints, and stale bindings", () => {
  const state = baseState();
  const first = event(state, 1, "evt-1");
  const applied = consumeFreshnessEvent(state, first, trustedTestVerifier);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.equal(consumeFreshnessEvent(applied.state, first, trustedTestVerifier).status, "duplicate");
  const rehydrated = JSON.parse(JSON.stringify(applied.state)) as FreshnessConsumerState;
  assert.equal(consumeFreshnessEvent(rehydrated, first, trustedTestVerifier).status, "duplicate");
  assert.equal(rehydrated.cursor, 1);
  assert.equal(consumeFreshnessEvent(applied.state, { ...first, eventKind: "qa" }, trustedTestVerifier).status, "duplicate-mismatch");
  assert.equal(consumeFreshnessEvent(applied.state, event(applied.state, 3, "evt-3"), trustedTestVerifier).status, "out-of-order");
  assert.equal(consumeFreshnessEvent(applied.state, event(applied.state, 1, "evt-old"), trustedTestVerifier).status, "stale");
  assert.equal(consumeFreshnessEvent(applied.state, { ...event(applied.state, 2, "evt-2"), expectedEvaluationId: "other" }, trustedTestVerifier).status, "conflict");
  const nextRevision = verify(input({ revisions: { old: snapshot("new", [pinA]), new: snapshot("newer", [pinB]) } }));
  const advanced = consumeFreshnessEvent(applied.state, event(applied.state, 2, "evt-advance", nextRevision), trustedTestVerifier);
  assert.equal(advanced.status, "applied");
  if (advanced.status === "applied") assert.deepEqual(advanced.state.freshness.evaluatedAgainst, { oldRevisionId: "new", newRevisionId: "newer" });
  assert.equal(state.cursor, 0);
});

test("revision and scope mismatches are rejected; approved body and history remain unchanged", () => {
  const state = baseState();
  assert.equal(consumeFreshnessEvent(state, { ...event(state, 1, "bad-cas"), expectedOldRevisionId: "other" }, trustedTestVerifier).status, "conflict");
  assert.equal(consumeFreshnessEvent(state, { ...event(state, 1, "bad-eval"), evaluation: { ...state.freshness, evaluatedAgainst: { oldRevisionId: "new", newRevisionId: "other" } } }, trustedTestVerifier).status, "stale-evaluation");
  assert.equal(consumeFreshnessEvent(state, { ...event(state, 1, "bad-source"), sourceRevisionId: "other" }, trustedTestVerifier).status, "stale-evaluation");
  assert.equal(consumeFreshnessEvent(state, { ...event(state, 1, "bad-scope"), evaluation: { ...event(state, 1, "bad-scope").evaluation, identity: { ...identity, documentId: "other" } } }, trustedTestVerifier).status, "wrong-scope");
  assert.throws(() => consumeFreshnessEvent(state, { ...event(state, 1, "bad-kind"), eventKind: "intake" as FreshnessEvent["eventKind"] }, trustedTestVerifier), /eventKind/u);
  const changed = verify(input({ revisions: { old: snapshot("new", [pinA]), new: snapshot("newer", [pinB]) } }));
  const applied = consumeFreshnessEvent(state, event(state, 1, "evt-change", changed), trustedTestVerifier);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.state.approval, state.approval);
  assert.equal(applied.state.bodyRef, "body:old");
  assert.deepEqual(applied.state.historyRefs, ["history:1"]);
});

test("consumer requires trusted verification of the entire evaluation binding", () => {
  const state = baseState();
  const candidate = event(state, 1, "evt-verified");
  const claims: FreshnessEvaluationClaim[] = [];
  assert.equal(consumeFreshnessEvent(state, candidate, claim => { claims.push(claim); return true; }).status, "applied");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, "freshness-evaluation");
  assert.deepEqual(claims[0].evaluatedAgainst, { oldRevisionId: "new", newRevisionId: "new" });
  assert.deepEqual(claims[0].identity, identity);
  assert.equal(consumeFreshnessEvent(state, candidate, () => false).status, "evaluation-unverified");
  assert.equal(consumeFreshnessEvent(state, candidate, () => { throw new Error("unavailable"); }).status, "evaluation-unverified");
  assert.equal(consumeFreshnessEvent(state, candidate, undefined as unknown as (claim: FreshnessEvaluationClaim) => boolean).status, "evaluation-unverified");
  assert.equal(state.cursor, 0);
});

test("trusted evaluations recover legacy mappings and accept verified mapping version changes", () => {
  const unmappedIdentity = Object.freeze({ ...identity, category: Object.freeze({
    id: category.id, sourceId: category.sourceId, mappingType: null, mappingVersion: null, mappingEvidenceRef: null,
  }) });
  const legacyState: FreshnessConsumerState = Object.freeze({
    ...baseState(), identity: unmappedIdentity,
    freshness: verify(input({ identity: unmappedIdentity })),
  });
  assert.equal(legacyState.freshness.status, "UNKNOWN");
  const recoveryEvaluation = verify(input({ identity, revisions: { old: snapshot("new", [pinA]), new: snapshot("newer", [pinA]) } }));
  const recovery = consumeFreshnessEvent(legacyState, event(legacyState, 1, "evt-legacy-recovery", recoveryEvaluation), claim => {
    assert.deepEqual(claim.identity, identity);
    assert.deepEqual(claim.evaluatedAgainst, recoveryEvaluation.evaluatedAgainst);
    return true;
  });
  assert.equal(recovery.status, "applied");
  if (recovery.status !== "applied") return;
  assert.deepEqual(recovery.state.identity.category, category);
  assert.deepEqual(recovery.state.freshness.identity.category, category);
  assert.deepEqual(recovery.state.approval, legacyState.approval);
  assert.equal(recovery.state.bodyRef, legacyState.bodyRef);
  assert.deepEqual(recovery.state.historyRefs, legacyState.historyRefs);

  const nextCategory = Object.freeze({ ...category, mappingVersion: "test-mapping-v2", mappingEvidenceRef: "mapping:workstream:v2" });
  const nextIdentity = Object.freeze({ ...identity, category: nextCategory });
  const nextEvaluation = verify(input({ identity: nextIdentity,
    revisions: { old: snapshot("newer", [pinA]), new: snapshot("newest", [pinA]) } }));
  const update = consumeFreshnessEvent(recovery.state, event(recovery.state, 2, "evt-mapping-v2", nextEvaluation), claim => {
    assert.deepEqual(claim.identity.category, nextCategory);
    return true;
  });
  assert.equal(update.status, "applied");
  if (update.status === "applied") assert.equal(update.state.identity.category.mappingVersion, "test-mapping-v2");
});

test("mapping recovery rejects altered identity, partial mapping, and unverified mapping claims", () => {
  const unmappedIdentity = Object.freeze({ ...identity, category: Object.freeze({
    id: category.id, sourceId: category.sourceId, mappingType: null, mappingVersion: null, mappingEvidenceRef: null,
  }) });
  const legacyState: FreshnessConsumerState = Object.freeze({ ...baseState(), identity: unmappedIdentity,
    freshness: verify(input({ identity: unmappedIdentity })) });
  const mappedEvaluation = verify(input({ identity, revisions: { old: snapshot("new", [pinA]), new: snapshot("newer", [pinA]) } }));
  let verifierCalls = 0;
  const wrongDocument = event(legacyState, 1, "evt-wrong-document", {
    ...mappedEvaluation, identity: Object.freeze({ ...identity, documentId: "another-document" }),
  });
  assert.equal(consumeFreshnessEvent(legacyState, wrongDocument, () => { verifierCalls += 1; return true; }).status, "wrong-scope");
  const wrongCategory = event(legacyState, 1, "evt-wrong-category", {
    ...mappedEvaluation, identity: Object.freeze({ ...identity, category: Object.freeze({ ...category, id: "another-category" }) }),
  });
  assert.equal(consumeFreshnessEvent(legacyState, wrongCategory, () => { verifierCalls += 1; return true; }).status, "wrong-scope");
  const unverified = consumeFreshnessEvent(legacyState, event(legacyState, 1, "evt-unverified-map", mappedEvaluation), () => {
    verifierCalls += 1;
    return false;
  });
  assert.equal(unverified.status, "evaluation-unverified");
  const partialIdentity = Object.freeze({ ...identity, category: Object.freeze({ ...category, mappingEvidenceRef: null }) });
  const partial = consumeFreshnessEvent(legacyState, event(legacyState, 1, "evt-partial-map", {
    ...mappedEvaluation, identity: partialIdentity,
  }), () => { verifierCalls += 1; return true; });
  assert.equal(partial.status, "evaluation-unverified");
  assert.equal(verifierCalls, 1);
  assert.equal(legacyState.identity.category.mappingVersion, null);
  assert.equal(legacyState.cursor, 0);
});
