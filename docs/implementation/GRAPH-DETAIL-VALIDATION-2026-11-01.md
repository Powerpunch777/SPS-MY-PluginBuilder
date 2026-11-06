# Graph Detail UI Verification

Date: 2026-11-01. Development evidence only; not full Builder delivery.

## Exact Runtime

- Builder `7faed9e6b341a02818f2d1e130f7114f2ae839b6`.
- Source `ddd07c8fe4d23493a6367b98095577c15fcdf264`.
- Private Core `f8ef641e3c6f71699ea0c95d38e979f6c76b28df`.
- Public SDK `61a929f6c783f78e5af603682de1543c7e24abc0`.
- Loaded `dist/ui-v0.1.0/index.js` byte SHA-256:
  `bec43fd2f50b76e3a8759f74e4fa30d140188e8c8100061340d0b5d94e21a1de`.
- SDK `development-build/v1` UI-directory fingerprint:
  `c66d059494c16316d6753e4b934f2d180f4a0598cf4801236b08c43b6213f25d`.

These hashes measure different objects. The SDK hashes the declared UI directory
using its directory domain separator, relative filenames, byte lengths and
contents; it is not a raw `index.js` hash. Different values do not establish a
rebuild or changed loaded bytes. The Host acceptance reads the copied index file.

## Changed Scope

Restore the v9 selected-node detail panel, with the approved black/neutral theme.
Display existing graph kind, status, Actor and relations only. Selecting a node
does not open a session or edit the graph; a separate owner action opens the
existing read-only Actor view. Missing owners disable that action. No fake
description, current task, evidence or AI execution is introduced.

The architecture page no longer includes the conversation activity rail, which
made the graph too narrow alongside its own detail panel. The page fills the
available width; mobile stacks the detail below the graph. Zoom can fit a small
viewport. Node selection handles React Flow's controlled select changes,
including keyboard activation. Nodes remain non-draggable/non-connectable.

## Verified

- Node24.22.1 `npm run check`: typecheck, build, 36/36 tests, SDK validation and
  Worker test passed. Focused SSR also checks stale/empty graph selection.
- `npm run test:browser:ci`: desktop 1440x900, mobile 390x844 and existing
  embedded-width regressions passed. A development-only graph fixture verifies
  keyboard and pointer selection, real control-based Fit View, missing owner,
  missing relations, separate read-only Actor navigation and no horizontal
  overflow. The desktop canvas must retain at least 600px width. Desktop and
  mobile/detail screenshots were inspected. The fixture is not production data.
- Exact Builder CI `41313407763`: SUCCESS for Node22.18, Node24 and Browser UI.
- Source-only actual Host command:
  `node scripts/test-core-host.mjs`, with `SPS_BUILDER_CORE_DESKTOP` pointing at
  the isolated private Desktop checkout above, on Node24.22.1. Exit 0.
  Real UI bridge, Workspace A/B isolation, explicit consultation persistence,
  Agent selection/config preservation, activation and restart tests passed.
  All four Main children exited orderly, all eight output streams ended,
  and exact temporary-data cleanup passed. No installed user profile changed.

Initial browser trials failed controlled keyboard selection, an incorrect test
Fit View button name, and clipped nodes in a narrow canvas. Those failures were
fixed and remain historical failures. An intermediate TypeScript check also
caught the need to narrow `NodeChange` to `select` before reading its ID.

## Not Proven

The real Host fixture retains an empty graph: graph-detail populated-data
interaction is browser-fixture evidence, not actual AI-generated graph proof.
Actual Lead/CTO/Dev/QA execution, shared memory, Graph revisions/editing, GitHub
Actions delivery, other v9 screens, signed installation and physical two-PC
verification remain incomplete. Local Main/output cleanup does not establish
whole-descendant containment or physical qualification.
