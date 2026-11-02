# 사용자 설계 결정과 내부 기준 버전

기록일 2026-11-02. 프로젝트 CTO 업무 배정에 앞서, 저장된 설계 초안의 명세와
Graph를 하나의 불변 기준으로 연결했다. 전체 v15 완료나 실행 승인을 뜻하지 않는다.

## 구현과 경계

- 준비된 현재 Lead만 `builder.publish-design-baseline`을 호출한다. CTO intake는
  거부하며, 현재 Run/세션에 실제 제출된 사용자 입력만 결정 근거로 인용한다.
  상담 자료나 AI 답변, 다른 실행의 사용자 입력을 대신 사용할 수 없다.
- 사용자 의도의 의미 판단은 Lead가 한다. 특정 문장을 승인으로 인식하는 하드코딩은
  없다. 사용자 입력 digest와 Lead 해석, 작성자/세션/Run/선택 revision을 기록한다.
- 서버가 현재 초안을 읽고 명세와 Graph를 복사한다. 호출자가 새 내용을 끼워 넣거나
  명세/Graph ID를 재사용하지 못하도록 기준 ID에서 두 ID를 파생한다.
- 기존 CAS journal을 재사용한다. 명세와 Graph는 한 기준 객체에 함께 들어가며
  head가 성공한 기록만 공개된다. 응답 유실/충돌에는 재조회하며 자동 재시도하지 않는다.
  초안과 기준 journal 사이의 다중 키 transaction은 아니다. 관측한 초안/Lead 변경은
  거부하지만 저장된 역사적 기준이 이후에도 최신 초안이라는 뜻은 아니다.
  Lead 선택 변경이 head CAS 안에서 경합하면 기록이 게시된 뒤 후속 검사에서 오류가
  날 수 있다. 롤백/성공 승인을 주장하지 않고 재조회한다. 단일 키 CAS만으로 권한
  회수와 게시의 원자성을 보장하지 못한다. 이후 실행 연결 전에는 현행 권한을 별도로
  검증해야 하며, 이 기록 자체를 실행 capability로 사용하면 안 된다.
- `builder.read-design-baseline`과 Workspace provider가 조회를 제공한다.
  기존 `builder.read-solution`도 기준의 Graph를 우선 읽고, 기준이 없으면 기존
  solution journal을 사용한다. Core API/DB migration은 추가하지 않았다.
- 문서 화면은 읽기 전용이다. 내부 설계 해석임을 표시하며 외부 계약/법적 서명,
  코드 실행/배포/삭제/납품 권한으로 해석하지 않는다. 기술 선정과 Workstream 권한은 별개다.

## 확인한 범위

Node24.22.1 격리 복사본에서 타입 검사, 빌드, 전체 **244/244**, 공개 SDK CLI
validate/test가 exit0이다. 잘못된 역할/세션/Run/출처, 동시 head 경쟁, 불변 ID,
입력 변조, 응답 유실, Lead 변경, 기존 solution 조회와 Worker RPC 경로를 검사했다.
실제 source Desktop/Host의 no-AI 시험도 exit0이며, 문서 표시 fixture를 캡처해
확인했다. fixture를 제거한 실제 Host의 기준 값은 null이다. 따라서 이 화면 시험을
실제 Lead의 기준 저장이나 실제 사용자 승인으로 보고하지 않는다.

후속 CAS 도중 Lead 교체를 드러내는 회귀 검사 1개를 추가한 뒤 **245/245**와
타입/빌드/SDK CLI를 재실행해 통과했다. 이 후속 build-only 지문은
`4fdf128c2aabea1c36b11daffe2a8bc119bc02955537f8dcf1bebb13ea18c883`이며,
Worker/manifest/UI bytes는 아래 no-AI 앱 시험과 같다. 다중 키 원자성이 해결됐다는
검사가 아니라, 불확실한 성공을 숨기거나 자동으로 재시도하지 않음을 확인한 검사다.

시험 복사본 fingerprint: `fbf4c5eec4c8c1ddef159f1e189eb2e2d4d3fd2ade13c2f7acc4e0962f9825f8`.
manifest SHA: `a2778a5858d015072fc8c1e8f580db3c6ba42b7425f12b3ba6a0bef41c996a48`.
Worker SHA: `eb6310a6811b87f4e54e21cae84c1d0724b67aed7d59e4b23efca5e2cf4b9616`.
SDK CLI UI 집계 SHA: `7d5780bc9a64bad4db0ff914d3359791962bc32f9d17de4fe05409624a69429c`.
실제 Host UI index SHA: `38ea8efad2a47b49d58f02caf47a9439ad53cd3a4d261f4c2e1a92843be9499a`.
문서 포함 HEAD 전체를 위 시험 복사본 지문과 동일하다고 주장하지 않는다.

Main4/4, 출력8개 정상 종료/실패0, 임시 데이터 정리를 확인했다. 원시 로그와 캡처는
로컬에만 보관한다. `--live-baseline`은 별도 계정 사용 동의와 CODEX/BASELINE 두
opt-in이 필요한 준비된 시험이며, 이 기록 시점에는 **실행하지 않았다**.

## 남은 작업

실제 Lead 기준 저장 시험, 기술 선정 Register, Workstream 명세/배정, CTO 기억과 질문
intake, Worker/QA·Task Packet·GitHub/Runner 근거·납품은 남아 있다. 기존 DEV/설치본/
계정/데이터와 Tailscale은 유지한다. Marketplace·Preview·자체 LAN은 계속 보류한다.
AC 전체 통과, 실제 Google OAuth·두 PC·서명·Stable 근거로 사용하지 않는다.

참고: [MCP 도구 계약](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
[PostgreSQL 동시성](https://www.postgresql.org/docs/current/transaction-iso.html).
외부 코드 복사 없이 기존 공개 SDK의 상태/실행 계약을 재사용했다.
