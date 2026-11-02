# Codex 네이티브 Worker 후속 검증 상태

기준일: 2026-11-02

## 현재 판정

목표는 사용자가 Lead에게 매번 "계속해"라고 말하지 않아도 CTO가 배정된 Workstream을 진행하는 것이다. Lead는 요구사항·범위·인수 기준을 정해 CTO에 배정하고, CTO는 이를 낮추지 않으면서 자신의 Worker/QA Task Packet으로 세분화한다. 한 번의 모델 turn이 끝나는 것과 CTO 업무가 끝나는 것은 다르다. 장기 목표는 영구 실행 프로세스가 아니라 저장된 CTO 목표와 작업 상태, 다음 이벤트에 따른 재개다.

**현재 공개 Builder에서 입증된 범위는 Task Packet 계획 도구까지다. 네이티브 Worker 생성·작업·QA, 자동 CTO 재개, 장기 업무 완료는 아직 입증되지 않았다.** 기존 [Task Packet 구현 기록](CTO-TASK-PACKETS-2026-11-02.md)은 계획 기록을 실제 Worker 실행이나 완료로 취급하지 않는다.

## 증거 구분

| 항목 | 현재 확인 내용 | 판정 |
| --- | --- | --- |
| Codex 버전 | 로컬 조사 대상은 Codex CLI `0.144.1`이다. Builder의 [SDK 고정](../../package.json)은 변경하지 않았다. | 버전 범위가 정해진 조사이며 전체 호환성 인증은 아님 |
| App Server 연결 | 실제 격리·무계정 App Server에서 `initialize`와 `thread/list` 요청을 보냈고 고정된 시험용 부모 ID의 `parentThreadId` 필터가 받아들여졌다. 실제 부모나 자식 항목을 만들지는 않았고 정상 종료 코드 0을 확인했다. | 전송·초기화·빈 목록 필터 확인 |
| 실제 자식 작업 | 위 조사에서 자식 thread 0개, turn 0개였다. 모델/provider 작업을 실행하지 않았다. | **네이티브 Worker 실증 아님** |
| 공개 Builder | `builder.read-task-packets`와 `builder.publish-task-packet`은 현재 CTO의 계획 문서를 읽고 저장한다. 생성 코드 실행, Worker 생성, QA 실행, 자동 continuation은 연결되지 않았다. | 계획 전용 |
| 비공개 Core 진행 | 읽기 전용 JSONL transport와 직접 자식 metadata 검증 helper가 추가됐다. 어댑터 소스 테스트 182/182 및 어댑터 타입 검사 통과를 총괄이 재확인했다. 새 transport/metadata 검사는 42개다. | 내부 조회 기반 구현·자동 검사. 실행 엔진 활성화, 실제 자식 생성, 권한 격리, UI 통합 완료는 아님 |

App Server에서 부모 ID 필터가 받아들여졌다는 사실만으로 자식 Agent가 생성됐거나, 그 thread가 지정된 CTO의 실제 직접 자식이거나, 독립 권한을 가졌다고 결론내리지 않는다. `parentThreadId`는 공식 App Server 문서에서도 실험적 API로 안내된다. 공식 Codex 자료는 네이티브 하위 에이전트와 thread 조회 기능의 가능성을 설명하지만, 이 Builder의 실행·권한·복구 경로를 대신 검증하지 않는다.

## 권한 경계

현재 CLI 실행 보호는 네이티브 multi-agent 실행을 의도적으로 비활성화한다. 자식 Agent가 부모와 같은 MCP 도구, 인증 문맥 또는 실행 권한을 물려받을 수 있는 경계를 조사하지 않고 이 보호만 해제해서는 안 된다. 공식 Codex 문서도 subagent가 부모의 sandbox 정책을 상속한다고 설명한다. 이는 SPS Workspace 경계나 Task Packet별 도구 권한이 자동 분리된다는 보증이 아니다.

실행을 연결하기 전에는 신뢰할 수 있는 직접 자식 식별 정보를 확보하고, 자식 thread ID를 정확한 Workspace·CTO·Task Packet ID와 revision에 묶어야 한다. Worker는 해당 Task Packet과 명시적으로 허용된 자료만 받아야 한다. CTO의 비공개 기억을 자동 fork하거나 부모의 넓은 도구 권한을 그대로 물려받지 않도록 별도 권한 필터를 검증한다. 현재처럼 실행이 미연결된 동안 생성된 코드의 자동 실행·Runner 전달은 계속 차단한다.

