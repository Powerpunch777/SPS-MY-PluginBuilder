/**
 * Pure, conservative Builder-side document freshness evaluation.
 * This module does not authorize a caller, authenticate evidence itself, persist data,
 * edit a document body, or approve a recommendation.
 */

export type DocumentCategoryIdentity = Readonly<{
  id: string;
  /** Canonical A source adapter and record type for this logical category tag. */
  sourceId: string;
  /** Server-owned mapping fields. Missing values keep the evaluation UNKNOWN. */
  mappingType?: string | null;
  mappingVersion?: string | null;
  mappingEvidenceRef?: string | null;
}>;

export type DocumentIdentity = Readonly<{
  workspaceId: string;
  projectId: string;
  documentId: string;
  /** Opaque range-specific category identity; this module invents no category names. */
  category: DocumentCategoryIdentity;
}>;

export type DocumentSourcePin = Readonly<{
  sourceId: string;
  revisionId: string;
  sourceSha256: string;
}>;

export type SourceRevisionSet = Readonly<{
  revisionId: string;
  pins: readonly DocumentSourcePin[];
  source: Readonly<{ status: "available" | "unknown"; evidenceRef: string | null }>;
  access: Readonly<{ status: "granted" | "denied" | "unknown"; evidenceRef: string | null }>;
  coverage: Readonly<{ status: "complete" | "unknown"; evidenceRef: string | null }>;
}>;

export type TraceAvailability = "complete" | "missing" | "access-denied" | "source-unavailable" | "index-incomplete";
export type ApprovalStatus = "approved" | "pending" | "rejected" | "unknown";
export type FreshnessStatus = "CURRENT" | "AFFECTED" | "UNKNOWN";
export type FreshnessCause =
  | "authority-unverified"
  | "category-unverified"
  | "snapshot-source-unverified"
  | "snapshot-access-unverified"
  | "snapshot-access-denied"
  | "snapshot-coverage-unverified"
  | "trace-unverified"
  | "trace-missing"
  | "trace-incomplete"
  | "access-denied"
  | "source-unavailable"
  | "index-incomplete"
  | "identity-mismatch"
  | "revision-pin-missing"
  | "changed-source-pin";

export type DocumentTrace = Readonly<{
  documentId: string;
  categoryId: string;
  documentRevisionId: string;
  availability: TraceAvailability;
  evidenceRef: string | null;
  /** Empty is meaningful only when availability is complete. */
  dependencies: readonly DocumentSourcePin[];
}>;

export type DocumentFreshnessInput = Readonly<{
  identity: DocumentIdentity;
  authority: Readonly<{ evidenceRef: string | null }>;
  revisions: Readonly<{ old: SourceRevisionSet; new: SourceRevisionSet }>;
  trace: DocumentTrace | null;
}>;

export type FreshnessEvidenceClaim =
  | Readonly<{ kind: "authority"; workspaceId: string; projectId: string; documentId: string; evidenceRef: string }>
  | Readonly<{ kind: "category-mapping"; workspaceId: string; projectId: string; documentId: string; documentRevisionId: string; categoryId: string; sourceId: string; type: string; mappingVersion: string; evidenceRef: string }>
  | Readonly<{ kind: "snapshot-source" | "snapshot-access" | "snapshot-coverage"; workspaceId: string; projectId: string; side: "old" | "new"; revisionId: string; pins: readonly DocumentSourcePin[]; value: string; evidenceRef: string }>
  | Readonly<{ kind: "document-trace"; workspaceId: string; projectId: string; documentId: string; categoryId: string; documentRevisionId: string; oldRevisionId: string; newRevisionId: string; availability: TraceAvailability; dependencies: readonly DocumentSourcePin[]; evidenceRef: string }>;

/** Must be supplied by the trusted source adapter; booleans from task inputs are not authentication. */
export type FreshnessEvidenceVerifier = (claim: FreshnessEvidenceClaim) => boolean;

