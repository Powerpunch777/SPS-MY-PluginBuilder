import { createHash } from "node:crypto";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignDraftStore } from "../design-draft-store.ts";
import { parseDesignBaseline, type DesignBaseline } from "../domain/design-baseline.ts";
import { composeDomainPacks, type DomainPack } from "./evaluator.ts";
import { readLeadUserSource } from "../lead-conversations.ts";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "../domain/snapshot.ts";
import { parseDesignDraft } from "../domain/design-drafts.ts";
import { parseLeadAgentBinding } from "../domain/lead-agent.ts";
import { parseLeadSessions } from "../domain/lead-sessions.ts";
import type { AuthoredDesignDraft } from "../design-draft-store.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import { parseDesignModelMaterial, type DesignModelMaterial } from "./design-model-material.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const ID = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 160
  && !/[\u0000-\u001f\u007f]/u.test(value);
const HEX = /^[a-f0-9]{64}$/u;

export type FirstDesignSourcePin = Readonly<{
  requirementId: string;
  acId: string | null;
  sourceId: string;
  sourceDigest: string;
}>;

export type FirstDesignReviewBundle = Readonly<{
  status: "PROPOSED" | "APPROVED";
  revisionId: string;
  workspaceId: string;
  projectId: string;
  priorBaseline: FirstDesignReviewBaselinePin | null;
  draftRevisionId: string;
  draftDigest: string;
  draft: AuthoredDesignDraft["draft"];
  sourcePins: readonly FirstDesignSourcePin[];
  pack: DomainPack;
  designModel?: DesignModelMaterial;
  author: Readonly<{ agentId: string; sessionId: string; runId: string; selectionRevision: number; createdAt: string }>;
  approval?: Readonly<{ userId: string; approvedAt: string; attestedBundleRevisionId: string }>;
}>;

export type FirstDesignReviewBaselinePin = Readonly<{ revisionId: string; sequence: number; digest: string }>;

export type FirstDesignReviewProposalInput = Readonly<{
  projectId: string;
  expectedDraftRevisionId: string;
  expectedReviewHeadRevisionId: string | null;
  pack: Readonly<Omit<DomainPack, "identity">>;
  sourcePins: readonly Readonly<{ requirementId: string; acId: string | null; sourceId: string }>[];
  designModel?: unknown;
}>;

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function validatePack(value: unknown, identity: DomainPack["identity"], requirements: ReadonlySet<string>, deriveIdentity = false): DomainPack {
  const fields = ["packId", "version", "applicability", "rules", "transitions", "exceptions", "excludedCombinations"];
  const row = exactToolRecord(value, deriveIdentity ? fields : [...fields, "identity"]);
  if (!ID(row.packId) || !ID(row.version) || !Array.isArray(row.rules)) throw new TypeError("A specific proposed rule-pack ID, version, and rules are required.");
  const pack = { ...row, identity } as unknown as DomainPack;
  if (!deriveIdentity) {
    const suppliedIdentity = exactToolRecord(row.identity, ["workspaceId", "projectId", "specRevisionId", "specDigest"]);
    if (suppliedIdentity.workspaceId !== identity.workspaceId || suppliedIdentity.projectId !== identity.projectId
      || suppliedIdentity.specRevisionId !== identity.specRevisionId || suppliedIdentity.specDigest !== identity.specDigest) {
      throw new TypeError("Stored rule pack identity must bind the current immutable DesignDraft specification.");
    }
  }
  composeDomainPacks([pack], identity, []);
  if (pack.rules.some(rule => rule.requirementIds.some(id => !requirements.has(id)))) {
    throw new TypeError("Rule pack rules must remain within the current DesignDraft requirements.");
  }
  return freezeTree(pack);
}

function proposalFingerprint(bundle: Pick<FirstDesignReviewBundle, "workspaceId" | "projectId" | "priorBaseline" | "draftRevisionId" | "draftDigest" | "draft" | "sourcePins" | "pack" | "designModel" | "author">) {
  return hash([bundle.workspaceId, bundle.projectId, bundle.draftRevisionId, bundle.draftDigest, bundle.draft,
    bundle.sourcePins, bundle.pack, bundle.author.agentId, bundle.author.sessionId, bundle.author.runId, bundle.author.selectionRevision,
    ...(bundle.priorBaseline === null ? [] : [bundle.priorBaseline]),
    ...(bundle.designModel ? [bundle.designModel] : [])]);
}

