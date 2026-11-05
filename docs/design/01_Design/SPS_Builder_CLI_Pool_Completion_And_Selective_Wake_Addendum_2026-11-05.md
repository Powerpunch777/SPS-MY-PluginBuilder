# CLI 공용 Pool·시스템 완료 이벤트·선택적 Wake 확정 설계

기준일: 2026-11-05. 사용자 확정 지시를 반영한다. 기존 실행·인계·복구 보강 §9를
구체화하며 충돌하는 과거 자동 Wake 해석보다 우선한다. **설계 반영만 완료**이며,
사용자의 후속 지시에 따라 이 추가 기능의 구현·실제 실행 연결·인수 시험은 보류한다.
기존 v15·UI v9·CSAS v0.8 및 후속 비충돌 요구, Lead 6세션과 독립 Manager는 유지한다.

## 1. 계정·세션·실행의 분리

- 모든 Lead·CTO·Worker·QA·Integration Manager는 하나의 활성 CLI 계정을 공유한다.
  Agent마다 인증 계정을 고정하지 않는다. 인증정보와 Secret은 Core가 보호한다.
- 각 논리 세션은 독립 Session ID·대화 기록을 유지한다. Lead의 CTO 생성 및 CTO의
  Worker/QA 생성 시 기존 Session Registry에 등록하며 Manager도 같은 원칙을 따른다.
- 등록만으로 CLI나 모델을 실행하지 않는다. 실제 AI 실행 시에만 현재 계정과 Run Lease를
  연결하고, 실행 종료·실제 프로세스 정리 확인 뒤 해당 Run의 점유를 해제한다.
  Session ID·대화·Task·Run·Checkpoint 이력은 보존한다.
- 계정 변경은 세션 정체성을 변경하거나 기록을 삭제하지 않는다. 필요하면 동일 로컬
  Session ID로 재개한다. 과거 계정의 서버 소유권을 로컬 기록 탐색의 전제조건으로 삼지
  않는다.

## 2. 시스템이 기록하는 마지막 AI 실행 상태

Agent에게 DONE 문구나 별도 완료 보고를 작성하도록 강제하지 않는다. Core/SDK 또는
채택한 Codex 실행 인터페이스의 시스템 실행 이벤트를 세션 외부의 **기존 Run/Event 저장**에
결속하고, Builder는 Session Registry와 연결된 마지막 Run의 상태를 투영한다.
대화 내용·UI 알림·무출력·CLI 프로세스 생존·임의 callback boolean은 완료 권위가 아니다.

| 상태 | 의미와 증거 |
| --- | --- |
| RUNNING | 실제 AI Run/turn이 시작돼 수행 중임을 실행 경계가 확인함. 예약·세션 등록·CLI 대기만으로 표시하지 않음 |
| DONE | 해당 세션의 마지막 AI 실행이 정상 종료됐다는 시스템 완료 증거가 있음. 실패·중단·불확실 종료는 제외 |
| INTERRUPTED | 실행 중 중단됐거나 실패/불확실 결과가 남음. 원인·정상 완료 미확인·종료 확실성을 별도 필드로 보존 |
| IDLE | 현재 시작된 AI 실행이 없는 준비·대기 상태. 과거 Run의 DONE/실패 이력을 삭제하거나 새 완료로 해석하지 않음 |

마지막 Run의 terminal 상태와 현재 실행 여부·대기 사유를 기존 기록에서 함께 조회한다.
DONE은 Task 제출·Task 완료·CTO VERIFIED·QA 합격·통합 완료·프로젝트 완료가 아니다.
기존 업무 상태·Revision·검증 Gate·승인 경계를 그대로 유지한다. 정상 답변 완료 후 사용자
입력을 기다리는 Lead도 자동 복구 대상이 아니다. 실패/불확실 결과를 DONE으로 바꾸지 않는다.

시스템 이벤트는 Workspace·Plugin·Agent·Session·Run·provider turn 및 원본 이벤트
ID/sequence에 결속한다. 성공 상태, 오류, 중단/취소 사유와 관측 시각을 보존한다.
오래된 Run의 지연 이벤트는 그 Run 이력만 갱신하며 현재 다른 Run을 덮어쓰지 못한다.
Codex app-server의 `turn/completed`는 최종 상태가 `completed`인 경우만 정상 완료다.
`failed`·`interrupted`도 종료 이벤트로 올 수 있으므로 이름만 보고 DONE으로 처리하지 않는다.
채택한 CLI JSONL 등 다른 인터페이스는 해당 버전의 실제 성공/실패 이벤트 계약을 확인한다.

## 3. 계정 전환 절차

1. 기존 Core 실행 admission에서 신규 AI 실행 배정을 일시 중지하고 전환 세대를 고정한다.
2. 기존 세션별 실제 Run/turn 상태, 완료 이벤트 cursor, Task·Checkpoint·Revision 및
   사용자/승인/의존성 대기를 읽는다. 전환 전 RUNNING 관측을 출처·버전과 함께 보존한다.
