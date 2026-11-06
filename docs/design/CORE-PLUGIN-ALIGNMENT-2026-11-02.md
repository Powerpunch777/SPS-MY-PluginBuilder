# Core·SDK 권한 계약과 검증 경계

## v16 현행 계약 (2026-11-06)

제품 정책은 [v16 정본](CURRENT-PRODUCT-CONTRACT-2026-11-04.md) 및
[범용 권한·Host 위임 확정 원문](01_Design/SPS_Builder_Generic_Permissions_And_Host_Delegation_Addendum_2026-11-05.md)에
따른다. 아래 날짜가 붙은 기존 정렬/검사 기록은 당시 증거다. 그 안의 3세션,
문서 전용 범위, 개발 중지나 예전 설치 버전은 이번 작업 지시가 아니다.

| 주체 | 실제 소유 범위 |
| --- | --- |
| Lead | Main 공식 Revision과 배정, 각 논리 세션의 허용된 자료/설계/조사/질문/Review. 사용자 전용 결정을 대신하지 않는다. |
| CTO | 배정 Workstream 기술 판단·개발·독립 QA 배정. 다른 CTO 영역·공식 설계 무단 변경 금지. |
| Worker / QA | Worker는 승인 Task의 파일·CLI·Runner와 허용 효과만. QA는 독립 대상의 테스트·증거만. |
| Integration Manager | 승인된 통합 후보·Git·CI/E2E·Packet. 별도 독립 Agent이며 설계 개정·일반 Node 관리·납품 승인 불가. |
| Core / Host 관리자 / 사용자 | Core 범용 권한 강제·철회, 관리자는 한정된 사전 위임, 사용자는 사업·설계 결정과 최종 패키지 승인. |

역할 기본 권한, Task의 임시 권한, 철회 가능한 Host 사전 위임, 사용자 전용 승인은
독립적이다. Workspace·Plugin·주체·Node·Runner·자원·Task·기간을 검증하고 종료·철회 시
임시 권한과 실행 점유를 회수한다. Agent 실행 허가는 파일/Git 수정, Secret 노출,
프로세스·네트워크 사용을 자동 허용하지 않는다. API/Workspace 검사와 OS 강제는
별도로 실증한다. 실제 Core capability가 없는 곳에 Builder 역할 예외, caller boolean,
가짜 ToolRunContext, 중복 권한 저장소를 만들지 않는다.

### 확인한 소스와 남은 선행 기능

| 실제 경계 | 2026-11-06 관측 | 미검증 또는 차단 |
| --- | --- | --- |
| 공개 SDK 세션 | 후보 `196bdfe`/e7 공개 `platform/index.d.ts`의 세션 list/ensure/sendMessage/getRequest/getRun. 요청 ID와 현재 binding 관측은 실행 권한이 아니다. | 설치 Host의 새 Run·적격 인증 풀·현재 역할·위임 결속. Builder 기초 package는 별도 `c69915a5`. |
| 독립 Agent·사전 위임 | 공개 후보 타입에는 조건부 owned Agent 설정 경계가 있고, 비공개 Core 개발 체크아웃에는 범용 구성/실행 위임 후보와 검증 작업이 있다. | 현재 승인된 통합 Host에서 기본 프로필 생성·새 실행·철회/만료·동시 한도. 후보/WIP를 일반 공개 API로 보지 않는다. |
| 실제 Workspace 시스템 이벤트 | 현재 실제 스코프 Worker의 등록·권위 있는 callback delivery 경계가 확인되지 않았다. 사용자/도구 invocation과 시스템 이벤트 invocation은 다르다. | 권위 있는 이벤트에서 선행 Manager Run 없이 새 소유 세션 Run의 검증된 admission. 전역 onEvent나 가짜 context로 대체 금지. |
| 보호 Node·Task 실행 | Core 개발 기준 `1f13812`의 Source 입력 저장/봉인과 준비 Run 후보는 입력 처리다. 고정 CLI·Worker transport는 범용 TestPlan 실행기가 아니다. | 승인 스냅샷의 안전한 materialize, 명령/파일/Secret/네트워크/프로세스 강제와 종료, 불변 산출물·실제 테스트 결과 발행. Windows 실험용 순수 소스 확인은 제품 보호가 아니다. |
| 공용 Pool, Goal/Wake | [실행 부속서](AGENT-GOALS-AND-RUNTIME.md)의 설치 스키마·공식 설명은 정적 증거. | 실제 A→B 모델 응답, 일반 무메시지 Wake, Goal 권한·복원·자동 연속, Capacity와 철회 복구. |

