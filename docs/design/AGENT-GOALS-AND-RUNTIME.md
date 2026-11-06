# Agent 장기목표와 실행 계약

2026-11-06 v16 실행 부속서. [제품 정본](CURRENT-PRODUCT-CONTRACT-2026-11-04.md)과 함께 적용한다.
이 문서는 목표 계약이다. 설치된 Codex에서 요청이 허용되거나 실제로 실행된다는 보증이 아니다.
원 결정과 시험 정의는 [Pool·선택적 Wake](01_Design/SPS_Builder_CLI_Pool_Completion_And_Selective_Wake_Addendum_2026-11-05.md),
[Goals·완료 후 대기](01_Design/SPS_Builder_Delegated_Goals_And_Completion_Idle_Addendum_2026-11-05.md),
[인계·복구](01_Design/SPS_Builder_Execution_Handoff_And_Recovery_Addendum_2026-11-05.md)에 보존한다.

## 1. 공용 Pool과 실행 소유권

- Core가 Host에서 관리하는 하나의 Builder 실행 인스턴스 공용 Pool에는 활성 CLI 계정이 하나다.
  같은 인스턴스의 모든 Workspace와 Lead·CTO·Worker·QA·Manager가 그 선택을 공유한다.
  계정 전환 세대·실행 중지·동시 점유는 해당 Pool의 단일 Core 소유자가 조정한다.
  여러 인스턴스가 같은 인증 자원을 참조하면 실제 자원의 동시 실행 한도를 Core에서 합산하고
  서로 독립된 활성 계정 선택기나 전환이 같은 자원을 경쟁하도록 두지 않는다.
  실제 다중 Host 조정 방식과 설치별 자원 식별 계약은 기술 검증 대상이다.
- Workspace·Plugin·Agent·Task별 권한과 데이터는 Pool 공유와 무관하게 분리한다.
  Session Registry의 논리 Session ID/기록과 공급자 Thread ID 연결을 계정 점유와 분리한다.
  계정은 Agent에 영구 배정하지 않는다. 실제 AI Run에만 활성 계정의 실행 lease를 사용하고
  완료·대기·중단 때 점유를 회수하되 기존 Session/Task/Goal/Checkpoint는 보존한다.
- Core가 인증과 적격 프로필을 관리하고 인증파일·Secret을 Builder나 Agent에 제공하지 않는다.
  Manager 프로필은 독립적이며 Lead의 공급자/모델은 초기 기본값만 재사용한다.
  공급자 제한이나 보호 장치를 우회하는 계정 순환을 설계하지 않는다.
- 여섯 Lead 논리 세션은 상주 CLI 프로세스 여섯 개가 아니다. CAO 운영 계정 전환,
  임시 CTO/Worker의 YOLO 및 모델 설정은 개발 도구의 관측이며 제품 실행 계약이 아니다.

## 2. 완료와 대기

| 상태 축 | 권위와 다음 동작 |
| --- | --- |
| Turn RUNNING / DONE / INTERRUPTED / WAITING_CAPACITY / IDLE | 실제 실행 이벤트와 프로세스·Turn 식별자. 정상 종료만 DONE. 오류/불명은 정상으로 승격하지 않는다. |
| Goal active / completed / 사용자 정지 등 | 공식 provider 상태를 보존하고 지원 버전의 wire 값을 해석한다. Goal 완료 시 연속 실행 중지, IDLE, 결과를 상위에 전달하고 새 정식 배정 대기. |
| Worker Task 제출 / Task 검증 | 제출은 원본 Commit·Artifact·증거 인계이며 독립 QA나 소비자 인수가 아니다. |
| CTO Workstream VERIFIED / 통합 | 승인 Revision·Gate·독립 QA를 검증한 기존 저장 경계만 VERIFIED를 발행한다. 저장된 WorkstreamVerified만 자동 Manager 통합을 깨운다. |

Agent의 자연어 DONE은 필요하지도 권위 있지도 않다. 완료 Goal을 검증용으로 다시 깨우지
않는다. 상위가 완료했으면 하위 결과는 기록만 한다. 사용자 답변·승인·의존성 대기는
실제 조건 해소 이벤트를 기다린다. 명시적 정지·취소·보관은 자동 회복 대상이 아니다.

## 3. 일반 세션: PREPARE, RESUME, WAKE

1. Pool이 신규 실행을 일시 중지한다. 전환 직전 실제 Run·Turn, Task 상태와 마지막
   정상 종료 이벤트를 고정하고 기존 프로세스의 안전한 종료를 확인한다.
2. 활성 계정과 전환 세대를 교체하되 로컬 Session/Thread 기록을 보존한다.
   계정 간 서버 소유권을 로컬 기록 읽기의 조건으로 추정하지 않는다.
3. PREPARE는 기록·정체성·업무 상태를 조회하고 복원 준비만 한다. RESUME은 같은
   Thread를 다시 여는 동작이다. 무호출 복원이 보장되지 않으면 PREPARE까지만 한다.
4. 자동 WAKE는 전환 전 실제 수행 중, 전환/인증으로 중단, 정상 완료 없음, 미완료
   업무와 기존 실행 종료 확인을 **모두** 만족하는 경우만 허용한다.