## 다음 검증 게이트

1. **Native child 생성:** Codex `0.144.1`의 실제 App Server 경로에서 CTO가 네이티브 child를 생성하는 turn을 확인한다. 직접 자식 metadata와 thread ID를 신뢰 경계 안에서 확인하고, 부모/다른 CTO/다른 Workspace의 thread가 섞이지 않는 음성 사례도 검증한다.
2. **Worker 권한과 입력:** 실제 child가 독립된 실행 기록을 갖고 정확한 Task Packet revision만 받는지 확인한다. 부모 MCP 권한, 자격 증명, 대화·CTO 기억이 의도치 않게 상속되지 않는지 확인한다. 기존 CLI의 multi-agent 보호는 이 검증 전까지 유지한다.
3. **CTO 장기 목표와 재개:** 설치된 CLI의 생성 스키마에는 `thread/goal/set`, `get`, `clear`가 있고 공식 문서에도 TUI와 같은 영속 목표 상태로 설명돼 있다. 이 기존 기능의 실제 저장·자동 재개·중지·한도·재시작 동작을 먼저 검증한다. 스키마에 있다는 사실만으로 자동 진행을 주장하지 않는다. 같은 논리 CTO의 목표와 진행 상태를 보존하되 별도 분산 scheduler나 자체 Agent framework를 추가하지 않는다.
4. **중복·순서·종료:** child 요청·응답 유실, 중복 및 역순 이벤트, 중복/지연 `getRun` 조회, 실패·취소·명시적 중지를 다룬다. 현재 Task Packet revision과 직접 연계해 불확실한 요청을 자동 재전송하거나 이전 결과를 새 revision의 성공으로 승격하지 않는다.
5. **실행 호스트:** 현재 확인된 범위만으로는 `WorkspaceJobs`에서 Workspace Worker를 직접 실행할 수 없다. 기존 Core의 허용된 실행 경로가 실제로 지원되는지 확인한다. 확인 전 별도 실행기를 만들거나 `WorkspaceJobs` 지원을 가정하지 않는다.
6. **인수 증거:** CTO가 Worker 결과를 검토하고 실패를 수정하며 독립 QA/TestPlan과 외부 실행 근거를 연결한다. 기술 명령이 성공한 사실만으로 Workstream 인수나 고객 납품을 완료 처리하지 않는다.

이 게이트를 실제 지원 Host/provider에서 확인하기 전까지 Native Worker는 설계 목표이자 미검증 기능이다. 현재 확인 작업은 문서·프로토콜 점검이며, 실제 AI 작업이나 Worker turn을 실행하지 않았다. Marketplace, Preview 및 새 Native LAN 범위는 이번 작업으로 열지 않는다.

## 공식 참고 자료

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): thread 시작·재개·조회, 영속 목표 상태, turn 이벤트 및 experimental `parentThreadId` 필터의 계약. 프로토콜이 지원된다는 사실은 Builder 통합 완료 증거가 아니다.
- [Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): 네이티브 subagent 흐름과 부모 sandbox 정책 상속에 관한 안내. SPS 도구 권한·Workspace 데이터 분리가 보장된다고 해석하지 않는다.

## 상태 기록 원칙

이 문서는 현재 조사 사실과 다음 검증 게이트를 정리한 기록이다. 위 숫자는 해당 Core 어댑터 소스 검사에 한정하며 전체 Core나 Builder 검증 수가 아니다. Builder의 기존 449개 검사와 실제 앱 근거는 이전 작업의 기록이며 이번 문서 변경으로 재실행한 것으로 표현하지 않는다. 첫 광범위 검사에는 생성된 dist 검사까지 포함돼 Windows 경로·종료 신호 가정 두 건이 중복 실패했다. 해당 테스트를 실제 플랫폼 동작과 PID 종료 확인으로 수정한 뒤 소스 검사만 재실행한 결과가 182/182다. 실제 AI/앱/실기기 검증, AC 완료나 릴리스 자격을 주장하지 않는다. 비공개 Core 코드, 내부 경로, 인증정보와 사용자 데이터는 공개 Builder 문서에 복사하지 않는다.
