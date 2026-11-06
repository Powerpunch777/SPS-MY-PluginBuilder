# CTO 질문 접수와 Lead 검토

후속 회신 단계는 [Lead 내부 해결의 CTO 회신](CTO-QUESTION-REPLY-2026-11-02.md)을
따른다. 아래의9도구·회신 미완료 표시는 당시 접수 단계의 기록이다. 새 intent는 별도
10도구 정책과 CTO read/ack 회신 경로를 추가했고423개/격리 앱 회귀를 통과했다.
실제 AI 시험과 사용자 답변의 설계 반영은 여전히 완료가 아니다.

2026-11-02. 사용자 확정 흐름은 **작업 중 CTO 질문 → 내부 Lead 검토 → 사용자 고유 결정이
필요한 질문만 미결정사항**이다. 일반 고객 상담/메인 Lead의 설계 질문은 여기에 섞지 않는다.
Lead가 해결할 수 있는 질문은 CTO에게 직접 답하는 것이 목표다. 이번 기록은 그 전체
자동 전달·답변·설계 개정이 끝났다는 뜻이 아니다.

## 저장과 권한

- CTO의 명세/노드/모호성/대안·장단점/권고/지연 영향을 내부 proposal로 접수한다.
  실제 등록된 CTO의 독립 세션, 정확한 Core 전달 요청·활성/미취소 run, 저장된 도구 정책,
  현재 명세 digest와 노드 소유 범위를 검사한다. 자기의 배정을 넘어선 질문은 받지 않는다.
- 질문 ID는 불변 내용/실제 reporter와 결합한다. 같은 ID의 결과 조회를 중복 제출로
  처리하지 않고, 다른 내용/다른 CTO로 바꾸면 거부한다. 프로젝트 보드는 기존 CAS
  journal을 재사용한다. 동시 접수는 명시적 conflict이며 일반 set/자동 재송신이 없다.
- 질문 제출은 먼저 보드에 durable 저장한 뒤 등록된 Lead `cto-inbox`로 dispatch한다.
  전달은 안정된 Core admission receipt에 결합한다. 결과가 불명확하면 재전송하지 않고
  `builder.read-cto-intake`로 그 receipt와 정확한 질문/고정된 출처를 읽어 복구한다.
  `main`, `decisions`, 원래 CTO 세션 또는 새 임시 Lead 세션으로 fallback하지 않는다.
  제출한 CTO는 Lead 검토를 기다리지 않고 반환한다. 같은 Agent의 직렬 실행 대기열에서
  Lead 응답을 기다리면 이후 CTO 처리와 교착될 수 있기 때문이다.
- 이 전달 경로는 등록된 9-tool CTO-intake profile과 정확한 Core-bound Lead run을
  사용한다. read/review는 접수된 질문 하나와 고정된 근거에만 결합하며, 일반 Lead run이
  프로젝트 내부 CTO 질문을 대신 읽거나 검토하는 우회 경로를 만들지 않는다.
- CTO는 자기 질문 한 건과 현재 보드 revision만 읽을 수 있다. 다른 CTO의 내부 질문이나
  사적 기억은 반환하지 않는다. 자기 질문의 접수/Lead 검토를 조회하는 기능이지 실제
  응답 전달이나 사용자 답변의 수신 확인은 아니다.
- 프로젝트의 전체 내부 접수와 검토는 준비된 Lead 세 세션 중 `cto-inbox`의 활성 run만
  수행한다. 메인/decisions/CTO/Worker 세션에서 Lead 검토를 대신할 수 없다.
- Lead는 기존 명세로 해결, 위임 범위 선택, 사용자 결정 필요 중 하나를 판단하고 근거와
  이유를 기록한다. 근거 참조는 해당 명세에 연결된 실제 설계/기술/Workstream ID만 받지만,
  그 의미가 타당하다는 독립 검증은 아니다. AI 의미 판단을 키워드로 하드코딩하지 않는다.

검토 결과를 과거 기록 위에 덮지 않고 새 보드 revision으로 남긴다. 개정/다른 배정의
질문을 새 명세의 유효한 결정으로 대체하지 않는다. `user-decision-needed`만 현재 정확한
Workstream digest가 유지될 때 사용자 UI provider에 투영한다. 미검토/Lead 직접 해결
질문은 목록에 나오지 않는다. 조회/저장 오류를 완료나 '질문 없음'으로 표시하지 않는다.
Lead가 내부적으로 해결할 수 있다고 판단한 질문의 목적지는 사용자 미결정사항이 아니라
원래 CTO에 대한 직접 회신이다. 이는 제품 흐름의 구분이며, 현재 CTO 회신 전달은 아직
연결되지 않았다. 오직 Lead가 `user-decision-needed`로 분류한 질문만 사용자가 선택할
미결정사항으로 투영한다.

## 화면과 현재 미완료

