# SPS MY Plugin Builder

자체 외주 사업의 고객 요구, 설계, 구현, 검증 및 납품을 관리하는 SPS 플러그인입니다. 공개 플러그인 마켓플레이스나 별도 범용 SaaS를 목표로 하지 않습니다.

현재 SPS Builder는 **구현 및 통합 검증 단계**입니다. 개발은 [`codex/builder-foundation`](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/tree/codex/builder-foundation)에서 진행하며, 일부 최신 변경은 로컬 작업 중입니다. 개별 기능과 실행 연결의 검증은 진행됐지만, 실제 AI 개발부터 최종 납품 승인까지의 전체 인수는 완료되지 않았습니다.

이 `main` 브랜치에는 초기 설계 원본과 과거 검토 문서가 남아 있습니다. 이 브랜치의 문서 안내 갱신은 개발 코드 병합이나 릴리스를 뜻하지 않습니다. 원격 개발 브랜치도 로컬 미커밋 작업을 모두 포함하지는 않습니다.

## 현재 개발 문서

- [현행 제품 기준선 v16 및 후속 사용자 결정](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/blob/codex/builder-foundation/docs/design/CURRENT-PRODUCT-CONTRACT-2026-11-04.md)
- [설계 마스터 인덱스와 과거 정책의 대체 관계](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/blob/codex/builder-foundation/docs/design/README.md)
- [공개된 구현 기록과 검증 한계](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/blob/codex/builder-foundation/docs/implementation/README.md)
- [원문 AC 및 인수 증거 추적](https://github.com/Powerpunch777/SPS-MY-PluginBuilder/blob/codex/builder-foundation/docs/design/AC-TRACE-2026-11-04.md)

위 링크는 원격에 공개된 내용입니다. 최신 사용자 결정과 로컬 WIP가 아직 반영되지 않았을 수 있으므로 원격 문서의 개별 시험 합격을 현재 설치본이나 제품 전체 완료로 해석하지 않습니다. 파일명의 날짜는 최초 작성일일 수 있습니다.

## 보존한 초기 설계 원본

사용자가 제공한 `SPS_Plugin_Builder_Design_Stack_UI_2026-10-29.zip`의 네 파일을 아래 경로에 원본 그대로 보관합니다.

- [원본 안내](docs/design/README.md)
- [최종 통합 설계 v15](docs/design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md)
- [기술 스택 조사](docs/design/02_Tech_Research/SPS_Builder_Technology_Stack_Research.md)
- [Lead UI v9 HTML](docs/design/03_UI/SPS_Builder_Lead_UI_v9.html)

## 과거 검토 자료 (2026-10-29)

- [개발 재개 전 체크포인트](docs/review/CHECKPOINT_PRESTART_2026-10-29.md)
- [의존성과 병렬 작업 계획](docs/review/DEPENDENCY_AND_PARALLEL_PLAN_2026-10-29.md)
- [Core에서 먼저 확인·해결할 사항](docs/review/CORE_PREREQUISITES_2026-10-29.md)
- [설계·실제 코드 비교 분석](docs/review/SPS_Plugin_Builder_Analysis_2026-10-29.md)

위 검토 문서의 미착수·중지·의존성·브랜치 정보는 작성 당시의 관측입니다. 현재 개발 상태나 최신 실행 지시가 아닙니다. 원본 설계와 실제 구현·검증 상태는 구분하며 HTML은 실제 Core·Codex·GitHub 연동을 입증하지 않는 UI 시제품입니다.

후속 사용자 지시에 따라 검토한 구성요소의 라이선스 차이는 설계 채택의 차단 사유로 삼지 않습니다. 구성요소의 실제 라이선스와 고지는 그대로 유지하며, 이 저장소 전체에 별도의 라이선스를 임의로 부여하지 않습니다.