function baselineJournal(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, { prefix: "design-baseline",
    parse: value => parseDesignBaseline(value, projectId), revisionId: (value: DesignBaseline) => value.revisionId });
}

async function currentBaselinePin(workspaceId: string, projectId: string, context: ReviewContext): Promise<FirstDesignReviewBaselinePin | null> {
  const current = await baselineJournal(workspaceId, projectId, context.state as RevisionState).current();
  return current ? Object.freeze({ revisionId: current.revision.revisionId, sequence: current.sequence,
    digest: hash(current.revision) }) : null;
}

function sameBaselinePin(left: FirstDesignReviewBaselinePin | null, right: FirstDesignReviewBaselinePin | null) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseBundle(value: unknown, workspaceId: string, projectId: string): FirstDesignReviewBundle {
  const row = exactToolRecord(value, ["status", "revisionId", "workspaceId", "projectId", "priorBaseline", "draftRevisionId", "draftDigest", "draft", "sourcePins", "pack", "author"], ["approval", "designModel"]);
  const author = exactToolRecord(row.author, ["agentId", "sessionId", "runId", "selectionRevision", "createdAt"]);
  let priorBaseline: FirstDesignReviewBaselinePin | null = null;
  if (row.priorBaseline !== null) {
    const prior = exactToolRecord(row.priorBaseline, ["revisionId", "sequence", "digest"]);
    if (!ID(prior.revisionId) || !Number.isSafeInteger(prior.sequence) || (prior.sequence as number) < 1
      || typeof prior.digest !== "string" || !HEX.test(prior.digest)) throw new TypeError("Invalid exact prior Baseline pin.");
    priorBaseline = Object.freeze({ revisionId: prior.revisionId as string, sequence: prior.sequence as number, digest: prior.digest });
  }
  if (!(row.status === "PROPOSED" || row.status === "APPROVED") || !ID(row.revisionId)
    || row.workspaceId !== workspaceId || row.projectId !== projectId
    || !ID(row.draftRevisionId) || typeof row.draftDigest !== "string" || !HEX.test(row.draftDigest)
    || !ID(author.agentId) || !ID(author.sessionId) || !ID(author.runId)
    || !Number.isSafeInteger(author.selectionRevision) || (author.selectionRevision as number) < 1
    || typeof author.createdAt !== "string" || !Number.isFinite(Date.parse(author.createdAt))
    || new Date(author.createdAt).toISOString() !== author.createdAt) throw new TypeError("Invalid first-design review identity.");
  const draft = parseDesignDraft(row.draft, projectId);
  if (!draft || draft.projectId !== projectId || draft.revisionId !== row.draftRevisionId || hash(draft) !== row.draftDigest) {
    throw new TypeError("Review bundle must contain the exact immutable DesignDraft and digest.");
  }
  if (!Array.isArray(row.sourcePins) || Object.getPrototypeOf(row.sourcePins) !== Array.prototype
    || row.sourcePins.length === 0 || Reflect.ownKeys(row.sourcePins).length !== row.sourcePins.length + 1) {
    throw new TypeError("Requirement-to-original-source pins are required as a dense list.");
  }
  const sourcePins = Array.from({ length: row.sourcePins.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(row.sourcePins, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("Source pins must be dense plain data.");
    const item = descriptor.value;
    const pin = exactToolRecord(item, ["requirementId", "acId", "sourceId", "sourceDigest"]);
    const requirement = draft.specification.requirements.find(value => value.id === pin.requirementId);
    if (!requirement || pin.acId !== null && !requirement.acceptanceCriteriaIds.includes(pin.acId as string)
      || !draft.sourceIds.includes(pin.sourceId as string) || typeof pin.sourceDigest !== "string" || !HEX.test(pin.sourceDigest)) {
      throw new TypeError("A source pin must cite a DesignDraft requirement, AC, and original source.");
    }
    return Object.freeze({ requirementId: pin.requirementId as string, acId: pin.acId as string | null,
      sourceId: pin.sourceId as string, sourceDigest: pin.sourceDigest });
  });
  const pinKeys = sourcePins.map(pin => `${pin.requirementId}\0${pin.acId ?? ""}\0${pin.sourceId}`);
  if (new Set(pinKeys).size !== pinKeys.length || draft.specification.requirements.some(requirement =>
    !sourcePins.some(pin => pin.requirementId === requirement.id))) throw new TypeError("Every requirement needs a unique original-source pin.");
  const identity = Object.freeze({ workspaceId, projectId, specRevisionId: draft.specification.revisionId,
    specDigest: hash(draft.specification) });
  const pack = validatePack(row.pack, identity, new Set(draft.specification.requirements.map(item => item.id)));
  const designModel = Object.hasOwn(row, "designModel")
    ? parseDesignModelMaterial(row.designModel, identity, draft.specification.requirements, pack, sourcePins, true) : undefined;
  const approval = Object.hasOwn(row, "approval") ? exactToolRecord(row.approval, ["userId", "approvedAt", "attestedBundleRevisionId"]) : undefined;
  if ((row.status === "APPROVED") !== !!approval) throw new TypeError("Approval evidence must be explicit and consistent with bundle status.");
  if (approval && (!ID(approval.userId) || typeof approval.approvedAt !== "string" || !Number.isFinite(Date.parse(approval.approvedAt))
    || new Date(approval.approvedAt).toISOString() !== approval.approvedAt || !ID(approval.attestedBundleRevisionId)
    || row.status !== "APPROVED" || approval.attestedBundleRevisionId === row.revisionId)) {
    throw new TypeError("Invalid exact-bundle user approval attestation.");
  }
  return freezeTree({ status: row.status, revisionId: row.revisionId, workspaceId, projectId, priorBaseline,
    draftRevisionId: row.draftRevisionId, draftDigest: row.draftDigest, draft, sourcePins: Object.freeze(sourcePins), pack,
    ...(designModel ? { designModel } : {}),
    author: Object.freeze({ agentId: author.agentId as string, sessionId: author.sessionId as string,
      runId: author.runId as string, selectionRevision: author.selectionRevision as number, createdAt: author.createdAt as string }),
    ...(approval ? { approval: Object.freeze({ userId: approval.userId as string, approvedAt: approval.approvedAt as string,
      attestedBundleRevisionId: approval.attestedBundleRevisionId as string }) } : {}) });
}

function createFirstDesignReviewStore(workspaceId: string, projectId: string, state: RevisionState) {
  const journal = createRevisionJournal(workspaceId, projectId, state, {
    prefix: "first-design-review",
    parse: value => parseBundle(value, workspaceId, projectId),
    revisionId: value => value.revisionId,
  });
  return Object.freeze({ current: () => journal.current(), readExact: (revisionId: string) => journal.publishedRevision(revisionId),
    proposeCAS: (patch: { expectedBaseRevisionId: string | null; revision: FirstDesignReviewBundle }) => {
      if (patch.revision.status !== "PROPOSED") throw new TypeError("Only a real first-design proposal may enter the proposal CAS.");
      return journal.publish(patch);
    },
    approveCAS: (patch: { expectedBaseRevisionId: string; revision: FirstDesignReviewBundle }) => {
      if (patch.revision.status !== "APPROVED" || !patch.revision.approval
        || patch.revision.approval.attestedBundleRevisionId !== patch.expectedBaseRevisionId) {
        throw new TypeError("Approval CAS must attest to the exact current proposal revision.");
      }
      return journal.publish(patch);
    } });
}

type ReviewContext = SpsPlatformInvocationContext;
type UserReviewContext = SpsActionContext & SpsPlatformInvocationContext;
function authenticatedWorkspace(context: UserReviewContext) {
  if (context.actor.type !== "user" || context.actor.companyId !== context.companyId || !ID(context.actor.userId)) {
    throw new Error("An authenticated Builder user action is required.");
  }
  return { workspaceId: context.companyId, userId: context.actor.userId };
}

async function currentDraft(workspaceId: string, projectId: string, context: ReviewContext) {
  const key = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: workspaceId,
    namespace: "sonpark.my-builder", stateKey });
  const rawBinding = await context.state.get(key("lead-agent.v1"));
  if (!rawBinding) throw new Error("A current Lead DesignDraft is unavailable.");
  const binding = parseLeadAgentBinding(rawBinding, workspaceId);
  if (!binding.selectedAgentId) throw new Error("A current Lead DesignDraft is unavailable.");
  const sessions = parseLeadSessions(await context.state.get(key(`lead-sessions.v1.${binding.revision}`))
    ?? { workspaceId, selectionRevision: binding.revision, agentId: binding.selectedAgentId,
      sessions: { main: null, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } }, workspaceId);
  const draftStore = createDesignDraftStore(workspaceId, projectId,
    { selectionRevision: binding.revision, agentId: binding.selectedAgentId }, context.state as RevisionState);
  const draft = await draftStore.current();
  const latestRaw = await context.state.get(key("lead-agent.v1"));
  const latestBinding = parseLeadAgentBinding(latestRaw, workspaceId);
  const latestSessions = parseLeadSessions(await context.state.get(key(`lead-sessions.v1.${binding.revision}`))
    ?? { workspaceId, selectionRevision: binding.revision, agentId: binding.selectedAgentId,
      sessions: { main: null, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } }, workspaceId);
  if (!draft || latestBinding.revision !== binding.revision || latestBinding.selectedAgentId !== binding.selectedAgentId
    || JSON.stringify(latestSessions) !== JSON.stringify(sessions)) throw new Error("The current DesignDraft or Lead selection changed; refresh without retrying.");
  return { draft, sessions };
}

