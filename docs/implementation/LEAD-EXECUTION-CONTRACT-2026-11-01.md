# Lead 실행 계약 조사 (2026-11-01)

## 결론

Builder가 실제 Lead 채팅을 하려면 새 AI 실행 서버나 Builder 소유 프로세스를 만들 필요가 없다. 이미 선택된 Workspace Agent의 기존 SPS Agent Session 실행 경로를 재사용하고, 현재 비어 있는 Workspace Host 경로와 최종 응답 회수 계약만 보완하는 것이 최소 변경이다.

이 문서는 조사 결과와 미승인 제안이다. 어떤 제안 API도 현재 구현되어 있거나 승인되었다고 뜻하지 않는다. 실제 AI/CLI 실행은 이 조사에서 테스트하지 않았다.

검토 기준: Builder `28d29ce`, 공개 SDK `61a929f`, 비공개 Core `431e2e67`.
2026-11-01의 Source 경로 별칭 수정은 이 조사 대상의 세션 구현을 변경하지 않았다.

## v15 제품 계약 유지

- Lead에는 `main`, `cto-inbox`, `decisions` 세 세션이 있고, 세 세션은 같은 프로젝트 Lead 기억을 공유한다.
- CTO는 단일 CLI 세션, Worker와 QA는 각자 독립 세션이다. 다른 CTO/Worker의 기억은 자동 공유하지 않는다.
- Document Worker는 현재 범위에 없다. Runner 실행·상태는 GitHub Actions + Self-hosted Runner의 영역이지 Core Node 실행기가 아니다.
- Lead가 선택한 기존 Workspace Agent를 사용한다. 선택/설정은 실행·인증·준비 상태의 증명이 아니다.

근거: `docs/design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md`의 v12/v14 결정, 역할표 및 `AC-113`; `docs/implementation/PLAN-2026-11-01.md`의 AI 연결 단계.

## 실제 Builder / SDK 계약

| 위치 | 현재 동작 |
| --- | --- |
| `src/domain/model.ts:BuilderSnapshot` | 세 채널의 `leadSessions`와 메시지/실행 식별자 자리는 있으나 실행 결과 계약은 없다. |
| `src/platform.ts:createBuilderPlatform` | 현재 권한은 `plugin.state.read/write`, `agents.read`; 데이터 조회와 상담 가져오기·Agent 선택 액션만 등록한다. 실행 세션 호출은 없다. |
| `src/platform.ts:selectLeadAgent` | Workspace Agent ID만 `lead-agent.v1`에 저장한다. 세션을 만들거나 AI를 실행하지 않는다. |
| `node_modules/@sonparkserver/plugin-sdk/platform/index.d.ts:SpsAgentSessionClient` | 공개 SDK 타입에 `sessions.create/list/sendMessage/getRun/cancel`이 있다. `sendMessage`는 `{ runId }`, `getRun`은 상태·취소·오류·실행 관찰값을 반환하며 최종 응답 필드는 없다. 타입상 존재가 모든 Host 경로의 런타임 지원을 보장하지 않는다. |
| `node_modules/@sonparkserver/plugin-sdk/runtime/index.d.ts:PluginSpsModelRun` | 별도 `sps.models` 실행은 텍스트 결과를 제공하는 일반 모델 연결 API다. Builder가 선택한 Agent의 CLI/session 메모리를 실행하는 계약은 아니다. |

따라서 `sps.models.submit`으로 Agent Session을 대체하면 선택된 Agent·CLI 실행 의미와 세션 기억을 우회한다. `sps.artifacts.publish/list`는 파일 증거용이지 채팅 응답의 기본 저장소가 아니다.

## 실제 Core Host 지원 경계

