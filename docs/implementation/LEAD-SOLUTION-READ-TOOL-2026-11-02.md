# Lead의 Solution 조회 도구

## 연결 범위

Builder `f4cb7a376c7b2f3e78c868182293135bef4bc049`에서 `builder.read-solution` 도구를
등록했다. 한 Builder 프로젝트의 저장된 Solution Revision을 읽는다. Graph 작성이나 고객
승인·납품 도구가 아니다. Core 역할 모델에 Lead를 추가하지 않는다.

- 인자는 정확히 `{ projectId: string }`이며 다른 필드·getter·잘못된 ID는 거부한다.
- Host가 확인한 호출 context의 Workspace·Agent·Run·session UUID가 필요하다.
- 현재 Lead 선택과 준비된 세션 기록을 읽어 같은 Agent 및 세 세션 중 하나인지 확인한다.
- 읽기 전후 선택 revision과 세션 binding을 재확인한다. 다른 Worker, 이전 Lead,
  다른 Workspace, 아직 준비하지 않은 세션 또는 session metadata가 없는 Host는 거부한다.
- 저장·Agent 실행·세션 생성은 하지 않는다. 결과가 없으면 `solution: null`을 반환하며
  임의의 예시 Graph를 만들지 않는다. 참조 문자열만으로 승인이나 납품을 주장하지 않는다.

도구 선언은 manifest와 플랫폼 등록에서 같은 파일을 참조한다. 새 capability
`agent.tools.register`가 추가됐으므로 기존 설치본에 자동 적용·승인하지 않는다. 기존 DEV는
의존성·패키지·설정을 그대로 유지했다. 새 개발 패키지의 명시적 설치는 별도 작업이다.

Run context를 단순히 함수 인자로 넣었다고 신뢰되는 것은 아니다. 실제 사용은 검증된
Host 도구 호출 경로가 전제다. 일반 UI Action에 이 도구를 등록하지 않았고, 요청 본문의
`role: lead`나 `sessionId`는 실제 Host의 세션 확인을 대신할 수 없다.

## 자동 검사

Node24에서 새 Lead 도구 검사8/8은 모의 KV와 context를 사용한다. 세 채널의 조회,
Worker/이전 선택/Workspace/미준비 세션 거부, 입력 검증, 읽기 후 binding 변경 거부,
쓰기 및 Agent 호출 없음과 선언 일치를 확인했다. 실제 AI 실행 증거는 아니다.

새 빌드의 Worker를 실제 자식 프로세스로 실행하는 기존 JSONL 시험도 확장했다. 조회가
동일 invocation ID로 읽기 RPC만 수행하고, session context 누락과 Host의 scope 거부를
오류로 반환하는지 확인했다. 모의 Host가 상태와 거부를 응답하므로 실제 Core 검증을
대신하지 않는다. 최초 시험은 SDK 자체가 Host의 tenant 권한까지 판정한다고 잘못 가정해
응답을 기다렸다. Host에 scope 거부를 응답하도록 고쳐 경계를 정확히 모델링했다.

새 SDK pin `316c56f247813e3ec19037b3a3f079d1caa7b739`를 사용하는 격리 임시 복사본에서
타입·새 빌드·전체130/130·SDK CLI validate/test가 통과했다. 최종 build-only fingerprint는
`bb27e7f85dd4104a0a62804f887b672e9269b74cd0f9ce4198d32b6297ed1038`다.

## 실제 source 앱 시험

동일 구현의 격리된 source Desktop/Owner Host에서 다음을 확인했다.

- 신선한 시험 패키지의 도구가 Host 목록에 등록됨. 목록 열람은 Agent 실행 권한이 아니다.
- 실제 UI에서 준비한 Lead 세션 ID를 넣어도 사용자 요청은 Agent 실행을 사칭할 수 없고403.
- 기존 Lead 선택·세션 준비/중복 방지·대화의 비-AI 실패·Workspace A/B 분리와 재시작 보존.
- Main4/4 정상 종료, 출력8개 종료·0실패와 시험 프로필 정리.

실제 Google 계정 대신 mock Identity를 사용했다. `liveLeadToolInvoked: false`,
`aiExecuted: false`, `installedPackageTested: false`, `physicalTwoPcTested: false`다.
실제 Lead가 도구를 사용했다거나 설치본·서명·실기기 검증이 끝났다고 표시하지 않는다.
첫 앱 시험은 도구 inventory API의 필드명을 시험 코드가 잘못 읽어 실패했다. 올바른 공개
descriptor를 대조한 뒤 재실행해 exit0을 확인했다. 실패한 임시 복사본도 종료 확인 후 정리했다.

앱 시험 fingerprint는 `42069e378056228fdb9884f4bd478f00db0ccb63db351edcd6f3b74acb3bdb35`다.
그 후 추가한 JSONL 검사만 반영한 최종 build-only도 같은 런타임 해시를 확인했다.

| 런타임 파일 | SHA-256 |
| --- | --- |
| manifest | `aab23b792d424b7de4e52ccceeea4d30686e469ae4e4dbcd395b29b06c2244be` |
| Worker | `2b925a819d9e7b7f286e58cd2c8edafc7d4d0b378bbff6d45fb3ee85f5095193` |
| UI build | `165d1fb1f65ed915d5ce7784eed0078828f084a8ef363e3a6787e8fea78d892c` |

## 남은 것

읽기 연결만으로 AC-02의 설계 변경 API나 Graph 화면 동기화가 완성되지 않는다. 실제
명세/승인 근거·사용자 답변·변경 영향 검증과 불변 Graph 쓰기를 연결해야 한다. 특히 선택
권한 변경과 저장의 경합을 단순 읽기 전후 검사만으로 완전히 막았다고 주장하지 않는다.
공유 Lead 기억, CTO/Worker/QA와 외부 실행·납품도 남아 있다.

Marketplace·Preview·자체 LAN은 계속 보류다. 이 문서로 전체 AC를 통과 처리하지 않는다.
