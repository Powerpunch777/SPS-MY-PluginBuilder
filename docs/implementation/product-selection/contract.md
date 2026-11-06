# 제품 선택 초안 계약

## 범위와 근거

`src/product-selection/index.ts`는 공식 상품 카탈로그와 제품 선택 초안을 검증하는 순수 Builder 모듈이다. `PRODUCT_CATALOG`, `parseProductSelectionDraft`, `projectSelectionForApprovedSpecConsumer`, `handoffProductSelectionDraft`와 관련 타입을 export한다. 결과는 제안 초안이며 승인 Baseline, 권리 부여, 자산 적격성, 실제 빌드, AI 실행 또는 납품 완료를 뜻하지 않는다.

상품 ID와 이름은 CTO가 원본 바이트와 목록을 확인한 문서 `SPS_Solution_Builder_Integrated_Reuse_First_Design_Tailscale_SSH_2026-10-28.md` §1.1.1, SHA-256 `7fd759a1c9f66e8145283ff804f149005eed842b6889d5dec69ee47f56444266`에서 가져왔다. 이 과거 문서의 다른 정책은 가져오지 않았다. 카탈로그에는 S 4개, M 5개, L 4개, XL 3개 상품과 A01~A05 공통 추가 항목이 고정 ID와 이름으로 들어 있다. 등급은 고객 가치·협업·운영 범위이고 모델, 장치 수, 코드 복잡도, 정가를 뜻하지 않는다.

설계 근거는 v15 §4.3, §5, AC-07~11이다. 특히 등급과 FAST/ASSEMBLY/CUSTOM 경로는 독립이며, AI를 쓰지 않는 SPS 제품과 SPS를 쓰지 않는 웹/API·CLI 자동화·Agent workflow도 표현할 수 있다. 해당 문서의 개념적 `ProductTier` 및 `DeliveryTarget`을 기존 `src/domain/specification-revisions.ts`의 실제 타입에서 재사용한다. v15의 구식 소문자 경로 표기는 현재 작업에서 확인된 FAST/ASSEMBLY/CUSTOM 계약을 따른다.

## 입력·결과

`parseProductSelectionDraft(value, expected)`는 정확한 객체 모양과 필드를 검증한다. `workspaceId`, `projectId`, `sourceContext`는 필수다. 원본 ID와 revision 참조는 문자열 배열로 보존한다. 이 참조들은 전달받은 진술일 뿐 별도 검증된 증거가 아니다. `expected` 경계와 다르면 잘못된 입력으로 처리해 다른 프로젝트 초안을 치환할 수 없게 한다. 양쪽 ID가 문자열로 일치해도 Host 권한이 증명되지는 않는다.

제품 ID, 등급, 경로, 납품 대상, 납품 제품의 AI 사용 여부와 추가 항목은 독립 필드다. 제품 ID와 등급은 둘 다 주어지면 카탈로그상 등급이 일치해야 한다. ID를 생략하면 미정으로 둔다. 알 수 없는 ID는 생략으로 간주하지 않고 오류다. 제품 ID를 추가 항목 칸에, 추가 항목 ID를 제품 칸에 넣어도 오류다. 알 수 없는 권리·근거는 허가, 승인, AI 미사용 또는 영향 없음으로 추론하지 않는다.

결과 `status`는 `invalid`, `incomplete`, `complete`다. 잘못된 모양·값·중복·경계 불일치는 `invalid`; 형식은 맞지만 선택이 비어 있는 초안은 `incomplete`; 핵심 선택이 모두 있는 초안은 `complete`다. 추가 항목은 선택 사항이다. 누락된 핵심 선택은 null로 남고 `missing`에 나온다. 납품 대상이 없거나 빈 배열이면 미정 상태로 남는다.

상담 수집 자체는 분석을 시작하지 않는다. 이 모듈은 파일이나 사용자 입력을 읽거나 처리하지 않고, 분석 시작 기능도 제공하지 않는다. 분석은 별도의 사용자 명시 동작에서만 연결할 수 있다.

## 저장소 연결

이 모듈은 새 저장소나 데이터베이스를 만들지 않는다. `ExistingProductSelectionWriter`는 v16 선택 저장소에 연결할 호출 경계이며 `handoffProductSelectionDraft`는 유효한 초안만 이 주입 writer에 넘긴다. 이 모듈만으로 Host 인증이나 실제 저장 성공을 증명하지 않는다.

Builder의 상품 선택 화면은 `builder.product-selection`과 `builder.save-product-selection`을 사용한다. 저장은 현재 Workspace의 인증된 사용자 동작만 받으며, 기존 CAS Revision journal에 불변 초안과 현재 포인터를 기록한다. 동일 요청·내용의 재전송은 기존 결과를 반환하고, 오래된 Revision에서의 저장은 충돌로 처리한다. 저장해도 Lead 실행이나 명세 승인이 발생하지 않는다.

## 소비자 매핑

`projectSelectionForApprovedSpecConsumer`는 호출자가 파서를 우회해도 입력을 신뢰하지 않는다. 초안 객체의 필드와 데이터 속성 형태, `draft`/`not-approved` 상태, 보고된 미검증 출처 참조, 카탈로그에 맞는 제품·등급, 경로, 비어 있지 않은 납품 대상, AI 사용 여부를 다시 검사한다. 필수 축이 하나라도 빠졌거나 값이 잘못되었거나 출처/승인 표식이 정규 초안과 다르면 `null`을 반환한다. 완전한 초안의 `productTier`와 `deliveryTargets`만 기존 ApprovedSpec 소비자용 필드 모양으로 투영한다. 예: `{ productTier: "M", targets: ["web-api"] }`. 이 투영은 데이터 모양 변환일 뿐 승인 명세 자체가 아니며 승인 Revision이나 근거를 만들지 않는다.

기존 승인 명세 계약에는 경로(route), 제품 ID, 추가 항목 ID, 제품의 AI 사용 여부 필드가 없다. 따라서 이 세부 선택을 승인 명세에 넣었다고 가장하지 않는다. 실제 mapping/writer 계약이 추가되기 전까지 이 정보는 초안으로만 보존한다. 승인 증거, 권리 판정, asset eligibility, 빌드·검증·납품 결과도 이 모듈에서 만들지 않는다.

## 예시

```ts
const result = parseProductSelectionDraft({
  workspaceId: "workspace-1",
  projectId: "project-1",
  sourceContext: { sourceIds: ["consult-42"], revisionRefs: ["baseline-r3"] },
  productId: "M02",
  productTier: "M",
  route: "ASSEMBLY",
  deliveryTargets: ["web-api"],
  deliveredProductUsesAI: false,
  addOnIds: ["A03"],
}, { workspaceId: "workspace-1", projectId: "project-1" });
// complete 초안. sourceContext는 미검증 참조이며 승인이나 분석 완료를 뜻하지 않는다.
```
