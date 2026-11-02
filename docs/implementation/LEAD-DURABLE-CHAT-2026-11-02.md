# Durable Lead Chat: Source App Evidence

Date: 2026-11-02. Development acceptance, not full v15 or Stable qualification.

## First Successful Answer Increment: Exact Source

- Builder implementation/operator: `b874181c86a6f96fa0ae2922739df172905fb860`.
- Consuming Desktop source: `c8c6b46f977afac12299d0c9dd33b02bb257f312`.
- Private Host contract revision: `3abf1f50b9cf69e23397e9b2cc1a0d1a01a2365d`.
- Public SDK pin: `0111d291a99c032760a391693aa879bb099b5034` (unreleased source API; package version remains 0.11.0).
- Windows, parent Node 24.22.1 with the same Node directory first on PATH; installed Codex CLI 0.144.1.
- Worker SHA-256: `2679b5f848d3fc73767dfc33e007c4b1bb1d49898acfc433e06fe9df3f6f2e12`.
- Loaded UI entry SHA-256: `1c38a1b9f698bb4e5d618828165262deb798a00b2a0aea3bb379421c87937139`.
- Manifest SHA-256: `2dd1fd32d079b94a9cefa7056a63997de679044e0f7d34b0559ebff78e0ddb23`.

The tested worktree was committed unchanged as the Builder revision above. A later documentation-only commit is not a new runtime test. No private Core source, credentials, account identifiers, raw CLI logs or user paths are included here.

## Implemented Boundary

Builder stores one bounded record per turn, a bounded channel head and sequence index. Pages contain at most ten turns and have a byte ceiling. Workspace, Agent selection revision, Agent, session and channel remain distinct. The initial consultation snapshot does not grow with chat. Three session transcripts are separate; this is **not shared Lead memory**.

The explicit send action records `prepared` before publishing its head and `dispatching` before invoking the public SDK. A request ID is immutable. Response loss queries the same Core receipt; null/uncertain admission never permits automatic resend. Only a saved `prepared` turn can be explicitly resumed. Core owns the private request receipt and admission fence; Builder-owned KV state cannot forge that fence. This is at-most-once admission, not exactly-once provider execution or an OS sandbox.

The UI uses public SDK data/actions only. It shows real returned answers, unavailable output, failures and cancellation/termination states separately. Background/hidden-page polling does not send new work. Manual response checks remain available. Unsupported older Hosts fail explicitly before dispatch. User messages cannot target the internal `cto-inbox` channel.

New read/send/cancel capabilities require the normal Host review. This test does not approve them in an existing user's DEV or installation.

## Reproduction

Use Node 24 first on PATH. From the Builder checkout:

```powershell
npm run check
$env:SPS_BUILDER_CORE_DESKTOP = '<absolute private Source checkout>/sps-server/desktop'
npm run test:core-host
```

The default app test uses no live account. Live acceptance is a separate, explicitly authorized operator mode; it can consume the default CLI account's usage:

```powershell
$env:SPS_BUILDER_LIVE_CODEX = '1'
$env:SPS_DESKTOP_E2E_SCREENSHOT = '<absolute private temporary screenshot directory>/workspace.png'
npm run test:core-host
```

Do not enable the live mode without the account holder's permission. It refuses an inherited API key/alternate-provider configuration. The operator creates a temporary Agent with the current managed `AGENTS.md` instruction contract, uses the existing CLI adapter's temporary managed home/default authentication link, requests a short nonsecret answer, and disables command, plugin, browser and subagent tools. It does not change login, install a product, generate code or run customer code. The existing fixture owns cleanup; no real Workspace/project is used.

## Observed Results

