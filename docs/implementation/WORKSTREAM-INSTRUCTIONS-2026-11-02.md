# CTO Workstream 명세와 수신 기록

기록일 2026-11-02. v15 2H.4의 버전 명세와 CTO 수신/준비도 기록을 연결하는 단계다.
자동 세션 전달, 실제 CTO 모델 실행, Worker 실행이나 전체 v15 완료는 아직 아니다.

## 사용자 확정: 노드 하나에 책임 CTO 한 명

사용자는 각 Graph 노드에 CTO 한 명을 배정하고, 내부 공동 개발은 그 CTO가 자신의
Workers에게 나누는 구조로 결정했다. 같은 프로젝트의 다른 CTO가 그 노드를 동시에
소유하는 배정은 거부한다. 서로 다른 노드를 맡은 CTO가 같은 API/계약을 사용하는
의존 관계는 허용한다. 한 CTO가 여러 Workstream으로 자신의 범위를 나누는 것은
두 번째 CTO 소유자를 만드는 것이 아니다. 이 규칙은 Builder의 업무 배정에 있으며
Core의 역할이나 파일/프로세스 접근 허가로 해석하지 않는다. 실제 Worker Task Packet과
독립 실행은 후속 구현이다. [통합 설계 v15](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md)에 반영했다.

## 구현

- Lead의 `builder.publish-workstream`은 명세 ID/다음 revision, 담당 CTO, 고정 Spec/
  기술 선정 참조, 목표/포함/제외/범위 노드/의존성/인터페이스/재사용 후보/수용 기준/
  요구 증거/열린 질문과 변경 diff·이유·영향·적용 시점을 저장한다. 기존 명세를 덮어
  쓰지 않으며 이력은 기존 CAS journal을 사용한다. 새 revision은 기존 수신 기록을
  승계하지 않는다. 실제 CTO 신원/독립 세션과 Graph 노드/인터페이스 참조를 검사한다.
- 현재의 설계 기준과 기술 선정 명세가 서로 일치해야 한다. 해당 버전의 digest를
  고정한다. 기술/설계가 개정돼도 이전 명세의 자료를 최신 자료로 바꿔 읽지 않는다.
  의존성 설명을 업무 소유 범위나 Graph 의존성 엣지로 자동 변환하지 않는다.
- `builder.read-workstreams`는 준비된 현재 Lead가 조회한다. CTO의
  `builder.read-cto-workstream`은 해당 프로젝트의 등록된 Agent와 정확한 독립 세션,
  현재 배정된 CTO ID가 맞을 때만 자신의 명세와 고정된 공통 설계 사실을 반환한다.
  다른 CTO의 비공개 기억/대화는 반환하지 않는다. 같은 Core Agent 계정을 사용해도
  Lead 세션에서 CTO 수신 확인을 대신 만들 수 없다.
- `builder.acknowledge-workstream`은 CTO가 정확한 명세/보드 revision에 대해 이해와
  준비도를 보고한다. ready는 '착수 가능 보고', needs-clarification은 '확인 필요',
  blocked는 '차단 보고'다. 어느 것도 실제 프로세스 실행이나 완료/검증 상태가 아니다.
  UI는 기존 문서 패널에서 미수신/보고를 구분한다. 가짜 Running/진척을 만들지 않는다.
- 여러 Workstream의 최신 명세를 한 프로젝트 보드의 CAS head로 함께 교체해 동시에
  들어온 소유권 배정이 두 소유자를 만들지 않게 한다. 파서도 한 노드/한 CTO를
  검사한다. 저장 직전의 현재 Lead/CTO/기준 재확인은 있지만 다중 키 transaction은
  아니다. 변경 경합이나 유실 응답에서 저장 후 오류가 날 수 있어 조회로 확인하며
  자동 쓰기 재시도/기록 삭제/일반 set fallback을 하지 않는다.

## 공개 이력 조회

Builder 내부 journal의 `publishedRevision`을 추가했다. raw revision 키가 존재해도
head 교체에 실패해 남은 staging 자료일 수 있으므로 현재 published head의 부모
이력을 따라간다. digest/스코프/sequence를 검사하며 1000개 조회 상한에 닿으면
'없음'으로 처리하지 않고 오류를 반환한다. 데이터 복구나 자동 최신 대체는 하지 않는다.
Core API/SDK/DB migration과 원격 실행기를 새로 추가한 것이 아니다.

