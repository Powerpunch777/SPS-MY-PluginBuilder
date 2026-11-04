# SPS Plugin Builder — Integration Manager & Lead Integration Review 추가 설계
> 작성일: 2026-11-04  
> 상태: 사용자 제안에 따른 추가 설계 결정 및 기존 계약과의 정합화 초안  
> 적용: **최종 SPS Plugin Builder 제품**의 Lead/CTO/Worker/QA/설계 시각화/Graph/Revision/CSAS G5·G6·G7  
> 제외: Builder 개발을 위해 임시 사용 중인 CAO의 실행 조직 자체를 필수 제품 구조로 복제하지 않는다.  
> 출처: 기존 Builder v15, CSAS v0.8, Project Document Center v1.1 및 2026-11-04 사용자 추가 결정. 기존 GitHub 코드에 반영 완료되었다는 뜻이 아니다.
> 2026-11-05 확정 개정: [최종 검토·승인 페이지 추가안](SPS_Builder_Lead_Final_Review_Approval_Page_Addendum_2026-11-05.md)을 함께 적용한다. 기존 Integration Review의 내부 검토는 유지하고 사용자 승인 페이지를 제공한다. 새 Agent/일곱 번째 Lead 세션/중복 승인 저장소를 추가하지 않는다.

## 0. 사용자 제안과 설계 결론

1. CTO가 담당 Workstream 또는 위임된 기능을 **개발하고 담당 범위의 검증을 완료**한 경우, 기존 설계 시각화 체크포인트에 완료 근거를 제출한다.
2. 체크포인트 상태 변경의 **권위 있는 저장 이벤트**로 별도 `Integration Manager`를 비동기 wake한다. 단순 UI 클릭·LLM 출력 메시지 자체는 완료 사실이 아니다.
3. Integration Manager는 선행 Workstream·인터페이스·기준선 Revision 등 통합 가능 조건을 확인하고, 가능할 때 통합 브랜치에서 코드를 통합하여 통합 QA를 수행한다.
4. 통합에 방해되는 이슈가 발생하면 원인을 구분한다. 기술적·국소적인 오류는 담당 CTO가 복구한다. **설계 변경/결정권/CTO 간 상충/공통 인터페이스 정책** 문제는 새 `Lead Integration Review` 세션에 올린다.
5. 영향받은 작업은 통합 보류로 처리하고 관계 없는 Workstream은 계속 진행한다.
6. 전체 통합 및 E2E 검증 성공 후에는 Lead Main(또는 Lead의 공식 최종 인수 경로)로 결과를 반환하여 프로젝트 전체 설계 적합성, 산출물 완비 및 G7을 최종 확인하게 한다.
7. 기존 승인 명세를 새 역할이 독단으로 수정하지 않는다. 사용자가 결정해야 하는 것은 Lead의 기존 Question Discussion으로 상향한다.

## 1. 세션·역할

| 역할/논리 세션 | 소속 | 책임 | 실행 |
|---|---|---|---|
| Main | Lead | 고객 상담, 설계 Revision 정식 발행, 최종 인수/완료 판단 | 사용자 대화 |
| UI Design | Lead | UI 시안·UI Contract 제안/검토 | 사용자 대화 |
| Background | Lead | 기술·Reuse·Workstream 분할 준비 | 필요시 백그라운드 |
| Question Intake | Lead | CTO의 일반 설계 질문과 원문/승인 근거 조회 | 필요시 내부 |
| Question Discussion | Lead | 사용자 결정을 요구하는 미결정사항 협의 | 사용자 대화 |
| **Integration Review** | **Lead 6번째** | 교차 Workstream 문제·설계 충돌 검토 및 사용자용 `최종 검토·승인` 요청·응답 연결 | **내부 이벤트 처리 + 사용자 승인 페이지** |
| **Integration Manager** | **Lead 밖의 별도 통합 담당** | CTO 완료 이벤트 수집·조건부 통합·통합 CI/E2E 및 문제 분류 | **이벤트 수신 시 wake** |
| CTO | 프로젝트별 Workstream | 담당 Workstream의 개발/내부 통합/테스트·QA 책임 | 기존 독립 세션 |
| Worker/QA | CTO 관할 | 작업 실행/테스트 및 증거 생성 | 작업별 실행 |

