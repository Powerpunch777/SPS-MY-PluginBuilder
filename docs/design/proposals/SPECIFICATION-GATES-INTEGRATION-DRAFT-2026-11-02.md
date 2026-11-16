# 명세 검증 Gate 통합 개정안

문서 ID: SPS-PB-SPEC-GATE-INTEGRATION-DRAFT-2026-11-02

상태: **검토용 개정안. 문서 작성만 승인됐으며 새 제품 정책·구현 착수는 미승인.**

## 1. 목적과 기준

사용자가 제공한 `SPS_Builder_Specification_Validation_Design_Addendum_2026-11-02.zip`
안의 DRAFT를 기존 Builder에 통합하는 최소 변경 제안이다. v15를 교체하거나
새 AI 조직·서버·DB·Runner를 만드는 계획이 아니다. 사용자가 매번 Lead에게
계속하라고 하지 않아도 CTO가 Worker/QA를 지휘하는 목표를 유지하되,
임의로 만들어 낸 제품 동작을 자동 실행하는 경로는 만들지 않는다.

검토 기준은 공개 Builder 작업 브랜치 `codex/builder-foundation`의
`a70b6824d0bbe7d64a0db2c1d36466ebe623c702`다. 검토 시 원격 작업 브랜치와
일치했다. 원격 `main`은 `5ab0920162c421bddf3e9e3ce605cbf3bc185486`로 달랐다.
첨부안의 `main` 링크만으로 최신 구현을 판단하지 않는다.

- [통합 설계 v15](../01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md)
- [기술 조사](../02_Tech_Research/SPS_Builder_Technology_Stack_Research.md)
- [설계·코드 분석](../../review/SPS_Plugin_Builder_Analysis_2026-10-29.md)
- [Core 의존성·병렬 계획](../../review/DEPENDENCY_AND_PARALLEL_PLAN_2026-10-29.md)
- [최신 UI 적용 기준](../03_UI/UI-IMPLEMENTATION-CONTRACT-2026-11-01.md)
- [추가 인수 기준 추적표](SPECIFICATION-GATES-AC-TRACE-2026-11-02.md)

제품 의도는 사용자 확정 결정과 v15를 따른다. 현재 Core/SDK 코드와 계약은
지금 실제로 실행할 수 있는 범위를 제한하는 근거이지, 미완성 구현을 최종
제품 설계로 승격시키는 권한이 아니다. 충돌·미지원은 숨기지 않고 기록한다.
본 개정안과 원본 DRAFT는 별도 채택 전까지 기존 확정 결정을 바꾸지 않는다.

이번 작업은 문서 검토·저장이다. 이 개정안으로 패키지 설치, CI 실행, 외부
저장소 권한 변경, 새 검증 정책 구현, 앱 업데이트를 수행하지 않는다.
기존 작업의 테스트 결과를 새 Gate 검증 결과로 재사용하지 않는다.

## 2. 반드시 보존할 결정

| 기존 결정 | 개정안에 적용하는 방식 |
| --- | --- |
| Lead 3세션, 프로젝트 Lead 기억 공유 | 쓰기는 현재 권한과 CAS를 재사용. 세션별 원본 대화는 합치지 않음 |
| 프로젝트 CTO당 단일 세션·자체 기억 | Lead의 CTO 자동 생성에 새 사용자 승인 창을 추가하지 않음 |
| Graph 노드별 책임 CTO 한 명 | 인터페이스 공유나 공동 읽기를 공동 CTO 소유권으로 바꾸지 않음. 내부 병렬 작업은 담당 CTO의 Workers로 분해 |
| Worker/QA 독립 세션·명시적 Task Packet 입력 | CTO 기억·권한·승인 기준을 자동 상속하지 않음 |
| Lead 설계·계약 변경, CTO 진행 상태·구현 지휘 | 업무 권한은 Builder에 두며 Core에 역할·Gate 판정을 하드코딩하지 않음 |
| 기술 선정과 구현용 재사용 조사 구분 | Lead가 스택을 정하고 CTO가 그 범위에서 OSS/라이브러리를 조사. 미언급 기술은 자동 금지가 아님 |
| 사용자 답변의 즉시 Revision 반영 | 명확한 답변에는 중복 승인을 요구하지 않음. 답변 범위 밖 추론은 승인으로 승격하지 않음 |
| 미결정사항 UI는 CTO 작업 질문에서 출발 | G1 상담의 모호성은 메인 Lead에서 논의. 모든 검증 경고를 미결정사항 패널로 보내지 않음 |
| CTO → 내부 Lead → 필요한 사용자 결정만 표시 | Worker는 CTO에게, CTO는 내부 Lead에게 질문. 내부 해결 가능 사항은 사용자에게 다시 묻지 않음 |
| 정기 CTO 보고 대신 Graph·실제 근거 조회 | Gate 보고서는 상태 근거이며 별도 정기 보고 대화를 강제하지 않음 |
| Marketplace·Preview·새 Native LAN 보류 | 이번 선행 작업에 포함하지 않음. UI v9와 검정·중립 회색 기준 유지 |

