import type {
  BuilderDocument,
  BuilderSnapshot,
  DocumentApprovalStatus,
  DocumentCategory,
  DocumentFreshnessStatus,
  DocumentSourceKind,
} from "./model.ts";

const CATEGORIES: readonly DocumentCategory[] = ["consultation", "design", "ui-design", "validation", "technical-research",
  "development", "change-history", "test-qa", "delivery", "unclassified"];
const APPROVAL: readonly DocumentApprovalStatus[] = ["approved", "unapproved", "unknown"];
const FRESHNESS: readonly DocumentFreshnessStatus[] = ["current", "stale", "review-required", "unknown"];
const SOURCES: readonly DocumentSourceKind[] = ["builder-document", "baseline-body", "design-baseline", "design-draft",
  "technology-decision", "workstream", "lead-memory", "consultation-source", "reuse-candidate"];
const SORTS = ["createdAt", "title", "sourceKind", "revisionId"] as const;
export type DocumentSort = typeof SORTS[number];

export type DocumentCenterQuery = Readonly<{
  search: string;
  category: DocumentCategory | null;
  sourceKind: DocumentSourceKind | null;
  approvalStatus: DocumentApprovalStatus | null;
  freshnessStatus: DocumentFreshnessStatus | null;
  relatedId: string | null;
  sortBy: DocumentSort;
  direction: "asc" | "desc";
}>;
export type DocumentCenterItem = Readonly<BuilderDocument & Required<Pick<BuilderDocument,
  "category" | "sourceKind" | "approvalStatus" | "freshnessStatus" | "bodyAvailable" | "sourcePins" | "relatedIds">>>;
export type DocumentCenterView = Readonly<{
  query: DocumentCenterQuery;
  items: readonly DocumentCenterItem[];
  total: number;
  facets: Readonly<{
    categories: Readonly<Record<DocumentCategory, number>>;
    approvalStatuses: Readonly<Record<DocumentApprovalStatus, number>>;
    freshnessStatuses: Readonly<Record<DocumentFreshnessStatus, number>>;
  }>;
}>;

/** Projects stored, user-imported sources without creating or publishing a second document. */
export function projectConsultationDocuments(snapshot: Readonly<{ messages: readonly BuilderSnapshot["messages"][number][];
  documents: readonly BuilderDocument[] }>): readonly BuilderDocument[] {
  const ids = new Set(snapshot.documents.map(document => document.id));
  const originals = snapshot.messages.filter(message => message.channel === "main" && message.actorId === null
    && message.role === "user" && /^consultation-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(message.id));
  const documents = originals.flatMap((message, index) => {
    const id = `consultation-source:${message.id}`;
    if (ids.has(id)) return [];
    return [{ id, revisionId: message.id, createdAt: message.createdAt, title: `\uc0c1\ub2f4 \uc790\ub8cc ${index + 1}`,
      text: message.text, category: "consultation" as const, sourceKind: "consultation-source" as const,
      approvalStatus: "unknown" as const, freshnessStatus: "unknown" as const, bodyAvailable: true,
      sourcePins: [], relatedIds: [message.id] }];
  });
  return [...snapshot.documents, ...documents];
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function exact(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key))) {
    throw new TypeError("Invalid document-center query fields.");
  }
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value) as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Document-center query fields must be own data values.");
    copy[key] = descriptor.value;
  }
  return copy;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(`Unsupported document ${label} filter.`);
  return value as T;
}

