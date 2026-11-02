# SPS Plugin Builder — 설계·기술 조사·UI 묶음

- `01_Design/`: 최신 통합 설계서 v15 (Lead/CTO/Worker/QA 및 기술 선정 반영)
- `02_Tech_Research/`: 기술 스택 조사·선정 근거
- `03_UI/`: HTML UI v9 (Document Worker 제외)
- [UI 적용 기준 (2026-11-01)](03_UI/UI-IMPLEMENTATION-CONTRACT-2026-11-01.md):
  UI v9의 구조·배치를 유지하고 색상만 사용자 결정에 따라 Codex식 검정·중립
  회색으로 적용한다. Core 테마와 구분하며, 미구현 기능은 위치를 유지하고
  사용 불가 상태로 표시한다. 임시 밝은 UI는 최종 기준이 아니다.

## 검토 중인 개정안

- [명세 검증 G1~G6 통합 개정안 (2026-11-02)](proposals/SPECIFICATION-GATES-INTEGRATION-DRAFT-2026-11-02.md)
- [추가 인수 기준·기존 AC 추적표](proposals/SPECIFICATION-GATES-AC-TRACE-2026-11-02.md)

위 두 문서는 작성·검토를 위한 초안이다. 기존 v15를 대체하거나 새 검증 정책의
구현을 승인하지 않으며, 기존 AC의 완료 상태와 UI v9 기준을 변경하지 않는다.

## 사용 안내
`03_UI/SPS_Builder_Lead_UI_v9.html` 파일을 브라우저에서 열면 UI 시제품을 볼 수 있습니다.
이 HTML은 **동작 시연용 프로토타입**이며 실제 SPS Core·Codex·GitHub 연동을 포함하지 않습니다.

## 개발 작업 기준

- 작업 분담·공식 자료 사전 조사·한도 회복 후 재개·쉬운 한국어 보고는
  루트 [AGENTS.md](../../AGENTS.md)를 따른다.
- 총괄은 설계·통합·최종 검수를 맡고, 독립적인 작은 작업은 `gpt-6-luna`
  `high` 추론에 나누어 병렬로 진행한다. 요청한 모델을 사용할 수 없는 경우
  사용했다고 표시하거나 임의로 다른 모델·계정으로 바꾸지 않는다.
- 검정·중립 회색은 Builder 플러그인에만 적용한다. 업무 설계는 v15,
  화면 구조는 v9, 실제 색상과 반응형 적용은 위 UI 적용 기준을 따른다.
  이 기준은 Core 전역 UI나 실제 AI 실행의 완료를 뜻하지 않는다.

이 묶음에는 과거 버전이나 이전 AGENTS/Skills 초안이 포함되지 않습니다.