3. 기존 CLI 프로세스와 연결된 실행을 안전하게 정리하고 실제 종료를 확인한다. timeout이나
   프로세스 ID만으로 종료를 단정하지 않는다. 불확실하면 새 실행을 시작하지 않는다.
4. 허용된 범위에서 Core가 활성 인증 계정을 A에서 B로 변경한다. 실행 중 인증파일을
   덮어쓰거나 Builder/Agent에 인증정보를 노출하지 않는다.
5. 기존 로컬 Session ID·기록·실행 상태를 재개 가능하게 준비한다. 호출 없는 복원이 실제
   지원되는 경우에만 RESUME하며, 그렇지 않으면 PREPARE까지만 수행한다.
6. 계정 전환/인증 문제로 중단된 미완료 Run만 자동 복구 후보로 선정한다.
7. WAKE 직전에 최신 완료·Run·Task·Revision·권한·종료 상태를 다시 검증하고 원자적으로
   중복 실행을 차단한 뒤, 적격 세션에만 짧은 `continue`를 전송한다.
8. DONE·IDLE·사용자/승인/의존성 대기·완료/보관·사용자 중단 세션에는 자동 입력을 보내지
   않는다. 부모 복원이 부모 Wake를 뜻하지 않으며 모든 세션 일괄 Wake는 금지한다.

## 4. 자동 Wake의 필요조건과 경합

다음 조건을 **모두** 만족해야 한다. Agent의 자가 보고나 당시 CLI 생존으로 대체하지 않는다.

- 전환 직전 실제 AI 작업이 RUNNING이었다.
- 그 Run이 계정 전환 또는 인증 문제로 중단됐다는 실행 근거가 있다.
- 같은 Run/turn의 정상 완료 이벤트가 기록되지 않았다.
- 최신 Task·Checkpoint에 이어 수행할 미완료 작업이 있고, 사용자 결정·승인·의존성 대기가 아니다.
- 기존 실행의 실제 종료가 확인됐고 현재 Revision·권한·위임·동시 실행 한도에서
  복구가 안전하다. 취소 불확실·외부 효과 미확인·이미 열린 후속 실행이 없다.

Lead가 답변 생성 중 중단됐다면 위 조건으로 복구할 수 있다. 답변을 마쳐 사용자 입력을
기다리면 continue를 보내지 않는다. 사용자 응답·의존성 해소·명시 재개는 각각 별도 이벤트로
Wake할 수 있으나 계정 전환 자동 복구와 혼동하지 않는다.

정상 완료 직후 한도가 소진돼도 저장된 완료 이벤트가 있으면 해당 세션을 깨우지 않는다.
후보 선정 당시 RUNNING이었더라도 최종 재조회에서 DONE이면 복구를 취소한다.
완료와 전환/복구가 겹치면 기존 Run ID·원본 이벤트 ID·전환 세대·Revision/CAS 및
실행 requestId/lease로 하나의 복구만 claim한다. 오래된 세대는 새 세대에 실행을 배정하지
못한다. claim과 실제 전송 사이에도 완료/권한 변화가 우회되지 않는 기존 admission 경계가
필요하며, 여러 저장 key의 개별 CAS를 원자적이라고 주장하지 않는다.

완료 이벤트가 지연·누락됐으면 자동 continue를 보류한다. 실제 프로세스 종료, 마지막 실행
결과, 원본 Run/Event와 Task·Checkpoint를 대조해 정상 종료/실제 중단/불확실을 판단한다.
exit 0이나 Checkpoint 하나만으로 정상 모델 완료를 만들지 않는다. 불확실성이 남으면
확인 필요와 원인·다음 조치로 보존하며 AI를 호출해 DONE 여부를 묻지 않는다.
전송 응답 유실은 기존 requestId 조회로 확인하고 확인되지 않은 메시지를 자동 재전송하지
않는다. 완료 이벤트/복구 이벤트 중복은 같은 Run과 세대에 중복 효과를 내지 않아야 한다.

## 5. PREPARE·RESUME·WAKE

| 동작 | 계약 |
| --- | --- |
| PREPARE | 기존 세션 식별자·로컬 기록·마지막 실행 상태·대기 사유와 전환 세대를 준비. 모델 요청 없음 |
| RESUME | 같은 로컬 Session ID의 기존 대화를 재개 가능한 상태로 복원. 모델 호출이 없는 지원 방식만 사용 |
| WAKE | 적격한 기존 세션에 continue를 전달해 새 AI 실행을 시작. 별도 requestId·Run·lease·복구 근거 기록 |

실제 CLI의 resume이 자동 입력·goal continuation·모델 호출을 발생시키는지 해당 버전과
실행 경로에서 확인한다. 호출 없는 방식이 없거나 미검증이면 PREPARE까지만 하고
RESUME 성공/모델 호출 0회를 주장하지 않는다. 조회·등록·준비만으로 실행하지 않는다.
대량 복구 프롬프트나 새 대화 생성을 동일 세션 복원으로 표시하지 않는다.

## 6. Core·Builder 책임과 재사용

