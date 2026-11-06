# SPS Builder 마스터 인덱스

기준일: 2026-11-06. **최신 사용자 확정 → v16 정본과 현행 부속서 →
확정 원문의 비충돌 상세 조항** 순이다. 과거 계획·시제품·구현 결과는
당시 기록이며 현행 설계를 승인하거나 대체하지 않는다.

| 목적 | 공식 위치 |
| --- | --- |
| A. 마스터 인덱스 | 이 파일. 기존 경로 유지 |
| B. 제품 기준선 v16 | [현재 제품 계약](CURRENT-PRODUCT-CONTRACT-2026-11-04.md) |
| C. Agent·Goals·CLI Pool·Wake | [실행 부속서](AGENT-GOALS-AND-RUNTIME.md) |
| D. Core·SDK·권한·보호 실행 | [권한 계약 및 현재 검증](CORE-PLUGIN-ALIGNMENT-2026-11-02.md)과 아래 범용 권한 확정 원문 |
| E. CSAS·통합·납품·문서센터 | [v16](CURRENT-PRODUCT-CONTRACT-2026-11-04.md) §5~§9와 아래 문서센터·통합·승인 원문 |
| F. AC·증거 추적 | [인수 추적표](AC-TRACE-2026-11-04.md), [기계 판독 정의](AC-TRACE-2026-11-04.json) |

- **현재 제품 기준은 [통합 제품 기준선 v16](CURRENT-PRODUCT-CONTRACT-2026-11-04.md)을 먼저 읽는다.**
  v15·CSAS v0.8·상담 개정·문서센터 v1.1·통합 담당·최종 검토·승인·범용 권한과 후속 사용자 결정을 통합한다.
  Lead 6세션과 별도 Integration Manager, 레거시 전환 제외, 실시간 수집/명시 분석,
  G0~G7 및 선택형 Shell 경계를 한곳에서 확인한다.
  옛 문서의 비충돌 요구와 역사 근거는 보존하며 이 링크가 구현 완료를 뜻하지 않는다.
- [현행 인수 기준 추적표](AC-TRACE-2026-11-04.md): v15 118 + CSAS 44 + 상담 8 + 문서센터 16 + 통합 16 + 최종 승인 14의
  원문 정의 216개를 소스 해시와 함께 추적한다. 레거시 6개는 제외이며, 정의 수는
  합격 개수나 서로 독립된 요구 개수가 아니다. 실제 AC 전체 인수 상태는 별도로 갱신한다.
- `01_Design/`: v15와 확정 추가안의 보존 원문. 현행 기준은 v16이다.
- `02_Tech_Research/`: 기술 스택 조사·선정 근거
- `03_UI/`: HTML UI v9 (Document Worker 제외)
- [UI 적용 기준 (2026-11-01)](03_UI/UI-IMPLEMENTATION-CONTRACT-2026-11-01.md):
  UI v9의 구조·배치를 유지하고 색상만 사용자 결정에 따라 Codex식 검정·중립
  회색으로 적용한다. Core 테마와 구분하며, 미구현 기능은 위치를 유지하고
  사용 불가 상태로 표시한다. 임시 밝은 UI는 최종 기준이 아니다.

## 최신 확정 개정

- [CTO·Worker 장기목표·완료 후 대기 (2026-11-05)](01_Design/SPS_Builder_Delegated_Goals_And_Completion_Idle_Addendum_2026-11-05.md):
  Lead→담당 CTO, CTO→직속 Worker/QA 목표 배정과 서버 권한 강제, 완료 후 IDLE/새 배정 대기를 확정한다.
  Turn DONE·Goal COMPLETED·VERIFIED를 분리하며 완료 Goal은 계정/Capacity 복구로도 깨우지 않는다.
  미완료 Goal은 공식 Goal 재개를 우선하고 Goal 없는 세션만 기존 toolOutput Wake를 유지한다.
  실제 배정·연속 실행·완료 중지·권한/계정 전환·재시작 인수 POLICY-GOAL-01~12는 모두 NOT_RUN이다.