5. 최신 Task·Revision·권한·Turn·완료 상태, Run/Event/requestId·전환 세대·lease/CAS를
   최종 재검사한다. DONE이 뒤늦게 확인되면 새 턴을 만들지 않는다. 상태가 불명하면
   프로세스·Task·Checkpoint·Git·Artifact를 대조하고 자동 시작을 보류한다.
6. 검증된 설치 버전에서는 공식 `thread/resume` 뒤 `turn/start`에 `input: []`와
   실제 관측된 Task·Checkpoint·중단 사유의 `toolOutput`을 제공한다.
   새로운 사용자 메시지나 권한이 아니다. 임의의 `continue`·비공식 API fallback은
   사용하지 않으며 정상 사용자/상위 Agent의 업무 메시지는 그대로 유지한다.

## 4. CTO·Worker·QA Goal

- Lead→담당 CTO Workstream, CTO→직속 Worker Task 또는 QA 검증 배정을 허용한다.
  업무 원본은 Workstream Contract와 Task Packet, Goal은 기존 실행 상태다.
  별도 Goal DB·관리 Agent·실행 스케줄러를 만들지 않는다.
- 실제 상위 주체·대상·Workspace·승인 Revision과 범위를 서버와 Core 실행 경계에서 검증한다.
  하위→상위, 형제·타 Workspace, 자기 목표의 무단 확대를 금지한다. provider raw Goal
  도구를 우회 경로로 노출하지 않는다. 요청에 적힌 origin은 권한 증거가 아니다.
- 활성 미완료 Goal은 공식 연속 실행을 우선한다. 전환·Capacity 복구 역시 공식 Goal
  재개를 우선하며 일반 세션의 `toolOutput` Wake를 중복 적용하지 않는다.
  복원 자체가 자동 실행을 유발할 수 있으므로 실행 lease·중복 방지·권한 검사를 먼저
  적용한다. 재활성화가 실제 모델 실행을 이어가는지는 별도 실증한다. 완료·사용자 정지
  Goal을 다시 활성화하지 않는다. 실제 API에 없는 Goal ID는 발명하지 않는다.

## 5. Capacity와 중복 방지

일시 Capacity는 사용량 제한·인증 만료·권한 오류·의존 대기와 별개다.
기존 Turn이 살아 있으면 provider 내부 재시도를 우선한다. 종료된 미완료 작업만
WAITING_CAPACITY와 기존 Job을 사용한다. 서버 지침, 지수 백오프와 jitter, 승인된
자원·비용·시도 한계 및 장기 대기 관측을 적용한다. 동일 Run의 동시 복구는 금지하고
정상 완료·취소·철회에 따라 예약을 해제한다. Capacity만으로 계정을 전환하지 않는다.

## 6. 실제 확인과 출시 조건

| 대상 | 확인된 범위 | 제품 인수 전 필요한 증거 |
| --- | --- | --- |
| 일반 Wake | [공식 App Server](https://learn.chatgpt.com/docs/app-server#start-a-turn-turnstart)에 standalone tool output 경로. 보존된 생성 스키마: Windows PATH 0.144.1에는 해당 필드 없음, 앱 0.166.0-alpha.5.1 및 CAO WSL 0.166.0에는 있음. | 정확한 대상 설치에서 요청/응답 및 모델 턴, 추가 userMessage 0, 같은 Task 계속 수행, 완료·동시 전환·이벤트 누락에서 중복 0. |
| Goal | [공식 Goal 관리](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal)의 set/get/clear 및 보존 스키마. 앱 스키마의 정상 완료 wire 값은 `complete`다. | 상하위 배정/거부, 우회 도구 차단, 완료 후 IDLE, 계정 변경·재시작에서 저장 Goal과 자동 연속 실행, pause/cancel/철회·예산·중복 방지. |
| A→B 복원 | 임시 CAO에서 선택적 로컬 세션 이어가기 및 별도 입력 사례를 관측했다. Builder 무메시지/Goal 증거가 아니다. | 같은 로컬 Thread 발견, 복원, B 인증 모델 요청, 무메시지/Goal 방식으로 실제 미완료 작업 복구를 각각 기록. |
| Capacity | 설계 및 복구 조건만 확정. | 공급자 실제 Capacity 오류와 기존 턴 내부 재시도, 종료 후 예약, 안전한 한 번의 새 실행, 완료·취소·철회 이후 추가 실행 0. |

기존 9개 및 A~D 실제 CLI 시험과 POLICY-GOAL-01~12는
[인수 추적표](AC-TRACE-2026-11-04.md)에서 관리한다. 스키마 수락을 보호 실행,
실제 앱 연결, 인증 전환의 모델 응답이나 제품 인수로 승격하지 않는다.

임시 CAO의 현재 운영상 전환 감시는 30초 간격으로 관측하며 다른 소유 실행이
진행 중이면 전환을 보류한다. 선정된 세션을 대상으로 하는 운영 동작이며,
자동으로 모든 하위 세션을 선정하거나 복구한다는 뜻이 아니다. 제품의 중단 세션
선택, 무메시지 Wake 및 Goals 인수는 위 기준으로 별도 시험한다.
