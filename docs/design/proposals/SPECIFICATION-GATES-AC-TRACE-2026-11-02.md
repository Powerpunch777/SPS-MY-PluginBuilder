# 명세 검증 Gate와 SG 추적 제안

> **문서 ID:** SPS-PB-SG-TRACE-2026-11-02
>
> **상태:** 설계 검토용 제안. v15를 개정하거나 구현·AC 통과를 승인하지 않는다.
>
> **작성 기준:** Builder v15 및 현재 공개 Builder 소스의 읽기 전용 대조.
>
> **원문:** 사용자 제공 `SPS_Builder_Specification_Validation_Design_Addendum_2026-11-02.zip` 안 Markdown 1개(40,554 bytes)를 .NET `ZipFile`/`StreamReader`로 직접 읽었다. 압축 해제하지 않았다.

## 관계와 범위

- 별도 [통합 설계 개정안](SPECIFICATION-GATES-INTEGRATION-DRAFT-2026-11-02.md)에 연결하는 추적 부록이다. 이 문서는 v15를 수정하지 않는다.
- 사용자가 승인한 것은 **설계 개정안 작성**이다. 구현, 새 AC 번호 배정, 기존 v15 체크박스 변경, 전체 AC 통과 선언은 승인되지 않았다. SG-01~SG-22는 제안서의 가칭을 유지한다.
- 제안 원문은 DRAFT다. 아래 Gate·데이터 모델·판정은 채택된 제품 정책이 아니라 기존 정책과 충돌을 찾기 위한 제안이다. 미결정은 `UNDECIDED`로 남긴다.
- 이 대조는 코드·문서 읽기에 한정한다. AI/Worker 실행, 개발 서버, 의존성 설치, CI·테스트 실행은 하지 않았다. 테스트 칸은 전부 **제안 / 실행 안 함**이다.
- 공식 [JSON Schema 검증 명세](https://json-schema.org/draft/2020-12/json-schema-validation)는 JSON 인스턴스의 **구조 검증**을 정의한다. 스키마 통과나 `APPROVED` 문자열은 권한 있는 사람의 승인, 근거의 진위, 실제 검사 실행을 대신하지 않는다.

## 유지할 권한·계층

1. Lead는 사용자 상담과 기존의 확정 답변을 바탕으로 설계 명세·Graph·기술 계약·Workstream 배정을 소유한다. 명확한 사용자 답변은 v15에 따라 중복 승인 요청 없이 새 Revision에 반영할 수 있다. 고객 원문이나 Lead의 추론을 사용자 승인으로 승격하지 않는다.
2. 기술 선정의 `required / allowed / prohibited / undecided`는 Lead 계약이다. CTO는 배정된 Workstream 안에서 재사용 조사와 세부 Task Packet을 작성하며 Lead의 범위·인수 기준·공개 계약을 약화하거나 수정하지 않는다. 단순히 언급되지 않은 라이브러리를 자동 금지하지 않는다.
3. **G3는 v15의 Workstream 소유권 규칙을 그대로 따른다.** 기능 Graph 노드마다 소유 CTO는 하나다. 인터페이스 충돌은 진단·차단한다. 제안 원문의 “허용된 중첩”은 공동 CTO 소유나 중복 배정 권한을 추가하지 않는다. 기존 계약상 같은 CTO의 별도 Workstream 중첩 가능성도 이 문서에서 새로 넓히지 않는다.
4. CTO는 Lead Workstream의 인수 기준으로 자신의 Worker/QA Task Packet을 세분화한다. Worker/QA는 각자 독립 세션·허용된 Task 자료만 쓰며 승인된 동작, 인터페이스, 합격 기준을 바꿀 수 없다.
5. Gate는 명시된 범위의 검사 상태만 낸다. 독립 작업은 계속하고, 영향받는 작업만 차단한다. 문서/코드 검사나 명령 성공은 고객 요구 충족·QA 인수·납품 완료와 다르다.
6. 명세에 Q-SG 문서가 기록되더라도 이는 결정 질문의 출처일 뿐 새 명령·승인·권한이 아니다. 승인 권한은 v15와 실제 Core/SDK 권한 계약에서만 온다.
7. 장기 CTO는 상주 모델이 아니라 durable goal과 이벤트 기반 wake/resume이다. 같은 CTO의 논리 세션, 중복 이벤트 복구, 순서가 뒤바뀐 결과 처리, 명시적 중지 존중은 후속 실행 계약으로 검증한다. 새 분산 scheduler, 전용 무한 CLI 반복기, 자체 큐를 제안하지 않는다. 네이티브 Worker 실증 전 생성 코드 자동 실행은 계속 차단한다.

## 기존 설계·현재 근거

| 주제 | v15·현재 계획의 근거 | 현재 소스에서 확인한 것 | 정확한 한계 |
|---|---|---|---|
| Lead 승인 명세·출처·Revision | v15 §2A.1–2A.3, §4.2, AC-01–05·33·38; 완료 계획의 AC-01/05 상태 | 설계 초안은 미승인 구조로 검증하고 출처 ID는 모양만 검사함 ([draft parser](../../../src/domain/design-drafts.ts#L93)). Baseline 게시 시 현재 Lead user turn의 session/run·본문 hash를 묶어 저장함 ([publisher](../../../src/design-baseline-tools.ts#L26)). | **일부 존재:** 실제 사용자 turn의 출처 연결은 있음. Baseline 응답은 내부 계획 기록이며 독립 법적/대외 승인 증명이 아님을 명시함. 승인 actor/범위를 검증해 의미상 승인으로 승격하는 G1과 전체 Graph impact 전파는 미완료. |
| 기술 결정·재사용 | v15 §2A.2, §2H.4, AC-34·92–95; 기술 조사 §3–5 | Task Packet reuse의 HTTPS·license/evidence 필드 외에 기술 등록부는 license/verification 수준과 evidence 참조를 구조화함 ([task reuse](../../../src/domain/task-packets.ts#L180), [technology register](../../../src/domain/technology-decisions.ts#L135)). | **일부 존재:** 미검증/보고된 검증 수준은 구분되지만 참조 내용·라이선스·호환성은 독립 확인되지 않고 실행 권한도 생기지 않음 ([authored parser](../../../src/domain/technology-decisions.ts#L187)). |
| Lead→CTO Workstream | v15 §2H.4, AC-35·93·105 | 게시 시 현재 baseline/technology digest, Graph 노드·계약 참조, CTO 지정과 노드 소유 충돌을 검사 ([workstream tools](../../../src/workstream-tools.ts#L52), [ownership](../../../src/domain/workstreams.ts#L301)). | 참조 유효성·단일 노드 소유는 구조 규칙이다. 승인 REQ 전체 커버리지, 의미상 인터페이스 충돌·실행 준비 verdict는 별도 검증되지 않음. |
| CTO→Worker Task Packet | v15 §2A.2·§2H.5·AC-35·94·99–100 | CTO 활성 run/도구 권한, Workstream node 범위, 고정 명세 requirement ID, QA testPlan 필수 여부, DAG와 immutable dependency pin을 검증 ([publisher](../../../src/task-packet-tools.ts#L46), [packet parser](../../../src/domain/task-packets.ts#L226), [DAG/pins](../../../src/domain/task-packets.ts#L340)). | 승인된 제품 동작·허용 부작용·수용기준을 의미상 검증해 Worker 실행 허가를 만드는 G4는 없음. 도구 설명도 “Worker/권한/완료 아님”으로 한정. |
| 동시성·stale | v15 §2G.6·§2H.4·§4.2, AC-05·38·77·104 | revision journal은 entry/head에 각기 CAS, immutable history, published chain 조회를 제공 ([store](../../../src/solution-revision-store.ts#L119), [publish](../../../src/solution-revision-store.ts#L161)); Task Packet read는 source를 `current/historical`, dependency를 `current/changed`로 표시 ([read](../../../src/task-packet-tools.ts#L94)). | CAS는 이 journal의 단일 head 게시 경합 해결이지 여러 키/명세 전체 트랜잭션이 아님. 이후 stale 체크 실패여도 이미 게시된 역사 기록은 rollback됐다고 말할 수 없음. 현 Worker 실행 진입점의 admission 재검사는 아직 없음. |
| 실행·검수 | v15 §2G.6, AC-37·99–105·113·118; [Task Packet 구현 기록](../../implementation/CTO-TASK-PACKETS-2026-11-02.md#L46) | planning tool의 조회/게시 및 no-execution 표기가 있음. | 실제 네이티브 Worker 생성·독립 권한·이력·QA/PR 증거·durable resume은 미입증. 기술 테스트 성공을 비즈니스 완료로 처리할 경로나 독립 G6 verdict는 확인되지 않음. |

현재 상태와 AC baseline 상세는 [v15 완료 계획 §AC-01–118](../../implementation/BUILDER-V15-COMPLETION-PLAN-2026-11-02.md#L102), [Task Packet 구현 기록](../../implementation/CTO-TASK-PACKETS-2026-11-02.md), [세션 실행 제한](../../implementation/SESSION-EXECUTION-POLICY-2026-11-02.md)도 함께 읽는다. v15 체크박스는 본 제안으로 변경하지 않는다.

## SG-01~SG-22 추적·검증 제안

표의 “현재 상태”는 이 문서 작업 중 읽은 저장소 근거만의 분류다. “일부”는 완성·통과를 의미하지 않는다. SG 자체는 인수기준 제안이며 실행 결과는 모두 **미실행**이다.

| SG(가칭) | 기존 v15 조항·AC | Gate | 현재 상태 / 근거 | 제안 검증(아직 미실행) |
|---|---|---|---|---|
| SG-01 출처와 승인 분리 | §2A.1, §4.2, AC-01·33 | G1 | **일부 존재:** 미승인 draft와 실제 사용자 turn에 묶인 Lead baseline은 있음. baseline은 법적·대외 승인 증명이 아니며 draft refs는 형식만 검사 ([draft](../../../src/domain/design-drafts.ts#L169), [baseline](../../../src/design-baseline-tools.ts#L57)). 권한 actor/범위와 원문 근거를 검사해 승인 상태를 부여하는 Gate는 미검증. | 고객 발언, 사용자 답변, Lead 추론을 혼합한 입력에서 원문 참조·결정권자·revision 검증. 고객 문구만으로 APPROVED 승격 시 차단. |
| SG-02 빈 질문 목록으로 완전 판정 금지 | §2H.4, §4.2, AC-01 | G1/G3 | **미구현:** 기존 `open_questions: []` 계약은 있으나 모델 범위 완전성 증거가 아님(v15 §2H.4). | 질문 배열만 빈 정상/오류 모델 fixture를 넣어 `PASS` 방지, 검사 범위/누락 한계를 출력. |
| SG-03 관찰 결과가 다른 대안 발견 | §2H.6, §4.2, AC-01 | G1 | **미구현:** 의미상 반례 탐색 소스 경로 없음. | 같은 요구를 만족하는 외부 동작 2개를 반례로 보고, 미승인 동작 선택 없이 REVIEW/BLOCK. |
| SG-04 모델 자체의 빠진 상태·이벤트 표시 | §4.2, §11, AC-01·05 | G1/G6 | **미구현:** 범위 기반 완전성 보고서/UNKNOWN 없음. | 일부 상태·이벤트만 모델에 넣어 미검사 범위를 표기하고 “완전” 주장을 거부. |
| SG-05 문서 확인과 실제 기능 실증 구분 | §2A.2, §4.5, AC-34·94·116 | G2/G6 | **구조 일부:** Technology Decision은 verification level/근거 ID를 요구하지만 작성 모델의 주장이고 근거를 독립 확인하지 않음 ([schema](../../../src/domain/technology-decisions.ts#L149)). | 문서만 있는 capability를 테스트 통과로 분류하지 않고 필수 미실증 의존성을 차단. |
| SG-06 미언급 라이브러리 자동 금지 금지 | §2A.2, §2H.4, AC-34·94–95 | G2/G4 | **정책 존재·강제 미검증:** v15는 단순 미언급을 금지로 보지 않음. | 미언급·계약 호환 라이브러리 선택은 허용, prohibited 또는 공개/권한 계약 변경은 거부. |
| SG-07 승인 요구의 Workstream 누락 | §2H.4, §4.2, AC-35 | G3 | **부분:** WS가 Graph node·계약에 연결됨. 요구사항 전체 coverage 판정 없음. [workstream publish](../../../src/workstream-tools.ts#L52). | 승인 REQ 하나를 어느 WS에도 넣지 않은 보드에서 coverage 실패; 영향 WS 발행만 차단. |
| SG-08 Workstream 책임/인터페이스 충돌 | §2A.1, §2H.4, AC-35·36·105 | G3 | **부분:** 같은 Graph 기능 노드를 다른 CTO에 중복 배정하는 구조 충돌 차단은 있음 ([owner check](../../../src/domain/workstreams.ts#L301)). 논리 계약 충돌 검사는 미확인. | 서로 다른 CTO에 같은 node 배정 시 거부 유지; 충돌 계약은 diagnostic/block. 단일 node-단일 CTO 규칙에 예외를 추가하지 않음. |
| SG-09 Task의 미승인 동작 금지 | §2H.5, AC-35·94–95·100 | G4 | **구조 일부:** 범위 node·요구 ID·포함/제외/acceptance/testPlan 필드는 있음 ([packet domain](../../../src/domain/task-packets.ts#L11)). 의미 승인 연결은 없음. | Task가 미승인 예외 동작을 지시하거나 authority 외 공개 계약 변경을 요구하면 publish/admission 차단, CTO→Lead 질의. |
| SG-10 승인 없는 공개 API 변경 | §2A.1, §4.5, AC-95·100·105 | G4/G6 | **미구현·미검증:** Task 범위 필드 외 코드 diff→승인 계약 확인 Gate 없음. | 승인된 diff와 공개 API·권한·저장 동작을 바꾸는 diff를 대비하고, 근거 없는 변경은 PR 차단 또는 REVIEW. |
| SG-11 내부 구현 재량 보존 | §2A.2, §2H.5, AC-34·95 | G2/G4 | **정책 존재·강제 미검증:** v15는 승인 범위의 내부 구현 재량을 둠. | 외부 관찰 계약 동일/내부 알고리즘만 변경 시 불필요한 재승인 없이 허용. |
| SG-12 명확한 사용자 답변의 Revision 반영 | §4.2, AC-05·38·103 | G1/G5 | **부분:** 답변 후 새 spec/Graph 저장·복원 기록은 있으나 승인 승격·공유기억·CTO 영향 전파는 완료 아님 ([완료 계획](../../implementation/BUILDER-V15-COMPLETION-PLAN-2026-11-02.md#L12)). | 기존 질문에 답한 명시적 사용자 메시지로 새 sourced Revision을 만들고, 중복 승인 없이 연계 CTO에 전달. |
| SG-13 답변 범위 밖 추론 차단 | §2H.6, AC-05·103 | G1/G5 | **미구현·미검증:** 적용 범위 밖 추론을 PROPOSED/UNDECIDED로 고정하는 검사 없음. | 답변이 기존 질문 일부만 해결하는 fixture에서 나머지/새 요구가 승인 상태로 승격되지 않음. |
| SG-14 동시 Lead Revision 쓰기 | §4.2, AC-70 직접; AC-98은 Lead 3세션 기억 공유의 넓은 배경 | G5 | **구조 일부:** revision journal의 CAS head 충돌 감지 있음. 이는 여러 저장 키 전체 transaction이 아님 ([publish](../../../src/solution-revision-store.ts#L161)). | 같은 base에서 동시 publish를 경쟁시켜 하나만 head가 되고 다른 호출은 conflict; staged/committed history와 응답 유실을 구별. |
| SG-15 오래된 Run 결과의 최신 완료 승격 금지 | §2H.4, §2G.6, AC-38·104 | G5/G6 | **부분:** Task source/dependency stale 표시와 “완료 아님” 설명은 있음. 실제 실행 admission/result 완료 모델은 미구현 ([read state](../../../src/task-packet-tools.ts#L100)). | 실행 직전과 결과 기록 시 spec/task/dependency pins 재확인; 변경 중 도착한 이전 run은 최신 Revision PASS/완료가 되지 않음. |
| SG-16 변경 영향 작업만 재검증 | §2H.4, §4.2, AC-38·104 | G5 | **부분:** WS node 영향 후보는 있으나 Task/PR/Test 의존 역추적 및 선택적 재검증은 미입증. | 영향/비영향 기능을 섞은 Graph 변경에서 의존분만 stale, 무관 작업은 진행 가능. |
| SG-17 QA 합격기준 독립성 | §2A.1, §2H.5, AC-37·100·109 | G4/G6 | **구조 일부:** QA Packet에는 TestPlan이 필수. QA가 기준을 수정 못하도록 하는 실제 실행 권한 Gate는 없음 ([parser](../../../src/domain/task-packets.ts#L217)). | QA의 기준 완화·테스트 삭제·다른 테스트 실행 시 거부/무효; 원래 승인 TestPlan은 불변. |
| SG-18 Timeout/외부검증 실패는 UNKNOWN | §4.5, §11, AC-37·115 | G6 | **미구현:** 현재 Task Packet 상태에 검증 verdict/UNKNOWN 및 provider 원본 결과 연결 없음. | timeout, API 오류, 증거 누락을 각각 UNKNOWN/REVIEW로 내고 PASS/완료를 만들지 않음. |
| SG-19 상담 내 지시를 정책으로 실행 금지 | §2A.4, §4.2, AC-33·117 | G1/G6 | **미검증:** 허용된 상담 자료 처리와 비-AI import 정책은 있으나 인젝션 명령의 데이터/지시 격리 테스트 미확인. | 상담 텍스트에 정책 우회·검증 생략 명령을 넣어 인용 데이터로만 취급, 권한/검사 설정은 변하지 않음. |
| SG-20 Workspace 간 데이터·권한 격리 | §2G.2, §4.5, AC-40·71·79·107·118 직접; AC-44는 공용 재사용/고객 지식 교차 방지의 인접 기준 | G1/G6 | **부분:** Workspace-scoped 저장 경계 설계/키는 있으나 고객 간 권한·비밀·실제 실행 격리의 전체 실증은 미완료 ([plan](../../implementation/BUILDER-V15-COMPLETION-PLAN-2026-11-02.md#L195)). | A/B Workspace의 동시 positive/negative access, source/evidence/task/session 분리 및 자격정보 미노출 시험. |
| SG-21 승인 대체 기술의 불필요한 재개발 금지 | §2A.2, §2H.4, AC-34·94–95 | G2/G4 | **정책 일부:** Reuse-First/미언급=금지 아님은 문서에 있음. 실제 verified capability 기반 비교는 미구현. | 승인 대체재의 기능·호환성·권리 증거를 확인해 조건 충족 시 채택 가능; 새 기술로 계약을 바꾸면 승인 경로 요구. |
| SG-22 테스트 통과만으로 완료 금지 | §4.5·§12, AC-36·37·101·105·118 | G6 | **정책 존재·실행 미구현:** v15는 CI/PR/사용자 인수를 다른 사실로 분리. 현재 계획 도구는 실행 자체를 하지 않음 ([Task Packet 구현 범위](../../implementation/CTO-TASK-PACKETS-2026-11-02.md#L52)). | 명령/CI 통과만 있고 요구 연결·독립 QA·승인 근거 없는 run에서 업무 완료/납품 상태가 생성되지 않음. |

## Gate별 판정·발행 원칙 제안

원문 초안의 `PASS / BLOCK / REVIEW / UNKNOWN`은 **새 승인 권한이 아니라** 검사 결과 표현 제안이다. `PASS`는 대상 Revision·입력 해시·검사 범위·검증기 버전·근거를 붙인 지정 범위 결과만 뜻한다. `BLOCK`은 의존 작업에 한정하고 독립 승인 작업을 멈추지 않는다. 의미 판단이 필요한 결과는 `REVIEW`, 검사 실패/시간 초과/자료 부족은 `UNKNOWN`으로 남긴다. Worker나 QA가 verdict 문자열을 자가 작성해 승격하지 못한다.

`SourceEvidence`, Decision Authority, Validator, Compiler, Execution Gate, Impact Analyzer, Conformance Validator는 우선 **논리 책임/데이터 계약 후보**다. 현 SDK/Core에 없는 저장·CAS·이벤트·권한·서명 기능을 이미 제공한다고 전제하지 않는다. 기존 scoped state/events/API를 감사한 뒤 적합한 경계에 흡수하고, SQLite는 실제 적용 저장소가 SQLite로 확인될 경우에만 해당 트랜잭션 계약을 검토한다. MCP 도구는 명시적 검증/API 호출 경계일 뿐 승인 진위·durable 상태를 자체 보장하지 않는다.

| 남은 결정(가칭) | 이번 제안에서의 처리 |
|---|---|
| Q-SG-01 직렬화/저장 경계 | `UNDECIDED`. JSON/TypeScript 기존 validator와 CUE 후보를 비교하되 새 저장소는 지정하지 않음. |
| Q-SG-02 검사 위험 등급·시간 예산 | `UNDECIDED`. 모델 커버리지·제외 영역·timeout을 보고. |
| Q-SG-03 REVIEW/UNKNOWN 해제 권한 | `UNDECIDED`. 기존 권한 계약 밖 수동 승인 API를 만들지 않음. |
| Q-SG-04 multi-key Revision 원자성 | `UNDECIDED`. 현 CAS journal을 전체 문서 transaction으로 과장하지 않고 Core/SDK API를 추가 감사. |
| Q-SG-05 code→spec 자동 추적 범위 | `UNDECIDED`. 자동 도구와 사람 검토 경계를 실증 후 설정. |
| Q-SG-06 고객 확인과 사용자 승인 경계 | v15 결정 유지. 본 문서가 세부 권한을 새로 위임하지 않음. |
| Q-SG-07 정형 검증 도구/실행환경 | `UNDECIDED`. JSON Schema는 구조 후보; 논리·상태 모델 도구 채택은 별도 조사·승인. |

## 제안된 다음 순서와 증명 상태

| 단계 | 제안 범위 | 현재 상태 |
|---|---|---|
| P0 저장소/계약 감사 | v15·기술조사·Builder/Core 공개 계약의 실제 소유 경계, 권한·저장·이벤트·동시성 대조 | 이 문서는 Builder v15/소스의 읽기 전용 대조만 수행. Core 내부 구현은 감사·검증하지 않음. |
| P1 공통 명세/권한/Revision | SourceEvidence, 승인 actor, 불변 Revision, 검증 입력/출력 모델을 기존 모델과 매핑 | 미구현·선택 미확정. |
| P2 G1/G3/G4 기본 게이트 | 명세 추적, 단일 CTO node ownership, 의미상 Task Packet 발행/admission 검증 | 일부 구조검사만 존재. 의미 Gate 및 Worker admission 미구현. |
| P3 G2/G5 | Technology capability 근거 및 Revision 영향/stale·ACK | 부분 자료/핀 존재, 정책 verdict·실행 연계 미검증. |
| P4 G6 | 독립 QA, 코드-계약 추적, 실제 PR/Runner evidence gate | 미구현·실제 Worker proof 대기. |

별도 실증에서 **실제 네이티브 Worker 생성 및 trusted child-thread ID에 따른 도구 범위, Worker별 Task Packet 격리, CTO durable goal resume/중복·역순 이벤트 복구, 기존 Core Workspace Job 호출 가능성**을 확인하기 전에는 자동 실행 금지를 유지한다. 현재 계획 도구 검사는 이 검증을 대체하지 않는다. 구현·검증 단계가 승인되더라도 각 SG의 합격 근거를 새로 수집하고, v15 AC 체크박스/완료 계획 상태는 별도 승인·정확한 증거 없이는 바꾸지 않는다.

## 참고

- 사용자 보완안 원본 ZIP: `SPS_Builder_Specification_Validation_Design_Addendum_2026-11-02.zip` — 원문은 수정하지 않음.
- [JSON Schema 2020-12 Validation](https://json-schema.org/draft/2020-12/json-schema-validation)
- [Creating your first JSON Schema](https://json-schema.org/learn/getting-started-step-by-step)
- [v15 canonical design](../01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md)
- [Technology Stack Research](../02_Tech_Research/SPS_Builder_Technology_Stack_Research.md)