미결정사항 목록은 위의 CTO 출처만 사용한다. 일반 초안의 질문은 메인 초안/설계 문서에
남기고 그 목록으로 옮기지 않는다. 과거 저장 자료나 기존 답변/설계 해석 계약을 삭제하는
마이그레이션은 없다. CTO 권고를 Lead 추천으로 바꿔 표시하지 않는다.

사용자 답변을 CTO 질문 ID와 정확히 연결하는 새 경로는 아직 미완료다. 따라서 해당
질문은 읽기 전용이며 답변 입력/전송을 비활성화하고 준비되지 않았다고 표시한다. 이를
연결되지 않은 일반 decisions 대화로 보내거나 가짜 답변/수신/설계 revision을 만들지 않는다.

durable CTO→Lead dispatch와 receipt-bound 질문 조회/검토 계약은 추가됐지만, 이를 실제
AI 호출 성공이나 Lead 검토 완료로 간주하지 않는다. Lead 자체 해결 결과를 원래 CTO에
직접 회신하는 전송 경로, 사용자 선택 답변을 질문 ID에 묶는 경로, 그 답변의 공유 기억/
새 설계 Revision/Workstream 재전달 연결은 아직 미완료다. 이들을 일반 저장 성공이나
현재 UI 표시로 완료 처리하지 않는다. 실제 AI 시험은 승인 방식 결정 전 다시 실행하지
않는다. 자동 MCP 승인 override를 추가하지 않았고, 이전 MCP 취소 처리 시험을 성공으로
바꾸지 않았다.

## 기존 실행과 기억

이전2/4도구 CTO intent는 그대로 보존한다. 새 CTO 전달만 명세 조회/수신·자기 기억
조회/저장·질문 제출/자기 접수 조회의6도구를 고정한다. 기존 intent의 정책을 확대하거나
같은 requestId를 새 정책으로 재전송하지 않는다. Core/SDK는 업무 중립 API를 유지한다.

같은 CTO의 명세가 개정돼도 기존 run을 자동 취소하지 않는다. 여전히 활성인 옛 run은
자기 private 기억을 옛 전달 출처로만 정리할 수 있다. 이것이 최신 명세 수신/완료/새 질문
등록 권한은 아니다. CTO가 중단/계속/재작업을 판단한다는 v15를 모든 개정의 자동 회수로
바꾸지 않았다. 질문 접수/Lead 검토/사용자 목록은 현재 digest를 별도로 요구한다.

CAS와 역할/run/명세의 재확인은 하나의 원자 transaction이 아니다. 저장 직후 회수나
응답 유실이면 publish된 기록이 남아도 호출이 오류가 될 수 있으며 삭제/자동 rollback을
주장하지 않는다. Core 도구 허용 목록은 OS sandbox 인증도 아니다.

## 검사

초기 격리 타입/빌드/전체383개/SDK CLI가 통과했다. 새 서비스 계약 검사11개는 제출과
검토 권한, 사용자 목록 필터, stale 명세, 다른 범위, 취소/퇴직, CAS 경합·응답 유실과
자기 질문 조회를 다룬다. fake Host이며 실제 모델 실행이나 자동 Lead 전달의 증거가 아니다.
화면 통합 작업 뒤 최종 전체/실제 source 앱 검사는 아래에 별도로 기록한다.

화면 통합 뒤 전체383/383·타입/빌드·SDK CLI도 재통과했다. 첫 앱 시험은 미결정사항
화면에서 메인 전용 새로고침 버튼을 찾는 스크립트 오류, 두 번째는 새로고침 직후 일반
초안 질문 수의 즉시 assertion 실패로 종료했다. 각각 Main2/2·출력4개 종료/실패0과
내부 임시 데이터 제거를 확인했고 진단 복사본은 보존했다. 실제 이동 경로와 비동기
새로고침 완료 대기를 반영해 재검사했다. 이 두 실패는 앱 통과로 세지 않는다.

마지막 재검사는 동일383개·타입/빌드·SDK CLI와 source Desktop no-AI 앱까지 exit0이다.
mock Identity/실제 UI bridge에서 일반 초안 질문과 사용자 목록의 분리, 미검토/내부 해결
제외, 사용자 결정 필요1건 표시, CTO 권고와 Lead 추천의 구분, 미완성 답변 입력/전송
차단과 action0건을 확인했다. 기존 권한/상태/재시작 회귀도 통과하고 캡처를 검토했다.
표시 질문은 명시적인 가로챈 DTO fixture이며 실제 CTO나 Lead가 저장한 질문이 아니다.
제거 후 실제 사용자 결정 provider는 null이다. Main4/4 정상 종료, 출력8개 종료/실패0와
임시 데이터 제거를 확인했다. 기존 로컬 복구 harness는 새 Native LAN 실증이 아니다.

