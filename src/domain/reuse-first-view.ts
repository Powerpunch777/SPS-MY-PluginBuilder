import type { BuilderSnapshot } from "./model.ts";
import { parseReuseFirstView, type ReuseFirstView } from "../reuse-first/view-parser.ts";
import type { ReuseFirstCandidate } from "../reuse-first/index.ts";

export { parseReuseFirstView } from "../reuse-first/view-parser.ts";
export type { ReuseFirstView } from "../reuse-first/view-parser.ts";

export type ReuseFirstDocumentProjection = Readonly<{
  id: string;
  title: string;
  revisionId: string;
  createdAt: string;
  text: string;
  category: "technical-research";
  sourceKind: "reuse-candidate";
  approvalStatus: "unknown";
  freshnessStatus: "unknown";
  bodyAvailable: true;
  sourcePins: readonly [];
  relatedIds: readonly string[];
}>;

function documentText(candidate: ReuseFirstCandidate, sequence: number): string {
  const source = candidate.source;
  return [
    `후보 ID: ${candidate.candidateId} (${candidate.kind})`,
    `재사용 후보 기록: ${sequence}`,
    `출처: ${candidate.origin.url}`,
    `출처 버전: ${candidate.origin.version ?? "미기록"}`,
    `원문: ${source.sourceId}, ${source.fromLine}-${source.throughLine}행`,
    `서버에 기록된 인용문 SHA-256: ${source.sha256}`,
    "원문 최신성: 미확인 · 이 화면은 원문을 다시 읽어 검증하지 않습니다.",
    "라이선스: 미확인 · 승인이나 검증 기록이 없습니다.",
    "재사용 권리: blocked-unverified · 다른 프로젝트의 재사용을 허가하지 않습니다.",
    `상품 규모: ${candidate.product.tier}`,
    `개발 방식: ${candidate.product.route}`,
    `납품 대상: ${candidate.product.deliveryTargets.join(", ")}`,
    "",
    "기록된 원문 인용:",
    source.quote,
  ].join("\n");
}

/** Creates read-only Document Center records; it does not publish or authorize reuse. */
export function projectReuseFirstDocuments(view: ReuseFirstView): readonly ReuseFirstDocumentProjection[] {
  return Object.freeze(view.revision.candidates.map(candidate => Object.freeze({
    id: `reuse-first:${candidate.candidateId}`,
    title: candidate.name,
    revisionId: view.revision.revisionId,
    createdAt: candidate.createdAt,
    text: documentText(candidate, view.sequence),
    category: "technical-research" as const,
    sourceKind: "reuse-candidate" as const,
    approvalStatus: "unknown" as const,
    freshnessStatus: "unknown" as const,
    bodyAvailable: true as const,
    sourcePins: Object.freeze([] as const),
    relatedIds: Object.freeze([...new Set([candidate.candidateId, candidate.source.sourceId, view.revision.revisionId])]),
  })));
}

/** Adds the current scoped reuse journal to the existing snapshot; null means no journal. */
export function projectReuseFirstCandidates<T extends Pick<BuilderSnapshot, "workspaceId" | "documents">>(
  snapshot: T, value: unknown,
): T {
  if (value === null) return snapshot;
  const view = parseReuseFirstView(value, snapshot.workspaceId, snapshot.workspaceId);
  return { ...snapshot, documents: [...snapshot.documents, ...projectReuseFirstDocuments(view)] } as T;
}
