import { createHash } from "node:crypto";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";

export type EvidencePin = Readonly<{ sourceId: string; revisionId: string; sha256: string }>;
export type VerifiedWorkstreamSnapshot = Readonly<{
  eventId: string;
  workspaceId: string;
  projectId: string;
  workstreamId: string;
  verificationStatus: "VERIFIED";
  sourcePins: readonly EvidencePin[];
  gateDecisions: readonly Readonly<{ gateId: "G4" | "G6"; verdict: "PASS"; evidenceRefs: readonly EvidencePin[] }>[];
  qaEvidence: readonly Readonly<{ result: "passed"; report: EvidencePin }>[];
}>;
export type VerifiedSnapshotRead =
  | Readonly<{ status: "current"; snapshot: VerifiedWorkstreamSnapshot }>
  | Readonly<{ status: "stale" }>
  | Readonly<{ status: "unknown"; reason: string }>;
export type ManagerDispatchRequest = Readonly<{
  requestId: string;
  eventId: string;
  evidenceDigest: string;
  scope: Readonly<{ workspaceId: string; projectId: string; workstreamId: string }>;
  snapshot: VerifiedWorkstreamSnapshot;
}>;
export type ManagerDispatchReceiptRead =
  | Readonly<{ status: "accepted"; requestId: string; receiptId: string; runId: string }>
  | Readonly<{ status: "pending"; requestId: string }>
  | Readonly<{ status: "not-found"; authoritative: true }>
  | Readonly<{ status: "uncertain"; reason: string }>;

/**
 * Approved integration-task/Runner port. It must dedupe requestId. `not-found`
 * is valid only when the Host can authoritatively establish absence; null alone is uncertain.
 */
export type ManagerDispatchPort = Readonly<{
  dispatch(request: ManagerDispatchRequest): Promise<void>;
  readReceipt(requestId: string): Promise<ManagerDispatchReceiptRead>;
}>;
export type VerificationConsumeResult = Readonly<{
  status: "pending" | "uncertain" | "accepted" | "stale" | "unknown" | "conflict";
  eventId: string;
  reason: string;
  requestId?: string;
  evidenceDigest?: string;
  receipt?: Readonly<{ receiptId: string; runId: string }>;
  consistency: "reservation-cas-and-manager-receipt-are-not-atomic";
}>;

