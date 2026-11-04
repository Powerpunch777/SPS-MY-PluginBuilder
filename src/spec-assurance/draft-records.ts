import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import type { DesignBaseline } from "../domain/design-baseline.ts";
import type { BuilderLeadContexts } from "../domain/lead-contexts.ts";
import type { BuilderLeadSessions } from "../domain/model.ts";
import { readLeadUserSource, readLeadUserTurn } from "../lead-conversations.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";
import { composeDomainPacks, type DomainPack } from "./evaluator.ts";
import type { CoverageIdentity } from "../spec-coverage/evaluator.ts";

const MAX_ID = 160;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_RANGES = 64;
const MAX_LINKS = 1_000;
const MAX_FACTS = 1_000;
const MAX_PACKS = 32;
const HASH = /^[a-f0-9]{64}$/u;
const LEAD_TURN = /^lead-turn:([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const byteHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Sessions = BuilderLeadSessions | BuilderLeadContexts;

export type AssuranceDraftBinding = Readonly<{
  workspaceId: string;
  projectId: string;
  baselineRevisionId: string;
  specRevisionId: string;
  specDigest: string;
}>;
/** Byte offsets refer to UTF-8 bytes in the cited turn; hashes are content checks, not approval evidence. */
export type DraftByteRange = Readonly<{
  rangeId: string;
  startByte: number;
  endByteExclusive: number;
  excerpt: string;
  excerptSha256: string;
}>;
export type RequirementSourceLinkDraft = Readonly<{
  requirementId: string;
  rangeId: string;
  interpretation: string;
}>;
export type SourceTraceDraft = Readonly<{
  schemaVersion: 1;
  recordType: "source-trace-draft";
  revisionId: string;
  status: "draft";
  binding: AssuranceDraftBinding;
  source: Readonly<{ sourceId: string; sourceSha256: string; ranges: readonly DraftByteRange[] }>;
  requirementLinks: readonly RequirementSourceLinkDraft[];
}>;
export type AssuranceFactDraft = Readonly<{ id: string; interpretation: string; rangeIds: readonly string[] }>;
export type FactsDraft = Readonly<{
  schemaVersion: 1;
  recordType: "facts-draft";
  revisionId: string;
  status: "draft";
  binding: AssuranceDraftBinding;
  sourceTraceRevisionId: string;
  facts: readonly AssuranceFactDraft[];
}>;
export type DomainPacksDraft = Readonly<{
  schemaVersion: 1;
  recordType: "domain-packs-draft";
  revisionId: string;
  status: "draft";
  binding: AssuranceDraftBinding;
  packs: readonly DomainPack[];
}>;
export type DraftLookup<T> = Readonly<
  | { status: "current-draft"; record: T }
  | { status: "stale"; record: T | null }
  | { status: "unavailable"; record: null }
  | { status: "failed"; record: null }
>;
export type DraftWrite<T> = Readonly<
  | { status: "stored"; record: T; sequence: number }
  | { status: "conflict"; actualBaseRevisionId: string | null }
  | { status: "stale" }
  | { status: "unavailable" }
  | { status: "failed" }
>;

type CurrentRecords = Readonly<{
  sequence: number;
  binding: AssuranceDraftBinding;
  identity: CoverageIdentity;
  baseline: DesignBaseline;
  sourceId: string;
  sourceText: string;
  sourceSha256: string;
}>;
class StaleBindingError extends Error {}

function invalid(message: string): never { throw new TypeError(message); }
function id(value: unknown, label = "identifier"): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID || /[\u0000-\u001f\u007f]/u.test(value)) {
    return invalid(`${label} is invalid.`);
  }
  return value;
}
function plain(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid(`${label} must be a plain record.`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return invalid(`${label} has unknown or missing fields.`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid(`${label}.${key} must be a data field.`);
    result[key] = descriptor.value;
  }
  return result;
}
function list(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return invalid(`${label} must be a bounded dense array.`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid(`${label} must contain data fields.`);
    return descriptor.value;
  });
}
function text(value: unknown, label: string, max = MAX_TEXT_BYTES): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max) return invalid(`${label} is invalid or too long.`);
  return value;
}
function binding(value: unknown): AssuranceDraftBinding {
  const row = plain(value, ["workspaceId", "projectId", "baselineRevisionId", "specRevisionId", "specDigest"], "binding");
  if (typeof row.specDigest !== "string" || !HASH.test(row.specDigest)) return invalid("binding.specDigest is invalid.");
  return Object.freeze({ workspaceId: id(row.workspaceId), projectId: id(row.projectId),
    baselineRevisionId: id(row.baselineRevisionId), specRevisionId: id(row.specRevisionId), specDigest: row.specDigest });
}
function sameBinding(a: AssuranceDraftBinding, b: AssuranceDraftBinding): boolean {
  return a.workspaceId === b.workspaceId && a.projectId === b.projectId && a.baselineRevisionId === b.baselineRevisionId
    && a.specRevisionId === b.specRevisionId && a.specDigest === b.specDigest;
}
function jsonCopy<T>(value: T, label: string): T {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return invalid(`${label} must be JSON data.`); }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 192 * 1024) return invalid(`${label} exceeds the record limit.`);
  try { return JSON.parse(serialized) as T; } catch { return invalid(`${label} must be JSON data.`); }
}

