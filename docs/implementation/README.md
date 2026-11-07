# 구현 기록

현행 구현 기준은 [v16 정본](../design/CURRENT-PRODUCT-CONTRACT-2026-11-04.md)과
[마스터 인덱스](../design/README.md), 확인된 증거는 [AC 추적표](../design/AC-TRACE-2026-11-04.md)다.
아래의 날짜가 붙은 계획·검사 결과는 당시 구현과 범위를 보존하는 기록이다.

## 2026-11-07 연결 현황

| 기능 | 현재 구현과 검증 경계 |
| --- | --- |
| 상품 선택 | 공식 16개 상품·5개 부가 서비스, 독립 분류 축, 사용자 CAS 초안 저장과 화면 연결. 로컬 독립 QA·데스크톱/모바일 검사 완료. 승인 명세·실제 빌드·납품 완료는 아님. |
| 상담 분석 | 수집은 AI를 실행하지 않음. 명시 분석 action이 원문 경계·해시를 고정하고 Main에 한 번 전달. 시스템 분석 요청은 사용자 원문·승인 근거에서 제외. 응답 유실·재시작·중복 요청의 로컬 회귀와 독립 QA 완료. |
| Lead 6세션 | 여섯 독립 Session ID와 채널별 도구 정책, Main 공식 발행 제한, Lead 영역 탐색 연결. 격리된 소스 Desktop/Host에서 준비·재확인·재시작 뒤 동일 6개 ID와 Run 미생성을 확인. Core가 반환한 실패 코드·메시지는 기존 대화 기록에 크기를 제한해 보존하고 화면에는 시스템 메시지로 표시하며 자동 재전송하지 않음. 모델 실행 실패 시 논리 세션 등록까지 삭제되던 경로의 수정과 실제 임시 Host의 등록·Run 연결 보존을 확인함. 시험본 MCP 실행 파일 누락을 해소한 뒤 실제 Main AI가 도구로 설계 초안을 한 번 저장했고 Host 재시작 후 같은 초안을 확인함. 후속 첫 검토의 도구 호출은 실패했으며 원본 실패를 보존함. 다음 시험은 실제 사용량 제한으로 종료되어 D3 승인·발행·조회 전체 AI 흐름과 계정 전환은 미검증. |
| 기준선 문서 | Main 발행 후 결정적 본문·해시·source pin을 기존 Revision journal에 저장하고 문서센터에서 조회. stale/unavailable, 별도 journal 실패와 명시 재생을 구분. 전체 납품 inventory와 독립 승인 증거는 아님. |
| 문서센터 | 현재 상담 원문·설계·기술 선정·Workstream 등 실제 연결 자료를 기존 화면에 투영. 제목·본문 검색, 분류·유형·승인·최신성·연관 ID 필터와 기록 시각 정렬을 연결. 미확인 상태를 보존하며 전체 Artifact 목록의 완전성은 주장하지 않음. |
| D3 | 첫 설계의 Main 제안과 인증 사용자 검토를 분리함. 첫 Baseline은 정확한 초안·원문 핀·규칙 팩을 담은 승인 Revision과 해시를 같은 발행에 고정하며, 일반 대화만으로 발행할 수 없음. 기존 검토 묶음에 선택적인 정적 설계 모델을 함께 승인하며, 등록된 D3 조회는 원문 AC 인용·사실·시나리오·항목별 결정과 정확한 요구·규칙 관계를 다시 검증하고 기존 유한 검사기를 실행함. 응답은 승인 Revision과 모델 해시를 표시하며 caller 입력으로 승인 모델을 교체할 수 없음. 모델 없는 과거 승인, 누락된 검사·실행·QA 증거는 계속 `UNKNOWN`. 후속 규칙팩 제안은 같은 승인·원문 핀을 검증하지만 후속 변경의 모델 승인·발행 경로는 미완료. codec·등록 handler의 fixture 독립 QA와 검토 화면의 데스크톱/모바일 검사는 통과했으며, 실제 Host·AI 승인 흐름이나 CTO VERIFIED의 근거는 아님. |
| UI Contract | 정확한 HTML과 시안·사용자 승인·Main 공식 발행을 연결. 접수 미확인 시 같은 요청 ID를 조회하고 이미 시도한 실행을 재전송하지 않음. 데스크톱/모바일 미리보기 통과. 자동 알림 복구에는 동일 Workspace Worker 경로가 필요하며 실제 AI 승인 흐름은 미검증. |
| G5 변경 영향 | 설계 시각화의 인증 사용자와 Main·Integration Review 도구에서 기존 Workspace 저널의 정확한 게시 Baseline 및 공식 UI 쌍을 읽기 전용으로 비교. 기존 `builder.read-change-impact`는 생략 기본값에서 기존 비교 결과를 유지하고, 선택적 `projection: "revalidation"`은 명시된 과거 G5·Workstream·Task 게시 쌍의 후보와 현재 지시사항을 투영함. CTO 준비 receipt는 readiness 참고일 뿐 G5 ACK가 아니며, 실행·독립 QA 증거와 불완전 inventory는 계속 `UNKNOWN`; 조회는 재승인·dispatch·실행을 허가하지 않음. 실제 자동 실행·승인 경로와 전체 원본 inventory는 미연결. 사용자 화면은 게시 Baseline과 그에 연결된 승인 UI를 명시 선택하며, 이전·신규 순서와 늦은 응답을 검사함. 격리된 소스 Desktop/Host에서 인증 사용자 조회·Workspace별 빈 목록·다른 Workspace 접근 거부를 확인했으며 실제 승인 쌍 생성이나 AI 실행 검증은 아님. 최근 이력 범위·누락된 승인 연결을 구분하고 현재 쌍을 자동 추정하지 않음. 요구·UI·Graph 후보 및 확인 범위를 구분. 기술·Workstream·Task의 실제 원본 쌍도 부분 범위이며, 일정·상품 및 전체 영향은 미확인. ACK·영향 범위 재승인과 실행 Gate는 별도 연결 필요. |
| CTO 프로필 | 지원 SDK/Host에서는 동일 CTO ID를 같은 plugin-owned Agent 및 Session ID로 준비함. 신규 프로필 요청은 현재 Lead에서 확인된 실행 어댑터만 초기 선호값으로 전달하며, 관측 불가 시 생성하지 않음. 이 연결은 fixture 독립 QA 완료. 등록은 Run을 시작하지 않으며 비활성·소유권 변경을 관측하면 전송을 차단함. 후보 공개 SDK의 범용 API를 사용한 별도 no-AI 플러그인으로 실제 소스 Host에서 전용 프로필 2개·세션·재시작·Workspace 분리와 Run 0개를 확인. 현재 고정 SDK의 논리 세션은 독립 Agent가 아니며, Builder Main 도구·동시 실행·전송 경쟁의 Core admission은 별도 미검증. |
| Task Worker·QA | 새 CTO 실행에 준비·조회·명시 dispatch를 등록하며 과거 실행의 권한 목록은 확대하지 않음. 정확한 현재 Workstream·Task Packet revision·출처·의존 핀과 역할별 owned Agent/keyed session을 확인함. 별도 Core Project가 없는 Workspace도 준비하며, 결정적 request ID와 실제 활성 Run을 확인한 Worker/QA만 전용 파일 도구를 사용함. Worker 구현 경로와 QA 테스트/설정 경로를 분리하고 취소·출처 변경·다른 요청의 Run 재사용을 차단함. 지원 SDK에는 사용자가 설정하는 `project-source` 폴더 선언을 제공하며 경로를 추정하지 않음. 현행 고정 SDK의 미지원 API는 대체 실행 없이 종료함. 후보 SDK/고정 SDK의 fixture 회귀·타입 검사는 통과했으나 실제 Host 파일 작업·AI Worker 작성·Git 제출·보호 테스트·독립 QA·결과 인수는 미완료. Source match와 파일 I/O 간 경합은 별도 Core 결속 API가 필요한 남은 의존성임. |
| Gate producer/consumer | 현재 Baseline·승인된 D3 Coverage·전체 개발 Task와 독립 QA 보고/완료 Run을 읽는 CTO 도구 `builder.verify-workstream` 및 기존 CAS/이벤트 Job 발행을 등록함. 정확한 현재 증거를 다시 읽는 별도 Manager dispatch와 인수 기록도 연결함. 등록 handler의 독립 양성·변경 거부 검사는 fixture이며 실제 AI VERIFIED나 설치본 검증이 아님. `currentGuarded`는 원자적 시점 조회이지 실행 lease가 아니며 dispatch와 Git 효과에서 현재 역할·등록·원본 guard를 다시 검증함. 누락된 Coverage·실행·QA 증거는 계속 `UNKNOWN`. |
| 조건부 Revision 발행 | 기존 불변 entry·CAS head 저널의 `publishGuarded`는 지원 SDK/Host에서만 원문 포인터 조건과 head를 함께 비교하며, 충돌·누락된 조건·응답 유실 뒤 staging 기록을 보존함. 별도 선택 기능 `publishGuardedWithJobWakeV1`은 같은 저장과 작업 알림을 명시적 원자 API로 요청함. 기존 API로 대체하거나 불확실한 요청을 자동 재시도하지 않으며 고정 SDK에서 미지원이면 state 접근 전에 멈춤. 저널 fixture 회귀는 통과했으나 실제 VERIFIED·최종 승인 writer 연결은 미완료. 후보 SDK/Host에서 확인한 원자 저장·작업 등록은 실제 Builder 자동 통합의 증거가 아님. |
| Manager 설정 | 시스템 화면에서 Lead와 분리된 Agent를 인증 사용자 action으로 선택·준비함. 같은 Workspace에서만 CAS로 설정하고, 현재 Lead와 같은 Agent는 거부함. Agent별 기존 Core 세션을 재사용하며 설정 변경은 과거 세션을 삭제하지 않음. 격리된 소스 Desktop/Host에서 사용자 선택, 독립 세션 준비·재확인·재시작, 다른 Workspace 및 Lead 선택 거부, Run 0개를 확인함. 후보 공개 SDK와 소스 Host를 쓰는 별도 no-AI 플러그인에서는 같은 생산자의 신규 기본 프로필 생성·독립 세션·재시작·Workspace 분리·사용자 설정 및 pause 보존도 확인함. 이는 실제 Builder UI의 신규 자동 생성 검증이 아니며, 현행 고정 SDK에서는 신규 자동 생성이 미지원. 준비는 실행 권한이나 통합 완료가 아님. |
| Manager 자동 통합 / Final Packet | 현재 검증 이벤트의 Workspace Job은 별도 owned Manager의 정확한 요청/Run 인수를 기록함. Main의 Baseline/UI·Source·후보 브랜치 계획 아래 실제 QA Commit/Tree와 영속 예약을 Core의 guarded Git 효과에 전달하는 도구를 등록함. 등록 경로의 독립 테스트는 DTO fixture이고 실제 Core의 Git CAS 검사는 별도 증거임. 정상 의존 대기는 기술 오류와 구분하며 응답 유실은 같은 예약으로만 조정함. Git 성공은 CI/E2E 성공이 아니며 후속 실행은 아직 미연결. 최종 검토 페이지·Main G7·Integration Review 요청·인증 사용자 결정은 등록했지만 현재 패킷/원문 reader와 원자 승인 writer가 미연결이므로 실제 납품 확정 불가. |
| Reuse | Background가 기존 사용자 조사 원문의 정확한 행·해시에서 후보를 기록하고 Main/Background와 문서센터가 같은 저널을 조회함. 원문의 CRLF를 보존하며 Lead 원문 16 KiB와 저장소 인용문 32 KiB 한도를 구분함. 로컬 등록 handler·문서 검사 및 실제 소스 Host에서 도구 등록·Workspace별 빈 조회·실행 사칭 거부를 확인. 실제 AI 조사·자산별 권리·호환성은 미검증이며 미확인 후보의 재사용은 차단 상태. |

