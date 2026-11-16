# Lead 공유 기억 구현과 실제 검증

기록일: 2026-11-02. Builder `53d5c33`, Core `55b5d5b`, 공개 SDK `316c56f` 기준이다.
전체 AC-98, 실제 세 Lead 세션, CTO intake, Core 완료 또는 출시 자격을 뜻하지 않는다.

## 구현한 것

`LeadMemoryRevision`은 프로젝트별 `projectId`, 새 `revisionId`, `entries`를 가진다.
항목은 `id`, `kind`, `text`, `sourceIds`만 허용한다. 종류는 목표·제약·결정·가정·미결정
질문이며, 모양·크기·중복 ID·출처 형식·프로젝트 경계를 순수 모듈에서 검증한다.
실제 출처의 존재와 호출 권한은 별도 도구 경계에서 검사한다.

`builder.read-lead-memory`와 `builder.update-lead-memory`는 현재 선택된 Lead의
준비된 세 채널에서 같은 프로젝트 기억을 사용한다. 작성 Agent·Run·세션·선택 revision·
채널·시각과 인용된 사용자 입력의 SHA-256을 남긴다. 원본 대화는 세션별로 따로 보존한다.
기억은 AI가 사용자 입력을 해석한 기록이며 고객 승인·실행·QA·납품 증거가 아니다.

저장은 기존 불변 Revision journal과 단일 키 CAS를 재사용한다. 예상한 이전 revision과
다르면 충돌로 반환하고 자동 재전송하지 않는다. 응답 유실은 현재 저장값을 다시 읽어
확인한다. 다중 키 transaction이나 모든 순간의 권한 회수를 보장하는 것은 아니다.

Lead가 바뀌어도 기억과 이력은 남는다. 새 Lead는 기존 항목을 정확히 유지할 수 있지만,
과거 Lead의 비공개 사용자 대화 출처로 내용을 바꾸려면 현재 접근 가능한 사용자 입력이
필요하다. 과거 사적 대화를 자동으로 합치거나 기억 본문으로 권한을 넘기지 않는다.
완성된 인계 UI와 모든 실행의 자동 기억 조회·주입은 아직 없다.

기존 설계 문서 화면에 `Lead 공유 기억 · 해석 기록`을 읽기 전용으로 표시한다.
현재 UI는 Workspace UUID를 기본 프로젝트 ID로 쓰므로 여러 프로젝트 선택 UI와
프로젝트별 Lead 배정까지 검증했다고 주장하지 않는다. 내부 CTO 질문 수신 채널은
사용자 메시지를 계속 거부한다.

## 자동 검사

Node24.22.1 격리 복사본에서 타입 검사·빌드·전체181/181·공개 SDK CLI validate/test가
통과했다. 기억의 순수 검증9개, 화면 투영2개, 모의 Host 통합7개가 포함된다.
세 준비 채널의 공유·프로젝트/Workspace 키 분리·Worker/잘못된 세션 거부·출처 해시·
충돌·응답 유실·선택 변경·새 Lead의 정확한 항목 유지와 기존 Lead 권한 상실을 확인했다.
모의 세 채널 검사를 실제 AI 세 세션 실행으로 보고하지 않는다.

내용128KiB와 최종 journal entry192KiB 제한은 별개다. 메타데이터와 출처 해시를 합친
최종 크기가 넘으면 저장 전에 거부한다. 사용자가 본문에 넣은 비밀을 완벽히 찾아내는
DLP 기능도 아니다. CLI 인증 파일을 기억에 자동 복사하지 않는다.

## 실제 앱·AI 검증

사용자는 기본 Codex CLI 계정을 쓰는 임시 기억 시험을 허용했다. 실제 source Desktop/
Host와 실제 제공자를 사용했지만 Identity는 mock이었다. 설치본·실제 Google OAuth·
서명·두 PC·Stable 자격 검증은 아니다. Source의 격리 연산자는 다음 별도 opt-in으로
시작하며 API 키·다른 provider·다른 실계정 시험 모드의 혼입을 시작 전에 거부한다.

