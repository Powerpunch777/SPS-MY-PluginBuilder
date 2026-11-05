# CLI 공용 Pool·시스템 완료 이벤트·무메시지 자동 Wake 확정 설계

기준일: 2026-11-05. 사용자 확정 지시를 반영한다. 기존 실행·인계·복구 보강 §9를
구체화하며 충돌하는 과거 자동 Wake 해석보다 우선한다. 최신 결정은 자동 복구의
`continue` 사용자 메시지를 Codex App Server의 `turn/start` + `toolOutput`으로 대체한다.
기술 확인과 실제 A→B 무메시지 복구를 우선하며 문서 반영만으로 구현 완료로 판단하지 않는다.
기존 v15·UI v9·CSAS v0.8 및 후속 비충돌 요구, Lead 6세션과 독립 Manager는 유지한다.
후속 [장기목표 배정·완료 후 대기](SPS_Builder_Delegated_Goals_And_Completion_Idle_Addendum_2026-11-05.md)는
Goal 세션에 우선한다. 아래 toolOutput 복구는 Goal 없는 일반 세션에 적용하며, 미완료 Goal은
공식 목표 재개 기능을 우선한다. 완료/사용자 정지 Goal은 어떤 복구에서도 재활성화하지 않는다.

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
- 인증 프로필별 Secret은 분리·보호하고 계정별 동시 실행 한도와 사용 정책을 준수한다.
  계정 자동 전환은 공급자의 약관과 사용량 제한 정책에서 허용되는 범위에서만 활성화한다.
  이는 이번 최신 지시로 다시 확정된 조건이며 직전 문구 삭제 결정보다 우선한다.

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
| WAITING_CAPACITY | 기존 턴이 종료됐고 확인된 일시적 모델 Capacity 오류 때문에 복구가 예약됨. 다음 시각·시도·원인·취소 조건을 기존 Run/Job 기록에 결속 |
| IDLE | 현재 시작된 AI 실행이 없는 준비·대기 상태. 과거 Run의 DONE/실패 이력을 삭제하거나 새 완료로 해석하지 않음 |

마지막 Run의 terminal 상태와 현재 실행 여부·대기 사유를 기존 기록에서 함께 조회한다.
DONE은 Task 제출·Task 완료·CTO VERIFIED·QA 합격·통합 완료·프로젝트 완료가 아니다.
Turn DONE은 Goal COMPLETED와도 별개다. 활성 미완료 Goal의 공식 연속 실행은 다음 턴으로
이어질 수 있으나 완료 Goal은 자동 실행을 종료하고 IDLE에서 새 배정을 기다린다.
기존 업무 상태·Revision·검증 Gate·승인 경계를 그대로 유지한다. 정상 답변 완료 후 사용자
입력을 기다리는 Lead도 자동 복구 대상이 아니다. 실패/불확실 결과를 DONE으로 바꾸지 않는다.

시스템 이벤트는 Workspace·Plugin·Agent·Session·Run·provider turn 및 원본 이벤트
ID/sequence에 결속한다. 성공 상태, 오류, 중단/취소 사유와 관측 시각을 보존한다.
오래된 Run의 지연 이벤트는 그 Run 이력만 갱신하며 현재 다른 Run을 덮어쓰지 못한다.
Codex app-server의 `turn/completed`는 최종 상태가 `completed`인 경우만 정상 완료다.
`failed`·`interrupted`도 종료 이벤트로 올 수 있으므로 이름만 보고 DONE으로 처리하지 않는다.
채택한 CLI JSONL 등 다른 인터페이스는 해당 버전의 실제 성공/실패 이벤트 계약을 확인한다.
위 상태는 Builder의 실행 상태 투영이며 Codex의 원시 상태 enum이 아니다. 특히
WAITING_CAPACITY를 Codex가 제공하는 고유 상태라고 주장하거나 실패 원본을 덮어쓰지 않는다.

## 3. 계정 전환 절차

