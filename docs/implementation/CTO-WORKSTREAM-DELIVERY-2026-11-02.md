# CTO Workstream 전달 단계

기록일: 2026-11-02. 이 문서는 통합 설계 v15의 Workstream 전달 설계 중 현재
Builder source에서 확인한 경계를 기록한다. 전체 v15 구현이나 납품 완료를 뜻하지
않으며, 자동 검사와 실제 AI 시험의 결과는 아래에서 따로 구분한다.

## 현재 범위

Lead의 `builder.dispatch-workstream`은 이미 저장된 정확한 Workstream 보드/명세 revision을
확인하고, 프로젝트에 등록된 동일 CTO ID·Agent·독립 세션을 대상으로 계획 전용 이벤트를
전달한다. 전송 전에 세션의 `plugin-tools-only-v1` 지원을 확인하며 CTO 허용 도구는
`builder.read-cto-workstream`과 `builder.acknowledge-workstream` 두 개다. 지시에는 고정된
Workstream 및 설계/기술 근거를 읽고 수신 이해·준비도만 보고하라고 명시한다. 코드 생성,
명령 실행, 파일 접근, Worker 생성, 구현·QA·납품 완료 주장은 이 전달의 권한이 아니다.

`builder.read-workstream-delivery`는 현재 기록과 Core receipt/run 상태를 조회하고,
`builder.cancel-workstream-delivery`는 준비 상태의 미송신 intent를 폐기하거나 정확히
확인된 Core run에 취소를 요청한다. 취소 요청·확인만으로 프로세스 종료를 단정하지 않는다.
상태는 provider 전달 상태이지 구현, readiness 승인, 테스트 통과 또는 납품 receipt가 아니다.

## 안정적 Intent와 저장

`requestId`는 `sps-builder-cto-delivery-v1` domain marker와 Workspace, project, CTO,
정규화된 정확한 Workstream instruction을 결합한 digest에서 결정적으로 만들어진다.
같은 intent의 재조회는 같은 Core request identity를 찾으므로 응답이 불명확하다고 새 요청
ID를 만들어 재전송하지 않는다. 명세가 바뀌면 새 revision과 새 intent가 된다.

Builder는 Core company-scoped state의 기존 revision journal/CAS를 사용해 immutable delivery
revision을 staging하고 published head를 교체한다. 일반 `set` fallback은 없다. 주요 단계는
`prepared` → `dispatching` → `submitted` 또는 `uncertain`이며, 이후 Core receipt/run을
조회해 종료 상태를 관찰한다. 응답 유실 뒤에는 같은 requestId의 Core receipt와 journal만
대조한다. receipt가 아직 보이지 않는 `dispatching`/`uncertain`은 재전송하지 않는다.
검증을 통과한 `prepared`만 명시적으로 다시 이어 보낼 수 있다. 아직 보내지 않은 prepared
intent는 명시적 취소로 폐기할 수 있다.

이번 호출에서 Core의 `sendMessage`를 아직 호출하지 않은 것이 확실하면, 호출자 Lead
권한을 재확인한 뒤 이번 호출의 정확한 `dispatching` revision만 `superseded`로 정리한다.
이것은 프로세스 취소가 아니라 미송신 기록의 폐기다. head가 달라졌거나 권한이 회수돼
정리를 확인하지 못하면 기록을 추측해 덮지 않는다. Core 호출 뒤의 응답 유실은 이 경로로
정리하지 않고 계속 같은 requestId를 조회한다.

같은 CTO의 기존 delivery가 active 또는 uncertain이면 다른 intent를 새로 만들지 않는다.
같은 Workstream 요청의 재호출은 상태를 관찰하고, 기존 전송을 자동 반복하지 않는다.
Lead/CTO 권한, 등록된 CTO identity/session, Workstream digest, 고정한 설계 기준과 기술
결정은 저장 및 전송 전후에 다시 검사한다.