async function readOriginalDesignSource(sourceId: string, workspaceId: string,
  sessions: Awaited<ReturnType<typeof currentDraft>>["sessions"], context: ReviewContext) {
  if (sourceId.startsWith("lead-turn:")) return readLeadUserSource(sourceId.slice("lead-turn:".length), sessions, context);
  if (sourceId.startsWith("consultation-")) {
    const raw = await context.state.get({ scopeKind: "company", scopeId: workspaceId,
      namespace: "sonpark.my-builder", stateKey: "snapshot.v1" } satisfies SpsStateKey);
    const snapshot = parseBuilderSnapshot(raw ?? createEmptyBuilderSnapshot(workspaceId), workspaceId);
    const message = snapshot.messages.find(item => item.id === sourceId && item.role === "user"
      && item.channel === "main" && item.actorId === null);
    if (!message || !message.text.trim()) throw new Error("Original consultation source is unavailable in this Workspace.");
    return Object.freeze({ id: message.id, text: message.text });
  }
  throw new Error("Unsupported original DesignDraft source identity.");
}

async function verifiedDraftSources(draft: AuthoredDesignDraft, workspaceId: string,
  sessions: Awaited<ReturnType<typeof currentDraft>>["sessions"], context: ReviewContext) {
  const sourceDigests = new Map(draft.sourceDigests.map(item => [item.id, item.sha256]));
  const verified = new Map<string, Readonly<{ digest: string; text: string }>>();
  for (const sourceId of draft.draft.sourceIds) {
    const source = await readOriginalDesignSource(sourceId, workspaceId, sessions, context);
    const digest = createHash("sha256").update(source.text, "utf8").digest("hex");
    if (source.id !== sourceId || sourceDigests.get(sourceId) !== digest) throw new Error("Original customer source bytes no longer match the immutable DesignDraft.");
    verified.set(sourceId, Object.freeze({ digest, text: source.text }));
  }
  return verified;
}