1. 기존 Core 실행 admission에서 신규 AI 실행 배정을 일시 중지하고 전환 세대를 고정한다.
2. 기존 세션별 실제 Run/turn 상태, 완료 이벤트 cursor, Task·Checkpoint·Revision 및
   사용자/승인/의존성 대기를 읽는다. 전환 전 RUNNING 관측을 출처·버전과 함께 보존한다.
3. 기존 CLI 프로세스와 연결된 실행을 안전하게 정리하고 실제 종료를 확인한다. timeout이나
   프로세스 ID만으로 종료를 단정하지 않는다. 불확실하면 새 실행을 시작하지 않는다.
4. 허용된 범위에서 Core가 활성 인증 계정을 A에서 B로 변경한다. 실행 중 인증파일을
   덮어쓰거나 Builder/Agent에 인증정보를 노출하지 않는다.
5. B 인증 환경에서 기존 로컬 Thread ID로 `thread/resume`한다. Session ID와 Thread ID의
   기존 매핑을 보존한다. 호출 없는 복원이 실제 지원되는 경우에만 RESUME하며,
   그렇지 않으면 PREPARE까지만 수행한다.
6. 계정 전환/인증 문제로 중단된 미완료 Run만 자동 복구 후보로 선정한다.
7. WAKE 직전에 최신 완료·Run·Task·Revision·권한·종료·활성 Turn 유무를 다시 검증하고
   원자적으로 중복 실행을 차단한다. 적격 세션에만 `turn/start`의 `input: []`와
   실제 복구 관측의 `toolOutput`을 전달한다. continue 사용자 메시지를 보내지 않는다.
8. DONE·IDLE·사용자/승인/의존성 대기·완료/보관·사용자 중단 세션에는 새 AI 턴을 만들지
   않는다. 부모 복원이 부모 Wake를 뜻하지 않으며 모든 세션 일괄 Wake는 금지한다.

## 4. 자동 Wake의 필요조건과 경합

다음 조건을 **모두** 만족해야 한다. Agent의 자가 보고나 당시 CLI 생존으로 대체하지 않는다.

- 전환/Capacity 오류 전 실제 AI 작업이 RUNNING이었다.
- 그 Run이 계정 전환·인증 문제 또는 확인된 일시적 모델 Capacity 오류로 중단됐다는 실행 근거가 있다.
- 같은 Run/turn의 정상 완료 이벤트가 기록되지 않았다.
- 최신 Task·Checkpoint에 이어 수행할 미완료 작업이 있고, 사용자 결정·승인·의존성 대기가 아니다.
- 기존 턴의 종료와 활성 Turn 부재가 확인됐고, 프로세스 교체 시 기존 프로세스의 실제 종료도
  확인됐다. 현재 Revision·권한·위임·동시 실행 한도에서
  복구가 안전하다. 취소 불확실·외부 효과 미확인·이미 열린 후속 실행이 없다.

Lead가 답변 생성 중 중단됐다면 위 조건으로 복구할 수 있다. 답변을 마쳐 사용자 입력을
기다리면 새 턴을 만들지 않는다. 사용자 응답·의존성 해소·명시 재개는 각각 별도 이벤트로
Wake할 수 있으나 계정 전환/Capacity 자동 복구와 혼동하지 않는다.

정상 완료 직후 한도가 소진돼도 저장된 완료 이벤트가 있으면 해당 세션을 깨우지 않는다.
후보 선정 당시 RUNNING이었더라도 최종 재조회에서 DONE이면 복구를 취소한다.
완료와 전환/복구가 겹치면 기존 Run ID·원본 이벤트 ID·전환 세대·Revision/CAS 및
실행 requestId/lease로 하나의 복구만 claim한다. 오래된 세대는 새 세대에 실행을 배정하지
못한다. claim과 실제 전송 사이에도 완료/권한 변화가 우회되지 않는 기존 admission 경계가
필요하며, 여러 저장 key의 개별 CAS를 원자적이라고 주장하지 않는다.

