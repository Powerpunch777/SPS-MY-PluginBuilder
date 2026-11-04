import { parseProjectDocument, type DocumentApprovalState, type DocumentFreshnessState,
  type DocumentReference, type ProjectDocumentRecord } from "./model.ts";

export const INTEGRATED_BASELINE_SECTIONS = Object.freeze([
  "overview-scope", "requirements-evidence", "function-data-authority", "ui-approval",
  "validation-summary", "technology-reuse", "workstreams-dependencies", "decisions-open-questions",
  "changes-current-baseline",
] as const);
export type IntegratedBaselineSectionId = typeof INTEGRATED_BASELINE_SECTIONS[number];

export type IntegratedBaselineSection = Readonly<{
  id: IntegratedBaselineSectionId;
  title: string;
  status: "available" | "unavailable";
  body: string | null;
  detailRefs: readonly DocumentReference[];
  unavailableReason: string | null;
}>;

const encoder = new TextEncoder();

/**
 * Renders an integrated read view from existing canonical records. Section
 * bodies are supplied by those records; missing sources remain explicitly
 * unavailable. Detail refs retain the independent source IDs and revisions.
 */
export function buildIntegratedBaselineDocument(input: Readonly<{
  workspaceId: string;
  projectId: string;
  documentId: string;
  revisionId: string;
  createdAt: string;
  modifiedAt: string;
  authorId: string | null;
  approval: Readonly<{ state: DocumentApprovalState; evidenceId: string | null; actorId: string | null; decidedAt: string | null }>;
  freshness: DocumentFreshnessState;
  freshnessReason: string | null;
  sections: readonly IntegratedBaselineSection[];
}>): ProjectDocumentRecord {
  if (input.sections.length !== INTEGRATED_BASELINE_SECTIONS.length) throw new TypeError("Integrated baseline requires all nine sections.");
  const byId = new Map(input.sections.map(section => [section.id, section]));
  if (byId.size !== INTEGRATED_BASELINE_SECTIONS.length || INTEGRATED_BASELINE_SECTIONS.some(id => !byId.has(id))) {
    throw new TypeError("Integrated baseline sections must contain each of the nine IDs exactly once.");
  }
  const references = new Map<string, DocumentReference>();
  const markdown = INTEGRATED_BASELINE_SECTIONS.map(id => {
    const section = byId.get(id)!;
    if (typeof section.title !== "string" || !section.title.trim()) throw new TypeError(`Integrated baseline section ${id} requires a title.`);
    if (section.status === "available") {
      if (typeof section.body !== "string" || section.unavailableReason !== null) throw new TypeError(`Available section ${id} must have source text.`);
    } else if (section.status === "unavailable") {
      if (section.body !== null || typeof section.unavailableReason !== "string" || !section.unavailableReason.trim()) {
        throw new TypeError(`Unavailable section ${id} must preserve an explicit reason.`);
      }
    } else throw new TypeError(`Integrated baseline section ${id} has an unsupported state.`);
    for (const ref of section.detailRefs) references.set(`${ref.kind}\0${ref.id}\0${ref.revisionId ?? ""}`, ref);
    const details = section.detailRefs.length
      ? section.detailRefs.map(ref => `- [${safeInline(ref.label)}](sps-document:${encodeURIComponent(ref.id)}${ref.revisionId ? `?revision=${encodeURIComponent(ref.revisionId)}` : ""})`).join("\n")
      : "- 연결된 세부 문서가 없습니다.";
    const body = section.status === "available" ? section.body! : `자료를 사용할 수 없습니다: ${section.unavailableReason}`;
    return `## ${safeInline(section.title)}\n\n${safeMarkdown(body)}\n\n### 상세 연결\n${details}`;
  }).join("\n\n");
  const body = `# 통합 설계 기준선\n\n${markdown}`;
  if (encoder.encode(body).byteLength > 192 * 1_024) throw new TypeError("Integrated baseline exceeds the 192 KiB read-view bound.");
  return parseProjectDocument({ workspaceId: input.workspaceId, projectId: input.projectId,
    id: input.documentId, category: "design", type: "integrated-design-baseline", title: "통합 설계 기준선",
    body, revisionId: input.revisionId, createdAt: input.createdAt, modifiedAt: input.modifiedAt,
    authorId: input.authorId, approval: input.approval, freshness: input.freshness, freshnessReason: input.freshnessReason,
    references: [...references.values(), { kind: "revision", id: input.revisionId, revisionId: input.revisionId, label: "통합 기준선 Revision" }],
  }, { workspaceId: input.workspaceId, projectId: input.projectId });
}

function safeInline(value: string): string {
  return value.replace(/[\r\n\[\]<>]/gu, " ").replace(/\s+/gu, " ").trim();
}

function safeMarkdown(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/<\/?[A-Za-z][^>]*>/gu, match => match.replace(/</gu, "&lt;").replace(/>/gu, "&gt;"))
    .replace(/\]\(\s*(?:javascript|data|vbscript):[^)]*\)/giu, "](about:blank#blocked)");
}