## 3. 현재 구현과 추가 범위

아래는 현재 소스 대조 결과다. 실제 AI/앱/실기기 전체 인수 통과를 뜻하지 않는다.

| 영역 | 재사용할 실제 코드 | 현재 한계 / 추가 제안 |
| --- | --- | --- |
| 설계 원본·사용자 발언 | [design-baseline-tools.ts](../../../src/design-baseline-tools.ts), [design-decision-tools.ts](../../../src/design-decision-tools.ts) | 현재 Lead run의 실제 사용자 입력·해시와 해석을 연결함. 그 해석의 모든 문장이 사용자에게 승인됐다는 의미 검증은 아님 |
| 역할별 쓰기 | [lead-tool-authority.ts](../../../src/lead-tool-authority.ts), [cto-planning-authority.ts](../../../src/cto-planning-authority.ts) | 세션·run·도구 허용 범위 검사 재사용. 이 기술 권한이 제품 결정의 승인 권한을 자동 증명하지는 않음 |
| Revision·동시성 | [solution-revision-store.ts](../../../src/solution-revision-store.ts) | `state.compareAndSet` 기반 저널·head 충돌 검사 존재. 여러 명세 문서와 실행 입구를 하나의 원자 트랜잭션으로 갱신하는 보장은 없음 |
| 기술 선정 | [technology-decision-tools.ts](../../../src/technology-decision-tools.ts) | 고정 baseline과 기술 상태 저장 존재. 버전별 실제 capability·라이선스·비용 실증은 별도 근거가 필요 |
| Workstream | [workstream-tools.ts](../../../src/workstream-tools.ts) | 현재 baseline/기술/Graph 참조, CTO 단일 노드 책임, 수신 기록 존재. 전체 REQ 커버리지와 Decision 기반 발행 판정은 미구현 |
| Task Packet | [task-packet-tools.ts](../../../src/task-packet-tools.ts), [domain/task-packets.ts](../../../src/domain/task-packets.ts) | CTO·지정 노드·REQ·의존성 revision/hash·QA 계획·불변 저장 검사 존재. 승인 동작의 의미 검사, Worker 실행 허가, 독립 QA 검증은 아님 |
| CTO 질문·Lead 회신 | [cto-question-tools.ts](../../../src/cto-question-tools.ts), [cto-question-reply-tools.ts](../../../src/cto-question-reply-tools.ts) | 내부 검토와 사용자 표시 분리 기반 존재. 사용자 답변에서 새 명세·변경 영향·전체 CTO 전파까지의 완성은 별도 미완료 |
| 네이티브 실행 | [현재 검증 기록](../../implementation/CODEX-NATIVE-WORKERS-2026-11-02.md) | 조회·프로토콜 기반만으로 native Worker 생성·장기 재개·독립 권한·완료를 주장하지 않음 |

현재 Task Packet의 `executionStarted: false`를 유지한다. 저장 성공을 G4 PASS나
실행 승인으로 소급 해석하지 않는다. 과거의 작성자 주장도 새 검증기의 독립
판정으로 변환하지 않고 재검토 대상으로 남긴다.

