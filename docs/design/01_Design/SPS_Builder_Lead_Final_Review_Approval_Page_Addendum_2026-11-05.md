# SPS Plugin Builder — Lead 최종 검토·승인 페이지 설계 추가안

> 작성일: 2026-11-05 (KST)
> 상태: 사용자 제품 정책 결정 반영 / 코드 미반영 / Core·SDK 계약 및 현재 Builder UI 감사 필요
> 대상: SPS Plugin Builder (프로젝트 1개 = Workspace 1개)
> 선행 문서: Builder v15, CSAS v0.8, `SPS_Builder_Integration_Design_20261104.md`, Project Document Center v1.1
> 사용자는 Builder의 실제 최종 고객 납품을 직접 수행한다.

## 0. 결정 내용 — 변경 사유

기존 2026-11-04 설계에서 Integration Manager의 `Final Integration Packet` 발행, Lead Main의 G7 검토 및 사용자 최종 승인 요청까지 정의했으나, 사용자가 해당 승인 요청을 보고 조치할 **실제 사용자 화면**이 없었다.

**사용자 확정:** 기존 Lead의 여섯 번째 논리 세션 `Integration Review`의 사용자용 인터페이스를 **「최종 검토·승인」 페이지**로 만든다. 별도 일곱 번째 Lead 세션이나 새로운 AI 직원은 만들지 않는다. 기존 Integration Review의 교차 Workstream 계약·통합 이슈 검사와 백그라운드 wake 기능은 유지하며, 그 결과 중 사용자 확인·승인이 필요한 요청을 화면에 게시한다.

`Integration Manager`는 계속 **Lead 밖의 독립 Agent**이고 통합·통합 QA를 담당한다. `Lead Main`은 설계 Revision 발행·최종 G7 검토의 공식 권한을 유지한다. 승인 UI는 검증을 우회하는 버튼이 아니다.

## 1. 역할·세션 구조

| 구성 | 세션/표시 | 역할 |
|---|---|---|
| Lead Main | 사용자 대화 | 제품 명세/계약·승인 Revision의 권위 있는 관리, G7 정합성 점검, 최종 승인 요청 발행 |
| Lead UI Design | 사용자 대화 | 승인 시각 UI 및 UI Contract 제안·사용자 검토 |
| Lead Background | 필요시 내부 | 기술·OSS·Workstream 계획 |
| Lead Question Intake | 필요시 내부 | CTO 질문 원문 근거 조사·해결 |
| Lead Question Discussion | 사용자 대화 | 설계·행동·비용 등 사용자 결정을 요구하는 미결정사항 |
| **Lead Integration Review** | **내부 이벤트 처리 + 사용자용 `최종 검토·승인` 페이지** | CTO 간 인터페이스/통합 설계 문제 검토; 최종 패키지 검토 요청 정리, 사용자 응답 수신·감사 |
| Integration Manager | Lead 밖의 독립 Agent, 이벤트성 실행 | CTO 완료 이벤트 수집, merge/integration QA/E2E, Final Integration Packet 생성 |

**개수 불변:** Lead 6개 논리 세션 + 별도 Integration Manager 1개. ‘승인 페이지’는 새로운 세션/독립 데이터 원본이 아니라 기존 Integration Review가 제공하는 사용자 UI이다. 6개가 모두 사용자 채팅창이라는 뜻은 아니다.

## 2. UI 배치 및 내용

- **진입점:** Workspace의 좌측 탐색 영역, Lead 섹션 아래 **「최종 검토·승인」**. 처리 대기 건수 배지 표시 가능. Core Workspace Shell 규약에 맞춰 화면/탭으로 연다.
- **중앙 화면:** (A) 승인 대기/보류/반려/승인 완료 요청 목록; (B) 선택한 요청의 승인 대상 상세/비교/증거; (C) 권한 있는 사용자 조치 영역. 불필요한 별도 채팅 세션 UI는 강제하지 않는다.
- **기존 우측 ‘미결정사항’ 패널 유지:** 상품·설계 결정 질문은 Question Discussion에서 처리한다. 최종 패키지 승인은 이 페이지에서 처리한다. 동일한 이슈는 링크로 연결하되 중복 결정원본을 만들지 않는다.
- **Project Document Center 연동:** 설치·사용법·제한사항·산출물 목록은 문서 센터의 **원본 Artifact/Revision**을 링크·미리보기하고, 승인 페이지에 임의 복제한 별도 정본을 만들지 않는다. 기존 승인된 HTML Viewer 기능과 혼동하지 않는다.