## 검사와 남은 범위

Node24.22.1 격리 타입 검사·빌드·전체 **300/300**과 공개 SDK CLI validate/test가
exit0이다. 새 domain11개·문서5개·도구/복구15개·기존 journal2개를 포함하고, compiled
Worker JSONL fake Host에서 배정→CTO 고정 자료 조회→Lead 사칭 거부→CTO 수신 기록→
provider 조회를 왕복했다. 동시 배정, 인터페이스 공유와 소유 분리, 소스 개정/불변 이력,
stale revision, 다른 프로젝트/Workspace/세션, 응답 유실, CAS 미지원, Lead 변경을 검사했다.
테스트와 타입 검사 시 원래 DEV의 SDK 의존성은 바꾸지 않고 격리 사본을 사용했다.

## 실제 앱 표시와 식별

같은300개 검사를 포함한 격리 복사본으로 source Desktop/Host no-AI 시험을 실행해
exit0을 확인했다. 실제 UI에서 명세 대기와 준비도 보고를 나눠 확인하고 캡처도 검사했다.
표시 자료는 명시적으로 가로챈 fixture이며, 제거 후 실제 Host의 Workstream 값은 null이다.
따라서 실제 CTO의 모델 실행/도구 수신이나 Host 업무 기록으로 보고하지 않는다.
mock Identity, Main4/4·출력8개 정상 종료/실패0·임시 데이터 제거를 확인했다.
기존 공통 시험 도구의 복구 점검은 새 Native LAN 개발/실증 근거가 아니다.

| 식별 | SHA-256 |
| --- | --- |
| 최종300개+no-AI 앱 복사본 | `f85e4bc368920a5ba9571d08adf03d210bcab51f8bf1d64433257b83cd39617e` |
| manifest | `1936076ca27fc88c7aced43a4b94231e3d968fef0d300d1c01ef226513b800a6` |
| Worker | `afe8f0ce2df0d658c45558c62280232642e1cc61f29cc0f5e4029eee5b1205a3` |
| SDK CLI UI 집계 | `d86ac51343e598e58ff71b904b91bb3c547ea84c66a64697c34307d5eddd5ef4` |
| 실제 Host UI index.js | `040ba5c1b14ffa150a8ccf98e20d028504b20252d104add3ea047399f5b6f556` |

Source Desktop에서 Node24/PATH24, 절대 Builder 경로의 `SPS_BUILDER_SOURCE_ROOT`와
로컬 캡처 경로를 지정해 `node scripts/smoke-builder-conditional-state-isolated.mjs`를
실행했고 live opt-in은 없었다. 원시 로그 `sps-builder-workstream-ui-verified.log`와
캡처는 로컬에 보관한다. 계정/실제 Workspace 식별자/비공개 Core를 공개 저장소에
올리지 않으며 문서 포함 HEAD를 위 복사본 지문과 동일하게 주장하지 않는다.
Core/SDK는 `55b5d5b` / `316c56f`를 유지했다.

아직 실제 AI의 배정/수신 도구 사용이나 CTO 세션에 구조화된 지시를 전송한 근거는 없다.
수신 보고의 내용도 CTO의 해석이지 독립 테스트나 납품 확인이 아니다. 실행 중 개정에
대한 CTO의 중단/계속/재작업 판단, CTO 기억/질문 intake, Worker/QA·Task Packet·
GitHub/Runner·납품, Graph 자체의 담당자/기술 참조 표시와 전체 AC 통과는 후속이다.
인터페이스 이름 참조의 존재를 실제 계약 구현/준수 증거로 사용하지 않는다. 아직 Task
체계가 없어 영향 Task/질문 참조의 진위는 별도 검증하지 않는다.

기존 DEV/설치본/계정/데이터·Tailscale은 보존하며 Marketplace·Preview·자체 LAN은
보류한다. 일반 Agent 기본 도구 승인, 실제 Google OAuth·설치본·두 PC·서명·Stable
검증을 이번 단계로 완료 처리하지 않는다. 공식 MCP 도구 계약과 기존 SDK/state/session
코드를 참고했고 외부 코드나 비공개 Core를 공개 Builder에 복사하지 않았다.
