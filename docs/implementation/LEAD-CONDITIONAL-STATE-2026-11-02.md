# Lead 선택 조건부 저장: 개발 Host 검증

2026-11-02. 선택 경로의 개발 Host 검증 기록이며, 전체 v15 승인이나 Stable 적격성 기록이 아니다.

## 정확한 대상

- Builder 기준 revision: `c06dcba`. 기록된 다섯 파일은 검증에 사용한 동일 작업 복사본의 내용이다.
- Builder source fingerprint: `45917d164b9a56a9340b4023c7a8e6e15a0ace237d3e7231115bed38f9d8f1f8`.
- Public SDK source pin: `fb5dbc79ea3b4c321b7558e5b823e44acf3265ba`. 임시 검증 복사본의 package와 lockfile이 이 정확한 revision을 가리켰다. SDK 버전 표기는 `0.11.0`이며, 이 검증으로 새 릴리스가 생긴 것은 아니다.
- 사용자 DEV, 설치된 앱, 기존 `node_modules`는 변경하지 않았다. 새 권한을 추가하거나 자동 승인하지 않았다.

## 저장 계약과 동작

Lead 선택은 Host의 선택적 `state.compareAndSet`을 통해 현재 Workspace(`scopeKind: "company"`)의 `lead-agent.v1` 상태를 조건부로 저장한다. 최초 선택은 행이 없는 상태를 기대하고, 후속 선택은 읽었던 레코드의 JSON 값을 기대값으로 보낸다. JSON 문자열의 키 순서 비교가 아니라 Host의 JSON 값 비교 계약이다. 새 레코드의 revision은 기존 값보다 1 증가한다. 완료 응답은 정확히 `{ swapped: boolean }` 모양이어야 하며, 잘못되거나 모호한 영수증은 성공으로 취급하지 않는다.

Host가 조건부 저장을 지원하지 않거나 호출 오류·응답 유실이 발생하면 일반 `set`으로 대체하거나 자동 재시도하지 않고 실패를 드러낸다. 조건이 맞지 않으면 충돌을 알리고 새로고침을 요구한다. 이 계약은 오직 조건부 선택 저장에 적용된다. 기존 사용 가능 Agent 및 Workspace 검사는 그대로 유지된다. Lead 선택은 AI를 실행하지 않고 Agent 설정을 편집하지 않는다.

`compareAndSet`의 원자성은 Host 구현이 제공해야 하는 계약이다. 이 공개 Builder의 단위 검사에서 쓰는 모의 저장소만으로 실제 DB 원자성을 증명하지 않는다. Host 계약 검증과 실제 앱 수용 시험을 구분한다.

## 검증 결과

- public SDK의 정확한 새 source bytes를 넣은 격리 임시 복사본에서 Builder 타입 검사와 빌드, Builder 테스트 89/89가 통과했다. 공개 SDK CLI의 validate와 test도 통과했다. 89는 공개 SDK 전체 suite의 개수가 아니다.
- 기존 `scripts/test-core-host.mjs`를 사용하는 실제 Source Desktop/OwnerHost acceptance가 exit 0으로 끝났다. 실제 UI Bridge, Workspace A/B 분리, Lead 선택·저장·재시작 후 보존, 기존 Agent 설정 보존, 세션 3개, 재검사 시 중복 없음, 대화 경로의 비-AI 실패 동작을 확인했다.
- 잘못된 `swapped` 영수증을 거부하는 검사를 포함했다. 이전 검토에서 발견된 적용 결과와 영수증 불일치는 수정 후 검증했다.
- public SDK source 검사는 깨끗한 SDK HEAD에서 수행했다. 임시 링크는 검증 후 제거했고 자식 프로세스 4/4 종료 및 출력 스트림 8개 종료를 확인했다.

재현 증거는 기존 Source Host 운영자 시험인 `scripts/test-core-host.mjs`의 실제 실행 결과다. 새 SDK bytes는 Builder의 원래 checkout에 설치된 것이 아니므로, 그 checkout에서 실행하는 SDK 명령을 새 SDK 검증의 재현 절차라고 제시하지 않는다. 실제 경로, 비공개 Source checkout, 원시 로그는 이 공개 문서에 포함하지 않는다.

## 한계와 남은 범위

이 시험은 live AI 실행, 설치된 제품, 두 대의 실제 PC, 서명된 릴리스 또는 AC-02 전체 통과를 증명하지 않는다. Builder 전체 완료도 아니다. Marketplace, Preview, Native LAN 개발은 현재 보류 상태를 유지한다. 그래프 권한 API와 revision history, 공유 기억, CTO/QA/Worker 흐름 및 provider 통합은 남아 있다. SDK의 선택적 계약은 호환 가능한 개발 Host에 대한 구현·검증이지, 릴리스된 Host 지원 매트릭스의 보증이 아니다.

이 기록만으로 AC 상태를 PASS로 바꾸지 않는다. 전체 기준과 보류 범위는 [v15 완료 계획](BUILDER-V15-COMPLETION-PLAN-2026-11-02.md)을 따른다.
