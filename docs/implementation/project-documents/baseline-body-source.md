# Project Documents: Immutable Baseline Body Source

## Scope

`src/project-documents/baseline-body-source.ts` supplies a Builder-owned document projection of the existing immutable `design-baseline` journal. It does not use generic Core package bytes, claim a complete package inventory, make an approval decision, or authorize execution. The source follows the A lane's document-as-projection and pinned historical readback approach; the wider A review, authority, Host and UI subsystems are not copied into this module.

## Publication and readback

Construct the source with a trusted workspace, project and Host state client:

```ts
const documents = createBaselineBodySource(workspaceId, projectId, platform.state);
```

Publication accepts only `{ documentRevisionId, expectedDocumentRevisionId, expectedBaselineRevisionId }`. The canonical body and its SHA-256, Baseline/specification/Graph/draft/user-source pins, partial inventory state, and unknown historical-approval state are derived from the current validated `DesignBaseline`. Its source timestamp is deterministic, so a lost entry-CAS or head-CAS receipt can be reconciled with the same immutable revision. The source rereads the current Baseline after the document journal CAS and reports `current` or `stale`; a concurrent Baseline update is never presented as current. Document revisions and Baseline revisions use the existing immutable journal's atomic `compareAndSet` head protocol.

`read(documentRevisionId)` follows the published document chain, verifies the stored body digest and deterministic rendering against the pinned historical Baseline revision, then compares that source with the current Baseline. Results distinguish:

- `available` + `current`: pinned bytes validate and the pinned Baseline is still current.
- `available` + `stale`: pinned historical bytes validate, but a newer Baseline exists.
- `unavailable` + `unknown`: the document/current Baseline or pinned historical bytes cannot be verified. No missing bytes are inferred from metadata.

Every successful read retains `historicalApproval.status: "unknown"`; a recorded Lead interpretation is not independent user/legal approval. `inventory.status` is always `partial` because this public Builder source has no Host-authoritative complete package/file inventory or byte-reader contract. `recent()` is a journal history helper, not an approval or freshness API.

## Registered platform flow

`src/platform.ts` now produces this projection immediately after successful Main Baseline publication. It derives a stable document revision ID and reads the current document head itself. The two journals are not one transaction: a projection failure leaves the published Baseline intact and reports unconfirmed document production. `builder.reconcile-baseline-document` is an authenticated-user-only explicit reconciliation action; it never invokes AI and cannot publish an arbitrary body.

`builder.baseline-document` is registered beside the existing project/Baseline data handlers. It binds the single project to the Host-authorized Workspace and returns a validated readback of the current published document head. The existing document center receives a view projection; it is not another authoritative store. The underlying reader is:

```ts
createBaselineBodySource(trustedWorkspaceId, trustedProjectId, platform.state)
  .read(documentRevisionId)
```

The source module itself has no dispatch or Agent API dependency. Registration and UI projection are owned by the platform layer.

## B Manager read contract

The next B Manager can depend on this narrow read-only interface without owning storage:

```ts
type BaselineBodyReader = {
  read(documentRevisionId: string): Promise<BaselineBodyRead>;
};
```

For every response, B must bind the reader instance to trusted workspace/project scope and compare the requested immutable document revision and expected Baseline revision against the returned `document.documentRevisionId`, `document.workspaceId`, `document.projectId`, and `document.sourceBaselineRevisionId`. B may treat the body as a current readable source only when `status === "available"`, `source === "current"`, `bodyAvailable === true`, and a fresh SHA-256 check of `document.body` equals `document.bodySha256`. `stale`, `unavailable`, `unknown`, partial inventory, missing pins, scope/revision mismatch, and any digest mismatch must remain explicit non-success/UNKNOWN outcomes. B must not convert `historicalApproval: "unknown"` into approval or treat this Baseline document as the complete package manifest.

The next contract needed for complete package freshness is a separate Host-authoritative artifact inventory/body reader, pinned to the same Baseline identity and CAS publication. This slice deliberately does not invent or stub that Core/Host source.

## Focused validation

`test/project-documents-baseline-body-source.test.ts` exercises real Baseline and document journals with CAS: body/pin integrity, current-to-stale readback, expected-head conflicts, and unavailable historical bytes. It is at the repository's existing root `test/*.test.ts` level, so the current `npm test` glob includes it without changing `package.json`. This is implementation coverage, not the independent A QA or full Host acceptance.