이후 추가된 durable CTO→Lead dispatch 및 `builder.read-cto-intake` 연결은 위의 과거
383개 시험 결과에 포함되지 않는다. 후속 Node24.22.1 격리 검사에서는 타입/빌드,
전체 **404/404**, SDK CLI validate/test가 통과했다. 도메인9개, 전달 서비스와 실제
platform wrapper11개, 강화한 질문 서비스12개가 포함된다. 정확한 Core receipt/run
결합, 저장 후 전달, 대상 변경/취소/명세 변경/미지원 정책/CAS 누락 차단, 응답 유실 후
동일 request 조회와 미재전송, 개인 기억/출력 비공개를 fake Host로 검사했다.
이는 실제 CTO/Lead 모델 실행이나 실제 Core를 통한 질문 전달 성공의 증거가 아니다.

초기 격리 타입 검사는 작성 중 테스트의 타입 오류, 다음 타입 검사는 두 테스트 fixture의
타입 지정 오류로 실패했다. 이를 고친 전체 검사에서는 신규 전용 도구를 일반 Lead 도구와
구분하지 않은 정책 목록 assertion1개가 실패했다. 일반 Lead 권한을 확대하지 않고 전용
9-tool 정책과 전체 manifest 합집합을 검증하도록 고쳤다. 이 실패들을 통과로 세지 않는다.

마지막 no-AI source 앱 재검사도404개/타입/빌드/SDK CLI 이후 exit0이다. mock Identity와
실제 Host/UI bridge에서 기존 상태·권한·재시작 및 CTO 질문 필터/읽기 전용 표시 회귀를
확인하고 캡처를 검토했다. 질문 화면은 이전과 같은 명시적 DTO fixture이며 실제 질문
작성/Lead 검토가 아니다. Main4/4 정상 종료, 출력8개 종료/실패0, 내부 임시 데이터 제거를
확인했다. DEV와 설치본/로그인/의존성은 바꾸지 않았다. 추가 도구 등록과 no-AI 화면
회귀가 실제 AI의 도구 승인이나 CTO 회신/사용자 답변 처리를 증명하지 않는다.

이 후속 사본의 source 지문은 `fff3057a340f8fa44be6e99a75e8273252b070ae9039a2acc900e1e89dcdb749`,
manifest는 `599036d8ba2a0b16876d40093bf3d4d016d02c9cf77321684b3feb9af49a20e2`,
Worker는 `ebaf0a52287937b03202afc5d78e8a2b68d450de5594109ffc3fce40c2b7c564`,
SDK CLI UI 집계는 `62928a714928dcde0f73ee1cfbcb62250cfa40e114bb365425321ef88c53f286`,
실제 Host UI index는 `af179a1093ddb6530200ab71f865ccb0fb16559784f1997c54e787ab929e3e15`다.
아래 표는 이전383개 시험 사본 식별을 그대로 보존한다. 이 후속 기록을 추가한 문서까지
시험 사본과 같은 source 지문이라고 주장하지 않는다.

검사 시 Core/SDK는 `a57f4d9ab0025b98ce4c7f9f5f6bf7db7060f136` /
`c69915a518f0eb600f0ace8238144059911f8d04` clean source를 유지했다.

| 식별 | SHA-256 |
| --- | --- |
| 최종 시험 사본 source | `07111e392dbf60af1cd19116155145672ccaff14c6dafb54de02f144eeb1e7e7` |
| manifest | `3507349595e5060e1b3fcbea61c9ba60ec9b3a4db4aa36bf49bbc2f2dec98846` |
| Worker | `da50758214495e6b31b7246a177f934aade44296c60737c70a194692a379782d` |
| SDK CLI UI 집계 | `5795d7adf1ee26eed56a36e5fff33a8529bcaf47014fbed202e8991df6a551f5` |
| 실제 Host UI index | `6c6daa7a447197d2031f9b0d8c884dbdc4922aa15ac03a9f741f5d32a2cc23ac` |

문서 후속 수정까지 같은 source 지문이라고 주장하지 않는다. 계정·실제 Workspace
식별자·사설 소스·원시 로그/캡처는 공개 레포에 올리지 않는다. 실제 모델 실행/OS 격리/
두 PC/설치본·서명·Stable 자격은 위 테스트가 증명하지 않는다.

Node24/PATH24/npm_execpath/절대 `SPS_BUILDER_SOURCE_ROOT`를 지정한 비공개 Source
Desktop에서 `node scripts/smoke-builder-conditional-state-isolated.mjs --build-only`로
재현한다. live opt-in은 없으며 DEV의 node_modules를 바꾸지 않는다.

기존 DEV/설치본/계정/데이터·Tailscale은 보존한다. Marketplace·Preview·자체 LAN은
계속 보류다. 독립 Worker/QA/Task Packet/GitHub·Runner/납품과 전체 v15 AC는 남아 있다.
[v15](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md) 2H.6과
[MCP 공식 도구 계약](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)을
참고했으며 비공개 Core나 외부 코드를 공개 Builder에 복사하지 않았다.
