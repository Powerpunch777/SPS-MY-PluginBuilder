import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const ID_LIMIT = 160;
const TITLE_LIMIT = 1_024;
const BODY_LIMIT = 192 * 1_024;
const PAGE_LIMIT = 200;
const DIGEST = /^[a-f0-9]{64}$/u;

export const DOCUMENT_CATEGORIES = Object.freeze([
  "consultation", "design", "ui-design", "validation", "technology",
  "development", "change", "test-qa", "delivery",
] as const);
export type DocumentCategory = typeof DOCUMENT_CATEGORIES[number];

export const APPROVAL_STATES = Object.freeze([
  "draft", "in-review", "approved", "superseded", "archived", "unknown",
] as const);
export type DocumentApprovalState = typeof APPROVAL_STATES[number];

export const FRESHNESS_STATES = Object.freeze([
  "current", "review-required", "stale", "unknown",
] as const);
export type DocumentFreshnessState = typeof FRESHNESS_STATES[number];

export type DocumentReference = Readonly<{
  kind: "source" | "revision" | "requirement" | "change-request" | "workstream" | "task" | "artifact" | "document";
  id: string;
  revisionId: string | null;
  label: string;
}>;

export type DocumentApproval = Readonly<{
  state: DocumentApprovalState;
  evidenceId: string | null;
  actorId: string | null;
  decidedAt: string | null;
}>;

/** A read projection over an existing authoritative Builder store or Artifact. */
export type ProjectDocumentRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  id: string;
  category: DocumentCategory;
  type: string;
  title: string;
  body: string;
  revisionId: string;
  createdAt: string;
  modifiedAt: string;
  authorId: string | null;
  approval: DocumentApproval;
  freshness: DocumentFreshnessState;
  freshnessReason: string | null;
  references: readonly DocumentReference[];
}>;

/** Exact approval-time content and source pins; never regenerated in place. */
export type ApprovedDocumentSnapshot = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  documentId: string;
  documentRevisionId: string;
  body: string;
  bodySha256: string;
  sourceRevisions: readonly Readonly<{ kind: DocumentReference["kind"]; id: string; revisionId: string }>[];
  approvalEvidenceId: string;
  approvedBy: string;
  approvedAt: string;
  capturedAt: string;
}>;

export type DocumentUnavailableReason =
  | "source-not-configured" | "source-not-supported" | "scope-unavailable"
  | "authorization-unavailable" | "source-failed" | "size-limit";

export type DocumentSourcePage = Readonly<{
  items: readonly ProjectDocumentRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  unavailableReason?: DocumentUnavailableReason;
}>;

/** Adapter boundary: the caller binds this to the current authorized Workspace/project. */
export interface ProjectDocumentSource {
  readonly id: string;
  readonly category: DocumentCategory;
  read(input: Readonly<{ workspaceId: string; projectId: string; cursor: string | null; limit: number }>): Promise<DocumentSourcePage>;
  readOne(input: Readonly<{ workspaceId: string; projectId: string; documentId: string }>): Promise<ProjectDocumentRecord | null>;
}

export type ProjectDocumentEvent = Readonly<{
  eventId: string;
  workspaceId: string;
  projectId: string;
  sourceKind: DocumentReference["kind"];
  sourceId: string;
  sourceRevisionId: string;
  eventType: "revision-published" | "approval-recorded" | "source-received" | "task-updated" | "qa-result-recorded";
  occurredAt: string;
}>;

export type ProjectDocumentEventReader = (input: Readonly<{
  workspaceId: string;
  projectId: string;
  afterEventId: string | null;
  limit: number;
}>) => Promise<Readonly<{ events: readonly ProjectDocumentEvent[]; nextCursor: string | null; hasMore: boolean }>>;

export type DocumentQuery = Readonly<{
  text?: string;
  category?: DocumentCategory;
  type?: string;
  approval?: DocumentApprovalState;
  freshness?: DocumentFreshnessState;
  relatedId?: string;
  sort?: "modified-asc" | "modified-desc" | "title" | "type" | "revision";
  cursor?: string | null;
  limit?: number;
}>;

