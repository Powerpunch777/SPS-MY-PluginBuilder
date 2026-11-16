# Lead/CTO 계획 도구 실행 제한

이 단계는 v15 Builder를 위한 제한된 실행 계약 연결이다. CTO 자동 전달, 실제 AI
성공, OS 격리나 전체 Builder 완성의 증거는 아니다.

## 구현 범위

- 새 Lead 대화는 설계·기억·질문·CTO 등록·기술 선정·Workstream 작성/조회에 필요한
  선언된 도구 15개를 명시한다. CTO 전용 명세 조회/수신 확인은 Lead 목록에서 제외한다.
- CTO 계획 실행용 목록은 `builder.read-cto-workstream`과
  `builder.acknowledge-workstream` 두 개다. 상수와 지원 확인 기반만 준비됐으며
  CTO 메시지 전송/큐는 아직 연결하지 않았다.
- 전송 전에 해당 세션의 Core 지원을 조회한다. 메서드 누락, 미지원/잘못된 응답은
  실행이나 대화 기록 저장 전에 거부한다. 제한 없는 전송으로 대체하지 않는다.
  지원 표시는 설정 정보이며 실제 CLI 로그인이나 성공, OS 격리 인증이 아니다.
- 새 대화 turn에는 정확한 허용 목록을 저장하고 재시작 후에도 그 목록으로 전송한다.
  전송 후 응답 유실은 기존 Core requestId 조회로만 복구하며 다시 보내지 않는다.
  제한 정보가 없는 과거 prepared turn은 읽을 수 있지만 자동 전송하지 않는다.
  기존 submitted/uncertain 기록의 상태 확인은 지원 조회 실패와 별개로 유지한다.
- 공개 SDK는 `c69915a518f0eb600f0ace8238144059911f8d04` 소스 커밋으로 고정했다.
  저장된 Agent 계정·cwd·모델·설정을 변경하지 않는다. 현재 Core의 첫 지원 경로는
  local Codex CLI와 invocation-bound Workspace 도구이며 다른 backend는 미지원이다.
- 이전 실제 시험 helper의 임의 CLI 인수와 MCP 자동 승인 재정의를 제거했다.
  제한 프로필은 Core가 실행별로 적용한다. 이 변경이 일반적인 도구 자동 승인
  정책을 새로 확정한 것은 아니다. 허용 도구의 CLI 추가 승인 정책은 사용자 확인이
  남아 있으며 실제 계정 시험은 아직 진행하지 않았다.

## 검증

Node24.22.1 격리 복사본에서 타입 검사·빌드·전체308/308·SDK CLI validate/test를
통과했다. 사용자 DEV의 설치된 의존성을 교체하지 않았다. 지원 미확인/미지원의
무전송·무저장, 기존 prepared의 제한 고정, 과거 무제한 prepared의 전송 거부,
응답 유실 조회와 기존 대화·질문·기억·Workstream 회귀를 포함한다.

첫 no-AI 앱 시험은 이전 계약의 'Process run 시작 후 실패' 기대 때문에 실패했다.
실제 앱은 새 보호 경로에 따라 시작 전에 거부했고 Run/turn을 만들지 않았다.
이를 성공한 실행이나 AI 검증으로 보고하지 않는다. 시험은 종료/정리됐고, 실제
계약에 맞춘 차단·입력 보존·재시작 시험을 다시 수행해 통과했다. 미지원 상태의 실제
HTTP 오류를 관찰했고 UI 입력 문장과 대화/Run0건을 보존했으며, 같은 요청 ID 재시도와
Host 재시작 후에도 새 실행은0건이었다. 문서/Graph/질문/수신 상태 표시 자료는 여전히
명시적인 UI fixture이며 실제 AI가 저장한 자료가 아니다.

오류 안내의 첫 수정은 Core UI bridge가 `Error`가 아닌 plain DTO를 반환해 실제 앱에서
식별되지 않았다. getter를 읽지 않는 own `message` 처리로 고치고 자동 검사와 앱에서
"보호 실행을 확인하지 못해 전송하지 않았습니다" 문구를 확인했다. 알 수 없는 실패는
여전히 접수 불명확 안내이며, 임의의 원시 오류/비밀값을 화면에 노출하지 않는다.

그 뒤 한 앱 시험은 재시작 초기 문서에서 `Uncaught`/빈 화면으로 종료했다. 원인은
확정하지 않았고 통과로 세지 않는다. 프로세스 종료/정리를 확인한 뒤 같은 코드·같은
지문으로 다시 실행한 마지막 시험은 exit0이었다. 실패 로그도 로컬 진단용으로 남겼다.
최종 Main4/4·출력8개 모두 정상 종료/실패0·임시 데이터 제거를 확인했다. 공통 하네스의
기존 로컬 복구 항목은 새 Native LAN 개발/연결 실증 근거가 아니다.

구현 커밋은 `75cfd33fe97bc9be421acf5e5416a0d3142b8a6e`, Core는
`a57f4d9ab0025b98ce4c7f9f5f6bf7db7060f136`이다. 아래 지문은 최종308개+앱 시험에
복사된 소스와 산출물이며, 이후의 이 설명 문서 변경까지 같은 지문이라고 주장하지 않는다.

| 식별 | SHA-256 |
| --- | --- |
| 시험 사본 소스 | `589106f57e7a2e73845548f53bd796fca8f6df84bccb2011a6837570653dd7d0` |
| manifest | `1936076ca27fc88c7aced43a4b94231e3d968fef0d300d1c01ef226513b800a6` |
| Worker | `62cd4f1738c7c0d2c93ad2d8687aa57d9fec462fd9e07b1479fb0c4fd90bdbfe` |
| SDK CLI UI 집계 | `c092e6cbf1fb4666c74882b01b76191a6fd46ecee5e8e13902a4b8562ae3eb07` |
| 실제 Host UI index.js | `d4b2dfbea7a3563b2d7c2f2d844a162a55240906579f5e49076931f37d73491b` |

Source Desktop에서 Node24/PATH24, `npm_execpath`, 절대 경로 `SPS_BUILDER_SOURCE_ROOT`로
`node scripts/smoke-builder-conditional-state-isolated.mjs`를 실행했고 live opt-in은 없다.
최종 로그 `sps-builder-session-policy-ui-final-recheck.log`와 캡처는 로컬에 보관한다.
계정·Workspace/기기 식별자·사설 소스가 있는 원시 로그나 캡처는 공개 레포로 복사하지 않는다.

Core 제한 계약의 자동 검사206개와 SDK 전체195개는 별도 증거다. 어느 결과도 실제
Lead/CTO 모델 실행, 두 PC, OS 샌드박스, 설치/서명/Stable 자격을 대신하지 않는다.
Core의 역할·업무 판단을 새로 만들거나 비공개 소스를 이 공개 레포로 복사하지 않았다.
Marketplace·Preview·자체 LAN은 계속 보류한다.