## 4. v15 삽입·수정 조항 초안

모든 행은 **검토용 문구 제안**이다. 기존 v15 원문은 이번에 변경하지 않는다.

| 현재 조항 | 문제 | 제안 조항 / 삽입 위치 | 근거·기존 AC 관계 | 추가 검사·남은 결정 |
| --- | --- | --- | --- | --- |
| §2A.2 기술 선정/재사용 | 선정 상태와 실제 기능 실증 수준이 섞일 수 있음 | 같은 절 뒤에 G2: 기술 상태와 capability 증거를 별도 축으로 보존 | AC-92~95 보강 | 필수 capability 미검증·버전 만료. 검증 도구·성능 예산 미정 |
| §2G 역할·기억·세션 | 권한 있는 run의 발언과 승인된 제품 결정을 혼동할 수 있음 | 역할 계약에 Decision authority와 원본 출처 연결 추가. 기존 세션 수·자율권 유지 | AC-98~105 보강 | CTO/Worker의 승인 위조·다른 Workspace 참조 거부 |
| §2H.2 Lead 정책 | 질문 목록이 비어 있어도 모델에 예외 동작이 빠질 수 있음 | G1: 원문→추출 명세의 출처·행동/예외·검사 범위·미확인 가정을 기록 | AC-01~05 보강 | 상담 질문은 메인 Lead. 실제 요구 완전성 보증 금지 |
| §2H.4 Workstream | 자유 텍스트·open_questions만으로 승인 근거와 커버리지를 증명 못 함 | G3: 고정 Decision/REQ/Interface 버전과 coverage·검증 보고서·차단 의존을 첨부 | AC-94, AC-99, AC-104~105 보강 | 한 노드 한 CTO 유지. 공유 인터페이스 영향 차단 범위 결정 필요 |
| §2H.5 CTO/Worker | 구조가 유효한 Packet에도 미승인 외부 동작이 들어갈 수 있음 | G4: Packet 저장과 발행/실행 허가를 분리. 검증기가 만든 정확한 판정을 실행 입구에서 재확인 | AC-94, AC-99~100 보강 | 허용 부작용·수정 범위·입출력/오류·테스트 오라클·Decision 참조 필요 |
| §2H.6 질문 답변 | 원문 답변보다 넓은 해석을 승인으로 처리할 위험 | 명확한 답변은 즉시 반영하되 근거 범위와 추론을 구분. 업무 질문 라우팅 유지 | AC-103, AC-108 보강 | 새 모호성만 재질문. 고객 발언을 사용자 승인으로 승격 금지 |
| §2H.4 변경 전달·§2H.7 Graph | CAS 하나로 문서·실행 전체 원자성을 주장할 위험 | G5: 불변 snapshot vector, 역방향 의존 영향, CTO ACK, 실행 전 최신성 재확인 | AC-104~105 보강 | stale 완료·두 Lead 동시 쓰기·영향 미확정은 관련 범위만 차단 |
| §4.2~4.5 명세·계획·연동·납품 | 새 검증 서버로 중복 구축할 위험 | Registry/Validator/Compiler/Gate는 Builder의 논리적 책임으로 흡수. Core는 범용 기술 기능만 보완 | 기존 Core/Plugin 경계 유지 | 실제 저장·호환성 계획은 구현 승인 후 확정 |
| §11 검증·납품 | 테스트 성공과 승인 적합성을 혼동할 수 있음 | G6: 명세→구현 및 구현→승인 근거의 양방향 추적. 실제 commit/Check/정책 설정에 결속 | AC-67~77, AC-94, AC-97, AC-104 보강 | SG-01~22는 가칭. 기존 AC 번호·체크 상태는 변경하지 않음 |

### 삽입 문구 예시

> `open_questions: []`는 발견한 질문이 없다는 뜻이지 모든 동작이 결정됐다는
> 증명이 아니다. 승인된 명세와 검사 범위에서 근거가 확인된 작업만 발행한다.
> 미결정 의존이 있는 기능과 그 영향 작업은 차단하되 독립된 승인 작업은
> 계속 진행할 수 있다. 내부 구현 재량을 전부 사용자 승인으로 바꾸지 않는다.

