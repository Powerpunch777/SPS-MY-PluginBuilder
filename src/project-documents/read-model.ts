import {
  APPROVAL_STATES, DOCUMENT_CATEGORIES, FRESHNESS_STATES, assertDocumentBounds,
  parseProjectDocument,
  type DocumentApprovalState, type DocumentCategory, type DocumentFreshnessState,
  type DocumentQuery, type DocumentSourcePage, type ProjectDocumentEvent,
  type ProjectDocumentEventReader, type ProjectDocumentPage, type ProjectDocumentRecord,
  type ProjectDocumentSource, type DocumentUnavailableReason,
} from "./model.ts";
import { randomUUID } from "node:crypto";

const MAX_CURSOR_CHARS = 4_096;
const CATEGORY_SET = new Set<string>(DOCUMENT_CATEGORIES);

export type ProjectReadScope = Readonly<{ workspaceId: string; projectId: string }>;
export type ProjectDocumentAuthorizationCheck = (scope: ProjectReadScope) => Promise<void>;

export type ProjectDocumentReader = Readonly<{
  list(query?: DocumentQuery): Promise<ProjectDocumentPage>;
  read(id: string): Promise<ProjectDocumentRecord | null>;
  readEvents(afterEventId?: string | null, limit?: number): Promise<Readonly<{
    events: readonly ProjectDocumentEvent[]; nextCursor: string | null; hasMore: boolean;
  }>>;
}>;

type CachedPage = Readonly<{
  queryKey: string;
  items: readonly ProjectDocumentRecord[];
  offset: number;
  unavailable: ProjectDocumentPage["unavailable"];
}>;

function validateQuery(query: DocumentQuery | undefined) {
  const value = query ?? {};
  const allowed = ["text", "category", "type", "approval", "freshness", "relatedId", "sort", "cursor", "limit"];
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key))) throw new TypeError("Invalid project document query.");
  if (value.text !== undefined && (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > 512)) throw new TypeError("Document search text is limited to 512 UTF-8 bytes.");
  if (value.category !== undefined && !CATEGORY_SET.has(value.category)) throw new TypeError("Unsupported document category.");
  if (value.type !== undefined && (typeof value.type !== "string" || value.type.length > 160)) throw new TypeError("Invalid document type filter.");
  if (value.approval !== undefined && !(APPROVAL_STATES as readonly string[]).includes(value.approval)) throw new TypeError("Unsupported approval filter.");
  if (value.freshness !== undefined && !(FRESHNESS_STATES as readonly string[]).includes(value.freshness)) throw new TypeError("Unsupported freshness filter.");
  if (value.relatedId !== undefined && (typeof value.relatedId !== "string" || value.relatedId.length > 160)) throw new TypeError("Invalid related-ID filter.");
  if (value.sort !== undefined && !["modified-asc", "modified-desc", "title", "type", "revision"].includes(value.sort)) throw new TypeError("Unsupported document sort.");
  if (value.cursor !== undefined && value.cursor !== null && typeof value.cursor !== "string") throw new TypeError("Invalid document cursor.");
  return { ...value, limit: assertDocumentBounds({ pageLimit: value.limit }) };
}

function matches(document: ProjectDocumentRecord, query: ReturnType<typeof validateQuery>): boolean {
  if (query.category && document.category !== query.category) return false;
  if (query.type && document.type !== query.type) return false;
  if (query.approval && document.approval.state !== query.approval) return false;
  if (query.freshness && document.freshness !== query.freshness) return false;
  if (query.relatedId && !document.references.some(reference => reference.id === query.relatedId)) return false;
  if (query.text) {
    const needle = query.text.trim().toLocaleLowerCase();
    if (needle && !`${document.title}\n${document.body}`.toLocaleLowerCase().includes(needle)) return false;
  }
  return true;
}

function compare(a: ProjectDocumentRecord, b: ProjectDocumentRecord, sort: NonNullable<DocumentQuery["sort"]>): number {
  let order: number;
  if (sort === "modified-asc") order = a.modifiedAt.localeCompare(b.modifiedAt);
  else if (sort === "modified-desc") order = b.modifiedAt.localeCompare(a.modifiedAt);
  else if (sort === "title") order = a.title.localeCompare(b.title);
  else if (sort === "type") order = a.type.localeCompare(b.type) || a.title.localeCompare(b.title);
  else order = a.revisionId.localeCompare(b.revisionId);
  return order || a.category.localeCompare(b.category) || a.id.localeCompare(b.id);
}