## 일관성의 한계

이 보호는 Builder의 업무 배정과 delivery journal, Core의 durable keyed-session admission을
함께 사용하는 것이다. Workstream, CTO registry, pinned source, Builder journal은 서로 다른
키/저장 계약이다. 재검사와 CAS가 이들을 하나의 transaction으로 묶지는 않으며, 확인과
전송 사이의 다중 키 TOCTOU 및 외부 변경 경합을 완전히 제거했다고 주장하지 않는다.
프로세스 간 전역 잠금이나 새 scheduler도 추가하지 않는다. CAS 경합·응답 유실은 실패 또는
불확실 상태로 남을 수 있으며 자동 재시도 대신 조회와 명시적 조정이 필요하다.

한 Workstream을 다른 CTO에게 재배정해도 이전 CTO 프로세스를 자동 취소하지 않는다.
이전 실행은 현재 배정의 도구 조회/수신 확인 권한을 잃지만, 이것이 기존 프로세스 종료나
향후 Worker 작업 회수까지 증명하지는 않는다. 실제 구현 실행의 revision/회수 경계는
후속 Worker 단계에서 별도로 검증해야 한다.

Core의 도구 허용목록은 플러그인 도구 dispatch 범위다. 이것만으로 Codex CLI의 파일,
프로세스, 네트워크 또는 OS sandbox 격리가 인증되는 것은 아니다. MCP 도구 명세는 모델이
도구를 선택·호출할 수 있다고 설명하고, host가 호출을 거부할 수 있는 인간 관여를 두도록
권고하지만, 구체적 승인 UI나 승인 정책을 프로토콜이 대신 정하지 않는다. 이번 단계는
pending 보호 또는 MCP 승인 정책을 변경하거나 자동 승인을 추가하지 않았다.

## 재현 명령

DEV 의존성은 교체하지 않는다. 비공개 Source의 Desktop 폴더에서 Node24를 PATH 앞에
두고 다음 격리 operator를 실행한다. 정확한 package/lock SDK pin을 가진 깨끗한 SDK
source와 임시 Builder 사본으로 타입/빌드/전체 검사/SDK CLI를 확인한다. 기존 Builder의
`node_modules`가 이전 SDK라면 그 폴더에서의 타입 검사를 현재 pin의 결과로 간주하지 않는다.

```powershell
$env:SPS_BUILDER_SOURCE_ROOT = 'C:\path\to\SPS-MY-PluginBuilder'
# npm_execpath must identify the installed npm-cli.js used by consumer tests.
node scripts/smoke-builder-conditional-state-isolated.mjs --build-only
```

delivery 계약 테스트는 고정 CTO 허용목록/정확한 session dispatch, 미지원 정책과 CAS 부재,
Core send 및 journal head 응답 유실, prepared 재개/폐기, Workstream 개정, 동시 요청,
권한·Workspace 경계, cancellation 및 과대 응답 보호를 다룬다. fake Host 기반 계약 검사는
실제 Core DB, 실제 provider, MCP 승인 UI 또는 실계정 AI 호출의 증거가 아니다.

## 검증 상태와 미완료

- Node24.22.1 격리 타입/빌드, Builder 전체 **330/330**, SDK CLI validate/test가 통과했다.
  CTO service의15개 검사는 응답 유실·소스/정체성 변경·미송신 폐기·과대 응답·다른
  Workspace/프로젝트·취소/종료 구분을 포함한다. fake Host 결과를 실제 provider 실행으로
  사용하지 않는다. Source operator의 범위 혼합/opt-in 누락 거부 검사2개도 통과했다.
