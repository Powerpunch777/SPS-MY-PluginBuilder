# Workspace Session Prerequisite Recheck

Date: 2026-11-02. Source-only development evidence, not real AI or release acceptance.

## Exact Scope

- Builder tested source: `5e7a5999265b6fb1c03c2bdd44af46a6bb2f6d3a`.
- Public SDK: `e58138e6e153c31b813f62a88932abf5d4cd495c`, source API, package0.11.0.
- SPS source baseline: `de9b598ce073454524466f37f745f8836da95f2d`.
- Private Core: `db37ee1a444db577b01ee9cba754e882c5cf659b`.
- Source evidence documents were being updated; no additional Source/Core runtime
  edits were present. Private code, local paths and raw logs are not copied here.
- v15 design, v9 structure and plugin-only black/neutral-gray appearance remain
  authoritative. Core's global light theme is unchanged.

## Build Record Correction

An initial actual Host pass on Builderfa6249d returned success but its build log
still hardcoded SDK61a929f despite package/lock pinning e581. That incorrect log
must not be used as SDK provenance. The follow-up build derives its declared SDK
revision from matching package.json, root lock dependency and resolved Git commit.
Unpinned, mismatched, missing and wrong-repository references fail before output
is written; plaintext HTTP is rejected. This reports declared/locked source, not
an attestation of installed dependency bytes.

Parent `npm run check` passed48/48 plus SDK validate/test, including12 revision
checks. The final build log reports e581 correctly. SDK runtime JS and Builder
UI/Worker behavior were not expanded by this dependency/build-record change.

## Actual Source App

`SPS_BUILDER_CORE_DESKTOP` selected the private source Desktop for
`npm run test:core-host`. The final command exited0. The fixture verified explicit
installation/activation/Shell selection, actual UI Bridge and Workspace storage,
TXT preview/manual save, invalid-file draft preservation, no save on selection,
idempotent input, Workspace A/B separation, Lead selection with the original
Agent configuration unchanged, Host restart, binding persistence and independent
Core Settings recovery.

The coordinating agent inspected the final actual-app captures. Builder retained
its black/neutral-gray view, single Lead heading, v9 work-panel slots and honest
empty states; its System view retained Lead selection without an activity rail.
The Core frame remained light. Captures and raw logs are local ignored artifacts,
not public evidence assets or a record of a real user's account.

- UI entry SHA256: `e6f37705ebdfa27f496c5a52641635b399f9dbf4e66ebb29fa25beb39dc23e5a`.
- SDK UI-directory fingerprint: `790d01631b2bbb92658b48275720800cf27d43d6675d21803aac3a5114c47983`.
- Worker SHA256: `46071a6c640aacb0bb2368ea65ed79b98f54bc83d42f56b7060f8769ca563bf9`.
- All4 owned Main processes exited normally;8 output streams ended,0 failed,
  and exact temporary-data cleanup completed.

## Not Proven

The fixture uses mock Identity and an unexecuted test Agent. No real Google,
provider/CLI AI, new session-method end-to-end AI, Main Preview, signed/installed
package, whole-descendant or physical two-PC qualification is claimed. User apps,
profiles, projects and Production were unchanged. Core cleanup qualification is
still pending.

The [Lead execution contract](LEAD-EXECUTION-CONTRACT-2026-11-01.md) distinguishes
the new generic Workspace session/output prerequisite from the still-missing
durable ensure/send receipts. Send remains disabled. Lead3 shared-memory sessions,
project CTO's single session, independent Dev/QA, GitHub Actions/Self-hosted Runner
and the remaining v15 features are not complete. Builder progress does not prove
Core completion.
