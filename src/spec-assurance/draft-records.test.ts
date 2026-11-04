import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import type { BuilderLeadSessions } from "../domain/model.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import { createCurrentBaselineAssuranceProvider } from "./current-baseline-provider.ts";
import { createAssuranceDraftRecords, type AssuranceDraftBinding } from "./draft-records.ts";
import { createSpecAssuranceConsumer, type DomainPack } from "./evaluator.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const FOREIGN_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "project-current";
const FOREIGN_PROJECT = "project-foreign";
const AGENT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TURN = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = `lead-turn:${TURN}`;
const SOURCE_TEXT = "Please keep the onboarding steps clear.";
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const fullKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture(sourceText = SOURCE_TEXT) {
  const values = new Map<string, JsonValue>();
  const state: RevisionState = {
    async get(key) { return structuredClone(values.get(fullKey(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      const keyId = fullKey(key), present = values.has(keyId), old = values.get(keyId);
      const matches = expected.exists ? present && JSON.stringify(old) === JSON.stringify(expected.value) : !present;
      if (matches) values.set(keyId, structuredClone(value));
      return { swapped: matches };
    },
  };
  const platform = { state, events: {}, agents: {} } as unknown as SpsPlatformInvocationContext;
  const sessions: BuilderLeadSessions = { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT,
    sessions: { main: SESSION, "cto-inbox": null, decisions: null } };
  const sourceKey: SpsStateKey = { scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder",
    stateKey: `lead-chat.turn.v1.${TURN}` };
  values.set(fullKey(sourceKey), { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT,
    sessionId: SESSION, channel: "main", schemaVersion: 1, requestId: TURN, previousRequestId: null, sequence: 0,
    text: sourceText, createdAt: "2026-11-04T00:00:00.000Z", state: "submitted", runId: RUN,
    answer: null, outputState: "not_ready", cancellationRequested: false, termination: "not_applicable" });
  const baseline = (specRevisionId = "spec-r1", revisionId = "baseline-r1") => ({
    projectId: PROJECT, revisionId, sourceDraftRevisionId: "draft-r1", draftDigest: "a".repeat(64),
    createdAt: "2026-11-04T00:00:01.000Z",
    author: { agentId: AGENT, sessionId: SESSION, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: SOURCE_ID, sourceSha256: sha256(sourceText), interpretation: "Keep onboarding clear." },
    specification: { projectId: PROJECT, revisionId: specRevisionId, productTier: "M",
      requirements: [{ id: "REQ-1", description: "Onboarding steps remain clear.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"], dataPolicyRef: "policy-current", approvalEvidenceRef: SOURCE_ID },
    graph: { approvedSpecRevisionId: specRevisionId, graphRevisionId: `graph-${specRevisionId}`,
      entities: [], relations: [], viewLayoutRef: "layout-r1" },
  });
  const baselineStore = createDesignBaselineStore(WORKSPACE, PROJECT, state);
  const service = createAssuranceDraftRecords({ workspaceId: WORKSPACE, projectId: PROJECT, sessions, platform });
  const traceInput = (expectedBinding: AssuranceDraftBinding, revisionId = "trace-r1", expectedBaseRevisionId: string | null = null,
    selectedText = "onboarding") => {
    const selectedBytes = Buffer.from(selectedText, "utf8");
    const startByte = Buffer.from(sourceText, "utf8").indexOf(selectedBytes);
    if (startByte < 0) throw new TypeError("Fixture source substring is missing.");
    return {
    expectedBinding, expectedBaseRevisionId, revisionId,
    ranges: [{ rangeId: "range-onboarding", startByte, endByteExclusive: startByte + selectedBytes.byteLength }],
    requirementLinks: [{ requirementId: "REQ-1", rangeId: "range-onboarding", interpretation: "The user asks to keep onboarding steps clear." }],
    };
  };
  return { values, state, platform, sessions, baseline, baselineStore, service, traceInput };
}

async function start(f = fixture()) {
  const published = await f.baselineStore.publish({ expectedBaseRevisionId: null, revision: f.baseline() });
  assert.equal(published.status, "published");
  const binding = await f.service.currentBinding();
  assert.equal(binding.status, "current");
  return { ...f, binding: binding.binding };
}

test("stores and re-reads exact current source byte ranges and draft requirement interpretations", async () => {
  const f = await start();
  const saved = await f.service.saveSourceTraceDraft(f.traceInput(f.binding));
  assert.equal(saved.status, "stored");
  if (saved.status !== "stored") return;
  assert.equal(saved.record.status, "draft");
  assert.deepEqual(saved.record.source, { sourceId: SOURCE_ID, sourceSha256: sha256(SOURCE_TEXT), ranges: [
    { rangeId: "range-onboarding", startByte: Buffer.byteLength("Please keep the "),
      endByteExclusive: Buffer.byteLength("Please keep the onboarding"), excerpt: "onboarding",
      excerptSha256: sha256("onboarding") },
  ] });
  assert.deepEqual(saved.record.requirementLinks, [{ requirementId: "REQ-1", rangeId: "range-onboarding",
    interpretation: "The user asks to keep onboarding steps clear." }]);
  const lookup = await f.service.lookupSourceTrace(f.binding);
  assert.equal(lookup.status, "current-draft");
  if (lookup.status === "current-draft") assert.deepEqual(lookup.record, saved.record);
});

test("stores Domain Pack rules and source-bound fact drafts in separate versioned records", async () => {
  const f = await start();
  const trace = await f.service.saveSourceTraceDraft(f.traceInput(f.binding));
  assert.equal(trace.status, "stored");
  if (trace.status !== "stored") return;
  const pack: DomainPack = { packId: "onboarding", version: "draft-1", identity: {
    workspaceId: f.binding.workspaceId, projectId: f.binding.projectId,
    specRevisionId: f.binding.specRevisionId, specDigest: f.binding.specDigest,
  }, applicability: { all: ["fact:onboarding-clear"] }, rules: [{ id: "clear-steps", requirementIds: ["REQ-1"],
    appliesWhen: { all: [] }, requiresCheck: false }], transitions: [], exceptions: [], excludedCombinations: [] };
  const packs = await f.service.saveDomainPacksDraft({ expectedBinding: f.binding, expectedBaseRevisionId: null,
    revisionId: "packs-r1", packs: [pack] });
  assert.equal(packs.status, "stored");
  const facts = await f.service.saveFactsDraft({ expectedBinding: f.binding, expectedBaseRevisionId: null,
    revisionId: "facts-r1", sourceTraceRevisionId: trace.record.revisionId,
    facts: [{ id: "fact:onboarding-clear", interpretation: "User asks for clear onboarding steps.", rangeIds: ["range-onboarding"] }] });
  assert.equal(facts.status, "stored");
  await assert.rejects(f.service.saveFactsDraft({ expectedBinding: f.binding, expectedBaseRevisionId: "facts-r1",
    revisionId: "facts-r2", sourceTraceRevisionId: trace.record.revisionId,
    facts: [{ id: "fact:uncited", interpretation: "No source link.", rangeIds: ["invented-range"] }] }), /outside the current source trace/);
  await assert.rejects(f.service.saveDomainPacksDraft({ expectedBinding: f.binding, expectedBaseRevisionId: "packs-r1",
    revisionId: "packs-r2", packs: [{ ...pack, identity: { ...pack.identity, projectId: FOREIGN_PROJECT } }] }), /different Workspace/);
  const packLookup = await f.service.lookupDomainPacks(f.binding);
  const factsLookup = await f.service.lookupFacts(f.binding);
  assert.equal(packLookup.status, "current-draft");
  assert.equal(factsLookup.status, "current-draft");
  if (packLookup.status === "current-draft") assert.equal(packLookup.record.status, "draft");
  if (factsLookup.status === "current-draft") {
    assert.equal(factsLookup.record.status, "draft");
    assert.equal(factsLookup.record.sourceTraceRevisionId, "trace-r1");
  }

  // Draft rule/fact records are intentionally not wired into the assurance provider.
  const activeProvider = createCurrentBaselineAssuranceProvider({ workspaceId: WORKSPACE, projectId: PROJECT,
    sessions: f.sessions, platform: f.platform });
  const current = await activeProvider({ identity: pack.identity, requirementIds: ["REQ-1"] });
  assert(current);
  assert.deepEqual(current.domainPacks, []);
  assert.deepEqual(current.facts, []);
  const evaluation = await createSpecAssuranceConsumer(activeProvider)({ identity: pack.identity,
    scope: { requirementIds: ["REQ-1"] }, facts: ["fact:onboarding-clear"], packs: [pack], scenarios: [] });
  assert.equal(evaluation.status, "UNKNOWN");
  assert.deepEqual(evaluation.applicablePackIds, []);
  assert.deepEqual(evaluation.sourceEvidence, []);
});

test("current binding changes make trace/rule/fact drafts stale without activating old revisions", async () => {
  const f = await start();
  const trace = await f.service.saveSourceTraceDraft(f.traceInput(f.binding));
  assert.equal(trace.status, "stored");
  if (trace.status !== "stored") return;
  const pack = await f.service.saveDomainPacksDraft({ expectedBinding: f.binding, expectedBaseRevisionId: null,
    revisionId: "packs-r1", packs: [] });
  assert.equal(pack.status, "stored");
  const changed = await f.baselineStore.publish({ expectedBaseRevisionId: "baseline-r1", revision: f.baseline("spec-r2", "baseline-r2") });
  assert.equal(changed.status, "published");
  assert.equal((await f.service.lookupSourceTrace()).status, "stale");
  assert.equal((await f.service.lookupDomainPacks()).status, "stale");
  assert.equal((await f.service.saveSourceTraceDraft(f.traceInput(f.binding, "trace-old-again", "trace-r1"))).status, "stale");
});

test("foreign project/workspace cannot read current records from another scoped journal", async () => {
  const f = await start();
  const trace = await f.service.saveSourceTraceDraft(f.traceInput(f.binding));
  assert.equal(trace.status, "stored");
  const otherProject = createAssuranceDraftRecords({ workspaceId: WORKSPACE, projectId: FOREIGN_PROJECT,
    sessions: f.sessions, platform: f.platform });
  assert.equal((await otherProject.currentBinding()).status, "unavailable");
  assert.equal((await otherProject.lookupSourceTrace()).status, "unavailable");
  assert.equal((await otherProject.saveSourceTraceDraft(f.traceInput({ ...f.binding, projectId: FOREIGN_PROJECT }))).status, "unavailable");
  const foreignSessions: BuilderLeadSessions = { ...f.sessions, workspaceId: FOREIGN_WORKSPACE };
  assert.throws(() => createAssuranceDraftRecords({ workspaceId: WORKSPACE, projectId: PROJECT,
    sessions: foreignSessions, platform: f.platform }), /match the bound Workspace/);
});

test("CAS conflicts preserve one version and tampered journal bytes fail closed", async () => {
  const f = await start();
  const writes = await Promise.all([
    f.service.saveSourceTraceDraft(f.traceInput(f.binding, "trace-left")),
    f.service.saveSourceTraceDraft(f.traceInput(f.binding, "trace-right")),
  ]);
  assert.deepEqual(writes.map(write => write.status).sort(), ["conflict", "stored"]);
  const stored = [...f.values.entries()].find(([, value]) => value && typeof value === "object" && !Array.isArray(value)
    && "revision" in value && (value as { revision?: { recordType?: string } }).revision?.recordType === "source-trace-draft");
  assert(stored);
  const [key, value] = stored;
  const entry = value as { revision: { source: { ranges: Array<{ excerpt: string }> } } };
  f.values.set(key, { ...value as Record<string, JsonValue>, revision: { ...entry.revision,
    source: { ...entry.revision.source, ranges: [{ ...entry.revision.source.ranges[0]!, excerpt: "tampered!!!" }] } } });
  const result = await f.service.lookupSourceTrace();
  assert.equal(result.status, "failed");
  assert.equal(result.record, null);
});

test("source bytes changed after draft creation cannot be looked up as current", async () => {
  const f = await start();
  const saved = await f.service.saveSourceTraceDraft(f.traceInput(f.binding));
  assert.equal(saved.status, "stored");
  const key = [...f.values.keys()].find(value => value.includes(`lead-chat.turn.v1.${TURN}`));
  assert(key);
  const turn = f.values.get(key) as Record<string, JsonValue>;
  f.values.set(key, { ...turn, text: "The cited original has changed." });
  assert.equal((await f.service.lookupSourceTrace()).status, "failed");
});

test("unsupported CAS Host cannot publish a draft record", async () => {
  const f = await start();
  (f.platform.state as unknown as { compareAndSet?: unknown }).compareAndSet = undefined;
  await assert.rejects(f.service.saveSourceTraceDraft(f.traceInput(f.binding)), /Unsupported Host: atomic state.compareAndSet is required/);
});

test("multibyte UTF-8 excerpts preserve exact source bytes and offsets", async () => {
  const source = "Intro 🌿 café end.";
  const f = await start(fixture(source));
  const saved = await f.service.saveSourceTraceDraft(f.traceInput(f.binding, "trace-utf8", null, "🌿 café"));
  assert.equal(saved.status, "stored");
  if (saved.status !== "stored") return;
  const sourceBytes = Buffer.from(source, "utf8"), excerptBytes = Buffer.from("🌿 café", "utf8");
  const expectedStart = sourceBytes.indexOf(excerptBytes);
  assert.equal(saved.record.source.ranges[0]?.startByte, expectedStart);
  assert.equal(saved.record.source.ranges[0]?.endByteExclusive, expectedStart + excerptBytes.byteLength);
  assert.equal(saved.record.source.ranges[0]?.excerpt, excerptBytes.toString("utf8"));
  assert.equal(saved.record.source.ranges[0]?.excerptSha256, createHash("sha256").update(excerptBytes).digest("hex"));
  assert(Buffer.from(saved.record.source.ranges[0]!.excerpt, "utf8").equals(excerptBytes));
  assert.equal((await f.service.lookupSourceTrace()).status, "current-draft");
});

test("UTF-8 byte ranges split inside multibyte characters or outside the source are rejected", async () => {
  const source = "A🌿B";
  const f = await start(fixture(source));
  const sourceBytes = Buffer.from(source, "utf8"), flowerBytes = Buffer.from("🌿", "utf8");
  const flowerStart = sourceBytes.indexOf(flowerBytes);
  const base = f.traceInput(f.binding, "trace-split", null, "🌿");
  const splitStart = { ...base, ranges: [{ ...base.ranges[0]!, startByte: flowerStart + 1 }] };
  await assert.rejects(f.service.saveSourceTraceDraft(splitStart), /splits a UTF-8 character/);
  const splitEnd = { ...base, ranges: [{ ...base.ranges[0]!, endByteExclusive: flowerStart + flowerBytes.byteLength - 1 }] };
  await assert.rejects(f.service.saveSourceTraceDraft(splitEnd), /splits a UTF-8 character/);
  const negativeStart = { ...base, ranges: [{ ...base.ranges[0]!, startByte: -1 }] };
  await assert.rejects(f.service.saveSourceTraceDraft(negativeStart), /byte range is invalid/);
  const pastEnd = { ...base, ranges: [{ ...base.ranges[0]!, endByteExclusive: sourceBytes.byteLength + 1 }] };
  await assert.rejects(f.service.saveSourceTraceDraft(pastEnd), /byte range is invalid/);
  const empty = { ...base, ranges: [{ ...base.ranges[0]!, endByteExclusive: base.ranges[0]!.startByte }] };
  await assert.rejects(f.service.saveSourceTraceDraft(empty), /byte range is invalid/);
});

test("malformed CAS journal envelopes, JSON payloads, and rehashed invalid records fail closed", async () => {
  const makeSaved = async () => {
    const f = await start();
    const saved = await f.service.saveSourceTraceDraft(f.traceInput(f.binding));
    assert.equal(saved.status, "stored");
    return f;
  };
  const traceEntry = (f: Awaited<ReturnType<typeof makeSaved>>) => [...f.values.entries()].find(([, value]) => value
    && typeof value === "object" && !Array.isArray(value) && "revision" in value
    && (value as { revision?: { recordType?: string } }).revision?.recordType === "source-trace-draft");
  const traceHead = (f: Awaited<ReturnType<typeof makeSaved>>) => [...f.values.entries()].find(([, value]) => value
    && typeof value === "object" && !Array.isArray(value) && "revisionId" in value
    && (value as { revisionId?: string }).revisionId === "trace-r1");

  const missingEnvelopeField = await makeSaved();
  const missingEntry = traceEntry(missingEnvelopeField);
  assert(missingEntry);
  const [missingKey, missingValue] = missingEntry;
  const malformedEnvelope = { ...missingValue as Record<string, JsonValue> };
  delete malformedEnvelope.projectId;
  missingEnvelopeField.values.set(missingKey, malformedEnvelope);
  assert.equal((await missingEnvelopeField.service.lookupSourceTrace()).status, "failed");

  const malformedJson = await makeSaved();
  const jsonEntry = traceEntry(malformedJson);
  assert(jsonEntry);
  malformedJson.values.set(jsonEntry[0], "{not-json" as unknown as JsonValue);
  assert.equal((await malformedJson.service.lookupSourceTrace()).status, "failed");

  const invalidRecord = await makeSaved();
  const entryPair = traceEntry(invalidRecord), headPair = traceHead(invalidRecord);
  assert(entryPair && headPair);
  const [entryKey, rawEntry] = entryPair;
  const [headKey, rawHead] = headPair;
  const entry = rawEntry as Record<string, JsonValue>;
  const revision = entry.revision as Record<string, JsonValue>;
  const invalidRevision = { ...revision, status: "active" };
  const body = { schemaVersion: entry.schemaVersion, workspaceId: entry.workspaceId, projectId: entry.projectId,
    sequence: entry.sequence, parent: entry.parent, revision: invalidRevision };
  const newDigest = sha256(JSON.stringify(body));
  invalidRecord.values.set(entryKey, { ...entry, revision: invalidRevision, digest: newDigest } as unknown as JsonValue);
  invalidRecord.values.set(headKey, { ...(rawHead as Record<string, JsonValue>), digest: newDigest });
  assert.equal((await invalidRecord.service.lookupSourceTrace()).status, "failed");
});
