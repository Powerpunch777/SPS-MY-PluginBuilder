# Lead 설계 초안 기록

## 구현 범위

Lead 전용 설계 초안 경로를 추가했다. 상담 원문을 다시 읽어야 하는 다음 작업을 위한 초안이며, 승인된 명세·확정 Graph·실행 권한·QA 통과·납품을 뜻하지 않는다.

- `builder.read-design-sources`는 등록된 Lead 도구다. 현재 Host가 확인한 Workspace, Lead 선택, Agent, 세션과 Run 문맥이 유효한지 검사한 뒤 상담 입력의 한 페이지를 반환한다. `consultation`은 가져온 사용자 상담 텍스트, `main`과 `decisions`는 현재 Lead 선택의 사용자 메시지만 반환한다. Lead 답변이나 CTO 입력은 사용자 근거로 내놓지 않는다. 페이지는 cursor로 이어 읽는다.
- `builder.propose-design`은 현재 Lead만 호출할 수 있다. 제안에 든 출처 ID가 실제 해당 Workspace/Lead 선택의 사용자 입력인지 확인하고, 입력 본문의 SHA-256을 기록한다. 초안 저장은 기존 revision journal의 예상 이전 revision 비교(CAS)를 사용한다. 불확실하거나 충돌한 결과를 자동 재전송하지 않고 현재 초안을 다시 읽도록 응답한다.
- `builder.read-design-draft`는 현재 선택의 초안을 읽는다. 이전 Lead 선택의 branch는 보존되지만 새 선택으로 자동 승인·이관되지는 않는다.
- 순수 검증기는 초안 명세와 Graph의 모양, ID 참조, 고유성, 입력 크기와 Graph 의존성 순환 등을 검증하고 결과를 동결한다. 초안 표시는 내부 검증에만 사용하는 승인 근거 placeholder를 결과에 포함하지 않는다. 참조 ID가 실제 존재하거나 권한이 있다는 사실은 검증기만으로 증명되지 않는다.
- UI는 Host data API에서 읽은 초안을 문서·Graph·미결정 질문에 읽기 전용으로 투영한다. 초안 Graph 항목은 `planned` 상태이며, 질문은 답이 없는 상태다. 사용자가 Lead를 가장해 초안을 쓸 UI action은 없다.

현재 새 Lead 선택에 이전 대화를 자동으로 넘기거나 초안 작성 호출을 자동 인계하는 동작은 구현되지 않았다. 초안 도구 경로와 별개의 기존 Lead 선택 분기는 유지되어 있으며, 새 Lead가 스스로 자료를 조회하고 초안을 제안하는 end-to-end handoff는 미완성이다.

## 검증 결과와 한계

Node 24 격리 복사본에서 타입 검사, `node scripts/build.mjs`, Node test runner(159/159)가 통과했고, SDK CLI `sps-plugin validate . --json` 및 `sps-plugin test . --json`도 통과했다. Source의 격리 연산자가 각 단계를 실행했으며, 기존 DEV의 의존성은 바꾸지 않았다. 이는 구현과 자동 검사의 결과이지 실제 Lead가 도구를 호출했다는 증거가 아니다.

실제 source Host 앱 시험은 `actualSourceHost: true`였으나 Identity는 mock이었다. 시험에서 사용자의 UI 요청으로 Lead 도구를 사칭하는 것은 거부됐고(`userDraftWriteImpersonationDenied: true`), 실제 AI 실행은 꺼져 있었다(`liveAi: false`). UI 검증에 주입한 API DTO fixture만 초안으로 표시되었으며, 실제 Host의 초안 저장은 없었다(`realHostDraftWritten: false`). 실제 Lead 도구 호출도 없었다(`liveLeadToolInvoked: false`). 따라서 이 앱 시험은 도구 등록·경계와 fixture 기반 읽기 전용 화면 확인에 한정된다.

기록된 최종 런타임 지문:

| 항목 | SHA-256 |
| --- | --- |
| Worker | `0b689d536fd998cf9a3fcab3096d0797dd4e118b335936d6eef3eb638b0e9b21` |
| UI | `a8987fa1c22e1d6ab5118c9c8bec0d0597fe163d353b1a591cda59080a3c021a` |
| source fingerprint | `c5b98707d57de62bac49db23551e51b00567294783a6f2790359d2bdcc049990` |

시험 코드 기준은 Builder `0feab9a`, Core `32a3f9f`, SDK `316c56f`다. 위 source fingerprint는 시험 복사본의 식별자이며, 이후 문서와 EOF 공백 정리를 포함한 HEAD 전체의 식별자로 주장하지 않는다.

## 남은 일과 범위

실제 Lead가 현재 인증된 Host 실행에서 출처를 읽고 초안을 제안·조회하는 통합 검증과 실제 Host 저장 후 재시작 복원 검증이 남아 있다. 새 Lead 선택 후 자료·초안 작업을 이어 주는 경로도 미완성이다. 승인된 명세로 승격, 질문 답변의 Revision 반영, Lead Graph Patch 및 전체 v15 인수 검증도 이 작업으로 완료되지 않는다.

Marketplace, Preview 및 자체 LAN 개발은 보류 범위다. 기존 Tailscale 경로는 유지한다. 이 기록은 AC 통과, 실제 AI 실행, 설치, 2PC, Stable 또는 Builder 완료를 주장하지 않는다.

## 참고 문서

- [React Flow API reference](https://reactflow.dev/api-reference/react-flow): UI는 확정 데이터의 시각화에 사용하며, 이 초안 화면에서는 사용자 직접 편집을 제공하지 않는다.
- [Node.js test runner](https://nodejs.org/api/test.html): Node 기반 자동 검증 실행의 공식 문서.
- [v15 통합 설계](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md) 및 [UI 적용 기준](../design/03_UI/UI-IMPLEMENTATION-CONTRACT-2026-11-01.md).