### 2026-11-07 Task 인수·보호 QA 후속 연결

- `f0aa9b0`과 `68ab18c`는 Worker의 정확한 제출 Commit/Tree를 현재 Task에서 찾고,
  해당 CTO가 받은 사실을 불변 인수 기록으로 남긴다. 인수는 현재 branch tip이나 QA 합격이 아니다.
- `d956754`·`ce65860`·`c737c09`는 현재 독립 QA Worker의 실제 dispatch Run, 개발 Task 의존 핀,
  인수 기록, Host Source/branch proof와 승인된 테스트 계획을 결합한다. 요청 ID와 subject는
  이 원본 핀에서 결정하며 임의 대체하지 않는다. 과거 Task-to-Run 참조는 기존 Revision
  journal에 보존하고, Core가 실행 상태의 원본이다. QA 대화가 끝나도 CTO의 읽기 전용
  조회는 가능하며 새 AI 실행을 만들지 않는다. 변경된 Task/소스의 결과는 이력으로 남긴다.
- 후보 SDK/Host의 실제 Worker subprocess와 임시 DB/Git에서 메타데이터만으로 실행 요청,
  같은 요청의 단일 기록, 철회·다른 Workspace·소스 핀 불일치 거부를 확인했다. 별도의 격리
  시험은 서명된 요청과 실제 보호 실행의 완료·종료 확인까지 연결했다. 이 두 증거를 합쳐
  실제 Builder의 AI QA 또는 두 CTO 종단 간 인수가 완료됐다고 주장하지 않는다.