완료 이벤트가 지연·누락됐으면 새 턴을 보류한다. 실제 CLI/턴·프로세스 종료, 마지막 실행
결과, 원본 Run/Event와 Task·Checkpoint·Git·Artifact 상태를 대조해 정상 종료/실제 중단/불확실을 판단한다.
exit 0이나 Checkpoint 하나만으로 정상 모델 완료를 만들지 않는다. 불확실성이 남으면
확인 필요와 원인·다음 조치로 보존하며 AI를 호출해 DONE 여부를 묻지 않는다.
전송 응답 유실은 기존 requestId와 provider Turn 조회로 확인하고 확인되지 않은 요청을 자동 재전송하지
않는다. 완료 이벤트/복구 이벤트 중복은 같은 Run과 세대에 중복 효과를 내지 않아야 한다.

## 5. PREPARE·RESUME·WAKE

| 동작 | 계약 |
| --- | --- |
| PREPARE | 기존 세션 식별자·로컬 기록·마지막 실행 상태·대기 사유와 전환 세대를 준비. 모델 요청 없음 |
| RESUME | 기존 Thread ID로 `thread/resume`하여 대화를 복원. 모델 호출이 없는 지원 방식만 사용 |
| WAKE | 같은 Thread에 `turn/start` + `input: []` + 실제 관측 `toolOutput`으로 새 AI 턴 시작. 별도 requestId·Run·Turn·lease·복구 근거 기록 |

실제 CLI의 resume이 자동 입력·goal continuation·모델 호출을 발생시키는지 해당 버전과
실행 경로에서 확인한다. 호출 없는 방식이 없거나 미검증이면 PREPARE까지만 하고
RESUME 성공/모델 호출 0회를 주장하지 않는다. 조회·등록·준비만으로 실행하지 않는다.
대량 복구 프롬프트나 새 대화 생성을 동일 세션 복원으로 표시하지 않는다.

`toolOutput`은 공식 스키마의 비어 있지 않은 `name`, 선택적 `namespace`, 문자열 또는
content item 배열인 `output`을 사용한다. `input`은 빈 배열이며 사용자 입력과 혼합하지
않는다. 실제 설치 버전의 스키마·기능 gate와 동작을 확인한 뒤 연결한다.
출력에는 시스템이 실제 확인한 Task·Checkpoint·중단 사유와 원본 이벤트/버전 참조만 넣는다.
새 사용자 지시·Main의 공식 설계 변경·사용자 승인·추가 권한으로 해석하지 않는다.

무메시지는 **추가 userMessage가 없다는 뜻**이다. 공식 인터페이스의 `functionCallOutput`
및 실행 이벤트는 기록·조회 가능하게 보존하며, 무기록 실행이나 숨겨진 승인을 뜻하지 않는다.
공식 서버는 활성 턴이 있으면 tool output을 그 턴에 큐잉할 수 있다. 복구 경로는 이를 이용해
살아 있는 턴에 출력을 밀어 넣지 않으며 admission 직전 활성 턴이 없음을 재검증한다.
정상적인 사용자/상위 Agent의 업무 메시지 경로는 유지한다. 미지원 시 continue나 비공식
내부 API로 자동 대체하지 않고 원인·지원 가능한 대안을 보고한다.

## 6. 모델 Capacity 자동 복구

- 원시 오류·실패 시각·Run/Turn·서버 재시도 지침을 보존한다. 모델 Capacity, 인증 오류,
  사용량 제한, 권한 오류를 별도 분류한다. HTTP 503이나 문자열 하나만으로 Capacity 또는
  계정 한도 소진을 확정하지 않는다. App Server ingress 과부하도 별도 원인이다.
- 기존 턴이 살아 있고 실제 `willRetry: true` 등 내부 재시도 근거가 있으면 Codex 내부
  재시도를 우선한다. 그동안 RUNNING을 유지하고 외부 Wake·새 Turn을 만들지 않는다.