- **Lead는 6개 논리 세션**, 별도로 **Integration Manager 1개 논리 세션**이다. 7개가 모두 사용자 채팅창으로 보이거나 항상 상주하는 CLI 프로세스라는 뜻이 아니다.
- Integration Manager와 Integration Review는 승인된 프로젝트 설계 Revision·Graph·정식 QA 증거·Task 결과 등을 **공통 프로젝트 저장소에서 필요한 범위만 조회**한다. 각각의 대화/작업 로그는 분리한다.
- Integration Manager는 고객 대화 전체에 대한 무제한 접근이나 사용자 결정·공식 설계 승인 권한을 갖지 않는다. 근거 필요시 Lead의 적법한 조회/질문 경로를 쓴다.
- 기존 CSAS는 새로운 AI 검수 직원이 아니라 **공통 검증/Gate**다. 통합 담당이 CSAS를 대체하는 것이 아니다.

## 2. 체크포인트 및 완료 조건: 반드시 두 차원의 상태로 관리

### 2.1 CTO 담당 범위 완료 상태

`NOT_STARTED → IN_PROGRESS → VERIFYING → VERIFIED`

`VERIFIED`(담당 기능/Workstream의 개발·검증 완료)로 변경하기 위한 **필수 조건**:

- 명시된 Workstream/Task 범위의 구현·내부 통합 완료
- 담당 CTO의 QA/TestPlan 실행 결과, 필요한 테스트 증거 및 빌드/커밋/산출물 식별자 확보
- 승인된 **Spec Revision, UI Contract/UI Revision, Workstream 계약**에 대한 정합성 확인
- CSAS G4/G6 관련 제출 검사에서 BLOCK/UNKNOWN 상태가 없고, 완료 표시에 필요한 근거가 충족됨
- 미완료·실패·생략 테스트 또는 미해결 필수 결정사항이 없는 상태. 예외/면제는 정식 위임 범위와 기록이 확인된 경우만 인정
- 담당 CTO가 저장된 검사 결과와 증거를 참조해 완료를 요청하고, **백엔드의 Gate가 원자적으로 허가**한 경우에만 `VERIFIED`가 됨.

**주의:** 위 조건에서의 `QA 완료`는 **CTO 담당 범위의 QA**다. 다른 CTO의 결과물이 아직 없는 상황에서 전체 통합·E2E QA까지 완료를 요구하면 순환 대기가 발생한다.

### 2.2 별도 통합 상태

Workstream별 통합 상태는 다음 상태를 별도로 가진다.

- `NOT_READY`: CTO 담당 검증 미완료
- `WAITING_DEPENDENCIES`: CTO 검증 완료, 선행 기능·버전 조건 대기
- `READY`: 현재 승인 Baseline·의존 관계상 통합 가능
- `INTEGRATING`: 통합 시도 중
- `INTEGRATION_HOLD`: 설계/계약/충돌 등의 원인으로 통합 보류
- `INTEGRATED`: 정해진 통합 빌드 및 통합 QA 기준 통과
- `REVALIDATION_REQUIRED`: 승인 Revision/코드/연결 인터페이스가 변경되어 기존 증거 재검증 필요

**중요한 구분:** `CTO=VERIFIED + Integration=INTEGRATION_HOLD`가 가능한 정상 상태다. 통합 담당이 단순히 통합을 보류했다는 이유로 CTO의 기존 QA 완료 사실을 삭제하거나 과거 검증 증거를 소급 변경하지 않는다.

