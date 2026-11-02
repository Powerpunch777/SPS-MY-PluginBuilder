# Builder v15 Full Completion Plan

## 최신 목표와 현재 작업 범위 (2026-11-02)

### 프로젝트 CTO 등록 후속 기록

Builder `8e9ee89`의 [프로젝트 CTO 등록·단일 세션·실제 앱 검증](PROJECT-CTO-REGISTRATION-2026-11-02.md)을
추가했다. 실제 Lead가 논리 CTO2명과 독립 Core 세션을 만들고 같은 ID 재등록·조직도·
재시작 보존을 확인했다. 후속 전체225/225가 통과했고 CTO 자체의 AI 실행은0회다.
Workstream 배정·질문 intake·전용 기억·Worker/QA 실행과 전체 v15는 계속 미완료다.

### 질문 답변 Revision 후속 기록

Builder `0ec7b5e`의 [질문 답변 Revision 구현·검증](LEAD-QUESTION-REVISION-2026-11-02.md)을
추가했다. 실제 UI 답변→decisions Lead→새 명세/Graph와 해석 저장→재시작 보존을 확인했다.
후속 UI 수정은 별도 no-AI 앱 시험과 전체202/202로 검증했다. 공유 기억/CTO 전파·승인 명세
승격·전체 AC-05 및 Builder 완료는 아니며 아래 초기 기준선 체크를 일괄 통과 처리하지 않는다.

### 최신 목표

최신 목표는 이 저장소의 v15 통합 설계, UI v9, 최신 UI 적용 기준을 따르는 실제 Builder를 완성하는 것이다. 화면 시제품만으로 완료 처리하지 않는다. 안전한 진행에 꼭 필요한 Core 선행 사항이 있으면 그것부터 확인·해결한다. Core 문서와 기술상 핵심 경로는 별도 담당 범위이며, 이 계획은 Builder를 다시 설계하거나 줄이지 않는다.

이번 재개는 Builder 목표를 다시 진행하는 승인이지, Core 전체 완성이나 Stable 선행 범위 확대의 승인이 아니다. 현재 문서 갱신 범위는 이 계획서와 Core–Plugin 정렬 문서 두 개다. 이 문서 수정만으로 Builder 구현, 전체 AC 통과, 실제 AI 실행 또는 제품 완료를 주장하지 않는다.

### 우선 보류

Marketplace, 자체 LAN 개발, Preview 기능 개발 및 Preview를 포함한 추가 시험은 보류한다. Preview 관련 부분은 아래 AC-10, AC-25, AC-66에서 현재 작업 범위에 넣지 않으며 완료로 보지 않는다. 이는 해당 AC 전체를 버리거나 나머지 요구를 제외한다는 뜻이 아니다. Preview와 무관한 요구를 포함해 AC-01~118은 모두 보존하며, 보류 범위 밖의 항목을 포기하거나 완료 처리하지 않는다.

- AC-10: 순수 SPS 플러그인의 Preview 부분만 보류·미완료·이번 범위 제외다. AI 없이 빌드하고 전달하는 나머지 요구는 유지한다.
- AC-25: 실제 Plugin Preview 통과 부분만 보류·미완료·이번 범위 제외다. 현재 Core/SDK 계약 호환 및 전달 차단 등 나머지 요구는 유지한다.
- AC-66: Preview 격리와 iPad 팝업 차단 복구 부분은 보류·미완료·이번 범위 제외다. AC 자체를 삭제하거나 통과 처리하지 않는다.

이 보류 표시는 현재 작업 순서를 정하기 위한 것이며, 원래 AC 문구·ID나 과거 기록을 고쳐 쓰지 않는다. 보류 해제와 시험 재개는 별도 사용자 결정이 필요하다.

## 원래 계획과 기준

Date: 2026-11-02
Status: initial source baseline plus separately dated progress; no full v15 acceptance item is declared complete by this document.

## Authority and Status

The acceptance criteria below follow the canonical [v15 design](../design/01_Design/SPS_Plugin_Builder_Codex_Final_Design_v15.md), AC-01 through AC-118. UI work must also follow the approved [UI v9 implementation contract](../design/03_UI/UI-IMPLEMENTATION-CONTRACT-2026-11-01.md). The November 2 Core–Plugin alignment in v15 takes precedence over older product assumptions: Builder is an optional, general-purpose plugin; it is not a mandatory Core workflow or Primary. Builder owns its full plugin UI. Core Native Settings and OS-level controls remain independent.

The deliverable is a working Builder workflow, not a UI-only prototype. The initial inspection at Builder `17224a9f` found a workspace-scoped initial snapshot, consultation text persistence, Lead Agent selection, three prepared Lead session IDs and read-only views, without actual AI execution. That is the baseline for the checklist below, not a claim about later code. The separately recorded durable-chat increment now demonstrates one authorized real CLI answer and restart retention; see [its exact evidence and limits](LEAD-DURABLE-CHAT-2026-11-02.md). No Lead-authored complete specification or executable customer deliverable has been accepted. **The Builder is not complete.**

### 2026-11-02 추가 기록: Lead 선택 조건부 저장

[Lead 선택 조건부 저장의 정확한 계약, 개발 Host 검증 결과와 한계](LEAD-CONDITIONAL-STATE-2026-11-02.md)를 추가했다. 선택 저장 경로에 한정된 증거이며 AC-02, 전체 Builder 완료 또는 보류 중인 Marketplace·Preview·Native LAN 범위의 완료를 뜻하지 않는다.