async function assertDraftStillCurrent(workspaceId: string, projectId: string,
  expected: Awaited<ReturnType<typeof currentDraft>>["draft"], context: ReviewContext) {
  const latest = await currentDraft(workspaceId, projectId, context);
  if (latest.draft.sequence !== expected.sequence || JSON.stringify(latest.draft.revision) !== JSON.stringify(expected.revision)) {
    throw new Error("The current DesignDraft changed during review. Refresh without automatically retrying.");
  }
}

async function assertBaselinePin(workspaceId: string, projectId: string, expected: FirstDesignReviewBaselinePin | null,
  context: ReviewContext) {
  const actual = await currentBaselinePin(workspaceId, projectId, context);
  if (!sameBaselinePin(actual, expected)) throw new Error("The Baseline changed during design review. Refresh without automatically retrying.");
}

async function baselinePinIsCurrent(workspaceId: string, projectId: string, expected: FirstDesignReviewBaselinePin | null,
  context: ReviewContext) {
  return sameBaselinePin(await currentBaselinePin(workspaceId, projectId, context), expected);
}

/**
 * Registered-tool signature: (params, Host runContext, platform).
 * params: { projectId: companyId, expectedDraftRevisionId, expectedReviewHeadRevisionId,
 *   pack: { packId, version, applicability, rules, transitions, exceptions, excludedCombinations },
 *   sourcePins: [{ requirementId, acId, sourceId }] }.
 * Main authors the proposal; pack identity and source digests come from the verified exact Draft and original readers.
 */
