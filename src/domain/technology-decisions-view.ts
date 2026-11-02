import { parseAuthoredTechnologyDecisions } from "./authored-technology-decisions.ts";
import type { BuilderSnapshot } from "./model.ts";

const dispositionLabels = { required: "필수", allowed: "허용", prohibited: "금지", undecided: "미결정" } as const;
const verificationLabels = { "not-verified": "검증 안 함", "documentation-only": "문서 조사 보고",
  "reported-integration-test": "통합 시험 보고 · 독립 검증 아님" } as const;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Invalid technology decisions view.");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError("Invalid technology decisions view fields.");
  }
  const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Invalid technology decisions view field.");
    }
    row[key] = descriptor.value;
  }
  return row;
}

export function projectTechnologyDecisions(snapshot: BuilderSnapshot, value: unknown): BuilderSnapshot {
  if (value === null) return snapshot;
  const row = exactRecord(value, ["workspaceId", "projectId", "sequence", "record"]);
  if (row.workspaceId !== snapshot.workspaceId || row.projectId !== snapshot.workspaceId
    || typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new TypeError("Invalid or cross-scope technology decisions view.");
  }

  const record = parseAuthoredTechnologyDecisions(row.record, snapshot.workspaceId);
  const lines = ["# 기술 선정 명세", "",
    "Lead가 기록한 기술 선택과 조사 근거입니다. 라이선스·보안·테스트의 독립 검증이나 실행 승인이 아닙니다.", "",
    `기술 명세: ${record.register.revisionId}`,
    `설계 기준: ${record.register.sourceBaselineRevisionId}`,
    `명세: ${record.register.sourceSpecRevisionId} · Graph: ${record.register.sourceGraphRevisionId}`, "",
    "기록되지 않은 기술은 미지정이며 자동 금지가 아닙니다. 기준이 개정되면 이 기록을 자동 승계하지 않습니다.", ""];
  if (record.register.entries.length === 0) lines.push("기록된 기술 선택이 없습니다. 조사 완료나 전체 기술 금지를 뜻하지 않습니다.", "");
  for (const entry of record.register.entries) {
    lines.push(`## ${entry.technology} · ${dispositionLabels[entry.disposition]} (${entry.disposition})`,
      `선택 이유: ${entry.selectionReason.trim() ? entry.selectionReason : "기록 없음"}`,
      `비선택 이유: ${entry.nonSelectionReason.trim() ? entry.nonSelectionReason : "기록 없음"}`,
      `적용 노드: ${entry.scopeNodeIds.length ? entry.scopeNodeIds.join(", ") : "프로젝트 전체"}`,
      `상호운용 계약: ${entry.interoperability.length ? entry.interoperability.join(" / ") : "기록 없음"}`,
      `제약: ${entry.constraints.length ? entry.constraints.join(" / ") : "기록 없음"}`,
      `비용: ${entry.cost}`, `버전·호환성: ${entry.versionCompatibility}`, `변경 책임자: ${entry.changeApprovalOwner}`,
      `라이선스: ${entry.licenseReview.status === "unreviewed" ? "검토 안 함" : `검토 보고 · ${entry.licenseReview.licenseExpression} · 독립 검증 아님`}`,
      `라이선스 근거 참조: ${entry.licenseReview.evidenceRefs.join(", ") || "없음"}`,
      `검증 상태: ${verificationLabels[entry.verification.level]}`,
      `검증 근거 참조: ${entry.verification.evidenceRefs.join(", ") || "없음"}`,
      `확인된 제약·보고 한계: ${entry.verification.limitations}`,
      `다음 검토 조건: ${entry.verification.nextReviewCondition}`, "");
  }
  lines.push("---", `기록 시각: ${record.createdAt}`, `작성 Agent: ${record.author.agentId}`,
    `세션: ${record.author.sessionId} · Run: ${record.author.runId} · Lead 선택: ${record.author.selectionRevision}`,
    `설계 기준 digest: ${record.baselineDigest}`);
  return {
    ...snapshot,
    documents: [...snapshot.documents, {
      id: `technology-decisions:${record.register.revisionId}`,
      title: "기술 선정 명세 · Lead 기록",
      revisionId: record.register.revisionId,
      createdAt: record.createdAt,
      text: lines.join("\n"),
    }],
  };
}