### 2.1 개별 최종 납품 패키지 승인 요청의 필수 표시

1. Workspace/프로젝트 식별자, 상품·계약상 납품 범위 및 승인된 Design Baseline·UI Revision
2. Integration Manager가 발행한 Final Integration Packet 식별자/생성시각 및 통합 브랜치·빌드/커밋·CI/E2E 증거
3. **납품 파일 목록**: 파일명, 분류, 상대 경로, 파일 크기, 해시, 포함 근거, 버전 및 접근 권한(계약 조건 준수)
4. **설치·실행 설명서**, **사용 설명서**, 환경변수·필수 의존성·지원 환경/버전, 알려진 제한사항
5. 관련 CTO 검증/통합 QA/G6·G7 상태 및 누락/미해결/UNKNOWN 여부 (검사 실패는 성공으로 가장하지 않음)
6. 이전 패키지 승인 버전과 현재 후보의 diff, 문서 최신성, 포함 파일 및 해시 변경 여부
7. Lead Main의 G7 점검 결과, 승인 요청 이유/남은 경고/검토 가능한 근거
8. 사용자 요청 시 상세 로그/테스트 근거/설계 개정 이력으로 이동할 링크

페이지 상단은 사용자가 빠르게 판단할 수 있도록 패키지 개요와 승인 가능 여부를 우선 보여주고, 세부 증거는 펼치기 또는 문서 센터로 이동한다.

## 3. 역할 분리 및 처리 흐름

1. CTO가 자신의 Workstream을 검증하고 `VERIFIED`를 기록한다(기존 G4/G6 및 CTO QA 계약).
2. Integration Manager가 유효한 완료 이벤트를 받아 통합, 통합 QA, E2E 및 CSAS G6를 처리하고 `Final Integration Packet`을 발행한다.
3. Lead Main은 현재 승인된 제품·UI 명세, 계약상 납품 범위, 누락 산출물/문서, G7 충족 여부를 재검토한다.
4. 적격한 최종 패키지 후보에 대하여 Lead Main이 **불변 스냅샷 참조를 가진 승인 요청**을 생성한다.
5. Lead Integration Review의 **「최종 검토·승인」 페이지**가 해당 요청을 사용자에게 표시한다. 페이지 렌더링 또는 AI 응답 메시지가 승인 상태를 변경하지 않는다.
6. 사용자는 `승인`, `수정 요청`, `보류` 가운데 하나를 선택한다. `승인`은 **제시한 파일 목록·설치법·사용법이 특정 Revision/해시에 고정된 최종 패키지 버전이라는 것**만 확정한다.
7. 승인 성공 시 해당 Workspace의 공식 납품 패키지 버전/승인 시각·승인자·참조 Revision/파일 및 문서 해시·근거가 감사 가능하게 기록된다. 문서 센터와 Lead Main에 결과가 반영된다.
8. 수정 요청은 이유와 영향을 기록하여 Lead Main/Integration Manager/관련 CTO로 라우팅하고 변경된 패키지를 새 후보로 재생성한다. 기존 승인본은 역사적 사실로 보존한다.

### 3.1 승인 전 차단 조건

- 필수 G6/통합 QA/E2E가 미통과, 또는 G7에 필수 산출물·문서가 없음
- 승인 요청 대상과 현재 Design Baseline/UI Revision/Artifact/파일 해시가 불일치
- 필수 검증 근거가 `UNKNOWN`/`BLOCK`/`REVIEW_REQUIRED`인데 해당 계약상 완료로 볼 수 없음
- Workspace 사용자에게 해당 패키지 버전의 승인 권한이 없음