function parseSourceTrace(value: unknown): SourceTraceDraft {
  const row = plain(value, ["schemaVersion", "recordType", "revisionId", "status", "binding", "source", "requirementLinks"], "source trace");
  if (row.schemaVersion !== 1 || row.recordType !== "source-trace-draft" || row.status !== "draft") return invalid("Unsupported source trace state.");
  const scope = binding(row.binding);
  const source = plain(row.source, ["sourceId", "sourceSha256", "ranges"], "source trace source");
  const sourceId = id(source.sourceId, "source ID");
  if (!LEAD_TURN.test(sourceId) || typeof source.sourceSha256 !== "string" || !HASH.test(source.sourceSha256)) return invalid("Unsupported or invalid source citation.");
  const ranges = list(source.ranges, MAX_RANGES, "source ranges").map((item, index) => {
    const range = plain(item, ["rangeId", "startByte", "endByteExclusive", "excerpt", "excerptSha256"], `source ranges[${index}]`);
    const excerpt = text(range.excerpt, `source ranges[${index}].excerpt`);
    const bytes = Buffer.from(excerpt, "utf8");
    if (!Number.isSafeInteger(range.startByte) || !Number.isSafeInteger(range.endByteExclusive)
      || (range.startByte as number) < 0 || (range.endByteExclusive as number) <= (range.startByte as number)
      || (range.endByteExclusive as number) - (range.startByte as number) !== bytes.byteLength
      || typeof range.excerptSha256 !== "string" || byteHash(bytes) !== range.excerptSha256) return invalid(`source ranges[${index}] byte evidence is invalid.`);
    return Object.freeze({ rangeId: id(range.rangeId, "range ID"), startByte: range.startByte as number,
      endByteExclusive: range.endByteExclusive as number, excerpt, excerptSha256: range.excerptSha256 });
  });
  if (new Set(ranges.map(range => range.rangeId)).size !== ranges.length) return invalid("Source trace has duplicate range IDs.");
  const rangeIds = new Set(ranges.map(range => range.rangeId));
  const requirementLinks = list(row.requirementLinks, MAX_LINKS, "requirement links").map((item, index) => {
    const link = plain(item, ["requirementId", "rangeId", "interpretation"], `requirement links[${index}]`);
    const rangeId = id(link.rangeId, "range ID");
    if (!rangeIds.has(rangeId)) return invalid("Requirement link references an absent range.");
    return Object.freeze({ requirementId: id(link.requirementId, "requirement ID"), rangeId,
      interpretation: text(link.interpretation, "requirement interpretation", 8 * 1024) });
  });
  const pairs = requirementLinks.map(link => `${link.requirementId}\0${link.rangeId}`);
  if (new Set(pairs).size !== pairs.length) return invalid("Source trace has duplicate requirement/range links.");
  const record: SourceTraceDraft = Object.freeze({ schemaVersion: 1, recordType: "source-trace-draft",
    revisionId: id(row.revisionId, "trace revision ID"), status: "draft", binding: scope,
    source: Object.freeze({ sourceId, sourceSha256: source.sourceSha256, ranges: Object.freeze(ranges) }),
    requirementLinks: Object.freeze(requirementLinks) });
  jsonCopy(record, "source trace");
  return record;
}