| 소유자 | 책임 |
| --- | --- |
| SPS Core | CLI 인증 프로필/공용 Pool·활성 계정, 승인된 CLI 실행/프로세스 관측, 완료·중단 이벤트, Run Lease·중복 실행 차단·기술 권한·계정 전환·비밀 보호 |
| SPS Builder | 기존 논리 Session Registry, 마지막 AI Run 상태와 Task 연결, 전환 중단 후보 선정, 적격 continue·사용자 대기 제외, 기존 Revision/QA/Integration 및 복구 결과 연결 |

기존 Core Agent/Session/Run/Job/Event·실행 requestId·CAS·pool·권한·lease와 Builder
Task Packet/Checkpoint/Revision을 우선 재사용한다. 새 AI 관리 Agent, 별도 scheduler,
중복 세션 원장·완료 DB·승인 체계를 추가하지 않는다. Core에 Builder 역할명을 하드코딩하지
않는다. API 검사와 실제 CLI의 OS 접근 격리는 별개이며 기존 보호 실행 요구는 축소하지 않는다.

실제 계약에서 빠진 terminal turn 식별/성공 이벤트 저장·재조회·전환 세대/admission 결속은
Core의 범용 선행 기능으로, 업무 미완료/대기 판정과 해당 continue 정책은 Builder 기능으로
분리한다. 인터페이스 선언·observer probe·CAO 운영 성공을 제품 연결 증거로 쓰지 않는다.

## 7. 필수 실제 CLI 인수

기존 POLICY-EXEC-02/09/11/15/16의 상세 인수로 추적한다. 원문 AC 216개를 대체하거나
합격 수에 더하지 않는다. 아래 9개는 모두 **NOT_RUN**이다. 정상·경합·실패 fixture 통과와
실제 CLI 시험을 구분한다. 실제 시험 환경을 확보하지 못하면 해당 인수는
BLOCKED/NOT_RUN으로 남긴다.

| 번호 | 필수 실제 CLI 시나리오 | 필요한 결과 |
| --- | --- | --- |
| 1 | Worker 작업 중 한도 소진, 계정 전환 | 실제 중단 Worker만 continue; 다른 완료·대기 세션 입력 0 |
| 2 | Worker 정상 완료 직후 계정 전환 | 정상 완료 이벤트 보존; continue 0 |
| 3 | Lead 사용자 답변 대기 중 전환 | 사용자 대기 보존; continue 0 |
| 4 | Lead 답변 생성 중 전환 | 실제 중단·미완료·종료/권한 재확인 후에만 continue |
| 5 | CTO·Worker 여러 개 병렬 실행 중 전환 | 각 Run의 실제 중단 여부에 따라 선택 복구; DONE·IDLE 제외 |
| 6 | 완료 이벤트와 계정 전환 동시 발생 | 최신 DONE 우선, 원자적 claim·중복/지연 이벤트에서 중복 Wake 0 |
| 7 | 완료 이벤트 누락 | 실제 종료·결과·Task/Checkpoint 대조, 불확실 자동 Wake 0 |
| 8 | 프로세스 종료·재시작 | 동일 Session ID·외부 실행 상태/이벤트·전환 세대 보존, 이중 프로세스/Run 0 |
| 9 | A 인증으로 만든 로컬 세션을 B 인증으로 재개 | 로컬 탐색·복원, 복원 중 모델 호출 0, B 인증의 실제 요청/응답 성공을 각각 증명 |

증거는 실제 CLI/adapter 버전·환경, Workspace/Session/Run/turn·원본 이벤트 ID/sequence,
전환 세대와 전후 상태, 종료 확인, requestId 및 실제 continue 전송/미전송을 연결한다.
비밀·사용자 원문을 공개하지 않는다. 마지막 시나리오에서 파일 존재나 같은 Session ID만으로
다른 계정의 모델 요청 성공을 증명하지 않는다. 실제 미지원은 합성 성공으로 대체하지 않는다.

## 8. 현재 반영 상태

- 설계 반영: 이 문서와 현행 제품 계약·실행 보강·설계 목차에 반영.
- 실제 실행 연결: **이 추가 결정의 제품 연결은 미검증**. 기존 Core/SDK 일부 Run 조회·취소·
  requestId와 Codex 종료 이벤트가 있다는 사실이 전체 요구 구현을 뜻하지 않는다.
- 종단 간 인수: 위 9개 모두 **NOT_RUN**. 과거 CAO의 수동 세션 지정·계정 변경·명시 Wake는
  이 시스템 완료 기반 자동 후보 선정/최종 경합 검증을 수행한 시험이 아니다.
- 후속 우선순위: 사용자가 이 기능 구현보다 다른 작업을 먼저 하도록 정했으므로 구현은 보류.
  기존 코드·WIP·원본 실패·세션 기록을 보존하며 이 문서 작성으로 개발을 자동 재개하지 않는다.

참고한 공식 이벤트 계약: [Codex app-server lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview),
[terminal 상태 확인](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server#using-codex-app-server).
thread 복원과 turn 시작은 별도 단계이며, 문서 계약과 현재 설치 CLI의 무호출 실증은 구분한다.