차단 중에는 검토·이력 열람·수정 요청은 가능하되 **승인 버튼은 비활성/서버 측 거부**해야 한다. 사용자가 클릭했다고 QA 통과나 외부 납품까지 승인된 것으로 취급하지 않는다.

### 3.2 상태 모델(예시, 정식 스키마는 코드 계약 감사 후 결정)

- 요청: `DRAFT → REVIEW_READY → PENDING_USER_APPROVAL → APPROVED` 또는 `CHANGES_REQUESTED` / `ON_HOLD` / `STALE`
- 검증 상태: 기존 G6/G7 상태를 **별도 저장**; 승인 요청의 상태만으로 자동 변경하지 않음
- 외부 고객 전달/배포: **별도 책임·상태**이며 본 승인 페이지에서 자동 실행하지 않음
- 승인 후 패키지/문서/기준선이 변경되면 **새 후보 Revision과 새 승인 요청**을 생성. 이전 승인 이력은 보존, 변경본의 승인 상태는 별도 관리
- 한 Workspace의 현재 공식 패키지 버전은 명시적인 참조 하나를 지정하되 이전 확정 버전의 증거·파일·해시 참조 보존

## 4. 기존 Integration Review의 역할 유지

이 페이지 전환은 교차 CTO 간 통합 설계·인터페이스 충돌 검토를 없애지 않는다.

- 기술/국소 오류: Integration Manager → 담당 CTO
- 인터페이스/설계 정책 충돌: Integration Manager → Lead Integration Review의 내부 이벤트 처리
- 사용자 제품/계약 결정 필요: Lead Integration Review → Question Discussion (사용자 협의) → Main 공식 Revision
- 최종 산출물 패키지 승인: Lead Main G7 적격성 확인 → Integration Review **사용자 승인 페이지**

같은 논리 세션이 내부 검토를 처리하지만 사용자가 봐야 할 항목만 요청 유형별로 UI에 표시한다. 승인 페이지가 사용자와 내부 통합 문제를 모든 사건에 대해 즉시 채팅하는 화면일 필요는 없다.

## 5. 데이터 계약 및 안전 조건

- 승인 대상은 인가된 프로젝트/Workspace의 `requestId`, `finalIntegrationPacketId`, `baselineRevision`, `uiRevision`, `manifestRevision`, `manifestHash`, `documentRevisionHashes`, QA/G7 evidence refs에 **결속**되어야 함. 이름은 논리 모델 예시.
- UI와 LLM 메세지가 아닌 **서버의 승인 API**가 최신 Revision·권한·CAS·게이트 상태를 원자적으로 검사하고 승인 이벤트를 발행한다.
- 새로운 독립 승인 DB/정식 설계서 중복 생성을 피하고 기존 Revision/CAS/Artifact/Document Center·감사 이력 저장 기능을 재사용한다.
- 동일 요청의 중복 승인 클릭, 재시도, 프로세스 재시작에 대한 멱등성 보장. 다수 탭/요청의 경쟁조건 처리.
- 사용자가 승인한 뒤라도 정식 QA 실패 또는 법적·계약상 외부 전달의 허가 상태를 바꾸거나 우회하지 않음.
- 패키지 후보가 바뀌면 기존 승인 요청은 `STALE`로 표시하고 변경본에 재승인을 받음.
- 접근 범위는 Core·SDK의 Primary/Workspace Shell/권한·파일 격리 계약을 우선으로 검증한다.

## 6. 인수 기준