type StateClient = Readonly<{
  get(key: SpsStateKey): Promise<JsonValue | null>;
  compareAndSet?: (key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => Promise<{ swapped: boolean }>;
}>;
export type VerifiedSnapshotReader = (input: Readonly<{ workspaceId: string; projectId: string; workstreamId: string; eventId: string }>) => Promise<VerifiedSnapshotRead>;

type StoredReceipt = Readonly<{ receiptId: string; runId: string }>;
export type ProtectedContinuation = Readonly<{
  terminalEventId: string;
  protectedRunId: string;
  receiptDigest: string;
  subjectKeySha256: string;
  phase: "ci" | "e2e" | "regression";
  requestId: string;
  previousRunId?: string;
  status: "waiting" | "pending" | "uncertain" | "accepted" | "manager-failed";
  dispatchAttempts: 0 | 1;
  recoveryWakeCount: 0 | 1;
  receipt: StoredReceipt | null;
  managerTerminalStatus?: "failed" | "cancelled";
}>;
type Reservation = Readonly<{
  eventId: string;
  evidenceDigest: string;
  requestId: string | null;
  status: "pending" | "uncertain" | "accepted";
  dispatchAttempts: number;
  receipt: StoredReceipt | null;
  continuations?: readonly ProtectedContinuation[];
}>;
type Ledger = Readonly<{
  schemaVersion: 2;
  workspaceId: string;
  projectId: string;
  workstreamId: string;
  revision: number;
  events: readonly Reservation[];
}>;

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const EVENT_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const MAX_EVENTS = 2048;
const MAX_CONTINUATIONS = 32;
const MAX_DISPATCH_ATTEMPTS = 2;
const MAX_CAS_REQUEST_BYTES = 220_000;
const encoder = new TextEncoder();
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const keyFor = (workspaceId: string, projectId: string, workstreamId: string): SpsStateKey => ({
  scopeKind: "company", scopeId: workspaceId, namespace: "sonpark.my-builder",
  stateKey: `verified-consumption.v1.${digest(`${projectId}\0${workstreamId}`)}`,
});
const samePin = (a: EvidencePin, b: EvidencePin) => a.sourceId === b.sourceId && a.revisionId === b.revisionId && a.sha256 === b.sha256;
const outcome = (status: VerificationConsumeResult["status"], eventId: string, reason: string,
  details: Partial<Pick<VerificationConsumeResult, "requestId" | "evidenceDigest" | "receipt">> = {}): VerificationConsumeResult =>
  Object.freeze({ status, eventId, reason, ...details, consistency: "reservation-cas-and-manager-receipt-are-not-atomic" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validPin(value: unknown): value is EvidencePin {
  if (!isRecord(value)) return false;
  return typeof value.sourceId === "string" && ID.test(value.sourceId)
    && typeof value.revisionId === "string" && ID.test(value.revisionId)
    && typeof value.sha256 === "string" && HASH.test(value.sha256);
}

export function validVerifiedWorkstreamSnapshot(value: unknown, expected: { workspaceId: string; projectId: string; workstreamId: string; eventId: string }): value is VerifiedWorkstreamSnapshot {
  try {
    if (!isRecord(value)) return false;
    const row = value;
    if (row.eventId !== expected.eventId || row.workspaceId !== expected.workspaceId || row.projectId !== expected.projectId
      || row.workstreamId !== expected.workstreamId || row.verificationStatus !== "VERIFIED"
      || !Array.isArray(row.sourcePins) || row.sourcePins.length === 0 || !row.sourcePins.every(validPin)
      || new Set((row.sourcePins as EvidencePin[]).map(pin => pin.sourceId)).size !== row.sourcePins.length
      || !Array.isArray(row.gateDecisions) || row.gateDecisions.length !== 2
      || !Array.isArray(row.qaEvidence) || row.qaEvidence.length === 0) return false;
    const sourcePins = row.sourcePins as EvidencePin[];
    const gates = new Map<string, Record<string, unknown>>();
    for (const candidate of row.gateDecisions) {
      if (!isRecord(candidate) || (candidate.gateId !== "G4" && candidate.gateId !== "G6")
        || candidate.verdict !== "PASS" || !Array.isArray(candidate.evidenceRefs)
        || candidate.evidenceRefs.length === 0 || !candidate.evidenceRefs.every(validPin)
        || new Set((candidate.evidenceRefs as EvidencePin[]).map(pin => `${pin.sourceId}\0${pin.revisionId}\0${pin.sha256}`)).size !== candidate.evidenceRefs.length
        || gates.has(candidate.gateId)) return false;
      gates.set(candidate.gateId, candidate);
    }
    if (gates.size !== 2 || !gates.has("G4") || !gates.has("G6")) return false;
    for (const gate of gates.values()) {
      const refs = gate.evidenceRefs as EvidencePin[];
      if (refs.some(ref => !sourcePins.some(pin => samePin(pin, ref)))) return false;
    }
    const qaEvidence = row.qaEvidence as unknown[];
    if (qaEvidence.some(candidate => !isRecord(candidate) || candidate.result !== "passed" || !validPin(candidate.report)
      || !sourcePins.some(pin => samePin(pin, candidate.report as EvidencePin))
      || !(gates.get("G6")!.evidenceRefs as EvidencePin[]).some(pin => samePin(pin, candidate.report as EvidencePin)))) return false;
    return new Set(qaEvidence.map(candidate => {
      const report = (candidate as Record<string, unknown>).report as EvidencePin;
      return `${report.sourceId}\0${report.revisionId}\0${report.sha256}`;
    })).size === qaEvidence.length;
  } catch { return false; }
}

export function normalizeVerifiedWorkstreamSnapshot(snapshot: VerifiedWorkstreamSnapshot): VerifiedWorkstreamSnapshot {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const pinOrder = (a: EvidencePin, b: EvidencePin) => compare(`${a.sourceId}\0${a.revisionId}\0${a.sha256}`,
    `${b.sourceId}\0${b.revisionId}\0${b.sha256}`);
  const pin = (value: EvidencePin) => ({ sourceId: value.sourceId, revisionId: value.revisionId, sha256: value.sha256 });
  return {
    eventId: snapshot.eventId,
    workspaceId: snapshot.workspaceId,
    projectId: snapshot.projectId,
    workstreamId: snapshot.workstreamId,
    verificationStatus: snapshot.verificationStatus,
    sourcePins: [...snapshot.sourcePins].sort(pinOrder).map(pin),
    gateDecisions: [...snapshot.gateDecisions].sort((a, b) => compare(a.gateId, b.gateId)).map(gate => ({
      gateId: gate.gateId,
      verdict: gate.verdict,
      evidenceRefs: [...gate.evidenceRefs].sort(pinOrder).map(pin),
    })),
    qaEvidence: [...snapshot.qaEvidence].sort((a, b) => pinOrder(a.report, b.report)).map(item => ({ result: item.result, report: pin(item.report) })),
  };
}

function parseReservation(value: unknown): Reservation {
  if (!isRecord(value) || (Reflect.ownKeys(value).length !== 6 && Reflect.ownKeys(value).length !== 7)
    || typeof value.eventId !== "string" || !ID.test(value.eventId)
    || typeof value.evidenceDigest !== "string" || !HASH.test(value.evidenceDigest)
    || !(value.requestId === null || typeof value.requestId === "string" && /^builder-ws-dispatch-v1:[a-f0-9]{64}$/u.test(value.requestId))
    || !["pending", "uncertain", "accepted"].includes(value.status as string)
    || !Number.isSafeInteger(value.dispatchAttempts) || (value.dispatchAttempts as number) < 0
    || (value.dispatchAttempts as number) > MAX_DISPATCH_ATTEMPTS) throw new TypeError("Malformed Manager dispatch reservation.");
  let receipt: StoredReceipt | null = null;
  if (value.receipt !== null) {
    if (!isRecord(value.receipt) || Reflect.ownKeys(value.receipt).length !== 2
      || typeof value.receipt.receiptId !== "string" || !ID.test(value.receipt.receiptId)
      || typeof value.receipt.runId !== "string" || !ID.test(value.receipt.runId)) throw new TypeError("Malformed Manager dispatch receipt.");
    receipt = { receiptId: value.receipt.receiptId, runId: value.receipt.runId };
  }
  if ((value.status === "accepted") !== (receipt !== null) || (value.status === "accepted" && value.requestId === null)) {
    throw new TypeError("Manager dispatch reservation state does not match its receipt.");
  }
  let continuations: ProtectedContinuation[] | undefined;
  if (Object.hasOwn(value, "continuations")) {
    if (!Array.isArray(value.continuations) || value.continuations.length > MAX_CONTINUATIONS) throw new TypeError("Malformed bounded Manager continuation history.");
    continuations = value.continuations.map(parseContinuation);
    if (new Set(continuations.map(item => `${item.terminalEventId}\0${item.protectedRunId}\0${item.receiptDigest}`)).size !== continuations.length) {
      throw new TypeError("Duplicate Manager continuation identity.");
    }
  }
  return { eventId: value.eventId, evidenceDigest: value.evidenceDigest, requestId: value.requestId as string | null,
    status: value.status as Reservation["status"], dispatchAttempts: value.dispatchAttempts as number, receipt,
    ...(continuations ? { continuations } : {}) };
}

function parseContinuation(value: unknown): ProtectedContinuation {
  if (!isRecord(value) || ![10, 11, 12].includes(Reflect.ownKeys(value).length)
    || typeof value.terminalEventId !== "string" || !EVENT_ID.test(value.terminalEventId)
    || typeof value.protectedRunId !== "string" || !ID.test(value.protectedRunId)
    || typeof value.receiptDigest !== "string" || !HASH.test(value.receiptDigest)
    || typeof value.subjectKeySha256 !== "string" || !HASH.test(value.subjectKeySha256)
    || !["ci", "e2e", "regression"].includes(value.phase as string)
    || typeof value.requestId !== "string" || !/^builder-ws-continuation-v1:[a-f0-9]{64}$/u.test(value.requestId)
    || Object.hasOwn(value, "previousRunId") && (typeof value.previousRunId !== "string" || !ID.test(value.previousRunId))
    || !["waiting", "pending", "uncertain", "accepted", "manager-failed"].includes(value.status as string)
    || !Number.isSafeInteger(value.dispatchAttempts) || ![0, 1].includes(value.dispatchAttempts as number)
    || !Number.isSafeInteger(value.recoveryWakeCount) || ![0, 1].includes(value.recoveryWakeCount as number)) {
    throw new TypeError("Malformed protected-receipt continuation.");
  }
  let receipt: StoredReceipt | null = null;
  if (value.receipt !== null) {
    if (!isRecord(value.receipt) || Reflect.ownKeys(value.receipt).length !== 2
      || typeof value.receipt.receiptId !== "string" || !ID.test(value.receipt.receiptId)
      || typeof value.receipt.runId !== "string" || !ID.test(value.receipt.runId)) throw new TypeError("Malformed continuation receipt.");
    receipt = { receiptId: value.receipt.receiptId, runId: value.receipt.runId };
  }
  if ((value.status === "waiting" && (value.dispatchAttempts !== 0 || receipt !== null))
    || (value.status === "pending" && (value.dispatchAttempts !== 1 || receipt !== null))
    || (value.status === "uncertain" && (value.dispatchAttempts !== 1 || receipt !== null))
    || (value.status === "accepted" && (value.dispatchAttempts !== 1 || receipt === null))
    || (value.status === "manager-failed" && (!(["failed", "cancelled"] as unknown[]).includes(value.managerTerminalStatus)
      || value.managerTerminalStatus === undefined))
    || (value.status !== "manager-failed" && Object.hasOwn(value, "managerTerminalStatus"))) {
    throw new TypeError("Continuation status does not match its effect receipt.");
  }
  return value as unknown as ProtectedContinuation;
}

function parseLedger(value: JsonValue | null, workspaceId: string, projectId: string, workstreamId: string): Ledger {
  if (value === null) return { schemaVersion: 2, workspaceId, projectId, workstreamId, revision: 0, events: [] };
  if (!isRecord(value)) throw new TypeError("Malformed Manager dispatch ledger.");
  if (value.schemaVersion === 1) {
    if (Reflect.ownKeys(value).length !== 6 || value.workspaceId !== workspaceId || value.projectId !== projectId
      || value.workstreamId !== workstreamId || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
      || !Array.isArray(value.eventIds) || value.eventIds.length > MAX_EVENTS
      || value.eventIds.some(id => typeof id !== "string" || !ID.test(id))
      || new Set(value.eventIds).size !== value.eventIds.length) throw new TypeError("Malformed legacy verified-event ledger.");
    return { schemaVersion: 2, workspaceId, projectId, workstreamId, revision: value.revision as number,
      events: (value.eventIds as string[]).map(eventId => ({ eventId, evidenceDigest: "0".repeat(64), requestId: null,
        status: "uncertain", dispatchAttempts: 0, receipt: null })) };
  }
  if (Reflect.ownKeys(value).length !== 6 || value.schemaVersion !== 2 || value.workspaceId !== workspaceId
    || value.projectId !== projectId || value.workstreamId !== workstreamId || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1 || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) {
    throw new TypeError("Malformed or cross-scope Manager dispatch ledger.");
  }
  const events = value.events.map(parseReservation);
  if (new Set(events.map(item => item.eventId)).size !== events.length) throw new TypeError("Duplicate event reservation.");
  return { schemaVersion: 2, workspaceId, projectId, workstreamId, revision: value.revision as number, events };
}

function validReceiptRead(value: unknown, requestId: string): ManagerDispatchReceiptRead | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (value.status === "accepted" && Reflect.ownKeys(value).length === 4 && value.requestId === requestId
    && typeof value.receiptId === "string" && ID.test(value.receiptId) && typeof value.runId === "string" && ID.test(value.runId)) {
    return { status: "accepted", requestId, receiptId: value.receiptId, runId: value.runId };
  }
  if (value.status === "pending" && Reflect.ownKeys(value).length === 2 && value.requestId === requestId) return { status: "pending", requestId };
  if (value.status === "not-found" && Reflect.ownKeys(value).length === 2 && value.authoritative === true) {
    return { status: "not-found", authoritative: true };
  }
  if (value.status === "uncertain" && typeof value.reason === "string") return { status: "uncertain", reason: value.reason };
  return null;
}

async function saveEntry(state: StateClient, key: SpsStateKey, raw: JsonValue | null, ledger: Ledger, entry: Reservation) {
  const next: Ledger = { ...ledger, revision: ledger.revision + 1,
    events: ledger.events.some(item => item.eventId === entry.eventId)
      ? ledger.events.map(item => item.eventId === entry.eventId ? entry : item)
      : [...ledger.events, entry] };
  if (next.events.length > MAX_EVENTS) return { swapped: false, next };
  const expected = raw === null ? { exists: false as const } : { exists: true as const, value: raw };
  const envelope = JSON.stringify({ key, expected, value: next });
  if (encoder.encode(envelope).byteLength > MAX_CAS_REQUEST_BYTES) throw new RangeError("Manager dispatch ledger CAS exceeds the bounded Host request size.");
  const swapped = await state.compareAndSet!(key, expected, next as unknown as JsonValue);
  return { swapped: swapped.swapped, next };
}

export function protectedContinuationRequestId(input: Readonly<{ workspaceId: string; projectId: string; workstreamId: string;
  verifiedEventId: string; terminalEventId: string; protectedRunId: string; receiptDigest: string; subjectKeySha256: string; phase: ProtectedContinuation["phase"] }>) {
  return `builder-ws-continuation-v1:${digest(JSON.stringify([input.workspaceId, input.projectId, input.workstreamId,
    input.verifiedEventId, input.terminalEventId, input.protectedRunId, input.receiptDigest, input.subjectKeySha256, input.phase]))}`;
}

type ContinuationScope = Readonly<{ workspaceId: string; projectId: string; workstreamId: string; verifiedEventId: string }>;
type ContinuationIdentity = Readonly<{ terminalEventId: string; protectedRunId: string; receiptDigest: string;
  subjectKeySha256: string; phase: ProtectedContinuation["phase"] }>;
type ContinuationState = StateClient & Readonly<{
  guardedCompareAndSetWithJobWakeV1?: (key: SpsStateKey & { scopeKind: "company"; scopeId: string;
    guards: readonly { stateKey: string; namespace?: string; expectedValue: JsonValue }[] },
    expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue,
    wake: Readonly<{ name: string; eventId: string; jobKey: string; payload: JsonValue }>) => Promise<{ status: "committed" | "conflict" | "unsupported"; reason?: string }>;
}>;

function continuationKey(value: ContinuationIdentity) {
  return `${value.terminalEventId}\0${value.protectedRunId}\0${value.receiptDigest}`;
}

function validContinuationIdentity(value: ContinuationIdentity) {
  return typeof value.terminalEventId === "string" && EVENT_ID.test(value.terminalEventId)
    && typeof value.protectedRunId === "string" && ID.test(value.protectedRunId)
    && HASH.test(value.receiptDigest) && HASH.test(value.subjectKeySha256)
    && ["ci", "e2e", "regression"].includes(value.phase);
}

async function loadContinuationLedger(scope: ContinuationScope, state: StateClient) {
  const key = keyFor(scope.workspaceId, scope.projectId, scope.workstreamId);
  const raw = await state.get(key);
  return { key, raw, ledger: parseLedger(raw, scope.workspaceId, scope.projectId, scope.workstreamId) };
}

export async function readVerifiedWorkstreamReservation(scope: ContinuationScope, state: StateClient) {
  const loaded = await loadContinuationLedger(scope, state);
  const event = loaded.ledger.events.find(item => item.eventId === scope.verifiedEventId);
  return event ? Object.freeze({ ...event }) : null;
}

/** Append one immutable receipt/event identity to the existing verified-event row. */
export async function reserveProtectedContinuation(scope: ContinuationScope, identity: ContinuationIdentity, state: StateClient) {
  if (![scope.workspaceId, scope.workstreamId, scope.verifiedEventId].every(value => typeof value === "string" && ID.test(value))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(scope.projectId) || !validContinuationIdentity(identity)) {
    throw new TypeError("Invalid protected continuation identity.");
  }
  if (typeof state.compareAndSet !== "function") return { status: "unknown" as const, reason: "host-cas-unavailable" };
  let loaded: Awaited<ReturnType<typeof loadContinuationLedger>>;
  try { loaded = await loadContinuationLedger(scope, state); }
  catch { return { status: "unknown" as const, reason: "manager-dispatch-ledger-read-failed" };
  }
  const event = loaded.ledger.events.find(item => item.eventId === scope.verifiedEventId);
  if (!event || event.status !== "accepted" || !event.receipt || !event.requestId) {
    return { status: "unknown" as const, reason: "verified-event-manager-request-not-accepted" };
  }
  const prior = event.continuations?.find(item => continuationKey(item) === continuationKey(identity));
  if (prior) return { status: "existing" as const, continuation: prior };
  if ((event.continuations?.length ?? 0) >= MAX_CONTINUATIONS) return { status: "unknown" as const, reason: "manager-continuation-history-capacity" };
  const requestId = protectedContinuationRequestId({ ...scope, ...identity });
  const continuation: ProtectedContinuation = Object.freeze({ ...identity, requestId, status: "waiting", dispatchAttempts: 0,
    recoveryWakeCount: 0, receipt: null });
  let saved: Awaited<ReturnType<typeof saveEntry>>;
  try { saved = await saveEntry(state, loaded.key, loaded.raw, loaded.ledger, { ...event,
    continuations: [...(event.continuations ?? []), continuation] }); }
  catch { return { status: "unknown" as const, reason: "manager-continuation-reservation-uncertain" };
  }
  return saved.swapped ? { status: "reserved" as const, continuation }
    : { status: "conflict" as const, reason: "manager-continuation-reservation-conflict" };
}

/** Queue at most one durable recheck while the exact earlier Manager run is active. */
export async function queueProtectedContinuationRecheck(scope: ContinuationScope, identity: ContinuationIdentity,
  managerBindingKey: SpsStateKey, managerBinding: JsonValue, wake: Readonly<{ name: string; eventId: string; jobKey: string; payload: JsonValue }>,
  state: ContinuationState) {
  if (typeof state.guardedCompareAndSetWithJobWakeV1 !== "function") return { status: "unsupported" as const,
    reason: "atomic-manager-continuation-wake-unavailable" };
  let loaded: Awaited<ReturnType<typeof loadContinuationLedger>>;
  try { loaded = await loadContinuationLedger(scope, state); }
  catch { return { status: "unknown" as const, reason: "manager-dispatch-ledger-read-failed" };
  }
  const event = loaded.ledger.events.find(item => item.eventId === scope.verifiedEventId);
  const prior = event?.continuations?.find(item => continuationKey(item) === continuationKey(identity));
  if (!event || event.status !== "accepted" || !event.receipt || !prior) return { status: "unknown" as const,
    reason: "manager-continuation-reservation-unavailable" };
  if (prior.recoveryWakeCount === 1) return { status: "existing" as const, continuation: prior };
  const continuation: ProtectedContinuation = Object.freeze({ ...prior, recoveryWakeCount: 1 });
  const entry: Reservation = { ...event, continuations: event.continuations!.map(item => continuationKey(item) === continuationKey(identity) ? continuation : item) };
  const next: Ledger = { ...loaded.ledger, revision: loaded.ledger.revision + 1,
    events: loaded.ledger.events.map(item => item.eventId === event.eventId ? entry : item) };
  const expected = loaded.raw === null ? { exists: false as const } : { exists: true as const, value: loaded.raw };
  const key = { ...loaded.key, scopeKind: "company" as const, scopeId: scope.workspaceId,
    guards: [{ stateKey: managerBindingKey.stateKey, ...(managerBindingKey.namespace ? { namespace: managerBindingKey.namespace } : {}),
      expectedValue: managerBinding }] };
  if (encoder.encode(JSON.stringify({ key, expected, value: next, wake })).byteLength > MAX_CAS_REQUEST_BYTES) {
    return { status: "unsupported" as const, reason: "manager-continuation-wake-request-over-bound" };
  }
  try {
    const result = await state.guardedCompareAndSetWithJobWakeV1(key, expected, next as unknown as JsonValue, wake);
    return result.status === "committed" ? { status: "queued" as const, continuation }
      : result.status === "conflict" ? { status: "conflict" as const, reason: "manager-continuation-wake-conflict" }
        : { status: "unsupported" as const, reason: result.reason ?? "atomic-manager-continuation-wake-unavailable" };
  } catch { return { status: "unknown" as const, reason: "manager-continuation-wake-outcome-unknown" };
  }
}

export async function startProtectedContinuation(scope: ContinuationScope, identity: ContinuationIdentity,
  previousRunId: string, state: StateClient) {
  if (typeof previousRunId !== "string" || !ID.test(previousRunId)) return { status: "unknown" as const,
    reason: "manager-continuation-previous-run-invalid" };
  return updateProtectedContinuation(scope, identity, state, prior => {
    if (prior.status !== "waiting") return prior;
    return Object.freeze({ ...prior, status: "pending", dispatchAttempts: 1, previousRunId });
  });
}

export async function finishProtectedContinuation(scope: ContinuationScope, identity: ContinuationIdentity,
  result: Readonly<{ status: "accepted"; receiptId: string; runId: string } | { status: "uncertain" }>, state: StateClient) {
  return updateProtectedContinuation(scope, identity, state, prior => {
    if (result.status === "uncertain") return prior.status === "pending" ? Object.freeze({ ...prior, status: "uncertain" }) : prior;
    if (prior.status === "accepted") return prior.receipt?.receiptId === result.receiptId && prior.receipt.runId === result.runId
      ? prior : prior;
    if (prior.status !== "pending" && prior.status !== "uncertain") return prior;
    return Object.freeze({ ...prior, status: "accepted", dispatchAttempts: 1, receipt: { receiptId: result.receiptId, runId: result.runId } });
  });
}

/** Close a waiting/accepted continuation when the exact Manager run ended unsuccessfully. */
export async function failProtectedContinuation(scope: ContinuationScope, identity: ContinuationIdentity,
  terminalStatus: "failed" | "cancelled", state: StateClient) {
  return updateProtectedContinuation(scope, identity, state, prior => prior.status === "manager-failed"
    ? prior : Object.freeze({ ...prior, status: "manager-failed", managerTerminalStatus: terminalStatus }));
}

async function updateProtectedContinuation(scope: ContinuationScope, identity: ContinuationIdentity, state: StateClient,
  update: (prior: ProtectedContinuation) => ProtectedContinuation) {
  let loaded: Awaited<ReturnType<typeof loadContinuationLedger>>;
  try { loaded = await loadContinuationLedger(scope, state); }
  catch { return { status: "unknown" as const, reason: "manager-dispatch-ledger-read-failed" };
  }
  const event = loaded.ledger.events.find(item => item.eventId === scope.verifiedEventId);
  const prior = event?.continuations?.find(item => continuationKey(item) === continuationKey(identity));
  if (!event || event.status !== "accepted" || !prior) return { status: "unknown" as const, reason: "manager-continuation-reservation-unavailable" };
  const nextContinuation = update(prior);
  if (JSON.stringify(nextContinuation) === JSON.stringify(prior)) return { status: "existing" as const, continuation: prior };
  const entry: Reservation = { ...event, continuations: event.continuations!.map(item => continuationKey(item) === continuationKey(identity) ? nextContinuation : item) };
  let saved: Awaited<ReturnType<typeof saveEntry>>;
  try { saved = await saveEntry(state, loaded.key, loaded.raw, loaded.ledger, entry); }
  catch { return { status: "unknown" as const, reason: "manager-continuation-update-uncertain" };
  }
  return saved.swapped ? { status: "updated" as const, continuation: nextContinuation }
    : { status: "conflict" as const, reason: "manager-continuation-update-conflict" };
}

function dispatchRequest(input: { workspaceId: string; projectId: string; workstreamId: string; eventId: string },
  snapshot: VerifiedWorkstreamSnapshot, evidenceDigest: string, requestId: string): ManagerDispatchRequest {
  return Object.freeze({ requestId, eventId: input.eventId, evidenceDigest,
    scope: Object.freeze({ workspaceId: input.workspaceId, projectId: input.projectId, workstreamId: input.workstreamId }), snapshot });
}

/**
 * Reserve current evidence. Without an approved effect port, persist a pending
 * no-effect reservation so the event is observable but not marked consumed.
 */
export async function consumeVerifiedWorkstream(input: Readonly<{
  workspaceId: string; projectId: string; workstreamId: string; eventId: string;
}>, state: StateClient, readCurrent: VerifiedSnapshotReader, manager?: ManagerDispatchPort): Promise<VerificationConsumeResult> {
  if (![input.workspaceId, input.eventId, input.workstreamId].every(value => typeof value === "string" && ID.test(value))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.projectId)) throw new TypeError("Invalid verified-event scope.");
  if (typeof state.compareAndSet !== "function") return outcome("unknown", input.eventId, "host-cas-unavailable");

  const key = keyFor(input.workspaceId, input.projectId, input.workstreamId);
  let current: VerifiedSnapshotRead | null = null;
  try { current = await readCurrent(input); } catch { /* Existing reservations still need receipt reconciliation. */ }
  const currentSnapshot = current?.status === "current" && validVerifiedWorkstreamSnapshot(current.snapshot, input) ? current.snapshot : null;
  const currentDigest = currentSnapshot ? digest(JSON.stringify(normalizeVerifiedWorkstreamSnapshot(currentSnapshot))) : null;

  let raw: JsonValue | null;
  let ledger: Ledger;
  try { raw = await state.get(key); ledger = parseLedger(raw, input.workspaceId, input.projectId, input.workstreamId); }
  catch { return outcome("unknown", input.eventId, "manager-dispatch-ledger-read-failed"); }

  let entry = ledger.events.find(item => item.eventId === input.eventId);
  let reservedForDispatch = false;
  if (entry?.requestId === null) {
    if (entry.status !== "pending" || entry.dispatchAttempts !== 0) {
      return outcome("uncertain", input.eventId, "legacy-event-has-no-safe-idempotency-key");
    }
    if (!currentSnapshot || !currentDigest) return outcome(current?.status === "stale" ? "stale" : "unknown", input.eventId,
      current?.status === "stale" ? "verification-event-stale-while-runner-unavailable" : "current-verified-evidence-unavailable",
      { evidenceDigest: entry.evidenceDigest });
    if (!manager) return outcome("pending", input.eventId, "approved-integration-runner-unavailable-no-effect-attempted",
      { evidenceDigest: entry.evidenceDigest });
    if (entry.evidenceDigest !== currentDigest) return outcome("stale", input.eventId,
      "verified-evidence-changed-while-integration-runner-unavailable", { evidenceDigest: entry.evidenceDigest });
    const requestId = `builder-ws-dispatch-v1:${digest(JSON.stringify([input.workspaceId, input.projectId, input.workstreamId, input.eventId, currentDigest]))}`;
    const promoted: Reservation = { ...entry, requestId, status: "pending", dispatchAttempts: 1 };
    let reserved;
    try { reserved = await saveEntry(state, key, raw, ledger, promoted); }
    catch { return outcome("uncertain", input.eventId, "runner-reservation-promotion-uncertain", { evidenceDigest: entry.evidenceDigest }); }
    if (!reserved.swapped) return outcome("conflict", input.eventId, "runner-reservation-promotion-conflict");
    raw = reserved.next as unknown as JsonValue;
    ledger = reserved.next;
    entry = promoted;
    reservedForDispatch = true;
  }
  if (entry && !manager) return outcome(entry.status === "accepted" ? "accepted"
    : entry.status === "pending" ? "pending" : "uncertain",
  input.eventId, entry.requestId === null ? "approved-integration-runner-unavailable-no-effect-attempted"
    : entry.status === "pending" ? "integration-request-reconciliation-unavailable" : "manager-dispatch-port-unavailable",
  { requestId: entry.requestId ?? undefined, evidenceDigest: entry.evidenceDigest,
    ...(entry.receipt ? { receipt: entry.receipt } : {}) });

  if (entry && manager && !reservedForDispatch) {
    let receipt: ManagerDispatchReceiptRead | null = null;
    try { receipt = validReceiptRead(await manager.readReceipt(entry.requestId!), entry.requestId!); } catch { /* Must not infer absence from a failed read. */ }
    if (!receipt || receipt.status === "uncertain") {
      if (entry.status === "pending") {
        const uncertain: Reservation = { ...entry, status: "uncertain" };
        try { await saveEntry(state, key, raw, ledger, uncertain); } catch { /* Keep the reservation; receipt can be reread. */ }
      }
      return outcome(entry.status === "accepted" ? "accepted" : "uncertain", input.eventId,
        receipt?.status === "uncertain" ? receipt.reason : "manager-receipt-read-uncertain",
        { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest, ...(entry.receipt ? { receipt: entry.receipt } : {}) });
    }
    if (receipt.status === "accepted") {
      const accepted: Reservation = { ...entry, status: "accepted", receipt: { receiptId: receipt.receiptId, runId: receipt.runId } };
      if (entry.status !== "accepted" || entry.receipt?.receiptId !== accepted.receipt?.receiptId
        || entry.receipt?.runId !== accepted.receipt?.runId) {
        try { await saveEntry(state, key, raw, ledger, accepted); } catch { /* Host receipt remains authoritative even if ledger readback is delayed. */ }
      }
      return outcome("accepted", input.eventId, "manager-acceptance-receipt-confirmed-not-completion",
        { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest, receipt: accepted.receipt! });
    }
    if (receipt.status === "pending") {
      if (entry.status === "uncertain") {
        const pending: Reservation = { ...entry, status: "pending" };
        try { await saveEntry(state, key, raw, ledger, pending); } catch { /* Keep the previous state; readback remains safe. */ }
      }
      return outcome(entry.status === "accepted" ? "uncertain" : "pending", input.eventId,
        entry.status === "accepted" ? "accepted-receipt-regressed-to-pending" : "manager-request-pending",
        { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest, ...(entry.receipt ? { receipt: entry.receipt } : {}) });
    }
    if (entry.status === "accepted") return outcome("uncertain", input.eventId, "accepted-receipt-missing-no-resend",
      { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest, ...(entry.receipt ? { receipt: entry.receipt } : {}) });
    if (!currentSnapshot || !currentDigest) return outcome(current?.status === "stale" ? "stale" : "unknown", input.eventId,
      current?.status === "stale" ? "verified-event-stale-before-dispatch-retry" : "current-verified-evidence-unavailable",
      { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest });
    if (entry.evidenceDigest !== currentDigest) return outcome("stale", input.eventId, "event-evidence-changed-no-resend",
      { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest });
    if (entry.dispatchAttempts >= MAX_DISPATCH_ATTEMPTS) return outcome("uncertain", input.eventId, "authoritative-absence-retry-limit",
      { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest });
    const retried: Reservation = { ...entry, status: "pending", dispatchAttempts: entry.dispatchAttempts + 1 };
    let reserved;
    try { reserved = await saveEntry(state, key, raw, ledger, retried); }
    catch (error) { return outcome(error instanceof RangeError ? "unknown" : "uncertain",
      input.eventId, error instanceof RangeError ? "manager-dispatch-ledger-capacity" : "retry-reservation-cas-uncertain",
      { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest }); }
    if (!reserved.swapped) return outcome("conflict", input.eventId, "retry-reservation-cas-conflict", { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest });
    raw = reserved.next as unknown as JsonValue;
    ledger = reserved.next;
    entry = retried;
  } else if (!entry) {
    if (!currentSnapshot || !currentDigest) return outcome(current?.status === "stale" ? "stale" : "unknown", input.eventId,
      current?.status === "stale" ? "verification-event-stale" : current?.status === "unknown" ? current.reason : "current-verification-evidence-unavailable");
    if (ledger.events.length >= MAX_EVENTS) return outcome("unknown", input.eventId, "manager-dispatch-ledger-capacity");
    if (!manager) {
      entry = { eventId: input.eventId, evidenceDigest: currentDigest, requestId: null, status: "pending", dispatchAttempts: 0, receipt: null };
      let reserved;
      try { reserved = await saveEntry(state, key, raw, ledger, entry); }
      catch (error) { return outcome(error instanceof RangeError ? "unknown" : "uncertain",
        input.eventId, error instanceof RangeError ? "manager-dispatch-ledger-capacity" : "unavailable-reservation-cas-uncertain",
        { evidenceDigest: currentDigest }); }
      if (!reserved.swapped) return outcome("conflict", input.eventId, "unavailable-reservation-cas-conflict");
      return outcome("pending", input.eventId, "approved-integration-runner-unavailable-no-effect-attempted",
        { evidenceDigest: currentDigest });
    }
    const requestId = `builder-ws-dispatch-v1:${digest(JSON.stringify([input.workspaceId, input.projectId, input.workstreamId, input.eventId, currentDigest]))}`;
    entry = { eventId: input.eventId, evidenceDigest: currentDigest, requestId, status: "pending", dispatchAttempts: 1, receipt: null };
    let reserved;
    try { reserved = await saveEntry(state, key, raw, ledger, entry); }
    catch (error) { return outcome(error instanceof RangeError ? "unknown" : "uncertain",
      input.eventId, error instanceof RangeError ? "manager-dispatch-ledger-capacity" : "dispatch-reservation-cas-uncertain",
      { requestId, evidenceDigest: currentDigest }); }
    if (!reserved.swapped) return outcome("conflict", input.eventId, "dispatch-reservation-cas-conflict", { requestId, evidenceDigest: currentDigest });
    raw = reserved.next as unknown as JsonValue;
    ledger = reserved.next;
  }

  let immediatelyCurrent: VerifiedSnapshotRead | null = null;
  try { immediatelyCurrent = await readCurrent(input); } catch { /* Fresh evidence is required before each effect. */ }
  if (!immediatelyCurrent || immediatelyCurrent.status !== "current" || !validVerifiedWorkstreamSnapshot(immediatelyCurrent.snapshot, input)) {
    const uncertain: Reservation = { ...entry!, status: "uncertain" };
    try { await saveEntry(state, key, raw, ledger, uncertain); } catch { /* Reservation remains for readback-only replay. */ }
    return outcome(immediatelyCurrent?.status === "stale" ? "stale" : "unknown", input.eventId,
      immediatelyCurrent?.status === "stale" ? "verification-event-revoked-before-dispatch" : "verification-reread-failed-before-dispatch",
      { requestId: entry!.requestId!, evidenceDigest: entry!.evidenceDigest });
  }
  const immediateDigest = digest(JSON.stringify(normalizeVerifiedWorkstreamSnapshot(immediatelyCurrent.snapshot)));
  if (immediateDigest !== entry!.evidenceDigest) {
    const uncertain: Reservation = { ...entry!, status: "uncertain" };
    try { await saveEntry(state, key, raw, ledger, uncertain); } catch { /* Preserve the original event key; never dispatch changed evidence. */ }
    return outcome("stale", input.eventId, "evidence-changed-before-dispatch", { requestId: entry!.requestId!, evidenceDigest: entry!.evidenceDigest });
  }

  if (!entry?.requestId) return outcome("unknown", input.eventId, "integration-task-reservation-id-unavailable");
  const request = dispatchRequest(input, normalizeVerifiedWorkstreamSnapshot(immediatelyCurrent.snapshot), entry.evidenceDigest, entry.requestId);
  try { await manager!.dispatch(request); } catch { /* Dispatch response loss is resolved only by authoritative readback. */ }
  let readback: ManagerDispatchReceiptRead | null = null;
  try { readback = validReceiptRead(await manager!.readReceipt(entry.requestId!), entry.requestId!); } catch { /* No status inference. */ }
  if (!readback || readback.status === "uncertain") {
    const uncertain: Reservation = { ...entry, status: "uncertain" };
    try { await saveEntry(state, key, raw, ledger, uncertain); } catch { /* Original reservation survives for replay. */ }
    return outcome("uncertain", input.eventId, readback?.status === "uncertain" ? readback.reason : "manager-receipt-read-uncertain",
      { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest });
  }
  if (readback.status === "pending") {
    // The attempt was already durably reserved as pending before dispatch.
    return outcome("pending", input.eventId, "manager-request-pending",
      { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest });
  }
  if (readback.status === "not-found") {
    const uncertain: Reservation = { ...entry, status: "uncertain" };
    try { await saveEntry(state, key, raw, ledger, uncertain); } catch { /* Preserve idempotency key before returning. */ }
    return outcome("uncertain", input.eventId, "authoritative-not-found-after-dispatch-no-same-call-retry",
      { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest });
  }
  const accepted: Reservation = { ...entry, status: "accepted", receipt: { receiptId: readback.receiptId, runId: readback.runId } };
  try { await saveEntry(state, key, raw, ledger, accepted); } catch { /* The receipt is authoritative; replay will read it again. */ }
  return outcome("accepted", input.eventId, "manager-acceptance-receipt-confirmed-not-completion",
    { requestId: entry.requestId!, evidenceDigest: entry.evidenceDigest, receipt: accepted.receipt! });
}