통합 중 실제 CTO 산출물이 담당 계약에 불합격했다는 증거가 생기면, 이력은 보존하고 `REVALIDATION_REQUIRED`를 발행해 CTO에게 재검증을 요구한다. 체크포인트 UI는 `통합 보류`나 `재검증 필요`를 완료 표시와 함께 분명히 보여준다. 기존 기록을 조용히 `미완료`로 덮어쓰지 않는다.

## 3. 이벤트와 wake 정책

### 3.1 트리거

- CTO가 Graph/설계 시각화 체크포인트의 **권위 있는 저장 API**를 통해 `VERIFIED` 전환에 성공하면 `WorkstreamVerified` 이벤트 발행.
- 이벤트는 `projectId, workstreamId, verifiedRevision, baselineRevision, uiRevision, commitSha/artifactId, qaEvidenceRefs, checkpointId, eventId, occurredAt`의 핵심 메타데이터를 포함(실제 필드명은 기존 API에 맞춘다).
- UI상 완료 표시만 생성해 이벤트를 위조하지 못하도록 **Gate 성공 → 저장 → 이벤트 발행** 순서를 보장한다.
- 기존 설계의 Graph 전체 편집은 기존 권한 계약을 유지한다. CTO는 완료 증거 제출/상태 전이용 **제한 API**만 호출하고, Graph의 임의 구조나 승인 명세를 수정하지 못하게 한다.

### 3.2 안전한 전달

- 신뢰 가능한 작업 큐/기존 이벤트 저장소를 재사용해 이벤트를 지속 기록한다. 통합 담당이 오프라인이어도 완료 이벤트가 유실되지 않아야 한다.
- `eventId + workstreamId + verifiedRevision` 등을 통해 **중복/재전송 멱등성**을 보장한다.
- 여러 CTO가 동시에 완료되면 wake를 합치거나 묶어 처리하고, 프로젝트/통합 브랜치 단위로 실행 충돌이 없게 lock/lease를 사용한다.
- 통합 Manager 세션/프로세스는 필요시 wake해 실행하고, 유휴 시 종료할 수 있다. 반드시 지속적인 상주 LLM 호출을 유지할 필요는 없다.
- 작업 시작과 commit/merge 직전에 **현재 승인 Revision·게이트 상태를 다시 확인**하고 오래된 이벤트/검증 결과를 인수하지 않는다.

### 3.3 Lead wake 조건

- **하지 않음:** CTO의 정상 `VERIFIED` 이벤트마다 Lead Main을 wake하지 않음.
- **하지 않음:** 의존 기능을 기다리는 정상 상태마다 Lead Review를 wake하지 않음.
- **조건부:** 기술적 충돌 중 담당 CTO 권한 내 해결 가능한 문제는 해당 CTO에 반송(Lead 불필요).
- **조건부 wake:** 교차 Workstream 계약 충돌, 사용자 결정이 필요한 요구사항/행동 변화, 승인 명세와 구현 상충, 통합 전략 변경이 요구되는 문제는 Integration Review를 wake.
- **최종 wake:** 전체 통합 빌드·E2E/회귀 QA·Gate가 통과한 뒤 Lead Main을 wake해 최종 설계·인수 점검.
- **최종 승인 요청:** Main이 실제 Packet·승인 Revision·필수 QA 및 G7을 확인한 후보만 불변 참조로 발행하고, 기존 Integration Review의 사용자 승인 페이지에 게시한다. 화면 렌더링/AI 메시지는 승인이 아니다.

## 4. 통합 가능성 판단

Integration Manager는 새 완료 이벤트를 수신하면 아래를 확인한다.

1. `VERIFIED` Gate가 유효한가? 담당 CTO QA 증거, Commit/Artifact ID, 검증 대상 Revision 확인.
2. 각 Workstream이 참조하는 **승인 Design Baseline/제품·UI Revision**이 현재 통합 대상과 양립 가능한가?
3. Workstream 사이의 API·Schema·Interface/Capability 계약이 만족되는가?
4. Graph의 선행 의존성에 따라 통합에 필요한 구성요소가 모두 존재하는가? (불필요한 전역 대기 금지)
5. 동일 파일/모듈/환경에 대한 충돌·통합 브랜치 상태·CI 실행 자원·락을 확인했는가?
6. 통합할 작업 범위에 미승인 Change Request나 검증 미완료가 섞여 있지 않은가?