개발 체크아웃/비공개 브랜치 경로·인증정보·실사용 데이터는 공개 기록에 넣지 않는다.
실제 제품 권한·설치본·두 PC 인수는 확인한 작업본과 별개다.

## 2026-11-02 범위 메모 (역사)

최신 사용자 결정으로 이전의 "paused, 문서 전용" 상태에서 Builder 목표 진행을 재개했다. 목표는 별도 `SPS-MY-PluginBuilder` 저장소의 통합 설계 v15, UI v9, 최신 UI 적용 기준을 따르는 실제 Builder 완성이다. 안전을 위해 꼭 필요한 Core 선행 사항만 먼저 다루며, Core 문서와 기술상 핵심 경로는 별도 담당 범위다. Core 전체 완성이나 Stable 선행 범위를 새로 요구하지 않는다.

Marketplace, 자체 LAN 개발, Preview 개발과 Preview를 포함한 추가 시험은 계속 보류한다. Builder의 Preview 관련 AC 부분은 보류·미완료로 남기며, 현재 범위에서 완료로 세지 않는다. 이 보류는 AC 전체를 포기한다는 뜻이 아니며, v15/UI v9와 나머지 AC는 계속 유효하다. 이번 문서 작업은 지정된 두 문서에 한정하고, 구현·검사·빌드·앱 실행·push·commit은 하지 않는다. 과거 설계와 증거의 원문은 유지한다. 공개 Builder 문서에 비공개 Core 파일·경로·코드 또는 사용자 정보를 복사하지 않는다.

## 목적과 우선순위

이 문서는 Builder 설계 문서에 남아 있던 오래된 제품 전제의 우선순위를 정리한다.
제품 기준은 Core의 `CORE-PLUGIN-ARCHITECTURE-2026-10-25.md`이며,
`DESIGN-BASELINE-2026-11-02.md`가 그 우선순위와 당일 결정을 요약한다. 이 기준은
Builder의 구현 상태나 Core 통합 완료를 증명하지 않는다.

2026-11-02 결정은 아래 문서에 적용한다.

- `docs/design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md`
- `docs/design/02_Tech_Research/SPS_Builder_Technology_Stack_Research.md`
- `docs/design/03_UI/UI-IMPLEMENTATION-CONTRACT-2026-11-01.md`
- `docs/implementation/PLAN-2026-11-01.md`

이 날짜 기준은 위 문서의 오래된 개인 전용·단독 Builder·필수 Core UI 진입 가정보다
우선한다. 날짜가 붙은 기존 검사/실제 Host 결과는 당시의 사실 기록으로 보존한다.
새 설계 기준은 과거 결과를 지우거나 현재 구현에 대한 새 증거로 승격하지 않는다.

## 제품과 소유권

- Builder는 공개 SDK로 만들 수 있는 일반 목적의 **선택형 authoring plugin**이다. Core의
  유일한 제작 경로가 아니며, 첫 Workspace에 필수이거나 모든 Workspace에서 활성화될 필요가 없다.
- Core는 Host, Plugin 설치·활성화, Workspace 격리와 공개 SDK 계약을 소유한다. Plugin은
  자신의 UI·도메인 기능·설정·Workspace 범위 데이터를 소유한다. Core는 비공개로 유지하고
  Builder에는 공개 SDK 계약과 기능 요약만 참조한다.
- Host 설치는 Plugin 단위이며 Workspace별 활성화·설정·데이터는 선택적이다. Primary는
  Workspace당 최대 하나이고 0개도 정상이다. Builder는 필수 Primary가 아니다.
