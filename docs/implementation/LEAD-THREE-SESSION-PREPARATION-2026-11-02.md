# Lead Three-Session Preparation

2026-11-02. v15 incremental implementation and actual source-app evidence.
Not Lead AI completion, Core completion or release qualification.

## Implemented

The explicit user action `builder.prepare-lead-sessions` uses the selected
Workspace Agent and its displayed selection revision. It prepares distinct
`main`, `cto-inbox` and `decisions` sessions with the public SDK's explicit
`agents.sessions.ensure` operation. Selection alone still creates no sessions.
No create/list fallback, Agent configuration mutation, provider call or message
send is performed. The added `agent.sessions.create` permission is declared in
the runtime and static manifests; send permission remains absent. Existing
Host installation/permission review and explicit Workspace activation apply.

Session bindings live in the Workspace/plugin state namespace, under
`lead-sessions.v1.<Agent-selection-revision>`, with exact Workspace, Agent,
selection revision and three nullable channel IDs. Every successful channel ID
is saved before proceeding. Partial save/response loss retains known state;
retry uses the same owned key and passes any saved ID as `expectedSessionId`.
Known missing/replaced sessions fail for review instead of automatic recreation.
Unexpected result fields, duplicate IDs or contradictory known-ID creation fail.

Changing the selected Agent creates a new selection generation. Previous binding
records and Host sessions remain retained, not closed, erased or silently
reassigned. This increment does not contain a session-retirement UI. Reads and
preparation recheck selection before/after awaited work. The existing dedicated
Workspace Worker queue serializes local selection/preparation handlers, not an
independent cross-process DB transaction or ongoing execution lease.

System shows saved session count and manual preparation/check controls. It says
AI transmission is still being prepared; session identity alone is not provider
readiness or shared memory. The existing consultation snapshot remains intact;
the new dedicated `builder.lead-sessions` record is the connection state, not a
claim that the legacy snapshot's empty Lead session fields implement chat.

## Exact Verification

- Tested Builder: `87ff7a25a4f393b08cce4f4c54fef80747b4ba01`.
- Public SDK: `bfd81cdae374ad5ac5e7e621ab99b6af8affee7e`, unreleased source API0.11.0.
- Source: `81b3210a9247631d709088b0700cf6b77572b948` (evidence-only successor to51b98b4).
- Compatible Host runtime: `83b9bd62918abe0ba8087945a89631ca27c3b689`.
- Node24.22.1 `npm run check`:59/59, SDK validate/test pass.
- Initial new-test typecheck found a parenthesis error, then a widened actor
  literal type; both were corrected before the final59/59 run. No runtime
  failure was waived. Unit fakes do not prove DB/process recovery.

`npm run test:core-host` with the source Desktop and supported screenshot-file
option exited0. Actual UI preparation created exactly three Host session rows;
manual recheck kept the same IDs and count; all had null lastRunId. Another
Workspace retained empty bindings. Host restart retained the three IDs and
original Agent configuration. Existing explicit lifecycle/Shell, TXT/manual save,
invalid-file draft preservation, A/B data, Lead selection, and Settings checks
also passed. All4 owned Main processes exited0,8output streams ended,0failed,
and exact temporary cleanup completed; not whole-descendant qualification.

The parent inspected actual System and Lead captures: saved3/3 with the check
button, honest AI-unconnected/disabled-send state, no layout clipping at the
tested embedded size, plugin-only black/neutral-gray UI and unchanged light
Core frame. Raw logs/captures are ignored local artifacts, not public assets.

- Worker SHA256: `aa05a1d6ffd0d5a5b96b69a322ee728a5ae43fd220e498f551c650b0b7e19076`.
- UI entry SHA256: `6f05a64769655bd3fe68726975272ff99228abe9682cce89c48e161064b72f47`.
- SDK UI-directory fingerprint: `7b5c361e5947f8341bc79a1a1e9b6eb5f9b65bd2df2f82ab00861466632df16f`
  is a different hash target from the entry file.

## Still Required

The fixture uses mock Identity and an unexecuted Agent. Lost response/save,
known-row deletion, selection races and invalid results are unit-test scenarios,
not all actual-app scenarios. Real provider/CLI execution, bounded paginated
messages, durable submit receipts/ambiguous-send recovery and shared structured
Lead memory are not implemented here. CTO single session, independent Dev/QA,
GitHub Actions/Self-hosted Runner and the remainingv15 requirements stay open.
No Main Preview, signed/installed update or physical2PC qualification is claimed.

User-requested DEV remains open separately; this fixture did not install Builder
or approve the added permission in that user profile. No private Core source,
credentials, user data or real account/machine metadata is copied here.

References checked before implementation: Node.js
[AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage)
and PostgreSQL [row locking](https://www.postgresql.org/docs/current/explicit-locking.html).
No external source was copied; the existing SDK/Host contract was reused.