[프로젝트별 Solution Revision 저장 기반](SOLUTION-REVISION-STORAGE-2026-11-02.md)도 추가했다.
충돌·과거 기록·응답 유실을 검사한 내부 모듈이며 아직 Lead 권한 API나 UI에 연결하지 않았다.
AC 상태는 변경하지 않는다.

[명세 Revision 구조 검증](SPECIFICATION-VALIDATION-2026-11-02.md)을 추가했다.
승인 근거 문자열의 존재를 실제 승인으로 오인하지 않으며, 저장·도구·UI 연결은 아직 남아 있다.

[Lead 전용 Solution 조회 도구](LEAD-SOLUTION-READ-TOOL-2026-11-02.md)를 등록했다.
단위/Worker JSONL 검사와 실제 source 앱의 등록·사용자 사칭 거부를 확인했다. 실제 AI의
도구 호출이나 Graph 작성·화면 갱신 완료는 아직 증명하지 않았으며 AC 상태는 유지한다.

[Lead 설계 초안 경로](LEAD-DESIGN-DRAFT-2026-11-02.md)를 추가했다. Lead 전용 출처 읽기,
초안 제안·조회, 구조 검증과 CAS 저널을 구현하고 Node24 전체 159/159 및 SDK CLI
검사를 통과했다. source Host 앱은 mock Identity와 UI 주입 DTO fixture로만 확인했으며,
실제 Lead 도구 호출·Host 초안 저장·승인·실행은 확인하지 않았다. 새 Lead의 자동 handoff도
미완성이다. AC 상태와 전체 완료 판단은 바꾸지 않는다.

The code status labels used below are an initial source inspection, not test results:

- `P` Partial behavior exists, but the full AC is not met.
- `S` Schema, UI, or dependency scaffold exists; the required behavior is not demonstrated.
- `M` No implementation of the required behavior was found in the inspected `src`.
- No label is an acceptance pass. Existing dated test records remain evidence only for their recorded source/runtime. Final status requires fresh evidence tied to an exact source revision and environment.

Do not copy private Core source into this repository. Reuse only the public SDK and verified Host contracts. Use the latest black/neutral-gray UI v9 styling only within Builder. Keep unsupported integrations visibly unavailable; do not invent AI, GitHub, Runner, Preview, or customer-approval states. Avoid building infrastructure already provided by Core or external services.

## Execution Order

Work in dependency order. A phase may proceed in parallel only after its API and data contracts are fixed; merge and acceptance remain gated on the preceding phase's security and contract checks.

1. **Baseline and contracts.** Record exact Builder HEAD, SDK pin, Core compatibility target, current source and historical evidence. Check official SDK and Host contracts before selecting any AI execution path. Define Builder-owned Task, Role, Graph, Question, Revision, Evidence, Run, and Release data without adding Builder product policy to Core.
2. **Workspace data and lifecycle.** Replace the single growing snapshot with bounded, revision-aware records/pages using existing Core storage primitives. Define idempotency, concurrency, restart, pause/stop/resume, retention, export and error semantics. Prove Workspace isolation before adding execution.
3. **UI v9 and input foundation.** Complete the current black/neutral UI against the approved v9 contract; preserve responsive and empty/error states. Complete permitted consultation import, source attribution and normalization. Do not add unauthorized scraping or a Document Worker.
4. **Lead runtime.** Select and verify one supported public SDK/Core execution route. Implement the three Lead sessions, durable request/receipt semantics, send, response persistence, memory sharing without transcript/permission merging, restart recovery and cancellation. Keep send disabled until retry safety and authority checks are proven.
5. **Lead authoring and Graph.** Implement structured requirements, technology decisions, questions, contracts and evidence; Lead-only validated Graph Patch and immutable revisions; cycle/invariant checking; natural-language feedback and revision propagation. Keep React Flow view-only to users and layout-only for ELK.
6. **Project organization and work execution.** Implement project-local CTOs and Workstreams, CTO single-session lifecycle, independent Worker/QA sessions, Task Packets, instructions, bounded concurrency, state transitions and durable history. Enforce role/Workspace authority in the data and execution boundary, not just UI.
7. **Reuse and external execution.** Implement the Reuse-First gates and product/target choices. Integrate verified existing GitHub, Codex and external-provider APIs; create and track Git/PR/Actions work only through supported contracts. Do not build a private Git host, generic CI, Runner fleet, coding runtime or queue.
8. **QA, evidence and delivery.** Add TestPlan/QAResult and real Check/log/artifact evidence; Preview and package compatibility gates; acceptance, release, maintenance and change tracking. A green-looking local UI or mock is not evidence of an external run.
9. **Security and full acceptance.** Verify customer/Workspace isolation, credential and process boundaries, untrusted Runner execution, permissions, data deletion/export and release gates. Execute the full AC suite against exact revisions, actual supported integrations and representative failure/restart scenarios. Only then report the v15 completion status.

### Required evidence convention

For every checked AC, attach the exact source revision, test name/command, environment and result. For external state include the provider's real run/check/runner identifier and source-of-truth response or log, with secrets and customer data redacted. For security boundaries include negative cross-Workspace/role/credential tests, not only successful UI flows. Record unsupported provider/version paths as unavailable. A mock, fixture, static screen, generated status, or old test result cannot substitute for a current integration test. The final completion gate is v15 section 12: end-to-end creation of an executable customer deliverable from an approved specification, with requirement-linked verification evidence and user acceptance.

