# SPS Plugin Builder 설계 분석 — 2026-10-29

이 문서는 2026-10-29의 분석 기록이다. 이후 사용자 요청에 따라 설계 자료와 이 보고서를 Builder 저장소에 문서 커밋으로 보관했다. 최신 Core 선행사항 분류는 [별도 문서](CORE_PREREQUISITES_2026-10-29.md)를 따른다.

최초 분석 시점에는 Builder 구현·의존성 설치·코드 수정·테스트·CI 실행·GitHub 쓰기·커밋을 하지 않았다. 문서 보관 이후에도 제품 구현은 시작하지 않았고, 기존 SPS Core 장기목표의 일시 중지 상태를 유지했다. 압축 문서의 구현 명령은 검토할 설계 내용으로 읽었으며 실행 지시로 사용하지 않았다.

검토 자료는 v15 설계서, 기술 스택 조사서, UI v9 HTML의 전체 소스와 README다. HTML을 실제 브라우저에서 렌더하거나 클릭하여 검증한 것은 아니다. 아래 UI 판단은 소스 기준이다.

대조 기준은 로컬 Source `73d5c09e293f9cdb31318ab7f18dca5022e04803`, Core `40199c6e55e956c31381e2377860baa78bc7cabb`, SDK `61a929f6c783f78e5af603682de1543c7e24abc0`다. 이는 마지막 Core 작업을 로컬에 저장한 상태이며 원격 CI로 검증된 이전 조합과 동일하지 않다. `SPS-MY-PluginBuilder`는 GitHub 조회에서 `isEmpty: true`로 확인했다. 새 저장소에 기존 Builder 구현이 있다는 전제는 사용할 수 없다.

## 판단

제품 방향은 현재 SPS와 맞는다. 개인 외주 사업용 Builder를 하나의 SPS 플러그인으로 두고, Core는 공통 실행·권한·Workspace 기능을 제공하며, Builder가 고객 요구·설계·작업 배정·인수 근거를 소유하는 구조가 적절하다. 고객 납품물은 SPS 플러그인 외에 앱·웹/API·CLI/자동화도 포함한다. 개발에 AI를 쓰는 것과 납품물의 AI 의존성은 분리돼 있다.

문서를 그대로 옮기면 즉시 작동하는 수준의 구현 명세는 아니다. 문서 자체도 이를 명시한다. 부족한 부분은 화면 수보다 저장 동시성, 세션 복구, 역할별 실제 쓰기 권한, 외부 실행 증거의 연결 계약이다. 이 경계를 먼저 구체화해야 기존 기능 재사용이 개발시간 절감으로 이어진다.

## 확정 방향으로 유지할 내용

- 고객 프로젝트마다 SPS Workspace 하나를 기본으로 사용하고 Builder 패키지는 Host에 한 번 설치한다.
- Lead는 사용자 대화·CTO 질문 수신·미결정사항 대화의 3세션을 사용하며 같은 프로젝트의 Lead 기억을 공유한다.
- 각 CTO는 단일 세션, Worker/QA는 각자 독립 세션을 사용한다. CTO의 정체성과 기억은 프로젝트별로 구분한다.
- Lead가 필요에 따라 별도 사용자 승인 없이 CTO를 생성한다. 이미 결정된 이 정책을 미결정 질문으로 되돌리지 않는다. 실행 권한·자원·비용 제한은 별도 집행한다.
- Lead가 설계 구조와 기술 결정을 관리한다. CTO는 담당 기능의 실행·배정·검증 사실을 기록하며 구조 변경은 제안으로 전달한다.
- 사용자 답변은 추가 재승인 없이 설계 Revision에 반영할 수 있다. 계약 발송·체결, 운영 배포·파기 등의 권한 행위는 구분한다.
- React Flow는 조회·시각화 계층이다. 명세·Graph가 원본이며 화면 좌표·외부 CI 상태는 별도다.
- QA는 CTO의 TestPlan을 실행하며 합격 기준을 임의로 낮추지 않는다.
- 공개 Marketplace, 글로벌 CTO 인사/고객 기억 통합, Document Worker, 상시 상담 크롤러, 자체 CI·Runner Fleet·VPN·범용 Agent 런타임은 만들지 않는다.

