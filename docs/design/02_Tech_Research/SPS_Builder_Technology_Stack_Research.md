# SPS Builder 기술 스택 조사·선정 결과 (2026-10-29)

> **출처:** SPS Plugin Builder 통합 설계서 v15의 `§3A` 발췌. 프로그램/스택의 공식 기능 조사와 실제 SPS Core 통합 검증은 다르다.

---

## 3A. 2026-10-29 기술 스택 선정 명세 — 공식 문서 조사 결과 (v15)

> **용도:** 개인 전용 Builder *자체 구현*에 적용할 기술 선정 명세. 고객에게 납품할 S/M/L/XL 제품의 스택을 하나로 강제하지 않는다. 이 표의 `required`는 설계상의 목표이며 **SPS Core/SDK와 실제 버전 호환성 검증을 거쳐서 확정 구현**한다. `allowed`는 CTO가 범위 안에서 판단한다. `prohibited`는 본 제품의 기본 구현에서 사용하지 않는다는 뜻이며 특정 고객 계약이 요구하면 별도 기술 결정/명세 개정 후 검토한다.

### 3A.1 우선 채택 기술 (필수 / 구현 검증 조건부)

| 영역 | 프로그램·스택 | 선정 상태 | 선택 이유·구현 경계 | 검증·위험 |
| --- | --- | --- | --- | --- |
| 호스트 / 플러그인 | **SPS Core + `@sonparkserver/plugin-sdk` Extension Profile v2** | **required** | Core를 수정하는 별도 앱이 아니라 Host에서 Workspace별로 활성화되는 사설 Builder 플러그인. SDK의 Manifest·Worker·Runtime·UI Bridge·Test Kit·Preview·Packaging 활용 | 공개 SDK가 Profile v2·도구/실행/상태·패키징 계약을 제공함을 확인. Host가 필요한 UI Shell/Primary/메모리 계약을 실제 지원하는지는 **Core CI 및 현행 Host에서 재확인** |
| 언어 / 런타임 | **Node.js 22+ / TypeScript / ESM** | **required** | 공개 SDK의 Node 22 이상 및 ESM Worker 번들에 맞춤. 새 백엔드 런타임을 추가하지 않음 | SDK 템플릿·현재 Core 빌드 구성과 버전 범위를 맞춘 뒤 잠금 파일로 고정. TS·Node 최신 버전 무조건 추종 금지 |
| 플러그인 UI | **기존 SPS UI Bridge + Host가 지원하는 React UI** | **required (호환성 조건)** | 기존 Core 화면·좌측 메뉴·설정 진입을 재사용. v9 UI 레이아웃 유지, 중복 React Runtime/독립 Electron 창 생성 금지 | 공개 SDK UI Bridge는 제공되나 실제 Host UI ABI 및 React 주입·번들 방식 확인 필요 |
| 설계 지도 | **`@xyflow/react` (React Flow)** | **required** | 사용자 조회/줌/이동/기능 선택·Lead 수정 결과의 렌더링. **사용자 수동 Graph 편집 비활성** | MIT. 기존 UI의 3가지 설계 관점만 표시, Graph 데이터 원본으로 사용하지 않음 |
| 그래프 자동 배치 | **`elkjs` (ELK.js)** | **required (라이선스 확인)** | 기능 DAG·CTO 영역 배치. 편집 UI 대신 Lead Graph Patch의 시각적 위치 계산 | **EPL-2.0** 라이선스 고지·변경/재배포 의무 확인 후 의존성 고정; React Flow Pro 유료 예제 코드는 무단 복제 금지 |
| AI 실행 / 세션 | **Codex CLI + 공식 `@openai/codex-sdk` 또는 Codex app-server** | **required 기능 / 어댑터 선택 조건부** | Codex Harness 재사용, Lead 세 대화 세션·CTO 한 세션·Worker/QA 실행. **기본 초기 검증은 SDK**, 앱 내부의 전체 메시지·상태·승인/취소·실시간 이벤트가 필요하면 **app-server 우선 검증·채택** | TypeScript SDK는 시작/이어하기/재개 가능. app-server는 thread/read·turn/items/events 제공. 프로토콜/버전 성숙도와 Core의 기존 Codex Adapter 중복 여부 검증. **구현에서는 한 주 실행 경로만 선택** |
| 하위 Worker / QA | **Codex native subagents + `AGENTS.md`·`SKILL.md`** | **required 기능 / 세부 구성 조건부** | CTO 단일 세션에서 Worker/QA를 생성·병렬 작업, QA는 CTO의 테스트 계획만 실행. 새 Agent 프레임워크 금지 | Codex는 서브에이전트 지원. **상위 CTO별 독립 메모리, 각 Worker의 이력 노출, 재시작 후 작업 복원**은 Builder 기록과 실제 API로 검증; CLI 서브에이전트마다 독립 OS 격리 보장된다고 가정 금지 |
| 소스·CI·테스트 실행 | **Git + GitHub PR + GitHub Actions + Self-hosted Runner** | **required (고객별 반출 정책 예외)** | 기존 Actions Workflow·`needs`·matrix·Artifacts·Checks 활용. CTO가 Test Plan 작성, QA가 실제 Runner 작업 트리거 및 증거 회수 | Repository/Runner 권한·보안·고객 프로젝트 간 환경 격리 실증. 고객이 GitHub 사용 금지 시 프로젝트별 ADR 필요 |
| GitHub API | **GitHub REST API + 기존 SPS GitHub Adapter, 부족할 때 `@octokit/rest`** | **required 기능 / 구현 allowed** | PR·Run·Job·Checks·Artifacts·Runner 상태를 필요한 만큼만 조회. 직접 HTTP로 해결되면 Octokit 추가하지 않아도 됨 | Runner 조회에 Repository Administration(read) 권한 필요할 수 있음. GitHub App 또는 최소권한 인증 채택, Host Secret 참조만 저장 |
| 원격 관리/배포 | **Tailscale + OpenSSH** | **allowed (배포에 한함)** | Tailnet 내부 장비/서버 접속에만 사용. GitHub Runner 등록·Job 할당에는 필요 없음 | Windows의 Tailscale SSH Server 기능을 기본 가정하지 않음. Runner에 운영 서버 관리자 계정 제공 금지 |