export async function proposeFirstDesignReview(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  if (context.projectId !== undefined && context.projectId !== context.companyId) {
    throw new Error("First-design review requires the authenticated single-project Workspace.");
  }
  const authority = await resolveLeadToolAuthority(context, platform);
  requireLeadFormalPublicationAuthority(authority);
  const state = platform.state as typeof platform.state & RevisionState;
  const guardedContext = { ...platform, state: {
    get: async (key: SpsStateKey) => { await authority.check(); const value = await state.get(key); await authority.check(); return value; },
    compareAndSet: state.compareAndSet ? async (...args: Parameters<NonNullable<typeof state.compareAndSet>>) => {
      await authority.check(); const result = await state.compareAndSet!(...args); await authority.check(); return result;
    } : undefined,
  } } as ReviewContext;
  const workspaceId = context.companyId;
  const input = exactToolRecord(params, ["projectId", "expectedDraftRevisionId", "expectedReviewHeadRevisionId", "pack", "sourcePins"], ["designModel"]);
  if (!ID(input.projectId) || input.projectId !== workspaceId) throw new TypeError("First-design review requires the authenticated single-project Workspace ID.");
  if (!ID(input.expectedDraftRevisionId) || input.expectedReviewHeadRevisionId !== null && !ID(input.expectedReviewHeadRevisionId)) {
    throw new TypeError("Exact current DesignDraft revision and observed review head are required.");
  }
  const projectId = input.projectId;
  await authority.check();
  const priorBaseline = await currentBaselinePin(workspaceId, projectId, guardedContext);
  const { draft, sessions } = await currentDraft(workspaceId, projectId, guardedContext);
  const parsedDraft = parseDesignDraft(draft.revision.draft, projectId);
  if (parsedDraft.revisionId !== input.expectedDraftRevisionId) {
    return { status: "conflict" as const, actualDraftRevisionId: parsedDraft.revisionId, content: "DesignDraft changed; refresh before proposing." };
  }
  const sources = await verifiedDraftSources(draft.revision, workspaceId, sessions, guardedContext);
  await assertDraftStillCurrent(workspaceId, projectId, draft, guardedContext);
  await assertBaselinePin(workspaceId, projectId, priorBaseline, guardedContext);
  const identity = Object.freeze({ workspaceId, projectId, specRevisionId: parsedDraft.specification.revisionId,
    specDigest: hash(parsedDraft.specification) });
  const pack = validatePack(input.pack, identity, new Set(parsedDraft.specification.requirements.map(item => item.id)), true);
  if (!Array.isArray(input.sourcePins) || Object.getPrototypeOf(input.sourcePins) !== Array.prototype
    || Reflect.ownKeys(input.sourcePins).length !== input.sourcePins.length + 1) throw new TypeError("Requirement-to-source pins must be a dense list.");
  const sourcePins = Array.from({ length: input.sourcePins.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input.sourcePins, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("Source pins must be dense plain data.");
    const value = descriptor.value;
    const row = exactToolRecord(value, ["requirementId", "acId", "sourceId"]);
    if (!ID(row.requirementId) || row.acId !== null && !ID(row.acId) || typeof row.sourceId !== "string"
      || !sources.has(row.sourceId)) throw new TypeError("Source pin must cite an in-scope requirement and original source in the current DesignDraft.");
    return { requirementId: row.requirementId, acId: row.acId as string | null,
      sourceId: row.sourceId, sourceDigest: sources.get(row.sourceId)!.digest };
  });
  const base = { status: "PROPOSED" as const, workspaceId, projectId, priorBaseline,
    draftRevisionId: parsedDraft.revisionId, draftDigest: hash(parsedDraft), draft: parsedDraft,
    sourcePins, pack, author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId,
      selectionRevision: authority.selectionRevision, createdAt: new Date().toISOString() } };
  const proposed = Object.hasOwn(input, "designModel") ? { ...base,
    designModel: parseDesignModelMaterial(input.designModel, identity, parsedDraft.specification.requirements, pack, sourcePins,
      false, new Map([...sources].map(([id, source]) => [id, source.text]))) } : base;
  const fingerprint = proposalFingerprint(proposed);
  await authority.check();
  const store = createFirstDesignReviewStore(workspaceId, projectId, state);
  const current = await store.current();
  if (current?.revision.status === "PROPOSED" && proposalFingerprint(current.revision) === fingerprint) {
    return { status: "replayed" as const, revision: current.revision,
      content: "Exact current proposal replayed; no new revision was written." };
  }
  const actualHead = current?.revision.revisionId ?? null;
  if (actualHead !== input.expectedReviewHeadRevisionId) {
    return { status: "conflict" as const, actualReviewHeadRevisionId: actualHead,
      actualDraftRevisionId: parsedDraft.revisionId, content: "Review head changed; refresh before proposing. No revision was overwritten." };
  }
  const revisionId = `first-review-${hash([fingerprint, actualHead])}`;
  const proposal = parseBundle({ ...proposed, revisionId }, workspaceId, projectId);
  await authority.check();
  const result = await store.proposeCAS({ expectedBaseRevisionId: actualHead, revision: proposal });
  await assertBaselinePin(workspaceId, projectId, priorBaseline, guardedContext);
  await authority.check();
  return result.status === "conflict"
    ? { status: "conflict" as const, actualReviewHeadRevisionId: result.actualBaseRevisionId,
      content: "Review head changed during proposal publication; refresh before proposing." }
    : { status: result.status, revision: result.revision,
      content: "Initial design review proposal stored. It is not approved and does not publish a Baseline." };
}

