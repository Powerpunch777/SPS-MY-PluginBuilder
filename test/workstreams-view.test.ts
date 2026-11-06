import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { projectWorkstreams } from "../src/domain/workstreams-view.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ctoAgentId = "22222222-2222-4222-8222-222222222222";
const ctoSessionId = "33333333-3333-4333-8333-333333333333";
const authorRunId = "44444444-4444-4444-8444-444444444444";
const receiptRunId = "55555555-5555-4555-8555-555555555555";
const digest = "a".repeat(64);

function record(overrides: Record<string, unknown> = {}) {
  return {
    spec: {
      projectId: workspaceId, id: "WS-001", revision: 2, sourceSpecRevisionId: "SPEC-004",
      assignedCtoId: "CTO-001", title: "인증 API", goal: "승인된 요구사항의 인증 흐름 제공",
      scopeNodeIds: ["auth-api", "token-session"], included: ["인증 API", "계약 테스트"],
      excluded: ["청구 기능"], dependencies: ["WS-002 공통 사용자 모델"],
      interfaceContracts: ["auth-contract-v2"], technologyDecisionsRef: "TECH-DEC-003@rev2",
      reuseCandidates: ["기존 인증 라이브러리 조사"], acceptance: ["API 계약 통과"],
      evidenceRequired: ["PR", "테스트 결과"], openQuestions: ["Q-12"],
    },
    sourceBaselineRevisionId: "BASELINE-003", baselineDigest: digest, technologyDigest: "b".repeat(64),
    ctoAgentId, ctoSessionId,
    author: { agentId: ctoAgentId, sessionId: ctoSessionId, runId: authorRunId, selectionRevision: 4 },
    createdAt: "2026-11-02T01:02:03.004Z",
    change: { previousRevision: 1, reason: "계약 범위 구체화", diff: "추가된 테스트 경로 명시",
      impactNodeIds: ["auth-api"], impactInterfaceContracts: ["auth-contract-v2"],
      impactTaskIds: ["TASK-7"], effectiveFrom: "다음 작업 배정부터" },
    receipt: null,
    ...overrides,
  };
}

function board(workstreams: unknown[] = [record()]) {
  return { projectId: workspaceId, revisionId: "BOARD-009", workstreams };
}

function view(overrides: Record<string, unknown> = {}) {
  return { workspaceId, projectId: workspaceId, sequence: 1, board: board(), ...overrides };
}

test("projects an empty or absent board without adding synthetic work", () => {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  assert.equal(projectWorkstreams(snapshot, null), snapshot);
  assert.equal(projectWorkstreams(snapshot, view({ board: board([]) })), snapshot);
  assert.deepEqual(snapshot.documents, []);
  assert.deepEqual(snapshot.activity, []);
});

test("adds one Korean read-only document per workstream with pinned source and change details", () => {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  snapshot.documents.push({ id: "existing", title: "기존", revisionId: "r1", createdAt: "now", text: "보존" });
  const original = structuredClone(snapshot);
  const projected = projectWorkstreams(snapshot, view({ board: board([record(), record({
    spec: { ...record().spec, id: "WS-002", title: "공통 사용자 모델", revision: 1 },
    change: { ...record().change, previousRevision: null },
  })]) }));

  assert.deepEqual(snapshot, original);
  assert.equal(projected.documents.length, 3);
  const document = projected.documents[1]!;
  assert.equal(document.id, "workstream:WS-001");
  assert.equal(document.title, "CTO 작업 명세 · 인증 API");
  assert.equal(document.revisionId, "2");
  assert.equal(document.createdAt, record().createdAt);
  for (const value of ["내부 계획 문서", "외부 계약", "최신 기준인지 자동 확인하지 않습니다",
    "목표: 승인된 요구사항의 인증 흐름 제공", "범위 노드: auth-api · token-session", "포함: 인증 API · 계약 테스트",
    "제외: 청구 기능", "인터페이스 계약: auth-contract-v2", "기술 선정 참조: TECH-DEC-003@rev2",
    "수용 기준: API 계약 통과", "필요 증거: PR · 테스트 결과", "열린 질문: Q-12",
    "변경 사유: 계약 범위 구체화", "차이: 추가된 테스트 경로 명시", "영향 Task: TASK-7",
    "출처 Baseline: BASELINE-003", authorRunId, ctoSessionId]) {
    assert.ok(document.text.includes(value), `expected document text to include ${value}`);
  }
  assert.deepEqual(projected.actors, original.actors);
  assert.deepEqual(projected.graph, original.graph);
  assert.deepEqual(projected.activity, original.activity);
  assert.deepEqual(projected.messages, original.messages);
  assert.deepEqual(projected.questions, original.questions);
  assert.deepEqual(projected.integrations, original.integrations);
});