- `npm run check`: 87/87 tests, typecheck, build, SDK validate and SDK test passed.
- Default source-app path: real UI import/selection, three-session preparation/recheck, A/B isolation, failed unconfigured Process dispatch, duplicate request rejection and exact run/turn retention after Host restart passed.
- Final live operator: actual UI send -> Core receipt/run -> existing Codex CLI -> actual provider success -> stored `SPS_LEAD_CHAT_OK` answer. Complete short-run CLI output contained assistant/reasoning items only; the temporary working folder remained empty.
- Exact assistant-bubble content (not matching the token inside the user's prompt) was asserted and visually inspected. After a separate Main/Host restart, the exact turn, run, session binding and assistant bubble were retained.
- Repeating the exact request ID/text left the actual Agent run count at one. No second provider execution was scheduled by that repeat.
- Final combined source-app run exited 0; five owned Main processes exited 0, ten output streams ended, zero output failures, exact temporary data cleanup confirmed. No forced shutdown was required.
- The common checklist's no-AI statement applies to its reference fixtures, not this separately opted-in live operator. No whole-descendant OS/physical qualification follows from Main/output cleanup.

Private captures and raw diagnostic logs stay outside this public repository. The user DEV/installed profile and existing login were not replaced or restarted by this test.

## Failed and Narrowed Attempts

The first live setup used a retired `promptTemplate` field and was rejected with 422 before live dispatch; the operator now supplies the supported managed instruction bundle. A subsequent attempt did not observe a terminal result while its page polling was inactive and timed out; it is not a successful live acceptance result. Explicit status observation now targets only the same saved run and never resends it.

An intermediate successful provider/restart check used a broad transcript-text assertion that could match the user's prompt. Parent visual review found the assistant bubble was not yet shown in its capture. The final operator explicitly refreshes visible data and requires the assistant-specific bubble before recording UI success; the stronger final rerun and fresh captures passed. These earlier assertions are not promoted to final UI evidence.

## Still Open

- At this first increment: actual live CLI cancellation/termination UI acceptance. The separately identified follow-up below now exercises that case.
- Shared structured Lead memory; Lead authoring tools and authorized Graph persistence. The new Graph module is pure validation only, not authorization/storage or a registered tool.
- CTO, independent Dev/QA, GitHub/Runner, requirement-linked evidence and deliverable acceptance.
- Protected Preview and OS-enforced file/Vault/child protection. Tools-off/read-only chat is not proof of that boundary.
- Packaged/signed app, updates, physical devices and Stable qualification.

All AC-01 through AC-118 remain tracked by the [full v15 plan](BUILDER-V15-COMPLETION-PLAN-2026-11-02.md); this increment is not full Builder completion.

Official reference: [Codex exec](https://learn.chatgpt.com/docs/developer-commands#codex-exec). Actual installed CLI flags and the existing Host adapter were checked before this live test; documentation alone is not its execution evidence.

## Follow-up: Actual CLI Cancellation and Restart

Operator revision: `9fdb553c9d8d296391cd789153c34ae3c4703f57`, committed unchanged from the tested worktree. Desktop source: `a69f68cb515478b1cf22f0719fe4f5adbd784630`; Host/SDK revisions above are unchanged. Worker/UI/manifest hashes above are unchanged; this follow-up modifies trusted test operators, not Plugin runtime or user settings.

This requires a second explicit opt-in, in addition to live account permission:

```powershell
$env:SPS_BUILDER_LIVE_CODEX = '1'
$env:SPS_BUILDER_LIVE_CANCEL = '1'
npm run test:core-host
```

The first actual answer, exact assistant bubble, duplicate rejection and restart checks passed again. The operator then sent one additional short nonsecret conversation message, observed a running Core run with a live managed CLI PID, and clicked the real Builder cancellation control. The same saved turn became `cancelled` with `termination: confirmed`; the observed process no longer existed. After another Main/Host restart the exact cancelled turn stayed terminal and the Agent had exactly the two explicitly requested runs, not a replay. The temporary working folder remained empty. This is an application-level observed managed-process check, not proof of every possible descendant, PID-resistant hardware attestation or OS sandbox containment.

Final opt-in cancellation app run: exit 0, six Main exits0, twelve ended output streams, zero output failures, exact temporary-data cleanup. Builder check rerun at the operator revision: 87/87 plus typecheck/build/SDK validate/test passed. The cancellation text is asserted in the actual restarted transcript; its capture extends below the first viewport, so no claim that every retained message is simultaneously visible. The earlier assistant captures were visually inspected. Raw logs, account data and captures remain private.

Remaining work is shared memory, authorized authoring/Graph persistence, CTO/Dev/QA, real external Runner/delivery evidence, complete Native management/UX, protected Preview and release qualification. The actual CLI cancellation case is no longer listed as untested, but this does not accept all 118 v15 criteria.