export type FreshnessEvaluation = Readonly<{
  identity: DocumentIdentity;
  evaluatedAgainst: Readonly<{ oldRevisionId: string; newRevisionId: string }>;
  status: FreshnessStatus;
  causes: readonly FreshnessCause[];
  changedSourceIds: readonly string[];
  traceDocumentRevisionId: string | null;
}>;

export type FreshnessEvaluationClaim = Readonly<{
  kind: "freshness-evaluation";
  workspaceId: string;
  projectId: string;
  documentId: string;
  identity: DocumentIdentity;
  evaluatedAgainst: Readonly<{ oldRevisionId: string; newRevisionId: string }>;
  status: FreshnessStatus;
  causes: readonly FreshnessCause[];
  changedSourceIds: readonly string[];
  traceDocumentRevisionId: string | null;
}>;

/** Must be supplied by a trusted source adapter that verifies the entire bound evaluation. */
export type FreshnessEvaluationVerifier = (claim: FreshnessEvaluationClaim) => boolean;

export type ApprovalRecord = Readonly<{ status: ApprovalStatus; evidenceRef: string | null }>;

export type FreshnessRecommendation = Readonly<{
  identity: DocumentIdentity;
  action: "draft" | "review";
  basedOnDocumentRevisionId: string;
  causes: readonly FreshnessCause[];
}>;

export type FreshnessEventKind = "analysis" | "baseline" | "ui" | "criteria" | "cr" | "task" | "qa";
export type FreshnessEvent = Readonly<{
  eventId: string;
  workspaceId: string;
  projectId: string;
  sequence: number;
  expectedBaseSequence: number;
  expectedEvaluationId: string;
  expectedOldRevisionId: string;
  expectedNewRevisionId: string;
  expectedBaseSourceRevisionId: string;
  sourceRevisionId: string;
  eventKind: FreshnessEventKind;
  evaluationId: string;
  evaluation: FreshnessEvaluation;
}>;

export type FreshnessConsumerState = Readonly<{
  identity: DocumentIdentity;
  cursor: number;
  evaluationId: string;
  freshness: FreshnessEvaluation;
  approval: ApprovalRecord;
  /** References are carried forward exactly; this consumer never writes bodies/history. */
  bodyRef: string | null;
  historyRefs: readonly string[];
  processedEventIds: readonly string[];
  processedEvents: readonly Readonly<{ eventId: string; fingerprint: string }>[];
}>;

export type FreshnessEventResult =
  | Readonly<{ status: "applied"; state: FreshnessConsumerState }>
  | Readonly<{ status: "duplicate" | "duplicate-mismatch" | "stale" | "stale-evaluation" | "evaluation-unverified" | "out-of-order" | "conflict" | "wrong-scope"; state: FreshnessConsumerState }>;

const HASH = /^[0-9a-f]{64}$/u;
const EVENT_KINDS: readonly FreshnessEventKind[] = ["analysis", "baseline", "ui", "criteria", "cr", "task", "qa"];
const FRESHNESS_CAUSES: readonly FreshnessCause[] = [
  "authority-unverified", "category-unverified", "snapshot-source-unverified", "snapshot-access-unverified",
  "snapshot-access-denied", "snapshot-coverage-unverified", "trace-unverified", "trace-missing", "trace-incomplete", "access-denied",
  "source-unavailable", "index-incomplete", "identity-mismatch", "revision-pin-missing", "changed-source-pin",
];