| 위치 | 확인 사항 |
| --- | --- |
| `server/src/services/sps-workspace-plugin-host.ts:METHODS` | Workspace Worker allowlist에는 `agents.list`는 있지만 `agents.sessions.*`는 없다. `sps.models.*`는 별도로 허용되어 있다. |
| `server/src/services/sps-workspace-plugin-workers.ts:ensure` | 기본 Workspace 서비스는 `buildHostServices(..., undefined, ...)`로 만들어 세션 event용 `notifyWorker`를 주입하지 않는다. |
| `server/src/services/plugin-host-services.ts:agentSessions` | 일반 Host에 세션 생성·목록·전송·조회·취소 구현이 이미 있다. `sendMessage`는 run을 dispatch하고 알림 구독을 붙인다. 성공 종료 때 내부 조회한 `resultJson`을 이벤트 payload에 포함하려 한다. |
| `server/src/services/plugin-worker-manager.ts:notify` | `ownerWorkspaceId`가 있는 Worker에는 notify가 즉시 무시된다. 일반 Agent Session의 비동기 이벤트를 Workspace Worker로 전달할 수 없다. Workspace Worker 호출은 Host가 만든 Workspace 권한 아래 `getData/performAction`으로 제한된다. |
| `server/src/services/sps-agent-session-runs.ts:spsAgentSessionRunService` | `getRun/cancel`은 company, plugin 소유 session, run·conversation 연계를 검증한다. 반환 snapshot은 status/cancellation/error/execution 메타데이터이며 `heartbeatRuns.resultJson`은 노출하지 않는다. |
| `packages/db/src/schema/agent_task_sessions.ts` | 사용자 없는 세션에 `(company, agent, adapter, taskKey)` 부분 unique 제약이 이미 있다. 현재 생성 코드는 insert이므로 같은 key 재시도를 기존 세션으로 반환하는 동작은 아니다. |
| `packages/db/src/schema/agent_wakeup_requests.ts` 및 `server/src/services/heartbeat.ts:enqueueWakeup` | `idempotencyKey` 필드와 기존 wakeup 경로가 있지만 해당 필드의 DB unique 보장이나 Plugin 전송의 내구성 중복 제거를 뜻하지 않는다. 단순 key 전달만으로 정확히 한 번 실행을 주장하면 안 된다. |

고정 SDK의 capability 이름과 Core manifest validator도 함께 맞춰야 한다. Workspace 전용 경로에서 실제 확인된 `agents.list` 지원(Builder 계획의 기존 Host 연결 기록)과 일반 Host용 session SDK 타입을 혼동하지 않는다.

## 최소 미승인 API 제안

기존 SDK 표면을 확장하되, 새 Builder AI 서버·범용 큐·별도 Node 실행기를 추가하지 않는다.