### 3A.2 Core 재사용 우선 / 세부 구현 선택

| 범위 | 기본 선택 | 결정 | 새로 만들지 않을 것 |
| --- | --- | --- | --- |
| 작업·Graph·Revision·질문·승인 기록 | **Builder 고유 타입/데이터 + SPS SDK `platform`의 scoped state/events 등 검증된 저장·이벤트 원시 기능** | **required (저장 어댑터 조건부)** | 범용 Graph DB·Redis·PostgreSQL·이벤트 버스·작업 서버. **SDK가 Task/Role/Memory를 직접 제공하는 것은 아님** |
| Lead 공유 기억 / CTO별 기억 / Worker 격리 | Core 기본 Memory가 실제 제공하는 scope·권한이면 재사용, 아니면 SDK 범위 내 Builder 전용 구조화 상태로 최소 구현 | **required 경계 / 구현 undecided** | 고객별 데이터를 합친 글로벌 메모리 DB·학습 서버·자동 공유 |
| Schema 검증 | SDK의 공식 타입·검증 함수를 먼저 활용, 프로젝트 추가 Schema는 JSON Schema/TypeScript 검증; **Zod는 기존 Core 의존성 및 보안·호환성 확인 후에만 allowed** | **allowed** | 동일 계약을 검증하는 중복 스키마 엔진. Zod 필수 종속화 |
| 번들 / 테스트 / 패키징 | SPS SDK `sps-plugin` CLI (`build`/`validate`/`test`/`pack`), 기존 `npm`/Node `node:test`; UI E2E는 현행 Playwright 경로 확인 | **required / allowed** | 신규 패키저·자체 Release 서버. SDK `test`를 실제 E2E 또는 Core compatibility의 대체로 오해 금지 |
| 고객 상담 입력 | 사용자가 선택해 제공한 파일·붙여넣기 → Builder parser → Lead. 크몽 공식 내보내기 확인 시만 API/Export 연동 | **required 최소 기능 / 외부 연동 undecided** | Document Worker·상시 크롤러·무허가 대화 추출·브라우저 로그인 우회 |
| 외부 후보 도구 | Hermes Agent·OpenClaw·OCE·n8n 등은 **고객 납품물의 요구에 따라 개별 채택** | **allowed (프로젝트별)** | 이들을 Builder 내부 필수 백엔드·에이전트 실행기로 상시 설치 |

### 3A.3 명시적 비채택 목록