- [CLI Pool·시스템 완료·무메시지 Wake (2026-11-05)](01_Design/SPS_Builder_CLI_Pool_Completion_And_Selective_Wake_Addendum_2026-11-05.md):
  단일 활성 계정과 독립 Session ID, RUNNING/DONE/INTERRUPTED/WAITING_CAPACITY/IDLE,
  실제 중단된 미완료 Run만 thread/resume 뒤 turn/start + input: [] + 실제 관측 toolOutput으로 복구한다.
  continue 사용자 메시지를 추가하지 않고 완료 직후 전환/지연 이벤트/중복 복구의 최종 CAS·활성 Turn 검사를 유지한다.
  DONE은 업무 완료/QA가 아니며 별도 보고 Agent·중복 원장을 만들지 않는다. PREPARE/RESUME/WAKE를
  분리하고 무호출 복원이 없으면 PREPARE만 한다.
  Capacity의 내부 재시도와 백오프·jitter 예약을 분리하고 취소·철회/완료 시 예약을 중단한다.
  공급자 제한 또는 보호 장치를 우회하는 계정 순환을 전제로 구현하지 않는다.
  기존 9개와 A~D 실제 CLI 인수는 NOT_RUN이다. 설치 지원 확인과 A→B 무메시지 실제 복구를 우선하며 문서만으로 완료하지 않는다.
- [실행·인계·QA·복구 계약 보강 (2026-11-05)](01_Design/SPS_Builder_Execution_Handoff_And_Recovery_Addendum_2026-11-05.md):
  실제 Core 선행 공백을 분리하고 기존 Task Packet의 소스·산출물·증거 인계와 소비자 인수를 결속한다.
  정확한 Commit QA·영향 범위 재검증·지속 이벤트 자동 통합·제한된 재시도/관측 가능한 대기와
  실제 시간/수동 개입 계측을 적용한다. CTO 2개 병렬과 오류·철회·변경·재시작 복구를 실제 인수한다.
  기존 원문 216 AC는 유지하고 POLICY-EXEC-01~16은 별도 NOT_RUN overlay다. 구현 완료 선언이 아니다.
- [범용 권한·Host 사전 위임 (2026-11-05)](01_Design/SPS_Builder_Generic_Permissions_And_Host_Delegation_Addendum_2026-11-05.md):
  Builder가 업무 역할/템플릿, Core가 범용 기술 권한/강제, Host 관리자가 실행 범위/위임,
  사용자가 최종 사업적 결정을 소유한다. 역할 기본·작업 임시·사전 위임·사용자 승인을 분리하고
  독립 Manager의 공용 풀 실행과 만료/철회/한도/실제 종료를 검증한다. Core 역할 하드코딩이나
  권한 자동 확대는 금지하며, API 검사와 OS 격리는 별개다. 기존 원문 AC 216개를 유지하고
  이 결정에서 도출한 POLICY-AUTH-01~14는 별도 overlay의 NOT_RUN 검사로 추적한다.
- [Lead 최종 검토·승인 페이지 (2026-11-05)](01_Design/SPS_Builder_Lead_Final_Review_Approval_Page_Addendum_2026-11-05.md):
  기존 Integration Review에 좌측 Lead 영역의 사용자 승인 페이지를 연결한다.
  Lead 6세션·별도 Manager를 유지하며 새 Agent/중복 승인 DB를 추가하지 않는다.
  Main의 실제 Packet/G7 적격 후보, 문서센터 정본·파일/문서 해시와 Revision을 재사용하고
  실제 사용자만 승인·수정 요청·보류를 제출한다. 필수 QA/G6/G7 미통과·stale 요청은
  직접 API에서도 차단한다. 과거 승인 보존·변경본 재승인·재시도 멱등성과 고객 전달/
  외부 배포·QA 상태의 분리를 AC-APP-01~14로 추적하며 신규 인수 상태는 NOT_RUN이다.
- [Integration Manager·Lead Integration Review (2026-11-04)](01_Design/SPS_Builder_Integration_Design_20261104.md):
  사용자 직접 확정과 함께 적용한다. Lead 6번째 Integration Review와 별도 Manager,
  CTO VERIFIED/통합 상태 분리, 지속 이벤트·중복 방지·부분 통합, 기술 오류 CTO 환류와
  설계 충돌 Review 경로, Final Integration Packet과 Main 최종 점검·사용자 납품 구성
  확정이다. 원문 `초안` 표시는 책임/라우팅 결정을 미정으로 되돌리지 않는다.
  AC-INT-01~16을 NOT_RUN으로 추가했으며 임시 CAO에 새 AI Lead를 만드는 지시가 아니다.
