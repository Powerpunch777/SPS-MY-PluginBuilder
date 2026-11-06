# 구현 기록

현행 구현 기준은 [v16 정본](../design/CURRENT-PRODUCT-CONTRACT-2026-11-04.md)과
[마스터 인덱스](../design/README.md), 확인된 증거는 [AC 추적표](../design/AC-TRACE-2026-11-04.md)다.
아래의 날짜가 붙은 계획·검사 결과는 당시 구현과 범위를 보존하는 기록이다.

## 2026-11-07 연결 현황

| 기능 | 현재 구현과 검증 경계 |
| --- | --- |
| 상품 선택 | 공식 16개 상품·5개 부가 서비스, 독립 분류 축, 사용자 CAS 초안 저장과 화면 연결. 로컬 독립 QA·데스크톱/모바일 검사 완료. 승인 명세·실제 빌드·납품 완료는 아님. |
| 상담 분석 | 수집은 AI를 실행하지 않음. 명시 분석 action이 원문 경계·해시를 고정하고 Main에 한 번 전달. 시스템 분석 요청은 사용자 원문·승인 근거에서 제외. 응답 유실·재시작·중복 요청의 로컬 회귀와 독립 QA 완료. |
| Lead 6세션 | 여섯 독립 Session ID와 채널별 도구 정책, Main 공식 발행 제한, Lead 영역 탐색 연결. 격리된 소스 Desktop/Host에서 준비·재확인·재시작 뒤 동일 6개 ID와 Run 미생성을 확인. Core가 반환한 실패 코드·메시지는 기존 대화 기록에 크기를 제한해 보존하고 화면에는 시스템 메시지로 표시하며 자동 재전송하지 않음. 모델 실행 실패 시 논리 세션 등록까지 삭제되던 Core 경로는 별도 소스 브랜치에서 수정했고 실제 임시 Host에서 동일 등록·Run 연결 보존을 확인함. 해당 시험의 모델 실행은 실패하여 D3 실제 AI 검증은 미완료이며, 계정 전환·전체 AI 흐름 합격이 아님. |
| 기준선 문서 | Main 발행 후 결정적 본문·해시·source pin을 기존 Revision journal에 저장하고 문서센터에서 조회. stale/unavailable, 별도 journal 실패와 명시 재생을 구분. 전체 납품 inventory와 독립 승인 증거는 아님. |
| 문서센터 | 현재 상담 원문·설계·기술 선정·Workstream 등 실제 연결 자료를 기존 화면에 투영. 제목·본문 검색, 분류·유형·승인·최신성·연관 ID 필터와 기록 시각 정렬을 연결. 미확인 상태를 보존하며 전체 Artifact 목록의 완전성은 주장하지 않음. |
| D3 | 첫 설계의 Main 제안과 인증 사용자 검토를 분리함. 첫 Baseline은 정확한 초안·원문 핀·규칙 팩을 담은 승인 Revision과 해시를 같은 발행에 고정하며, 일반 대화만으로 발행할 수 없음. 기존 검토 묶음에 선택적인 정적 설계 모델을 함께 승인하며, 등록된 D3 조회는 원문 AC 인용·사실·시나리오·항목별 결정과 정확한 요구·규칙 관계를 다시 검증하고 기존 유한 검사기를 실행함. 응답은 승인 Revision과 모델 해시를 표시하며 caller 입력으로 승인 모델을 교체할 수 없음. 모델 없는 과거 승인, 누락된 검사·실행·QA 증거는 계속 `UNKNOWN`. 후속 규칙팩 제안은 같은 승인·원문 핀을 검증하지만 후속 변경의 모델 승인·발행 경로는 미완료. codec·등록 handler의 fixture 독립 QA와 검토 화면의 데스크톱/모바일 검사는 통과했으며, 실제 Host·AI 승인 흐름이나 CTO VERIFIED의 근거는 아님. |
| UI Contract | 정확한 HTML과 시안·사용자 승인·Main 공식 발행을 연결. 접수 미확인 시 같은 요청 ID를 조회하고 이미 시도한 실행을 재전송하지 않음. 데스크톱/모바일 미리보기 통과. 자동 알림 복구에는 동일 Workspace Worker 경로가 필요하며 실제 AI 승인 흐름은 미검증. |
| G5 변경 영향 | 설계 시각화의 인증 사용자와 Main·Integration Review 도구에서 기존 Workspace 저널의 정확한 게시 Baseline 및 공식 UI 쌍을 읽기 전용으로 비교. 기존 `builder.read-change-impact`는 생략 기본값에서 기존 비교 결과를 유지하고, 선택적 `projection: "revalidation"`은 명시된 과거 G5·Workstream·Task 게시 쌍의 후보와 현재 지시사항을 투영함. CTO 준비 receipt는 readiness 참고일 뿐 G5 ACK가 아니며, 실행·독립 QA 증거와 불완전 inventory는 계속 `UNKNOWN`; 조회는 재승인·dispatch·실행을 허가하지 않음. 실제 자동 실행·승인 경로와 전체 원본 inventory는 미연결. 사용자 화면은 게시 Baseline과 그에 연결된 승인 UI를 명시 선택하며, 이전·신규 순서와 늦은 응답을 검사함. 격리된 소스 Desktop/Host에서 인증 사용자 조회·Workspace별 빈 목록·다른 Workspace 접근 거부를 확인했으며 실제 승인 쌍 생성이나 AI 실행 검증은 아님. 최근 이력 범위·누락된 승인 연결을 구분하고 현재 쌍을 자동 추정하지 않음. 요구·UI·Graph 후보 및 확인 범위를 구분. 기술·Workstream·Task의 실제 원본 쌍도 부분 범위이며, 일정·상품 및 전체 영향은 미확인. ACK·영향 범위 재승인과 실행 Gate는 별도 연결 필요. |
| CTO 프로필 | 지원 SDK/Host에서는 동일 CTO ID를 같은 plugin-owned Agent 및 Session ID로 준비함. 신규 프로필 요청은 현재 Lead에서 확인된 실행 어댑터만 초기 선호값으로 전달하며, 관측 불가 시 생성하지 않음. 이 연결은 fixture 독립 QA 완료. 등록은 Run을 시작하지 않으며 비활성·소유권 변경을 관측하면 전송을 차단함. 후보 공개 SDK의 범용 API를 사용한 별도 no-AI 플러그인으로 실제 소스 Host에서 전용 프로필 2개·세션·재시작·Workspace 분리와 Run 0개를 확인. 현재 고정 SDK의 논리 세션은 독립 Agent가 아니며, Builder Main 도구·동시 실행·전송 경쟁의 Core admission은 별도 미검증. |
| Task Worker·QA 준비 | 새 CTO 실행에만 두 준비·조회 도구를 등록하며 과거 실행의 권한 목록은 확대하지 않음. 정확한 현재 Workstream·Task Packet revision·출처와 의존성 핀을 확인하고, 지원 Host의 owned Agent 및 keyed session을 역할별로 분리하여 기존 Workspace 상태에 연결함. 구형 Host는 대체 신원이나 실행 없이 미지원으로 반환함. 준비는 실행 권한·AI Run·코드 제출·QA 합격이 아니며 실제 실행·결과 인수 연결은 미완료. |
| Gate producer/consumer | 서버 전용 helper 조합은 authoritative TaskPacketBoard와 모든 개발 Task 입력을 한 Workstream snapshot으로 집계하고, 전체 source/dependency guard에 결속된 publication 및 guarded current observation을 제공함. `currentGuarded`는 원자적 시점 조회일 뿐 lease나 후속 동작 권한이 아니므로 실제 Manager/Core dispatch는 같은 source guard를 dispatch 시점에 다시 검증해야 함. 현재 Source Inventory·완료 Run/QA의 실권위 reader, 해당 dispatch 재검증, 등록된 VERIFIED 생산·이벤트 경로는 없음. 이 helper는 live plugin에 등록되지 않았고 Gate의 실권위 Coverage reader와 부분 Baseline inventory는 `UNKNOWN`; 정적 D3 검사만으로 VERIFIED/자동 통합을 허가하지 않음. |
| 조건부 Revision 발행 | 기존 불변 entry·CAS head 저널의 `publishGuarded`는 지원 SDK/Host에서만 원문 포인터 조건과 head를 함께 비교하며, 충돌·누락된 조건·응답 유실 뒤 staging 기록을 보존함. 별도 선택 기능 `publishGuardedWithJobWakeV1`은 같은 저장과 작업 알림을 명시적 원자 API로 요청함. 기존 API로 대체하거나 불확실한 요청을 자동 재시도하지 않으며 고정 SDK에서 미지원이면 state 접근 전에 멈춤. 저널 fixture 회귀는 통과했으나 실제 VERIFIED·최종 승인 writer 연결은 미완료. 후보 SDK/Host에서 확인한 원자 저장·작업 등록은 실제 Builder 자동 통합의 증거가 아님. |
| Manager 설정 | 시스템 화면에서 Lead와 분리된 Agent를 인증 사용자 action으로 선택·준비함. 같은 Workspace에서만 CAS로 설정하고, 현재 Lead와 같은 Agent는 거부함. Agent별 기존 Core 세션을 재사용하며 설정 변경은 과거 세션을 삭제하지 않음. 격리된 소스 Desktop/Host에서 사용자 선택, 독립 세션 준비·재확인·재시작, 다른 Workspace 및 Lead 선택 거부, Run 0개를 확인함. 후보 공개 SDK와 소스 Host를 쓰는 별도 no-AI 플러그인에서는 같은 생산자의 신규 기본 프로필 생성·독립 세션·재시작·Workspace 분리·사용자 설정 및 pause 보존도 확인함. 이는 실제 Builder UI의 신규 자동 생성 검증이 아니며, 현행 고정 SDK에서는 신규 자동 생성이 미지원. 준비는 실행 권한이나 통합 완료가 아님. |
| Manager 자동 통합 / Final Packet | Manager 이벤트 소비는 실제 자동 실행에 아직 미연결. 최종 검토 페이지, Main G7 확인, Integration Review 요청, 인증 사용자 결정 경로는 역할별로 등록함. 격리 Host에서 패킷 없는 확정을 거부함. 현재 패킷·원문 근거 reader 및 원자 승인 writer가 연결되기 전에는 실제 납품 확정 불가. |
| Reuse | Background가 기존 사용자 조사 원문의 정확한 행·해시에서 후보를 기록하고 Main/Background와 문서센터가 같은 저널을 조회함. 원문의 CRLF를 보존하며 Lead 원문 16 KiB와 저장소 인용문 32 KiB 한도를 구분함. 로컬 등록 handler·문서 검사 및 실제 소스 Host에서 도구 등록·Workspace별 빈 조회·실행 사칭 거부를 확인. 실제 AI 조사·자산별 권리·호환성은 미검증이며 미확인 후보의 재사용은 차단 상태. |

