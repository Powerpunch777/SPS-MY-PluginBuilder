# 질문 답변을 설계 Revision에 반영

기록일 2026-11-02. 구현 커밋 `0ec7b5e`, Core `55b5d5b`, 공개 SDK `316c56f`.
v15 AC-05의 일부 구현·검증이며 영향 분석·변경 전파를 포함한 전체 AC 통과는 아니다.

## 구현

- 질문 화면의 사용자 답변에 프로젝트·현재 초안 Revision·질문 ID를 함께 저장한다.
  연결 정보는 승인이나 실행 권한이 아니다. 메인/CTO 사용자 입력으로 위장할 수 없다.
- 현재 선택된 Lead의 준비된 `decisions` 세션만 `builder.resolve-design-question`을
  호출할 수 있다. 실제 저장된 사용자 답변과 연결 정보를 확인하고 원문 SHA-256,
  해석문, 이전/반영 Revision과 질문 digest를 남긴다. 답변의 의미는 AI가 판단한다.
- 새 초안·명세·Graph ID와 답변 출처를 요구한다. 답변 해석과 새 초안은 같은 불변
  journal entry에 넣고 기존 CAS head로 함께 게시한다. 일반 state.set으로 대체하지 않는다.
- 충돌하거나 결과가 불확실하면 읽어서 확인한다. 자동 재전송하지 않는다. 이미 보낸
  같은 메시지 확인은 질문이 답변된 뒤에도 가능하지만 새 메시지의 오래된 질문은 거부한다.
- 해결한 질문과 해석 이력은 후속 제안에서 지울 수 없다. 질문의 의미를 몰래 바꾸지
  못하며, 새로운 결정이 필요하면 새 질문/Revision으로 이어가야 한다.
- 옛 대화와 초안의 직렬화 형태는 유지하고 새 연결/해석 필드만 선택적으로 추가한다.
  Core/SDK API나 DB migration은 이번에 추가하지 않았다.

UI는 전송 영수증만으로 질문을 답변됨 처리하지 않는다. 실제 저장된 해석으로 상태를
표시하며, 해결한 질문은 미결정 개수에서 뺀다. 답변 완료 입력창을 AI 연결 장애로
표시하지 않고, 질문을 바꾸면 이전 작성 중인 답변이 다른 질문으로 따라가지 않게 했다.
긴 질문 상세는 스크롤 영역으로 제한한다. 실제 사용자 DEV/설치본은 교체하지 않았다.

## 자동 검사

Node24.22.1 격리 복사본의 타입 검사·빌드·전체 **202/202**, SDK CLI validate/test가
통과했다. 순수 입력 검증, 대화 저장/재개, 질문 연결, 역할/세션/출처 거부, CAS와 응답
유실, 완료 후 중복 메시지 확인, 후속 제안의 이력 보존, DTO/화면 표시를 검사했다.
컴파일된 Worker JSONL 시험은 가짜 Host이며 실제 AI 증거와 구분한다.

처음에는 시험 fixture 타입 오류2건과 Worker getData 입력 envelope 오류1건을 고쳐
재실행했다. 앱의 임시 로딩 상태를 즉시 검사한 부분과 중복 CSS class 선택자도 수정했다.
실패한 시험을 성공 근거에 합치지 않는다.

## 실제 AI와 앱

사용자가 허용한 기본 Codex CLI 계정으로 `--live-question` 시험을 진행했다. 별도
임시 Workspace/Agent, 실제 source Desktop/Host와 UI, mock Identity를 사용했다.
첫 main 실행이 출처 조회→초안 제안1회→재조회를 수행했고 재시작 후 보존됐다.
질문 화면에서 보낸 답변은 실제 decisions 세션으로 전달되어 새 명세/Graph와 해석을
저장했다. 답변 처리 쓰기1회, 두 제공자 실행을 확인했고 추가 승인 질문은 만들지 않았다.
그 뒤 재시작에서도 같은 초안과 별도 main/decisions 기록, CTO 입력0, 다른 Workspace
불변을 확인했다. 기존 Agent 설정과 빈 시험 작업 폴더도 그대로였다.

