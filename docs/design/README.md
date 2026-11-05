# SPS Plugin Builder — 설계·기술 조사·UI 묶음

- **현재 제품 기준은 [통합 제품 계약](CURRENT-PRODUCT-CONTRACT-2026-11-04.md)을 먼저 읽는다.**
  v15·CSAS v0.8·상담 개정·문서센터 v1.1·통합 담당·최종 검토·승인·범용 권한과 후속 사용자 결정을 통합한다.
  Lead 6세션과 별도 Integration Manager, 레거시 전환 제외, 실시간 수집/명시 분석,
  G0~G7 및 선택형 Shell 경계를 한곳에서 확인한다.
  옛 문서의 비충돌 요구와 역사 근거는 보존하며 이 링크가 구현 완료를 뜻하지 않는다.
- [현행 인수 기준 추적표](AC-TRACE-2026-11-04.md): v15 118 + CSAS 44 + 상담 8 + 문서센터 16 + 통합 16 + 최종 승인 14의
  원문 정의 216개를 소스 해시와 함께 추적한다. 레거시 6개는 제외이며, 정의 수는
  합격 개수나 서로 독립된 요구 개수가 아니다. 실제 AC 전체 인수 상태는 별도로 갱신한다.
- `01_Design/`: 최신 통합 설계서 v15 (Lead/CTO/Worker/QA 및 기술 선정 반영)
- `02_Tech_Research/`: 기술 스택 조사·선정 근거
- `03_UI/`: HTML UI v9 (Document Worker 제외)
- [UI 적용 기준 (2026-11-01)](03_UI/UI-IMPLEMENTATION-CONTRACT-2026-11-01.md):
  UI v9의 구조·배치를 유지하고 색상만 사용자 결정에 따라 Codex식 검정·중립
  회색으로 적용한다. Core 테마와 구분하며, 미구현 기능은 위치를 유지하고
  사용 불가 상태로 표시한다. 임시 밝은 UI는 최종 기준이 아니다.

## 최신 확정 개정

- [CLI Pool·시스템 완료·선택적 Wake (2026-11-05)](01_Design/SPS_Builder_CLI_Pool_Completion_And_Selective_Wake_Addendum_2026-11-05.md):
  단일 활성 계정과 독립 Session ID, 시스템 완료 이벤트의 RUNNING/DONE/INTERRUPTED/IDLE,
  전환으로 실제 중단된 Run만 continue, 완료 직후 전환/지연 이벤트/중복 복구의 최종 CAS 검증을 확정한다.
  DONE은 업무 완료/QA가 아니며 별도 보고 Agent·중복 원장을 만들지 않는다. PREPARE/RESUME/WAKE를
  분리하고 무호출 복원이 없으면 PREPARE만 한다. 별도의 공급자 정책 확인·활성화 승인 조건은 추가하지 않는다.
  9개 실제 CLI 인수는 NOT_RUN이며 사용자 지시로 이 추가 기능의 구현·실행 검증은 보류한다.
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
- 검정·중립 회색은 Builder 플러그인에만 적용한다. 업무 설계는 v15,
  화면 구조는 v9, 실제 색상과 반응형 적용은 위 UI 적용 기준을 따른다.
  이 기준은 Core 전역 UI나 실제 AI 실행의 완료를 뜻하지 않는다.

이 묶음에는 과거 버전이나 이전 AGENTS/Skills 초안이 포함되지 않습니다.