## AC-01–118 Checklist and Mapping

Status below is the current `src` baseline; remaining work and evidence describe what must be done before checking an item. The criteria are concise restatements of the canonical AC text; use the linked v15 item as the full normative wording.

### 1. Specification and Visualization — AC-01–06

Current implementation: snapshot types contain messages, questions and Graph entities/relations; the Graph is displayed read-only. There is no demonstrated Lead analysis or Graph authoring API.

Remaining execution: implement requirement extraction and approval state, Lead-authorized patch/revision, graph invariants, separate layout from specification, and common IDs across views.

Evidence: AC-level unit/property tests for graph invariants and cycles; Host-backed create/restart/revision tests; role tests proving users cannot patch Graph; UI checks proving canvas movement does not change specification; cross-view ID assertions.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-01 | Derive structured requirements, unresolved questions and exclusions from consultation; distinguish approval state. | S |
| [ ] AC-02 | Only Lead edits Graph/contracts through authorized API; users view/request natural-language changes; restore the same revision after restart. | S |
| [ ] AC-03 | Canvas coordinate/layout changes never mutate approved feature specifications. | P |
| [ ] AC-04 | Reject cycles in development prerequisites while distinguishing runtime data-flow cycles. | M |
| [ ] AC-05 | Lead applies user feedback/answers as sourced, impact-checked, validated Graph Patch and new revision without duplicate design approval; ask again only when ambiguous; keep external acts separately authorized. | M |
| [ ] AC-06 | Product architecture, feature dependencies, development/QA and system views resolve consistent requirement/architecture/development/verification/deployment/Runner IDs; do not require seven tabs. | S |

### 2. Reuse and Delivery Targets — AC-07–11

Current implementation: no Blueprint/reuse search, mode selection, license-aware reuse, or non-SPS delivery implementation was found in `src`.

Remaining execution: add a verifiable reuse-first decision record and separate product size from implementation mode. Support plugin, standalone, web/API, CLI/Python, agent/workflow and hybrid targets without requiring SPS where the design says it is optional.

Evidence: fixtures with reusable and prohibited assets; cross-customer license tests; AC-specific builds and delivery tests for both SPS and non-SPS targets.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-07 | Propose verified Blueprint/code/external-product reuse first and identify only the remaining development gap. | M |
| [ ] AC-08 | Select FAST/ASSEMBLY/CUSTOM independently of S/M/L/XL product classification. | M |
| [ ] AC-09 | Never automatically include customer-licensed or non-reusable assets in another customer's Blueprint. | M |
| [ ] AC-10 | Build, Preview and deliver a pure SPS plugin without requiring AI. | M |
| [ ] AC-11 | Deliver web apps, Python automation and composite Agent products without requiring SPS. | M |

### 3. GitHub, Codex and Runners — AC-12–19

Current implementation: no GitHub, Codex execution, Runner registration/status, DAG, PR, Check, log or artifact integration was found in `src`.

Remaining execution: verify supported provider/API contracts, implement the thinnest adapters over those contracts, map jobs to OS/labels/groups, persist provider IDs and reconcile real state after restart. Isolate untrusted execution and credentials before enabling customer code.

Evidence: live private test repository and registered test Runners; wrong-label/OS and permission-denied tests; real run/PR/Check/log IDs; disconnect/cancel/retry/restart scenarios; negative secret/SSH access tests on the actual Runner boundary.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-12 | Register an existing GitHub Runner and show real API labels, groups and state in Runner view. | M |
| [ ] AC-13 | Never mark work complete on an incompatible OS/label Runner. | M |
| [ ] AC-14 | Respect `needs`: predecessor failure blocks dependents and UI shows the actual state. | M |
| [ ] AC-15 | Link actual Codex result to requirement, Git commit and PR. | M |
| [ ] AC-16 | Represent changed plans with a new Run/approval path; do not claim a running GitHub DAG was edited. | M |
| [ ] AC-17 | Distinguish CI failure, cancellation, disconnection and retry exhaustion from success. | M |
| [ ] AC-18 | Restore latest real GitHub Run/PR/Check state after UI/Builder restart. | M |
| [ ] AC-19 | Test that customer-code Runners cannot access another customer's secrets or operations SSH credentials. | M |

### 4. External Programs and Network Operations — AC-20–24

Current implementation: no Hermes, OpenClaw/OCE, Tailnet or SSH integration was found in `src`.

Remaining execution: feature-detect exact provider/version/API permissions; show verified support boundaries; separate administrative SSH from QA and deployment; preserve distinct failure causes. Do not implement replacement infrastructure or claim undocumented APIs.

Evidence: versioned provider contract tests, denied-scope and unavailable-provider tests, Tailnet device allow/deny tests, separate GitHub/Tailscale/SSH failure fixtures and authorized environment smoke tests.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-20 | Expose only actually supported Hermes/OpenClaw APIs and permissions; state unsupported functions. | M |
| [ ] AC-21 | Show OCE integration as a version-specific verified contract; never imply untested support. | M |
| [ ] AC-22 | Permit SSH only from Tailnet-authorized administrator devices; reject others. | M |
| [ ] AC-23 | Support management without a public SSH port and keep automated deployment Tailnet/SSH authority separately restricted. | M |
| [ ] AC-24 | Distinguish GitHub task, Tailscale connection and SSH deployment failures. | M |

