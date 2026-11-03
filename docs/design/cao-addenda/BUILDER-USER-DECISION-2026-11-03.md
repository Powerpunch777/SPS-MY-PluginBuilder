# Builder 사용자 결정 추가 기록 — 2026-11-03

## 출처와 문서 상태

이 결정은 사용자가 Lead에게 직접 전달한 2026-11-03 지시를 기록한다. 기존 v15, UI v9, 기존 addendum 또는 Task/Workstream 수용 기준을 조용히 고쳐 쓰지 않는다. 이 문서는 날짜가 붙은 추가 기록이며, 원본 설계와 Git/source 증거는 당시 기록으로 보존한다.

이 결정문 자체는 구현, 데이터 초기화, 테스트, 검수, 제품 완료 또는 Task 수용을 증명하지 않는다. 제공된 Task 조회의 `specRevision`은 `V15-CSAS-V07-M1`이며, 그 조회 내용과 이 사용자 결정 사이의 수용 기준 변경은 확인되지 않았다. 따라서 아래 대체 문구는 모두 `PROPOSED_NOT_BOUND`이며, 새 Task ID·계획 개정·승인·실행 사실을 뜻하지 않는다.

## 최신 공급 결정 보충 — 2026-11-03

공급된 사용자 결정(2026-11-03, SHA-256 `14996c6a9bc084255f50e1b790a1ad435e4b66c2a21c67993fadc931c754a228`)은 아래의 구 전환 정책보다 최신이며, 충돌하는 Builder 제품 요구를 대체한다. 구 정책은 `BUILDER-V15-CSAS-V08-INTEGRATION-2026-11-03.md` (2026-11-03, SHA-256 `7089279dc303175e0420b2774850571390a67820de2cd22b8875a015bc90c3fd`)에 기록된 바와 같이, 기존 3개 대화와 ID/provenance를 보존하고 기존 사용자는 현재 화면을 유지하며 명시적으로 선택한 뒤 새 5-context 대화를 시작하도록 했고, 자동 연결·이관·삭제·병합은 하지 않으며 전환 세부 UX는 미결정으로 두었다. 이는 역사적 기준으로 남기며 현행 요구로 적용하지 않는다.

현행 요구는 빈 상태로 시작하는 `Main`, `UI Design`, `Background`, `Question Intake`, `Question Discussion`의 다섯 논리 context다. 레거시 전환, 마이그레이션 및 이전 대화 이력 메뉴를 두지 않고, context 시작만으로 AI를 자동 실행하지 않는다. 실제 존재하는 데이터를 함부로 삭제하지 않으며 공유 프로젝트 기억, 승인된 설계 Revision, 결정 및 CTO 기록을 보존한다. 재개(resume)할 때 최신 승인 Revision과 최신 결정을 모두 갱신한다. 공식 발행 권한은 Main에 있고, 보이는 순서는 `Main` → `UI Design` → `미결정사항`이다. `Background`와 `Question Intake`는 내부 context이며, `Question Discussion`은 미결정사항의 논의 context다.

## 제품 결정

- Builder에는 실제 최종 사용자 대화 이력이 없다. 코드의 `main`, `cto-inbox`, `decisions`는 과거 코드 구조일 뿐, 기존 사용자의 대화 기록이나 현재 화면 정책이 아니다.
- 그 구조를 위한 레거시 사용자 전환 버튼, 데이터 마이그레이션 기능, 이전 대화 메뉴를 만들지 않는다. 이전 3세션 구조를 현재 기본값으로 계속 유지하거나 보존하기 위한 UI 작업도 중단한다.
- Lead는 다음 다섯 논리 context를 사용하며 새 기본 상태는 비어 있다: `Main`, `UI Design`, `Background`, `Question Intake`, `Question Discussion`. 다섯 context의 시작은 AI 실행을 자동으로 일으키지 않는다. 메시지 전송은 사용자의 명시 동작으로만 시작한다.
- 동일 프로젝트의 공유 기억, 승인된 설계 Revision 및 결정 참조는 계속 필요하다. Main의 제품 권한은 이 공통 참조와 승인된 설계 상태를 기준으로 다루며, 과거 키 이름만으로 새 권한이나 API를 추론하지 않는다. 실제 권한은 적용되는 Core/SDK 계약과 자격 증명 보안 경계를 따른다.
- 최신 화면에서 보이는 왼쪽 순서는 `Main` → `UI Design` → `미결정사항`이다. `Background`와 `Question Intake`는 내부 context다. `Question Discussion`은 미결정사항의 질문 논의 context다.
- 검정·중립 회색 UI 기준은 UI v9에 따라 Builder 플러그인 영역에만 적용한다. Core 전역 테마로 넓히지 않는다.
- Marketplace, Core의 Native 대체 구현, Core Preview는 이 결정의 범위에 포함하지 않는다.

## 데이터 범위와 보안

사용자는 범위를 확인한 뒤 실제로 식별된 개발/시험 데이터만 초기화하도록 허용했다. 이는 Core, Host 또는 사용자 데이터 전체 삭제를 허가하지 않는다. 운영자는 현재 어떤 데이터도 초기화하지 않았다. 이 문서 작성으로 삭제·마이그레이션·초기화가 수행된 것은 아니다.

기존 Git/source 근거와 원본 설계 기록을 보존한다. 자격 증명, Core/SDK 경계, Workspace 격리 및 권한 검증을 약화하거나 우회하지 않는다. 새 UI·저장/API 계약이 필요하다면 실제 공개 계약과 확인된 데이터 범위를 먼저 검토해야 한다.