- [Project Document Center·최신성 보완 v1.1 (2026-11-04)](01_Design/SPS_Builder_Project_Document_Center_and_Freshness_Addendum_v1.1_2026-11-04.md):
  좌측 `문서`와 중앙 문서센터, 통합 기준선·상세 링크, 검색·필터·비교·Markdown,
  승인과 최신성의 분리, 영향 문서만 새 초안으로 갱신하는 계약이다. 새 AI 세션이나
  중복 문서 DB를 만들지 않는다. AC-DOC-01~16은 추적표에 NOT_RUN으로 편입했다.
  요구-원문 연결과 적용 규칙의 특정 버전은 설계 검토 후 Baseline 승인에 함께 포함한다.
  설계 통합을 구현·앱 검증 완료나 검사/QA 자동 합격으로 해석하지 않는다.
- [상담 Connector·명시적 분석·설계 변경관리 (2026-11-04)](01_Design/CONSULTATION-CONNECTOR-AND-CHANGE-CONTROL-2026-11-04.md):
  실시간 수집과 AI 분석을 분리한다. 사용자 명시 분석 후 초기 설계를 작성하고,
  최초 Baseline 이후 CR은 영향 분석·사용자 승인·새 Revision을 거친다.
  v15 §2C의 수동 Batch-only 정책보다 우선하며 CSAS D3·Revision·G5·현행 Lead 세션에 적용한다.
  실제 플랫폼 Connector 제공·연동·구현 완료를 선언하는 문서는 아니다.

## 검토 중인 개정안

- [명세 검증 G1~G6 통합 개정안 (2026-11-02)](proposals/SPECIFICATION-GATES-INTEGRATION-DRAFT-2026-11-02.md)
- [추가 인수 기준·기존 AC 추적표](proposals/SPECIFICATION-GATES-AC-TRACE-2026-11-02.md)

위 두 문서는 작성·검토를 위한 초안이다. 기존 v15를 대체하거나 새 검증 정책의
구현을 승인하지 않으며, 기존 AC의 완료 상태와 UI v9 기준을 변경하지 않는다.
단, 후속 확정 CSAS v0.8 F절의 G0~G7 의미까지 미정이라는 뜻은 아니다.
현행 결정은 위 통합 제품 계약, 과거 제안 경위는 이 두 파일에서 구분해 읽는다.

## 사용 안내
`03_UI/SPS_Builder_Lead_UI_v9.html` 파일을 브라우저에서 열면 UI 시제품을 볼 수 있습니다.
이 HTML은 **동작 시연용 프로토타입**이며 실제 SPS Core·Codex·GitHub 연동을 포함하지 않습니다.

## 개발 작업 기준

- 작업 분담·공식 자료 사전 조사·한도 회복 후 재개·쉬운 한국어 보고는
  루트 [AGENTS.md](../../AGENTS.md)를 따른다.
- 총괄은 설계·통합·최종 검수를 맡고, 독립적인 작은 작업은 `gpt-6-luna`
  `high` 추론에 나누어 병렬로 진행한다. 요청한 모델을 사용할 수 없는 경우
  사용했다고 표시하거나 임의로 다른 모델·계정으로 바꾸지 않는다.
- 검정·중립 회색은 Builder 플러그인에만 적용한다. 업무 설계는 v16,
  화면 구조는 v9, 실제 색상과 반응형 적용은 위 UI 적용 기준을 따른다.
  이 기준은 Core 전역 UI나 실제 AI 실행의 완료를 뜻하지 않는다.

## 변경 매트릭스