> CTO가 저장한 Task Packet은 계획 문서다. 검증 보고서와 실행 권한을 별도로
> 확인하기 전 Worker를 실행하지 않는다. Gate 판정은 AI 입력 문자열이 아니라
> 정해진 검증 경로가 실제 입력·버전·근거를 확인한 결과로 기록한다.

## 5. 논리 데이터 계약 초안

다음은 **제안 데이터**이며 현재 SDK export, DB 테이블, 구현된 서비스/API가 아니다.
현재 JSON/TypeScript 파서와 Revision 저장을 우선 재사용하는 안을 권장하지만,
CUE·SMT 도구·서명 키·새 저장 형식은 아직 채택하지 않는다.

| 개체 | 최소 필드와 관계 | 소유·검증 원칙 |
| --- | --- | --- |
| SourceEvidence | ID, Workspace/프로젝트, 입력 종류, 발언자 종류, 원문 위치·해시, 수집 시각/이벤트 | 서버가 실제 입력 경로와 주체를 결속. AI가 적은 `actor: user`만으로 승인하지 않음. 원문 불변·필요한 인용만 전달 |
| Requirement | ID, 행동/환경/부정 조건, Source/Decision/Acceptance 참조, revision | Lead가 작성. 고객 원문·제안·확정 결정을 구분 |
| Decision | ID, 쟁점/선택, 상태, 권한 근거, 정확한 범위, source revision, affected IDs | 승인 주체와 위임의 부모 근거를 연결. 권한 범위 확장 금지 |
| BehaviorContract | 상태·이벤트·전/후조건·출력/오류·불변식·허용/금지 부작용·Decision 참조 | 승인된 사용자 관찰 동작과 내부 알고리즘을 구분 |
| CapabilityEvidence | 도구/버전/OS/기능, documented/tested/unknown/failed, 근거, 환경·확인일·재검토 조건 | `required/allowed/prohibited/undecided`와 별도 축. 링크 존재가 실증 성공은 아님 |
| Workstream/TaskContract | 기존 ID·revision, REQ/Decision/Interface refs, 범위·의존·효과·테스트, 보고서 참조 | 기존 필드를 지우지 않는 호환 확장안. 과거 Packet을 새 정책 PASS로 자동 이관하지 않음 |
| ValidationReport | ID, 검사기 버전, 입력 snapshot/hash, 대상 범위·제외 범위/이유, verdict, 반례·증거·미실행 사유 | 검증 경로만 판정 작성. 범위 없는 PASS 금지. 결과 재사용 시 입력·버전·근거 유효성 대조 |
| ChangeImpact | old/new snapshot, 변경된 Decision/Contract/Graph, 영향 WS/Task/PR/Test, ACK·처리 근거 | 이전 결과를 최신 결과로 승격하지 않음. 영향이 불명확하면 해당 의존 범위 재검토 |

### 상태를 분리한다

- 질문 처리: 현재 질문의 OPEN/CLOSED 등 처리 상태. 결정 승인과 다른 축이다.
- 결정: 제안 상태 `APPROVED / UNDECIDED / UNDEFINED / PROPOSED / FORBIDDEN /
  DELEGATED / DONT_CARE / NOT_APPLICABLE`. 이름·직렬화는 아직 확정되지 않았다.
- 검증: `PASS / BLOCK / REVIEW / UNKNOWN`. 특정 입력·범위에서의 판정일 뿐이다.
- 기술 실행: Core/provider의 queued/running/종료·취소·불확실 상태.
- 업무 인수: Builder가 명세·테스트·QA·원본 근거를 보고 판단하는 별도 상태.

DELEGATED는 부모 승인 범위·허용 결정·제약을 검사해야 한다. DONT_CARE와
NOT_APPLICABLE도 AI가 빈칸을 채우기 위한 도피 값으로 사용할 수 없고 근거가
필요하다. 고객 원문은 SourceEvidence가 될 수 있어도 사용자 설계 승인과
같은 등급으로 저장하지 않는다.

