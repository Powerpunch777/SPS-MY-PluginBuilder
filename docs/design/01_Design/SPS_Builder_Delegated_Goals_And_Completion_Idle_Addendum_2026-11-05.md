# CTO·Worker 장기목표 배정과 완료 후 대기 확정 설계

기준일: 2026-11-05. 사용자가 첨부한 장기목표 지시서를 현행 제품 요구에 반영한다.
원문 SHA-256: `81876f49bdbd5543589b40f8b4905464c65dff15a242d03c675a048c85e86a5d`.
설계 반영·코드 구현·실제 인수는 별개다. 아래 실제 인수 12개는 모두 NOT_RUN이다.
Lead 6개 논리 세션·독립 Manager·기존 권한/사전 위임·단일 활성 CLI 계정·Revision/CAS·
CSAS G0~G7·UI Contract·공식 통합 이벤트·사용자 전용 최종 납품 승인은 유지한다.

## 1. 배정과 목표의 범위

- Lead는 담당 CTO의 Workstream을, CTO는 직속 Worker의 Task 또는 QA의 검증 작업을
  해당 Agent의 장기목표로 등록할 수 있다. 여러 AI 턴에 걸쳐 승인된 범위를 자율 수행한다.
- Manager는 기존 승인된 통합 작업/공식 이벤트 경로를 유지한다. Goal이 통합 시작 권위를
  만들거나 다른 Agent의 목표를 바꾸는 권한을 부여하지 않는다.
- 목표는 승인 설계·Spec/UI Revision·Workstream/Task·파일/CLI/Runner·위임·예산 범위를
  초과하지 않는다. 목표 지속성은 CLI 무중단 실행 보장이 아니며 원래 복구 계약을 따른다.
- 기존 Task Packet/Workstream 배정·Session Registry·Core Run/Job/Event·Revision에
  목표 배정 참조와 원본 provider 상태를 결속한다. 별도 Goal AI Agent/중복 DB·실행기를 만들지 않는다.

## 2. 배정 권한과 서버 강제

| 주체 | 허용하는 목표 변경 대상 |
| --- | --- |
| 사용자 | 현재 권한과 Workspace 범위 내 Agent |
| Lead | 담당 CTO |
| CTO | 같은 Workstream의 직속 Worker·QA |
| Worker·QA | 상위/형제 Agent 변경 불가 |
| Integration Manager | Lead·CTO 목표 변경 불가 |

목표 등록·수정·삭제/clear·활성화·중단 모두 실제 호출 주체와 현재 위임·조직/배정 관계를
Builder 백엔드에서 검증하고, Core가 대상 Agent/Thread·Workspace/Plugin·기술 권한을
검증한다. Core에 Builder 역할명을 하드코딩하지 않는다. Thread ID만 알면 임의로 호출할 수
있는 raw Goal RPC를 Agent에게 노출하지 않는다. API의 origin 필드는 권한 증거가 아니다.
실제 사용자 요청인지 시스템/Agent 요청인지는 인증된 실행 경계에서 판정한다.

자신의 목표 수정도 상위의 기존 위임 범위 안에서만 가능하다. 목표 확대·다른 Task로 교체는
새 상위 배정이 필요하다. 상위/형제 목표 조작과 다른 Workspace 접근은 직접 API에서도 거부한다.
변경은 배정 Revision/CAS·멱등 요청·원본 감사 이력에 연결한다. 새 목표가 사용량 집계를
초기화하는 경우 이전 목표/비용 이력을 먼저 보존하며 수정으로 예산을 우회하지 않는다.

## 3. 실제 Codex 인터페이스와 미구현 경계

공식 App Server의 `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`와
`thread/goal/updated`, `thread/goal/cleared`를 우선 재사용한다. 직접 AI 간 등록이 없으면
기존 Builder 배정 경로가 권한 검사 후 Core를 통해 Goal API를 호출한다. AI끼리 별도
Goal 관리 대화를 만들지 않는다. 등록 성공과 자동 모델 실행 시작은 별도 증거가 필요하다.

설치 앱 번들 0.166.0-alpha.5.1의 기존 생성 stable 스키마에서 Goal set/get 응답 및 상태를
정적으로 확인했다. provider 상태는 active/paused/blocked/usageLimited/budgetLimited/complete다.
이 문서의 Goal COMPLETED는 해당 버전의 `complete`와 결속하며 임의의 `completed` wire 값을
만들지 않는다. 원본 상태·사유를 보존한다. 스키마 존재는 자동 연속 실행 성공이 아니다.

그 스키마의 ThreadGoal에는 별도 Goal ID가 없고 Thread ID·objective·상태·생성/갱신 시각과
사용량이 있다. provider Goal ID를 꾸며내지 않는다. 인수의 Goal ID는 기존 배정 기록의
목표 참조/Revision과 provider Thread ID·생성 시각에 결속하며 native ID 유무를 명시한다.
등록/활성화가 실제 AI 실행을 시작하는지, 완료 후 실행이 멈추는지, 계정별 goals 저장 위치와
같은 Thread 재개는 실제 설치 버전에서 따로 시험한다. 직접 SQLite 조작은 Goal API 대안이 아니다.