- 보호 실행의 `succeeded`는 기술 실행 결과다. 등록된 QA 보고 경로는 개발 Task의 인수 조건,
  QA Task의 인수 조건과 테스트 계획 기준을 모두 평가하고, 정확한 Core 완료 receipt와
  독립 QA 작성자를 고정한다. 실패·미검사 항목은 합격으로 바꾸지 않는다. 현재 이 보고
  경로의 독립 fixture QA는 작성 권한·정확한 기준·Task/등록 변경 중 CAS 거부를 확인했다.
  실제 Core 영수증을 받는 통합 QA와 실제 AI QA 수행은 별도 검증 대상이다.
- `f587dcb`는 같은 실행 이력에서 QA 작성 판정, Core 영수증 일치 여부와 작성자 Run의
  종료 상태를 각각 보여 준다. 조회는 과거 결과를 현재 합격으로 바꾸거나 AI를 깨우지 않는다.
- 현재 CTO의 `builder.verify-workstream` 연결은 기존 Baseline·원문 검증·D3 Coverage,
  전체 개발 Task와 정확한 QA 보고서/Run reference, Core 기술 영수증을 서버에서 읽는다.
  Core가 작성한 QA 판정이나 빌드 Artifact를 가정하지 않는다. QA 작성자 Run이 정상
  종료되지 않았거나 최신 보고서·소스가 달라지면 과거 합격으로 대체하지 않는다.
  검증 발행은 기존 원자 CAS/이벤트 Job을 사용하며 역할·등록·각 journal head를 함께
  고정한다. 해당 도구와 Workspace 이벤트 Job을 등록했으며 독립 등록 handler의 양성
  경로를 검사했다. Host/Core 상태와 AI Run 응답은 fixture인 검사와 실제 실행을 구분한다.