### 5. Core Compatibility, Review and Release — AC-25–32

Current implementation: Builder uses the public SDK and has build/validate/test/package scripts; old records document specific earlier validation. There is no demonstrated end-to-end Preview/release gate, customer acceptance lifecycle or evidence-backed release in current `src`.

Remaining execution: pin and test the current public SDK/Core contract; make compatibility failure block plugin delivery; represent merge, CI, customer acceptance and installation independently; gate release on evidence and produce verifiable package metadata. Keep Core private.

Evidence: fresh SDK build/validate/test/pack on the exact candidate; actual Host Preview compatibility run; forced compatibility/security/acceptance failures that block release; package hash/version/permissions/license/recovery manifest checks; cross-customer data leakage tests.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-25 | Build plugin against current SPS Core/SDK contract and pass actual Plugin Preview. | P |
| [ ] AC-26 | Block SPS plugin delivery while Core compatibility failures remain. | M |
| [ ] AC-27 | Track `PR merged`, `CI passed`, `customer accepted` and `installed` as separate states. | M |
| [ ] AC-28 | Prevent Release until required tests, security, permissions and customer acceptance pass. | M |
| [ ] AC-29 | Include package hash, version, compatibility, permissions, license and recovery guide in Release. | M |
| [ ] AC-30 | Connect existing-customer change requests to new specification revisions, impact analysis and regression tests. | M |
| [ ] AC-31 | Keep customer confidential data out of other customers' Blueprints, logs and shared caches. | M |
| [ ] AC-32 | Block projects forbidding external GitHub/AI when no permitted route exists; do not bypass policy. | M |

### 6. Roles, Workspace Isolation and Parallel Work — AC-33–44

Current implementation: user consultation text is stored in company/Workspace-scoped state; a local per-Workspace handler queue serializes writes. The Actor/Task-like fields are display models, not working CTO/Worker execution. This does not prove agent, memory, search, cache, lifecycle or resource isolation.

Remaining execution: implement source-preserving authorized intake, Lead/CTO/Worker contracts, project-scoped identity and lifecycle, shared-state revisions, controlled worktrees/PRs and resource measurements. Reuse existing Core primitives and keep Workspace separate from Git worktree.

Evidence: two-Workspace adversarial tests for every read/write/search/session/lifecycle path; concurrency and restart tests; real Git worktree/PR integration; resource measurements at increasing Workspace counts; reuse-library access-control tests.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-33 | Pass only permitted project material with source to Lead; Lead drafts requirements/questions/acceptance criteria and marks unapproved material as draft. | P |
| [ ] AC-34 | Lead records contract-level used/unused programs and stacks before CTO assignment; CTO separately researches implementation reuse after Workstream assignment. | M |
| [ ] AC-35 | Assign CTO functional Workstreams, not dependency edges; CTO researches reuse and gives Workers Task Packets. | M |
| [ ] AC-36 | Validate CTO PRs by group and incrementally integrate against Lead contracts; expose cross-group mismatch. | M |
| [ ] AC-37 | Run CTO TestPlan on suitable Actions Runner; attach actual logs/Checks; QA gets no operations SSH authority. | M |
| [ ] AC-38 | Track feedback through Lead revision/impact/CTO propagation without redundant approval for design; CTO decides stop/continue/rework. | M |
| [ ] AC-39 | Install plugin at Host and activate only selected Workspace; activation/Primary are optional and Primary-none is valid. | P |
| [ ] AC-40 | Prevent Workspace A consultation, agents, search index/cache from exposing Workspace B customer data or secrets. | P |
| [ ] AC-41 | Prove pause/stop/resume/reset/backup in Workspace A do not affect B, including actual Actions lifecycle state. | M |
| [ ] AC-42 | Measure CPU/RAM as concurrent Workspaces grow and prove no needless per-Workspace Core/Builder process duplication. | M |
| [ ] AC-43 | Use Git worktrees/PRs to reduce same-project code conflict; preserve their distinction from SPS Workspace. | M |
| [ ] AC-44 | Limit shared Reuse Library to approved non-confidential assets; block unauthorized cross-customer knowledge reuse. | M |

### 7. Consultation Batch Import — AC-45–52

Current implementation: one text input or UTF-8 `.txt` file up to 48 KiB can be saved once by request ID. It does not perform a conversation export/import, preserve full source metadata/attachments, or prove deduplication of source messages.

Remaining execution: support only user-provided or officially permitted inputs, selectable scope/date/attachments, preview and approval, source/order/sender normalization, conflict review and explicit incomplete status. No continuous sync, unauthorized crawl or security bypass.

Evidence: crafted export fixtures and source-preservation assertions; scope preview/approval tests; repeat/conflicting ID tests; incomplete attachment tests; cross-Workspace import isolation; explicit rejection of unsupported/unapproved sources.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-45 | Select conversation/message scope and date range; clearly distinguish the two `N` controls. | M |
| [ ] AC-46 | Preview estimated scope and attachments; import nothing without user approval. | M |
| [ ] AC-47 | Preserve source, order and sender for user-provided files/text; deliver only to the approved Workspace Lead. | P |
| [ ] AC-48 | Avoid unlimited duplicate messages; send uncertain/conflicting source IDs to review without deleting originals. | P |
| [ ] AC-49 | Mark missing messages/attachments or incomplete ranges; never claim full collection. | M |
| [ ] AC-50 | Prevent conversation, attachment or source from entering another project's Workspace, memory or search. | P |
| [ ] AC-51 | Do not poll automatically; record each manual Batch rerun as a separate approval. | M |
| [ ] AC-52 | If official Bulk Export/API or permission is unverified, offer only allowed user-provided input; no crawl/CAPTCHA/auth bypass. | P |

