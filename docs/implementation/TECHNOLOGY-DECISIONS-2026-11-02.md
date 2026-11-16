# Lead 기술 선정 명세

기록일 2026-11-02. v15의 AC-34/92/93/116에 관련된 구현 단계이며, 이 기준 전체의
통과나 CTO Workstream 실행 완료를 뜻하지 않는다. 실제 구현 조사와 계약 수준의
기술 선정은 서로 다른 산출물이다.

## 구현

- 준비된 현재 Lead의 세 세션에서 `builder.publish-technology-decisions`와
  `builder.read-technology-decisions`를 사용한다. 같은 실행 Agent를 쓰더라도
  CTO/Worker의 다른 세션은 Lead 도구를 사용할 수 없다.
- 기술별 필수(required)·허용(allowed)·금지(prohibited)·미결정(undecided), 선택/
  비선택 이유, Graph 노드 범위, 상호운용 계약, 고객/플랫폼 제한, 비용, 버전 호환,
  변경 책임자와 다음 검토 조건을 기록한다. 미언급 기술은 미지정이지 금지가 아니다.
  빈 명세도 '기록된 선택 없음'이지 기술 전체 금지나 조사 완료가 아니다.
- 실제 저장된 설계 기준/명세/Graph의 정확한 revision과 digest에 연결한다. 잘못된
  기준이나 Graph에 없는 범위 노드는 거부한다. 현재의 불변 Graph를 뒤에서 수정하지
  않고 기술 명세에서 연결하므로, Graph 자체의 기술 참조/향후 Workstream 명세 연결은
  후속 구현으로 남는다. 기준 개정 후 과거 명세를 자동 승계하지 않는다.
- 기존 CAS journal을 재사용해 불변 이력과 expected revision 경쟁 검사를 제공한다.
  응답 유실/충돌에는 조회로 확인하며 자동 쓰기 재시도나 일반 set fallback은 없다.
  선택/기준/head가 다중 키 transaction인 것은 아니다. head CAS 도중 변경되면
  기록은 저장됐지만 오류가 반환될 수 있다. 이 과거 기록을 실행 권한으로 쓰지 않는다.
- Workspace의 읽기 전용 문서에 기술 명세와 출처를 표시한다. v9 문서 패널을 유지하고
  원시 JSON 대신 기술별 한국어 분류·이유·제약·검토 상태를 읽기 쉬운 텍스트로 보인다.
  보고된 검토와 통합 시험에는 독립 검증이 아니라는 표시를 유지한다. 새 업무 모델이나
  Core API/DB migration, 자동 설치, CTO/Worker 실행, 외부 검색기는 추가하지 않았다.

## 조사 주장과 실제 증거

라이선스는 `unreviewed` 또는 `reported-reviewed`, 검증은 `not-verified`,
`documentation-only`, `reported-integration-test`로 구분한다. 보고된 검토/테스트에는
근거 참조가 필요하지만 현재는 참조 문서의 존재·진위·라이선스 적합성·테스트 성공을
독립적으로 검증하지 않는다. 임의 보고를 Host가 검증한 결과로 바꾸지 않으며 실행/
법적 승인도 아니다. 보안 검사와 실제 Runner/GitHub 검증 근거 연결은 별도 단계다.

Builder 저장 한도는 명세128KiB·기술128개·기술명512UTF-8바이트·일반문장4096바이트다.
Core 용량이나 권장 프로젝트 크기가 아니다. 객체/배열은 엄격히 검사해 복제/동결하며
알 수 없는 필드, getter/symbol/비정상 배열, 중복 ID/참조를 거부한다.

## 자동 검사

Node24.22.1 격리 복사본의 타입 검사·빌드·전체 **267/267**와 공개 SDK CLI
validate/test가 exit0이다. 새 순수 파서6개·문서 투영4개·도구/복구11개·스키마 선언1개를 포함하고,
기존 compiled Worker JSONL 시험에 실제 빌드된 두 도구와 provider 저장/조회 왕복을
추가했다. JSONL의 Host는 fake이며 실제 AI나 실서비스가 아니다.
초기265개 검사와 앱 표시 시험 뒤 도구 선언의 사유/조사 수준 조건을 강화하고 회귀
검사를 추가했다. 선언 검사는 조건의 존재를 확인하며 독립 JSON Schema 검증기는 아니다.
서버의 엄격한 파서가 최종 입력 경계를 유지한다. 최종 UI에서는 문서의 읽기 흐름도 개선했다.

## 실제 앱 표시 시험과 식별

최종267개 검사와 같은 격리 복사본으로 source Desktop/Host no-AI 시험을 실행해 exit0을
확인했다. 실제 UI bridge에서 네 가지 기술 분류·문서·독립 검증 아님 표시를 확인하고
캡처도 검사했다. 표시 데이터는 명시적으로 가로챈 fixture이며 복원 후 실제 Host의
기술 명세 값은 null이다. 실제 AI 조사나 Host 기술 명세 저장을 증명한 시험이 아니다.
mock Identity를 사용했고 Main4/4·출력8개 정상 종료/실패0·임시 데이터 제거를 확인했다.
공통 source 시험 도구의 기존 복구 점검은 새 Native LAN 개발/실증 근거로 사용하지 않는다.

| 식별 | SHA-256 |
| --- | --- |
| 최종267개+no-AI 앱 복사본 | `e98332f4bb81e64d203bc89bb57963d3c12ebc4e72421d120dc365b67a6e0acb` |
| manifest | `1f0329c0d34717739c6d56cd14a939f7a2bc07e225c0fe1cbb862f282cd0414e` |
| Worker | `40a14a259a82790c6dbf53cc1fa487d80dc1da47d4a86d51b8cf2ed7a6836b16` |
| SDK CLI UI 집계 | `3fdeb84f8caad887387017a1e699f9e2d15209200de0aa5a52b6d61134a1b27a` |
| 실제 Host UI index.js | `b94b734ebbb34843ea56aa83aff8a4b062bb19356dd401163dacd276e7ffd67e` |

명령은 Source Desktop에서 `node scripts/smoke-builder-conditional-state-isolated.mjs`다.
Node24/PATH24와 절대 Builder 경로 `SPS_BUILDER_SOURCE_ROOT`를 지정했고 live opt-in은
없었다. 원본 로그 `sps-builder-technology-final-ui-verified.log`와 캡처는 로컬에만
보관하며 원시 계정/Workspace 식별자나 비공개 Core를 공개 저장소에 올리지 않는다.
문서 포함 HEAD 전체를 위 시험 복사본 지문과 같다고 주장하지 않는다. Core/SDK는
`55b5d5b` / `316c56f` 그대로이며 두 PC/Google OAuth/설치본/서명/Stable 근거는 아니다.

기술 명세가 없는 상태에서 일반 Lead/설계 기능도 유지한다. CTO 범위 배정, 기술 참조를
포함한 Graph 개정, 실제 조사/AI 도구 호출, 질문에 따른 명세/CTO 전파, Worker/QA·
Runner·납품은 아직 미완료다. AC 체크 상태를 이 기록만으로 PASS로 바꾸지 않는다.
기존 DEV/설치본/계정/데이터·Tailscale을 유지하고 Marketplace·Preview·자체 LAN은 보류한다.

참고: [MCP 도구 계약](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
[GitHub 라이선스 조회](https://docs.github.com/en/rest/licenses/licenses),
[React 렌더링](https://react.dev/learn/render-and-commit).
외부 코드는 복사하지 않았다. GitHub 라이선스 API의 존재가 이 기능에서 실제 조회/법적
검토를 수행했다는 의미는 아니다.
