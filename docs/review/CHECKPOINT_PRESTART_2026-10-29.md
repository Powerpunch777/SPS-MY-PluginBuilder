# SPS 개발 재개 전 체크포인트 — 2026-10-29

## 사용자 요청과 현재 상태

요청은 “시작하기 전에 의존성을 조사하고 체크포인트를 만들어. 병렬 작업할 수 있는 부분과 선행되어야하는 부분을 구분해놔”이다.

이번에는 조사와 문서 기록만 수행했다. 기존 Core/Source/SDK 제품 코드는 수정하지 않았고, 의존성 설치·업그레이드, 테스트·audit·빌드·CI·앱 실행도 하지 않았다. Core 변경의 원격 push나 Native 신규 개발은 하지 않았다. 실제 구현은 후속 개발 재개 단계다.

최신 사용자 AGENTS 지침은 총괄 + GPT-6 Luna high 병렬 분담이며, **Luna에는 높은 추론이 필요하지 않은 일만 배분**한다. 의존성·안전성·권한·복구 계약의 판단은 root가 맡고, 파일/버전/기존 검사 경로 확인·확정된 규약의 반복 연결·fixture 정리를 나눈다. 불필요한 전체 검사는 생략하고 쉽게 설명한다. 이전 사용자 AGENTS 지침은 대체됐다. 사용량 제한이 생겨도 가능한 작업을 계속하되, 제한으로 실행하지 못한 일을 완료했다고 기록하지 않는다.

## 저장소 기준점

| 구성 | 경로/브랜치 | 조사 시작 시 HEAD |
| --- | --- | --- |
| Source | `work/SPS-Source`, `codex/sps-release-hardening` | `73d5c09e293f9cdb31318ab7f18dca5022e04803` |
| Core | Source의 `external/sps-core`, `codex/windows-dev-bootstrap` | `40199c6e55e956c31381e2377860baa78bc7cabb` |
| SDK | Source의 `external/sps-plugin-sdk` | `61a929f6c783f78e5af603682de1543c7e24abc0` |
| Builder | `work/SPS-MY-PluginBuilder`, 로컬 `codex/builder-design-baseline`, 원격 `main` | 문서 기준 `49df6f3283a20965032ec253078fff4bed98dd66` |

`work`의 로컬 절대 경로는 `C:/Users/user2/Documents/Codex/2026-10-26/g/work`다. 조사 시작 시 Source와 Builder 작업 트리는 깨끗했다. Core·SDK 참조는 Source gitlink 및 support matrix와 일치했다. 이 문서 포함 커밋은 위 Builder 문서 기준 커밋의 후속 문서 커밋이며 제품 버전 변경이 아니다.

## 실제 원격 조회와 기존 검증의 경계

2026-10-29 11:37 KST 전후 GitHub API를 읽기 전용 조회했다.

- Source 원격 `codex/sps-release-hardening`: `45ac567603f4ef195371acc8f20a7b99cb32b131`
- Core 원격 `codex/windows-dev-bootstrap`: `4d0b587b56ec794c490b710d734c15ac7e310b2b`
- Builder 원격 `main`: 문서 기준 `49df6f3283a20965032ec253078fff4bed98dd66`
- Source run `40794257537`: `head_sha=45ac567...`, completed/failure

로컬 Source/Core의 최신 종료·완료 보고 변경은 아직 원격에 반영되지 않았다. 기존 CI 결과를 최신 로컬 변경의 원격 검증으로 표현하지 않는다. CI 실패 원인과 상세 통과 범위는 기존 체크포인트와 로그에서 확인했고 이번에는 새 CI를 실행하지 않았다.

기존 기록:

- 이전 Source/Core 조합의 Linux 타입·빌드·9 shard 및 Windows Desktop job은 통과했다.
- production dependency security gate가 Zod high advisory로 실패했고 예외는 승인되지 않았다.
- 최신 로컬 Core focused service 19 PASS, 실제 PostgreSQL 선택 검사 3 PASS/35 unselected, Source outbox/Main 25 PASS, 최종 typecheck exit 0 기록이 있다. 각 범위를 합산하거나 이번에 재실행했다고 표현하지 않는다.
- Windows temp cleanup 간헐 실패는 완전히 해결됐다고 확인하지 않았다.