```powershell
$env:SPS_BUILDER_LIVE_CODEX = '1'
$env:SPS_BUILDER_LIVE_MEMORY = '1'
node scripts/smoke-builder-conditional-state-isolated.mjs --live-memory
```

실행3회는 **두 채널 main → decisions → main 재개**다. 각각 기억 쓰기1·1·0회였고,
메인에서 저장한 목표를 질문 세션이 읽고 사용자 결정을 추가한 뒤 메인이 다시 읽었다.
첫 전송은 실제 UI이고 나머지는 정상 인증된 Builder action이다. 질문 큐 UI나 CTO
라우팅까지 연결됐다는 뜻은 아니다. 내부 CTO 채널의 실제 실행은 하지 않았다.

실제 출처 ID, 저장된 두 항목, Host 기억 문서 표시, 재시작 후 같은 기억·별도 대화 기록,
다른 Workspace 불변을 확인했다. Main5/5·출력10개 정상 종료와 최종 임시 데이터 정리가
완료됐고 전체 명령은 exit0이다. 시험용 Agent의 두 MCP wrapper 승인 설정은 일반 Agent
기본 승인 UX의 완성을 뜻하지 않는다. 명령·코드·파일 편집·웹·다른 앱·하위 Agent는
실행하지 않았고 사용자 DEV·설치본·기존 Agent 설정·의존성은 바꾸지 않았다.

## 재개 실패에서 찾은 연결 수정

이전 Core의 두 시험에서는 첫 두 실행은 성공했지만 재개된 메인 MCP 호출이 실패했다.
진단 로그에서 `user cancelled MCP tool call`을 확인했으며, 이를 만료 토큰이나 기억
손상의 증거로 단정하지 않았다. 각 실패 시험의 Main3/3은 정상 종료됐다.

Core `55b5d5b`는 어댑터의 MCP `-c` 설정을 `resume` 뒤가 아니라 기존 exec 옵션과
같은 앞쪽에 배치한다. 일부 CLI의 명령 단계별 옵션 수집에서 앞쪽 설정이 누락되는
문제를 피한다. sandbox·사용자 승인 정책·Core 권한 값 자체를 완화하지 않는다.
집중16/16·Codex 어댑터 타입 검사가 통과했고, 변경 후 실제 메인 재개도 성공했다.
전체 Core 회귀나 모든 Codex 버전의 호환성 인증은 아니다.

## 증거 식별

- 최종 시험 source fingerprint: `a7bf8c0e0fac42b76db27ea17fa3fe5afb2c55035e4368e92076b3ea255b269b`
- manifest SHA-256: `bfe7cc6a216501cea6469cf95c2cfdda584369ab6d0cc2ef31e887573c42ffc4`
- Worker SHA-256: `d4ac72ed4e340d12893d3fddc07648a31696277c571390dbcc51b3e90b476865`
- UI build SHA-256: `926123eab02bc45d3e7371d24d265830f28d7ab9906ff90449ae1bf74b1092ad`
- 실제 기억 DTO SHA-256: `197b447eb342f77a8fd2d2f2a3090cc9e3257cea9d1b2dc953f04125f1f6c90f`

원본 로그는 로컬의 `sps-builder-live-memory-verified.log`다. 공개 문서에 사용자 경로·
계정·원시 로그·비공개 Core 소스를 복사하지 않는다. 문서를 추가한 HEAD 전체를 위
시험 복사본의 fingerprint와 같다고 표시하지 않는다.

## 남은 작업

내부 CTO 질문 전달, 신뢰할 역할 지침과 기억 조회 시점, 완전한 인계 UI, 질문 답변의
명세·Graph·계약 반영, CTO/Worker/QA·실제 provider/Runner 근거·납품 흐름이 남는다.
Marketplace·Preview·자체 LAN은 보류이고 기존 Tailscale은 유지한다. 이 기록으로
전체 v15 인수 기준을 완료 처리하지 않는다.

참고: [MCP 도구 계약](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
[PostgreSQL 동시성](https://www.postgresql.org/docs/current/transaction-iso.html),
[Codex 옵션 수집 구현](https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/config_override.rs).
