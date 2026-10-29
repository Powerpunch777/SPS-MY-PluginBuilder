# Builder를 위한 SPS Core 선행사항 — 2026-10-29

## 결론과 범위

이번 코드 검토에서는 Builder를 시작하기 위해 반드시 새로 구현해야 하는 Core 전용 기능을 확인하지 못했다. Workspace, 플러그인 활성화, Shell 선택, scoped state, Agent 실행 등의 기존 기반을 먼저 재사용할 수 있다.

다만 Core 완성·배포를 선언하기 전에는 기존 보안 gate, 최신 변경의 검증 공백, 원격 실행 복구의 미완료 부분을 해결하거나 실제 운영 제한으로 명시해야 한다. 이 문서는 이 세 가지와 Builder 연동 전에 확인할 공통 경계를 구분한다. Builder의 Graph·역할·기억·GitHub UI를 Core의 선행 개발로 확대하지 않는다.

이번 요청에서는 문서 보관과 읽기 전용 확인만 했다. Core 코드 수정, 기존 Core 커밋 push, 테스트·CI 실행 및 Builder 제품 구현은 하지 않았다. 사용자 요청에 따른 Core 개발 중지 상태를 유지했다.

## 확인 기준과 증거의 한계

| 구분 | 기준 |
| --- | --- |
| 로컬 Source | `73d5c09e293f9cdb31318ab7f18dca5022e04803` |
| 로컬 Core | `40199c6e55e956c31381e2377860baa78bc7cabb` |
| SDK | `61a929f6c783f78e5af603682de1543c7e24abc0` |
| 마지막 기록된 원격 검증 Source | `45ac567603f4ef195371acc8f20a7b99cb32b131` |
| 마지막 기록된 원격 검증 Core | `4d0b587b56ec794c490b710d734c15ac7e310b2b` |

Source/Core 로컬 작업 트리는 깨끗했다. 원격 CI 상태는 기존 중지 체크포인트와 로그를 근거로 하며, 이번 요청에서 새 CI를 실행하거나 원격 Core 상태를 갱신하지 않았다. 로컬 최신 변경에 이전 원격 CI 결과를 적용하지 않는다.

핵심 기록은 `SPS-CHECKPOINT-2026-10-29-PAUSE-NODE-CLOSURE.md`다. 아래 Core 코드 경로는 위 Source checkout을 기준으로 하며, 이 Builder 저장소에 Core 소스를 복사한 것은 아니다.

## Core 완성·안정 운영을 위해 먼저 정리할 사항

### 1. 기존 의존성 보안 gate 해소 — 확인된 출시 차단 항목

마지막 기록된 CI run `40794257537` 및 `40794265220`은 production dependency security gate 때문에 실패했다. 당시 Linux 타입·빌드·9개 테스트 shard와 Windows Desktop job은 통과했지만 전체 CI 성공은 아니다.

보안 로그에는 Zod advisory `1243066`이 high로 기록되어 있고, 승인된 예외 없이 gate가 실패했다. 그 이후 해결됐다는 근거는 확인하지 못했다. 신규 Builder 기능으로 우회하거나 검사를 삭제하지 않는다. 재개 시 실제 의존 경로와 호환성을 확인해 수정하고, 영향받는 범위와 보안 gate로 해결을 검증해야 한다. 특정 라이브러리 버전을 이 문서에서 임의로 지정하지 않는다.

근거: `sps-production-auth-security-audit-2026-10-28.log`, 위 중지 체크포인트의 원격 CI 결과.

### 2. 최신 종료·완료 보고 수정의 동일 버전 검증 — 검증 공백

로컬 Core는 원격 Node의 늦은 완료 보고, 서명된 결과 보존, 자식 작업 전체의 종료 증거 확인, Workspace 정리 및 Agent 세션의 종료 확인을 보완했다. 해당 변경은 로컬 선별 서비스·실제 PostgreSQL·타입 검증 근거가 있다.

기록된 최종 근거는 Core focused service 19 PASS, 실제 PostgreSQL 선택 검사 3 PASS / 35 unselected, Source outbox/Main 25 PASS 및 final typecheck exit 0이다. 이는 서로 범위가 다르므로 전체 테스트 통과 수로 합산하지 않는다.

이 변경을 포함한 최신 로컬 Source/Core 조합의 원격 Windows CI 결과는 아직 없다. Core 개발 재개 시 호환 조합을 고정하고, 변경된 종료·재시작·완료 보고 및 Windows 관련 필수 경로를 검증해야 한다. 전체 검사를 반복 실행하는 것을 기본 작업으로 삼지 않는다.

Windows 임시 파일 정리의 간헐 실패도 완전히 제거됐다고 확인되지 않았다. 살아 있거나 상태를 알 수 없는 프로세스는 종료 성공으로 표시하지 않는 현재 원칙을 유지한다.

근거: `terminal-node-closure-postgres-verified.log`, `terminal-node-closure-types-verified.log`, `terminal-node-report-desktop-final.log`, 위 중지 체크포인트.

### 3. 원격 작업 수령 응답 유실 복구 — 무인 원격 실행의 미완료 기능

Node가 작업을 수령했으나 응답을 잃거나 그 사이 프로세스가 종료되면, 수령 상태만 남고 실행 여부를 확정하지 못할 수 있다. 현재는 불확실한 작업을 임의 재실행하지 않는 보수적인 동작이며 자동 복구는 완성되지 않았다.

같은 요청에 같은 결과를 돌려주는 영속 receipt, 빈 수령 결과인 HTTP 204의 기록, 실행 진입 전 로컬 영속 기록과 재시작 시 대조 규칙이 아직 없다. 이를 설계할 때 다른 작업을 새로 가져오는 문제와 이미 실행했을 수 있는 작업을 중복 실행하는 문제를 모두 막아야 한다.