1. **Workspace session 권한**: 공개 SDK에 이미 있는 `agent.sessions.create/list/send/read/cancel` capability와 일반 Host 구현을 재사용한다. 단순 allowlist 추가에 앞서 Workspace별 실행 권한·종료·응답 경로까지 확인하고 같은 계약을 연결한다. 모든 호출은 신뢰 invocation에서 받은 `companyId`로 고정하고, Agent가 같은 Workspace에 속하는지와 `plugin:<pluginKey>:session:` 소유권을 매번 확인한다. 생성 시 호출자 taskKey가 다른 Plugin의 prefix나 비소유 세션을 만들지 못하도록 검증해야 한다. 임의 company/session/run ID로 범위를 바꾸지 못하게 한다.
2. **세션 준비의 재시도 안전성**: 각 Lead 채널마다 안정된 session `taskKey`를 사용해 생성 응답을 잃어도 동일 세션을 다시 찾도록 한다. `list` 또는 좁은 `ensure` 연산으로 복구한다. 중복 세션 생성을 막는 DB 제약/트랜잭션 성질은 구현 전 실제 schema를 확인하고 테스트한다.
3. **전송 멱등성**: `sendMessage` 입력에 호출자 생성 `requestId`를 추가한다. Core가 `(plugin, session, requestId)`와 dispatch 결과 `runId`를 내구성 있게 연결해, 응답 유실 후 같은 요청 재시도는 기존 run을 반환하고 새 실행을 만들지 않게 한다. 현재 SDK send에 이 키가 없으므로 단순 Builder 메모리 dedupe로 대체하지 않는다.
4. **소유 세션의 bounded 응답 회수**: `getRun`의 기존 검증을 거친 결과에 명시적 `resultState: available | not_ready | withheld`와 크기 제한 JSON-safe `result`(또는 기존 결과의 허용된 텍스트 추출)를 추가하는 방향을 검토한다. 원본 `resultJson` 전체, 다른 Agent/Workspace 데이터, Secret, 임의 파일 경로는 노출하지 않는다. Core가 안전하게 정규화할 수 없다면 결과 전용의 소유권 검사 API를 추가하되 새로운 저장소는 만들지 않는다.
5. **상태 복구**: Worker는 전송 전 요청 식별자·세션·미확정 상태를 영속 기록하고, dispatch 응답의 `runId`를 확인한 뒤 저장한다. 응답을 잃으면 run ID가 있다고 가정하지 말고 같은 요청의 기존 실행을 조회한다. 이후 `getRun`으로 완료/실패/취소와 결과를 회수한다. 이벤트/알림은 빠른 갱신에만 사용하고, 알림 유실을 최종 상태의 유일한 원본으로 삼지 않는다. 기존 SDK의 알림 callback은 현재 Workspace의 유효한 Host invocation을 자동 생성하지 않으므로 callback에서 상태 저장 권한이 생긴다고 가정하지 않는다.

위 API 이름·응답 shape는 제안일 뿐이다. 결과 노출 권한·크기/페이지·SDK 호환성은 구현 전에 검토·확정한다. 기존 사용자 권한이나 배포 정책을 바꾸는 결정이 필요하면 사용자에게 질문하고, 내부 기술 세부사항은 확정된 제품·보안 경계 안에서 구현한다.

## 생명주기 / 안전 조건

- Workspace 데이터의 단일 작성 소유자는 계속 전용 Workspace Worker다. 대화 응답·run ID도 Workspace별 snapshot에 저장하고 기존 직렬화/검증을 재사용한다. 현재 단일 Worker 직렬화는 프로세스 간 DB 트랜잭션이나 영속 큐가 아니다.
- Send 응답을 받기 전에 Worker/Host/UI가 꺼질 수 있다. 안정된 `requestId`와 Core 내구성 dedupe가 없으면 자동 재전송 금지(중복 과금/실행 위험); UI에는 결과 불명 상태를 보여주고 같은 키로 조회/재시도한다.
- Host 재시작·Workspace 비활성화·Worker 재시작 뒤에도 session/run ID로 재조회한다. 기억은 Worker 메모리만이 아니라 같은 Workspace의 승인된 Lead 문맥과 기존 Agent Session에 둔다. 다른 Workspace 데이터나 자격증명은 전달하지 않는다.
- 취소는 같은 소유권 경계를 사용하고 Core의 실제 취소 종료 확인을 따른다. `cancellationRequested`를 종료 완료로 간주하지 않는다. 기존 SDK의 `termination: pending/confirmed`를 보존한다.
- 실행 전 Agent 상태/설정 목록은 준비 보증이 아니다. 기존 `describeExecution`의 `readiness: unknown`, `authorization: recheck_on_dispatch` 같은 상태 의미를 과장하지 말고 dispatch 실패를 사용자에게 그대로 표시한다.
- v15의 세 Lead 세션 공통 기억은 SDK가 자동 공유한다고 가정하지 않는다. Builder가 같은 Workspace의 승인된 Lead 문맥(요구사항/결정/문서 Revision 등)만 제한된 입력으로 구성해 각 채널에 전달해야 한다. 고객 상담 원문 전체를 매번 무제한으로 복제하지 말고, 선택한 기존 Agent 외부의 대화나 다른 Workspace 데이터는 넣지 않는다.
- 채팅 메시지·결과는 제한된 크기와 스키마를 검증한다. 큰 대화의 pagination은 현재 초기 snapshot의 192 KiB 경계와 별도 후속 과제로 둔다.