function parseDomainPacks(value: unknown): DomainPacksDraft {
  const row = plain(value, ["schemaVersion", "recordType", "revisionId", "status", "binding", "packs"], "Domain Pack draft");
  if (row.schemaVersion !== 1 || row.recordType !== "domain-packs-draft" || row.status !== "draft") return invalid("Unsupported Domain Pack state.");
  const scope = binding(row.binding);
  const packs = jsonCopy(list(row.packs, MAX_PACKS, "Domain Packs") as DomainPack[], "Domain Packs");
  composeDomainPacks(packs, { workspaceId: scope.workspaceId, projectId: scope.projectId,
    specRevisionId: scope.specRevisionId, specDigest: scope.specDigest }, []);
  return Object.freeze({ schemaVersion: 1, recordType: "domain-packs-draft", revisionId: id(row.revisionId, "Domain Pack record revision"),
    status: "draft", binding: scope, packs: Object.freeze(packs) });
}

function parseFacts(value: unknown): FactsDraft {
  const row = plain(value, ["schemaVersion", "recordType", "revisionId", "status", "binding", "sourceTraceRevisionId", "facts"], "facts draft");
  if (row.schemaVersion !== 1 || row.recordType !== "facts-draft" || row.status !== "draft") return invalid("Unsupported facts state.");
  const scope = binding(row.binding);
  const facts = list(row.facts, MAX_FACTS, "facts").map((item, index) => {
    const fact = plain(item, ["id", "interpretation", "rangeIds"], `facts[${index}]`);
    const rangeIds = list(fact.rangeIds, MAX_RANGES, `facts[${index}].rangeIds`).map(rangeId => id(rangeId, "range ID"));
    if (rangeIds.length === 0 || new Set(rangeIds).size !== rangeIds.length) return invalid("Each draft fact must cite unique source ranges.");
    return Object.freeze({ id: id(fact.id, "fact ID"), interpretation: text(fact.interpretation, "fact interpretation", 8 * 1024),
      rangeIds: Object.freeze(rangeIds) });
  });
  if (new Set(facts.map(fact => fact.id)).size !== facts.length) return invalid("Facts draft has duplicate IDs.");
  const record: FactsDraft = Object.freeze({ schemaVersion: 1, recordType: "facts-draft", revisionId: id(row.revisionId, "facts revision"),
    status: "draft", binding: scope, sourceTraceRevisionId: id(row.sourceTraceRevisionId, "source trace revision"), facts: Object.freeze(facts) });
  jsonCopy(record, "facts draft");
  return record;
}

/**
 * Server-side draft record service. It never activates trace links, facts or packs
 * for evaluation; each journal is isolated by the existing Workspace/Project CAS store.
 */
