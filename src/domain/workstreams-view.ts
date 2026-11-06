import { parseWorkstreamBoard } from "./workstreams.ts";
import type { BuilderSnapshot } from "./model.ts";

function exactDto(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Invalid workstreams view.");
  }
  const keys = ["workspaceId", "projectId", "sequence", "board"];
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError("Invalid workstreams view fields.");
  }
  const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Invalid workstreams view field.");
    }
    row[key] = descriptor.value;
  }
  return row;
}

function section(title: string, entries: readonly string[]): string {
  return `${title}: ${entries.length ? entries.join(" · ") : "없음"}`;
}

function renderWorkstream(record: ReturnType<typeof parseWorkstreamBoard>["workstreams"][number]): string {
  const { spec, change, receipt } = record;
  const receiptText = receipt === null
    ? "수신 확인 대기"
    : receipt.readiness === "ready"
      ? "착수 가능 보고 · 실행 시작 아님"
      : receipt.readiness === "needs-clarification"
        ? "확인 필요 보고 · 실제 실행 상태 아님"
        : "차단 보고 · 실제 실행 상태 아님";
  const lines = [
    `# ${spec.title} · Revision ${spec.revision}`,
    "",
    "내부 계획 문서입니다. 외부 계약이나 실행 권한을 만들지 않습니다. 표시된 기준은 이 Revision에 고정되어 있으며 현재 최신 기준인지 자동 확인하지 않습니다.",
    "",
    `목표: ${spec.goal}`,
    `담당 CTO: ${spec.assignedCtoId} · Agent ${record.ctoAgentId} · Session ${record.ctoSessionId}`,
    `수신 상태: ${receiptText}`,
    ...(receipt === null ? [] : [
      `수신 보고: ${receipt.note}`,
      `보고 참조: revision ${receipt.revision} · Agent ${receipt.agentId} · Session ${receipt.sessionId} · Run ${receipt.runId} · ${receipt.createdAt}`,
    ]),
    "",
    "## 고정 출처",
    `프로젝트: ${spec.projectId}`,
    `출처 Spec: ${spec.sourceSpecRevisionId}`,
    `출처 Baseline: ${record.sourceBaselineRevisionId} · digest ${record.baselineDigest}`,
    `기술 선정 참조: ${spec.technologyDecisionsRef} · digest ${record.technologyDigest}`,
    `작성: Agent ${record.author.agentId} · Session ${record.author.sessionId} · Run ${record.author.runId} · 선택 Revision ${record.author.selectionRevision}`,
    `기록 시각: ${record.createdAt}`,
    "",
    "## 범위와 계약",
    `범위 노드: ${spec.scopeNodeIds.join(" · ")}`,
    section("포함", spec.included),
    section("제외", spec.excluded),
    section("의존성", spec.dependencies),
    section("인터페이스 계약", spec.interfaceContracts),
    section("재사용 후보", spec.reuseCandidates),
    "",
    "## 수용 및 미결 사항",
    section("수용 기준", spec.acceptance),
    section("필요 증거", spec.evidenceRequired),
    section("열린 질문", spec.openQuestions),
    "",
    "## 변경 기록",
    `이전 Revision: ${change.previousRevision === null ? "최초 배정" : change.previousRevision}`,
    `변경 사유: ${change.reason}`,
    `차이: ${change.diff}`,
    section("영향 노드", change.impactNodeIds),
    section("영향 인터페이스", change.impactInterfaceContracts),
    section("영향 Task", change.impactTaskIds),
    `적용 기준 시점: ${change.effectiveFrom}`,
  ];
  return lines.join("\n");
}

/** Projects internal Workstream planning records into the existing read-only documents panel. */
export function projectWorkstreams(snapshot: BuilderSnapshot, value: unknown): BuilderSnapshot {
  if (value === null) return snapshot;
  const row = exactDto(value);
  if (row.workspaceId !== snapshot.workspaceId || row.projectId !== snapshot.workspaceId
    || typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new TypeError("Invalid or cross-scope workstreams view.");
  }

  const board = parseWorkstreamBoard(row.board, snapshot.workspaceId);
  if (board.workstreams.length === 0) return snapshot;
  return {
    ...snapshot,
    documents: [...snapshot.documents, ...board.workstreams.map(record => ({
      id: `workstream:${record.spec.id}`,
      title: `CTO 작업 명세 · ${record.spec.title}`,
      revisionId: String(record.spec.revision),
      createdAt: record.createdAt,
      text: renderWorkstream(record),
    }))],
  };
}