/** Authenticated user approval of the exact currently stored bundle; no user ID or approval claim is accepted from params. */
export async function approveFirstDesignReview(params: unknown, context: UserReviewContext) {
  const { workspaceId, userId } = authenticatedWorkspace(context);
  const input = exactToolRecord(params, ["projectId", "expectedBundleRevisionId"]);
  if (!ID(input.projectId) || !ID(input.expectedBundleRevisionId)) throw new TypeError("Exact project and review bundle revision are required.");
  const projectId = input.projectId;
  const store = createFirstDesignReviewStore(workspaceId, projectId, context.state as RevisionState);
  const exact = await store.readExact(input.expectedBundleRevisionId);
  const current = await store.current();
  if (!exact || !current || current.revision.revisionId !== input.expectedBundleRevisionId
    || exact.revision.revisionId !== current.revision.revisionId || current.revision.status !== "PROPOSED") {
    return { status: "conflict" as const };
  }
  if (!await baselinePinIsCurrent(workspaceId, projectId, current.revision.priorBaseline, context)) return { status: "conflict" as const };
  const { draft, sessions } = await currentDraft(workspaceId, projectId, context);
  if (draft.revision.selectionRevision !== current.revision.author.selectionRevision
    || draft.revision.author.agentId !== current.revision.author.agentId
    || draft.revision.draft.revisionId !== current.revision.draftRevisionId
    || hash(draft.revision.draft) !== current.revision.draftDigest) return { status: "conflict" as const };
  const sources = await verifiedDraftSources(draft.revision, workspaceId, sessions, context);
  if (current.revision.sourcePins.some(pin => sources.get(pin.sourceId)?.digest !== pin.sourceDigest)) return { status: "conflict" as const };
  await assertDraftStillCurrent(workspaceId, projectId, draft, context);
  if (!await baselinePinIsCurrent(workspaceId, projectId, current.revision.priorBaseline, context)) return { status: "conflict" as const };
  const latest = await store.current();
  if (!latest || latest.revision.revisionId !== current.revision.revisionId || latest.revision.status !== "PROPOSED") return { status: "conflict" as const };
  const approval = Object.freeze({ userId, approvedAt: new Date().toISOString(), attestedBundleRevisionId: current.revision.revisionId });
  const base = { ...current.revision, status: "APPROVED" as const, approval };
  const revision = parseBundle({ ...base, revisionId: `first-review-approval-${hash([base, approval])}` }, workspaceId, projectId);
  const result = await store.approveCAS({ expectedBaseRevisionId: current.revision.revisionId, revision });
  if (!await baselinePinIsCurrent(workspaceId, projectId, current.revision.priorBaseline, context)) return { status: "conflict" as const };
  return result.status === "conflict" ? result : Object.freeze({ status: result.status, revision: result.revision,
    content: "Authenticated user attested to this exact initial DesignDraft, source-pin set, and proposed rule-pack version. This is not a Baseline publication, QA acceptance, or execution permission." });
}