## 구현 순서와 검증

1. **Core/SDK 계약 결정**: session capability, Workspace dispatcher, 멱등 키, 소유 결과 회수 방식과 최대 결과 크기를 승인한다. Core/SDK를 함께 수정하며 Builder 파일은 충돌 피해서 이후 반영한다.
2. **Core/SDK 테스트**: 허용 capability/manifest 검증, 올바른 Workspace invocation, 교차 Workspace Agent/session/run 거부, plugin session 소유권 거부, 동일 requestId 동시·후속 호출의 단일 run, 다른 키는 별도 run, result 미완료/완료/초과 크기/오류, 취소 후 종료 확인을 테스트한다.
3. **Builder domain/UI wiring**: 기존 `BuilderSnapshot.leadSessions`, `messages`, `runId`를 사용한다. channel별 세션 생성/복구, 사용자 메시지 저장, 멱등 dispatch, 상태 조회, 결과 저장, UI pending/error/cancel을 작은 액션으로 연결한다. 승인 문맥 생성은 Lead가 담당하며 Document Worker를 넣지 않는다.
4. **Builder 회귀·실행 검사**: 기존 SDK validate/test 및 Worker lifecycle에 A/B Workspace 분리, Host·Worker 재시작 후 복구, 응답 유실 모의, 중복 제출, cancel/late result 경쟁, 결과 크기/형식, 선택 Agent의 Workspace 소속을 추가한다. 먼저 가짜 Host 계약으로 결정성을 확인하고, 이후 승인된 시험 Agent에서만 실제 AI 한 번을 검증한다.
5. **보고**: 코드 검사/가짜 Host/실제 Host/실제 AI를 별개의 증거로 기록한다. AI를 실제 실행하지 않았다면 완료 또는 실연동이라고 쓰지 않는다.

GitHub Actions/Runner 연결, CTO 생성, Worker/QA 위임, Graph patch, 질문 답변의 설계 Revision 반영은 이 Lead 채팅 계약의 일부가 아니며 순서상 후속이다.

## 공식 런타임 참고

- Node.js [Child process](https://nodejs.org/api/child_process.html): 실제 프로세스가 있는 경우 부모가 자식 lifecycle event를 관찰하는 공식 계약. 이번 제안은 Builder 자체 child process를 추가하지 않는다.
- Electron [IPC tutorial](https://www.electronjs.org/docs/latest/tutorial/ipc) 및 [Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation): IPC를 넓게 노출하지 않고 좁은 API를 내놓는 원칙 참고. SPS Plugin Worker 계약은 Electron IPC가 아니므로 이 문서를 SPS API 명세처럼 취급하지 않는다.

## 도메인 회귀 커버리지 메모

`test/domain.test.ts`의 snapshot 검증 회귀 테스트는 Lead 세션 배정이 비어 있거나 일부만 지정된 경우 및 세 채널 모두 지정된 경우를 허용한다. 계획 단계 actor의 `agentId`/`sessionId`는 null일 수 있으며, Lead 채널과 actor 전체에서 null이 아닌 세션 ID의 중복은 거부한다. 이는 저장 데이터의 parser 검증 범위일 뿐, 세션 생성·실제 AI 실행 또는 세 Lead 세션 간 공통 기억 구현의 완료를 뜻하지 않는다.

## 검증하지 않은 것

이번 작업은 Builder/Core/고정 SDK 소스 계약 조사다. 실제 AI 모델 호출, Codex CLI 로그인/권한, Core 운영 설치본, 응답 내용·품질, 비용, 승인된 Agent의 취소·재시작 동작은 실행하지 않았으며 보증하지 않는다.
