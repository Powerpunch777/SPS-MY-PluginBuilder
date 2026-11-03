# 미해결 계약 및 의존성

분류: `UNKNOWN`은 이번 승인 공개 자료/소스만으로 확정할 수 없음, `CONFLICT`는 서로 다른 기준의 불일치, `DOCUMENTED_ONLY`는 공급 문서 진술이며 별도 실증이 아님.

## 기준선과 AC 대조의 한계

코드·테스트·공백 참조의 출처는 공개 Builder PR #2의 [revision `996c43f47ad68ba0a63c7bfbe14851e731a66891`](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/tree/996c43f47ad68ba0a63c7bfbe14851e731a66891)이며 [PR #2](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/pull/2)로 식별된다. URL은 제공된 repository identity로 구성했고 이번 QA는 원격을 조회하지 않았다. 코드 행은 제공 운영자 감사 `Builder 전체 인수 기준 정적 감사` (SHA-256 `9d955a62e9391b3adbbaf5f1da37d1be6b65bd4c0760e1cb7b41836c14aabd7d`)의 공급 기준선 대조다. checkout HEAD 독립 확인과 baseline 일치는 `NOT_VERIFIED`다. 감사 및 설계 원문은 사용자 제공 작업자료이며 공개 문서라고 주장하지 않는다.

제공 감사는 전체 162개 고유 AC 행을 v15 `AC-01`–`AC-118`(118행)과 CSAS 44행(`AC-CSAS-SESSION-01`–`07`, `AC-CSAS-LEGACY-01`–`06`, `AC-CSAS-IMPACT-01`–`05`, `AC-CSAS-UI-01`–`05`, `AC-CSAS-HTML-01`–`07`, `AC-CSAS-D3-01`–`14`)으로 대조한다. 각 행에 E0–E15 근거 묶음, 관련 코드/테스트 경로, 남은 공백을 기록한다. 제공 감사의 합계는 P101/M51/N10이며, 이 표는 행별 의미를 다시 확인한 QA 결과가 아니다. 이번 독립 QA 판정은 **162행 전체 의미 `NOT_VERIFIED`**, 제품 테스트 `NOT_RUN`이다. 구체적인 행별 코드·테스트·공백 참조는 위 제목/SHA로 식별되는 제공 감사표를 따라가야 하며, 그 제공자료의 공개 접근성을 전제하지 않는다.

| 질문/계약 | 분류·근거 | 영향 및 독립 진행 |
|---|---|---|
| 대상 Core/SDK/Source revision과 실제 호환성, Primary/UI ownership | `UNKNOWN`; 사용자 제공 「Operator-Observed SPS Context」는 서로 다른 관찰점을 제공하고 Core 소스는 제공되지 않음. 이 참고자료의 공개 URL은 없음. | Primary/UI/활성화 의존 구현은 계약 확인 전 확정 금지. Builder 문서 대조는 독립 진행 가능. |
| SDK 발견 목록에 ensure/getRequest 누락 | `DOCUMENTED_ONLY`; 사용자 제공 「후속 운영자 지시」(SHA-256 `f8e2ad0ede6e3b6a336a18ed32e94e187a625c5f526b1925d0014c16e5cb1396`)는 별도 Worker operation 집합의 존재도 기록 | API 전체 부재로 단정 금지. 해당 SDK revision에서 원문/API/test 확인. |
| 다섯 논리 context와 기존 세 대화의 공존/선택 UI 상세 | 제품 원칙은 `DOCUMENTED_ONLY`로 확정; 버튼 배치, 재전환, 명시적 history link 등 세부 UX는 미결정 | 기존 진입 유지, 명시 시작, 이력/ID/provenance/receipt/reference 보존, 이름 자동 매핑/자동 이관/삭제/병합/중복 생성 금지. 승인되지 않은 readonly, 자동링크, 취소/재전송, 자동 AI 실행은 추가하지 않음. 신규 context 구조 설계는 지속 가능. |
| 신규 권한/tool matrix | `UNKNOWN`; `src/lead-tool-authority.ts`는 전체 `LEAD_CHANNELS`, `src/session-execution-policy.ts`는 공통 Lead tool set 사용 | 신규 역할·context별 허용/금지 tool 결정 및 거부 경로를 함께 검증. |
| 실행 Gate가 Task Packet 이후 실제 Worker/process를 차단하는가 | `UNKNOWN`; `src/task-packet-tools.ts`, `src/domain/task-packets.ts`는 계획 데이터. Operator audit은 `executionStarted=false`로 기록 | Task Packet 저장을 실행/QA로 보고하지 않음. Core dispatch 경계가 필요한 Workstream을 별도 확인. |
| D3 domain packs, coverage/gap, conditional logic, gate integration | `UNKNOWN`; v0.8은 승인 목표이나 현재 구현 인수는 없음 | 승인된 목표 범위는 유지, OSS/API 선택은 비교·실증 전 미확정. |
| Core/SDK session message query/search/recovery, durable receipts | `UNKNOWN`; v0.8 §J, API pin별 확인 없음 | Query-First 및 기존 receipt/reference 보존 구현 전 API/스토어 계약 검증. |
| 전체 AC 정적 계수 및 인용 경로 | 제공 operator audit의 E0–E15 목록 자체는 **80개 고유 경로**(39 `src` + 38 `test` + package/build 3개: `package.json`, `sps-plugin.json`, `scripts/build.mjs`)이며, 두 manifest를 제외하면 78개다. 후속 operator directive의 78은 부정확한 요약이다. `ACTOR-QA-B`는 QA 담당 role ID이며 credential/account 식별자가 아니다. | 출처: 제공 audit SHA-256 `9d955a62e9391b3adbbaf5f1da37d1be6b65bd4c0760e1cb7b41836c14aabd7d`; operator directive SHA-256 `f8e2ad0ede6e3b6a336a18ed32e94e187a625c5f526b1925d0014c16e5cb1396`. 대조는 `DOCUMENTED_ONLY`; 162행 의미 `NOT_VERIFIED`, 제품 테스트 `NOT_RUN`. |
| 전체 Builder 실제 acceptance | `NOT_RUN`; 이 작업은 문서 작업이며 baseline 검사는 이번 QA가 아님 | 실제 변경 후 QA는 CTO가 새 명령·종료값·환경·근거로 별도 수행. |

## 다음 안전 구현 조각

명시 선택으로 신규 5-context를 시작하는 흐름에 필요한 계약/데이터 호환 설계를 먼저 정리한다. 기존 3개 record, IDs, message provenance, receipts, references를 보존하고 retry/restart/idempotency에서 중복 생성을 막는 범위를 정의한다. `lead-sessions.ts`의 parser와 `lead-tool-authority.ts`의 전체 채널 검사, `session-execution-policy.ts`의 공통 Lead 도구 집합을 함께 설계 대상으로 둔다. 세부 UI 전환 정책 및 신규 AI 실행은 추가 결정 없이 확대하지 않는다. 계획 저장 후 Worker/QA 실행을 완료로 오인하지 않는다.
