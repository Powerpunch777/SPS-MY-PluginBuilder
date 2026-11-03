# Builder v15 및 CSAS v0.8 통합 추가 노트 — 2026-11-03

이 문서는 v15 및 UI v9 원본을 바꾸지 않는 추가 노트다. 제품 요구의 출처는 통합 설계 v15, 동봉 CSAS v0.7, 누적 개정 CSAS v0.8과 후속 사용자 확정 운영자 지시다. 구현 진술은 별도 코드 근거가 표시된 항목만 `CONFIRMED_CODE`로 본다.

## 기준선과 출처 한계

코드/테스트/공백 대조의 공급 공개 기준선은 [SPS-MY-PluginBuilder PR #2](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/pull/2), revision [`996c43f47ad68ba0a63c7bfbe14851e731a66891`](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/tree/996c43f47ad68ba0a63c7bfbe14851e731a66891)다. 링크는 제공된 repository identity로 구성했으며 이번 QA가 원격을 조회한 것은 아니다. checkout HEAD 독립 확인 및 기준선 일치는 `NOT_VERIFIED`다. `CONFIRMED_CODE`는 제공 operator audit `Builder 전체 인수 기준 정적 감사` (SHA-256 `9d955a62e9391b3adbbaf5f1da37d1be6b65bd4c0760e1cb7b41836c14aabd7d`)가 이 기준선에서 대조한 코드 사실을 의미한다. 감사/설계 입력은 제공 작업자료이며 공개 접근 가능하다고 가장하지 않는다.

## 확정된 제품 방향

- 신규 Lead 구성은 Main/UI/Background/Intake/Discussion의 **5개 논리 context**다. 기존 3개 대화 사용자는 현재 화면을 유지하며 사용자가 명시 선택할 때 새 5-context 대화를 시작한다. 상주 프로세스 5개를 요구하지 않는다. (`DOCUMENTED_ONLY`, 제공 v0.8 원문 SHA-256 `bb5e723e1aa0408e4e91fcbad784d58acb27ed46f00a78b474b828ad58be9de7` §B/S7 및 사용자 제공 「후속 사용자 확정 답변」)
- 기존 기록, 원래 ID, provenance, receipt와 참조는 보존한다. 이름으로 자동 매핑하지 않는다. 시작 중복 클릭/불확실한 응답/재시작에서 중복 생성을 막는다. 기존 이력 자동 링크·이관·삭제·병합은 하지 않는다. (`DOCUMENTED_ONLY`, 후속 directive)
- 강제 읽기전용, 자동 링크, 실행 취소/재전송, 자동 AI 실행은 승인되지 않았다. 버튼 배치·재전환·진행 중 실행·명시적 history link 등 세부 UX는 추가 결정 전까지 미결정이다.
- D3의 완성형 요구(도메인 팩, coverage/gap, 상태·이벤트·예외/조건부 검사, 근거 기반 질문 해결, 관련 범위 실행 Gate)는 제품 설계 목표다. 특정 OSS나 구현 완료를 뜻하지 않는다. (`DOCUMENTED_ONLY`, v0.8 §§B/H)
- 기존 Main/UI 승인 경계, 상담→설계→UI 기준선→기술 선택→CTO 분배 순서, UI HTML 시각 기준 + 별도 UI Contract/UI Revision을 유지한다. (`DOCUMENTED_ONLY`, v0.8 §§C/F)

## 공개 코드 대조

- 현 Builder `parseLeadSessions`는 정확히 `main`, `cto-inbox`, `decisions` 세 키만 받는다. `resolveLeadToolAuthority`는 `LEAD_CHANNELS` 전부에 대해 현재 세션을 검사한다. (`CONFIRMED_CODE`, `src/domain/lead-sessions.ts`, `src/lead-tool-authority.ts`)
- Lead 실행정책은 `LEAD_PLANNING_TOOL_NAMES` 공통 목록이다. 새 역할별 권한은 `src/session-execution-policy.ts`의 목록까지 함께 검토한다. (`CONFIRMED_CODE`)
- Task Packet 저장은 계획 자료다. Worker 생성, process 실행, 실제 작업, QA 또는 완료 증거가 아니다. (`CONFIRMED_CODE`, `src/domain/task-packets.ts`, `src/task-packet-tools.ts`; 실행 Gate 결과 `UNKNOWN`)
- SDK 지원 발견 목록에서 `ensure/getRequest`가 빠졌다는 제공 검토는 API 전체 부재를 뜻하지 않는다. 제공된 후속 자료는 Worker RPC가 두 operation을 전송한다고 기록하지만 이 추가 노트 작업에서는 SDK 원문을 재검사하지 않았다. (`DOCUMENTED_ONLY`, 사용자 제공 「후속 운영자 지시」 SHA-256 `f8e2ad0ede6e3b6a336a18ed32e94e187a625c5f526b1925d0014c16e5cb1396`)
- 제공 operator audit의 E0–E15 목록 자체는 80개 고유 경로(39 `src`, 38 `test`, package/build 3개: `package.json`, `sps-plugin.json`, `scripts/build.mjs`)이며, `package.json` 및 `sps-plugin.json` 두 manifest를 제외하면 78개다. 후속 operator directive의 78은 부정확한 요약이다. `ACTOR-QA-B`는 QA 담당 role ID이며 credential/account 식별자가 아니다. 이 Task의 162행 의미는 `NOT_VERIFIED`, 제품 테스트는 `NOT_RUN`이다. 출처: 제공 audit SHA-256 `9d955a62e9391b3adbbaf5f1da37d1be6b65bd4c0760e1cb7b41836c14aabd7`; operator directive SHA-256 `f8e2ad0ede6e3b6a336a18ed32e94e187a625c5f526b1925d0014c16e5cb1396`. (`DOCUMENTED_ONLY`)

## 적용 경계와 미결정

Core Primary/Extension/activation, pinned SDK/Core compatibility, 새 context별 권한, 기존 이력 조회 API, receipt 내구성, 실제 실행 Gate와 세부 UX는 `UNKNOWN` 또는 미결정인 채 둔다. 기존 3개 대화를 자동 변환하거나 보안/권한 동작을 새로 정하지 않는다. 다음 안전한 설계 작업은 명시 선택·idempotent 생성·기존 데이터 provenance 보존을 함께 다루는 저장/API/UI 계약을 작성하고, Core/SDK 공개 계약과 독립 QA 계획을 확인하는 것이다.

이 노트는 READY_FOR_DESIGN_INTEGRATION 판단에만 참고되며 구현/실행/QA/릴리스 완료를 선언하지 않는다.