test("renders receipt readiness as a report, never as actual execution or completion", () => {
  const ready = { revision: 2, agentId: ctoAgentId, sessionId: ctoSessionId, runId: receiptRunId,
    createdAt: "2026-11-02T02:03:04.005Z", readiness: "ready", note: "명세를 확인했습니다." };
  const clarification = { ...ready, readiness: "needs-clarification", note: "계약 질문을 확인해야 합니다." };
  const blocked = { ...ready, readiness: "blocked", note: "필수 입력이 누락됐습니다." };
  const render = (receipt: unknown) => projectWorkstreams(createEmptyBuilderSnapshot(workspaceId),
    view({ board: board([record({ receipt })]) })).documents[0]!.text;

  assert.ok(render(null).includes("수신 상태: 수신 확인 대기"));
  assert.ok(render(ready).includes("착수 가능 보고 · 실행 시작 아님"));
  assert.ok(render(ready).includes("수신 보고: 명세를 확인했습니다."));
  assert.ok(render(clarification).includes("확인 필요 보고 · 실제 실행 상태 아님"));
  assert.ok(render(blocked).includes("차단 보고 · 실제 실행 상태 아님"));
  for (const text of [render(null), render(ready), render(clarification), render(blocked)]) {
    assert.doesNotMatch(text, /실행 완료|작업 완료|검증 완료|status:\s*(running|completed)/iu);
  }
});

test("rejects cross-scope, invalid sequence, extra DTO fields and accessor descriptors", () => {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  for (const change of [{ workspaceId: "other" }, { projectId: "other" }, { sequence: 0 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 }, { sequence: 1.5 }, { approved: true },
    { board: board([record({ spec: { ...record().spec, projectId: "other" } })]) }]) {
    assert.throws(() => projectWorkstreams(snapshot, view(change)));
  }

  const withSymbol = view();
  Object.defineProperty(withSymbol, Symbol("extra"), { value: true, enumerable: true });
  assert.throws(() => projectWorkstreams(snapshot, withSymbol), /fields/);

  let invoked = false;
  const withGetter = view();
  Object.defineProperty(withGetter, "board", { enumerable: true, get() { invoked = true; return board(); } });
  assert.throws(() => projectWorkstreams(snapshot, withGetter), /field/);
  assert.equal(invoked, false);

  assert.throws(() => projectWorkstreams(snapshot, Object.assign(Object.create({ inherited: true }), view())));
  assert.throws(() => projectWorkstreams(snapshot, view({ board: { ...board(), extra: true } })));
  assert.throws(() => projectWorkstreams(snapshot, view({ board: board([record({ extra: true })]) })));
});

test("keeps untrusted-looking values as plain text rather than producing markup", () => {
  const maliciousText = "<script>do not execute</script>";
  const text = projectWorkstreams(createEmptyBuilderSnapshot(workspaceId), view({
    board: board([record({ spec: { ...record().spec, goal: maliciousText } })]),
  })).documents[0]!.text;
  assert.ok(text.includes(`목표: ${maliciousText}`));
  assert.equal(text.includes("<div"), false);
});