export type ProjectDocumentPage = Readonly<{
  items: readonly ProjectDocumentRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  unavailable: readonly Readonly<{ category: DocumentCategory; reason: DocumentUnavailableReason }>[];
}>;

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} has a symbol field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label}.${key} must be data.`);
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, label: string, maximumBytes: number, blank = false): string {
  if (typeof value !== "string" || (!blank && !value.trim()) || encoder.encode(value).byteLength > maximumBytes) {
    throw new TypeError(`${label} must be ${blank ? "text" : "nonblank text"} within its UTF-8 size limit.`);
  }
  return value;
}

function id(value: unknown, label: string): string {
  const result = text(value, label, ID_LIMIT, false);
  if (/[\u0000-\u001f\u007f]/u.test(result)) throw new TypeError(`${label} contains control characters.`);
  return result;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  return value;
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${label} is unsupported.`);
  return value as T[number];
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`${label} must be a dense bounded list.`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} contains non-data.`);
    return descriptor.value;
  });
}

export function parseDocumentReference(value: unknown): DocumentReference {
  const row = plainRecord(value, "document reference");
  if (Reflect.ownKeys(row).length !== 4) throw new TypeError("Document reference has unknown or missing fields.");
  const kind = enumValue(row.kind, ["source", "revision", "requirement", "change-request", "workstream", "task", "artifact", "document"] as const, "reference.kind");
  return Object.freeze({ kind, id: id(row.id, "reference.id"),
    revisionId: row.revisionId === null ? null : id(row.revisionId, "reference.revisionId"),
    label: text(row.label, "reference.label", TITLE_LIMIT) });
}

export function parseProjectDocument(value: unknown, expected: Readonly<{ workspaceId: string; projectId: string }>): ProjectDocumentRecord {
  const row = plainRecord(value, "project document");
  const fields = ["workspaceId", "projectId", "id", "category", "type", "title", "body", "revisionId", "createdAt", "modifiedAt", "authorId", "approval", "freshness", "freshnessReason", "references"];
  if (Reflect.ownKeys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))) throw new TypeError("Project document has unknown or missing fields.");
  const workspaceId = id(row.workspaceId, "document.workspaceId"), projectId = id(row.projectId, "document.projectId");
  if (workspaceId !== expected.workspaceId || projectId !== expected.projectId) throw new Error("Cross-Workspace or cross-project document rejected.");
  const approvalRow = plainRecord(row.approval, "document approval");
  if (Reflect.ownKeys(approvalRow).length !== 4 || !["state", "evidenceId", "actorId", "decidedAt"].every(field => Object.hasOwn(approvalRow, field))) throw new TypeError("Document approval has unknown or missing fields.");
  const approval: DocumentApproval = Object.freeze({
    state: enumValue(approvalRow.state, APPROVAL_STATES, "approval.state"),
    evidenceId: approvalRow.evidenceId === null ? null : id(approvalRow.evidenceId, "approval.evidenceId"),
    actorId: approvalRow.actorId === null ? null : id(approvalRow.actorId, "approval.actorId"),
    decidedAt: approvalRow.decidedAt === null ? null : iso(approvalRow.decidedAt, "approval.decidedAt"),
  });
  if (approval.state === "approved" && (!approval.evidenceId || !approval.actorId || !approval.decidedAt)) {
    throw new TypeError("Approved status requires preserved approval evidence, actor, and time.");
  }
  if (approval.state !== "approved" && approval.evidenceId === null && (approval.actorId !== null || approval.decidedAt !== null)) {
    throw new TypeError("Approval actor/time cannot exist without approval evidence.");
  }
  if (row.authorId !== null && typeof row.authorId !== "string") throw new TypeError("document.authorId is invalid.");
  const freshness = enumValue(row.freshness, FRESHNESS_STATES, "document.freshness");
  const freshnessReason = row.freshnessReason === null ? null : text(row.freshnessReason, "document.freshnessReason", 4_096);
  if ((freshness === "unknown" || freshness === "review-required" || freshness === "stale") && !freshnessReason) {
    throw new TypeError("Non-current freshness requires an explicit reason.");
  }
  if (freshness === "current" && freshnessReason !== null) throw new TypeError("Current freshness must not carry a stale reason.");
  const references = list(row.references, 256, "document.references").map(parseDocumentReference);
  const referenceKeys = references.map(ref => `${ref.kind}\0${ref.id}\0${ref.revisionId ?? ""}`);
  if (new Set(referenceKeys).size !== referenceKeys.length) throw new TypeError("Document references must be unique.");
  return Object.freeze({ workspaceId, projectId, id: id(row.id, "document.id"),
    category: enumValue(row.category, DOCUMENT_CATEGORIES, "document.category"),
    type: id(row.type, "document.type"), title: text(row.title, "document.title", TITLE_LIMIT),
    body: text(row.body, "document.body", BODY_LIMIT, true), revisionId: id(row.revisionId, "document.revisionId"),
    createdAt: iso(row.createdAt, "document.createdAt"), modifiedAt: iso(row.modifiedAt, "document.modifiedAt"),
    authorId: row.authorId === null ? null : id(row.authorId, "document.authorId"), approval,
    freshness, freshnessReason, references: Object.freeze(references) });
}

export function createApprovedSnapshot(input: Readonly<{
  document: ProjectDocumentRecord;
  sourceRevisions: readonly Readonly<{ kind: DocumentReference["kind"]; id: string; revisionId: string }>[];
  capturedAt: string;
}>): ApprovedDocumentSnapshot {
  const document = parseProjectDocument(input.document, input.document);
  const approval = document.approval;
  if (approval.state !== "approved" || !approval.evidenceId || !approval.actorId || !approval.decidedAt) {
    throw new Error("Only an already-approved document with persisted approval evidence can be snapshotted.");
  }
  const sourceRevisions = input.sourceRevisions.map((source, index) => {
    const row = plainRecord(source, `sourceRevisions[${index}]`);
    if (Reflect.ownKeys(row).length !== 3) throw new TypeError("Invalid source revision pin.");
    const kind = enumValue(row.kind, ["source", "revision", "requirement", "change-request", "workstream", "task", "artifact", "document"] as const, "sourceRevision.kind");
    const ref = Object.freeze({ kind, id: id(row.id, "sourceRevision.id"), revisionId: id(row.revisionId, "sourceRevision.revisionId") });
    if (!document.references.some(candidate => candidate.kind === ref.kind && candidate.id === ref.id && candidate.revisionId === ref.revisionId)) {
      throw new Error("Snapshot source revision is not pinned by the document record.");
    }
    return ref;
  });
  const unique = sourceRevisions.map(ref => `${ref.kind}\0${ref.id}\0${ref.revisionId}`);
  if (new Set(unique).size !== unique.length) throw new TypeError("Snapshot source revision pins must be unique.");
  const requiredPins = document.references.filter((reference): reference is typeof reference & { revisionId: string } => reference.revisionId !== null)
    .map(reference => `${reference.kind}\0${reference.id}\0${reference.revisionId}`);
  const suppliedPins = new Set(unique);
  if (requiredPins.some(pin => !suppliedPins.has(pin))) {
    throw new Error("Snapshot must pin every versioned document reference.");
  }
  const bodySha256 = createHash("sha256").update(document.body, "utf8").digest("hex");
  return Object.freeze({ schemaVersion: 1, workspaceId: document.workspaceId, projectId: document.projectId,
    documentId: document.id, documentRevisionId: document.revisionId, body: document.body, bodySha256,
    sourceRevisions: Object.freeze(sourceRevisions), approvalEvidenceId: approval.evidenceId,
    approvedBy: approval.actorId, approvedAt: approval.decidedAt, capturedAt: iso(input.capturedAt, "capturedAt") });
}

export function assertDocumentBounds(input: Readonly<{ pageLimit?: number }>): number {
  const limit = input.pageLimit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new TypeError(`Document page size must be 1 through ${PAGE_LIMIT}.`);
  return limit;
}