사용자에게 특정한 승인 단어·버튼을 반복해서 요구하는 제안은 아니다. 명확한
요청·답변의 의미와 적용 범위는 Lead가 판단하고, 검증 경로는 실제 입력 출처,
부여된 결정 권한, 연결된 근거·Revision·검사 범위를 확인한다. 자연어 의도
판단을 키워드 규칙으로 대체하거나 그 의미가 완벽하게 검증됐다고 주장하지
않는다. 새 모호성·위임 밖 결정만 기존 사용자 질문 경로로 올린다.

### 보고서 입력 예시

```json
{
  "schemaVersion": "draft-1",
  "gate": "G4",
  "workspaceId": "EXAMPLE-WORKSPACE",
  "projectId": "EXAMPLE-PROJECT",
  "target": { "taskId": "TASK-EXAMPLE", "revision": 2 },
  "snapshot": {
    "specRevision": "SPEC-EXAMPLE",
    "technologyRevision": "TECH-EXAMPLE",
    "workstreamRevision": 3,
    "decisionRevision": "DECISIONS-EXAMPLE"
  },
  "validatorVersion": "EXAMPLE-NOT-IMPLEMENTED",
  "inputHashes": ["EXAMPLE-NOT-A-REAL-HASH"],
  "verdict": "UNKNOWN",
  "checkedScope": ["EXAMPLE-STRUCTURE-ONLY"],
  "excludedScope": [{ "scope": "EXTERNAL-BEHAVIOR", "reason": "not checked" }],
  "evidenceRefs": [],
  "blockedBy": ["EXAMPLE-MISSING-DECISION"]
}
```

설명용의 무효한 ID/hash를 포함한 예시이며, 실제 승인·PASS·실행 허가가 아니다.

## 6. G1~G6 배치와 권한 경계

| Gate | 기존 저장·도구에 붙일 위치 | 검증·실패 경로 | 판정과 실행의 연결 |
| --- | --- | --- | --- |
| G1 상담→명세 | Import/Lead 입력, draft/baseline 발행 | 실제 입력/의미 구분·행동/예외·Acceptance·모델 범위. 미정은 메인 Lead에서 논의 | 불명확한 외부 동작을 승인 baseline으로 승격하지 않음 |
| G2 기술 선정 | Technology Decision Register | 실제 capability·라이선스/비용/데이터·버전 근거. 위임 외 결정만 사용자 경로 | 필수 capability 미검증을 tested로 표시하지 않음 |
| G3 Workstream 분할 | Lead Workstream 발행 전 | REQ/Decision 커버리지·Graph 소유·Interface·DAG·고정 버전 | 관련 WS 발행만 차단. CTO 자동 생성 자체에 승인 게이트를 추가하지 않음 |
| G4 Task 발행 | CTO Packet 저장 후, native Worker 실행 직전 | 최신 고정 명세·효과/수정 범위·테스트 오라클·승인/위임·의존 판정 | 판정 ID와 정확한 입력을 재조회. Core의 실제 세션/권한/중지 검사도 별도로 통과해야 함 |
| G5 변경 전파 | Lead 새 Revision·CTO ACK·Run 결과 채택 전 | 이전/신규 snapshot diff·역의존·충돌·stale·영향 ACK | CTO의 cancel/continue/rework 재량 보존. continue가 최신 완료 인정은 아님 |
| G6 구현→QA/통합 | PR/commit/Test/Check·업무 완료 채택 | 양방향 추적·독립 테스트/기준 보존·외부 근거·현재 명세 | 실제 GitHub 보호 설정·Check 발행자·대상 SHA까지 확인해야 병합 강제를 주장할 수 있음 |

최소 발행 절차 제안: 입력 snapshot 고정 → 결정/역할/참조/범위 검증 →
검사 보고서 불변 저장 → 실행 직전 최신 snapshot·판정·실제 권한 재확인 →
기존 Core 실행 요청/receipt → 결과를 원래 snapshot에 연결 → G6 평가.
불확실한 발행 응답은 기존 request receipt를 관찰하며 자동 재전송하지 않는다.