export function createAssuranceDraftRecords(input: Readonly<{
  workspaceId: string;
  projectId: string;
  sessions: Sessions;
  platform: SpsPlatformInvocationContext;
}>) {
  if (!input || input.sessions.workspaceId !== input.workspaceId) throw new TypeError("Lead sessions must match the bound Workspace.");
  const { workspaceId, projectId, sessions, platform } = input;
  const baselineStore = createDesignBaselineStore(workspaceId, projectId, platform.state as typeof platform.state & RevisionState);

  async function currentRecords(): Promise<CurrentRecords | null> {
    const first = await baselineStore.current();
    if (!first) return null;
    const baseline = first.revision;
    const spec = baseline.specification;
    const identity: CoverageIdentity = Object.freeze({ workspaceId, projectId, specRevisionId: spec.revisionId,
      specDigest: hash(JSON.stringify(spec)) });
    const bindingValue: AssuranceDraftBinding = Object.freeze({ workspaceId, projectId,
      baselineRevisionId: baseline.revisionId, specRevisionId: spec.revisionId, specDigest: identity.specDigest });
    const sourceId = baseline.userDecision.sourceId;
    if (spec.approvalEvidenceRef !== sourceId) throw new Error("Baseline source citation does not match its original-source record.");
    const match = LEAD_TURN.exec(sourceId);
    if (!match) throw new Error("Baseline source type is unsupported by the current source reader.");
    const sourceTurn = await readLeadUserTurn(match[1]!, sessions, platform);
    const source = await readLeadUserSource(match[1]!, sessions, platform);
    const sourceSha256 = hash(source.text);
    if (source.id !== sourceId || sourceSha256 !== baseline.userDecision.sourceSha256
      || sourceTurn.workspaceId !== workspaceId || sourceTurn.sessionId !== baseline.author.sessionId
      || sourceTurn.runId !== baseline.author.runId || sourceTurn.selectionRevision !== baseline.author.selectionRevision
      || sourceTurn.channel !== "main" && sourceTurn.channel !== "user_conversation") {
      throw new Error("Baseline source citation is absent, stale or does not match its stored digest/author.");
    }
    const latest = await baselineStore.current();
    const latestTurn = await readLeadUserTurn(match[1]!, sessions, platform);
    const latestSource = await readLeadUserSource(match[1]!, sessions, platform);
    if (!latest || latest.sequence !== first.sequence || JSON.stringify(latest.revision) !== JSON.stringify(baseline)
      || latestTurn.sessionId !== sourceTurn.sessionId || latestTurn.runId !== sourceTurn.runId
      || latestTurn.selectionRevision !== sourceTurn.selectionRevision || latestSource.id !== source.id
      || hash(latestSource.text) !== sourceSha256) throw new Error("Baseline or original source changed during the current-record read.");
    return Object.freeze({ sequence: first.sequence, binding: bindingValue, identity, baseline, sourceId, sourceText: source.text, sourceSha256 });
  }

  async function currentJournal<T>(bindingValue: AssuranceDraftBinding,
    codec: { prefix: string; parse(value: unknown): T; revisionId(value: T): string }) {
    const state = platform.state as typeof platform.state & RevisionState;
    const check = async () => {
      const records = await currentRecords();
      if (!records || !sameBinding(records.binding, bindingValue)) throw new StaleBindingError("Current baseline binding changed.");
    };
    const guarded: RevisionState = {
      async get(key) { await check(); const value = await state.get(key); await check(); return value; },
      async compareAndSet(key, expected, value) {
        if (!state.compareAndSet) throw new Error("Unsupported Host: atomic state.compareAndSet is required.");
        await check(); const receipt = await state.compareAndSet(key, expected, value); await check(); return receipt;
      },
    };
    return createRevisionJournal(workspaceId, projectId, guarded, codec);
  }

  function traceJournal(bindingValue: AssuranceDraftBinding) {
    return currentJournal(bindingValue, { prefix: "assurance-source-trace", parse: parseSourceTrace, revisionId: value => value.revisionId });
  }
  function packJournal(bindingValue: AssuranceDraftBinding) {
    return currentJournal(bindingValue, { prefix: "assurance-domain-packs", parse: parseDomainPacks, revisionId: value => value.revisionId });
  }
  function factsJournal(bindingValue: AssuranceDraftBinding) {
    return currentJournal(bindingValue, { prefix: "assurance-facts", parse: parseFacts, revisionId: value => value.revisionId });
  }

  function excerpt(range: Readonly<{ rangeId: string; startByte: number; endByteExclusive: number }>, sourceText: string): DraftByteRange {
    const bytes = Buffer.from(sourceText, "utf8");
    if (!Number.isSafeInteger(range.startByte) || !Number.isSafeInteger(range.endByteExclusive)
      || range.startByte < 0 || range.endByteExclusive <= range.startByte || range.endByteExclusive > bytes.byteLength
      || range.endByteExclusive - range.startByte > MAX_TEXT_BYTES) throw new TypeError("Draft source byte range is invalid.");
    const excerptBytes = bytes.subarray(range.startByte, range.endByteExclusive);
    const excerptText = excerptBytes.toString("utf8");
    if (!Buffer.from(excerptText, "utf8").equals(excerptBytes)) throw new TypeError("Draft source byte range splits a UTF-8 character.");
    return Object.freeze({ rangeId: id(range.rangeId, "range ID"), startByte: range.startByte,
      endByteExclusive: range.endByteExclusive, excerpt: excerptText, excerptSha256: byteHash(excerptBytes) });
  }

  async function lookupTraceRecord(bindingValue: AssuranceDraftBinding): Promise<DraftLookup<SourceTraceDraft>> {
    try {
      const journal = await traceJournal(bindingValue);
      const current = await journal.current();
      if (!current) return Object.freeze({ status: "unavailable", record: null });
      if (!sameBinding(current.revision.binding, bindingValue)) return Object.freeze({ status: "stale", record: current.revision });
      const actual = await currentRecords();
      if (!actual || !sameBinding(actual.binding, current.revision.binding) || current.revision.source.sourceId !== actual.sourceId
        || current.revision.source.sourceSha256 !== actual.sourceSha256) return Object.freeze({ status: "stale", record: current.revision });
      const verifiedRanges = current.revision.source.ranges.map(range => excerpt(range, actual.sourceText));
      if (JSON.stringify(verifiedRanges) !== JSON.stringify(current.revision.source.ranges)) return Object.freeze({ status: "failed", record: null });
      const requirements = new Set(actual.baseline.specification.requirements.map(requirement => requirement.id));
      if (current.revision.requirementLinks.some(link => !requirements.has(link.requirementId))) return Object.freeze({ status: "stale", record: current.revision });
      return Object.freeze({ status: "current-draft", record: current.revision });
    } catch (error) {
      return Object.freeze({ status: error instanceof StaleBindingError ? "stale" : "failed", record: null });
    }
  }

  async function currentBinding(): Promise<Readonly<{ status: "current"; binding: AssuranceDraftBinding } | { status: "unavailable"; binding: null } | { status: "failed"; binding: null }>> {
    try {
      const records = await currentRecords();
      return records ? Object.freeze({ status: "current" as const, binding: records.binding })
        : Object.freeze({ status: "unavailable" as const, binding: null });
    } catch { return Object.freeze({ status: "failed" as const, binding: null }); }
  }

  return Object.freeze({
    currentBinding,
    async lookupSourceTrace(expectedBinding?: AssuranceDraftBinding) {
      const current = await currentBinding();
      if (current.status !== "current") return Object.freeze({ status: current.status, record: null });
      if (expectedBinding && !sameBinding(expectedBinding, current.binding)) return Object.freeze({ status: "stale", record: null });
      return lookupTraceRecord(current.binding);
    },
    async saveSourceTraceDraft(value: unknown): Promise<DraftWrite<SourceTraceDraft>> {
      const row = plain(value, ["expectedBinding", "expectedBaseRevisionId", "revisionId", "ranges", "requirementLinks"], "source trace draft input");
      const actual = await currentBinding();
      if (actual.status !== "current") return Object.freeze({ status: actual.status });
      const expected = binding(row.expectedBinding);
      if (!sameBinding(expected, actual.binding)) return Object.freeze({ status: "stale" });
      const records = await currentRecords();
      if (!records) return Object.freeze({ status: "stale" });
      const sourceTrace: SourceTraceDraft = parseSourceTrace({ schemaVersion: 1, recordType: "source-trace-draft",
        revisionId: id(row.revisionId, "trace revision ID"), status: "draft", binding: actual.binding,
        source: { sourceId: records.sourceId, sourceSha256: records.sourceSha256,
          ranges: list(row.ranges, MAX_RANGES, "source ranges").map((range, index) => {
            const item = plain(range, ["rangeId", "startByte", "endByteExclusive"], `source range[${index}]`);
            return excerpt({ rangeId: id(item.rangeId), startByte: item.startByte as number, endByteExclusive: item.endByteExclusive as number }, records.sourceText);
          }) },
        requirementLinks: list(row.requirementLinks, MAX_LINKS, "requirement links").map((link, index) => {
          const item = plain(link, ["requirementId", "rangeId", "interpretation"], `requirement link[${index}]`);
          return { requirementId: id(item.requirementId), rangeId: id(item.rangeId), interpretation: text(item.interpretation, `requirementLinks[${index}].interpretation`, 8 * 1024) };
        }) });
      const knownRequirements = new Set(records.baseline.specification.requirements.map(requirement => requirement.id));
      if (sourceTrace.requirementLinks.some(link => !knownRequirements.has(link.requirementId))) throw new TypeError("Trace link references a requirement outside the current specification.");
      try {
        const journal = await traceJournal(actual.binding);
        const result = await journal.publish({ expectedBaseRevisionId: row.expectedBaseRevisionId === null
          ? null : id(row.expectedBaseRevisionId, "expected trace revision"), revision: sourceTrace });
        return result.status === "published" ? Object.freeze({ status: "stored" as const, record: sourceTrace, sequence: result.sequence })
          : Object.freeze({ status: "conflict" as const, actualBaseRevisionId: result.actualBaseRevisionId });
      } catch (error) {
        if (error instanceof StaleBindingError) return Object.freeze({ status: "stale" as const });
        throw error;
      }
    },
    async lookupDomainPacks(expectedBinding?: AssuranceDraftBinding): Promise<DraftLookup<DomainPacksDraft>> {
      const current = await currentBinding();
      if (current.status !== "current") return Object.freeze({ status: current.status, record: null });
      if (expectedBinding && !sameBinding(expectedBinding, current.binding)) return Object.freeze({ status: "stale", record: null });
      try {
        const journal = await packJournal(current.binding);
        const record = await journal.current();
        if (!record) return Object.freeze({ status: "unavailable", record: null });
        return sameBinding(record.revision.binding, current.binding)
          ? Object.freeze({ status: "current-draft" as const, record: record.revision })
          : Object.freeze({ status: "stale" as const, record: record.revision });
      } catch (error) { return Object.freeze({ status: error instanceof StaleBindingError ? "stale" : "failed", record: null }); }
    },
    async saveDomainPacksDraft(value: unknown): Promise<DraftWrite<DomainPacksDraft>> {
      const row = plain(value, ["expectedBinding", "expectedBaseRevisionId", "revisionId", "packs"], "Domain Pack draft input");
      const current = await currentBinding();
      if (current.status !== "current") return Object.freeze({ status: current.status });
      const expected = binding(row.expectedBinding);
      if (!sameBinding(expected, current.binding)) return Object.freeze({ status: "stale" });
      const record = parseDomainPacks({ schemaVersion: 1, recordType: "domain-packs-draft", revisionId: id(row.revisionId), status: "draft",
        binding: current.binding, packs: row.packs });
      try {
        const journal = await packJournal(current.binding);
        const result = await journal.publish({ expectedBaseRevisionId: row.expectedBaseRevisionId === null ? null : id(row.expectedBaseRevisionId), revision: record });
        return result.status === "published" ? Object.freeze({ status: "stored", record, sequence: result.sequence })
          : Object.freeze({ status: "conflict", actualBaseRevisionId: result.actualBaseRevisionId });
      } catch (error) { if (error instanceof StaleBindingError) return Object.freeze({ status: "stale" }); throw error; }
    },
    async lookupFacts(expectedBinding?: AssuranceDraftBinding): Promise<DraftLookup<FactsDraft>> {
      const current = await currentBinding();
      if (current.status !== "current") return Object.freeze({ status: current.status, record: null });
      if (expectedBinding && !sameBinding(expectedBinding, current.binding)) return Object.freeze({ status: "stale", record: null });
      try {
        const journal = await factsJournal(current.binding);
        const record = await journal.current();
        if (!record) return Object.freeze({ status: "unavailable", record: null });
        if (!sameBinding(record.revision.binding, current.binding)) return Object.freeze({ status: "stale", record: record.revision });
        const trace = await lookupTraceRecord(current.binding);
        if (trace.status !== "current-draft" || trace.record.revisionId !== record.revision.sourceTraceRevisionId
          || record.revision.facts.some(fact => fact.rangeIds.some(rangeId => !trace.record!.source.ranges.some(range => range.rangeId === rangeId)))) {
          return Object.freeze({ status: "stale", record: record.revision });
        }
        return Object.freeze({ status: "current-draft", record: record.revision });
      } catch (error) { return Object.freeze({ status: error instanceof StaleBindingError ? "stale" : "failed", record: null }); }
    },
    async saveFactsDraft(value: unknown): Promise<DraftWrite<FactsDraft>> {
      const row = plain(value, ["expectedBinding", "expectedBaseRevisionId", "revisionId", "sourceTraceRevisionId", "facts"], "facts draft input");
      const current = await currentBinding();
      if (current.status !== "current") return Object.freeze({ status: current.status });
      const expected = binding(row.expectedBinding);
      if (!sameBinding(expected, current.binding)) return Object.freeze({ status: "stale" });
      const trace = await lookupTraceRecord(current.binding);
      if (trace.status !== "current-draft" || trace.record.revisionId !== row.sourceTraceRevisionId) return Object.freeze({ status: "stale" });
      const record = parseFacts({ schemaVersion: 1, recordType: "facts-draft", revisionId: id(row.revisionId), status: "draft",
        binding: current.binding, sourceTraceRevisionId: id(row.sourceTraceRevisionId), facts: row.facts });
      const rangeIds = new Set(trace.record.source.ranges.map(range => range.rangeId));
      if (record.facts.some(fact => fact.rangeIds.some(rangeId => !rangeIds.has(rangeId)))) throw new TypeError("Draft fact cites a range outside the current source trace.");
      try {
        const journal = await factsJournal(current.binding);
        const result = await journal.publish({ expectedBaseRevisionId: row.expectedBaseRevisionId === null ? null : id(row.expectedBaseRevisionId), revision: record });
        return result.status === "published" ? Object.freeze({ status: "stored", record, sequence: result.sequence })
          : Object.freeze({ status: "conflict", actualBaseRevisionId: result.actualBaseRevisionId });
      } catch (error) { if (error instanceof StaleBindingError) return Object.freeze({ status: "stale" }); throw error; }
    },
  });
}
