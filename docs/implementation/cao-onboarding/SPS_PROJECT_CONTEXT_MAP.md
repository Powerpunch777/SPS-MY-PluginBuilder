# SPS 프로젝트 맥락 지도

- 작업 기준: `BUILDER-CONTRACT-REPORTS`, Revision `V15-CSAS-V07-M1`; 공급된 공개 Builder 기준선은 [SPS-MY-PluginBuilder PR #2](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/pull/2), revision [`996c43f47ad68ba0a63c7bfbe14851e731a66891`](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/tree/996c43f47ad68ba0a63c7bfbe14851e731a66891)이다. URL은 제공된 저장소 식별자에서 구성했으며 이번 QA에서 원격을 조회하지 않았다. 이 작업의 checkout HEAD와 기준선 일치는 독립 검증하지 않았다.
- 근거 공개성: 코드/테스트/공백 표는 위 공개 기준선에 관한 제공 운영자 정적 감사 `Builder 전체 인수 기준 정적 감사`(SHA-256 `9d955a62e9391b3adbbaf5f1da37d1be6b65bd4c0760e1cb7b41836c14aabd7d`)에 근거한다. 감사 원문 및 입력 문서는 제공된 작업자료이며 공개 URL에서 열람 가능하다고 주장하지 않는다. 입력 원문은 `SPS_Builder_CSAS_Complete_Design_Reviewed_v0.7_2026-11-03.md` (SHA-256 `832b1f4a4884df8b12f5733ce60e951bfaa418f249c54c69e2646ca95c7070db`), 누적 v0.8 `SPS_Builder_CSAS_Complete_Design_Reviewed_v0.8_2026-11-03.md` (SHA-256 `bb5e723e1aa0408e4e91fcbad784d58acb27ed46f00a78b474b828ad58be9de7`)이다. 비공개 온보딩 입력은 공개 문서라고 가장하지 않고 이 작업에 제공된 참고자료로만 사용했다.
- 운영자 관찰 참고자료는 「Operator-Observed SPS Context」(2026-11-03, SHA-256 `5b13db3796916f5c362ee1ef4536a08ff0fa16a7f072b1aec7af98f3d9c9cfc0`)다. 이는 공개 저장소 원문 검증이 아니라 출처 추적 가능한 제공자료다.
- 코드 분류의 기준선: `CONFIRMED_CODE`는 위에 명시한 공급 Builder revision에 대해 제공 정적 audit이 수행한 코드 대조를 귀속한다. 현재 checkout `HEAD`의 독립 git 검증이나 각 항목의 별도 재검증을 뜻하지 않으며 checkout 기준선 여부는 `NOT_VERIFIED`다. 이번 QA는 제품 코드 검증을 수행하지 않았다.
- 분류: 아래 구현 관찰의 `CONFIRMED_CODE`는 현재 작업 디렉터리에서 독립 확인한 결과가 아니라 공급 Builder 기준선에 대한 제공 정적 audit의 귀속이다. 공급 문서 내용은 `DOCUMENTED_ONLY`; 제공 기록이 가리키는 별도 Core/SDK 소스 미열람 사항은 `UNKNOWN` 또는 `CONFLICT`다.

## 역할과 데이터 흐름

| 영역 | 책임/관찰 | 분류·출처 |
|---|---|---|
| SPS Core | Host/Workspace, Plugin lifecycle, 권한 및 실제 실행 계약의 소유자로 제공된 온보딩 참고문서 §3–6이 규정한다. Core 원문은 제공되지 않았다. | `DOCUMENTED_ONLY` — 사용자 제공 `SPS_CAO_Lead_SPS_Project_Contract_Onboarding_2026-11-03.md` (SHA-256 `96b07af6b1b74646b3e85378fde2921861d44d4bd4cdb4de825ed53d693df12d`); 실제 대상 계약 `UNKNOWN` |
| SPS SDK | 공개 SDK facade/capability 계약의 소유자로 제공된 온보딩 참고문서가 규정한다. package pin은 `c69915a518f0eb600f0ace8238144059911f8d04`라고 기록돼 있으나 SDK API 원문을 이 QA에서 독립 검사하지 않았다. | `DOCUMENTED_ONLY` — 사용자 제공 온보딩 참고문서 및 공개 Builder 기준선의 SDK pin; 호환성 `UNKNOWN` |
| Builder | 설계 초안·결정·기준선·세션·CTO 질문·Workstream/Task Packet 계획 자료의 제품 의미를 가진다. 공급 기준선 감사는 `src/`의 도메인/도구/플랫폼 코드 경로를 인용한다. | `CONFIRMED_CODE` — 공급 revision `996c43f47ad68ba0a63c7bfbe14851e731a66891` 기준의 `src/manifest.mjs`, `src/platform.ts`, `src/domain/*`, `src/*-tools.ts`; checkout HEAD 별도 확인 `NOT_VERIFIED` |
| CAO 임시 조직 | 이 작업의 Lead/CTO/Worker 실행 관계이며 Builder 제품의 내부 역할 계약과 동일시하지 않는다. | `DOCUMENTED_ONLY` — 사용자 제공 v0.8 §0.1 및 온보딩 참고문서 §4; 비공개 참고문서의 공개 접근을 전제하지 않음 |
| GitHub/Runner | v15의 납품/CI 경계. 현재 Builder Runner 및 외부 실행 연결은 공급 정적 감사에서 미연결로 기록된다. 이 작업에서 전체 저장소를 다시 인수 시험하지 않았다. | `DOCUMENTED_ONLY` — operator audit §근거 묶음; 런타임 인수 `UNKNOWN` |

## 공급 공개 기준선에서 확인한 경계

- `parseLeadSessions`는 세 채널(`main`, `cto-inbox`, `decisions`)만 허용한다. `resolveLeadToolAuthority`는 `LEAD_CHANNELS` 전체를 현재 세션 권한 확인에 사용한다. `src/domain/lead-sessions.ts`, `src/lead-tool-authority.ts` — `CONFIRMED_CODE`.
- Lead의 정적 도구 목록은 `LEAD_PLANNING_TOOL_NAMES`이며 실행 정책은 이 공통 목록을 사용한다. 새 역할별 컨텍스트/권한 검토에서는 채널 검사와 이 도구 집합 모두를 재평가해야 한다. `src/session-execution-policy.ts` — `CONFIRMED_CODE`.
- Task Packet 스키마는 개발/QA 계획, acceptance/evidence 및 test plan 필드를 저장하지만 실제 Worker 실행의 증명이 아니다. `src/domain/task-packets.ts`, `src/task-packet-tools.ts` — `CONFIRMED_CODE`; 실행 Gate 전체는 `UNKNOWN`.
- Builder UI와 manifest는 제품 표면 및 선언 capability를 제공하지만, 존재만으로 Core의 실행/권한/격리 동작이 검증되지는 않는다. `src/platform.ts`, `src/manifest.mjs` — `CONFIRMED_CODE`.

## 후속 설계의 보존 조건

사용자 후속 결정은 기존 3개 대화 화면 보존 후 명시적 선택으로 별도 5-context를 시작하도록 한다. 기존 기록/ID/provenance/receipt/reference 보존, 이름 기반 자동 매핑 금지, 중복 생성 방지가 적용된다. 읽기전용 강제, 자동 링크/이관/삭제/병합, 취소·재전송, 자동 AI 실행은 승인되지 않았다. 세부 UX는 미결정이다. 출처: 사용자 제공 「후속 사용자 확정 답변」(2026-11-03), operator directive SHA-256 `f8e2ad0ede6e3b6a336a18ed32e94e187a625c5f526b1925d0014c16e5cb1396`; `DOCUMENTED_ONLY`.