- **prohibited (기본 설계):** 별도의 Electron/Tauri 데스크톱 앱, 독립 Next.js SaaS 프런트/백엔드, 자체 AI Harness·LangGraph/Paperclip/AutoGen 대체 오케스트레이터, 범용 Redis/RabbitMQ/Temporal 작업 큐, 자체 Git/Runner Fleet/CI 서버, 별도 Graph DB/Vector DB/검색 서버, 자체 VPN/SSH 서버, 공개 Marketplace·결제 서버, Document Worker AI.
- **중요한 예외:** 위 비채택 목록이 **고객에게 제작·납품하는 제품의 기술 선택을 제한하지 않는다**. Builder 자체에는 쓰지 않지만 고객 계약 또는 기존 SPS Core 구현이 정당한 필요를 입증하면 승인된 Technology Decision Register를 개정한다.
- **라이선스:** React Flow MIT, Octokit MIT, Zod MIT, SDK Apache-2.0, `elkjs` EPL-2.0은 용도·수정·배포 형태가 다르므로 패키지 버전별 `LICENSE/NOTICE` 원문을 Release 전 재검토한다.

### 3A.4 아직 코드/실행 환경에서 검증되지 않은 필수 점검

1. `Powerpunch777/SPS-Source` **현재 비공개 또는 비검색 소스**의 package.json, 플러그인 Host ABI, UI Bridge, Primary Workspace 활성화, 기존 Codex/Memory/GitHub Adapter를 직접 감사한다. **공개 `Powerpunch777/SPS` 저장소는 소개/문서이며 최신 Core 실제 소스가 아니다.**
2. 공개 `sps-plugin-sdk`의 **Profile v2 / Node>=22 / ESM / typed authoring contract**는 확인되지만 실제 개발 중인 Core의 특정 Commit과 호환되는지는 `SPS Core compatibility`와 SDK conformance로 확인한다.
3. Codex CLI의 **서브에이전트 하위 세션 ID·이력 조회 가능 범위**를 샘플로 실증한다. 앱서버의 thread/read 및 이벤트 API가 사용자 UI의 '읽기 전용 하위 AI 전체 대화' 요구를 충족하는지 검증한다. **Native subagents의 이벤트가 항상 완전한 원문 대화 기록을 제공한다고 가정하지 않는다.**
4. Lead 세 세션이 **같은 Workspace 승인 기억을 원자적으로 공유**하고 CTO별 기억·Worker 이력이 다른 범위를 침범하지 못하는지 권한 및 동시 수정 테스트로 확인한다.
5. 자체 호스팅 Runner는 GitHub가 제어·실행하는 기반이지 **고객 코드 실행의 자동 클린룸**이 아니다. 다른 고객을 번갈아 테스트하면 외부 비밀 및 작업 파일 분리를 검증한다.
6. 크몽의 공식 API/Export와 자동 처리 이용약관은 **현재 미확인**이므로 고객이 적법하게 제공한 원문 파일/붙여넣기를 기본 입력으로 한다. 내보내기 지원 여부를 추정하지 않는다.
7. 선택한 버전/프로토콜/SDK/API는 `Technology Decision Register`에 버전 범위·채택 이유·비채택 이유·검증 결과·발견된 제약·다음 검토 조건을 기록한다. 공식 문서로 기능을 확인한 것과 **실제 SPS에 통합 테스트가 통과한 것**을 혼동하지 않는다.

### 3A.5 확인한 1차 자료 (2026-10-29 조회)

- SPS Plugin SDK 공개 계약 / Profile v2 / Node22 / ESM / Authoring / UI Bridge: https://github.com/Powerpunch777/sps-plugin-sdk
- 공개 SPS 제품 문서(실제 Core 소스 미포함): https://github.com/Powerpunch777/SPS
- Codex 공식 TypeScript SDK: https://learn.chatgpt.com/docs/codex-sdk
- Codex app-server (thread/read, events, approvals): https://learn.chatgpt.com/docs/app-server
- Codex native subagents: https://learn.chatgpt.com/docs/agent-configuration/subagents
- Codex Harness 재사용 의사결정: https://developers.openai.com/blog/codex-as-a-platform
- React Flow (`@xyflow/react`, MIT): https://reactflow.dev/
- ELK.js (`elkjs`, EPL-2.0): https://github.com/kieler/elkjs/blob/master/LICENSE.md
- GitHub Actions self-hosted Runner / 격리: https://docs.github.com/en/actions/reference/runners/self-hosted-runners
- GitHub REST Runner API/권한: https://docs.github.com/en/rest/actions/self-hosted-runners
- GitHub REST Workflow Run API: https://docs.github.com/en/rest/actions/workflow-runs
- GitHub App 인증: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app
- Octokit REST Client: https://github.com/octokit/rest.js
- Zod (선택적, MIT): https://github.com/colinhacks/zod