현재 Core의 App Server state-probe는 paused 목표 진단에 제한돼 있으며 제품용 배정·권한
강제·연속 실행 경로가 아니다. 범용 Goal 기술 권한과 호출 주체/대상 결속이 없으면 Core 선행
의존성으로 분리한다. Builder의 역할/배정 정책과 제품 연결도 별도 구현 대상이다.

## 4. 세 완료 상태와 IDLE

| 구분 | 의미와 후속 처리 |
| --- | --- |
| Turn DONE | 마지막 AI 턴 정상 종료. 활성 미완료 Goal은 공식 연속 실행 기능으로 다음 턴이 이어질 수 있음 |
| Goal COMPLETED | 배정된 목표의 수행 종료. 자동 연속 실행 종료, 세션은 IDLE, 새 정식 배정 대기 |
| Task/Workstream VERIFIED | 실제 소스·Commit·Artifact·QA·Revision·CSAS Gate의 공식 검증 판정 |

마지막 턴 DONE 이력과 Goal 상태를 보존하면서 현재 세션만 IDLE로 전환한다. 상태 하나를
다른 완료로 승격하지 않는다. Codex Goal 완료 보고만으로 QA 합격이나 VERIFIED를 만들지 않는다.
Goal 완료 후 추가 턴을 생성하거나 자동 Wake/재활성화하지 않는다. 완료 처리가 도착했으나
턴이 아직 살아 있으면 종료 확인을 기다리며 중복 연속 실행·슬롯 조기 재사용을 막는다.

Worker 완료 시 Goal/정상 종료·Task 결과·Commit·Artifact·검증 증거를 기존 저장에 결속하고
CTO에 완료 이벤트를 전달한다. CTO의 새로운 수정 배정 때만 같은 세션을 다시 활성화하거나
정책에 따라 새 Task를 등록한다. Worker 완료는 CTO의 검증 완료가 아니다.

CTO 완료 시 Goal/IDLE과 Workstream 완료 근거·검증 결과를 저장해 Lead에 전달한다.
Manager의 공식 시작 조건은 저장된 WorkstreamVerified 이벤트뿐이다. Goal 완료 이벤트가
Manager를 통합 실행시키지 않는다. CTO도 새 Workstream 또는 명시 추가 지시 전에는 대기한다.

## 5. 상위 Agent의 이벤트 소비

- 상위가 자신의 활성 미완료 Goal을 수행 중이면 기존 흐름에 결과를 반영한다. 활성 턴이
  있으면 중복 턴을 만들지 않고, 실행이 필요할 때만 기존 이벤트 기반 경로를 사용한다.
- 상위 Goal이 이미 완료됐으면 이벤트/결과만 기록하고 Wake하지 않는다. 새 정식 배정이 필요하다.
- 사용자 결정·승인·외부 의존성 대기라면 해당 조건이 실제로 해소됐을 때만 실행한다.
  이벤트 수신만으로 대기 해소를 추정하거나 모든 상위를 깨우지 않는다.
- 기존 이벤트 ID·원본 Run/Turn·Goal 배정 Revision·Task/Workstream·처리 cursor와 CAS로
  중복을 차단한다. 지연된 옛 목표 완료가 새 목표를 완료시키거나 다시 실행하지 못한다.

## 6. 계정 전환과 Capacity 복구

모든 역할은 단일 활성 CLI 계정과 독립 Thread/Session을 유지한다. 전환 전 목표의 실제
상태·배정 Revision·Task/Run·원본 이벤트·사용자 중단을 보존한다. 기존 프로세스/턴 종료·
현재 권한·lease·전환 세대·최신 완료를 확인하고 기존 Thread와 목표를 복원한다.

| 세션 | 복구 원칙 |
| --- | --- |
| 활성 목표 수행 중 실제 중단된 미완료 Goal | 공식 Goal 재개/자동 연속 기능 우선. 복구 목적 toolOutput Wake는 원칙적으로 사용하지 않음 |
| 장기목표 없는 일반 세션 | 기존 무메시지 turn/start + input: [] + 실제 관측 toolOutput 계약 유지 |
| 완료 Goal | 조회/복원 가능한 이력으로만 유지. 재활성화·새 턴 금지 |
| 사용자가 정지한 Goal | 계정 전환/Capacity를 이유로 자동 재활성화하지 않음 |