### 8. UI, System, Credentials and HTML Preview — AC-53–66

Current implementation: the UI shell has Lead, Graph, organization, documents, decisions and system views; the Graph and Actor transcripts are read-only; the active Actor list excludes Lead. Lead HTML Preview callback and Core Settings callback are optional props, and current `src/ui/index.tsx` does not wire them. Runner and actual integrations are not connected. Treat prior UI/Host checks as scoped, dated evidence, not proof of all v9 behavior.

Remaining execution: reconcile all views with the approved UI v9 contract, plug in actual source data, implement actual read-only session records and responsive behavior, connect only supported preview/settings affordances, and implement secure credential profiles only through approved secure storage. Do not render placeholder status as live state.

Evidence: exact UI contract comparison; desktop/tablet/mobile/embedded Host screenshot and interaction suite; current source Host tests; real provider/profile authorization and secret-non-disclosure tests; isolated HTML artifact security and popup-blocked tests.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-53 | Keep v9 Workspace/menu/profile in Builder surface; do not force Core chrome; Native Settings independent; optional SDK link only if supported. | P |
| [ ] AC-54 | Show only actually running/waiting non-Lead Agents from selected Workspace; preserve Lead conversation and organization. | P |
| [ ] AC-55 | Show real CTO/Worker transcript read-only with their actual records in the right panel. | S |
| [ ] AC-56 | Keep three Lead sessions distinct but share project Lead memory; record answer-to-revision without duplicate approval. | P |
| [ ] AC-57 | Distinguish CTO ownership and active work in Graph; Actor selection opens correct read-only session. | P |
| [ ] AC-58 | Show Host-wide real Runner status/busy/OS/labels regardless of Workspace; distinguish offline, stale and lookup failure. | M |
| [ ] AC-59 | Verify iPad-size operation of drawers, navigation and system details without a top bar. | P |
| [ ] AC-60 | Securely register/verify multiple approved CLI credential profiles and choose eligible profiles per task/role. | M |
| [ ] AC-61 | Prove tokens, customer conversations/files/session memory cannot cross profile, Workspace, logs or artifacts. | M |
| [ ] AC-62 | Switch profiles only under confirmed provider/error policy; no false seamless migration or policy-evasion rotation. | M |
| [ ] AC-63 | When no profile is eligible, show hold/approved alternative/wait; never mark failed Codex Run successful. | M |
| [ ] AC-64 | Show HTML viewer button only in main Lead view, not other Agent or decisions Lead views. | P |
| [ ] AC-65 | Open actual current Workspace/Lead HTML artifact separately; show empty state; never mix Workspaces. | M |
| [ ] AC-66 | Prove preview script/file/network/Core isolation and handle iPad popup block without losing Lead work. | M |

### 9. Session, CTO Identity and Memory Boundaries — AC-67–81

Current implementation: Lead selection and three session IDs are persisted and prepared through the public Host session ensure operation. No send path, durable send receipts, shared Lead memory, CTO creation, CTO session, Worker/QA execution, memory isolation or retained execution history is demonstrated. Local handler serialization is not a cross-process durable queue.

Remaining execution: validate one supported Codex/Host path; establish durable run+receipt semantics before sending; implement Lead shared structured memory with separated transcripts, project-local CTO lifecycle, independent Worker/QA sessions, cancellation and non-replay recovery. Respect Core authorization and concurrency limits.

Evidence: real provider session create/resume/send test; duplicate request/restart/entered-uncertain tests; concurrent memory conflict tests; two-Workspace and two-CTO isolation tests; max-concurrency, retire/delete and stopped Worker history tests; no stale revision marked complete.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-67 | Exactly one CTO CLI session per project CTO for Lead instructions and Worker direction; no legacy dual sessions. | M |
| [ ] AC-68 | Link revisions and Worker/QA commands/results by Task ID; duplicate commands do not duplicate work. | M |
| [ ] AC-69 | Share Lead memory only within project; separate Lead transcript/authority and all CTO/Worker memories. | P |
| [ ] AC-70 | Detect concurrent shared-Lead-memory writes and prevent incorrect independent CTO/Worker state overwrites. | P |
| [ ] AC-71 | Prevent Workspace/profile swaps from exposing CTO/Worker context across Workspaces. | P |
| [ ] AC-72 | Create/reassign only needed project CTOs; do not duplicate ownership unnecessarily. | M |
| [ ] AC-73 | Preserve project-local CTO states/immutable IDs; retired CTO cannot create Workers; retain authorized history. | M |
| [ ] AC-74 | Avoid accidental UI deletion; distinguish authorized administrator disposal and its limits. | M |
| [ ] AC-75 | Create/direct/stop Workers and QA within supported Codex limits, concurrency and cost/Runner availability. | M |
| [ ] AC-76 | Retain completed/failed/stopped Worker instructions, results, PR/commit, QA proof and termination cause. | M |
| [ ] AC-77 | Allow idle CTO without active model; after restart restore dedicated memory/tasks and disclose lost CLI context. | M |
| [ ] AC-78 | Support multiple parallel project CTOs, each with project ID, single session and separate memory. | M |
| [ ] AC-79 | Keep same-named CTOs and all project data/search/secrets/Worker records isolated across projects. | P |
| [ ] AC-80 | Ensure CTO state/retirement/stop in A cannot affect CTO execution/memory/authority in B. | M |
| [ ] AC-81 | Do not add mandatory Host-global CTO roster/reassignment/knowledge DB; gate reusable assets by permission. | P |