export function parseDocumentCenterQuery(value: unknown = {}): DocumentCenterQuery {
  const row = exact(value, ["search", "category", "sourceKind", "approvalStatus", "freshnessStatus", "relatedId", "sortBy", "direction"]);
  const search = row.search === undefined ? "" : row.search;
  if (typeof search !== "string" || search.length > 500 || search.includes("\0")) throw new TypeError("Document search must be at most 500 characters.");
  const relatedId = row.relatedId ?? "";
  if (typeof relatedId !== "string" || relatedId.length > 160 || /[\u0000-\u001f\u007f]/u.test(relatedId)) {
    throw new TypeError("Invalid exact document relation ID.");
  }
  const sortBy = row.sortBy === undefined ? "createdAt" : row.sortBy;
  const direction = row.direction === undefined ? "desc" : row.direction;
  if (typeof sortBy !== "string" || !SORTS.includes(sortBy as DocumentSort)) throw new TypeError("Unsupported document sort field.");
  if (direction !== "asc" && direction !== "desc") throw new TypeError("Document sort direction must be asc or desc.");
  return Object.freeze({ search: search.trim().toLocaleLowerCase(),
    category: optionalEnum(row.category, CATEGORIES, "category"), sourceKind: optionalEnum(row.sourceKind, SOURCES, "source"),
    approvalStatus: optionalEnum(row.approvalStatus, APPROVAL, "approval"), freshnessStatus: optionalEnum(row.freshnessStatus, FRESHNESS, "freshness"),
    relatedId: relatedId.trim() || null,
    sortBy: sortBy as DocumentSort, direction });
}

function dateKey(value: string): number | string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : value;
}

/** Pure local selector. It filters only metadata explicitly present in the current Builder snapshot. */
export function selectProjectDocuments(snapshot: Pick<BuilderSnapshot, "documents">,
  queryInput: unknown = {}): DocumentCenterView {
  const query = parseDocumentCenterQuery(queryInput);
  const categoryCounts = Object.fromEntries(CATEGORIES.map(value => [value, 0])) as Record<DocumentCategory, number>;
  const approvalCounts = Object.fromEntries(APPROVAL.map(value => [value, 0])) as Record<DocumentApprovalStatus, number>;
  const freshnessCounts = Object.fromEntries(FRESHNESS.map(value => [value, 0])) as Record<DocumentFreshnessStatus, number>;
  const documents: DocumentCenterItem[] = snapshot.documents.map(document => ({ ...document,
    category: document.category ?? "unclassified", sourceKind: document.sourceKind ?? "builder-document",
    approvalStatus: document.approvalStatus ?? "unknown", freshnessStatus: document.freshnessStatus ?? "unknown",
    bodyAvailable: document.bodyAvailable ?? true, sourcePins: document.sourcePins ?? [], relatedIds: document.relatedIds ?? [],
  }));
  for (const document of documents) {
    categoryCounts[document.category] += 1;
    approvalCounts[document.approvalStatus] += 1;
    freshnessCounts[document.freshnessStatus] += 1;
  }
  const needle = query.search;
  const filtered = documents.filter(document => (!needle || `${document.title}\n${document.bodyAvailable ? document.text : ""}`
    .toLocaleLowerCase().includes(needle))
    && (!query.category || document.category === query.category)
    && (!query.sourceKind || document.sourceKind === query.sourceKind)
    && (!query.approvalStatus || document.approvalStatus === query.approvalStatus)
    && (!query.freshnessStatus || document.freshnessStatus === query.freshnessStatus)
    && (!query.relatedId || document.relatedIds.includes(query.relatedId)));
  const direction = query.direction === "asc" ? 1 : -1;
  const items = filtered.map((document, index) => ({ document, index })).sort((left, right) => {
    const a = left.document, b = right.document;
    const av = query.sortBy === "createdAt" ? dateKey(a.createdAt) : a[query.sortBy];
    const bv = query.sortBy === "createdAt" ? dateKey(b.createdAt) : b[query.sortBy];
    const order = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return order === 0 ? left.index - right.index : order * direction;
  }).map(row => row.document);
  return Object.freeze({ query, items: Object.freeze(items), total: items.length, facets: Object.freeze({
    categories: Object.freeze(categoryCounts), approvalStatuses: Object.freeze(approvalCounts), freshnessStatuses: Object.freeze(freshnessCounts),
  }) });
}
