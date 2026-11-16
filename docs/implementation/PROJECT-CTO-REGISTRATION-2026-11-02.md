# 프로젝트 CTO 등록과 독립 세션

기록일 2026-11-02. 구현 `8e9ee89`, Core `55b5d5b`, 공개 SDK `316c56f`.
v15의 프로젝트별 CTO 정체성과 단일 세션을 연결한 단계다. CTO 업무 실행 전체나
AC-67~81/104~110 전체 통과를 뜻하지 않는다.

## 구현과 경계

- `builder.create-cto`는 현재 선택된 Lead의 준비된 세 세션에서만 호출한다.
  CTO ID·이름과 프로젝트를 받아 기존 Lead의 Core 실행 Agent/계정 설정을 재사용한다.
  별도 Core Agent·계정·인증 파일·모델 서버를 만들거나 기존 설정을 바꾸지 않는다.
- 논리 CTO의 프로젝트 ID와 세션 ID는 별개다. 프로젝트별 레지스트리에 생성 Run/세션/
  Lead 선택과 시각을 남긴다. 같은 이름이어도 다른 프로젝트/Workspace와 합치지 않는다.
- 먼저 CAS로 생성 의도를 남기고 Core의 plugin-owned `sessions.ensure` 키로 세션을
  얻은 뒤 CAS로 연결한다. Lead 세 세션과 CTO 세션은 달라야 한다. 일반 set/create/list
  fallback, 삭제된 세션의 자동 교체나 작업 실행은 없다.
- 응답 유실이나 충돌 때 같은 ID를 명시적으로 확인/복구한다. 기존 ID의 이름 변경·
  퇴직 정체성 재생성은 거부한다. Lead가 바뀌어도 CTO의 기존 실행 Agent/세션은
  바뀌지 않으며 새 Lead가 같은 계정이나 사적 기억을 인수했다고 표시하지 않는다.
- `builder.list-ctos`와 `builder.project-ctos`는 정체성·세션 등록 정보만 반환한다.
  CTO의 사적 기억/대화 조회 도구는 아직 없고 자동으로 공유하지 않는다.
- 조직도에 저장한 CTO를 표시한다. `ACTIVE` 기록만으로 실행 중을 만들지 않으며
  실제 Run 근거가 연결되기 전에는 대기로 표시한다. 등록된 세션도 준비 상태이지
  로그인·백엔드 가용성·진척·작업 완료·명세 승인 증거가 아니다.

레지스트리의 100명/이름512UTF-8바이트/ID160자 제한은 현재 Builder 구현 한도다.
Core 용량이나 제품의 권장 직원 수가 아니다. 현재 UI의 기본 프로젝트는 Workspace UUID다.
사용자가 조직도에서 CTO 생성 권한을 사칭할 UI action은 추가하지 않았다.

## 자동 검사

Node24.22.1 격리 타입 검사·빌드·전체 **225/225**, SDK CLI validate/test가 exit0이다.
순수 레지스트리7개·표시4개·도구/복구12개를 포함한다. 동시 생성 CAS, 다른 프로젝트/
Workspace, 잘못된 Lead와 같은 실행 Agent를 쓰는 CTO 세션의 Lead 사칭, 이름 변경·
퇴직 ID, 유실된 ensure/final CAS 응답, 기존 세션 삭제, 잘못된 Host 결과와 CAS 부재,
Lead 교체 후 기존 CTO 보존을 확인했다.

초기 시험 fixture의 타입 오류를 고친 뒤 재실행했다. 실제 Core 계약 대조에서 세션 키의
`:session:` 접두사 누락도 발견해 고쳤고 가짜 Host도 이 계약을 검사하게 했다.
Source opt-in 검사의 다른 시험 모드 혼입 누락은 부정 테스트가 발견해 고쳤으며,
최종 가드는 **48개 거부 사례**를 통과한다. 실패한 검사 결과는 통과 근거로 사용하지 않는다.

