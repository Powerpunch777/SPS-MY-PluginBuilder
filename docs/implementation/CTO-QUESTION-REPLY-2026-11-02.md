# Lead 내부 해결의 CTO 회신

2026-11-02. v15 2H.6의 **CTO 질문 → Lead 내부 검토 → 해결 가능한 질문은 원래 CTO에
직접 답변, 사용자 고유 결정만 미결정사항** 흐름을 따른다. 고객 상담의 모호성은 메인
Lead에서 다룬다. 사용자 대신 답하거나 새 명세를 확정하는 우회 수단이 아니다.

## 저장과 전달

- `builder.answer-cto-question`은 정확한 질문에 결속된 현재 Lead `cto-inbox` run만
  사용한다. 실제 Core admission receipt, 저장된 질문/내부 검토, 현재 Lead와 명세를
  확인한다. 같은 run이 `existing-specification` 또는 `delegated-choice` 검토를 먼저
  저장해야 한다. `user-decision-needed`와 미검토 질문의 내부 답변은 거부한다.
- 검토 이유와 답변은 별개다. 명시적 답변 text, 선택지 ID 또는 null인 자유 답변,
  실제 고정된 설계/기술/Workstream 참조를 저장한다. 존재하지 않는 선택지·근거,
  8192 UTF-8 bytes를 넘는 답변은 받지 않는다. 의미의 정확성은 Lead의 판단이며
  키워드로 답을 고르거나 사용자 동의를 만들어내지 않는다.
- 질문·검토·답변에 결속된 안정된 requestId와 불변 CAS journal을 먼저 남기고 원래
  등록된 CTO의 기존 단일 세션으로 전달한다. 다른 CTO/새 세션을 대신 만들지 않는다.
  대상 변경, 명세 개정, 취소, 권한 회수, 미지원 정책은 중단한다. 여러 키의 재확인은
  단일 DB transaction이 아니며 응답 유실 후 기록이 남을 수 있음을 숨기지 않는다.
- Core 호출 뒤 결과가 불분명하면 같은 request의 receipt만 확인한다. 새 ID 생성,
  자동 재전송, 다른 대상 선택은 하지 않는다. 저장만 완료된 정확한 prepared intent의
  명시적 재개만 가능하며, proven-unsent dispatch marker는 그 사본만 퇴역시킨다.
- Lead는 CTO 답변을 기다리지 않고 admission 후 반환한다. 같은 Agent의 직렬 큐에서
  서로 기다리는 교착을 피한다. admission은 실제 모델 시작이나 수신 확인이 아니다.

## CTO 수신

회신 turn은 `builder.read-cto-question-answer`, `builder.acknowledge-cto-question-answer`
두 도구만 허용한다. 실제 Core receipt/run과 등록 CTO의 독립 세션, 원래 질문/명세를
확인한다. 처음 질문한 옛 Workstream run이나 다른 CTO가 ID를 주장하는 것만으로는
읽기/수신 확인 권한을 얻지 못한다. 코드·명령·파일·기억 쓰기·Worker/QA 실행 권한을
주지 않는다. 후속 구현·재계획 작업이 완료됐다는 뜻도 아니다.

CTO는 실제 이해한 내용을 4096 UTF-8 bytes 이내로 기록한다. 같은 내용의 수신 확인은
다시 쓰지 않고, 이미 남긴 내용을 덮지 않는다. 응답 유실 시 재송신 없이 기록을 조회한다.
수신 확인 이후 provider가 실패/취소돼도 확인 사실은 보존한다. 확인은 답의 정확성,
개발·QA·업무 완료, 변경 명세 수락, 사용자 승인과 다르다. 사적 Lead/CTO 기억이나 raw
provider 출력은 반환하지 않는다.

## 과거 정책 보존

기존 정확한9도구 intake intent는 그대로 읽되 answer 권한을 얻지 못한다. 새 intent만
정확한10도구 정책에 `builder.answer-cto-question`을 포함한다. 과거 requestId에 새
정책을 덧붙이거나 기존 intent를 재송신하지 않는다. 일반 Lead 및 기존 CTO Workstream
정책도 넓히지 않는다. CTO 회신 turn의 별도2도구 목록과 모두 manifest 계약으로 검사한다.

## 검사와 현재 한계

