import { createHash } from "node:crypto";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import type { RevisionState } from "../solution-revision-store.ts";
import { consumeFreshnessEvent, type DocumentIdentity, type FreshnessConsumerState,
  type FreshnessCause, type FreshnessEvaluationVerifier, type FreshnessEvent } from "./index.ts";

/** The Host owns this single-key atomic operation; get/set is never used as a CAS fallback. */
export type FreshnessHostState = RevisionState;

export type FreshnessHostRead =
  | Readonly<{ status: "ready"; state: FreshnessConsumerState }>
  | Readonly<{ status: "empty" | "unsupported-host" | "unavailable" | "corrupt-state" }>;

export type FreshnessHostConsume =
  | Readonly<{ status: "applied" | "duplicate" | "duplicate-mismatch" | "stale" | "stale-evaluation"
    | "evaluation-unverified" | "out-of-order" | "conflict" | "wrong-scope"; state: FreshnessConsumerState }>
  | Readonly<{ status: "uninitialized" | "unsupported-host" | "unavailable" | "corrupt-state" | "state-too-large";
    state: FreshnessConsumerState | null }>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_STATE_BYTES = 192 * 1024;
const FRESHNESS_CAUSES: readonly FreshnessCause[] = ["authority-unverified", "category-unverified", "snapshot-source-unverified",
  "snapshot-access-unverified", "snapshot-access-denied", "snapshot-coverage-unverified", "trace-unverified", "trace-missing",
  "trace-incomplete", "access-denied", "source-unavailable", "index-incomplete", "identity-mismatch", "revision-pin-missing", "changed-source-pin"];
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`Invalid ${label}.`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) throw new TypeError(`Invalid ${label} fields.`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`Invalid ${label}.${key}.`);
    result[key] = descriptor.value;
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function denseList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`Invalid ${label}.`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`Invalid ${label} entry.`);
    return descriptor.value;
  });
}

function stringList(value: unknown, label: string): readonly string[] {
  const result = denseList(value, label).map(item => identifier(item, label));
  if (new Set(result).size !== result.length) throw new TypeError(`Duplicate ${label}.`);
  return Object.freeze(result);
}

const CATEGORY_FIELDS = ["id", "sourceId", "mappingType", "mappingVersion", "mappingEvidenceRef"] as const;
const LEGACY_CATEGORY_FIELDS = ["id", "sourceId", "sourceRevisionId", "scope", "allowedCategoryIds", "listCompleteness", "listEvidenceRef"] as const;

