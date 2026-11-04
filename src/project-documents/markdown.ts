import { createHash } from "node:crypto";
import type { ApprovedDocumentSnapshot } from "./model.ts";

const encoder = new TextEncoder();

/** Export only the captured immutable body; never regenerate from live sources. */
export function exportApprovedSnapshotMarkdown(snapshot: ApprovedDocumentSnapshot): string {
  if (snapshot.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(snapshot.bodySha256)
    || createHash("sha256").update(snapshot.body, "utf8").digest("hex") !== snapshot.bodySha256) {
    throw new TypeError("Approved snapshot content digest does not match its captured body.");
  }
  if (encoder.encode(snapshot.body).byteLength > 192 * 1_024) throw new TypeError("Approved snapshot exceeds the bounded Markdown export size.");
  const sourcePins = snapshot.sourceRevisions.map(source =>
    `- ${safe(source.kind)}: ${safe(source.id)} @ ${safe(source.revisionId)}`).join("\n") || "- 기록된 원본 Revision이 없습니다.";
  const markdown = [
    `# 문서 스냅샷 ${safe(snapshot.documentId)}`,
    "",
    `- Workspace: ${safe(snapshot.workspaceId)}`,
    `- Project: ${safe(snapshot.projectId)}`,
    `- 문서 Revision: ${safe(snapshot.documentRevisionId)}`,
    `- 승인 근거: ${safe(snapshot.approvalEvidenceId)}`,
    `- 승인자: ${safe(snapshot.approvedBy)}`,
    `- 승인 시각: ${safe(snapshot.approvedAt)}`,
    `- 스냅샷 생성 시각: ${safe(snapshot.capturedAt)}`,
    `- 본문 SHA-256: ${snapshot.bodySha256}`,
    "",
    "## 참조한 원본 Revision",
    sourcePins,
    "",
    "## 승인 시점 본문",
    "",
    safeMarkdown(snapshot.body),
    "",
    "> 이 파일은 위 문서 Revision과 원본 Revision을 참조하는 승인 시점 스냅샷입니다. 현재 최신성은 별도 조회가 필요합니다.",
    "",
  ].join("\n");
  if (encoder.encode(markdown).byteLength > 256 * 1_024) throw new TypeError("Markdown export exceeds the bounded output size.");
  return markdown;
}

function safe(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function safeMarkdown(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/<\/?[A-Za-z][^>]*>/gu, match => match.replace(/</gu, "&lt;").replace(/>/gu, "&gt;"))
    .replace(/\]\(\s*(?:javascript|data|vbscript):[^)]*\)/giu, "](about:blank#blocked)");
}