export type CurrentFirstDesignApprovalBinding = Readonly<{
  workspaceId: string;
  projectId: string;
  approvedRevisionId: string;
  proposalRevisionId: string;
  reviewReference: string;
  sequence: number;
  bundleDigest: string;
  bundle: FirstDesignReviewBundle;
}>;

/** Exact historical lookup for Baseline readers. It returns no customer-source text. */
export async function readFirstDesignReviewRevision(workspaceId: string, projectId: string, revisionId: string, state: RevisionState) {
  if (!ID(revisionId)) throw new TypeError("An exact first-design review revision ID is required.");
  return (await createFirstDesignReviewStore(workspaceId, projectId, state).readExact(revisionId))?.revision ?? null;
}

export async function readFirstDesignApprovalRevision(workspaceId: string, projectId: string, approvedRevisionId: string, state: RevisionState) {
  const exact = await readFirstDesignReviewRevision(workspaceId, projectId, approvedRevisionId, state);
  return exact?.status === "APPROVED" && exact.approval?.attestedBundleRevisionId !== exact.revisionId ? exact : null;
}

/** Main publication preflight: current approved head, exact Draft, and original source bytes must all still match. */
export async function assertCurrentFirstDesignApproval(params: unknown, runContext: unknown,
  platform: SpsPlatformInvocationContext): Promise<CurrentFirstDesignApprovalBinding | null> {
  const context = parseLeadToolContext(runContext);
  if (context.projectId !== undefined && context.projectId !== context.companyId) {
    throw new Error("First-design Baseline binding requires the authenticated single-project Workspace.");
  }
  const authority = await resolveLeadToolAuthority(context, platform);
  requireLeadFormalPublicationAuthority(authority);
  const input = exactToolRecord(params, ["projectId", "approvedRevisionId"]);
  if (input.projectId !== context.companyId || !ID(input.approvedRevisionId)) {
    throw new TypeError("Exact authenticated Workspace project and approved review revision are required.");
  }
  const workspaceId = context.companyId, projectId = input.projectId as string;
  const state = platform.state as typeof platform.state & RevisionState;
  const guardedContext = { ...platform, state: {
    get: async (key: SpsStateKey) => { await authority.check(); const value = await state.get(key); await authority.check(); return value; },
    compareAndSet: state.compareAndSet ? async (...args: Parameters<NonNullable<typeof state.compareAndSet>>) => {
      await authority.check(); const result = await state.compareAndSet!(...args); await authority.check(); return result;
    } : undefined,
  } } as ReviewContext;
  const reviewStore = createFirstDesignReviewStore(workspaceId, projectId, state);
  const [exact, current] = await Promise.all([reviewStore.readExact(input.approvedRevisionId as string), reviewStore.current()]);
  if (!exact || !current || current.revision.revisionId !== input.approvedRevisionId
    || exact.revision.revisionId !== current.revision.revisionId || exact.revision.status !== "APPROVED"
    || !exact.revision.approval || exact.revision.approval.attestedBundleRevisionId === exact.revision.revisionId) return null;
  const { draft, sessions } = await currentDraft(workspaceId, projectId, guardedContext);
  const normalizedDraft = parseDesignDraft(draft.revision.draft, projectId);
  if (draft.revision.selectionRevision !== exact.revision.author.selectionRevision
    || draft.revision.author.agentId !== exact.revision.author.agentId
    || normalizedDraft.revisionId !== exact.revision.draftRevisionId
    || hash(normalizedDraft) !== exact.revision.draftDigest
    || JSON.stringify(normalizedDraft) !== JSON.stringify(exact.revision.draft)) return null;
  const sources = await verifiedDraftSources(draft.revision, workspaceId, sessions, guardedContext);
  if (exact.revision.sourcePins.some(pin => sources.get(pin.sourceId)?.digest !== pin.sourceDigest)) return null;
  await assertDraftStillCurrent(workspaceId, projectId, draft, guardedContext);
  await assertBaselinePin(workspaceId, projectId, exact.revision.priorBaseline, guardedContext);
  const latest = await reviewStore.current();
  if (!latest || latest.revision.revisionId !== exact.revision.revisionId || latest.revision.status !== "APPROVED") return null;
  const latestDraft = await currentDraft(workspaceId, projectId, guardedContext);
  if (latestDraft.draft.sequence !== draft.sequence || JSON.stringify(latestDraft.draft.revision) !== JSON.stringify(draft.revision)) return null;
  const latestSources = await verifiedDraftSources(latestDraft.draft.revision, workspaceId, latestDraft.sessions, guardedContext);
  if (exact.revision.sourcePins.some(pin => latestSources.get(pin.sourceId)?.digest !== pin.sourceDigest)) return null;
  await assertBaselinePin(workspaceId, projectId, exact.revision.priorBaseline, guardedContext);
  await authority.check();
  const bundleDigest = hash(exact.revision);
  return Object.freeze({ workspaceId, projectId, approvedRevisionId: exact.revision.revisionId,
    proposalRevisionId: exact.revision.approval.attestedBundleRevisionId,
    reviewReference: "first-design-review:" + exact.revision.revisionId,
    sequence: current.sequence, bundleDigest, bundle: exact.revision });
}