- 기존 턴 종료 뒤 확인된 일시적 Capacity 문제이고 미완료 작업이 남으면 WAITING_CAPACITY로
  투영하고 기존 지속 Job/Run 재시도 기능에 예약한다. Capacity만으로 계정을 바꾸지 않는다.
- 서버가 실제 제공한 재시도 시각/간격을 우선하며 그렇지 않으면 백오프와 jitter를 적용한다.
  각 시도는 제한된 timeout·하나의 lease를 갖고 실패 원인·attempt·다음 시각을 기록한다.
  정상 재개까지 예약을 유지하되 밀집 무한 루프나 동시에 여러 재시도를 만들지 않는다.
- 매 시도 직전 §4의 최신 완료·Task·권한·활성 Turn·세대/CAS를 다시 검사한다. 요청 가능 상태가
  되면 §5와 같은 무메시지 Wake를 사용한다. 재개가 확인되면 대기 예약을 해제하고,
  정상 완료 뒤 예약·지연 이벤트가 새 턴을 생성하지 못하게 한다.
- 사용자 취소·중단, 권한 철회·만료, 사용자/승인/의존성 대기로 바뀌면 예약을 중단한다.
  영구 오류나 불확실 상태는 Capacity로 재포장하지 않고 원인·담당·복구 조건을 표시한다.
  재시작 시 원본 예약을 복구하며 이미 재개된 Run을 중복 실행하지 않는다.

이 절은 POLICY-EXEC-09의 Capacity 재시도 구체화다. 개별 시도의 실행 예산은 유지하고,
Capacity 대기 예약은 정상 재개 또는 위 중단 조건까지 보존한다. 장기 대기는 다음 시각·
최근 원인·누적 대기·기술 담당 조치를 관측하며 같은 알림을 반복하지 않는다.

## 7. Core·Builder 책임과 재사용

| 소유자 | 책임 |
| --- | --- |
| SPS Core | CLI 인증 프로필/공용 Pool·활성 계정, 승인된 CLI/Thread/Turn 실행과 프로세스 관측, 완료·중단 이벤트, Run Lease·중복 차단·권한·계정 전환·비밀 보호, 기존 Job 기반 기술 재시도 |
| SPS Builder | 기존 논리 Session Registry와 Thread 매핑, 마지막 AI Run/Capacity 대기와 Task 연결, 복구 후보 선정·실제 관측 구성·사용자 대기 제외, Revision/QA/Integration 및 복구 결과 연결 |

기존 Core Agent/Session/Run/Job/Event·실행 requestId·CAS·pool·권한·lease와 Builder
Task Packet/Checkpoint/Revision을 우선 재사용한다. 새 AI 관리 Agent, 별도 scheduler,
중복 세션 원장·완료 DB·승인 체계를 추가하지 않는다. Core에 Builder 역할명을 하드코딩하지
않는다. API 검사와 실제 CLI의 OS 접근 격리는 별개이며 기존 보호 실행 요구는 축소하지 않는다.

실제 계약에서 빠진 terminal turn 식별/성공 이벤트 저장·재조회·전환 세대/admission 결속은
Core의 범용 선행 기능으로, 업무 미완료/대기 판정과 해당 자동 Wake 정책은 Builder 기능으로
분리한다. 인터페이스 선언·observer probe·CAO 운영 성공을 제품 연결 증거로 쓰지 않는다.

## 8. 필수 실제 CLI 인수

기존 POLICY-EXEC-02/09/11/15/16의 상세 인수로 추적한다. 원문 AC 216개를 대체하거나
합격 수에 더하지 않는다. 아래 9개는 모두 **NOT_RUN**이다. 정상·경합·실패 fixture 통과와
실제 CLI 시험을 구분한다. 실제 시험 환경을 확보하지 못하면 해당 인수는
BLOCKED/NOT_RUN으로 남긴다.