function id(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank identifier without ASCII controls.`);
  }
  return value;
}

function pinMap(pins: readonly DocumentSourcePin[], label: string): Map<string, DocumentSourcePin> {
  const result = new Map<string, DocumentSourcePin>();
  for (const pin of pins) {
    id(pin.sourceId, `${label}.sourceId`);
    id(pin.revisionId, `${label}.revisionId`);
    if (!HASH.test(pin.sourceSha256)) throw new TypeError(`${label}.sourceSha256 must be a lowercase SHA-256 digest.`);
    if (result.has(pin.sourceId)) throw new TypeError(`${label} contains duplicate source IDs.`);
    result.set(pin.sourceId, Object.freeze({ ...pin }));
  }
  return result;
}

function samePin(a: DocumentSourcePin | undefined, b: DocumentSourcePin | undefined): boolean {
  return !!a && !!b && a.revisionId === b.revisionId && a.sourceSha256 === b.sourceSha256;
}

function canonicalPins(pins: readonly DocumentSourcePin[]): readonly DocumentSourcePin[] {
  return Object.freeze([...pins].map(pin => Object.freeze({ ...pin })).sort((a, b) => a.sourceId.localeCompare(b.sourceId)));
}

/** Mapping metadata may be established or versioned only by the trusted evaluation verifier. */
function sameDocumentCategory(a: DocumentIdentity, b: DocumentIdentity): boolean {
  const left = freezeIdentity(a);
  const right = freezeIdentity(b);
  return left.workspaceId === right.workspaceId
    && left.projectId === right.projectId
    && left.documentId === right.documentId
    && left.category.id === right.category.id
    && left.category.sourceId === right.category.sourceId;
}

function hasVerifiedMapping(identity: DocumentIdentity): boolean {
  const category = identity.category;
  return !!category.mappingType && !!category.mappingVersion && !!category.mappingEvidenceRef;
}

function hasPartialMapping(identity: DocumentIdentity): boolean {
  const category = identity.category;
  const present = [category.mappingType, category.mappingVersion, category.mappingEvidenceRef]
    .map(value => value != null);
  return present.some(Boolean) && present.some(value => !value);
}

function fingerprint(event: FreshnessEvent): string {
  const evaluation = freezeEvaluation(event.evaluation);
  return JSON.stringify({
    eventId: event.eventId, workspaceId: event.workspaceId, projectId: event.projectId,
    sequence: event.sequence, expectedBaseSequence: event.expectedBaseSequence,
    expectedEvaluationId: event.expectedEvaluationId, expectedOldRevisionId: event.expectedOldRevisionId,
    expectedNewRevisionId: event.expectedNewRevisionId, expectedBaseSourceRevisionId: event.expectedBaseSourceRevisionId,
    sourceRevisionId: event.sourceRevisionId, eventKind: event.eventKind, evaluationId: event.evaluationId,
    evaluation,
  });
}

function freezeIdentity(identity: DocumentIdentity): DocumentIdentity {
  return Object.freeze({
    workspaceId: id(identity.workspaceId, "identity.workspaceId"),
    projectId: id(identity.projectId, "identity.projectId"),
    documentId: id(identity.documentId, "identity.documentId"),
    category: Object.freeze({
      id: id(identity.category.id, "identity.category.id"),
      sourceId: id(identity.category.sourceId, "identity.category.sourceId"),
      mappingType: identity.category.mappingType == null ? null : id(identity.category.mappingType, "identity.category.mappingType"),
      mappingVersion: identity.category.mappingVersion == null ? null : id(identity.category.mappingVersion, "identity.category.mappingVersion"),
      mappingEvidenceRef: identity.category.mappingEvidenceRef == null ? null : id(identity.category.mappingEvidenceRef, "identity.category.mappingEvidenceRef"),
    }),
  });
}

function freezeEvaluation(evaluation: FreshnessEvaluation): FreshnessEvaluation {
  if (!( ["CURRENT", "AFFECTED", "UNKNOWN"] as const).includes(evaluation.status)) {
    throw new TypeError("evaluation.status is unsupported.");
  }
  const causes = [...new Set(evaluation.causes)];
  for (const cause of causes) if (!FRESHNESS_CAUSES.includes(cause)) throw new TypeError("evaluation.causes contains an unsupported cause.");
  const changedSourceIds = [...new Set(evaluation.changedSourceIds.map(sourceId => id(sourceId, "evaluation.changedSourceIds[]")))].sort();
  return Object.freeze({
    identity: freezeIdentity(evaluation.identity),
    evaluatedAgainst: Object.freeze({
      oldRevisionId: id(evaluation.evaluatedAgainst.oldRevisionId, "evaluation.evaluatedAgainst.oldRevisionId"),
      newRevisionId: id(evaluation.evaluatedAgainst.newRevisionId, "evaluation.evaluatedAgainst.newRevisionId"),
    }),
    status: evaluation.status,
    causes: Object.freeze(causes.sort()),
    changedSourceIds: Object.freeze(changedSourceIds),
    traceDocumentRevisionId: evaluation.traceDocumentRevisionId === null
      ? null
      : id(evaluation.traceDocumentRevisionId, "evaluation.traceDocumentRevisionId"),
  });
}

/**
 * CURRENT requires independently verifiable authority, scope, snapshot access,
 * source availability, collection coverage, and a complete document trace.
 * The verifier must be supplied by a trusted adapter; caller flags alone do not prove evidence.
 */
export function evaluateDocumentFreshness(
  input: DocumentFreshnessInput,
  verifyEvidence: FreshnessEvidenceVerifier,
): FreshnessEvaluation {
  const identity = freezeIdentity(input.identity);
  id(input.revisions.old.revisionId, "revisions.old.revisionId");
  id(input.revisions.new.revisionId, "revisions.new.revisionId");
  const oldPins = pinMap(input.revisions.old.pins, "revisions.old.pins");
  const newPins = pinMap(input.revisions.new.pins, "revisions.new.pins");
  const causes = new Set<FreshnessCause>();
  const changedSourceIds: string[] = [];
  const sourceIds = new Set([...oldPins.keys(), ...newPins.keys()]);
  for (const sourceId of sourceIds) {
    if (!samePin(oldPins.get(sourceId), newPins.get(sourceId))) changedSourceIds.push(sourceId);
  }
  changedSourceIds.sort();

  const isVerified = (claim: FreshnessEvidenceClaim): boolean => {
    try { return verifyEvidence(claim) === true; } catch { return false; }
  };
  const authorityEvidence = input.authority.evidenceRef;
  if (!authorityEvidence || !isVerified({ kind: "authority", workspaceId: identity.workspaceId, projectId: identity.projectId, documentId: identity.documentId, evidenceRef: authorityEvidence })) {
    causes.add("authority-unverified");
  }
  const categoryMapping = identity.category.mappingType && identity.category.mappingVersion && identity.category.mappingEvidenceRef && input.trace
    ? { kind: "category-mapping" as const, workspaceId: identity.workspaceId, projectId: identity.projectId,
      documentId: identity.documentId, documentRevisionId: input.trace.documentRevisionId, categoryId: identity.category.id,
      sourceId: identity.category.sourceId, type: identity.category.mappingType,
      mappingVersion: identity.category.mappingVersion, evidenceRef: identity.category.mappingEvidenceRef }
    : null;
  if (!categoryMapping || !isVerified(categoryMapping)) causes.add("category-unverified");
  for (const [side, snapshot] of [["old", input.revisions.old], ["new", input.revisions.new]] as const) {
    const pins = canonicalPins(snapshot.pins);
    const verifySnapshot = (kind: "snapshot-source" | "snapshot-access" | "snapshot-coverage", value: string, evidenceRef: string | null): boolean =>
      !!evidenceRef && isVerified({ kind, workspaceId: identity.workspaceId, projectId: identity.projectId, side, revisionId: snapshot.revisionId, pins, value, evidenceRef });
    if (snapshot.source.status !== "available" || !verifySnapshot("snapshot-source", snapshot.source.status, snapshot.source.evidenceRef)) {
      causes.add("snapshot-source-unverified");
    }
    if (snapshot.access.status === "denied") causes.add("snapshot-access-denied");
    else if (snapshot.access.status !== "granted" || !verifySnapshot("snapshot-access", snapshot.access.status, snapshot.access.evidenceRef)) {
      causes.add("snapshot-access-unverified");
    }
    if (snapshot.coverage.status !== "complete" || !verifySnapshot("snapshot-coverage", snapshot.coverage.status, snapshot.coverage.evidenceRef)) {
      causes.add("snapshot-coverage-unverified");
    }
  }
  const trace = input.trace;
  if (!trace) {
    causes.add("trace-missing");
  } else {
    if (trace.documentId !== identity.documentId || trace.categoryId !== identity.category.id) causes.add("identity-mismatch");
    id(trace.documentRevisionId, "trace.documentRevisionId");
    const dependencies = pinMap(trace.dependencies, "trace.dependencies");
    if (!trace.evidenceRef || !isVerified({ kind: "document-trace", workspaceId: identity.workspaceId, projectId: identity.projectId, documentId: identity.documentId,
      categoryId: identity.category.id, documentRevisionId: trace.documentRevisionId, oldRevisionId: input.revisions.old.revisionId, newRevisionId: input.revisions.new.revisionId,
      availability: trace.availability, dependencies: canonicalPins([...dependencies.values()]), evidenceRef: trace.evidenceRef })) causes.add("trace-unverified");
    if (trace.availability === "missing") causes.add("trace-missing");
    if (trace.availability === "access-denied") causes.add("access-denied");
    if (trace.availability === "source-unavailable") causes.add("source-unavailable");
    if (trace.availability === "index-incomplete") causes.add("index-incomplete");
    if (trace.availability !== "complete") causes.add("trace-incomplete");
    // The trace is a complete dependency index only if its evidence verifier authenticated this exact list.
    for (const [sourceId, traced] of dependencies) {
      const oldPin = oldPins.get(sourceId);
      const newPin = newPins.get(sourceId);
      if (!oldPin || !newPin) {
        causes.add("revision-pin-missing");
      } else if (!samePin(oldPin, newPin)) {
        // The trace must bind to one side of the comparison to identify a cause.
        if (!samePin(traced, oldPin) && !samePin(traced, newPin)) causes.add("revision-pin-missing");
        else causes.add("changed-source-pin");
      } else if (!samePin(traced, newPin)) {
        causes.add("revision-pin-missing");
      }
    }
    if (trace.availability === "complete") {
      for (const sourceId of changedSourceIds) {
        if (dependencies.has(sourceId)) causes.add("changed-source-pin");
      }
    }
  }

  const hardUnknown = [...causes].some(cause => cause !== "changed-source-pin");
  const status: FreshnessStatus = hardUnknown ? "UNKNOWN" : causes.has("changed-source-pin") ? "AFFECTED" : "CURRENT";
  return Object.freeze({
    identity,
    evaluatedAgainst: Object.freeze({ oldRevisionId: input.revisions.old.revisionId, newRevisionId: input.revisions.new.revisionId }),
    status,
    causes: Object.freeze([...causes].sort()),
    changedSourceIds: Object.freeze(changedSourceIds),
    traceDocumentRevisionId: trace?.documentRevisionId ?? null,
  });
}

/** Only affected documents receive a recommendation; this function never approves or writes it. */
export function recommendAffectedDocument(
  freshness: FreshnessEvaluation,
  approval: ApprovalRecord,
): FreshnessRecommendation | null {
  if (freshness.status !== "AFFECTED" || !hasVerifiedMapping(freshness.identity)) return null;
  const documentRevisionId = freshness.traceDocumentRevisionId;
  if (!documentRevisionId) return null;
  return Object.freeze({
    identity: freezeIdentity(freshness.identity),
    action: approval.status === "approved" ? "review" : "draft",
    basedOnDocumentRevisionId: documentRevisionId,
    causes: Object.freeze([...freshness.causes]),
  });
}

/** Idempotent, ordered, CAS-style derived-view consumer. The host must persist atomically. */
export function consumeFreshnessEvent(
  state: FreshnessConsumerState,
  event: FreshnessEvent,
  verifyEvaluation: FreshnessEvaluationVerifier,
): FreshnessEventResult {
  id(event.eventId, "event.eventId");
  const prior = state.processedEvents.find(item => item.eventId === event.eventId);
  if (prior) return Object.freeze({ status: prior.fingerprint === fingerprint(event) ? "duplicate" : "duplicate-mismatch", state });
  if (event.sequence <= state.cursor) return Object.freeze({ status: "stale", state });
  if (event.sequence !== state.cursor + 1) return Object.freeze({ status: "out-of-order", state });
  const currentSourceRevisionId = state.freshness.evaluatedAgainst.newRevisionId;
  if (event.expectedBaseSequence !== state.cursor || event.expectedEvaluationId !== state.evaluationId
    || event.expectedOldRevisionId !== currentSourceRevisionId
    || event.expectedBaseSourceRevisionId !== currentSourceRevisionId) {
    return Object.freeze({ status: "conflict", state });
  }
  if (event.workspaceId !== state.identity.workspaceId || event.projectId !== state.identity.projectId
    || !sameDocumentCategory(event.evaluation.identity, state.identity)) {
    return Object.freeze({ status: "wrong-scope", state });
  }
  id(event.evaluationId, "event.evaluationId");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new TypeError("event.sequence must be a positive safe integer.");
  if (!EVENT_KINDS.includes(event.eventKind)) throw new TypeError("event.eventKind is unsupported.");
  const suppliedEvaluation = freezeEvaluation(event.evaluation);
  if (hasPartialMapping(suppliedEvaluation.identity)) return Object.freeze({ status: "evaluation-unverified", state });
  // A verifier may authenticate claims, but cannot make an absent server mapping
  // authoritative. Keep the event/cursor semantics while exposing only UNKNOWN.
  const evaluation = hasVerifiedMapping(suppliedEvaluation.identity) ? suppliedEvaluation : Object.freeze({
    ...suppliedEvaluation,
    status: "UNKNOWN" as const,
    causes: Object.freeze([...new Set([...suppliedEvaluation.causes, "category-unverified" as const])].sort()),
  });
  if (evaluation.evaluatedAgainst.oldRevisionId !== currentSourceRevisionId
    || evaluation.evaluatedAgainst.oldRevisionId !== event.expectedOldRevisionId
    || evaluation.evaluatedAgainst.newRevisionId !== event.expectedNewRevisionId
    || event.sourceRevisionId !== event.expectedNewRevisionId) return Object.freeze({ status: "stale-evaluation", state });
  if (typeof verifyEvaluation !== "function") return Object.freeze({ status: "evaluation-unverified", state });
  const claim: FreshnessEvaluationClaim = Object.freeze({
    kind: "freshness-evaluation",
    workspaceId: state.identity.workspaceId,
    projectId: state.identity.projectId,
    documentId: state.identity.documentId,
    ...evaluation,
  });
  let evaluationVerified = false;
  try { evaluationVerified = verifyEvaluation(claim) === true; } catch { evaluationVerified = false; }
  if (!evaluationVerified) return Object.freeze({ status: "evaluation-unverified", state });
  const next: FreshnessConsumerState = Object.freeze({
    ...state,
    identity: evaluation.identity,
    cursor: event.sequence,
    evaluationId: event.evaluationId,
    freshness: evaluation,
    approval: Object.freeze({ ...state.approval }),
    bodyRef: state.bodyRef,
    historyRefs: Object.freeze([...state.historyRefs]),
    processedEventIds: Object.freeze([...state.processedEventIds, event.eventId]),
    processedEvents: Object.freeze([...state.processedEvents, Object.freeze({ eventId: event.eventId, fingerprint: fingerprint(event) })]),
  });
  return Object.freeze({ status: "applied", state: next });
}