빌드·타입·테스트는 선언된 SDK commit `c69915a518f0eb600f0ace8238144059911f8d04`와
일치하는 고정 사본에서 검증한다. 기존 설치 의존성과 작업 데이터를 덮어쓰지 않는다.
로컬 fixture·브라우저 미리보기 결과는 실제 Host·AI·실기기 인수나 원문 AC 전체 합격이 아니다.
다음 상위 연결은 실권위 Coverage·현재 Source Inventory·완료 Run/QA 증거를 가진 Gate producer, 이를 소비하는 VERIFIED 이벤트/Manager 실행, 그리고 같은 현재 핀·완전 inventory를 읽는 Final Packet·원자적 사용자 승인이다. Core/Host 증거가 없으면 해당 기능은 계속 `UNKNOWN`/blocked이며 helper·fixture만으로 승격하지 않는다.

- [상품 선택 저장 계약](product-selection/contract.md)
- [기준선 본문 생산자와 Manager 읽기 계약](project-documents/baseline-body-source.md)
- [UI Contract와 사용자 승인 연결](ui-contracts/README.md)
- [Reuse 후보의 미검증 권리 경계](reuse-first/platform-contract.md)

- [Codex 네이티브 Worker 후속 검증 상태](CODEX-NATIVE-WORKERS-2026-11-02.md): App Server 조사 결과, 현재 미입증 범위와 실행 전 검증 게이트.
- [CTO Task Packet 구현 기록](CTO-TASK-PACKETS-2026-11-02.md): CTO 계획 도구의 구현 범위, 근거와 한계.
- [v15 완료 계획](BUILDER-V15-COMPLETION-PLAN-2026-11-02.md): 전체 인수 기준과 실행 순서.
