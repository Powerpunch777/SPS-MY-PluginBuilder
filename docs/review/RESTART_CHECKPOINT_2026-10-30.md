# 개발 재개 체크포인트 — 2026-10-30

## 목적과 기준

이 문서는 2026-10-30 시점의 Source/Core/SDK 및 Desktop 상태를 재개 판단용으로 기록한다. 기존 v15 설계와 2026-10-29 검토 문서는 당시 판단의 역사 기록으로 보존하며 수정하지 않는다. 이 문서 추가는 Core 완료 선언이나 Builder 구현 착수를 뜻하지 않는다.

기준 조합:

| 구성 | 기준 |
| --- | --- |
| SPS Source | `d3777c155632f23349ac2243f3fc615cb8759643` |
| SPS Core | `01fe9b16162fb8f6c0023e5efda30c1189094f10` |
| SPS Plugin SDK | `61a929f6c783f78e5af603682de1543c7e24abc0` |
| SPS Desktop | `0.4.137` development-candidate |

## 구현된 코드와 확인된 CI

- Core에는 durable claim receipt와 empty claim 처리가, Desktop/Node에는 encrypted claim journal과 completion outbox 연계가 구현되어 있다. 이는 코드 상태를 기록하며, 모든 운영·재시작 경로가 검증됐다는 뜻은 아니다.
- Zod `4.6.6`과 명시적 v3 호환 처리가 기준 조합에 포함된다.
- GitHub에서 Source push `41011334677`과 PR `41011340737`의 각 CI 결과는 `18/18 success`다. 이 근거는 해당 Source CI에 한정하며 모든 Core 배포·설치 경로의 통과 증거로 확대하지 않는다.

## 아직 검증되지 않은 Core/Desktop 경로

- 실제 Main 프로세스의 export/import, promotion, activation, restart 조합 qualification은 남아 있다.
- Installer 테스트는 same-version unsigned preservation만 확인했다. 이전 stable 버전에서의 upgrade/migration, normal profile, 동일 서명 설치본의 실제 Host/Member 두 대 PC 검증은 완료되지 않았다.
- 따라서 현재 근거만으로 Core가 완성됐거나 전체 업그레이드·복구가 안전하다고 선언하지 않는다.
- 종료/재시작 qualification은 실제 프로세스 종료와 durable 결과 기록을 구분해야 한다. Node child process의 `close`는 프로세스 종료와 stdio 종료 뒤 발생한다([Node.js child_process 문서](https://nodejs.org/api/child_process.html#event-close)). Electron `app.quit()`은 창 종료 과정을 거치지만 `app.exit()`은 즉시 종료하며 `before-quit`/`will-quit`를 발생시키지 않는다([Electron app 문서](https://www.electronjs.org/docs/latest/api/app)). 이 문서는 해당 경로의 제품 테스트가 완료됐다는 주장이 아니다.

### 같은 날 후속: 정상 소스 앱 복원 흐름 확인

위 기준 이후 Source `a7246667584615edcb8ed71dfc16a983bac455a6`에는 재현 가능한
`test:e2e:owner-vault-transfer` 검증 도구와 기록이 추가됐다. Core/SDK와 제품 Main
동작은 그대로다. 실제 Electron Main의 내보내기, 별도 빈 프로필 복원, 프로젝트·
storage 파일 보존, 정상 종료 후 재시작의 프로젝트 조회가 수동 개입 없이 통과했다.
복원 관련 67/67, 공유 Identity·harness 6/6, 전체 Desktop 검사와 Core 빌드도 통과했다.

이는 임시 프로필·fixture Identity를 사용한 **정상 소스 앱 경로**의 확인이다.
위 첫 항목 중 정상 경로의 공백을 보완하지만, 강제 종료·크래시 복구나 실제 운영
Google 인증, 설치본 업그레이드·마이그레이션, 서명본·물리 두 PC 검증은 아니다.
새 Source 커밋의 원격 CI도 기준 커밋 CI와 별개다.
[재현 명령과 한계](https://github.com/Powerpunch777/SPS-Source/blob/a7246667584615edcb8ed71dfc16a983bac455a6/sps-server/docs/reviews/OWNER-VAULT-MAIN-ACCEPTANCE-2026-10-30.md)를 따른다.
해당 소스와 기록은 비공개 저장소 접근 권한이 있어야 열 수 있다.

## Builder 상태와 미확정 연동

- Builder 저장소는 계속 설계 저장소이며 제품 패키지 구현은 없다. v15와 UI 시제품은 구현 증거가 아니다.
- SDK와 내부 Core 사이의 ABI, manifest/worker/UI 연결은 아직 매핑·검증되지 않았다.
- Workspace 설정의 `secret-ref` schema는 지원되지 않은 상태다. 자격증명을 평문 설정으로 대체하지 않는다.
- Codex thread의 대화 이력 및 재개 경로도 아직 확정·검증되지 않았다.
- Builder 착수 판단 전에는 위 연동 계약을 확인한다. 문서상 범위나 기존 코드의 존재를 실제 Builder 기능 완성으로 간주하지 않는다.

## 재개 범위 메모

- 우선순위는 Core-first다. Native 작업은 기본 비활성(deferred/off)이며, 공개 Marketplace는 폐기(retired)하고 내부 Registry 방향은 유지한다.
- 구현된 코드, 통과한 CI, 미검증 경로, 향후 Builder 요구를 별도 근거로 취급한다. 이 체크포인트는 기능 범위나 MVP를 새로 정하지 않는다.
- 이번 문서 작업에서는 코드·설계 원본·의존성·테스트·CI를 변경하거나 실행하지 않았다.