이 절차의 저장·재확인 사이 경쟁 조건은 아직 해결됐다고 주장하지 않는다.
첫 구현에서는 기존 CAS와 고정 snapshot을 재사용하고, 여러 key 갱신과
실행 admission 사이의 원자성·실행 중 변경 처리 계약을 별도 검증해야 한다.
새 서명 토큰을 발명하거나 AI가 적은 `gateVerdict: PASS`를 실행 허가로
신뢰하는 방식은 제안하지 않는다.

SPS 내부 발행 거부와 GitHub 병합 강제는 다른 경계다. 외부 관리자가 보호
규칙을 우회할 수 있거나 예상 Check 발행자를 확인할 수 없다면 그 한계를
표시한다. skipped/neutral/성공 표시만 보고 필요한 검사가 수행됐다고 판단하지
않고 요구한 검사 범위·실제 실행 증거·대상 commit을 대조한다.

## 7. 탐지·검증과 UI의 최소 변경

구조 완전성, 모델 안의 행위 완전성, 현실 요구 완전성을 별도로 표시한다.
구조 파서 통과와 질문 목록의 공백으로 현실 요구의 완전성을 선언하지 않는다.

AI는 상태·이벤트·예외·제약과 반례 후보를 제안한다. 결정적 검증은 참조·권한·
Revision·선언된 모델의 전이를 검사한다. 서로 다른 외부 동작이 가능한지의
논리 탐색은 도구·범위·시간 예산을 정한 뒤 도입한다. SAT는 반례 후보,
UNSAT는 해당 모델 범위 내 미발견, timeout/실패는 UNKNOWN으로 남긴다.
내부 알고리즘만 다른 경우를 새 제품 승인 질문으로 자동 승격하지 않는다.

현재 v9 화면 구조를 바꾸거나 검증 전용 AI 6명을 추가하지 않는다. 후속 UI는
기존 명세/Task/진행 상태에 판정·차단 이유·근거 범위·오래된 버전을 표시하는
안으로 제한해 검토한다. 사용자 고유 결정만 기존 질문 흐름으로 보내며,
수백 개 정적 경고를 그대로 질문 카드로 만드는 정책은 채택하지 않는다.

## 8. 단계별 구현 제안과 검증

이 단계들은 **미승인 구현 계획**이다. 문서 채택 후 필요한 부분만 착수한다.

| 단계 | 최소 변경·재사용 | 완료를 증명할 검사 |
| --- | --- | --- |
| P0 현황 확정 | 현재 source authority/CAS/저널/Packet 구조와 미연결 native 경로 재사용 지도 | 실제 소스와 설계 조항·SG 추적표 대조. 현재 근거와 계획 구분 |
| P1 데이터 계약 | Source/Decision/Behavior/Report와 고정 snapshot, 상태 축 분리 | 다른 Workspace 참조, 가짜 actor/evidence, 현재 입력 외삽, 중복/충돌, 과거 형식 보존 |
| P2 G1/G3/G4 | 기존 발행 입구에 scoped 판정 연결. 새 Worker 자동 실행은 허가 계약과 함께 검증 | 질문 없음이지만 예외 미정, REQ 누락, 한 노드 두 CTO, stale/검사 누락 발행 거부, 독립 작업 진행 |
| P3 G2/G5 | capability 근거와 역의존 변경 분석. 논리 검사기는 ROI 검토 후 필요한 것만 | documented≠tested, 근거 만료, 부분 영향, 사용자 답변 즉시 반영, 변경 중 완료·ACK 정합성 |
| P4 G6 | 기존 GitHub/Codex/Runner와 실제 대상 SHA·Checks를 연결 | 테스트 약화, 미승인 API/부작용, 다른 commit 근거, 검사 skipped·조회 실패, 외부 우회 한계 |

각 단계에서 타입·단위 검사 → 실제 Host/SDK 경계 → 실제 AI/앱 → 필요한
외부 실행 증거를 구분한다. UI 시연·목 데이터·검증기 자체 선언을 업무 인수
통과로 표시하지 않는다. 전체 Core/Stable 출시 자격을 Builder 선행 범위로
확대하지 않는다.

