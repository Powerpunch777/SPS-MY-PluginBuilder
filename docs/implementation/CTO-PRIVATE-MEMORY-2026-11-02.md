# CTO별 독립 기억

2026-11-02 개발 기록. 설계 v15의 프로젝트별 CTO 단일 세션과 전용 기억을 구현하는
단계이며 전체 Builder 완료나 실제 CTO AI 실행의 증거가 아니다.

## 구현

기억은 `(Workspace, projectId, ctoId)`별로 분리한다. 같은 Codex 계정/Agent를 사용하는
CTO도 서로의 기억을 읽지 못한다. Workstream ID는 현재 호출 권한의 맥락이며, Workstream
마다 별도 기억 풀을 만드는 것이 아니다. 같은 CTO는 이후 전달받은 명세에서도 자신의
이전 노트를 복원할 수 있다. Core에 역할별 메모리 시스템을 새로 추가하지 않는다.

- `builder.read-cto-memory`: 등록된 해당 CTO의 독립 세션, 정확한 전달 요청과 Core run,
  현재 배정, 활성·취소되지 않은 실행, 저장된 도구 허용 목록을 확인한 뒤 자기 기억만 읽는다.
- `builder.update-cto-memory`: 같은 조건에서 정확한 이전 revision을 지정해 새 불변 revision을
  저장한다. 일반 set/무조건 덮어쓰기, 자동 쓰기 재시도, 응답 유실 시 새 실행은 없다.
- 내용은 맥락·판단·가정·열린 질문의 제한된 텍스트다. 현재 전달된 명세의 requestId와 digest를
  서버에서 연결한다. 다른/임의 요청 ID를 근거로 새 해석을 쓰지 못한다. 변경 없이 승계한
  기존 노트만 이전 출처를 유지할 수 있다. 기억은 모델의 해석이지 사실 검증·승인·최신 명세가 아니다.
- 첫 조회는 null이며 가짜 초기 기억을 자동 저장하지 않는다. 빈 revision을 명시적으로
  저장할 수는 있지만 이력 삭제나 개인정보 폐기 기능을 뜻하지 않는다.
- Lead/다른 CTO/Worker가 자동 조회하는 UI data provider나 공유 기억 연결은 추가하지 않는다.
  상위 보고는 후속 명세·질문·Graph·증거 인터페이스로 처리해야 한다.

일반 텍스트/배열/객체를 엄격하게 검사하고 새 키·getter·비표준 prototype·sparse 배열,
잘못된 Unicode·제어 문자·크기 초과를 거부한다. 최대128개 노트, 각4096 UTF-8 bytes,
노트별1~32개 출처, 기억128KiB, 전체 출처128개와 저장 record 상한을 둔다.

## 기존 실행의 권한 보존

이전 CTO 전달은 명세 조회/수신 확인 두 도구만 저장했다. 이 기록은 여전히 두 도구만
보존한다. 새 전달만 기억 조회/저장을 더한 네 가지 계획 도구를 고정하며, 예전 prepared를
명시적으로 재개해도 원래 두 도구 정책을 사용한다. 기존 요청 ID를 다른 정책으로 자동
재전송하거나 저장된 intent를 업그레이드하지 않는다. 새 profile 역시 코드·명령·Worker
실행 권한이 아니다. CLI의 추가 도구 승인 정책은 바꾸지 않았고 사용자 확인을 기다린다.

## 검증과 한계

초기 격리 타입 검사에서는 새 테스트의 string literal
타입 한 곳이 실패했다. 이를 수정한 Node24.22.1 재실행은 타입/빌드/전체357개/SDK CLI
validate/test를 통과했다. 이어 빌드된 Worker의 JSONL 왕복 검사를 확장해 실제
public SDK wire의 getRequest/getRun/CAS로 자기 기억 조회·저장·재조회를 검사했다.
Lead 접근과 일반 UI data provider를 통한 private memory 조회도 거부했다. Host/실행
응답은 mock이며 새 provider 전송은 한 번도 호출하지 않는다. 이 검사를 포함한 최종
격리 타입/빌드/전체 **357/357**과 SDK CLI validate/test도 통과했다.