### 10. Role Instructions, Workstreams, Questions and Graph Authority — AC-82–91

Current implementation: data types cover questions, Actors, Graph, documents and revisions, but current actions only import consultation, select Lead and prepare Lead sessions. There is no instruction/role enforcement, CTO task lifecycle, question answer path or Graph Patch permission API.

Remaining execution: make each role's trusted instruction boundary explicit; add idempotent CTO creation, revisioned Workstream/Task Packet, question intake/resolution, Lead-only Graph changes and CTO-only assigned execution status. Use existing Graph API if it proves sufficient; add no mandatory MCP server.

Evidence: hostile instruction/source precedence tests; duplicate/concurrent CTO create; role/scope/assigned-entity authorization tests; revision diff/acknowledgement; duplicate unresolved question and answer flow; negative tests for CTO changing design contracts or inventing completion evidence.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-82 | Separate common/role instructions and Skills; Worker/customer repo content cannot override Builder policy or gain Lead authority. | M |
| [ ] AC-83 | Lead can create scoped CTO without extra user approval; safely handle failure, duplicate call and scope conflict. | M |
| [ ] AC-84 | CTO acts only on required-field Workstream Spec revision; out-of-scope requests are not completed. | M |
| [ ] AC-85 | Track Lead change revision/diff/impact, CTO receipt and affected Worker Task updates. | M |
| [ ] AC-86 | Distinguish 상담-supported contract conditions, assumptions and undecided terms; never claim unauthorized external agreement. | S |
| [ ] AC-87 | Route CTO questions to intake Lead; resolve from known decisions or publish only user decisions once. | M |
| [ ] AC-88 | Apply answer through decisions Lead to new revision and CTO replanning; leave unrelated Task running. | M |
| [ ] AC-89 | Validate Lead Graph Patch revisions; allow CTO only assigned status/current work/test evidence changes. | M |
| [ ] AC-90 | Reuse existing Graph API where sufficient; require no new MCP server unless a minimum adapter is proven necessary. | S |
| [ ] AC-91 | Compare approved-scope reuse/code/library cost and record evidence in CTO Task Packet. | M |

### 11. Technology Decisions, Import/QA Boundaries — AC-92–97

Current implementation: TXT import path exists and no Document Worker or QA executor was found. There is no Technology Decision Register, CTO reuse record, TestPlan or QAResult execution.

Remaining execution: implement Lead's contract-level technology selection separately from CTO's implementation research; reference decisions by revision in each Workstream. Keep consultation parser non-AI and define QA as execution of CTO-authored TestPlan only.

Evidence: required/allowed/prohibited/undecided schema validation; linked revision tests; OSS license/compatibility task packet fixtures; QA run bound to exact commit/plan and actual Check/log; tests proving QA cannot weaken acceptance criteria.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-92 | Lead records required/allowed/prohibited/undecided program and stack decisions before CTO assignment with reasons. | M |
| [ ] AC-93 | Link the Technology Decision Register revision from design/contract and each CTO Workstream. | M |
| [ ] AC-94 | CTO researches OSS/reference code inside approved scope and records links, license, compatibility and avoided duplication in Worker packet. | M |
| [ ] AC-95 | Block prohibited-stack/interface changes without Lead revision/required approval; do not interpret omission as prohibition. | M |
| [ ] AC-96 | Use existing import/parser without Document Worker; preserve source/sender/order and record Lead analysis output. | P |
| [ ] AC-97 | Run QA concurrently from CTO TestPlan; attach commit/Run/Check/log/failure; QA cannot alter acceptance or final-complete status. | M |

### 12. Lead 3 Sessions, CTO/Worker Execution and Authority — AC-98–105

Current implementation: three Lead channel IDs are ensured and stored per Agent-selection revision. This is session preparation only, not shared memory, conversation execution, CTO/Worker creation, Graph authority or end-to-end status.

Remaining execution: implement structured Lead memory and independent transcripts, single CTO session, independent Worker/QA sessions and durable task/run records. Apply pause/stop/resume/cancel semantics without unsafe automatic replay. Enforce execution authority at API/storage boundaries.

