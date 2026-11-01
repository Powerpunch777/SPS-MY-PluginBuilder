# SPS MY Plugin Builder

자체 외주 사업의 고객 요구, 설계, 구현, 검증 및 납품을 관리하는 SPS 플러그인입니다. 공개 플러그인 마켓플레이스나 별도 범용 SaaS를 목표로 하지 않습니다.

현재는 **v15 설계에 따른 초기 구현 단계**입니다. Workspace별 데이터 검증, 상담 텍스트 저장 액션, 공개 SPS SDK Worker와 Lead 중심 UI를 구현하고 있습니다. 실제 AI·GitHub·Runner 연동과 납품 전체 흐름은 아직 완성되지 않았습니다. 설계 HTML과 개발용 UI Preview는 실연동 결과가 아닙니다.

## 개발 실행

Node.js 22.18 이상과 npm이 필요합니다. 공개 SDK는 확인한 Git commit에 고정합니다.

```sh
npm ci
npm run check
npm run dev
```

개발 미리보기는 `http://127.0.0.1:4174/`에서 열립니다. 이 화면은 Core·AI에 연결하지 않으며, 입력은 창의 메모리에만 보관합니다. 실제 플러그인 빌드는 Host의 React/UI Bridge와 Workspace 저장소를 사용합니다. 별도 Electron 앱이나 자체 서버·AI 실행기를 제품에 추가하지 않습니다.

Chrome이 설치된 개발 PC에서는 Preview 실행 중 `npm run test:browser`로 데스크톱/모바일 메뉴·입력·레이아웃을 확인할 수 있습니다. 이 검사는 실제 SPS Host 설치·Google 로그인·Codex·두 PC 검증을 대신하지 않습니다.

## 현재 구현

- Workspace가 다른 데이터, 잘못된 참조 및 중복 ID를 거부하는 Builder 상태 계약.
- 실제 Core가 제공한 Workspace/사용자 범위로 선택한 상담 텍스트를 저장하는 액션. 같은 요청 재시도는 중복 저장하지 않으며 AI 분석을 시작했다고 표시하지 않습니다.
- Lead 대화, 설계 지도, 조직도, 문서, 미결정사항, 시스템 화면과 읽기 전용 하위 AI 기록 UI.
- SDK 빌드·정적 매니페스트·Worker 생명주기 검사와 source-only 격리 Host의 초기 저장 흐름 검증. 설치본·실제 AI·납품 전체 검증 완료본은 아닙니다.
- Host 설치만으로 Workspace에 자동 활성화하지 않습니다. Workspace 활성화와 Shell 선택은 명시적으로 수행합니다.
- 시스템 화면에서 같은 Workspace의 기존 Agent를 Lead용으로 지정·해제하고 재시작 후 유지할 수 있습니다. 지정은 AI 실행·세션 생성·Agent 설정 변경이 아닙니다. 메시지 전송은 아직 비활성입니다.
- 사용자가 고른 UTF-8 `.txt` 상담 파일을 먼저 편집 가능한 입력으로 읽습니다.
  파일 선택만으로 저장·분석하지 않으며, 직접 저장해야 기존 Workspace 저장
  경로를 사용합니다. 이 기능은 전체 출처·첨부 정규화 파서의 완성이 아닙니다.

다음 단계와 검증 범위는 [병행 구현 계획](docs/implementation/PLAN-2026-11-01.md)에 기록합니다.

## 실제 SPS Host 검사

Windows 개발 PC에서 준비된 비공개 SPS Source의 `sps-server/desktop` 경로를
`SPS_BUILDER_CORE_DESKTOP` 환경변수로 지정하고 `npm run test:core-host`를 실행합니다.
이 경로를 공개 저장소에 기록하거나 Core 소스를 복사하지 않습니다. 이 검사는
지원되는 source-only 외부 플러그인 시험 도구가 있는 개발 checkout을 요구합니다.

시험은 새 임시 프로필과 모의 Identity를 사용해 실제 Electron/SPS Host를 실행합니다.
명시적 설치·활성화·Shell 선택, 화면에서 상담 저장, Workspace 간 데이터 분리,
동일 요청 재시도와 Host 재시작 후 보존을 확인합니다. 사용자의 설치본·로그인·프로젝트는
사용하지 않습니다. 이 검사는 실제 AI, 서명된 설치본, 두 PC 검증이나 납품 완료가 아닙니다.

`npm run test:browser:ci`는 별도 서버를 수동으로 켜지 않고 독립 Preview 검사를 실행합니다.
Playwright Chromium이 필요하며, `npx playwright install chromium`으로 준비할 수 있습니다.
기존 `npm run dev`와 설치된 Chrome을 사용하는 `npm run test:browser`도 유지합니다.

## 설계 원본

사용자가 제공한 `SPS_Plugin_Builder_Design_Stack_UI_2026-10-29.zip`의 네 파일을 아래 경로에 원본 그대로 보관합니다.

- [원본 안내](docs/design/README.md)
- [최종 통합 설계 v15](docs/design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md)
- [기술 스택 조사](docs/design/02_Tech_Research/SPS_Builder_Technology_Stack_Research.md)
- [Lead UI v9 HTML](docs/design/03_UI/SPS_Builder_Lead_UI_v9.html)

## 검토 자료

- [개발 재개 전 체크포인트](docs/review/CHECKPOINT_PRESTART_2026-10-29.md)
- [의존성과 병렬 작업 계획](docs/review/DEPENDENCY_AND_PARALLEL_PLAN_2026-10-29.md)
- [Core에서 먼저 확인·해결할 사항](docs/review/CORE_PREREQUISITES_2026-10-29.md)
- [설계·실제 코드 비교 분석](docs/review/SPS_Plugin_Builder_Analysis_2026-10-29.md)

원본 설계와 실제 구현 상태는 구분합니다. 2026-11-01 사용자가 Builder와 Core의 병행 개발을 지시했습니다. 과거 검토 문서의 ‘개발 미착수/중지’는 당시 기록이며, 현재 상태는 위 구현 목록과 최신 계획을 따릅니다. Core의 미해결 설치·복구·두 PC 검증은 별도이며 Builder UI의 통과로 완료 처리하지 않습니다.

후속 사용자 지시에 따라 검토한 구성요소의 라이선스 차이는 설계 채택의 차단 사유로 삼지 않습니다. 구성요소의 실제 라이선스와 고지는 그대로 유지하며, 이 저장소 전체에 별도의 라이선스를 임의로 부여하지 않습니다.