- 전체 프로젝트가 끝날 때까지 대기하는 것이 아니라, **부분 통합이 안전하고 가치 있는 단위**는 먼저 통합할 수 있다.
- `WAITING_DEPENDENCIES`는 오류가 아니며 리소스를 점유하지 않고 다음 관련 이벤트에서 재평가한다.
- 병렬 통합은 통합 영역·브랜치·데이터 경합을 통제하고, 검증된 스냅샷을 무작위로 섞지 않는다.
- Git 작업은 보호된 통합 후보 브랜치/작업공간에서 실시하고, CI·QA 완료 전에는 보호된 기준 브랜치에 직접 병합하지 않는다.

## 5. 통합 오류의 분류 및 처리

| 상황 | 처리 주체 | 조치 |
|---|---|---|
| 정상 선행 의존성 대기 | Integration Manager | `WAITING_DEPENDENCIES`, wake 없이 대기 |
| 승인 계약 내 해결 가능한 merge/build/test 오류 | 담당 CTO 및 Integration Manager | 통합 보류·수정 요청·재검증 |
| 두 CTO 작업의 API·Schema 충돌 | Integration Manager → Lead Integration Review (필요시) | 원인·영향·대안 첨부 후 검토. 결정권 안에서 정리되면 담당 CTO 수정 |
| 설계상 모순/누락·미승인 사용자 동작 | Lead Integration Review → Question Intake/Discussion 또는 Main | 원본 근거 조회, 사용자 결정 시 승인 Revision 갱신 |
| 새로운 계약 범위·일정·비용·보안·납품 영향 | Lead Integration Review → 사용자 | 정식 Change Request/결정 필요 |
| 승인 Revision 변경·기존 QA 증거 무효 | Integration Manager + CTO | 영향받은 범위에 한해 `REVALIDATION_REQUIRED`, CTO 재검증 |
| 검사 시스템 장애 또는 근거 부족 | Integration Manager | `UNKNOWN`으로 보류, 자동 합격·우회 불가 |
| 전체 통합·E2E 검증 완료 | Integration Manager → Lead Main | 최종 인수 패킷 제출 후 Lead의 G7 확인 |

- 통합 담당은 미승인 설계 변경을 직접 확정할 권한이 없다.
- Lead Integration Review는 기존 원본/계약으로 해결 가능한 문제는 처리하고, 사용자 결정이 필요한 것은 Question Discussion으로 보낸다.
- 이미 해결된 문제나 명확한 기술적 실패를 전부 Lead에게 보내지 않는다.
- 이슈가 통합 진척을 막는 경우에는 해당 노드에 `INTEGRATION_HOLD` 사유와 blocker를 연결하고, 관련 없는 영역의 진행은 유지한다.

## 6. 설계 시각화 UI 및 Project Document Center 연동

### 6.1 체크포인트 정보

- CTO 개발 상태와 통합 상태를 **별도 축**으로 표시한다.
- CTO 완료 표시에는 검증 완료 날짜, 커밋/아티팩트, 테스트·QA 결과, 승인 Revision 근거 링크가 있다.
- 통합 보류 표시에는 원인·담당자·선행 의존성·Lead Review 케이스·다음 조치가 표시된다.
- 통합 완료에는 통합 빌드 ID, 통합 테스트 근거, 회귀 검증 결과가 연결된다.
- CTO가 완료 신호를 전송하는 UI 또는 API 경로는 기존 CTO 권한 계약과 일치해야 한다.

### 6.2 문서 센터 산출물