Node24.22.1 격리 사본에서 타입/빌드, 전체 **423/423**, SDK CLI validate/test가 통과했다.
새 reply domain10개와 서비스8개, 기존 intake의 legacy 정책 보존 회귀를 포함한다.
서비스 검사는 fake Host로 질문/검토→admission→read/ack 경로, 사용자 결정 거부,
잘못된 선택지/근거/크기, 권한·대상·명세·취소·CAS/정책 누락, 응답 유실 후 미재송신,
수신 뒤 provider 실패와 사적 출력 비공개를 다룬다. 실제 Core나 AI 판단을 증명하지 않는다.

초기 타입 검사는 테스트의9/10도구 literal union 비교·변조 fixture 지정 오류로 실패했고,
변조 값을 string collection으로 다루도록 수정 후 재통과했다. 실패한 타입 검사를 통과로
세지 않았다. 마지막 no-AI source 앱도423개/타입/빌드/SDK CLI 이후 exit0이다. 실제
Host/UI bridge와 mock Identity로 기존 권한/상태/재시작·질문 필터/읽기 전용 표시를
확인했다. 표시 질문은 명시적 DTO fixture이며 실제 모델 저장이나 회신이 아니다.
Main4/4 정상 종료, 출력8개 종료/실패0 및 내부 임시 데이터 제거를 확인했다. 기존 로컬
복구 harness는 새 Native LAN 실증이 아니다.

| 시험 사본 | SHA-256 |
| --- | --- |
| source | `c4e012ee1adb5e94ca31c4eef9bd62447345b4f9a742d60fa3f9c1611357888c` |
| manifest | `fc3afdda68c31cc5b3ceac57473c1d2b40b3d903fe2a39cf78a365946e2510ab` |
| Worker | `495bd2d20c42dcdae2ad2ae5d7120dbe0bdb3670ac52c2640927cbb01673eee5` |
| SDK CLI UI 집계 | `62928a714928dcde0f73ee1cfbcb62250cfa40e114bb365425321ef88c53f286` |
| 실제 Host UI index | `af179a1093ddb6530200ab71f865ccb0fb16559784f1997c54e787ab929e3e15` |

이 문서 후속 수정까지 시험 사본과 같은 source 지문이라고 주장하지 않는다. Core/SDK는
`a57f4d9ab0025b98ce4c7f9f5f6bf7db7060f136` /
`c69915a518f0eb600f0ace8238144059911f8d04` clean source 그대로다. 실제 계정·Workspace·
원시 로그/캡처·사설 소스는 공개 레포에 올리지 않는다. Node24/PATH24/npm_execpath/
절대 SPS_BUILDER_SOURCE_ROOT를 지정한 비공개 Source Desktop에서
`node scripts/smoke-builder-conditional-state-isolated.mjs`로 재현한다. live opt-in은 없다.

## 후속 사용자 결정

사용자는 허용된 설계 도구에 한해 매 호출 CLI 확인 없이 실행하도록 확정했다. 목록 밖
도구와 명령·파일 작업 차단은 유지한다. 이는 CTO 질문의 사용자 결정 흐름과 별개다.
위 검사 당시에는 아직 해당 MCP 자동 승인 설정을 구현/시험하지 않았고 실제 AI 재실행도
없다. 공식 Codex 설정을 확인한 뒤 해당 범위만 연결하고 실제 검증할 후속 작업으로 둔다.
기존 DEV·설치본·계정·데이터·Tailscale은 보존한다. 전용 도구 허용 목록은 OS 격리 인증이 아니다.

**남음:** 실제 CTO→Lead→CTO 모델 검증, 사용자 결정 답변의 질문 ID 결합/Lead 기억과
설계 Revision/Workstream 개정·전달, CTO의 중단·계속·재작업과 Worker/QA/Task Packet/
Runner/납품. CTO 회신의 자동 검사로 전체 Builder나 실기기/출시 완료를 선언하지 않는다.
Marketplace·Preview·새 Native LAN은 계속 보류한다.

## 참고

- [통합 설계 v15 2H.6](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md)
- [MCP 도구 계약](https://modelcontextprotocol.io/specification/2025-06-18/server/tools):
  도구 형식·입력 검증·접근 제어를 참고했다. 외부 코드나 비공개 Core를 공개 Builder에
  복사하지 않았으며 이 명세가 자동 승인이나 SPS의 OS 격리를 증명하지 않는다.
- [공식 Codex 설정](https://developers.openai.com/codex/config-reference):
  MCP 서버별 도구 허용 목록과 개별 도구 approval mode를 조사했다. 전체 승인/샌드박스
  해제나 사용자 전역 설정 변경을 허용받은 것으로 해석하지 않는다.