같은357개 검사를 포함한 별도 source Desktop no-AI 시험도 exit0이다. mock Identity와
실제 UI bridge/state/권한/재시작·미지원 전송의 Run0건/입력 보존을 확인하고 캡처도
검토했다. CTO 기억을 실제 모델이 쓰는 시험이 아니라 현재 manifest/Worker와 기존 UI의
회귀 검사다. 명세/질문/준비도 표시 fixture는 실제 AI 산출물이 아니다. Main4/4 정상
종료, 출력8개 종료/실패0, 임시 데이터 제거를 확인했다. 공통 harness의 기존 로컬 복구
검사를 새 Native LAN 개발/추가 실기기 시험의 근거로 사용하지 않는다.

계약 검사는 두 CTO가 같은 Agent를 쓸 때 분리, 다른 Workspace/project/Lead/세션/run
거부, Core receipt 회수, 취소·종료·퇴직, CAS 동시 쓰기, 응답 유실과 기존 노트 복원,
새로운 해석이 이전 근거를 빌리지 못하는 경로를 다룬다. 가짜 Host와 고정 데이터를
사용하므로 실제 DB/모델의 기억 사용이나 OS 격리를 입증하지 않는다.

권한 재확인과 CAS는 실행 취소/배정 변경과 하나의 원자적 transaction이 아니다. 저장
직후 권한이 바뀌면 호출이 실패해도 이미 저장한 불변 head가 남을 수 있으며 자동 삭제나
원자적 rollback을 주장하지 않는다. 현재 도구는 임의 노트 안의 모든 비밀을 탐지하는
보안 DLP가 아니다. 자격증명/원시 사적 대화를 읽어 넣는 도구는 허용하지 않지만 입력
텍스트의 기밀성 책임과 향후 보존·삭제 정책은 별도다.

이 단계에서 새 실제 AI 시험은 하지 않는다. 이전 실제 Lead 시험은 MCP 도구 호출이
취소 처리되어 CTO 실행 전 실패한 상태다. 시험 동의는 실제 성공 증거가 아니다.
DEV/설치본/계정·데이터/의존성은 보존하며 Core/SDK/DB schema/버전/릴리스는 바꾸지 않는다.
CTO 질문 intake·Worker/QA·Task Packet·GitHub/Runner·변경 전파·납품과 전체 AC는 남아 있다.
Marketplace·Preview·자체 LAN은 계속 보류한다.

검사 시 Core/SDK는 `a57f4d9ab0025b98ce4c7f9f5f6bf7db7060f136` /
`c69915a518f0eb600f0ace8238144059911f8d04` clean source다. 최종357개+앱 복사본:

| 식별 | SHA-256 |
| --- | --- |
| source 지문 | `ebb848c9466b648614c66ca7dcb71b8366abb5d61ea2f57199b7b1230ab021c9` |
| manifest | `fb9a6223abd4ffe337ee6ed26a80a809ea99dbb7ec554601cd5d30fdae2b4c78` |
| Worker | `0ed4681b58aa0833f235c8f9bb59eb0ec6ce52a1eaabb70e15b8033727bd6c86` |
| SDK CLI UI 집계 | `2a5471fcd2a303ab468356416c41aea7f266a571ec97a78c341a71ef67be2d6c` |
| 실제 Host UI index | `3373eee9c523cf5f6c0e3ad2b964c87fc8200df3bbe87e7da34e0c3c09706e59` |

문서의 후속 수정까지 위 source 지문과 같다는 뜻은 아니다. 원시 로그/실제 Workspace
식별자/계정/로컬 경로·비공개 소스는 공개 레포에 올리지 않는다.

## 재현

Node24를 PATH 앞에 두고, npm의 실제 CLI 위치를 `npm_execpath`로 지정한 다음 비공개
Source Desktop 폴더에서 아래 operator를 사용한다. 현재 Builder package/lock의 정확한
SDK SHA를 사용하는 격리 사본을 검사하며 원래 DEV의 node_modules는 교체하지 않는다.

```powershell
$env:SPS_BUILDER_SOURCE_ROOT = 'C:\path\to\SPS-MY-PluginBuilder'
node scripts/smoke-builder-conditional-state-isolated.mjs --build-only
```

설계 근거: [v15](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md) 2B.2/2G.2,
[CTO 전달](CTO-WORKSTREAM-DELIVERY-2026-11-02.md),
[MCP 공식 도구 계약](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
외부 코드나 비공개 Core를 공개 Builder에 복사하지 않았다.