- Workstream 완료 보고/검증 증거
- Integration Queue 및 통합 시도·결과
- Integration Blocker/Review Decision
- 통합 QA 및 E2E 결과
- 전체 설계 대조 보고서 및 Final Integration Packet
- 최신성 상태·Revision 변경 이력

정식 데이터/Graph/QA 원본을 문서 센터에서 읽기 쉬운 뷰로 노출하며, 통합 담당이 별도의 중복 문서/설계 원본을 임의 생성하지 않는다.

## 7. Lead에게 최종 반환하는 패킷

Integration Manager는 전체 요구된 Workstream의 통합 성공과 정의된 통합 QA/E2E/CSAS G6 게이트를 확인하면 **Final Integration Packet**을 발행한다.

최소 포함 항목:
- 프로젝트/승인 Design Baseline 및 UI/검증 기준 Revision
- 포함된 Workstream·Task와 각 Commit/Artifact/PR의 식별자
- 통합 대상 브랜치/빌드 해시, CI 결과
- 기능·인터페이스·UI Contract와의 대응 관계
- E2E/회귀 테스트 및 QA 증거, 미검증 범위 명시
- 해결된 통합 이슈와 남은 제한사항
- 납품 산출물 후보 목록 및 초안 문서 참조
- CSAS G6의 상태 및 별도 G7 점검 필요사항

Lead Main은 전체 제품의 승인 설계·QA 증거·산출물과 패킷 및 G7을 재확인한다. 미완료 또는 계약 변경 사유가 있으면 관련 작업으로 환류한다. 적격 후보만 납품물 목록/파일·문서 해시/설치·사용법·제한사항의 불변 스냅샷 참조로 확정 요청을 만들고, Integration Review의 **최종 검토·승인 페이지**에 게시한다. 실제 권한 있는 사용자의 승인·수정 요청·보류를 서버에서 처리하고 필수 QA/G6/G7 미통과나 stale 요청은 승인해도 확정하지 않는다. 기존 Revision/문서센터/감사 경로를 재사용하며 변경본은 새 후보로 재승인하고 옛 이력은 보존한다. 고객 전달/계약·결제 확정·외부 배포는 사용자 책임이며 통합 완료·패키지 버전 확정과 자동으로 동일시하지 않는다.

## 8. 추가 인수 기준 초안

- `AC-INT-01`: CTO가 담당 계약의 필수 QA 증거를 제출하지 않으면 `VERIFIED` 체크포인트 상태로 전환할 수 없다.
- `AC-INT-02`: `VERIFIED` 상태 변경 성공 이벤트가 Integration Manager에 지속 기록되고, 오프라인/재시작 후에도 복구된다.
- `AC-INT-03`: 중복 완료 이벤트나 재전송은 동일 Workstream/Revision의 통합을 중복 실행하지 않는다.
- `AC-INT-04`: CTO 완료 이벤트만으로 Lead Main이 wake되지 않는다.
- `AC-INT-05`: 선행 의존성이 충족되지 않으면 무한 대기/자원 점유 대신 `WAITING_DEPENDENCIES`로 처리된다.
- `AC-INT-06`: 준비된 일부 Workstream은 다른 무관 Workstream 완료를 기다리지 않고 통합 가능성을 검토한다.
- `AC-INT-07`: 통합 대상 Revision이 변경되거나 QA 증거가 무효화되면 오래된 완료 신호를 그대로 인수하지 않는다.
- `AC-INT-08`: CTO의 검증 완료와 통합 보류를 별도 상태로 표시하며, 기존 완료/QA 이력을 무단 삭제하지 않는다.
- `AC-INT-09`: 기술적 범위 내 문제는 CTO에게 환류하고, 제품·설계·교차 Workstream 계약 문제에 한해 Lead Integration Review를 wake한다.
- `AC-INT-10`: 사용자 결정이 필요한 문제는 기존 Question Discussion과 공식 Revision/Change Request 경로로 이동한다.
- `AC-INT-11`: 실제 통합/병합은 격리된 브랜치 또는 동등 작업공간에서 수행하고, 필수 CI/QA 통과 전 기준 브랜치에 직접 반영하지 않는다.
- `AC-INT-12`: 통합 테스트 실패/검증 시스템 장애 또는 `UNKNOWN` 상태를 성공으로 취급하지 않는다.
- `AC-INT-13`: 전체 통합 및 E2E QA 통과 시 Final Integration Packet이 생성되고 Lead Main의 최종 점검이 호출된다.
- `AC-INT-14`: Lead 최종 점검·사용자 납품 확인·외부 고객 전달을 통합 완료와 동일한 단일 상태로 합치지 않는다.
- `AC-INT-15`: Integration Manager/Lead Integration Review는 별도 논리 세션으로 동작하되, 승인된 명세의 불법 수정이나 Core/SDK 권한 경계 우회가 불가능하다.
- `AC-INT-16`: 완료·통합 보류·Review·결정·재개·최종 반환의 모든 이벤트가 작업/Revision/원문 증거와 연결되어 감사 가능하다.