Evidence: live multi-session provider test; separate transcript/shared-memory assertions; restart and uncertain-send behavior; Agent creation with Core cap/permission tests; Workstream change during run; stale-revision and authority negative tests.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-98 | Share structured memory across three same-project Lead sessions but isolate other projects and retain separate transcript sources. | P |
| [ ] AC-99 | One CTO session receives Lead spec and directs multiple Workers/QA; no duplicate upper/lower CTO sessions. | M |
| [ ] AC-100 | Each Worker/QA has one independent session and only explicit Task Packet/allowed materials; retain history after close. | M |
| [ ] AC-101 | CTO updates Graph/Task with actual feature, assignment, PR/commit and QA/CI evidence; Lead reads source evidence without periodic reports. | M |
| [ ] AC-102 | Lead creates needed CTO without user-approval wait; enforce Core policy, duplicate handling and concurrency limits. | M |
| [ ] AC-103 | Route customer ambiguity to main Lead and CTO uncertainty through intake/decisions Lead; resolved decisions create revision without extra approval. | M |
| [ ] AC-104 | CTO chooses stop/continue/rework on changed Workstream, records reason and new test scope; never mark stale revision as current success. | M |
| [ ] AC-105 | Enforce CTO execution-state authority separately from Lead design/stack/interface authority in actual APIs/data layer. | M |

### 13. Final UI, SDK, Graph and Security — AC-106–118

Current implementation: React Flow renders stored Graph read-only, Workspace scope is represented in stored data, and SDK build/validation tooling exists. No real Lead Graph Patch, CTO questions, live Runner status, Codex execution, Preview artifact, decision register or security evidence is demonstrated. `elkjs` is a dependency, not proof of authority-safe layout.

Remaining execution: close UI v9 gaps using current plugin data, implement only verified SDK contracts, record library/license decisions, connect actual provider source-of-truth, and complete isolation/security acceptance before marking release-ready.

Evidence: current exact SDK/Core build/validate/test/pack results; Host-backed Graph/Workspace/session test; actual Codex history and Runner API responses; license inventory; adversarial multi-Workspace, token/process and untrusted Runner security tests; final end-to-end delivery/acceptance scenario.

| Check | v15 acceptance criterion | Baseline |
|---|---|---|
| [ ] AC-106 | Request design in natural language; Lead's validated Graph revision updates diagram without user node/edge editing. | P |
| [ ] AC-107 | Show independent A/B Graphs, active CTOs and revisions with no cross-project leakage. | P |
| [ ] AC-108 | Show CTO question choices/tradeoffs/Lead recommendation/free input and connect answer to new revision/CTO spec; label demos. | S |
| [ ] AC-109 | Show Lead contract/technology decisions; exclude Document Worker; present QA only as CTO TestPlan executor. | S |
| [ ] AC-110 | Three user visualization views plus system menu serve seven logical information layers from correct project/Host sources. | S |
| [ ] AC-111 | Verify current Node 22+/Profile v2/Worker ESM/UI Bridge and submit exact SDK build/validate/test/pack evidence. | P |
| [ ] AC-112 | Keep Builder Task/Role/Graph/Question/Revision data plugin-owned and use Host primitives within Workspace boundaries. | P |
| [ ] AC-113 | Verify chosen Codex SDK/App Server can create/restore required sessions and prove transcript completeness/source; do not claim unavailable history. | M |
| [ ] AC-114 | Keep `@xyflow/react` user view-only; show only Lead patches; prove `elkjs` layout cannot change Graph authority/revision. | P |
| [ ] AC-115 | Distinguish actual Runner online/offline/busy, permission failure and stale lookup; never synthesize status. | M |
| [ ] AC-116 | Link dependency choices, versions, licenses and tests to Technology Decision Register; review `elkjs` EPL-2.0 notice. | P |
| [ ] AC-117 | Use only user-provided consultation data, no Document Worker; do not run unverified Kmong extraction. | P |
| [ ] AC-118 | Block release until customer-data/files, Codex token/process and untrusted Runner isolation are verified on actual Host/Runners. | M |

## Open Decisions and Verification Gates

These are unresolved by the design or require contract verification; do not silently decide them in implementation:

- Distribution license, sale/resale and revenue sharing are a separate product decision.
- The evidence that distinguishes an internal proposal/agreement from externally effective customer contract, outbound signature and deployment authority needs a policy decision and verified execution boundary.
- Confirm supported Codex SDK/App Server behavior for create, resume, read/history completeness, concurrency and subagents against the installed versions before committing to an adapter.
- Confirm current Builder/Core Graph API and authorization contract; only then determine whether an adapter is needed.
- Verify practical OS-specific Runner isolation for untrusted customer code and secret/SSH exclusion on actual supported machines.
- Decide how the initial three Graph views cover the seven logical information layers without changing the approved UI arbitrarily.
- Verify whether Kmong provides a permitted official export/API. Until then, support only permitted user-supplied content and label its limits.

Do not treat the above as permission to build unsupported APIs. A failed or unavailable verification remains a visible blocker, not a pass.

## Official References Consulted

