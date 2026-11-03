# SPS 버전 및 호환성 보고서

## 기준과 증거

- 이번 task revision: `V15-CSAS-V07-M1` (SPS 원장). `CONFIRMED_CODE` 여부와 달리 작업 트리의 `.git` 포인터 상태는 조사/검증하지 않았다.
- 공개 Builder 기준 revision은 [PR #2](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/pull/2)의 [`996c43f47ad68ba0a63c7bfbe14851e731a66891`](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/tree/996c43f47ad68ba0a63c7bfbe14851e731a66891)로 제공됐다. 링크는 공급된 공개 저장소 식별자로 구성했으며 이 QA에서 원격 조회하지 않았다. 현 checkout HEAD가 이 revision과 일치하는지는 `NOT_VERIFIED`다. SDK pin `c69915a518f0eb600f0ace8238144059911f8d04` 및 Core/Source support matrix 간 차이는 운영자 제공 참고자료의 진술이다. 비공개 원문이 공개되어 있다고 전제하지 않는다. `DOCUMENTED_ONLY` — operator-observed context와 사용자 제공 지시.
- v0.8 manifest에 기록된 원문 `SPS_Builder_CSAS_Complete_Design_Reviewed_v0.8_2026-11-03.md`, SHA-256 `bb5e723e1aa0408e4e91fcbad784d58acb27ed46f00a78b474b828ad58be9de7`, 85,493 bytes. v0.7 원문 `SPS_Builder_CSAS_Complete_Design_Reviewed_v0.7_2026-11-03.md`, SHA-256 `832b1f4a4884df8b12f5733ce60e951bfaa418f249c54c69e2646ca95c7070db`, 79,474 bytes. 두 문서는 제공 참고자료이며 이 보고서는 공개 URL 접근을 주장하지 않는다. `DOCUMENTED_ONLY`.
- Manifest는 v0.8이 v0.7의 session-transition 해석만 supersede하며 누적 설계를 보존한다고 밝힌다. 원본 문서들은 변경하지 않는다.
- 출처 식별: v0.7 원문 `SPS_Builder_CSAS_Complete_Design_Reviewed_v0.7_2026-11-03.md` SHA-256 `832b1f4a4884df8b12f5733ce60e951bfaa418f249c54c69e2646ca95c7070db`; v0.8 원문은 위 manifest 이름/SHA와 같다. 공개 Builder 대조표인 제공 operator audit `Builder 전체 인수 기준 정적 감사` SHA-256 `9d955a62e9391b3adbbaf5f1da37d1be6b65bd4c0760e1cb7b41836c14aabd7d`는 작업자료이며 공개 자료가 아니다.

## 호환성 판정

| 조합/정책 | 판정 | 근거 |
|---|---|---|
| Builder 코드 ↔ 이번 실행의 Core/SDK 실물 | `UNKNOWN` | 이 workspace에는 Core/SDK 원문이 제공되지 않았고 별도 revision의 공개 호환 conformance를 실행하지 않음. |
| SDK ensure/getRequest 발견 | `DOCUMENTED_ONLY` | 운영자 제공 검토는 발견 목록에서 두 메서드가 빠져 필터링되지만 Worker 별도 RPC 집합에 전송 경로가 있다고 기술. API 전체 부재로 표현 금지. |
| Core/SDK 최신 관찰 HEAD ↔ Source support matrix pin | `CONFLICT` | 사용자 제공 「Operator-Observed SPS Context」(2026-11-03, SHA-256 `5b13db3796916f5c362ee1ef4536a08ff0fa16a7f072b1aec7af98f3d9c9cfc0`)와 「후속 운영자 지시」(SHA-256 `f8e2ad0ede6e3b6a336a18ed32e94e187a625c5f526b1925d0014c16e5cb1396`)는 서로 다른 revision 계열을 기록하고, matrix가 대상 런타임이라고 확정하지 말라고 명시한다. 이 참고자료들은 공개 URL에서 확인했다고 주장하지 않는다. |
| **HISTORICAL ANALYSIS — 2026-11-04 시작** | 현행 기본은 비어 있는 5개 context이며, legacy switch·migration·이전 대화 메뉴는 없다. 최신 `14996c` 및 `6026596`을 우선한다. | 아래 레거시 보존 주장은 과거 기록이다. |
| Builder 3채널 ↔ v0.8 5-context 의도 | `CONFLICT` | `src/domain/lead-sessions.ts`는 세 키만 허용; v0.8 §B/S7과 후속 결정은 다섯 논리 context와 레거시 보존을 요구. 이는 제품 목표 철회가 아닌 구현 차이. |
| **HISTORICAL ANALYSIS — 2026-11-04 종료** |  |  |
| 정책 discovery ↔ 실제 실행 안전성 | `UNKNOWN` | 코드가 readiness unknown, OS isolation not-certified를 명시하며 실제 Host 강제 검증은 별도 필요. |

## 안전한 다음 호환성 확인

대상 Core/SDK 공개 revision, package pin과 지원 matrix를 같은 기준선으로 고정한 뒤 manifest/profile/API conformance, Worker/session API 및 권한 거부 경로를 실제 시험해야 한다. 이 보고서는 Core 내부 소스나 사설 경로를 인용하지 않는다. 실행한 호환성 시험은 `NOT_RUN`이다.
