# 프로젝트별 G7 산출물 자료 저널

기록일: 2026-11-04. 이 문서는 저장 모듈의 현재 범위와 한계를 설명한다. 제품 완료나 사용자 승인을 선언하지 않는다.

## 기준과 범위

- 현행 제품 계약 `CURRENT-PRODUCT-CONTRACT-2026-11-04.md` §6은 G7을 계약상 실행물, 설치/사용 자료, 테스트와 제한을 준비하는 단계로 정의하고 고객 자동 전달은 제외한다. §7.1–7.2는 내부 설계 기준선과 외부 계약, 사용자 승인, 실행 권한을 구분하며 실제 권한 이벤트 없이 승인을 만들지 않는다.
- 같은 계약 §8.2는 Requirement 등 정식 구조 데이터의 ID와 원본 저장소를 보존하고 통합 문서에서 연결하도록 한다. 기준선 요구사항 목록을 자동으로 계약상 산출물 목록으로 바꾸지 않는다.
- v15 AC-07/08은 재사용 가능 범위와 상품 분류를, AC-29는 Release 정보와 복구 안내를, AC-34/91–95는 Lead 기술 선정과 CTO 재사용 조사 경계를 다룬다. 이 자료 저널은 상품, 가격, 라이선스 승인 또는 카탈로그 항목을 만들지 않는다.
- CSAS v0.8 F절의 G7, `CURRENT-PRODUCT-CONTRACT-2026-11-04.md` §9는 설치/실행/사용 안내, 테스트/QA, 알려진 제한 및 계약상 산출물 준비를 설명한다. 테스트/QA의 실제 결과는 이 문서 입력으로부터 추론하지 않는다.

## 구현

`src/domain/project-deliverable-source.ts`는 프로젝트가 작성할 산출물 요구사항과 원본 참조, 기존 카탈로그 레코드 참조, 설치/사용/알려진 제한 텍스트 및 출처 참조의 입력을 엄격히 복사·검증한다. 카탈로그 본문은 복사하지 않는다. 각 저장 Revision에는 작성 출처와 관찰된 Source Revision을 기록한다. 비어 있거나 아직 작성되지 않은 설치/사용/제한 항목은 `null`로 유지한다.

`src/project-deliverables-store.ts`는 기존 Builder CAS revision journal을 재사용한다. 범위는 Workspace와 project로 나뉘고, 낙관적 `expectedBaseRevisionId`로 초안을 추가한다. 현재 조회는 요청된 source revision과 기록의 source revision을 대조한다. 일치 결과도 `authority: unknown`, `sourceRevisionVerification: unknown`을 유지한다. 불일치는 현재 자료로 반환하지 않는다.

이 모듈은 입력의 실제 원본 존재, 본문 진실성, 사용자/Lead 권한, 계약 승인, 현재 Git/source-manifest와 소스 범위의 동일성, QA 독립성, 테스트 통과, 릴리스·설치·실행 허가를 증명하지 않는다. 초안의 기록과 조회는 승인/발행이 아니다. 인증된 작성 액션과 정식 승인 이벤트 연결은 미결정 질문 `Q-CP3-G5-G7-AUTHORING-APPROVAL`에 따라 별도 연결해야 한다.

## 현재 소비 경계

기존 `src/delivery-evidence/current-preparation.ts`는 별도 현재 계약/문서 provider를 받지만 이 작업 중 QA가 검토 중이어서 변경하지 않았다. 새 Reader는 아직 그 provider에 배선되지 않았다. 따라서 현재 G6/G7 준비 응답은 이 저널에 있는 값으로 갱신되지 않으며 계약 권한이나 문서 가용성을 완료로 표시하지 않는다. 소비자 연결과 독립 QA는 별도 검토가 필요하다.