## 9. CAO Lead 인계 지시

- 본 설계는 기존 Lead 5개 논리 세션을 **Lead 6개**로 확장하고, **별도의 Integration Manager 논리 세션 1개**를 추가한다.
- 기존 CTO `1개 세션/Workstream`, Worker/QA 실행별 세션, 사용자 미결정사항 처리, 공통 Revision, CSAS Gate 및 UI 계약은 유지한다.
- 기존 설계 시각화의 상태 업데이트를 **서버가 검증한 완료 이벤트**로 만들고 Integration Manager가 이를 받아 비동기 wake하도록 한다. 비동기 큐/세션 스케줄러/프로세스 복구는 기존 Core/SDK/Builder 기능을 우선 재사용한다.
- `CTO VERIFIED`와 `INTEGRATION_HOLD/INTEGRATED`를 별도의 상태 축으로 모델링한다.
- Merge/CI/기술 문제는 해당 CTO로 환류하고, 정책·설계·교차 CTO 계약 문제만 Lead Integration Review를 깨운다.
- 통합 E2E QA 후에만 Final Integration Packet을 Lead Main에 반환하고 최종 제품 검수/G7을 수행한다.
- 기존 v15, CSAS v0.8, 최신 통합 제품 계약, Project Document Center v1.1, Core/SDK/Primary/Workspace/권한 계약과 충돌 여부를 먼저 점검해 **최신 정식 설계**에 통합한다.
- 문서/AC 통합, 코드 반영, 실제 테스트 통과를 각각 분리해 보고한다. 문서 승인만으로 구현 완료라고 주장하지 않는다.

## 10. 구현 전 확인할 기술 사항

- 설계 시각화 체크포인트의 실제 데이터 소유자 및 CTO 상태 갱신 API
- 이벤트 큐 및 Workstream Verified 상태 전이를 원자적으로 보장하는 저장 경로
- 통합 시점의 branch/worktree 권한, CI Runner, 병합 권한
- 기존 Graph의 의존성/기준선/QA 증거 검증 방법
- 서로 다른 Workstream의 병렬 통합 처리와 충돌 방지
- Lead Integration Review와 기존 Intake/Discussion 간 중복 없는 라우팅
- Reviewer/Integration Manager의 데이터 접근 범위 및 Workspace 격리

---
**변경 이력:** 2026-11-04 — CTO의 검증 완료 체크포인트 기반 wake, Integration Manager/Lead Integration Review 2개 논리 세션 추가, 기술·정책 이슈 분리, 완료/통합 상태 분리, Final Integration Packet 및 AC-INT-01~16 추가.
2026-11-05 — 기존 Integration Review에 사용자용 최종 검토·승인 페이지 연결, Main G7 적격 후보의 불변 요청·사용자 전용 조치·기존 문서/Revision 재사용 및 변경본 재승인 경계 명시. AC-APP-01~14는 별도 추가안과 통합 추적표로 관리한다.