function unavailableCategorySources(sources: readonly ProjectDocumentSource[], failures: ReadonlyMap<string, DocumentUnavailableReason>) {
  const availableCategories = new Set(sources.map(source => source.category));
  return DOCUMENT_CATEGORIES.flatMap(category => availableCategories.has(category) ? [] : [{ category, reason: failures.get(category) ?? "source-not-configured" as const }]);
}

/**
 * Composes read-only adapters over canonical stores/Artifacts. It does not own
 * persistence or calculate freshness; those remain with the source and the
 * accepted freshness contract. Authorization is rechecked around each read.
 */
export function createProjectDocumentReader(input: Readonly<{
  scope: ProjectReadScope;
  sources: readonly ProjectDocumentSource[];
  authorize: ProjectDocumentAuthorizationCheck;
  readEvents: ProjectDocumentEventReader;
}>): ProjectDocumentReader {
  const { scope } = input;
  if (!scope || typeof scope.workspaceId !== "string" || !scope.workspaceId.trim()
    || typeof scope.projectId !== "string" || !scope.projectId.trim()) throw new TypeError("A Workspace and project scope are required.");
  const sourceById = new Map<string, ProjectDocumentSource>();
  for (const source of input.sources) {
    if (!source || typeof source.id !== "string" || !source.id.trim() || !CATEGORY_SET.has(source.category)
      || typeof source.read !== "function" || typeof source.readOne !== "function" || sourceById.has(source.id)) throw new TypeError("Invalid or duplicate project document source adapter.");
    sourceById.set(source.id, source);
  }
  const sources = [...sourceById.values()].sort((a, b) => a.id.localeCompare(b.id));
  // Cursors address immutable, fully observed bounded results held by this reader.
  // They never ask a mutable source to continue a page without snapshot support.
  const cachedPages = new Map<string, CachedPage>();

  async function readSource(source: ProjectDocumentSource, cursor: string | null, limit: number): Promise<DocumentSourcePage> {
    const raw = await source.read({ ...scope, cursor, limit });
    if (!raw || !Array.isArray(raw.items) || raw.items.length > limit
      || (raw.nextCursor !== null && typeof raw.nextCursor !== "string") || typeof raw.hasMore !== "boolean"
      || raw.hasMore !== (raw.nextCursor !== null)
      || raw.unavailableReason !== undefined && !["source-not-configured", "source-not-supported", "scope-unavailable", "authorization-unavailable", "source-failed", "size-limit"].includes(raw.unavailableReason)) {
      throw new TypeError("Invalid bounded document source page.");
    }
    const items = raw.items.map(item => parseProjectDocument(item, scope));
    if (items.some(item => item.category !== source.category)) throw new Error("Document source returned a record outside its category adapter.");
    const ids = items.map(item => item.id);
    if (new Set(ids).size !== ids.length) throw new TypeError("Document source page contains duplicate document IDs.");
    return Object.freeze({ items: Object.freeze(items), nextCursor: raw.nextCursor, hasMore: raw.hasMore,
      ...(raw.unavailableReason ? { unavailableReason: raw.unavailableReason } : {}) });
  }

  return Object.freeze({
    async list(untrustedQuery?: DocumentQuery): Promise<ProjectDocumentPage> {
      const query = validateQuery(untrustedQuery);
      await input.authorize(scope);
      const sort = query.sort ?? "modified-desc";
      const queryKey = JSON.stringify({ workspaceId: scope.workspaceId, projectId: scope.projectId,
        text: query.text ?? null, category: query.category ?? null, type: query.type ?? null,
        approval: query.approval ?? null, freshness: query.freshness ?? null,
        relatedId: query.relatedId ?? null, sort, limit: query.limit,
        sources: sources.map(source => [source.id, source.category]) });
      if (query.cursor !== undefined && query.cursor !== null) {
        if (typeof query.cursor !== "string" || query.cursor.length > MAX_CURSOR_CHARS) throw new TypeError("Invalid or oversized document cursor.");
        const cached = cachedPages.get(query.cursor);
        if (!cached) throw new TypeError("Document cursor is expired or does not match this read.");
        if (cached.queryKey !== queryKey) throw new TypeError("Document cursor does not match the scope, query, sort, or limit.");
        cachedPages.delete(query.cursor);
        const items = cached.items.slice(cached.offset, cached.offset + query.limit);
        const nextOffset = cached.offset + items.length;
        const hasMore = nextOffset < cached.items.length;
        const nextCursor = hasMore ? randomUUID() : null;
        if (nextCursor) cachedPages.set(nextCursor, { ...cached, offset: nextOffset });
        await input.authorize(scope);
        return Object.freeze({ items: Object.freeze(items), nextCursor, hasMore, unavailable: cached.unavailable });
      }
      const applicable = query.category ? sources.filter(source => source.category === query.category) : sources;
      const unavailable = unavailableCategorySources(applicable, new Map());
      const failures = new Map<string, DocumentUnavailableReason>();
      const pages = await Promise.all(applicable.map(async source => {
        try {
          const page = await readSource(source, null, 200);
          if (page.unavailableReason) failures.set(source.category, page.unavailableReason);
          if (page.hasMore) failures.set(source.category, "source-not-supported");
          return { source, page };
        } catch { failures.set(source.category, "source-failed"); return { source, page: null }; }
      }));
      await input.authorize(scope);
      // A partial source page cannot support complete filtering or global ordering.
      // Return its actual unavailable state instead of presenting a misleading prefix.
      if (failures.size > 0) {
        const unavailableByCategory = new Map(unavailable.map(row => [row.category, row.reason] as const));
        for (const [category, reason] of failures) unavailableByCategory.set(category as DocumentCategory, reason);
        return Object.freeze({ items: Object.freeze([]), nextCursor: null, hasMore: false,
          unavailable: Object.freeze([...unavailableByCategory].map(([category, reason]) => ({ category, reason }))) });
      }
      const records = pages.flatMap(result => result.page?.items ?? []).filter(document => matches(document, query));
      const distinct = new Map<string, ProjectDocumentRecord>();
      for (const document of records) {
        const key = `${document.category}\0${document.id}`;
        const previous = distinct.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(document)) throw new Error("Conflicting canonical document adapters returned the same identity.");
        distinct.set(key, document);
      }
      const sorted = [...distinct.values()].sort((a, b) => compare(a, b, sort));
      const items = sorted.slice(0, query.limit);
      const hasMore = sorted.length > query.limit;
      const nextCursor = hasMore ? randomUUID() : null;
      const unavailableByCategory = new Map(unavailable
        .filter(row => !(query.category && row.category !== query.category))
        .map(row => [row.category, row.reason] as const));
      const unavailableSnapshot = Object.freeze([...unavailableByCategory]
        .map(([category, reason]) => Object.freeze({ category, reason })));
      if (nextCursor) {
        cachedPages.set(nextCursor, { queryKey, items: Object.freeze(sorted), offset: query.limit, unavailable: unavailableSnapshot });
        // Keep memory bounded if a caller abandons pagination.
        while (cachedPages.size > 100) cachedPages.delete(cachedPages.keys().next().value!);
      }
      return Object.freeze({ items: Object.freeze(items), nextCursor, hasMore,
        unavailable: unavailableSnapshot });
    },
    async read(documentId: string): Promise<ProjectDocumentRecord | null> {
      if (typeof documentId !== "string" || !documentId.trim() || documentId.length > 160) throw new TypeError("A bounded document ID is required.");
      await input.authorize(scope);
      const records = await Promise.all(sources.map(async source => {
        const result = await source.readOne({ ...scope, documentId });
        if (result === null) return null;
        const document = parseProjectDocument(result, scope);
        if (document.category !== source.category) throw new Error("Document detail source returned a record outside its category adapter.");
        return document;
      }));
      await input.authorize(scope);
      const found = records.filter((document): document is ProjectDocumentRecord => document !== null);
      if (found.some(document => document.id !== documentId)) throw new Error("Document source returned a different identity than requested.");
      if (found.length > 1) throw new Error("Document ID is ambiguous across canonical categories.");
      return found[0] ?? null;
    },
    async readEvents(afterEventId: string | null = null, limit = 50) {
      if (afterEventId !== null && (typeof afterEventId !== "string" || afterEventId.length > 160)) throw new TypeError("Invalid event cursor.");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError("Event page size must be 1 through 200.");
      await input.authorize(scope);
      const result = await input.readEvents({ ...scope, afterEventId, limit });
      await input.authorize(scope);
      if (!result || !Array.isArray(result.events) || result.events.length > limit
        || (result.nextCursor !== null && typeof result.nextCursor !== "string")
        || typeof result.hasMore !== "boolean" || result.hasMore !== (result.nextCursor !== null)) {
        throw new TypeError("Invalid bounded project document event page.");
      }
      const events = result.events.map(event => {
        if (event.workspaceId !== scope.workspaceId || event.projectId !== scope.projectId) throw new Error("Cross-scope document event rejected.");
        return Object.freeze({ ...event });
      });
      return Object.freeze({ events: Object.freeze(events), nextCursor: result.nextCursor, hasMore: result.hasMore });
    },
  });
}

export type { DocumentApprovalState, DocumentFreshnessState };