## 실제 앱과 CLI

사용자가 허용한 기본 Codex CLI 계정으로 임시 Workspace/Agent를 사용했다.
실제 source Desktop/Host/UI, mock Identity다. 최초 Lead 실행의 설계 저장 후 같은
main 세션을 재개해 CTO 2명 생성·첫 ID 재등록·목록 조회를 수행했다.
Core 기록은 정확히 Lead3+CTO2의 세션5개, CTO의 lastRunId는 둘 다 null이다.
Lead 실행은 총2회이며 CTO 자체의 모델 실행은0회다. 실제 조직도 카드2개와 재시작 후
동일 레지스트리/대화/세션, 다른 Workspace 불변과 기존 Agent 설정/빈 작업 폴더 보존을
확인했다. 캡처도 직접 검사했다. 코드 생성·명령·파일 읽기/편집·웹은 실행하지 않았다.

Main6/6 정상 종료, 출력12개 정상 종료/실패0, 임시 데이터 제거와 exit0을 확인했다.
실계정 시험은 `--live-ctos`, CODEX=1과 CTOS=1을 모두 요구한다. API 키·다른 provider·
다른 시험 범위를 섞지 않는다. 두 MCP wrapper에 한정한 시험용 승인이므로 일반 Agent
기본 승인 UX나 설치본/Google OAuth/두 PC/서명/Stable 인증은 아니다.

| 식별 | 값 |
| --- | --- |
| 실제 시험 fingerprint | `08e69cc68b6030058472f9ae13532c9992ebdd9c26e6a1f2ea8b24ebd19af49c` |
| 후속 225개 검사 fingerprint | `89e78a2c9932e1c36af8e3a8f2868ae07a6c7e069e6b687290479a44fd96c1bb` |
| 공통 manifest SHA | `f4ecf67e5ad3da3293e24919102a53e6fd1930e882dddba5dfc639b8f56a15da` |
| 공통 Worker SHA | `3f13bbf05671915a9edde72a6933d8665ee700c5e799b904a2acbeed4cc4043c` |
| 공통 SDK CLI UI 집계 SHA | `7ea423cee9d9a38471b9a3582f8df783d5cf021602c56d8aa6da04c5723162b6` |
| 실제 Host UI index.js SHA | `1732a5e790733e746036f2df6643cb2b083f8479cb6260c0d92b04ebf57fb0f4` |
| 실제 레지스트리 DTO SHA | `b8ea95812b0263f5f85ad841a6fd7388e696ccd586e32a90211b718020c34062` |

실제 시험은221개 검사를 포함했고 후속4개 부정 검사를 추가했다. Worker/UI bytes는 같지만
문서/시험 포함 HEAD 전체를 이전 fingerprint와 동일하다고 주장하지 않는다. 원본 로그
`sps-builder-live-ctos-verified.log`, `sps-builder-ctos-final-build.log`와 캡처는 로컬에만
보관한다. 공개 저장소에 계정·원시 로그·비공개 Core 소스를 올리지 않는다.

## 이어서 필요한 것

Workstream/기술 선정·승인 명세 연결, CTO 단일 세션 지시/변경 수신, CTO 전용 기억,
질문 제안→Lead 내부 intake→사용자 질문/답변 전달, Worker/QA·Task Packet·실제 GitHub/
Runner 근거·납품 흐름은 아직 미완료다. 현재 등록만으로 이 동작을 실행하거나 검증했다고
표시하지 않는다. 기존 DEV/설치본/계정/데이터는 보존했고 Marketplace·Preview·자체 LAN은
계속 보류한다. Core/SDK API·DB migration·새 분산 실행기는 이번에 추가하지 않았다.

참고: [MCP 도구 계약](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
[PostgreSQL 동시성](https://www.postgresql.org/docs/current/transaction-iso.html).
기존 공개 SDK의 세션/상태 계약을 재사용했고 외부 코드를 복사하지 않았다.
