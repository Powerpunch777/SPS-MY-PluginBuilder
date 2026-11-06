# Reuse-First Evidence Slice

## Scope

`src/reuse-first/index.ts` records project-bound reuse candidates and the exact current-project source excerpt they were reported from. It keeps product tier, implementation route, and delivery targets as separate values. It is not a reuse approval, license decision, rights registry, catalog search provider, or proof that an external source is current.

Every candidate is persisted with `license.status = "unknown"`, an empty license evidence list, `reuse.status = "blocked-unverified"`, and `reusableAcrossProjects = false`. There is no caller boolean or input field that can upgrade these values. Caller-supplied provenance/eligibility claims are rejected by exact-field validation. Unknown or missing rights must not be interpreted as permission.

## Persistence

`createReuseFirstStore({ workspaceId, projectId }, state, sourceReader)` reuses the Builder `createRevisionJournal` and its Host `state.compareAndSet` capability. Each revision is immutable, content-digested, and keyed by the Workspace scope plus project-specific revision keys. Publishing requires the exact current `expectedRevisionId`; stale callers receive `conflict` and are not automatically retried. Candidate IDs cannot be added twice in one project history. The store requires CAS and fails closed when unavailable.

The store validates Workspace UUID and project identity, current source reader identity, excerpt Workspace/project/source/line binding, SHA-256 shape, quote bounds, HTTPS origin, and the product/route/target enums. The reader must establish currentness by performing the authorized source read, not by returning a trust marker. A reported source excerpt is evidence of what the current-project reader returned, not evidence of copyright ownership, license compatibility, technical fitness, or cross-customer reuse rights.

## Platform Adapter Contract

The platform owner may register a data/action boundary without changing this domain contract:

- Resolve `workspaceId` from the authenticated Host invocation context, never from an action destination field.
- Resolve and authorize the single current `projectId` from Host-owned project context. Do not treat the caller's project string as authorization.
- Construct `sourceReader.currentScope()` from that same invocation and return the actual Workspace/project pair.
- Implement `sourceReader.readCurrentExcerpt({ sourceId, fromLine, throughLine })` against the existing authorized current-project source API. Return exactly `{ workspaceId, projectId, sourceId, fromLine, throughLine, sha256, text }` only when that persisted source and excerpt are current and verified by the read itself; do not accept or infer currentness from a caller-supplied boolean/marker. Return `null` or fail closed for stale, missing, cross-project, consultation-only, or otherwise unverified sources.
- Construct the store with the invocation's existing `platform.state`; expose `current()` for read and `publish({ expectedRevisionId, revisionId, candidate })` only through an authenticated user action boundary. Derive `revisionId` at the action boundary if the input contract requires a Host-generated request ID.
- Reauthorize the same Workspace/project on every data/action call. Do not expose `publish` to an AI/tool caller as user authority.
- Do not promote candidate status to reusable or copy assets into another customer's Blueprint. A later permission workflow must establish asset-specific origin, immutable version, license bytes/digest, customer scope, authenticated user decision and revocation semantics before any use.

No registration is made here. The current checkout does not expose the previous C slice's source-reader implementation, so this slice accepts only an injected adapter contract and its fixture tests are not installed-Host evidence.

## Acceptance Mapping

- AC-07: records one reported candidate and a bounded current source excerpt; it does not rank/search a complete Blueprint or prove technical fit. Remaining work stays explicitly unknown.
- AC-08: tier, route, and targets are independent validated fields.
- AC-09: unknown license/rights block reuse; scope is bound to a Workspace/project and never exported as cross-project permission.
- AC-10: `sps-plugin` may be selected with any supported route and does not imply AI use. Actual no-AI build/Preview/delivery is outside this slice.
- AC-11: web/API, CLI automation, agent workflow, desktop, hybrid, or SPS targets are accepted independently; no SPS requirement or real build/delivery is claimed.