| 충돌 또는 누락 | 판정 | 현행 결론 |
| --- | --- | --- |
| Lead 3·5·6세션 및 마이그레이션 | REPLACE / REMOVE_FROM_ACTIVE_SCOPE | 6개 논리 세션과 별도 Manager. 개발 기록을 신규 사용자 데이터로 이전하지 않는다. |
| 상담 Batch-only 대 지속 수집 | REPLACE | 수집과 명시 분석 분리. 승인 후 CR·영향 분석·Revision은 유지. |
| Agent별 계정 고정 | REPLACE | Core 관리 단일 활성 계정. Workspace 권한·세션 및 실제 점유는 분리. |
| 일반 Wake 대 Goal 연속 실행 | REPLACE / VERIFY | 일반 세션의 공식 toolOutput 지원 확인. 활성 Goal은 공식 재개 우선. |
| Turn DONE 대 Goal COMPLETED | UPDATE | 정상 종료 턴과 목표 완료를 별도 시스템 이벤트로 기록. |
| Goal 완료 대 Task·Workstream VERIFIED | KEEP / UPDATE | 상위에 결과를 인계하고 독립 QA·Gate·저장 이벤트를 별도 판정. |
| 계정 전환 후 Goal Resume | VERIFY | 실행 소유권·세대·lease/CAS와 활성 Turn 검사. 완료·사용자 정지 자동 실행 0. |
| Manager 대 Lead 통합 책임 | UPDATE | Manager 통합/CI/E2E/Packet, CTO 기술 재작업, Review 설계 충돌, Main G7. |
| 내부 Review 대 사용자 승인 | UPDATE | 같은 여섯 번째 세션에 최종 승인 페이지, 실제 사용자만 정확한 버전을 승인·수정 요청·보류. |
| Core 기술 권한 대 Builder 결정권 | KEEP / VERIFY | 범용 Core 권한·Host 위임, Builder 역할, 사용자 결정, OS 강제의 실제 검증 분리. |
| G1~G6 제안과 CSAS D3·G0~G7 | KEEP / VERIFY | 확정 v0.8의 Domain Pack·Coverage·Gap·Revision 유지. SG 초안이나 미확인 v0.9 적용 금지. |
| Marketplace·자체 Native·Core Preview | REMOVE_FROM_ACTIVE_SCOPE | 과거 범위 보존. 제품 HTML 승인 뷰어와 실제 Worker 실행은 제외하지 않음. |
| Capacity·인증·사용량·권한·대기 | UPDATE / VERIFY | 분류와 복구를 분리, 서버 지침·백오프·유한 자원·완료/취소/철회 시 예약 해제. |

## 원문 및 중복 참조 감사

- 감사 시작점: Builder `c7993c8`의 `docs/` 54개와 루트 소개·지침·고지 3개,
  **기존 57개**. 아래 목록은 추적 파일 단위다. 이번에 추가한 실행 부속서는 별도다.
- 첨부 2026-11-06 지시와 최근 대화의 CLI Pool·Goal·Wake·Capacity·개발 접근 결정은
  현행 정본에 반영했다. CAO 작업용 사본·보고서는 제품의 두 번째 원문이 아니다.
- CSAS v0.8 원본 ZIP의 Markdown은 추적표의 SHA-256 `bb5e723e…de7`와 일치한다.
  B/C/F/G/H의 결정·업무 순서·Gate·D3를 대조했다. 확정 유효 조항은 유지하고,
  D절의 5세션/레거시 전환은 PARTIALLY_SUPERSEDED로 처리한다.
  v0.7 ZIP 및 과거 Git의 v15/CSAS v0.8 온보딩 메모(`e78760f`)는 HISTORICAL이다.
  **CSAS v0.9는 UNKNOWN**: 확인한 첨부·추적 문서·로컬
  자료에서 원문/확정 효력을 찾지 못해 조항 비교는 미완료다. 원문 확보 전 추정하지 않는다.
- 문서 이동·삭제 없음. v15, 이전 세션 정책, CSAS 원문 AC 및 각 추가안은 계속 인용할 수 있다.
  서로 다른 복사본은 마스터 인덱스의 경로로 참조를 통일한다.
- 현재 확인 범위에서 새 제품 결정이 필요한 UNRESOLVED 항목은 없다. 원문 누락,
  실제 실행 증거 부족, 설치별 호환성은 별도 검증 공백이다.

`CURRENT`는 현행 기준/참조, `PARTIALLY_SUPERSEDED`는 일부 조항 대체,
`SUPERSEDED`는 운영 지시 전체 대체, `HISTORICAL`은 기록 보존,
`DRAFT`는 미확정, `UNKNOWN`은 원문 또는 효력 확인 필요다.

### CURRENT (13개)

현행 정본·부속서·추적표, 상세 원문 또는 안내/고지. 구현 승인과 별개.