호환성 제안: 새 계약에 버전을 붙이고 기존 불변 기록을 유지한다. 이전
기록의 조회는 보존하되 새 실행에는 새 검증 근거가 필요하다. 현재 진행 중
run의 중단·격리·재개/이관 정책은 아직 확정하지 않았으므로 자동 취소나
과거 PASS 소급 부여를 구현하지 않는다. 공개 SDK 확장은 기존 기능으로
부족함이 확인된 범용 계약에만 제안한다.

## 9. 남은 결정과 차단 범위

| 원본 ID | 질문·선택지 | 권장안/대가 | 결정 주체·확인 전 차단 범위 |
| --- | --- | --- | --- |
| Q-SG-01 | 기존 JSON/TS 저장·파서 확장 또는 CUE 등 새 형식 | 기존 방식 우선 검토가 중복을 줄임. 의미 검사·승인 검증은 별도로 필요 | 사용자 설계 채택 후 구현 담당. 새 형식/도구 도입·마이그레이션은 미확정 |
| Q-SG-02 | 위험 등급별 탐색 범위·timeout·비용 예산 | 중요 외부 계약 우선, 제외 범위 기록. 전수 조합 탐색은 비용·지연 증가 | 사용자 정책 결정. 자동 논리 검사의 범위·예산 미확정 |
| Q-SG-03 | REVIEW/UNKNOWN을 수동 승인으로 해제할 수 있는 경우 | 근거 보강·범위 축소 후 재검증 우선. 예외 허용은 위험별 별도 결정 | 사용자. 수동 허가를 검증 성공으로 재기록하는 방식은 채택하지 않음 |
| Q-SG-04 | 기존 CAS로 다중 문서·실행 경계를 어떻게 연결할지 | CAS 자체는 구현됨. 고정 snapshot+admission 재검사와 더 강한 원자성 대안 비교 | 기술 설계 담당. 전체 트랜잭션/TOCTOU 해결 완료 주장은 불가 |
| Q-SG-05 | 코드→명세 자동 분석과 사람 검토의 분기 | 알려진 공개 API/권한/데이터 변경은 명시적 계약 검사, 의미 불명은 REVIEW 후보 | 사용자 범위 결정. 모든 임의 동작을 자동 탐지한다는 보증 불가 |
| Q-SG-06 | 고객 발언·사용자 승인·외부 계약 권한의 위임 | 기존 v15 결정 유지. 위임을 확장하려면 명시적 근거 필요 | 사용자. 새 계약·지출·배포 위임은 미확정 |
| Q-SG-07 | Z3/Alloy/CUE/TLA+/Quint 등 실제 채택 | 아직 선택/설치하지 않음. 한 도구씩 성능·호환성·라이선스 조사 | 사용자 기술 선택/구현 승인 후 담당. 심화 도구 도입만 차단 |

다음 문서 검토에서는 전체 7개를 한꺼번에 다시 결정하기보다 P1/P2에 필요한
직렬화·최소 명세 계약·Gate 실행 경계부터 확인하는 안을 권장한다. 이미
위임된 내부 구현 선택·CTO 생성·명확한 사용자 답변을 다시 승인받지 않는다.

## 10. 공식 참고와 검토 한계

- [JSON Schema validation](https://json-schema.org/draft/2020-12/json-schema-validation):
  구조 제약 검사의 기준. 입력 발언의 승인 의미나 현실 요구 완전성 증명은 아님.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server):
  실제 버전에서 확인해야 할 세션·실행·목표 기능의 원본 계약.
- [GitHub status checks](https://docs.github.com/en/pull-requests/reference/status-checks),
  [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches):
  외부 Check와 병합 통제의 별도 권한·설정 경계.

이번 검토는 위 source revision과 문서에 한정한다. 실제 동작·기능 채택은
개별 테스트와 별도 승인으로 증명해야 한다. 보안 정책, 새 데이터 보관 기간,
서명 키 배포, 운영 기본값, 출시 조건을 이 문서로 새로 확정하지 않는다.