## HISTORICAL ANALYSIS — 2026-11-03 최신 결정 이전 계획 대조

> 아래 절은 2026-11-03 최신 사용자 결정이 반영되기 전에 작성된 계획·수용 기준 대조와 대체 제안을 당시 기록으로 보존한다. 인용된 “현재” 상태 진술과 `PROPOSED_NOT_BOUND` 제안은 해당 기록 시점의 설명이며, 현행 제품 요구나 최신 사용자 결정을 대체하지 않는다. 현행 정책은 위의 “최신 공급 결정 보충”과 “제품 결정”을 따른다.

## 기존 계획과의 충돌 — 아직 변경되지 않음

현재 제공된 Worker 계획에 포함된 원문:

> “Preserve old stored sessions through explicit compatible handling, not data deletion.”
>
> “Add focused regression tests for existing sessions, five unique logical contexts, Workspace isolation and no extra always-running model processes.”

현재 Worker 수용 기준 원문:

> “Existing callers and stored data remain usable; focused tests and typecheck are actually executed with the prepared toolchain.”

현재 QA 계획 원문:

> “...check legacy sessions and Workspace isolation.”

현재 Workstream 수용 기준 원문:

> “Implement the five logical Lead contexts ... preserving existing stored conversations and CTO-question/decision records.”

위 계획과 수용 기준은 이 문서 작성 시점에도 변경되지 않았다. 아래 문구는 사용자의 새 결정에 맞춘 변경 제안이며, CTO/Lead가 계획과 수용 기준을 갱신하기 전까지 `PROPOSED_NOT_BOUND` 상태다.

## 계획 대체 제안 — `PROPOSED_NOT_BOUND`

- 다섯 논리 context, 동일 Workspace 격리, 공유 기억과 승인된 설계 참조, Main 권한 경계, Core/SDK/자격 증명 보안을 구현·검토 범위로 유지한다. 기존 `main`/`cto-inbox`/`decisions`를 실제 사용자 이력으로 전제하거나 레거시 전환·마이그레이션·이전 대화 UI를 인수 조건으로 삼지 않는다.
- 기존 저장 대화와 CTO 질문/결정 기록의 보존·호환성을 새 사용자 대화 이력의 존재로 전제하지 않는다. caller/API 호환성은 UI 정책과 별도로 취급하고, 실제 공개 계약과 확인된 저장 데이터가 요구하는 범위만 정한다. 확인되지 않은 데이터 삭제는 하지 않는다.
- 시험은 다섯 context의 구분·고유성, Workspace 격리, Main 권한과 명시적 전송 경계, 추가 상주 AI 프로세스가 생기지 않는 동작 및 적용 가능한 보안 계약을 확인하는 데 둔다. 레거시 최종 사용자 이력·레거시 UI·마이그레이션을 전제로 한 테스트 요구는 제거 대상으로 제안한다. 실제 테스트와 typecheck는 준비된 도구체인에서 실행한 경우에만 결과 증거로 보고한다.
- 초기화는 범위를 확인해 식별한 개발/시험 fixture에 한정한다. Git/source 근거와 원본 설계 기록은 보존하고, 확인되지 않은 Core/Host/사용자 데이터 범위를 확대하지 않는다.

> **HISTORICAL ANALYSIS 구간 종료 — 2026-11-03.** 위 계획 대체 제안은 기록된 당시의 분석이며, 현행 정책과 수용 기준은 이후의 명시적 사용자 결정에 따른다.

## 제공 설계 자료와 대조 기준

다음 자료를 읽었다. 해시는 이 작업 디렉터리에서 `sha256sum`으로 계산한 각 파일의 SHA-256이다.

| 경로 | SHA-256 | 확인한 관련 내용 |
| --- | --- | --- |
| `docs/design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md` | `2f3ee89479339180c86e99ed04a540a08bb03a0fcc25e176c713ec83ac44dc1c` | v12 3세션·공유 기억 (§0.14, §2G), 메인/질문 경로 (§2D), Main의 설계 Revision 반영, UI/보안 목표. 문서 자체가 구현 완료 증거가 아님을 명시. |
| `docs/design/03_UI/UI-IMPLEMENTATION-CONTRACT-2026-11-01.md` | `89410e495aca9ff1160051e30f9333c289f7ca66f0ffa15e73b29a34bb55e762` | UI v9 구조와 Builder에 한정된 검정·중립 회색 기준. |
| `docs/design/CORE-PLUGIN-ALIGNMENT-2026-11-02.md` | `d00952a29d70c8d0e7a9cb7c2629f4b1982aa076e8f426d88fc26f3c16e23f85` | 선택형 Plugin 경계, Core/SDK 및 Vault·파일 보안 목표와 미완료 상태, Marketplace/Preview 보류, 과거 기록은 완료 증거가 아님. |
| `docs/design/cao-addenda/BUILDER-V15-CSAS-V08-INTEGRATION-2026-11-03.md` | `7089279dc303175e0420b2774850571390a67820de2cd22b8875a015bc90c3fd` | 기존 3세션 유지·선택 전환을 적은 이전 통합 노트. 이 사용자 결정과 충돌하는 과거 기록으로 보존하며, 현행 결정으로 간주하지 않음. |

이번 작업은 이 문서들 외의 비공개 Core 자료, 자격 증명 경로 또는 `.cao-tools`를 읽지 않았다. 코드를 수정하거나 테스트, typecheck, 데이터 초기화, 빌드, 앱 실행을 수행하지 않았다.
