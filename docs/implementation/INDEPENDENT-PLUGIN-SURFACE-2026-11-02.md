# Independent Plugin Surface Acceptance

2026-11-02. This tests the existing Builder on the common Plugin page surface.
It is not Lead AI completion, OS isolation, Preview or release qualification.

## Exact Runtime

- Builder runtime remains `87ff7a25a4f393b08cce4f4c54fef80747b4ba01`; the subsequent
  documentation commits did not change its Worker/UI.
- Builder acceptance script: `ba28d43f473df82d82ebab09c972f18f44947cb5`.
- Source runtime: `93f6330f365e6e5a8c360e10955dea2c1b2fca3e`.
- Compatible Core runtime: `71b649ebcc1bef0248873d3f5ec699b11d2c12da`.
- Host SDK documentation pin: `18e06800d1c1e75003b7dd12936ebfcab2ef1f7f`;
  actual Builder dependency remains `bfd81cdae374ad5ac5e7e621ab99b6af8affee7e`.
  The two SDK revisions have the same runtime API; no SDK release/tag was made.

Command: Node 24.22.1 `npm run test:core-host`, with `SPS_BUILDER_CORE_DESKTOP`
pointing at the explicitly selected private development checkout, source-only
acceptance enabled and screenshots saved to a separate ignored temporary folder.
No private source, user profile, credentials or raw logs were copied here.

## Observed Result

The script exited 0. The actual source Electron/Host opened Builder as the
explicitly chosen Primary without the compatibility `#main-content` frame.
The Builder surface started at the viewport origin and filled both its width
and height within the bounded pixel tolerance. Existing v9 navigation, work
tabs, black/neutral palette and disabled AI-send state were retained.

The parent inspected fresh Lead and System captures: no Core sidebar/header,
no leftover white canvas below the Plugin, three saved Lead sessions, and an
honest unconnected Runner/AI state. This is the current general Plugin page
route, not a new dedicated OS window or a Preview instance.

Existing acceptance also passed: explicit installation and Workspace activation,
inactive/cross-Workspace access denial, A/B data preservation, consultation TXT
input and invalid-file draft preservation, Lead selection without changing the
original Agent configuration, exactly three sessions with no duplicates on
recheck, same IDs and data after Host restart, and activation without data loss.

The common reference fixture additionally exercised UI actions/events, a
Workspace Job, capability denial, a UI-less Worker, package update/initialization
failure rollback, and independent Native recovery. Main processes 4/4 exited 0;
8 output streams ended with no failures and exact temporary cleanup completed.
That is local Main/output/data evidence, not whole-descendant/physical evidence.

## Failures Found Before Final Acceptance

The first frame-removal attempt showed only a page placeholder. The Plugin module
loader had been reached through the removed compatibility Layout. Core now loads
the selected page contribution independently, without bringing back common chrome.
An intermediate passing run still showed a white strip below Builder in the
capture. The common surface height and child page height were then fixed, and
the final script above added and passed the height assertion. Earlier passes
are not substituted for this final result.

## Artifact Identity and Limits

- Worker SHA256: `aa05a1d6ffd0d5a5b96b69a322ee728a5ae43fd220e498f551c650b0b7e19076`.
- UI entry SHA256: `6f05a64769655bd3fe68726975272ff99228abe9682cce89c48e161064b72f47`.
- Lead capture SHA256: `4e3728e0c6c68fa217d72aea44a5c8865747d33afdbfc16ecdfc87a4b2856be6`.
- System capture SHA256: `ef646e6fbe122474eeb5b4466b99e69768a015680f15517b3989d0395587ac9a`.

Captures are ignored local files, not public assets or signed release evidence.
Mock Identity and an unexecuted Agent were used. Real Google/provider calls,
durable message submit, paginated chat, shared Lead memory, CTO/Dev/QA/Runner,
OS protection and signed/installed/two-PC acceptance remain open. User DEV was
kept running separately and was not populated or approved by this fixture.

Design remains the repository's v15/UI v9 and
[Core–Plugin alignment](../design/CORE-PLUGIN-ALIGNMENT-2026-11-02.md).