| 번호 | 필수 실제 CLI 시나리오 | 필요한 결과 |
| --- | --- | --- |
| 1 | Worker 작업 중 한도 소진, 계정 전환 | 실제 중단 Worker만 무메시지 Wake; 다른 완료·대기 세션 새 턴 0 |
| 2 | Worker 정상 완료 직후 계정 전환 | 정상 완료 이벤트 보존; 새 턴 0 |
| 3 | Lead 사용자 답변 대기 중 전환 | 사용자 대기 보존; 새 턴 0 |
| 4 | Lead 답변 생성 중 전환 | 실제 중단·미완료·종료/권한 재확인 후에만 무메시지 Wake |
| 5 | CTO·Worker 여러 개 병렬 실행 중 전환 | 각 Run의 실제 중단 여부에 따라 선택 복구; DONE·IDLE 제외 |
| 6 | 완료 이벤트와 계정 전환 동시 발생 | 최신 DONE 우선, 원자적 claim·중복/지연 이벤트에서 중복 Wake 0 |
| 7 | 완료 이벤트 누락 | 실제 종료·결과·Task/Checkpoint 대조, 불확실 자동 Wake 0 |
| 8 | 프로세스 종료·재시작 | 동일 Session ID·외부 실행 상태/이벤트·전환 세대 보존, 이중 프로세스/Run 0 |
| 9 | A 인증으로 만든 로컬 세션을 B 인증으로 재개 | 로컬 탐색·Thread 복원·B 실제 응답·추가 userMessage 0·미완료 작업 복구를 각각 증명 |

이번 결정의 우선 종단 간 시험은 다음 A~D다. 위 인수를 상세화하며 별도 합격 수로 더하지
않는다. A~D는 모두 **NOT_RUN**이다.

| 시험 | 실제 절차와 인수 결과 |
| --- | --- |
| A: 계정 간 무메시지 Wake | A 인증 테스트 Thread에서 실제 미완료 Task/Checkpoint와 ID 저장 → A CLI 종료 확인 → B 인증 환경 → 같은 ID의 thread/resume → input: []와 실제 관측 toolOutput으로 turn/start → B 실제 응답과 기존 작업 연속성 확인. 사용자 메시지 추가 0 |
| B: 완료 세션 제외 | A Worker 정상 종료 이벤트 저장 → B 전환 → 동일 Thread/이력 보존과 새 Turn/복구 예약 0 확인 |
| C: 병렬 선택 복구 | Lead·CTO·Worker 동시 실행 → 일부 정상 완료/일부 실제 중단 → 전환 → 중단 미완료만 복구. 사용자 대기 Lead·완료 Worker의 새 Turn 0 확인 |
| D: Capacity 복구 | 재현 가능한 Capacity 오류 → 기존 턴 생존 시 내부 재시도/종료 시 백오프 예약 → 실제 정상 응답·기존 작업 재개 → 완료 후 예약 중단. 중복 Turn·파일 수정 0 및 취소·철회 시 예약 중단 확인 |

D의 제어된 오류 주입은 분류·경합 검사 증거일 뿐 실제 공급자 Capacity/실제 모델 복구 성공을
대체하지 않는다. 재현 가능한 실제 환경이 없으면 해당 단계는 BLOCKED/NOT_RUN으로 둔다.

증거는 실제 CLI/adapter 버전·환경, Workspace/Session/Run/turn·원본 이벤트 ID/sequence,
전환 세대와 전후 상태, 종료 확인, requestId 및 실제 toolOutput·새 Turn 생성/미생성을 연결한다.
계정은 비밀 없는 내부 프로필 식별자로, CLI 버전·OS·CODEX_HOME 경로·Thread ID·응답 상태는
실제 값으로 기록한다. 로컬 기록 탐색, Thread 복원, B 인증 모델 요청, userMessage 없는 새 Turn,
미완료 Task 복구는 **서로 다른 다섯 단계**로 판정한다. 한 단계 성공으로 나머지를 PASS하지 않는다.
비밀·사용자 원문을 공개하지 않는다. 마지막 시나리오에서 파일 존재나 같은 Session ID만으로
다른 계정의 모델 요청 성공을 증명하지 않는다. 실제 미지원은 합성 성공으로 대체하지 않는다.