- 이벤트 소비는 현재 검증 기록을 다시 읽고 기존 인수 원장에 보존한다. 별도 Manager의
  제한된 실행 요청과 Git 효과 경로를 연결했다. 정상 의존성 대기만 명시적으로 인수하며
  미확인 권위·실행 오류는 성공으로 바꾸지 않는다. Git 이후 자동 CI·E2E·Final Packet 및
  사용자 최종 확정은 미완료다.
- 제품 SDK pin은 변경하지 않았다. 후보 API의 존재, 실제 실행 연결, fixture 판정,
  설치된 앱/AI 검증을 구분하며 미지원 Host에서 대체 실행하거나 PASS를 만들지 않는다.
- `7d0c745`의 정확한 소스와 고정 SDK 의존성을 쓰는 별도 사본에서 빌드·타입 검사 및
  자동 테스트 939개가 통과했다. 이는 실제 Core·AI의 전체 Workstream VERIFIED 발행이나
  Manager 자동 통합 인수가 아니며, 해당 독립 연결 시험은 별도로 진행한다.
- 등록된 Builder 제출/CTO 인수/QA 요청과 후보 SDK Worker IPC가 실제 임시 Core DB의
  보호 실행 접수까지 연결됐다. 같은 요청은 `queued` 기록 하나를 재사용했다. 이 시험의
  Git 제출 응답과 Node는 fixture였으며 실제 Git 생산자 연결 시험은 별도로 진행한다.