These references inform integration investigation; they do not prove that Builder currently implements or is authorized to use the described integration.

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) — programmatic local coding workflows and thread start/continue/resume.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) — client integration, authentication, conversation history, approvals and streamed events; verify exact API/version before use.
- [React Flow: Building a Flow](https://reactflow.dev/learn/concepts/building-a-flow) — graph nodes/edges and rendering.
- [GitHub Actions: Self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use) — security risks and untrusted workflow code on persistent runners.
- [GitHub Actions workflow runs REST API](https://docs.github.com/en/rest/actions/workflow-runs) — provider source for run status, cancellation, rerun and logs.
- [GitHub Actions runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners) — runner operations and lifecycle.

## Completion Report Requirements

For each AC, replace the initial `P`/`S`/`M` baseline with `PASS`, `PARTIAL`, `BLOCKED` or `NOT STARTED` only when evidence is attached. Keep criterion wording and IDs intact. Include exact revision, test command and output reference; identify mocked versus real Host/provider paths; list security limitations and unresolved decisions. Do not report full v15 completion until every required AC is accepted and the end-to-end customer deliverable plus user acceptance gate is proven.

Checklist authorship alone is not implementation evidence. Dated implementation records must identify their exact revisions, actual tests and remaining scope before changing any AC's acceptance status.

### 2026-11-02 추가 기록: Lead 실제 앱 live-design 시험

[Lead 실제 앱 live-design 시험의 범위와 증거](LEAD-LIVE-DESIGN-2026-11-02.md)를 기록했다. Builder `12ba623` / Source `3c1eb21` 기준으로, 명시적 사용자 동의와 `SPS_BUILDER_LIVE_CODEX=1`, `SPS_BUILDER_LIVE_DESIGN=1` 설정을 사용한 운영자 시험에서 실제 Source Desktop/Host와 실제 Codex CLI의 응답 및 Host 초안 쓰기·재조회·재시작 후 보존이 확인됐다. Node 24 전체 160/160 테스트와 타입·빌드·SDK/CLI 검증도 통과했다. 최종 시험의 출력 10건은 모두 `ended`, `failed`는 0건이었다.

이는 일반 Agent 기본 권한으로 성공했다는 뜻이 아니다. 최종 TrialAgent에는 MCP 도구 승인 재정의가 있었고 mock identity를 사용했다. 첫 시험의 AI 답변은 도구 취소를 보고했지만, 실제 도구 로그를 확인하지 않아 취소 여부나 원인은 확정할 수 없다. 플러그인은 임시 Host에 설치해 시험했으나 사용자 환경의 정식 설치본이나 두 컴퓨터(2PC) 검증은 확인하지 않았다. 실제 Google OAuth도 사용하지 않았다. 당시 화면 캡처에서 마지막 답변이 보이는 영역 아래에 있어 사용자에게 보였다고 주장하지 않는다. 공유 Lead 메모리·handoff·승인/질문 흐름과 CTO/Worker/QA/provider 증거 및 전달은 남아 있다. AC 체크와 상태는 변경하지 않는다.

후속 `dcaecb3`은 위에서 발견한 대화 스크롤을 고쳤다. no-AI source 앱에서 긴 메시지
fixture의 처음 끝 위치·과거 기록 독자 위치 보존·직접 최근 메시지 이동을 확인했다.
전체163/163·타입/빌드·SDK CLI가 통과했지만 이 UI 변경에서 실계정 AI를 다시 실행한
것은 아니다. 일반 Agent의 도구 승인·Lead 공유 기억과 나머지 v15 범위는 계속 미완료다.

### 2026-11-02 추가 기록: Lead 공유 기억

[Lead 공유 기억의 구현과 실제 시험 범위](LEAD-SHARED-MEMORY-2026-11-02.md)를
추가했다. Builder `53d5c33` / Core `55b5d5b` / SDK `316c56f` 기준으로,
프로젝트 ID·인용된 사용자 원문 digest·작성자/세션/run/선택 revision/channel을
기록하는 불변 CAS journal과 읽기 전용 문서 패널을 구현했다. Node 24.22.1에서
181/181, 타입·빌드·SDK/CLI 검사가 통과했고 Core adapter 대상 16/16 및 타입 검사도
통과했다. 승인된 실제 시험은 두 채널을 거친 세 번의 run이며, 세 개의 독립 Lead
세션이나 실제 CTO intake는 아니다. 일반 Agent 기본 도구 정책, 자동 memory-read
보장, 프로젝트 선택 UI, 질문 답변에서 Spec/Graph/Contract로 이어지는 흐름은 남아
있다. 이 기록은 AC 상태를 바꾸지 않으며 전체 v15 완료나 납품을 뜻하지 않는다.

### 2026-11-02 추가 기록: 질문·CTO 정체성·내부 설계 기준

[질문 답변과 새 설계 버전](LEAD-QUESTION-REVISION-2026-11-02.md),
[프로젝트 CTO 등록](PROJECT-CTO-REGISTRATION-2026-11-02.md),
[내부 설계 기준](DESIGN-BASELINE-2026-11-02.md)의 구현/검증 범위를 기록했다.
질문과 CTO는 동의받은 실제 Lead 시험을 포함하지만, 내부 기준의 현재 근거는
244개 자동 검사와 no-AI 앱 표시 fixture다. 실제 기준 저장, 기술 선정/Workstream,
CTO 업무/질문 intake, Worker/QA·Runner·납품은 이 기록으로 완료 처리하지 않는다.
기존 AC 체크 상태는 유지하며 Marketplace·Preview·자체 LAN도 계속 보류한다.

### 2026-11-02 추가 기록: Lead 기술 선정 명세

[기술 선정 명세](TECHNOLOGY-DECISIONS-2026-11-02.md)의 저장/조회와 읽기 전용 문서를
연결했다. 현재 설계 기준의 명세/Graph revision과 범위 노드를 검증하며 네 가지 기술
선택과 조사 주장/실제 검증의 차이를 보존한다. 전체267/267·타입/빌드·SDK CLI가
통과했다. Graph 자체 기술 참조 개정, CTO Workstream 배정과 실제 AI 조사/Runner
증거·납품은 남아 있으므로 AC-34/92/93/116 전체 통과로 올리지 않는다.
