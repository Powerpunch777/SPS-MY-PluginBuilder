# 구현 기록

현행 구현 기준은 [v16 정본](../design/CURRENT-PRODUCT-CONTRACT-2026-11-04.md)과
[마스터 인덱스](../design/README.md), 확인된 증거는 [AC 추적표](../design/AC-TRACE-2026-11-04.md)다.
아래의 날짜가 붙은 계획·검사 결과는 당시 구현과 범위를 보존하는 기록이다.

## 2026-11-06 연결 현황

| 기능 | 현재 구현과 검증 경계 |
| --- | --- |
| 상품 선택 | 공식 16개 상품·5개 부가 서비스, 독립 분류 축, 사용자 CAS 초안 저장과 화면 연결. 로컬 독립 QA·데스크톱/모바일 검사 완료. 승인 명세·실제 빌드·납품 완료는 아님. |
| 상담 분석 | 수집은 AI를 실행하지 않음. 명시 분석 action이 원문 경계·해시를 고정하고 Main에 한 번 전달. 시스템 분석 요청은 사용자 원문·승인 근거에서 제외. 응답 유실·재시작·중복 요청의 로컬 회귀와 독립 QA 완료. |
| Lead 6세션 | 여섯 독립 Session ID와 채널별 도구 정책, Main 공식 발행 제한, Lead 영역 탐색 연결. 준비·화면 이동만으로 AI 호출하지 않음. 실제 Host 계정 전환 검증은 미완료. |
| 기준선 문서 | Main 발행 후 결정적 본문·해시·source pin을 기존 Revision journal에 저장하고 문서센터에서 조회. stale/unavailable, 별도 journal 실패와 명시 재생을 구분. 전체 납품 inventory와 독립 승인 증거는 아님. |
| D3 | 실제 Main 원문·현재 Baseline 조회와 Main 전용 팩 제안/조회 연결. 팩 제안은 승인된 규칙·Coverage가 아니며 미등록 권위는 `UNKNOWN` 유지. |
| Reuse·Gate·Manager | 범위별 backend 후보와 테스트를 통합 중. 실제 권리·전체 소스·기술 실행 증거 및 Host 자동 통합은 아직 미검증. |

빌드·타입·테스트는 선언된 SDK commit `c69915a518f0eb600f0ace8238144059911f8d04`와
일치하는 고정 사본에서 검증한다. 기존 설치 의존성과 작업 데이터를 덮어쓰지 않는다.
로컬 fixture·브라우저 미리보기 결과는 실제 Host·AI·실기기 인수나 원문 AC 전체 합격이 아니다.
다음 연결 대상은 HTML/UI 승인, 권위 있는 source/runtime reader, 자동 통합과 최종 패킷·사용자 승인이다.

- [상품 선택 저장 계약](product-selection/contract.md)
- [기준선 본문 생산자와 Manager 읽기 계약](project-documents/baseline-body-source.md)
- [Reuse 후보의 미검증 권리 경계](reuse-first/platform-contract.md)

- [Codex 네이티브 Worker 후속 검증 상태](CODEX-NATIVE-WORKERS-2026-11-02.md): App Server 조사 결과, 현재 미입증 범위와 실행 전 검증 게이트.
- [CTO Task Packet 구현 기록](CTO-TASK-PACKETS-2026-11-02.md): CTO 계획 도구의 구현 범위, 근거와 한계.
- [v15 완료 계획](BUILDER-V15-COMPLETION-PLAN-2026-11-02.md): 전체 인수 기준과 실행 순서.
