# 시스템 화면 검증

2026-11-02 KST. 통합 설계 v15와 UI v9 원본을 바꾸지 않은 UI 후속 보정이다.

## 변경 범위

- System 화면에서 대화용 작업 기록 패널과 열기/닫기 토글을 제거했다.
  Lead·미결정사항·하위 Actor의 기존 기록 조회는 유지한다.
- 연결 상태와 Runner 영역이 사용 가능한 본문 폭을 쓴다. 좁은 화면은 세로로
  배치하며 검정·중립 회색과 기존 한글 폰트 구성을 유지한다.
- Workspace에 저장된 AI·GitHub 상태를 Host 전역 상태로 설명하지 않는다.
  `snapshot` 등 개발 용어 대신 쉬운 안내를 사용한다.
- 기존 Lead Agent 선택·명시적 저장은 유지한다. Agent 설정을 덮어쓰거나
  이 화면에서 세션·Actor·실행을 자동 생성하지 않는다.
- 현재 연결되지 않은 Runner 목록·접속 상태·운영체제·라벨·최근 작업을 지어내지
  않는다. 미연결 안내는 Runner 기능의 구현 완료나 조회 성공이 아니다.

## 정확한 검증 대상

- Builder runtime: `1d5b884e20546af45486e1ad224685a3666fc8f2`.
- Source Host: `aee421da93a466d93006003e9d393c372804b50c`.
- Core: `f8ef641e3c6f71699ea0c95d38e979f6c76b28df`.
- 공개 SDK: `61a929f6c783f78e5af603682de1543c7e24abc0`.
- 실제 Host가 복사·로드한 UI index SHA-256:
  `e6f37705ebdfa27f496c5a52641635b399f9dbf4e66ebb29fa25beb39dc23e5a`.
- SDK가 측정한 UI 디렉터리 fingerprint:
  `790d01631b2bbb92658b48275720800cf27d43d6675d21803aac3a5114c47983`.
  두 해시는 대상이 다르다. 이 문서만 추가한 후속 커밋은 runtime 변경이 아니다.

## 수행 결과

Node24.22.1 `npm run check`36/36 및 SDK validate/test가 통과했다.
`npm run test:browser:ci`도 정상 종료했다. 실제 Chromium의 desktop/mobile 및
900px embedded 화면에서 중복 패널·토글 부재, 두 영역의 배치, Agent 컨트롤 보존과
가로 넘침 없음을 확인했다. 채워진 Graph·문서·조직은 개발 fixture이며 실제 AI가
만든 데이터로 제시하지 않는다.

격리된 source Electron Host에서 `node scripts/test-core-host.mjs`가 exit0으로
끝났다. 위 Source Desktop 경로는 시험 환경변수로만 전달했다. System DOM의
Workspace 범위 안내와 Runner 미연결 문구, 패널·토글 0개, Lead 선택/저장 컨트롤
각 1개를 확인하고 실제 Workspace Agent를 선택·저장했다. 기존 Agent 설정이
그대로인지, 재시작 후 별도 Lead binding과 Workspace A/B 데이터가 보존되는지도
대조했다. 기존 TXT 미리보기·명시적 저장·잘못된 파일 입력 보존도 통과했다.

시험 Main4개 정상 종료, 출력8개 종료, 실패 출력0개 및 정확한 임시 데이터
정리를 확인했다. 원시 앱 로그와 캡처는 Git에서 제외한 로컬 검증 자료다.
공개 레포에 비공개 Core 코드·사용자 경로·계정·인증정보를 복사하지 않았다.

이전 UI runtime `d47aa84`도 실제 Host 검사를 통과했지만 최종 문구·UI 해시의
증거는 위 `1d5b884` 검사다. 이전 해시를 최종 UI 증거로 재사용하지 않는다.

## 남은 범위

현재는 UI와 기존 저장 흐름의 source-only 검증이다. 실제 Google/AI, Lead3세션
공유 기억, 프로젝트별 CTO 단일 세션, 독립 Dev/QA, GitHub Actions/Runner 납품,
설치본·두 PC·전체 자손 종료 및 Core 정리 기능의 완료 증거가 아니다. Source의
진행 상황으로 Builder 실행 계약을 우회하거나 이 설계의 범위를 줄이지 않는다.

접근성 참고: [W3C ARIA APG](https://www.w3.org/WAI/ARIA/apg/).
