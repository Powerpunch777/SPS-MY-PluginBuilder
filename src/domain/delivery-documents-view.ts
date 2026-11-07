import type { BuilderDocument } from "./model.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^delivery-documents-v1:[a-f0-9]{64}$/u;
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid delivery document view.");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError("Invalid delivery document view fields.");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Delivery document view fields must be own data properties.");
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(value)
    || [...value].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) {
    throw new TypeError(`Invalid delivery document ${label}.`);
  }
  return value;
}

/** Project the read-only server DTO into strict BuilderDocument rows; hashes are server-verified, not re-hashed in the browser. */
export function projectDeliveryDocuments(expectedWorkspaceId: string, value: unknown): readonly BuilderDocument[] {
  const wrapper = record(value, ["workspaceId", "projectId", "read"]);
  const workspaceId = text(wrapper.workspaceId, "workspace ID", 160);
  if (workspaceId !== expectedWorkspaceId || wrapper.projectId !== workspaceId) throw new TypeError("Cross-Workspace delivery document view.");
  const read = record(wrapper.read, ["status", "reason", "document", "source", "currentRevisionId", "confirmed", "completeness"]);
  if (read.status === "unavailable" && read.document === null) return Object.freeze([]);
  if (read.status !== "available" || !["current", "stale", "unknown"].includes(read.source as string)
    || read.confirmed !== false || read.completeness !== "unknown" || read.reason !== null && typeof read.reason !== "string") {
    throw new TypeError("Delivery document source freshness or draft status is not verified.");
  }
  const doc = record(read.document, ["schemaVersion", "workspaceId", "projectId", "revisionId", "createdAt", "status", "approvalStatus",
    "author", "baseline", "ui", "integrationPlan", "source", "documents", "completeness"]);
  const author = record(doc.author, ["agentId", "sessionId", "runId", "selectionRevision"]);
  const completeness = record(doc.completeness, ["status", "reason"]);
  if (doc.schemaVersion !== 1 || doc.status !== "draft" || doc.approvalStatus !== "unapproved"
    || doc.workspaceId !== workspaceId || doc.projectId !== workspaceId
    || typeof doc.revisionId !== "string" || !REVISION.test(doc.revisionId) || read.currentRevisionId !== doc.revisionId
    || typeof doc.createdAt !== "string" || !Number.isFinite(Date.parse(doc.createdAt)) || new Date(doc.createdAt).toISOString() !== doc.createdAt
    || [author.agentId, author.sessionId, author.runId].some(item => typeof item !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(item))
    || !Number.isSafeInteger(author.selectionRevision) || (author.selectionRevision as number) < 0
    || completeness.status !== "unknown" || typeof completeness.reason !== "string" || !completeness.reason.trim()) {
    throw new TypeError("Delivery document is not the exact current unconfirmed draft revision.");
  }
  const baseline = record(doc.baseline, ["sourceId", "revisionId", "sha256", "sequence"]);
  const ui = record(doc.ui, ["sourceId", "revisionId", "sha256"]);
  const integrationPlan = record(doc.integrationPlan, ["sourceId", "revisionId", "sha256"]);
  const source = record(doc.source, ["sourceId", "folderKey", "branch", "commitSha", "treeSha", "sha256"]);
  const pins = [baseline, ui, integrationPlan];
  for (const pin of pins) {
    if (pin.sourceId !== `${workspaceId}/${workspaceId}` || typeof pin.revisionId !== "string" || !pin.revisionId.trim()
      || typeof pin.sha256 !== "string" || !SHA256.test(pin.sha256)) throw new TypeError("Delivery document contains an invalid source pin.");
  }
  if (!Number.isSafeInteger(baseline.sequence) || (baseline.sequence as number) < 1
    || typeof source.sourceId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(source.sourceId)
    || typeof source.folderKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(source.folderKey)
    || typeof source.branch !== "string" || !source.branch.trim() || source.branch.length > 240
    || typeof source.commitSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.commitSha)
    || typeof source.treeSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(source.treeSha)
    || typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) {
    throw new TypeError("Delivery document Source commit/tree pin is invalid.");
  }
  if (!Array.isArray(doc.documents) || doc.documents.length < 2 || doc.documents.length > 32
    || Object.getPrototypeOf(doc.documents) !== Array.prototype || Reflect.ownKeys(doc.documents).length !== doc.documents.length + 1) {
    throw new TypeError("Delivery documents must contain both required guide bodies.");
  }
  const documents = doc.documents.map(item => {
    const row = record(item, ["kind", "path", "classification", "scope", "body", "bodySha256"]);
    if (row.kind !== "installation-guide" && row.kind !== "user-guide" && row.kind !== "other") throw new TypeError("Invalid delivery document kind.");
    const path = text(row.path, "path", 512), body = text(row.body, "body", 192 * 1024);
    if (path.startsWith("/") || path.includes("\\") || path.includes(":")
      || path.split("/").some(part => !part || part === "." || part === "..")
      || typeof row.bodySha256 !== "string" || !SHA256.test(row.bodySha256)) {
      throw new TypeError("Delivery document path or body digest shape is invalid.");
    }
    return Object.freeze({ kind: row.kind, path, classification: text(row.classification, "classification", 160),
      scope: text(row.scope, "scope", 2048), body, bodySha256: row.bodySha256 });
  });
  if (documents.filter(item => item.kind === "installation-guide").length !== 1
    || documents.filter(item => item.kind === "user-guide").length !== 1
    || new Set(documents.map(item => item.path.toLocaleLowerCase("en-US"))).size !== documents.length) {
    throw new TypeError("Required guide kinds and paths must be unique.");
  }
  const bundleSha256 = (doc.revisionId as string).slice("delivery-documents-v1:".length);
  const sourceId = `delivery-document:${doc.workspaceId}/${doc.projectId}`;
  const freshnessStatus = read.source as "current" | "stale" | "unknown";
  const commonPins = [
    { sourceId, revisionId: doc.revisionId as string, sha256: bundleSha256 },
    { sourceId: baseline.sourceId as string, revisionId: baseline.revisionId as string, sha256: baseline.sha256 as string },
    { sourceId: ui.sourceId as string, revisionId: ui.revisionId as string, sha256: ui.sha256 as string },
    { sourceId: integrationPlan.sourceId as string, revisionId: integrationPlan.revisionId as string, sha256: integrationPlan.sha256 as string },
    { sourceId: `source-tip:${source.sourceId}`, revisionId: source.commitSha as string, sha256: source.sha256 as string },
  ];
  return Object.freeze(documents.map((item, index) => {
    const itemId = `${sourceId}:${index + 1}:${item.kind}`;
    const itemRevisionId = `delivery-document-rev:${bundleSha256}:${index + 1}`;
    return Object.freeze({
    id: itemId,
    title: item.path,
    revisionId: itemRevisionId,
    text: item.body,
    createdAt: doc.createdAt as string,
    category: "delivery" as const,
    sourceKind: "delivery-document" as const,
    approvalStatus: "unapproved" as const,
    freshnessStatus,
    bodyAvailable: true,
    sourcePins: Object.freeze([...commonPins, { sourceId: itemId, revisionId: itemRevisionId,
      sha256: item.bodySha256 }]),
    relatedIds: Object.freeze([doc.revisionId as string, baseline.revisionId as string, ui.revisionId as string,
      integrationPlan.revisionId as string, source.commitSha as string, item.path]),
  } as BuilderDocument);
  }));
}
