# SPS Core / SDK / Builder 계약 매트릭스

분류는 `CONFIRMED_CODE`, `CONFIRMED_TEST`, `DOCUMENTED_ONLY`, `UNKNOWN`, `CONFLICT`를 사용한다. 이 실행에서는 새 테스트를 실행하지 않았다.

## 기준선과 검증 한계

코드/테스트/공백 행의 제공 근거는 공개 Builder PR #2의 [revision `996c43f47ad68ba0a63c7bfbe14851e731a66891`](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/tree/996c43f47ad68ba0a63c7bfbe14851e731a66891)을 대상으로 한 운영자 감사 `Builder 전체 인수 기준 정적 감사` (SHA-256 `9d955a62e9391b3adbbaf5f1da37d1be6b65bd4c0760e1cb7b41836c14aabd7d`)다. PR 링크는 [여기](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/pull/2)다. 이 URL은 공급된 저장소 식별자에 따른 참조이며 이번 QA에서 원격 확인하지 않았다. 각 `CONFIRMED_CODE`는 이 제공 기준선의 정적 대조를 뜻한다. 현 checkout HEAD에서 독립 검증한 결과가 아니며 기준선 일치는 `NOT_VERIFIED`다. 감사/온보딩 참고문서는 작업에 제공된 자료이며 공개 URL에서 열람할 수 있다고 주장하지 않는다. QA는 162개 행의 의미 인수나 제품 테스트를 수행하지 않았다.

| 항목 | 소유 경계 | 이번에 확인한 사실 | 분류 및 출처 | 남은 확인 |
|---|---|---|---|---|
| Lead 세션 선택 | Builder | 제공 기준선에서 허용 채널은 `main`, `cto-inbox`, `decisions`; Workspace/agent/revision 검증 및 세션 중복 ID 거부가 구현됨 | `CONFIRMED_CODE` — 공급 기준선 `src/domain/lead-sessions.ts` (`parseLeadSessions`), 감사 E6 | 신규 5-context 저장/레거시 공존 인수 `UNKNOWN` |
| Lead 도구 권한 | Builder | 현재 선택된 Lead와 현재 세션을 검사하고 모든 `LEAD_CHANNELS` 중 하나와 일치해야 함 | `CONFIRMED_CODE` — `src/lead-tool-authority.ts` (`resolveLeadToolAuthority`) | 신규 context별 도구 경계·권한 매핑 `UNKNOWN` |
| Lead 실행 도구 집합 | Builder/Host SDK 경계 | `LEAD_PLANNING_TOOL_NAMES`가 세션 정책에 사용되며 mode는 `plugin-tools-only-v1` | `CONFIRMED_CODE` — `src/session-execution-policy.ts` | Host 측 강제/실제 dispatch 증거 `UNKNOWN` |
| 정책 준비도/격리 | Core/SDK | 코드가 반환하는 계약 값은 `readiness: unknown`, `osIsolation: not-certified`; 이를 인증으로 표시하지 않음 | `CONFIRMED_CODE` — `src/session-execution-policy.ts` | 실제 Host 환경·OS 격리 확인 `UNKNOWN` |
| Task Packet | Builder | 계획 자료에 dependency pin, acceptance/evidence, test plan을 둠 | `CONFIRMED_CODE` — `src/domain/task-packets.ts`, `src/task-packet-tools.ts` | Task 발행이 Worker/process/execution/QA를 시작하는지에 대한 증거 없음; operator audit은 계획 저장이라고 기록 (`DOCUMENTED_ONLY`) |
| Worker 실행/복구 | Core + SDK | 제공된 공개 자료만으로 해당 pinned Core/SDK 실제 실행 완료를 입증할 수 없음 | `UNKNOWN` — 사용자 제공 「SPS CAO Lead SPS 프로젝트 계약 온보딩」(2026-11-03, SHA-256 `96b07af6b1b74646b3e85378fde2921861d44d4bd4cdb4de825ed53d693df12d`), §§3–6. 이 참고문서의 공개 URL은 제공되지 않음. | 공개 API/지원 matrix와 실제 pin에 대한 conformance 필요 |
| SDK 발견 목록 | SDK | 운영자 제공 검토는 `runtime/host-support.mjs` 발견 목록에 `ensure/getRequest`가 빠졌지만 Worker RPC의 별도 operation 집합에는 있다고 기록한다. 이는 API 전체 부재가 아님. | `DOCUMENTED_ONLY` — 사용자 제공 「후속 운영자 지시」(2026-11-03, SHA-256 `f8e2ad0ede6e3b6a336a18ed32e94e187a625c5f526b1925d0014c16e5cb1396`); 이번 작업에서 SDK 코드 미열람 | 대상 SDK revision의 원문·테스트 독립 검토 |
| Primary/UI ownership | Core | v0.8은 Primary 판정을 Core 계약으로 제한하고 추측을 금지 | `DOCUMENTED_ONLY` — v0.8 §0.2; 대상 Core 원문 없음 | Primary/Extension/Workspace activation 및 복구 공개 계약 `UNKNOWN` |
| manifest/package | Builder + SDK | Builder manifest/package 선언은 로컬 코드에 존재 | `CONFIRMED_CODE` — `src/manifest.mjs`, `package.json` | pinned SDK의 실제 적합성/배포 대상 `UNKNOWN` |
| Runner/실행 산출물 | Core/Runner/Builder | 운영자 정적 감사는 실제 GitHub Runner API 연결 부재와 UI 미연결 패널을 기록 | `DOCUMENTED_ONLY` — operator audit §근거 묶음 | 이 작업에서 실제 Runner 호출/배포 인수 `NOT_RUN` |

SDK ensure/getRequest 발견 누락은 SDK 전체 API 부재, Builder 실패 또는 지원 불가로 확대하지 않는다. v0.8의 신규 5-context/CSAS 요구는 승인된 제품 의도이며 위의 구현 상태와 별도로 다룬다.