Goal 재활성화만으로 모델이 실제 수행되는지 반드시 실증한다. 무호출 Thread/Goal 복원이
지원되는지도 확인한다. 조회·PREPARE/RESUME만 요청했는데 활성 Goal이 자동 실행되지 않도록
실행 admission을 결속한다. 이를 보장하지 못하면 PREPARE까지만 하고 미지원 경로를 보고한다.
공식 Goal 재개가 미지원일 때 toolOutput/continue로 몰래 대체하거나 완료 상태를 active로
고쳐 실행하지 않는다. 지원 가능한 대안을 기술 검토 후 보고한다.

Capacity는 목표 완료가 아니다. Goal/Task/Checkpoint를 보존하고 기존 턴의 내부 재시도가
살아 있으면 우선 사용한다. 종료된 미완료 Goal은 기존 복구 대기/Job에 백오프·jitter·서버의
실제 지침을 연결해 공식 목표 재개를 시도한다. 계정 사용량 소진과 Capacity를 구분한다.
취소·권한 철회/부족·사용자 승인 대기·해결되지 않은 의존성·예산 한계에서는 무조건 반복하지
않고 목표와 정당한 중단 사유를 유지한다. 조건 해소 후 현재 권한과 목표 상태를 재검증한다.
완료·취소 뒤 남은 예약/지연 이벤트가 다시 Goal을 실행하지 못하게 한다.

## 7. 필수 실제 인수

원문 216개 AC와 기존 상태/증거는 보존한다. 아래 POLICY-GOAL-01~12는 이번 지시의
상세 인수이며 기존 Task/Graph/CSAS 추적에 결속한다. 모두 **NOT_RUN**이다.

| ID | 실제 인수 조건 |
| --- | --- |
| POLICY-GOAL-01 | Lead가 담당 CTO Thread에 Workstream 목표 등록 후 실제 자동 실행 시작 |
| POLICY-GOAL-02 | CTO가 직속 Worker Thread에 Task 목표 등록 후 여러 턴에 걸친 실제 수행 |
| POLICY-GOAL-03 | Worker Goal 완료 후 연속 실행 종료·IDLE 유지·추가 턴 0 |
| POLICY-GOAL-04 | 완료 Worker가 계정 전환 후 복원돼도 Wake/재활성화/새 턴 0 |
| POLICY-GOAL-05 | CTO의 Worker 완료 이벤트 소비·중복 방지·필요한 새 배정에서만 Worker 실행 |
| POLICY-GOAL-06 | CTO Goal 완료 후 IDLE·Lead 새 지시 대기·Goal 완료만으로 Manager 실행 0 |
| POLICY-GOAL-07 | Worker가 CTO Goal 등록/수정/삭제·활성화를 직접 요청하면 서버 권한 거부 |
| POLICY-GOAL-08 | CTO가 Lead Goal을 직접 변경하면 거부; 형제/타 Workspace/범위 확대도 거부 |
| POLICY-GOAL-09 | A→B 실제 인증 전환에서 같은 Thread/저장 Goal 보존·미완료만 재개, 완료/사용자 정지 제외 |
| POLICY-GOAL-10 | 실제 Capacity 후 목표 보존·안전한 공식 Goal 재개·중복/취소/권한/예산 한계 처리 |
| POLICY-GOAL-11 | Builder/프로세스 재시작 후 기존 목표·배정·상태·이벤트/예약 복원, 중복 실행 0 |
| POLICY-GOAL-12 | Turn DONE·Goal COMPLETED·Task/Workstream VERIFIED의 분리와 정확한 QA/Gate 권위 |

실제 Session/Thread·목표 참조·Task·Workstream·Run/Turn·배정/설계 Revision·Commit·Artifact·
QA 증거·원본 이벤트·계정 전환 세대와 테스트 환경을 결속한다. 로컬 기록 발견, Goal API 수락,
목표 상태 저장, 자동 연속 실행, 다른 인증의 실제 응답/업무 복구는 서로 별도 결과로 기록한다.
권한 검사는 fixture 외 실제 backend/API 경계에서도 확인한다. 인증 원문은 기록하지 않는다.

## 8. 현재 상태와 소유

- 설계: 이 추가안과 현행 계약·관련 복구/권한 문서·목차에 반영한다.
- 설치/공식 계약: 문서와 기존 생성 스키마의 Goal API·상태만 정적 확인. 자동 실행 실증 아님.
- Core/SDK: 범용 목표 권한·대상 Thread/배정 결속·종료/이벤트·재시작 가능한 Goal 재개 연결은 미검증.
- Builder: A는 기존 배정/Session/공유 UI, B는 완료 이벤트·Gate/Manager 소비를 소유하고
  Core CTO는 범용 기술 경계를 소유한다. 기존 파일 단일 소유/독립 QA를 유지한다.
- 실제 인수: 12개 모두 NOT_RUN. 임시 CAO의 세션 복원/계정 전환 성공을 이 인수로 승격하지 않는다.

공식 근거: [Codex App Server의 Goal 관리](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal).
공식 API가 있다는 사실과 Builder 역할 위계의 강제·실제 자동 연속 실행 지원은 별개다.