- [`AGENTS.md`](../../AGENTS.md)
- [`README.md`](../../README.md)
- [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)
- [`SPS_Builder_Generic_Permissions_And_Host_Delegation_Addendum_2026-11-05.md`](01_Design/SPS_Builder_Generic_Permissions_And_Host_Delegation_Addendum_2026-11-05.md)
- [`SPS_Builder_Lead_Final_Review_Approval_Page_Addendum_2026-11-05.md`](01_Design/SPS_Builder_Lead_Final_Review_Approval_Page_Addendum_2026-11-05.md)
- [`SPS_Builder_Project_Document_Center_and_Freshness_Addendum_v1.1_2026-11-04.md`](01_Design/SPS_Builder_Project_Document_Center_and_Freshness_Addendum_v1.1_2026-11-04.md)
- [`UI-IMPLEMENTATION-CONTRACT-2026-11-01.md`](03_UI/UI-IMPLEMENTATION-CONTRACT-2026-11-01.md)
- [`AC-TRACE-2026-11-04.json`](AC-TRACE-2026-11-04.json)
- [`AC-TRACE-2026-11-04.md`](AC-TRACE-2026-11-04.md)
- [`CORE-PLUGIN-ALIGNMENT-2026-11-02.md`](CORE-PLUGIN-ALIGNMENT-2026-11-02.md)
- [`CURRENT-PRODUCT-CONTRACT-2026-11-04.md`](CURRENT-PRODUCT-CONTRACT-2026-11-04.md)
- [`README.md`](README.md)
- [`README.md`](../implementation/README.md)

### PARTIALLY_SUPERSEDED (11개)

비충돌 원문·시험은 유지. 세션, Batch-only, 계정 결속, 테마, Goal/Wake, 실행/계획 기준의 충돌은 v16 우선.

- [`CONSULTATION-CONNECTOR-AND-CHANGE-CONTROL-2026-11-04.md`](01_Design/CONSULTATION-CONNECTOR-AND-CHANGE-CONTROL-2026-11-04.md)
- [`SPS_Builder_CLI_Pool_Completion_And_Selective_Wake_Addendum_2026-11-05.md`](01_Design/SPS_Builder_CLI_Pool_Completion_And_Selective_Wake_Addendum_2026-11-05.md)
- [`SPS_Builder_Delegated_Goals_And_Completion_Idle_Addendum_2026-11-05.md`](01_Design/SPS_Builder_Delegated_Goals_And_Completion_Idle_Addendum_2026-11-05.md)
- [`SPS_Builder_Execution_Handoff_And_Recovery_Addendum_2026-11-05.md`](01_Design/SPS_Builder_Execution_Handoff_And_Recovery_Addendum_2026-11-05.md)
- [`SPS_Builder_Integration_Design_20261104.md`](01_Design/SPS_Builder_Integration_Design_20261104.md)
- [`SPS_Plugin_Builder_Codex_Final_Design_v15.md`](01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md)
- [`SPS_Builder_Technology_Stack_Research.md`](02_Tech_Research/SPS_Builder_Technology_Stack_Research.md)
- [`SPS_Builder_Lead_UI_v9.html`](03_UI/SPS_Builder_Lead_UI_v9.html)
- [`BUILDER-V15-COMPLETION-PLAN-2026-11-02.md`](../implementation/BUILDER-V15-COMPLETION-PLAN-2026-11-02.md)
- [`LEAD-EXECUTION-CONTRACT-2026-11-01.md`](../implementation/LEAD-EXECUTION-CONTRACT-2026-11-01.md)
- [`PLAN-2026-11-01.md`](../implementation/PLAN-2026-11-01.md)

### SUPERSEDED (1개)

운영 지시는 교체, 과거 증거만 보존.

- [`LEAD-THREE-SESSION-PREPARATION-2026-11-02.md`](../implementation/LEAD-THREE-SESSION-PREPARATION-2026-11-02.md)

### HISTORICAL (30개)

해당 소스/버전의 구현·검토·시험 기록. 새 범위 지시 또는 현재 검증으로 재사용 금지.

