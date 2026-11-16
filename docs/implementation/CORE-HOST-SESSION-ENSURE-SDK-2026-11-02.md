# Session Ensure SDK Recheck

2026-11-02. Development regression, not real AI or release qualification.

- Builder tested source: `508033341b9498675ab6544f1327f53a1952df8c`.
- Public SDK: `bfd81cdae374ad5ac5e7e621ab99b6af8affee7e`, unreleased source API0.11.0.
- Source runtime: `51b98b4291480cda881f5da83c43b2cfe7220705`.
- Compatible Host runtime revision: `83b9bd62918abe0ba8087945a89631ca27c3b689`.

Node24 `npm run check` passed48/48 and SDK validate/test. The dependency adds
explicit session ensure with optional known-ID recovery and no create/list
fallback. This Builder increment changes dependency/contract text, not its
workflow source or actual session initialization. Send remains disabled.

`npm run test:core-host` exited0. The isolated source Desktop exercised real
UI Bridge, explicit lifecycle/Shell, TXT preview/manual save, invalid-file draft
preservation, idempotent input, Workspace A/B separation, Lead Agent selection
without Agent config mutation, binding persistence after Host restart, and
independent Settings recovery. All4 owned Main processes exited normally,
8output streams ended,0failed, and exact temporary cleanup completed.

Worker SHA256: `62a9dbbac8482bc364afd27c68176b6f787842f75beb440efdaa56f285ecf603`.
UI entry SHA256: `e6f37705ebdfa27f496c5a52641635b399f9dbf4e66ebb29fa25beb39dc23e5a`.
UI source and plugin-only black/neutral-gray design are unchanged. The run used
an unsupported screenshot-directory option rather than the supported file
option; no fresh visual captures are claimed. Existing UI assertions passed.

The fixture uses mock Identity and does not execute the selected Agent. It does
not call the new ensure RPC from Builder. No real Google/provider AI, Main
Preview, installed/signed build, whole-descendant or physical2PC acceptance.
No private source, user profile, credentials or raw logs are included here.

Lead3 session initialization/shared memory, project CTO single session,
independent Dev/QA, durable send receipts and GitHub Actions/Self-hosted Runner
remain within the unchangedv15 goal. SDK prerequisites do not complete them.
