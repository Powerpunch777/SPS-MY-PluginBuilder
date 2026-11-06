import type { BuilderSnapshot } from "./model.ts";
import { parseBuilderSnapshot } from "./snapshot.ts";

export function projectBaselineDocument(snapshot: BuilderSnapshot, value: unknown): BuilderSnapshot {
  if (value === null) return snapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Baseline document view.");
  const row = value as Record<string, unknown>;
  if (row.workspaceId !== snapshot.workspaceId || row.projectId !== snapshot.workspaceId) throw new TypeError("Cross-Workspace Baseline document view.");
  const read = row.read as Record<string, unknown> | null;
  if (!read || typeof read !== "object" || Array.isArray(read)) throw new TypeError("Invalid document read result.");
  if (read.status === "unavailable" && read.bodyAvailable === false && read.document === null) return snapshot;
  const document = read.document as Record<string, unknown> | null;
  const rawPins = document?.sourcePins;
  if (read.status !== "available" || read.bodyAvailable !== true || !["current", "stale"].includes(read.source as string)
    || !document || document.workspaceId !== snapshot.workspaceId || document.projectId !== snapshot.workspaceId
    || typeof document.documentId !== "string" || typeof document.sourceBaselineRevisionId !== "string"
    || !/^baseline-body:[a-f0-9]{64}$/.test(document.documentId)
    || typeof document.documentRevisionId !== "string" || typeof document.createdAt !== "string" || typeof document.body !== "string"
    || typeof document.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.bodySha256)
    || !Array.isArray(rawPins) || rawPins.some(source => !source || typeof source !== "object" || Array.isArray(source)
      || typeof (source as Record<string, unknown>).id !== "string" || typeof (source as Record<string, unknown>).revisionId !== "string"
      || typeof (source as Record<string, unknown>).sha256 !== "string" || !/^[a-f0-9]{64}$/.test((source as Record<string, unknown>).sha256 as string))) {
    throw new TypeError("The published Baseline document is unavailable or invalid.");
  }
  const shown = {
    id: document.documentId, revisionId: document.documentRevisionId, createdAt: document.createdAt,
    title: `통합 설계 기준선${read.source === "stale" ? " · 이전 버전" : ""}`,
    text: document.body,
    category: "design" as const, sourceKind: "baseline-body" as const, approvalStatus: "unknown" as const,
    freshnessStatus: read.source as "current" | "stale", bodyAvailable: true,
    sourcePins: [{ sourceId: document.documentId, revisionId: document.documentRevisionId, sha256: document.bodySha256 },
      ...(rawPins as Array<{ id: string; revisionId: string; sha256: string }>).map(source => ({
        sourceId: source.id, revisionId: source.revisionId, sha256: source.sha256,
      }))],
    relatedIds: [...new Set([...(rawPins as Array<{ id: string }>).map(source => source.id), document.sourceBaselineRevisionId])],
  };
  return parseBuilderSnapshot({ ...snapshot,
    documents: [...snapshot.documents.filter(item => item.id !== document.documentId), shown] }, snapshot.workspaceId);
}