- `AC-APP-01`: 좌측 Lead 항목에서 `최종 검토·승인` 페이지에 들어갈 수 있고, 실제 승인 요청이 없을 땐 빈 상태가 명확하다.
- `AC-APP-02`: Background와 Intake는 기존대로 사용자 일반 채팅에 노출되지 않으며 Lead 논리 세션 수는 6개로 유지된다.
- `AC-APP-03`: Final Integration Packet 미발행 또는 Lead Main G7 검증 미완료 상태에서 최종 패키지 승인 요청이 발행되지 않는다.
- `AC-APP-04`: 승인 요청에는 파일 목록/해시, 설치법·사용법, 제한사항, CI/E2E·QA/G7 증거 및 명세/문서 Revision이 포함된다.
- `AC-APP-05`: 승인된 자료는 문서 센터의 실제 정본을 참조하며 승인 페이지가 중복된 최신성 원본이 되지 않는다.
- `AC-APP-06`: 사용자의 승인·수정 요청·보류가 각각 서버 상태와 감사 이력에 반영된다.
- `AC-APP-07`: 필수 QA/G6/G7 실패·누락/UNKNOWN일 때 UI/직접 API 양쪽에서 최종 패키지 버전 승인 요청을 거부한다.
- `AC-APP-08`: 요청 당시 파일/문서/설계 Revision이 변경된 상태에서는 이전 승인 요청의 승인 시도를 거부하고 새 후보를 요구한다.
- `AC-APP-09`: 승인 이력은 승인자·시각·패키지 파일 및 문서 해시·참조 Revision과 연결되며 이력 수정 없이 새 버전을 승인할 수 있다.
- `AC-APP-10`: 패키지 버전 승인은 고객 전송/배포, 계약/결제, QA PASS의 자동 처리로 이어지지 않는다.
- `AC-APP-11`: CTO 간 계약 문제는 내부 Integration Review를 거쳐 필요시 Question Discussion으로 라우팅되고, 승인 페이지로 옮긴다는 이유로 기존 실패 처리 경로가 끊기지 않는다.
- `AC-APP-12`: 기존 Core/SDK의 권한·Workspace 격리·Primary/플러그인 UI 계약과 호환되고, 권한이 없는 Workspace의 승인 요청은 볼 수 없다.
- `AC-APP-13`: 동일 요청 재시도/중복 승인 및 프로세스 중단·복구에서도 공식 승인 버전은 중복 발행되지 않는다.
- `AC-APP-14`: 파일/설치법/사용법 변경에 대한 사용자 수정 요청은 관련 CTO/Integration Manager·Lead Main에 전달되고 영향받은 문서·테스트만 재검토된다.

## 7. CAO 개발용 Lead에게 전달할 구현 지시

1. **최신 통합 제품 계약**과 본 추가 결정을 대조한다. CAO의 임시 Agent 운영 UI를 Builder 제품에 그대로 이식하지 않는다.
2. 기존 `Lead Integration Review`를 일반 백그라운드 전용 논리 세션으로만 취급하지 않고, **`최종 검토·승인` 페이지를 소유한 Lead 6번째 세션**으로 수정한다. 신규 별도 AI/7번째 Lead 세션을 만들지 않는다.
3. Integration Manager·Lead Main·Question Discussion의 승인 및 설계 결정권 경계를 위 절차대로 유지한다.
4. Project Document Center v1.1의 문서 참조·최신성/Revision 모델을 우선 재사용한다.
5. UI 라우트·메뉴 배치는 실제 Core/SDK/Builder UI Shell의 적법한 확장 지점을 소스 감사 후 연결한다.
6. 서버 Gate·CAS·권한/Workspace 격리·불변 승인 스냅샷·Stale 처리 및 AC-APP-01~14를 검증한다.
7. 설계문서 통합, 코드 구현, 테스트 통과는 별도 증거로 보고한다. **문서 승인 자체를 구현 완료로 표시하지 않는다.**

## 8. 문서 정합성 수정 지점

- `SPS_Builder_Integration_Design_20261104.md` 1장 `Lead Integration Review`의 실행 설명을 **내부 이벤트 처리 + 사용자 승인 페이지**로 변경.
- 같은 문서 3.3절의 Lead wake 조건은 유지. 최종 G7 확인 뒤 `Lead Main → ApprovalRequest → Lead Integration Review UI` 연결 추가.
- 같은 문서 7장의 최종 반환에서 '사용자에게 최종 확인 요청'을 **승인 페이지에 불변 요청 게시**로 명확히 변경.
- CSAS G7과 Project Document Center의 최신성/승인 문서 정책을 일관 적용.
- 사용자 2026-11-05 결정에 근거한 설계 변경이다. 별도 채팅용 일곱 번째 Lead 세션 추가가 아니다.

