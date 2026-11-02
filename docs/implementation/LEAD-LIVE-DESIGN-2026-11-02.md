# Lead 실제 앱 live-design 시험 기록

기록일: 2026-11-02  
범위: Builder의 live-design 운영자 실행 한 건. 이 기록은 제한된 실제 시험의 근거이며, v15 인수 기준 통과나 제품 완료를 뜻하지 않는다.

## 시험 결과

최종 앱 시험은 종료 코드 0으로 끝났다. 실제 Source Desktop/Host와 실제 Codex CLI를 사용했고, 현재 기본 CLI 계정으로 실행하기 전에 사용자의 명시적 동의를 받았다. 운영자는 `--live-design`과 함께 `SPS_BUILDER_LIVE_CODEX=1`, `SPS_BUILDER_LIVE_DESIGN=1` 두 설정을 모두 명시해야 했다. 시험에서는 mock identity를 사용했으며 실제 Google OAuth는 사용하지 않았다.

Host에서 관찰한 도구 호출 순서는 다음과 같다.

1. MCP `list_plugin_tools`
2. 원본 읽기를 위한 `execute_plugin_tool`
3. 초안 읽기
4. 한 건의 쓰기를 포함한 `propose`
5. 초안 재조회

최종 시험에서 `actualUiSend`, `actualProviderSucceeded`, `liveLeadToolInvoked`, `realHostDraftWritten`, `restartRetainedDraft`, `otherWorkspaceUnchanged` 신호가 모두 참으로 보고됐다. 저장된 초안 요약은 주입된 fixture가 아니라 실제 Host 결과를 렌더링했다. 이 결과는 해당 시험에서 실제 UI 전송, Lead 도구 호출, Host 초안 쓰기·재조회와 재시작 후 보존을 확인한 것이다. 일반 Agent 기본 권한 동작이나 포괄적인 권한·보안 검증을 입증하지는 않는다.

화면 캡처 시 마지막 답변은 앱이 자동 스크롤하지 않아 보이는 영역 아래에 있었다. 따라서 사용자에게 마지막 답변이 보였다고 주장하지 않는다. 자동 스크롤 동작 수정과 재시각 검증이 남아 있다.

## 구현 및 검사

이번 구현에는 `scripts/live-design-acceptance.mjs`와 `test/design-draft-worker-rpc.test.mjs`가 추가됐다. 후자는 결정론적 `fakeHost`와 `builtWorker`를 사용한다. 이 테스트 근거는 fixture 기반 검사이며, 최종 실제 앱·실제 Codex CLI 시험과는 별개다.

Node 24에서 전체 테스트 160/160이 통과했다. 타입 검사, 빌드, SDK 검증, CLI 검증 및 테스트 검사도 통과했다. 이 결과는 설치 자격, 두 컴퓨터(2PC) 검증, 실제 Google OAuth 또는 고객용 결과물의 종단 간 완성을 증명하지 않는다.

## 권한 및 시험 경계

최종 시험의 TrialAgent에는 MCP `execute_plugin_tool` 승인 모드 `approve`와 허용된 바깥 도구 2개가 명시적으로 설정됐다. 이 MCP 승인 재정의 없이 실행한 첫 시험에서는 AI 답변에 도구가 취소됐다는 설명이 나타났다. 다만 실제 도구 로그를 확인하지 않았으므로, 도구 호출이 취소됐는지 또는 취소의 원인이 무엇인지는 확정할 수 없다. 첫 시험의 Main은 3/3으로 정상 종료했다. 최종 시험은 5/5로 정상 종료했고, 출력 10건은 모두 `ended`였으며 `failed`는 0건이었다. 최종 시험의 임시 데이터는 정리했다. 첫 실패의 바깥 빌드 복사본은 실행 중인 프로세스가 없지만 자동 정리가 거부되어 로컬에 보존했다. 실제 사용자 데이터는 아니다.

승인 재정의 없이 일반 Agent 기본 설정이 동작한다고 주장하지 않는다. MCP 도구에 대한 제품 권한 UX는 추가 작업이 필요하다. Core grant, 인증 동작, 전역 설정은 변경하지 않았다. 플러그인은 임시 Host에 설치해 시험했지만, 사용자 환경의 정식 설치 절차나 배포 설치본은 검증하지 않았다. 두 컴퓨터(2PC) 검증도 수행하지 않았다. 읽기 전용 CLI 셸 기능은 비활성화했다. 하위 에이전트는 사용하지 않았다.