Builder의 기본 화면·로컬 작업 시작을 막는 조건은 아니다. 그러나 신뢰할 수 있는 무인 원격 실행·중단 복구를 완성했다고 선언하려면 해결해야 한다. 경과 시간만으로 재대기열에 넣거나 불확실한 실행을 종료 처리하지 않는다.

완료 보고 outbox는 최종 결과를 보존하지만 모든 스트리밍 출력의 영속화를 제공하지는 않는다. 전체 출력 이력 영속화는 별도 요구사항으로 구분하고, 출력 전송 실패 때문에 이미 확인된 최종 완료 결과를 보류하는 회귀를 만들지 않는다.

근거: 위 중지 체크포인트의 claim-response recovery 및 completion outbox 한계 기록.

## Builder를 연결하기 전에 확인할 기존 Core 계약

이 항목들은 먼저 검증할 경계이며, 미구현으로 확정한 Core 신규 기능 목록은 아니다.

| 영역 | 이미 있는 기반 | 필요한 연결 확인 |
| --- | --- | --- |
| Workspace | 회사/Workspace별 활성화·설정, 선언된 workspaceWorker | 한 Builder 패키지를 두 Workspace에서 사용할 때 데이터·권한·실행·중지·재시작 범위가 분리되는지 확인 |
| 기본 화면 | Workspace Shell provider 선택과 중립 fallback | 활성화와 기본 화면 선택을 구분하고 기존 Shell을 임의 교체하지 않기 |
| 권한·Secret·파일 | Workspace 고정 Host 호출, capability/grant 검사, 비밀이 아닌 설정 JSON, Node share/grant | 선택 계정과 Workspace 권한을 연결하고 토큰을 설정·대화·로그로 노출하지 않기; 부족한 공통 API만 Core 보완 후보 |
| Agent 실행 | SDK 세션 생성·메시지·상태·취소 및 기존 Codex adapter | 세션 정체성, 출력/이력, 취소·종료 확인, 앱 재시작 후 재연결을 필요한 제품 범위로 검증 |
| 호환 조합 | Core·SDK·Source 버전 및 로컬 candidate 기록 | 특정 검증 조합을 고정하고 이전 조합의 통과 결과를 최신 조합의 근거로 사용하지 않기 |

실제 코드 근거:

- `external/sps-core/server/src/services/sps-workspace-plugin-workers.ts:73`
- `external/sps-core/server/src/services/sps-workspace-surfaces.ts:186`
- `external/sps-core/server/src/routes/sps-workspace-surfaces.ts:58`
- `external/sps-core/server/src/routes/sps-workspace-plugin-config.ts:21`
- `external/sps-core/server/src/services/sps-workspace-plugin-host.ts:40`
- `external/sps-core/server/src/services/sps-node-execution.ts:95`
- `external/sps-plugin-sdk/platform/index.d.ts:11`
- `external/sps-core/packages/adapters/codex-local/src/server/execute.ts:741`

## Core 선행 개발로 만들지 않을 항목

### 공유 기억과 변경 충돌

Core state의 `set`은 upsert이며 조건부 쓰기/CAS는 없다. 따라서 여러 세션이 직접 같은 상태를 읽고 덮어쓰면 충돌할 수 있다. 그러나 CAS를 무조건 Core 선행조건으로 추가할 필요는 없다.

Builder에서 Workspace별 변경을 하나의 작성자로 모아 순서대로 처리하는 방법을 먼저 검토한다. 불변 Revision, 중복 요청, 현재 Revision 포인터, 중단 후 복구 규칙도 함께 정의해야 한다. 단순 메모리 queue만으로 영속 복구가 해결됐다고 주장하지 않는다. 현재 계약으로 필요한 정합성을 충족하지 못하는 것이 확인될 때 공통 조건부 쓰기 기능을 Core 확장 후보로 삼는다.

근거: `external/sps-core/server/src/services/plugin-state-store.ts:120`, `external/sps-plugin-sdk/platform/index.d.ts:11`.

### Builder가 소유할 기능

- Lead·CTO·Worker·QA 조직 및 역할별 실제 액션 권한
- Graph·Spec·질문·승인·고객 기억·요구사항과 Revision
- 프로젝트와 Core Workspace/작업 디렉터리/Git worktree의 매핑
- Codex 역할별 thread 매핑과 제품 화면에 필요한 이력 처리
- GitHub Actions·Checks·Artifacts 및 GitHub Runner 상태 연동
- 상담 자료 가져오기, 인수 근거, 납품 Target과 ReleaseEvidence

Core는 공통 권한·실행·저장 경계를 제공하고 Builder는 제품 정책을 소유한다. 기존 SDK도 Task·Role·Room·Memory·승인 모델을 플러그인 책임으로 둔다. SPS Runner와 GitHub Actions Runner는 같은 개념으로 합치지 않는다.

근거: `external/sps-plugin-sdk/README.md:92`, `external/sps-core/server/src/routes/sps-nodes.ts:1220`.

### 이번 선행 범위에서 제외

Native 신규 개발, 공개 Marketplace, 완전한 비신뢰 코드 OS 샌드박스, 자체 CI/Runner Fleet 및 별도 범용 Agent 프레임워크를 선행조건으로 되돌리지 않는다. Tailscale/SSH 방향과 기존 보안 기능은 유지한다. 프로세스 소유권·Windows Job을 파일·네트워크 보안 샌드박스로 표현하지 않는다.

라이선스 차이는 사용자에게 설명했고 허용받았으므로 Builder 설계 채택의 미결정 차단 항목으로 남기지 않는다. 개별 구성요소의 라이선스 고지는 유지한다.