기존 체크포인트: `work/SPS-CHECKPOINT-2026-10-29-PAUSE-NODE-CLOSURE.md`.

## 변경 감지용 SHA-256

아래 경로는 Source 기준이다. 바이트 변경을 감지하기 위한 기준이며 서명·출시 검증을 대신하지 않는다.

| 파일 | SHA-256 |
| --- | --- |
| `sps-server/release/support-matrix.json` | `4CF9EA9C4835243DFBE0FD7F79F1D8D0E7BBD1105905CD75E274F11A3C9D53AE` |
| `sps-server/docs/current/CURRENT-CANDIDATE.md` | `697461ABA89E6D11B411777667A6E931F6D0A9C5966BFAC33D50009E3F49B715` |
| `external/sps-core/pnpm-lock.yaml` | `39CFC14611FF339875732C0A31C648FE3E661D8C73E73E2396CFB173D9528F6A` |
| `external/sps-core/pnpm-workspace.yaml` | `50DF184EAE07A8B3C670C04B4007E91BECD612D505F18A822345B8EC88BA929E` |
| `external/sps-core/patches/zod@3.25.76.patch` | `82D58282A08D684B253417BF277F6FEF5CA2EED4E0DDDCE73A0C37CCF1FAC79D` |
| `sps-server/desktop/package-lock.json` | `F046477E2CC6ED7CD1CE09D3BF075FADEFEE88C621A1CADB1C51126A89695C6D` |
| `external/sps-plugin-sdk/package-lock.json` | `4D36981F7E98ACCB50797E9E56A6637A188A6027B7EB33DDECE6F7762A9A5ACD` |

## 다음 재개 순서

1. 개발 재개 지시와 범위를 확인하고 HEAD·미커밋 파일·담당 소유권을 다시 확인한다. 현재 미커밋 변경을 삭제하지 않는다.
2. Luna에 보안 의존 경로·기존 API·검사 경로의 사실 확인을 병렬 배분한다. root가 보안 수정 방식과 claim 재시도 계약을 판단한다.
3. claim 계약을 고정한 뒤 Core 서버/DB와 Node/Desktop 로컬 기록을 분리해 구현한다. root가 경합·권한·실행 진입 보장을 맡고 Luna에는 확정된 타입·필드 연결·fixture 등을 분담한다. 잠금 파일·migration·서명 공통 타입은 중복 편집하지 않는다.
4. 필요한 부분만 고정된 입력으로 검증하고 Core/SDK/Source의 동일 조합으로 통합한다.
5. Core/SDK를 변경했다면 참조할 커밋을 원격에서 받을 수 있게 한 뒤 Source gitlink·support matrix·생성 문서를 동기화한다. 이력이나 사용자 데이터를 되돌리지 않는다.
6. 최종 조합의 필수 CI·Windows 결과를 확인한 뒤 완료를 판단한다. 이전 CI 결과를 재사용하거나 이유 없이 반복 실행하지 않고, 검사를 생략했다는 이유로 완료 처리하지 않는다.

담당·의존 표·검증 범위는 [의존성과 병렬 작업 계획](DEPENDENCY_AND_PARALLEL_PLAN_2026-10-29.md)을 참조한다.

## 남은 항목을 누락하지 않기

- 기존 보안 gate의 해결 방식은 아직 확정하지 않았다. 기존 patch 효과와 audit 판정을 구분한다.
- 과거 `zod-installed-final.log`는 `98ab5563…` 패치의 결과다. 현재 lock/patch의 `82d58282…`와 달라 최신 설치 산출물의 통과 근거로 재사용하지 않는다.
- claim 응답 유실의 영속 receipt와 로컬 실행 진입 기록은 미구현이다.
- 최신 로컬 조합의 원격 CI·Windows 증거는 아직 없다.
- Builder의 공유 기억·역할 권한·Codex 전체 이력/재개는 기존 API와의 적합성 확인이 필요하다. Core 신규 기능이라고 단정하지 않는다.
- 공개 SPS SDK와 Core 내부 SDK의 연결 방식, Workspace config에서 지원하지 않는 `secret-ref`의 대체 경로는 구현 전에 확인한다. 평문 설정으로 우회하지 않는다.
- 모든 stream 출력의 영속화, Native 신규 개발, 공개 Marketplace, 완전한 비신뢰 OS sandbox를 이번 선행조건에 추가하지 않는다.
