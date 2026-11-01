# Core Host 재검증

2026-11-02. Builder 기능 추가가 아닌, Core 변경 후의 실제 source 앱 회귀 기록이다.

## Source Inventory 후속 재검증

다음은 아래 초기 검사와 별개의 정확한 후보 검사다.

- Builder 문서 HEAD `0a4c54c133d81eb3bfcb44e3dc4c18bb52d31399`,
  runtime `1d5b884e20546af45486e1ad224685a3666fc8f2`.
- Source `0f34b37438bf3ef51947d3372630853f673a60e0`.
- Core `bebc04f7bfa54ad25c8676ade61fafe1ab0c4e2e`.
- 공개 SDK `61a929f6c783f78e5af603682de1543c7e24abc0`, Node24.22.1.

`node scripts/test-core-host.mjs`가 exit0으로 끝났다. 실제 격리 source 앱에서
System의 Workspace 연결 안내·대화용 rail/토글 부재, 기존 Lead Agent 선택과
명시적 저장·원래 설정 보존, 실제 Bridge·TXT 미리보기와 명시적 저장·A/B 분리·
재시작·Settings 복구를 확인했다. 복사해 로드한 UI index SHA-256은
`e6f37705ebdfa27f496c5a52641635b399f9dbf4e66ebb29fa25beb39dc23e5a`이다.
Main4개 정상 종료·출력8개 종료·실패0개 및 정확한 임시 데이터 정리를 확인했다.
로컬 원시 로그는 Git에서 제외하며 공개 레포에 비공개 소스를 복사하지 않았다.

Core의 Source 내부 조회 개선은 Builder의 AI 기능 추가가 아니다. 이 시험에서
Core의 정리 검사를 UI로 호출하지 않았고 실제 Google/AI·Main Preview·전체 자손·
설치본·두 PC도 검증하지 않았다. Lead3세션·공유 기억·프로젝트별 CTO 단일 세션·
독립 Dev/QA·GitHub Actions 납품은 여전히 별도 구현·검증 범위다.

## 초기 재검증

- Builder 문서 HEAD: `4cef8b8dd74651406ded8a3f100e96ca599b3a0c`.
- Builder runtime: `0a935e38ece5aa7e5f1a7c28d4af6439ab0e8134`와 동일.
- Source: `2ee7a348e205f3323903ababfe292b7cc429ddf6`.
- Core: `f8ef641e3c6f71699ea0c95d38e979f6c76b28df`.
- 공개 SDK: `61a929f6c783f78e5af603682de1543c7e24abc0`.
- Node: `24.22.1`.

준비된 비공개 Desktop checkout을 `SPS_BUILDER_CORE_DESKTOP`으로 지정하고
`node scripts/test-core-host.mjs`를 실행해 exit0을 확인했다. 실제 source
Electron/Core에서 명시적 설치·활성화·Shell 선택, 검정 UI, 실제 Bridge,
상담 텍스트 저장·동일 요청 재시도, Workspace A/B 분리, Lead Agent 지정과 원래
Agent 설정 보존, 재시작 후 상태 보존 및 별도 Settings 복구가 통과했다.

복사해 로드한 UI index SHA-256은
`c099f8b77d49656c5117bd5395fd0f44c2752f2759bee30a47a77d9a6bba4ba0`이다.
시험 Main4개가 exit0으로 종료되고 출력 스트림8개가 오류 없이 닫혔으며,
정확한 격리 임시 데이터 삭제도 확인했다. 새 캡처는 생성하지 않았다.

모의 Identity를 쓰는 검사다. 실제 Google 로그인, AI 실행, Main에서 여는
Preview, 전체 자손 프로세스 종료, 서명 설치본과 두 PC를 검증한 것은 아니다.
Core의 새 내부 정리 검사도 아직 Settings에 연결되지 않아 이 시험으로 그
기능을 사용자 조작 검증했다고 말하지 않는다. Lead3세션·공유 기억·프로젝트별
CTO·독립 Dev/QA·GitHub Actions 납품 흐름은 여전히 구현/검증이 남아 있다.

원본 사용자 앱·로그인·프로필·Vault·외부 프로젝트는 사용하거나 변경하지 않았다.
Core 소스나 원시 로그는 이 공개 레포에 복사하지 않았다. 설계 v15와 UI v9의
제품 범위는 그대로 유지한다.
