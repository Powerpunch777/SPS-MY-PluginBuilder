# Core Host 재검증

2026-11-02. Builder 기능 추가가 아닌, Core 변경 후의 실제 source 앱 회귀 기록이다.

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