근거: [설계 정책](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md#L21), [Workspace](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md#L197), [세션·기억](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md#L422), [확정 정책과 잔여 검증](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md#L1233).

## 실제 코드에서 재사용할 기반

| 영역 | 확인된 기반 | Builder에서 별도로 해야 할 일 |
| --- | --- | --- |
| 패키지와 Workspace | Host 설치, Workspace별 활성화·설정, 선언된 workspaceWorker의 전용 실행 | 고객·프로젝트 모델과 Core Workspace ID 매핑 |
| 기본 화면 | Workspace Shell provider 0~1개 선택, neutral fallback | 설치·활성화와 Shell 선택을 구분한 사용자 흐름 |
| 저장·이벤트 | plugin-scoped get/set/delete와 이벤트 | Graph/Spec/질문/역할/승인 모델, Revision·동시성·복구 |
| Agent 실행 | SDK의 세션 create/list/send/getRun/cancel 및 Core Codex 어댑터 | Lead/CTO/Worker 조직 모델, 완전한 이력·재개 지원 확인 |
| 제작 도구 | SDK authoring·번들·validate/test/pack·Preview 관련 코드 | 다양한 납품 Target의 작업·검증·납품 연결 |
| 기존 Builder | Source의 `sps.plugin-discovery`에 대화·위임·초안·Preview 관련 구현 | 새 제품에 필요한 부분의 이전/어댑터화; 새 설계 전체를 기존 완성 기능으로 간주하지 않기 |
| 원격 실행 | SPS Node/Runner Profile·grant·실행 계약 | GitHub Actions Runner 등록·상태·Workflow/Checks/Artifacts API 연결 |

Core 코드 근거:

- Workspace worker (`SPS-Source/external/sps-core/server/src/services/sps-workspace-plugin-workers.ts:73`)
- Shell 조회·선택 (`SPS-Source/external/sps-core/server/src/services/sps-workspace-surfaces.ts:186`), Host Shell route (`SPS-Source/external/sps-core/server/src/routes/sps-workspace-surfaces.ts:58`)
- SDK state·session 계약 (`SPS-Source/external/sps-plugin-sdk/platform/index.d.ts:11`)
- 기존 Builder 대화 구현 (`SPS-Source/sps-server/sps-plugin-discovery/src/builder-chat.js:183`)
- 기본 비활성/opt-in 번들 (`SPS-Source/sps-server/desktop/src/bundled-extensions.mjs:14`)
- 현재 Codex 실행 어댑터 (`SPS-Source/external/sps-core/packages/adapters/codex-local/src/server/execute.ts:741`)

문서의 Primary에 대응할 기본 Shell 선택 기반은 존재한다. 별도 `Primary`라는 export가 없다는 이유로 기능 전체를 없다고 판단하면 안 된다. 반대로 `companyActivation.defaultEnabled`를 켰다고 기본 Shell까지 자동 지정되는 것도 아니다.

설계상의 SPS Workspace는 Core의 companyId 경계에 연결해야 한다. Core의 소스 실행용 project workspace, Git worktree, GitHub Runner 작업 디렉터리와 동일 개체로 취급하면 권한·정리 범위가 섞인다.

## 구현 전에 해결할 핵심 계약

**1. Lead 공유 기억과 불변 Revision의 동시 쓰기**

SDK state는 get/set/delete이며 expectedRevision·CAS가 없다. Core state store도 같은 composite key가 충돌하면 값을 교체하는 upsert다. 세 세션이 각각 읽고 수정한 값을 저장하면 마지막 쓰기가 다른 결정을 지울 수 있다.

권장 방향은 Workspace별 단일 작성자와 불변 Revision을 우선 검토하고, 승인 근거·Graph 변경·현재 Revision 포인터의 원자성 및 재시작 규칙을 정하는 것이다. 기존 계약으로 충족하지 못하는 것이 확인되면 일반적인 조건부 쓰기 계약만 Core 확장 후보로 삼는다. 별도 DB·Redis·대형 큐를 먼저 추가할 이유는 없다. 단순 프로세스 내부 잠금만으로 재시작·여러 작성자의 영속 동시성이 해결됐다고 표시해서도 안 된다.

근거: SDK state 계약 (`SPS-Source/external/sps-plugin-sdk/platform/index.d.ts:20`), Core state 쓰기 (`SPS-Source/external/sps-core/server/src/services/plugin-state-store.ts:120`), [설계의 공유 기억](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md#L455).

**2. 역할 권한은 프롬프트와 실제 액션 권한을 분리**

Lead만 Graph 구조를 바꾸고 CTO는 진행 상태만 바꾸도록, 서버 측에서 변경 필드·담당 범위·명세 Revision·실제 세션/실행 정체성을 검사해야 한다. 요청 본문에 적힌 `role: lead`나 AGENTS.md 지침만으로 권한을 인정하면 안 된다. CTO 자동 생성은 별도 재승인 없이 하되 중복 생성 방지, 동시 실행 상한, 비용 한도와 한도 도달 동작은 필요하다.

**3. Codex의 세션·이력·복구 계약**

SPS의 기존 Agent 세션과 Codex의 thread는 자동으로 동일한 것이 아니다. `(Workspace, Builder role/session, Core session/run, Codex thread, Task)` 매핑과 재개 실패 동작이 필요하다. native subagent라는 이름만으로 Worker별 기억 접근이 제한되거나 모든 대화 이력이 UI에 제공된다고 볼 수 없다.

공식 문서는 SDK를 작업 자동화에, app-server를 인증·대화 이력·승인·실시간 이벤트를 갖춘 제품 클라이언트에 사용하도록 구분한다. 설계의 전체 이력·승인·취소 UI를 보면 app-server를 비교 검증할 가치가 크지만, 기존 Core 어댑터를 버리거나 두 실행기를 동시에 구현할 결론은 아니다. 고정할 버전에서 필요한 기능을 확인하고 주 실행 경로 하나를 정해야 한다. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [app-server](https://learn.chatgpt.com/docs/app-server)

app-server의 thread 조회·turn/item 이력과 하위 thread 필터 기능은 공식 문서에 있다. 하위 thread 필터 중 일부는 experimental이며 설치 버전과 API 범위를 확인해야 한다. Lead 공통 기억은 대화 thread들을 무차별 합치는 방식으로 대체하지 않는다. [공식 thread API](https://learn.chatgpt.com/docs/app-server), [하위 에이전트 권한 상속](https://learn.chatgpt.com/docs/agent-configuration/subagents)

**4. SPS Runner와 GitHub Runner를 분리**

같은 PC에서 두 실행기가 동작할 수 있지만 ID·권한·등록 상태·취소 대상은 별개다. Builder 시스템 화면의 GitHub online/busy를 SPS Node의 실행 가능 상태로 대체하면 안 된다. GitHub가 원본인 Run/Job/Check는 repository·정확한 commit·실행 attempt·spec Revision에 연결해야 한다. GitHub Runner 할당은 라벨·그룹·online/idle 상태를 사용하는 별도 계약이다. [GitHub Runner 공식 문서](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)

**5. 명세 개정과 진행 상태의 독립 버전**

세 가지 Graph 화면은 하나의 설계 데이터에서 파생하고, CTO별 진행 상태는 별도 실행 기록으로 둬야 한다. 사용자 답변이 명세를 바꾸면 이전 Task·QA 결과는 당시 Revision/commit에 계속 연결하고, 새 명세에도 유효한지 별도로 판정한다. `Run 성공`을 `고객 기능 인수 완료`와 같게 취급하지 않는다.

**6. 승인 증거·납품 범위**

사용자 답변을 내부 설계 결정으로 반영하는 정책은 이미 정해져 있다. 다만 답변자·질문/결정 ID·영향 범위·부모 Revision을 연결해야 한다. 외부 계약·배포·파기는 별도 행위다. 납품 Target별 버전·해시·설치/업데이트/롤백·수동 인수 근거도 필요하다. 문서의 예시 ReleaseEvidence만으로 모든 Target의 설치 수용 계약이 완성된 것은 아니다.

**7. 고객 자료·파일·HTML Preview·인증 프로필**

상담은 사용자가 제공한 파일/붙여넣기로 시작할 수 있다. 크몽 Export/API는 문서도 미확인이라고 명시하므로 지원을 전제로 잡지 않는다. 원문·순서·작성자·출처·사용자 선택 범위·중복 가져오기 처리를 연결하고, 내용의 지시가 시스템 정책이나 승인으로 승격되지 않게 한다.

생성 HTML은 검증된 artifact·Workspace·Lead 세션·Revision과 연결한다. prototype의 sandbox iframe은 UI 접근법을 보여줄 뿐 실제 Core Preview의 네트워크·파일·인증 차단 증거는 아니다. CLI 프로필도 자격증명 보관, 역할 기억, 프로젝트 자료를 별개로 다뤄야 한다. 기존 보안 브로커/프로필 코드를 우선 확인하고 AI에게 auth 파일 원문을 넘기지 않는다.

## UI v9 해석

화면은 Lead 중심 대화, 오른쪽 변경/작업 기록, 세 가지 Graph 관점, 읽기 전용 하위 AI 조회, 미결정사항, 설계 문서, 시스템/Runner 조회로 구성된다. Document Worker가 빠진 현재 정책과 대체로 맞는다.

실제 구현된 시연은 정적 프로젝트 객체의 전환, 키워드 기반 대화 응답, 메모리 안에서의 변경/질문 상태 조작, SVG/DOM Graph, 정적 Runner 목록, 샘플 HTML 뷰어다. 실제 AI·GitHub·SPS 연동·영속 승인·React Flow·Lead artifact 조회는 구현돼 있지 않다.

근거: [정적 데이터와 응답](../design/03_UI/SPS_Builder_Lead_UI_v9.html#L234), [변경 승인 데모](../design/03_UI/SPS_Builder_Lead_UI_v9.html#L331), [Graph](../design/03_UI/SPS_Builder_Lead_UI_v9.html#L339), [Runner](../design/03_UI/SPS_Builder_Lead_UI_v9.html#L431), [샘플 HTML](../design/03_UI/SPS_Builder_Lead_UI_v9.html#L451).

제품으로 옮길 때는 다음을 명확히 해야 한다.

- `변경안 승인` 버튼이 코드 변경 승인인지, 외부 배포 승인인지, 아직 결정되지 않은 설계 제안인지 구분한다. 이미 사용자가 답한 설계를 다시 승인받는 기능으로 만들지 않는다.
- 실제 하위 대화 이력이 없으면 요약·샘플을 전체 원문처럼 보여주지 않는다.
- GitHub/Codex 연결 실패·미확인·재연결 상태와 마지막 확인 시각을 표현한다.
- 선택 Workspace의 artifact가 없으면 샘플을 실제 Lead 결과로 대체하지 않는다.
- 시안의 레이아웃을 먼저 보존하고, 불필요한 새 메뉴·Graph 편집 팔레트를 늘리지 않는다.

## 스택 및 라이선스 판단

Node 22+·TypeScript·ESM, 현재 SPS SDK·Host React UI Bridge·Preview/패키징을 재사용하는 방향은 기존 코드와 맞는다. Node 22는 현재 SDK Worker 번들 target에도 있다. Host React ABI·번들 외부화는 실제 연결 검증이 필요하다. SDK 로컬 버전은 미출시 0.11.0이므로 설계에 적힌 공개 일반 지원을 특정 Core 조합의 통과로 바꾸어 말하지 않는다.

React Flow는 MIT다. ELK.js는 EPL-2.0이며 MIT가 아니다. 라이선스 차이는 확인했으며 후속 사용자 지시 ‘라이선스는 괜찮아’에 따라 설계 채택의 차단 사유로 삼지 않는다. 개별 구성요소의 라이선스 고지와 실제 사용 시 준수 사항은 유지한다. 현재 시점에 패키지를 설치하거나 대체재를 확정하지 않았다. [React Flow 공식](https://reactflow.dev/), [ELK.js LICENSE](https://github.com/kieler/elkjs/blob/master/LICENSE.md)

SPS Plugin SDK의 package.json은 Apache-2.0을 명시한다. 따라서 ‘모든 기반이 MIT’라고 표현할 수 없다. 이 사실은 SPS SDK를 사용하지 말라는 뜻이 아니라 라이선스 기준을 구성요소별로 정확히 적용하자는 뜻이다. 로컬 SDK package.json (`SPS-Source/external/sps-plugin-sdk/package.json:7`)

Octokit은 기존 연동에서 부족한 경우에만 검토한다. Zod는 문서에서도 필수가 아니고 Core의 기존 보안 문제가 남아 있으므로 Builder 신규 의존성으로 자동 채택하지 않는다. 별도 Electron/Next/DB/큐/Agent 프레임워크를 추가할 근거는 현재 자료에서 확인되지 않았다.

## 향후 구현 착수 시 권장 순서 — 아직 실행하지 않은 제안

1. 현재 Core·SDK 조합을 고정하고, 새 Builder 저장소가 기존 제작 도구와 어떤 코드를 재사용할지 목록을 확정한다.
2. 한 패키지를 두 Workspace에서 활성화·Shell 선택·저장·중지하는 최소 연결로 기본 경계를 검증한다.
3. Graph/Spec/질문/승인과 역할별 쓰기 권한, 단일 작성자·Revision·재시작 규칙을 확정한다.
4. 실제 Codex에서 Lead 3세션·CTO 1세션·하위 실행·이력·취소·재개를 검증하고 주 실행 경로를 고른다.
5. GitHub 한 저장소·한 Workflow와 요구사항 하나를 연결해 정확한 소스/검증 근거를 수집한다.
6. v9 화면에 실제 상태를 연결하고, 상담 → 설계 개정 → 구현 → QA → 사용자 인수 → 납품의 전 구간을 검증한다.

이는 최종 요구사항을 빼거나 재설계하자는 제안이 아니라, 118개 인수 기준을 실제 의존 순서로 나눠 확인하자는 제안이다. 현재는 문서·코드 읽기와 공식 자료 확인만 했으므로 인수 테스트의 실행 통과를 주장하지 않는다.
