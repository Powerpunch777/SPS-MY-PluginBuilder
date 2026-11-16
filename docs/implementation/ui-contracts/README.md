# UI Contract Revisions

## Ownership and source anchors

`src/ui-contracts/domain.ts` validates immutable UI contracts, exact UTF-8 HTML hashes, source identities, approval records and impact statuses. `src/ui-contracts/store.ts` uses the existing Builder `createRevisionJournal` CAS protocol. All records are project-scoped under the trusted Workspace.

A proposal names either `{ kind: "draft", revisionId }` or `{ kind: "baseline", revisionId }`. The store resolves the selected revision from the canonical current design-draft or design-baseline journal and derives its digest and Spec revision; callers cannot provide those trust pins. Draft sources bind the active Lead selection revision and Agent. This permits a first UI proposal and approval before a Baseline exists, while also supporting Baseline-backed proposals.

## Call contracts for Lead-owned registration

The UI Design/Background proposal tool calls `createUiContractStore(workspaceId, projectId, platform.state).propose(input, runContext, platform)` with exactly:

```ts
{
  revisionId: string,
  expectedBaseRevisionId: string | null,
  source: { kind: "draft" | "baseline", revisionId: string },
  artifact: {
    artifactId: string, html: string, htmlSha256: string, screenIds: string[],
    viewport: { width: number, height: number }, sourceSessionId: string, sourceSpecRevisionId: string
  },
  contract: {
    projectId: string, revisionId: string, screenIds: string[],
    interactions: Array<{
      id: string, screenId: string, requirementRefs: string[], behaviorRefs: string[], stateRefs: string[], apiRefs: string[],
      preconditions: string[], outcomes: string[], prohibited: string[], validationCriteria: string[],
      status: "specified" | "unknown" | "unconnected"
    }>
  }
}
```

Proposal storage accepts only current `ui-design` or `background` sessions and verifies the HTML author session and Spec revision. Proposals are not approvals and never enter the formal journal directly.

The user confirmation control must be registered as a Host `SpsActionContext` action, not an AI tool. The exact action method is `approveProposalAction(params, context)` with `context.actor.type === "user"`, matching Workspace, and a nonempty authenticated `actor.userId`. Its exact params are:

```ts
{
  revisionId: string,
  expectedBaseRevisionId: string | null,
  proposalRevisionId: string,
  htmlSha256: string,
  approvedInteractionIds: string[]
}
```

The server fetches the immutable published proposal, compares the exact HTML hash, validates selected interaction IDs, and stores a CAS approval revision containing the complete proposal digest, contract revision, HTML hash, interaction IDs, authenticated user ID and timestamp. Unknown fields such as `approved`, caller-supplied user text, or a role claim are rejected. The existing approval journal is append-only; newer approvals do not erase earlier evidence.

Formal publication is registered as a Lead tool and calls `publishFormal(params, runContext, platform)` with exactly:

```ts
{
  revisionId: string,
  expectedBaseRevisionId: string | null,
  proposalRevisionId: string,
  approvalRevisionId: string
}
```

The store requires canonical current Main authority, a published proposal and a published user-action approval whose proposal digest, HTML hash and contract revision match exactly. It copies the approved proposal's HTML, source anchor and UI Contract into the formal revision; no direct or unapproved formal body path exists. Expected heads are CAS-checked for proposals, approvals and formal revisions.

## Impact and uncertainty

Formal revisions retain requirement references and the approval revision. For a new formal revision the store compares the previous formal Contract and its pinned source revision with the new proposal. Known changed requirement/entity/contract references affect only linked interactions. Affected interactions become `APPROVED` only when selected in the authenticated approval action; otherwise they remain `REVIEW_REQUIRED`. Unaffected prior approval statuses are preserved. Unconnected interactions remain `UNCONNECTED`.

The Builder currently stores HTML as one exact opaque string, without a trusted per-screen DOM diff. When HTML bytes change, prior approval does not automatically carry over to interactions of unknown impact. The authenticated user can explicitly approve the specified, linked interactions in the new exact proposal; unreviewed or unmapped impact remains `UNKNOWN`.

## Registration and verification

`src/platform.ts` registers proposal and formal publication tools and the user-only `builder.approve-ui-proposal` action. The action checks that a new approval matches the current proposal and source; exact replays preserve the stored record. Main notification uses the saved approval's stable request ID. If Main is busy, the same user action lane can retry delivery using `builder.retry-ui-approval-notification`; an attempted request of uncertain admission is only reconciled, never resent. A saved approval, Core run receipt and formal UI revision are separate states. The automatic scheduler is not registered: a Workspace-scoped scheduler job and the approval action currently run on separate Worker lanes, which do not share the action's serialization boundary.

`test/ui-contracts.test.ts` and `test/ui-contract-platform.test.mjs` cover these store and registered-handler paths with controlled fixtures. Desktop/mobile preview checks the sandboxed, hash-checked HTML view and approval controls. The preview allows static HTML and CSS interaction, not arbitrary script execution, functional QA, or actual Host/AI approval verification.