- Manager의 별도 제한 도구 정책, Main의 현재 Baseline/UI·Source·후보 브랜치 계획,
  현재 검증 이벤트에서만 찾는 Task Commit/Tree와 예약된 Git 효과를 연결했다.
  실제 Git에서는 후보 ref 생성·경합·재생·철회·symbolic ref 거부를 검사했다. 보호된 기준
  브랜치를 수정하지 않으며 Git 성공을 CI/E2E 또는 전체 통합 완료로 표시하지 않는다.
- 새 Main 도구는 후보 SDK의 64개 제한 정책 지원 표시가 있을 때만 포함한다. 고정 SDK는
  기존 32개 Main 정책을 유지하고 아직 새 통합 계획을 AI 도구로 발행할 수 없다.
  과거 대화 정책은 원문 그대로 읽고 무음으로 권한을 확장하지 않는다. SDK pin·설치본은
  변경하지 않았다. 후보 소스의 통합 도구가 실제 배포됐다는 의미는 아니다.
- `aea05b7`의 정확한 소스는 고정 SDK 사본에서 빌드·타입 검사·947개 자동 테스트를
  통과했다. 후보 SDK `46ae9e9`에서도 같은 소스의 빌드와 947개 테스트가 통과했으며,
  후보 SDK의 엄격한 owned-result union 타입 진단은 후속 discriminant 수정 사본에서
  타입 검사 통과를 확인했다. 원래 실패를 보존하며 두 소스 상태를 같은 증거로 섞지 않는다.
- 현재 Core 보호 테스트 승인은 subject와 정확한 Commit/Tree에 고정된다. 새 통합 Commit의
  CI를 사전 위임으로 자동 실행하는 범용 승인 템플릿 생산자는 아직 없으며, 기존
  메타데이터 enqueue를 그 기능으로 주장하지 않는다. 승인·실행 선행 계약과 실제 CI 연결을
  해소하기 전까지 통합 검증은 `not-executed`로 남는다.
- `6d062c7`·`e81cf07`의 독립 등록 handler 검사는 Manager 요청/인수와 정확한 QA
  보고서에 고정된 Git DTO, 응답 유실 뒤 같은 예약 재조정, 기록된 결과의 Git 재실행
  방지, Manager·Source·보고서·계획 변경 거부를 포함한다. 관련 focused 검사는 23개를
  통과했다. 실제 CLI·Git·CI 실행이나 전체 AC 합격의 근거로 사용하지 않는다.

빌드·타입·테스트는 선언된 SDK commit `c69915a518f0eb600f0ace8238144059911f8d04`와
일치하는 고정 사본에서 검증한다. 기존 설치 의존성과 작업 데이터를 덮어쓰지 않는다.
로컬 fixture·브라우저 미리보기 결과는 실제 Host·AI·실기기 인수나 원문 AC 전체 합격이 아니다.
다음 상위 인수는 현재 Gate reader와 원자 이벤트 발행의 실제 Core 연결, 승인된 Manager Git·CI 실행, 그리고 같은 현재 핀·완전 inventory를 읽는 Final Packet·원자적 사용자 승인이다. Core/Host 증거가 없으면 해당 기능은 계속 `UNKNOWN`/blocked이며 helper·fixture만으로 승격하지 않는다.

- [상품 선택 저장 계약](product-selection/contract.md)
- [기준선 본문 생산자와 Manager 읽기 계약](project-documents/baseline-body-source.md)
- [UI Contract와 사용자 승인 연결](ui-contracts/README.md)
- [Reuse 후보의 미검증 권리 경계](reuse-first/platform-contract.md)

- [Codex 네이티브 Worker 후속 검증 상태](CODEX-NATIVE-WORKERS-2026-11-02.md): App Server 조사 결과, 현재 미입증 범위와 실행 전 검증 게이트.
- [CTO Task Packet 구현 기록](CTO-TASK-PACKETS-2026-11-02.md): CTO 계획 도구의 구현 범위, 근거와 한계.
- [v15 완료 계획](BUILDER-V15-COMPLETION-PLAN-2026-11-02.md): 전체 인수 기준과 실행 순서.