- [`CODEX-NATIVE-WORKERS-2026-11-02.md`](../implementation/CODEX-NATIVE-WORKERS-2026-11-02.md)
- [`CORE-HOST-RECHECK-2026-11-02.md`](../implementation/CORE-HOST-RECHECK-2026-11-02.md)
- [`CORE-HOST-SESSION-ENSURE-SDK-2026-11-02.md`](../implementation/CORE-HOST-SESSION-ENSURE-SDK-2026-11-02.md)
- [`CORE-HOST-WORKSPACE-SESSIONS-2026-11-02.md`](../implementation/CORE-HOST-WORKSPACE-SESSIONS-2026-11-02.md)
- [`CTO-PRIVATE-MEMORY-2026-11-02.md`](../implementation/CTO-PRIVATE-MEMORY-2026-11-02.md)
- [`CTO-QUESTION-INTAKE-2026-11-02.md`](../implementation/CTO-QUESTION-INTAKE-2026-11-02.md)
- [`CTO-QUESTION-REPLY-2026-11-02.md`](../implementation/CTO-QUESTION-REPLY-2026-11-02.md)
- [`CTO-TASK-PACKETS-2026-11-02.md`](../implementation/CTO-TASK-PACKETS-2026-11-02.md)
- [`CTO-WORKSTREAM-DELIVERY-2026-11-02.md`](../implementation/CTO-WORKSTREAM-DELIVERY-2026-11-02.md)
- [`DESIGN-BASELINE-2026-11-02.md`](../implementation/DESIGN-BASELINE-2026-11-02.md)
- [`GRAPH-DETAIL-VALIDATION-2026-11-01.md`](../implementation/GRAPH-DETAIL-VALIDATION-2026-11-01.md)
- [`INDEPENDENT-PLUGIN-SURFACE-2026-11-02.md`](../implementation/INDEPENDENT-PLUGIN-SURFACE-2026-11-02.md)
- [`LEAD-CONDITIONAL-STATE-2026-11-02.md`](../implementation/LEAD-CONDITIONAL-STATE-2026-11-02.md)
- [`LEAD-DESIGN-DRAFT-2026-11-02.md`](../implementation/LEAD-DESIGN-DRAFT-2026-11-02.md)
- [`LEAD-DURABLE-CHAT-2026-11-02.md`](../implementation/LEAD-DURABLE-CHAT-2026-11-02.md)
- [`LEAD-LIVE-DESIGN-2026-11-02.md`](../implementation/LEAD-LIVE-DESIGN-2026-11-02.md)
- [`LEAD-QUESTION-REVISION-2026-11-02.md`](../implementation/LEAD-QUESTION-REVISION-2026-11-02.md)
- [`LEAD-SHARED-MEMORY-2026-11-02.md`](../implementation/LEAD-SHARED-MEMORY-2026-11-02.md)
- [`LEAD-SOLUTION-READ-TOOL-2026-11-02.md`](../implementation/LEAD-SOLUTION-READ-TOOL-2026-11-02.md)
- [`PROJECT-CTO-REGISTRATION-2026-11-02.md`](../implementation/PROJECT-CTO-REGISTRATION-2026-11-02.md)
- [`SESSION-EXECUTION-POLICY-2026-11-02.md`](../implementation/SESSION-EXECUTION-POLICY-2026-11-02.md)
- [`SOLUTION-REVISION-STORAGE-2026-11-02.md`](../implementation/SOLUTION-REVISION-STORAGE-2026-11-02.md)
- [`SPECIFICATION-VALIDATION-2026-11-02.md`](../implementation/SPECIFICATION-VALIDATION-2026-11-02.md)
- [`SYSTEM-UI-VALIDATION-2026-11-02.md`](../implementation/SYSTEM-UI-VALIDATION-2026-11-02.md)
- [`TECHNOLOGY-DECISIONS-2026-11-02.md`](../implementation/TECHNOLOGY-DECISIONS-2026-11-02.md)
- [`WORKSTREAM-INSTRUCTIONS-2026-11-02.md`](../implementation/WORKSTREAM-INSTRUCTIONS-2026-11-02.md)
- [`CHECKPOINT_PRESTART_2026-10-29.md`](../review/CHECKPOINT_PRESTART_2026-10-29.md)
- [`CORE_PREREQUISITES_2026-10-29.md`](../review/CORE_PREREQUISITES_2026-10-29.md)
- [`DEPENDENCY_AND_PARALLEL_PLAN_2026-10-29.md`](../review/DEPENDENCY_AND_PARALLEL_PLAN_2026-10-29.md)
- [`SPS_Plugin_Builder_Analysis_2026-10-29.md`](../review/SPS_Plugin_Builder_Analysis_2026-10-29.md)

### DRAFT (2개)

제안. 승인된 CSAS v0.8 G0~G7을 대체하지 않는다.

- [`SPECIFICATION-GATES-AC-TRACE-2026-11-02.md`](proposals/SPECIFICATION-GATES-AC-TRACE-2026-11-02.md)
- [`SPECIFICATION-GATES-INTEGRATION-DRAFT-2026-11-02.md`](proposals/SPECIFICATION-GATES-INTEGRATION-DRAFT-2026-11-02.md)