## 9. 현재 반영 상태

- 설계 반영: 이 문서와 현행 제품 계약·실행 보강·설계 목차에 반영.
- 설치 계약 확인: Windows PATH CLI 0.144.1에는 toolOutput 필드가 없고 런타임이 미지의
  필드를 무시한다. Windows 앱 번들 0.166.0-alpha.5.1과 CAO WSL 고정 CLI 0.166.0에는
  stable 스키마/타입 파싱 지원을 확인했다. 유효 입력은 없는 테스트 Thread 오류까지 도달했고
  잘못된 필드 타입은 거부됐다. experimentalApi false/true 모두 확인했으나 모델 요청은 0회다.
  이는 실제 Thread 저장·복원·tool output 기록·queue·모델 응답·Task 복구 성공이 아니다.
  Host/Runner는 실제 선택된 실행파일·버전·계약을 확인해야 하며 단순 PATH 명령이나 미지 필드
  무시를 지원 근거로 삼지 않는다. 기존 설치를 자동 교체하거나 업데이트한 것은 아니다.
- 실제 실행 연결: **이 추가 결정의 제품 연결은 미검증**. 기존 Core/SDK 일부 Run 조회·취소·
  requestId와 Codex 종료 이벤트가 있다는 사실이 전체 요구 구현을 뜻하지 않는다.
- 현재 Core/SDK 정적 조사: 기존 session/request receipt·취소·lease·CAS와 백오프/jitter 예약
  기반은 있으나 공개 세션의 standalone toolOutput 입력·provider Thread/Turn의 지속 결속·
  완료 이벤트 cursor 재생·동일 Thread Capacity 복구가 연결되지 않았다. 기존 CLI/ACP의
  fresh-session fallback은 이 기능에서 동일 Thread 복구 증거로 쓸 수 없다. read-only
  App Server probe도 실행 엔진이 아니다. 필요한 확장은 Core의 범용 선행 기능으로 분리한다.
- 종단 간 인수: 기존 9개와 A~D 모두 **NOT_RUN**. 과거 CAO 수동 전환/continue는 이번 무메시지
  Wake와 Capacity 복구의 증거가 아니다. 완료 조건은 실제 A→B 무메시지 Wake와 Task 복구 성공이다.
- A→B 사전 확인: 지원 CLI는 확보했으나 안전하게 lease할 테스트 인증 환경 두 개는 미확보다.
  기존 활성 환경은 사용 중이고 다른 등록 환경은 비활성 상태다. 시험을 위해 생산 Pool을 바꾸거나
  기존 세션을 깨우거나 인증 원문을 읽기/복사하지 않았다. A 테스트 Thread 생성·B 복원·모델
  요청을 모두 아직 실행하지 않았으며 이를 실패 후 복구 성공으로 기록하지 않는다.
  기존 Pool에는 생산 후보에서 제외한 두 프로필을 시험에만 활성화/독점 lease하는 경계가 없다.
  전역 enabled 변경이나 요청별 후보 제한만으로 시험 격리를 주장하지 않는다. 기존 생산 실행을
  건드리지 않는 승인된 두 인증 환경이 확보돼야 실제 A→B 단계로 진행할 수 있다.
- 후속 우선순위: 최신 사용자 지시에 따라 설치 지원/실제 Core 계약 확인과 A→B 실증을 우선한다.
  미지원이면 비공식 API나 메시지 fallback으로 우회하지 않는다. 기존 WIP·원본 실패·기록은 보존한다.

참고한 공식 계약: [turn/start와 toolOutput](https://learn.chatgpt.com/docs/app-server#start-a-turn-turnstart),
[Codex app-server lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview),
[terminal 상태 확인](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server#using-codex-app-server).
thread 복원과 turn 시작은 별도 단계이며, 문서 계약과 현재 설치 CLI의 무호출 실증은 구분한다.