- 다른 IDE·CLI·Builder도 같은 공개 SDK를 사용할 수 있다. Preview는 Builder 독점 기능이
  아니라 필요할 때 재사용하는 선택적 authoring capability다. Preview와 Builder의 배포
  라이선스 정책은 이 문서에서 정하지 않는다.

## 화면과 Builder 워크플로

- Plugin은 전체 plugin surface를 소유한다. Builder 화면 안에 Core navbar/sidebar/Dashboard/Inbox/Settings 메뉴를 강제 주입하지 않는다.
- Core Native Settings, OS tray, 전역 단축키와 시스템 관리는 Plugin UI와 독립적이다.
  공개 SDK가 설정 진입 API를 제공하면 plugin 안의 선택적 바로가기로 쓸 수 있지만 필수는 아니다.
- 검정·중립 회색 v9 디자인은 Builder plugin 영역에만 적용한다. Core 전역 테마에는 적용하지 않는다.
- 당시 Lead 3개 세션(현행 v16은 6개)과 공유 기억, 프로젝트별 CTO 단일 세션, 독립 Dev/QA, GHA 및 self-hosted
  Runner는 v15가 정의한 **이 Builder의 솔루션 제작 워크플로**다. Core 사용자나 다른
  Plugin에 강제되는 제품 법칙으로 일반화하지 않는다.

## 보안 목표와 현재 상태

- OS 사용자 경계 내 파일 접근 제한과 Secret Vault plaintext 비노출은 Core 보안의 필수
  목표다. 설정된 파일 경계는 Plugin뿐 아니라 CLI·script·child process까지 일관되게
  적용하고, 미지원 경로는 명시적으로 거부해야 한다. 경계가 설정되지 않은 경우의
  기본 범위도 OS 사용자 권한을 넘지 않는다.
- Vault plaintext는 광범위한 파일 권한이 있더라도 Plugin이 직접 읽을 수 없어야 한다.
  토큰 중개와 실제 파일 경계 강제는 Core/OS 책임이며 SDK에서 필드를 숨기는 것만으로
  충족되지 않는다.
- 현재 trusted mode의 OS file-bound enforcement는 부분 구현/미완료다. DPAPI, ACL,
  프로세스 실행 또는 기존 테스트만으로 완료됐다고 표시하지 않는다. 출하 전 OS 수준의
  경계가 실제 적용되는지 별도 검증해야 한다.
- Preview는 비신뢰 콘텐츠의 격리와 권한 제한을 필요로 한다. Electron 기반 구현은
  [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security),
  [Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation/),
  [Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
  지침을 따라야 한다. 이 참고는 Preview가 이미 구현됐다는 증명이 아니다.

## 구현 상태와 과거 기록

현재 고정 SDK는 `bfd81cdae374ad5ac5e7e621ab99b6af8affee7e`다. 검증된 Builder
runtime `87ff7a25a4f393b08cce4f4c54fef80747b4ba01`에서 Node24 검사59/59 및
SDK validate/test가 통과했다. 실제 source Host에서 세 Lead 세션 생성·재확인 시
중복 없음·재시작 후 동일 ID 보존을 확인했다.
[정확한 기록](../implementation/LEAD-THREE-SESSION-PREPARATION-2026-11-02.md)을 따른다.
이번 설계 정렬에서는 테스트를 새로 실행하지 않았다.

그 시험은 Core 공통 프레임이 남은 호환 화면에서 수행됐다. 강제 Core UI 없는
전체 Plugin 화면, 실제 AI/provider·공유 기억·전체v15, 서명 설치본·두 PC 또는
OS 보호의 완료 증거가 아니다. 전송 기능은 비활성이다.
과거 revision·시험은 당시 사실로 유지하고 최신 결과로 바꾸지 않는다.
비공개 Core 코드·사용자 정보·원시 로그는 이 문서에 포함하지 않는다.

## 변경 경계

이 문서는 설계 정렬만 기록한다. Core 구현, SDK 구현, Builder 기능 활성화, 테스트 실행,
제품 완료 판정 또는 라이선스 결정을 승인하지 않는다. 최신 Core/SDK 공개 계약과 별도
evidence가 실제 구현 상태를 판단하는 기준이다.
