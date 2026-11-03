# Builder v15 ↔ CSAS v0.7 통합 차이

기준: v15 원본 `docs/design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md`, CSAS v0.7 입력 및 v0.8 누적 개정 원문. 분류는 소스 코드 확인(`CONFIRMED_CODE`)과 문서 요구(`DOCUMENTED_ONLY`)를 구분한다.

검토 기준선은 공개 Builder PR #2의 [revision `996c43f47ad68ba0a63c7bfbe14851e731a66891`](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/tree/996c43f47ad68ba0a63c7bfbe14851e731a66891)이며, 이는 공급된 식별자다. [PR 링크](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/pull/2); 두 URL은 이번 QA에서 원격 조회하지 않았다. `CONFIRMED_CODE` 행은 운영자 제공 `Builder 전체 인수 기준 정적 감사` (SHA-256 `9d955a62e9391b3adbbaf5f1da37d1be6b65bd4c0760e1cb7b41836c14aabd7d`)의 기준선 대조를 인용한다. checkout HEAD 독립 확인 및 기준선 일치는 `NOT_VERIFIED`다. v15/CSAS 및 audit 원문은 제공된 작업자료이며 비공개 입력을 공개 자료인 것처럼 인용하지 않는다.

| 주제 | v15 기준 | v0.7/v0.8 확정·개정 요구 | 현재 소스 대조 및 안전한 처리 |
|---|---|---|---|
| Lead context | 3개 채널 구조 | Main/UI/Background/Intake/Discussion의 5개 논리 context. 기존 화면 유지 후 명시 선택으로 별도 시작. 기록/ID/provenance/receipt/reference 보존, 자동 이름 매핑/중복 생성 방지 | `src/domain/lead-sessions.ts`는 세 채널만 지원 (`CONFIRMED_CODE`). 별도 저장/API/UI 및 회귀 검증 필요. 세부 전환 UX는 미결정 (`DOCUMENTED_ONLY`, v0.8 §B/S7 및 후속 결정). |
| Lead 권한 | 기존 역할·세션 권한 | 신규 역할별 권한 검토 | `src/lead-tool-authority.ts`가 모든 `LEAD_CHANNELS`를 검사하고 `src/session-execution-policy.ts`가 공통 `LEAD_PLANNING_TOOL_NAMES`를 실행 허용 집합으로 사용 (`CONFIRMED_CODE`). 두 경계 모두 갱신 검토. |
| 설계 순서 | 기존 v15 워크플로 | 상담→설계 협의→UI 시안 검토→기준선→기술 선택→CTO 분배 | 요구는 `DOCUMENTED_ONLY` (v0.8 §C/S4); 구현 완료 여부를 이 보고서에서 확인하지 않음. |
| UI 계약 | UI v9 및 HTML viewer | 승인 HTML은 시각 기준, 별도 UI Contract/UI Revision, 기능↔UI 양방향 영향 및 부분 재검토 | 사용자 승인된 목표. 현재 구현 완결성은 `UNKNOWN`; UI fixture/HTML만으로 승인 기능을 추정하지 않음. |
| CSAS/D3/G0–G7 | v15의 기존 AC 및 이전 Gate 모델 | Domain Pack/Coverage/Gap, 조건부 논리·상태/예외 탐색, Lead 근거 해결, 영향 범위 차단, 실행/인수 Gate 도입 목표 | `UNKNOWN`/미검증. Task Packet의 계획 저장은 실행 Gate가 아님 (`src/domain/task-packets.ts`, operator audit). |
| 제품 범위 | Builder 완성형 외주 플러그인 도구 | D1–D9, S1–S7, G0–G7; 고객 전송/납품·결제 자동확정 금지 | 승인 문서 기준이며 새 정책을 만들지 않음. 실제 전체 인수 `NOT_RUN`. |
| Core Primary | 용어 해석 충돌 가능 | Primary/Extension/activation은 Core 실계약으로 판정 | Core 코드 부재로 `UNKNOWN`; 선택형이라는 이유로 배제하거나 문서 용어만으로 가상 API를 만들지 않음. |

v15와 UI v9 원본은 수정하지 않는다. 사용자 확정 정책은 재질문하거나 미결정으로 되돌리지 않고, 명시하지 않은 세부 UX/API는 미결정으로 유지한다. 출처: 제공 원문 `SPS_Builder_CSAS_Complete_Design_Reviewed_v0.7_2026-11-03.md` (SHA-256 `832b1f4a4884df8b12f5733ce60e951bfaa418f249c54c69e2646ca95c7070db`) §§B–K, 누적 v0.8 원문 (SHA-256 `bb5e723e1aa0408e4e91fcbad784d58acb27ed46f00a78b474b828ad58be9de7`) §§0.1–0.4/B–K, 사용자 제공 「후속 운영자 지시」 SHA-256 `f8e2ad0ede6e3b6a336a18ed32e94e187a625c5f526b1925d0014c16e5cb1396`. 제공자료는 공개 문서라고 주장하지 않는다.