명령·파일 편집·코드 생성·웹·다른 앱·하위 Agent는 실행하지 않았다. 시험 Agent의
두 MCP wrapper에 한정된 승인 설정이므로 일반 Agent의 기본 승인 UX 인증은 아니다.
main6/6 정상 종료·출력12개 종료/실패0·임시 데이터 정리 후 명령 exit0이다.

실제 화면 관찰에서 답변 완료 이유와 질문 개수 오류를 찾아 **UI만 후속 수정**했다.
후속 no-AI source 앱 시험은 전달할 질문 연결을 가로챈 표시 fixture로 검사하며 실제
AI/Host 설계 저장으로 보고하지 않는다. 전송만으로 완료되지 않음, 저장 해석 표시,
미결정0, 완료 이유, 상세 높이 제한을 확인하고 캡처를 육안 검사했다. main4/4·출력8개
종료/실패0·임시 데이터 정리와 exit0이다. 실제 AI 시험을 다른 UI bytes로 재사용하지 않는다.

## 식별자

| 증거 | 실제 AI 질문 시험 | 후속 UI/no-AI 시험 |
| --- | --- | --- |
| source fingerprint | `7f4c71daa458e392a426802c9fa0b9bcbb9c02948df63d2cf6413fa448138835` | `99ce44b6406f17dc98ab15903434a2d58e917c5318451984a6b3ff5168b287b8` |
| Worker SHA-256 | `fe314c6018c907135db289d71b973572020cbb3e0e760513c0ab9959f9d64f77` | 동일 |
| SDK CLI UI 집계 SHA-256 | `1fbc31679bd12f6424a0fabb2d461b580739d1d2e488473afa68355b429d8f5a` | `a78209fa83e873ab07e6d6de205d3363ac43a86db1dd29c770c740a3ec6e67bd` |
| Host UI index.js SHA-256 | `b64712a2ce292e5abb7db915078378e7b0fc899b3cfd9d83b6c30e0b83c17f4f` | `2c1b9d52f23360bd146174988b81470b0c51c8ebc7221249a6b23cc97e321450` |

두 manifest SHA는 `c6ea304f412575fc4733bfab46c454ca8b9ba1a24ee68591f6e0f3553bc4f5f9`.
실제 질문 반영 DTO SHA는 `240b6a4402741e2334a8b76f99896d35010cb99c15cfe047f89cb5630691966a`.
문서 포함 HEAD를 시험 복사본 fingerprint와 동일하다고 주장하지 않는다. 원본 로그
`sps-builder-live-question-verified.log`, `sps-builder-question-ui-final.log`와 캡처는 로컬에
보관하고 공개 저장소에 계정·원시 로그·비공개 Core 소스를 복사하지 않는다.

재현은 Source Desktop의 격리 연산자를 사용한다. 실제 계정 시험에는 CODEX=1과
QUESTION=1의 별도 opt-in이 모두 필요하며 다른 실계정 시험·API 키·제공자를 혼합하지 않는다.

## 남은 범위

공유 기억 갱신과 CTO/하위 명세 전파는 이 단일 journal 게시에 포함되지 않는다.
승인 명세/계약 승격, 영향 분석·변경 전파, 프로젝트별 Lead/CTO 구성, 실제 CTO intake,
인계 UI, Worker/QA/Task Packet·GitHub/Runner 근거·납품 흐름과 나머지 v15 요구는 남았다.
현재 기본 프로젝트는 Workspace UUID이며 다중 프로젝트 UI까지 완료한 것이 아니다.
Google OAuth·설치본·서명·두 PC·Stable 자격 검증도 아니다. Marketplace·Preview·자체 LAN은
계속 보류하고 기존 Tailscale·사용자 DEV·설치본·계정·데이터를 보존한다.

참고: [MCP 도구 계약](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
[PostgreSQL 동시성](https://www.postgresql.org/docs/current/transaction-iso.html).
기존 저장 계약을 재사용했고 외부 소스 코드를 복사하지 않았다.