function categoryIdentity(value: unknown, label: string): Readonly<{
  id: string; sourceId: string; mappingType: string | null; mappingVersion: string | null; mappingEvidenceRef: string | null;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid ${label}.`);
  const keys = Reflect.ownKeys(value);
  let mappingType: string | null = null, mappingVersion: string | null = null, mappingEvidenceRef: string | null = null;
  let category: Record<string, unknown>;
  if (keys.some(key => key === "scope")) {
    category = record(value, LEGACY_CATEGORY_FIELDS, label);
    identifier(category.sourceRevisionId, `${label}.sourceRevisionId`);
    const scope = record(category.scope, ["id", "revisionId", "approval", "evidenceRef"], `${label}.scope`);
    identifier(scope.id, `${label}.scope.id`); identifier(scope.revisionId, `${label}.scope.revisionId`);
    if (scope.approval !== "approved" && scope.approval !== "unknown") throw new TypeError(`Invalid ${label} legacy approval.`);
    if (scope.evidenceRef !== null) identifier(scope.evidenceRef, `${label}.scope.evidenceRef`);
    const allowed = stringList(category.allowedCategoryIds, `${label}.allowedCategoryIds`);
    if (!allowed.includes(category.id as string) || category.listCompleteness !== "complete" && category.listCompleteness !== "unknown") {
      throw new TypeError(`Invalid ${label} legacy category list.`);
    }
    if (category.listEvidenceRef !== null) identifier(category.listEvidenceRef, `${label}.listEvidenceRef`);
  } else {
    category = record(value, CATEGORY_FIELDS, label);
    mappingType = nullableIdentifier(category.mappingType, `${label}.mappingType`);
    mappingVersion = nullableIdentifier(category.mappingVersion, `${label}.mappingVersion`);
    mappingEvidenceRef = nullableIdentifier(category.mappingEvidenceRef, `${label}.mappingEvidenceRef`);
    if ([mappingType, mappingVersion, mappingEvidenceRef].some(item => item !== null)
      && [mappingType, mappingVersion, mappingEvidenceRef].some(item => item === null)) {
      throw new TypeError(`Incomplete ${label} mapping.`);
    }
  }
  return Object.freeze({ id: identifier(category.id, `${label}.id`), sourceId: identifier(category.sourceId, `${label}.sourceId`),
    mappingType, mappingVersion, mappingEvidenceRef });
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : identifier(value, label);
}

function validateState(value: unknown, scope: Readonly<{ workspaceId: string; projectId: string; documentId: string }>): FreshnessConsumerState {
  const row = record(value, ["identity", "cursor", "evaluationId", "freshness", "approval", "bodyRef", "historyRefs", "processedEventIds", "processedEvents"], "freshness consumer state");
  const identity = record(row.identity, ["workspaceId", "projectId", "documentId", "category"], "document identity");
  const category = categoryIdentity(identity.category, "category identity");
  const categoryId = category.id;
  const hasCategoryMapping = category.mappingType !== null && category.mappingVersion !== null && category.mappingEvidenceRef !== null;
  const workspaceId = identifier(identity.workspaceId, "workspace ID");
  const projectId = identifier(identity.projectId, "project ID");
  const documentId = identifier(identity.documentId, "document ID");
  if (workspaceId !== scope.workspaceId || projectId !== scope.projectId || documentId !== scope.documentId) {
    throw new TypeError("Persisted freshness state is outside its Host key scope.");
  }
  if (!Number.isSafeInteger(row.cursor) || (row.cursor as number) < 0) throw new TypeError("Invalid freshness cursor.");
  const evaluationId = identifier(row.evaluationId, "evaluation ID");
  const freshness = record(row.freshness, ["identity", "evaluatedAgainst", "status", "causes", "changedSourceIds", "traceDocumentRevisionId"], "freshness evaluation");
  const evaluatedAgainst = record(freshness.evaluatedAgainst, ["oldRevisionId", "newRevisionId"], "freshness revision binding");
  identifier(evaluatedAgainst.oldRevisionId, "old revision ID");
  identifier(evaluatedAgainst.newRevisionId, "new revision ID");
  if (freshness.status !== "CURRENT" && freshness.status !== "AFFECTED" && freshness.status !== "UNKNOWN") throw new TypeError("Invalid freshness status.");
  const causeValues = denseList(freshness.causes, "freshness causes");
  if (causeValues.some(cause => typeof cause !== "string" || !FRESHNESS_CAUSES.includes(cause as FreshnessCause))) {
    throw new TypeError("Invalid freshness causes.");
  }
  const causes = [...new Set(causeValues as FreshnessCause[])];
  if (!hasCategoryMapping && !causes.includes("category-unverified")) causes.push("category-unverified");
  const normalizedStatus = hasCategoryMapping ? freshness.status : "UNKNOWN";
  const changedSourceIds = stringList(freshness.changedSourceIds, "changed source IDs");
  if (freshness.traceDocumentRevisionId !== null) identifier(freshness.traceDocumentRevisionId, "trace document revision ID");
  const approval = record(row.approval, ["status", "evidenceRef"], "approval record");
  if (!["approved", "pending", "rejected", "unknown"].includes(approval.status as string)) throw new TypeError("Invalid approval status.");
  if (approval.evidenceRef !== null) identifier(approval.evidenceRef, "approval evidence reference");
  if (row.bodyRef !== null) identifier(row.bodyRef, "body reference");
  const historyRefs = stringList(row.historyRefs, "history references");
  const processedEventIds = stringList(row.processedEventIds, "processed event IDs");
  const processedEvents = denseList(row.processedEvents, "processed events").map((item, index) => {
    const event = record(item, ["eventId", "fingerprint"], `processed event ${index}`);
    const eventId = identifier(event.eventId, "processed event ID");
    if (typeof event.fingerprint !== "string" || !event.fingerprint.trim()) throw new TypeError("Invalid processed event fingerprint.");
    return Object.freeze({ eventId, fingerprint: event.fingerprint });
  });
  if (processedEvents.length !== processedEventIds.length
    || processedEvents.some((event, index) => event.eventId !== processedEventIds[index])) throw new TypeError("Processed event indexes disagree.");
  // Rebuild from parsed JSON so no mutable Host object aliases escape.
  const normalizedIdentity: DocumentIdentity = Object.freeze({ workspaceId, projectId, documentId, category: Object.freeze({
    ...category,
  }) });
  const evaluationIdentity = record(freshness.identity, ["workspaceId", "projectId", "documentId", "category"], "evaluation identity");
  const evalCategory = categoryIdentity(evaluationIdentity.category, "evaluation category identity");
  if (evaluationIdentity.workspaceId !== workspaceId || evaluationIdentity.projectId !== projectId || evaluationIdentity.documentId !== documentId
    || JSON.stringify(evalCategory) !== JSON.stringify(category)) throw new TypeError("Evaluation identity does not match the persisted document identity.");
  return Object.freeze({ identity: normalizedIdentity, cursor: row.cursor as number, evaluationId,
    freshness: Object.freeze({ identity: normalizedIdentity,
      evaluatedAgainst: Object.freeze({ oldRevisionId: evaluatedAgainst.oldRevisionId as string, newRevisionId: evaluatedAgainst.newRevisionId as string }),
      status: normalizedStatus, causes: Object.freeze(causes), changedSourceIds,
      traceDocumentRevisionId: freshness.traceDocumentRevisionId as string | null }),
    approval: Object.freeze({ status: approval.status as FreshnessConsumerState["approval"]["status"], evidenceRef: approval.evidenceRef as string | null }),
    bodyRef: row.bodyRef as string | null, historyRefs, processedEventIds, processedEvents: Object.freeze(processedEvents) });
}

export function createFreshnessHostConsumer(input: Readonly<{
  identity: DocumentIdentity;
  state: FreshnessHostState;
  verifyEvaluation: FreshnessEvaluationVerifier;
  maxCasAttempts?: number;
}>) {
  const identity = input.identity;
  if (!UUID.test(identity.workspaceId)) throw new TypeError("Host CAS requires a canonical company Workspace UUID.");
  const scope = Object.freeze({ workspaceId: identity.workspaceId,
    projectId: identifier(identity.projectId, "project ID"), documentId: identifier(identity.documentId, "document ID") });
  if (typeof input.verifyEvaluation !== "function") throw new TypeError("A trusted evaluation verifier is required.");
  const maxCasAttempts = input.maxCasAttempts ?? 4;
  if (!Number.isSafeInteger(maxCasAttempts) || maxCasAttempts < 1 || maxCasAttempts > 16) throw new TypeError("maxCasAttempts must be between 1 and 16.");
  const key: SpsStateKey = Object.freeze({ scopeKind: "company", scopeId: scope.workspaceId,
    namespace: "sonpark.my-builder", stateKey: `document-freshness.v1.${hash(scope.projectId)}.${hash(scope.documentId)}` });

  function encode(state: FreshnessConsumerState): JsonValue {
    const normalized = validateState(state, scope);
    const wire: JsonValue = { schemaVersion: 1, workspaceId: scope.workspaceId, projectId: scope.projectId,
      documentId: scope.documentId, state: normalized as unknown as JsonValue };
    if (Buffer.byteLength(JSON.stringify(wire), "utf8") > MAX_STATE_BYTES) throw new RangeError("Freshness Host state exceeds 192 KiB.");
    return wire;
  }

  function decode(value: JsonValue): FreshnessConsumerState {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(value); } catch { throw new TypeError("Freshness Host state is not serializable."); }
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw new RangeError("Freshness Host state exceeds 192 KiB.");
    }
    const envelope = record(value, ["schemaVersion", "workspaceId", "projectId", "documentId", "state"], "freshness Host envelope");
    if (envelope.schemaVersion !== 1 || envelope.workspaceId !== scope.workspaceId
      || envelope.projectId !== scope.projectId || envelope.documentId !== scope.documentId) throw new TypeError("Freshness Host envelope scope mismatch.");
    return validateState(envelope.state, scope);
  }

  async function load(): Promise<Readonly<{ read: FreshnessHostRead; raw: JsonValue | null }>> {
    let raw: JsonValue | null;
    try { raw = await input.state.get(key); } catch { return { read: { status: "unavailable" }, raw: null }; }
    if (raw === null) return { read: { status: "empty" }, raw: null };
    try { return { read: { status: "ready", state: decode(raw) }, raw }; }
    catch { return { read: { status: "corrupt-state" }, raw }; }
  }

  return Object.freeze({
    async read(): Promise<FreshnessHostRead> {
      if (typeof input.state.compareAndSet !== "function") return Object.freeze({ status: "unsupported-host" });
      return (await load()).read;
    },

    async initialize(initialState: FreshnessConsumerState): Promise<FreshnessHostRead> {
      if (typeof input.state.compareAndSet !== "function") return Object.freeze({ status: "unsupported-host" });
      const value = encode(initialState);
      if (initialState.freshness.status !== "UNKNOWN") {
        throw new TypeError("A freshness consumer must initialize as UNKNOWN until a source-backed event is verified.");
      }
      const loaded = await load();
      if (loaded.read.status !== "empty") return loaded.read;
      try {
        const receipt = await input.state.compareAndSet(key, { exists: false }, value);
        if (receipt?.swapped === true) return Object.freeze({ status: "ready", state: decode(value) });
      } catch { /* A lost response is resolved below by observing the same CAS key. */ }
      const after = await load();
      return after.read.status === "empty" ? Object.freeze({ status: "unavailable" }) : after.read;
    },

    async consume(event: FreshnessEvent): Promise<FreshnessHostConsume> {
      if (typeof input.state.compareAndSet !== "function") return Object.freeze({ status: "unsupported-host", state: null });
      let lastState: FreshnessConsumerState | null = null;
      for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
        const loaded = await load();
        if (loaded.read.status === "empty") return Object.freeze({ status: "uninitialized", state: null });
        if (loaded.read.status !== "ready") return Object.freeze({ status: loaded.read.status, state: lastState });
        const current = loaded.read.state;
        lastState = current;
        // Decoding a legacy category is read-only normalization. Its null mapping is
        // replaced durably only by a verifier-approved transition below, in the same CAS
        // that advances the event cursor and preserves approval/body/history references.
        const transition = consumeFreshnessEvent(current, event, input.verifyEvaluation);
        if (transition.status !== "applied") return transition;
        let value: JsonValue;
        try { value = encode(transition.state); }
        catch (error) {
          if (error instanceof RangeError) return Object.freeze({ status: "state-too-large", state: current });
          return Object.freeze({ status: "corrupt-state", state: current });
        }
        try {
          const receipt = await input.state.compareAndSet(key, { exists: true, value: loaded.raw! }, value);
          if (receipt?.swapped === true) {
            // Return the exact state represented by the committed Host envelope.
            return Object.freeze({ status: "applied", state: decode(value) });
          }
        } catch { /* Retry only through the same event ID and exact CAS base; success is idempotently observed. */ }
      }
      const latest = await load();
      if (latest.read.status === "ready") {
        const observed = consumeFreshnessEvent(latest.read.state, event, input.verifyEvaluation);
        if (observed.status === "duplicate") return observed;
        return Object.freeze({ status: "conflict", state: latest.read.state });
      }
      return Object.freeze({ status: latest.read.status === "empty" ? "unavailable" : latest.read.status, state: lastState });
    },
  });
}