/** Main integration may bind only this immutable approved record and must revalidate the current Draft and source bytes before publication. */
export async function readFirstDesignReviewBundle(workspaceId: string, projectId: string, state: RevisionState) {
  return (await createFirstDesignReviewStore(workspaceId, projectId, state).current())?.revision ?? null;
}

export async function readFirstDesignApprovalBinding(workspaceId: string, projectId: string, state: RevisionState) {
  const current = await createFirstDesignReviewStore(workspaceId, projectId, state).current();
  if (!current || current.revision.status !== "APPROVED" || !current.revision.approval
    || !ID(current.revision.approval.attestedBundleRevisionId)
    || current.revision.approval.attestedBundleRevisionId === current.revision.revisionId) return null;
  return Object.freeze({ workspaceId, projectId, reviewRevisionId: current.revision.revisionId,
    bundle: current.revision,
    draftRevisionId: current.revision.draftRevisionId, draftDigest: current.revision.draftDigest,
    sourcePins: current.revision.sourcePins, packId: current.revision.pack.packId,
    packVersion: current.revision.pack.version, packDigest: hash(current.revision.pack),
    userId: current.revision.approval.userId, approvedAt: current.revision.approval.approvedAt,
    attestedBundleRevisionId: current.revision.approval.attestedBundleRevisionId });
}