## 기준 리비전 및 지문

시험 기준 리비전: Builder `12ba623` / Source `3c1eb21` / Core `32a3f9f` / SDK `316c56f`. 아래 Source fixture 지문은 이 문서 편집 전에 기록한 값이다. 문서만 수정했으므로 시험한 Source fixture는 바뀌지 않았다. Source 관련 부모 측 기록은 별도로 작성됐다.

| 산출물 | SHA-256 |
|---|---|
| Source | `a3cfc3b3b218f4cfda0fcd946b568b24cc54c9fc13615383244957777f06401b` |
| Worker | `0b689d536fd998cf9a3fcab3096d0797dd4e118b335936d6eef3eb638b0e9b21` |
| UI | `a8987fa1c22e1d6ab5118c9c8bec0d0597fe163d353b1a591cda59080a3c021a` |
| Manifest | `b1ec6cf28f50cb1b04211cde9f93de829927ceeac9cdccf85a3491a657a4733e` |
| Draft | `fe2a10f9e0f7cd1cdaf6c0ff907236fcd8119a9851803ac46358bec079fca2a3` |

원본 앱 로그 `sps-builder-live-design-app-verified.log`는 로컬 임시 위치에만 보관하며 공개하지 않는다. 원본 로그, 사용자 경로, 계정 정보 또는 비공개 Core 소스를 이 저장소에 추가하지 않는다.

## 남은 작업과 주장 범위

- 세 Lead 세션 간 공유 메모리, 전체 handoff, 승인·질문 흐름은 미완성이다.
- CTO, Worker, QA 및 외부 provider의 증거·전달 흐름은 미완성이다.
- Marketplace·Preview·자체 LAN 작업은 보류 상태이며 기존 Tailscale은 유지한다.
- 마지막 답변 자동 스크롤 문제를 수정하고 화면에서 다시 확인해야 한다.
- 이번 증거는 기본 Agent 권한으로의 성공, 실제 Google OAuth, 사용자 환경 정식 설치, 두 컴퓨터(2PC) 검증, 전체 v15 인수 또는 고객용 결과물 완성을 입증하지 않는다.

이 기록으로 완료 처리하는 인수 기준은 없다.

## 후속: 대화 스크롤 개선

별도 Builder `dcaecb3`에서 최초 대화는 끝으로 이동하고, 아래쪽을 보고 있으면 새 내용을
따라가도록 했다. 사용자가 위쪽 기록을 읽으면 자동 이동을 멈추며 `최근 메시지로 이동`
버튼으로 직접 돌아갈 수 있다. 명시적 이전 페이지는 처음 위치에서 읽도록 유지한다.

Node24 격리 타입 검사·빌드·전체163/163·SDK CLI 검사와 no-AI 실제 source 앱 시험이
exit0이었다. 긴 메시지 fixture를 API 응답으로만 표시해 최초 끝 위치, 위쪽 독자의 위치
유지, 직접 최근 메시지 이동, fixture 제거 후 원본 상태 불변을 확인했다. 이 후속에서는
새 실계정 AI를 실행하지 않았으므로 위 실제 설계 시험과 검증 범위를 구분한다. 캡처는
데이터 갱신 중간의 loading 표시를 포함하며 일반 사용자 흐름 완성을 뜻하지 않는다.

후속 source fingerprint는 `c03d94c622464d3de6956f1514cce1932de62af28a049072bfdc7818a27de18f`,
UI build SHA-256은 `4d71d0c5e96708b5ca2f4cc4f33274596c5d9cf169a0754bdc07ccdc84c08320`다.
Worker와 manifest는 위 실제 설계 시험과 같은 bytes다. 로컬 로그 이름은
`sps-builder-transcript-app.log`이며 Main4/4·출력8개 정상 종료와 임시 데이터 정리를
확인했다. 문서 추가 후의 HEAD 전체를 이 fingerprint와 같다고 표시하지 않는다.

## 참고 자료

공식 MCP 설정 및 승인 문서: [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp).