- 명시적 사용자 동의로 `--live-workstreams`와 `SPS_BUILDER_LIVE_CODEX=1`,
  `SPS_BUILDER_LIVE_WORKSTREAMS=1`을 사용한 격리 앱 시험을 실제 실행했다. 첫 Lead
  provider run은 기술적으로 succeeded였지만, MCP 목록 조회 뒤 설계 근거/초안 조회4건이
  `user cancelled MCP tool call`로 실패했다. 사용자가 직접 취소했다는 증거는 아니다.
  Lead는 초안을 저장/검증하지 못했다고 답했고 전체 시험은 exit1로 거부됐다. 설계 기준,
  기술/Workstream 저장과 실제 CTO 실행은 시작하지 못했으므로 완료로 보고하지 않는다.
- 일반 MCP 자동 승인은 추가하지 않았고 실패한 요청을 새 ID로 다시 보내지 않았다.
  추가 CLI 승인 없이 허용된 설계 도구만 실행할지 사용자에게 정책을 확인 중이다. 임시
  Main3/3이 정상 종료됐고 출력6개 종료/실패0, 내부 임시 데이터 제거를 확인했다. 진단용
  격리 Builder 사본은 보존했으며 원시 로그/계정/경로/실제 Workspace ID는 공개하지 않는다.
- 실제 CTO AI 호출은 아직 실행하지 않았다. fake session 응답이나 정책 지원 DTO는 실제
  모델의 도구 사용·지시 이해·로그인·준비 상태를 증명하지 않는다. 별도 no-AI source 앱
  재검사는 exit0으로 통과했다. mock Identity와 실제 UI/state/권한/재시작, 입력 보존 및
  미지원 전송의 Run0건을 확인했다. 문서/명세 표시 fixture는 실제 AI 산출물이 아니다.
  Main4/4 정상 종료, 출력8개 종료/실패0, 내부와 외부 임시 데이터 제거를 확인했다.
  캡처도 검토했다. 공통 harness의 로컬 복구 검사는 새 Native LAN 개발/실증이 아니다.
- 독립 Worker 생성/실행, QA와 QA 승인, Worker Task Packet, CTO 기억 및 질문 intake,
  실제 Runner/CLI와 OS 격리 증거, 구현·검증·납품 연결은 미완료다. v15 전체 AC 완료나
  설치본/실기기 검증으로 승격하지 않는다.
- 기존 DEV, 설치본, 의존성, 계정, 데이터와 MCP 승인/pending 보호는 보존 대상이다.
  Core 및 SDK를 수정·복사·교체한 단계가 아니며 버전·태그·release도 변경하지 않는다.

시험 시 Core는 `a57f4d9ab0025b98ce4c7f9f5f6bf7db7060f136`, SDK는
`c69915a518f0eb600f0ace8238144059911f8d04`의 깨끗한 source를 사용했다. 실제 실패한
live 복사본의 source 지문은 `046f66cb7fc12f69ef3cad89caae609012842aebe75b302ce2c0d760d3fc13ec`,
Worker hash는 `41f05253a4ae8f4e81890201d5c36c7c387472139290b01c232635a41785c023`다.
이후 문서 변경을 포함한 HEAD가 그 source 지문과 같다는 뜻은 아니다. Gitlink나 릴리스
지원 매트릭스·설치본은 승격하지 않았다.

별도 성공한 no-AI 앱 복사본의 source 지문은
`d9481cc0338c842d520ba8b435913008636408992e39562190b21ebf0fa328f9`다.
Worker/manifest/SDK CLI UI 집계는 위 live 복사본과 같지만 문서를 포함한 source 지문은
다르다. 실제 Host가 읽은 UI index hash는
`95b5facb82a52ce459f0eb48ca77106e2dd580ea86b3d279ec99c2ba59963f97`다.
이 UI 검사를 provider 또는 OS/실기기/서명·출시 자격으로 사용하지 않는다.

## 참고

- [통합 설계 v15](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md)
- [Workstream 명세와 수신 기록](WORKSTREAM-INSTRUCTIONS-2026-11-02.md)
- [실행별 세션 도구 제한](SESSION-EXECUTION-POLICY-2026-11-02.md)
- [MCP Tools specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
