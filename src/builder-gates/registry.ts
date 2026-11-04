import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseLeadToolContext, resolveLeadToolAuthority, requireLeadFormalPublicationAuthority } from "../lead-tool-authority.ts";
import { resolveCtoPlanningAuthority } from "../cto-planning-authority.ts";
import { taskPacketRecordDigest, type TaskPacketDependencyPin, type TaskPacketRecord } from "../domain/task-packets.ts";
import type { ApprovedSpecRevision } from "../domain/specification-revisions.ts";
import type { WorkstreamRecord } from "../domain/workstreams.ts";
import type { CtoDelivery } from "../domain/cto-deliveries.ts";
import type { UiRevision } from "../ui-contracts/domain.ts";
import type { ChangeImpactResult } from "../change-impact/index.ts";
import { createSolutionRevisionStore, type RevisionState } from "../solution-revision-store.ts";
import { createUiContractStore } from "../ui-contracts/store.ts";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import { createWorkstreamStore } from "../workstream-tools.ts";
import { createCtoDeliveryStore } from "../cto-delivery-store.ts";
import type { BuilderGateId, EvidencePin, GateScopeSnapshot } from "./index.ts";
import { isHostBoundRegistry } from "./provider-brand.ts";
import type { BaselineApprovalRecord, RequirementRuleProposalRecord } from "./records.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const samePin = (left: EvidencePin, right: EvidencePin): boolean => left.sourceId === right.sourceId
  && left.revisionId === right.revisionId && left.sha256 === right.sha256;
const sameSnapshot = (left: GateScopeSnapshot, right: GateScopeSnapshot): boolean =>
  left.workspaceId === right.workspaceId && left.projectId === right.projectId && left.scopeId === right.scopeId
  && left.revisionId === right.revisionId && left.pins.length === right.pins.length
  && [...left.pins].sort((a, b) => a.sourceId.localeCompare(b.sourceId, "en"))
    .every((pin, index) => samePin(pin, [...right.pins].sort((a, b) => a.sourceId.localeCompare(b.sourceId, "en"))[index]));

function recordsMatchScope(snapshot: GateScopeSnapshot, records: RegistryDomainRecords): boolean {
  if (records.spec && (records.spec.projectId !== snapshot.projectId
    || !snapshot.pins.some(pin => pin.revisionId === records.spec!.revisionId))) return false;
  if (records.workstream && (records.workstream.spec.projectId !== snapshot.projectId
    || !snapshot.pins.some(pin => pin.revisionId === String(records.workstream!.spec.revision)))) return false;
  if (records.taskPacket && (records.taskPacket.packet.projectId !== snapshot.projectId
    || records.taskPacket.packet.taskId !== snapshot.scopeId
    || !snapshot.pins.some(pin => pin.revisionId === String(records.taskPacket!.packet.revision)))) return false;
  if (records.ctoDelivery && (records.ctoDelivery.projectId !== snapshot.projectId
    || records.ctoDelivery.workspaceId !== snapshot.workspaceId
    || records.ctoDelivery.instruction.spec.id !== snapshot.scopeId)) return false;
  if (records.uiRevision && (records.uiRevision.projectId !== snapshot.projectId
    || !snapshot.pins.some(pin => pin.revisionId === records.uiRevision!.revisionId))) return false;
  if (records.changeImpact && (records.changeImpact.workspaceId !== snapshot.workspaceId
    || records.changeImpact.projectId !== snapshot.projectId)) return false;
  return true;
}

export type RegistryLookup<T> =
  | Readonly<{ status: "found"; value: T }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "unavailable"; reason?: string }>;

/** Stored domain records that a Registry adapter must bind to its current scope record. */
export type RegistryDomainRecords = Readonly<{
  spec?: ApprovedSpecRevision;
  workstream?: WorkstreamRecord;
  taskPacket?: TaskPacketRecord;
  taskDependencies?: readonly TaskPacketDependencyPin[];
  ctoDelivery?: CtoDelivery;
  uiRevision?: UiRevision;
  changeImpact?: ChangeImpactResult;
}>;
export type StoredGateScope = Readonly<{ snapshot: GateScopeSnapshot; records: RegistryDomainRecords }>;
export type StoredGateSource = Readonly<{ sourceId: string; scopeId: string; revisionId: string; bytes: Uint8Array }>;
export type StoredChecker = Readonly<{ checkerId: string; checkerVersion: string; implementation: EvidencePin }>;
export type StoredQaEvidence = Readonly<{
  actorId: string;
  target: GateScopeSnapshot;
  command: string;
  exitCode: number;
  result: "passed" | "failed" | "unknown";
  report: EvidencePin;
}>;
export type JointBaselineApproval = Readonly<{ proposal: RequirementRuleProposalRecord; approval: BaselineApprovalRecord }>;
export type JointBaselineApprovalTarget = Readonly<{
  proposalId: string;
  proposal: EvidencePin;
  baseline: EvidencePin;
  specification: EvidencePin;
  graph: EvidencePin;
}>;

/**
 * Registry adapter boundary. These are lookups of stored/current records, not
 * booleans supplied by a model. Missing methods are reported as required lookups.
 */
export type BuilderGateRegistry = Readonly<{
  lookupCurrentScope?: (workspaceId: string, projectId: string, scopeId: string) => Promise<RegistryLookup<StoredGateScope>>;
  lookupCurrentRevision?: (scopeId: string, expected: EvidencePin) => Promise<RegistryLookup<EvidencePin>>;
  lookupCurrentTaskDependencies?: (workspaceId: string, projectId: string, packet: TaskPacketRecord) => Promise<RegistryLookup<readonly TaskPacketRecord[]>>;
  lookupSource?: (sourceId: string, scopeId: string, revisionId: string) => Promise<RegistryLookup<StoredGateSource>>;
  lookupChecker?: (checkerId: string, checkerVersion: string) => Promise<RegistryLookup<StoredChecker>>;
  lookupIndependentQa?: (target: GateScopeSnapshot) => Promise<RegistryLookup<StoredQaEvidence>>;
  lookupJointBaselineApproval?: (target: JointBaselineApprovalTarget) => Promise<RegistryLookup<JointBaselineApproval>>;
  resolveAuthority?: (request: GateAuthorityRequest) => Promise<ResolvedGateAuthority>;
}>;

export type GateAuthorityRequest =
  | Readonly<{ kind: "lead"; runContext: unknown; platform: SpsPlatformInvocationContext; formalPublication: boolean }>
  | Readonly<{ kind: "cto"; projectId: string; ctoId: string; workstreamId: string; runContext: unknown;
      platform: SpsPlatformInvocationContext; toolName: string }>;
export type ResolvedGateAuthority = Readonly<{ actorId: string; workspaceId: string; scopeId: string;
  check: () => Promise<void> }>;

/** Resolve authority through the existing current-run/current-assignment guards. */
export async function resolveGateAuthority(request: GateAuthorityRequest): Promise<ResolvedGateAuthority> {
  if (request.kind === "lead") {
    const context = parseLeadToolContext(request.runContext);
    const authority = await resolveLeadToolAuthority(context, request.platform);
    if (request.formalPublication) requireLeadFormalPublicationAuthority(authority);
    await authority.check();
    return Object.freeze({ actorId: context.agentId, workspaceId: context.companyId, scopeId: context.projectId ?? context.companyId,
      check: authority.check });
  }
  const authority = await resolveCtoPlanningAuthority(request.projectId, request.ctoId, request.workstreamId,
    request.runContext, request.platform, request.toolName);
  await authority.check();
  return Object.freeze({ actorId: authority.context.agentId, workspaceId: authority.context.companyId,
    scopeId: authority.source.workstreamId, check: authority.check });
}

const registryResolutionBrand: unique symbol = Symbol("builder-gate-registry-resolution");
const mintedResolutions = new WeakSet<object>();
export type RegistryResolution = Readonly<{
  readonly [registryResolutionBrand]: true;
  gateId: BuilderGateId;
  target: GateScopeSnapshot;
  status: "RESOLVED" | "UNKNOWN";
  requiredLookups: readonly string[];
  checker: StoredChecker | null;
  resolved: Readonly<{ currentScope: StoredGateScope | null; authority: ResolvedGateAuthority | null;
    qa: StoredQaEvidence | null; sources: readonly EvidencePin[] }>;
  limitations: readonly string[];
}>;
export type ResolveRegistryInput = Readonly<{
  gateId: BuilderGateId;
  expected: GateScopeSnapshot;
  checkerId: string;
  checkerVersion: string;
  authority: GateAuthorityRequest;
  requireQa: boolean;
  evidenceRefs: readonly EvidencePin[];
  /** Exact user-approved requirement/rule proposal and baseline revision. Omission stays UNKNOWN. */
  jointBaselineApproval?: JointBaselineApprovalTarget;
}>;

const UNAVAILABLE = (name: string): RegistryLookup<never> => ({ status: "unavailable", reason: `${name}-provider-unavailable` });
async function safeLookup<T>(name: string, lookup: () => Promise<RegistryLookup<T>>): Promise<RegistryLookup<T>> {
  try {
    const result: unknown = await lookup();
    if (!result || typeof result !== "object") return UNAVAILABLE(name);
    const candidate = result as { status?: unknown; value?: unknown };
    if (candidate.status === "missing") return { status: "missing" };
    if (candidate.status === "unavailable") return UNAVAILABLE(name);
    if (candidate.status === "found" && candidate.value !== null && candidate.value !== undefined) {
      return result as RegistryLookup<T>;
    }
    return UNAVAILABLE(name);
  } catch { return UNAVAILABLE(name); }
}

async function currentTaskDependencyIssues(registry: BuilderGateRegistry, snapshot: GateScopeSnapshot,
  record: TaskPacketRecord): Promise<string[]> {
  if (!record || !Array.isArray(record.dependencyPins)) return ["validate-current-task-dependency-packets"];
  if (record.dependencyPins.length === 0) return [];
  if (!registry.lookupCurrentTaskDependencies) return ["lookup-current-task-dependency-packets"];
  const found = await safeLookup("lookup-current-task-dependency-packets",
    () => registry.lookupCurrentTaskDependencies!(snapshot.workspaceId, snapshot.projectId, record));
  if (found.status !== "found") return ["lookup-current-task-dependency-packets"];
  const issues: string[] = [];
  for (const pin of record.dependencyPins) {
    const matches = found.value.filter(candidate => candidate.packet.taskId === pin.taskId);
    if (matches.length !== 1) { issues.push(`lookup-current-task-dependency:${pin.taskId}`); continue; }
    const dependency = matches[0];
    let currentDigest: string;
    try {
      currentDigest = taskPacketRecordDigest(dependency, dependency.packet.projectId,
        dependency.packet.ctoId, dependency.packet.workstreamId);
    } catch {
      issues.push(`validate-current-task-dependency:${pin.taskId}`);
      continue;
    }
    if (dependency.packet.revision !== pin.revision || currentDigest !== pin.recordSha256) {
      issues.push(`stale-task-dependency:${pin.taskId}`);
    }
  }
  return issues;
}

/**
 * Current Registry resolver contract for G0-G7 evidence. It re-reads the scope
 * after lookup to detect races. It does not publish, dispatch, approve, or send.
 */
async function resolveBuilderGateRegistryFromProvider(input: ResolveRegistryInput,
  registry: BuilderGateRegistry | undefined): Promise<RegistryResolution> {
  const required = new Set<string>();
  let currentScope: StoredGateScope | null = null;
  let authority: ResolvedGateAuthority | null = null;
  let qa: StoredQaEvidence | null = null;
  let checker: StoredChecker | null = null;
  const sources: EvidencePin[] = [];
  const unknown = (name: string) => required.add(name);

  if (!registry?.lookupCurrentScope) unknown("lookup-current-scope");
  else {
    const found = await safeLookup("lookup-current-scope", () => registry.lookupCurrentScope!(input.expected.workspaceId, input.expected.projectId, input.expected.scopeId));
    if (found.status !== "found") unknown("lookup-current-scope");
    else if (!sameSnapshot(found.value.snapshot, input.expected)
      || !recordsMatchScope(found.value.snapshot, found.value.records)) unknown("lookup-current-scope-current-revision-and-pins");
    else currentScope = found.value;
  }

  if (!registry?.lookupCurrentRevision) unknown("lookup-current-revision-journal");
  else for (const pin of input.expected.pins) {
    const found = await safeLookup("lookup-current-revision-journal", () => registry.lookupCurrentRevision!(input.expected.scopeId, pin));
    if (found.status !== "found" || !samePin(found.value, pin)) unknown(`lookup-current-revision:${pin.sourceId}`);
  }

  if (currentScope?.records.taskPacket) {
    for (const issue of await currentTaskDependencyIssues(registry ?? {}, input.expected, currentScope.records.taskPacket)) unknown(issue);
  }

  if (input.evidenceRefs.length === 0) unknown("lookup-original-source-references-missing");
  const evidenceRefKeys = new Set<string>();
  for (const pin of input.evidenceRefs) {
    const key = `${pin.sourceId}\u0000${pin.revisionId}`;
    if (evidenceRefKeys.has(key)) unknown(`lookup-original-source-reference-duplicate:${pin.sourceId}`);
    evidenceRefKeys.add(key);
    if (!input.expected.pins.some(expected => samePin(expected, pin))) unknown(`lookup-original-source-reference-unpinned:${pin.sourceId}`);
  }

  if (!input.jointBaselineApproval || !registry?.lookupJointBaselineApproval) {
    unknown("lookup-joint-baseline-approval");
  } else {
    const target = input.jointBaselineApproval;
    const targetPins = [target.proposal, target.baseline, target.specification, target.graph];
    for (const pin of targetPins) {
      if (!input.expected.pins.some(expected => samePin(expected, pin))) unknown(`lookup-joint-baseline-pin:${pin.sourceId}`);
    }
    const found = await safeLookup("lookup-joint-baseline-approval",
      () => registry.lookupJointBaselineApproval!(target));
    if (found.status !== "found") unknown("lookup-joint-baseline-approval");
    else {
      const { proposal, approval } = found.value;
      const proposalPin = {
        sourceId: `builder-gate-proposal:${proposal.proposalId}`,
        revisionId: proposal.revisionId,
        sha256: createHash("sha256").update(JSON.stringify({ schemaVersion: proposal.schemaVersion,
          workspaceId: proposal.workspaceId, projectId: proposal.projectId, scopeId: proposal.scopeId,
          proposalId: proposal.proposalId, revisionId: proposal.revisionId, previousRevisionId: proposal.previousRevisionId,
          revision: proposal.revision, baseline: proposal.baseline, specification: proposal.specification,
          graph: proposal.graph, links: proposal.links, rulePacks: proposal.rulePacks })).digest("hex"),
      };
      if (proposal.proposalId !== target.proposalId || !samePin(proposalPin, target.proposal)
        || !samePin(proposal.baseline, target.baseline) || !samePin(proposal.specification, target.specification)
        || !samePin(proposal.graph, target.graph) || proposal.scopeId !== input.expected.scopeId
        || approval.proposalRevisionId !== proposal.revisionId || approval.proposalSha256 !== proposalPin.sha256
        || approval.state !== "formalized" || !samePin(approval.event.proposal, target.proposal)
        || !samePin(approval.event.baseline, target.baseline) || !samePin(approval.event.specification, target.specification)
        || !samePin(approval.event.graph, target.graph)) unknown("lookup-joint-baseline-approval-current-exact-binding");
      for (const link of proposal.links) for (const original of link.originals) {
        const source = await safeLookup("lookup-joint-baseline-original-source",
          () => registry.lookupSource!(original.sourceId, input.expected.scopeId, original.revisionId));
        if (!registry.lookupSource || source.status !== "found" || source.value.sourceId !== original.sourceId
          || source.value.scopeId !== input.expected.scopeId || source.value.revisionId !== original.revisionId
          || sha256(source.value.bytes) !== original.sha256) unknown(`lookup-joint-baseline-original-source:${original.sourceId}`);
        const current = await safeLookup("lookup-joint-baseline-current-revision",
          () => registry.lookupCurrentRevision!(input.expected.scopeId, original));
        if (!registry.lookupCurrentRevision || current.status !== "found" || !samePin(current.value, original)) {
          unknown(`lookup-joint-baseline-current-revision:${original.sourceId}`);
        }
      }
    }
  }

  if (!registry?.lookupSource) unknown("lookup-original-source-bytes");
  else for (const pin of input.evidenceRefs) {
    const found = await safeLookup("lookup-original-source-bytes", () => registry.lookupSource!(pin.sourceId, input.expected.scopeId, pin.revisionId));
    if (found.status !== "found" || found.value.scopeId !== input.expected.scopeId
      || found.value.sourceId !== pin.sourceId || found.value.revisionId !== pin.revisionId
      || sha256(found.value.bytes) !== pin.sha256) unknown(`lookup-original-source:${pin.sourceId}`);
    else sources.push(pin);
  }

  if (!registry?.lookupChecker) unknown("lookup-approved-checker-registry");
  else {
    const found = await safeLookup("lookup-approved-checker-registry", () => registry.lookupChecker!(input.checkerId, input.checkerVersion));
    if (found.status !== "found" || found.value.checkerId !== input.checkerId
      || found.value.checkerVersion !== input.checkerVersion
      || !input.expected.pins.some(pin => samePin(pin, found.status === "found" ? found.value.implementation : pin))) {
      unknown("lookup-approved-checker-registry-current-pin");
    } else checker = found.value;
  }

  try {
    if (!registry?.resolveAuthority) unknown(input.authority.kind === "lead"
      ? "resolve-current-lead-authority" : "resolve-current-cto-planning-authority");
    else authority = await registry.resolveAuthority(input.authority);
    if (authority) {
    const authorityScopeMatches = input.authority.kind === "lead"
      ? authority.scopeId === input.expected.projectId || authority.scopeId === input.expected.scopeId
      : authority.scopeId === input.expected.scopeId;
    if (authority.workspaceId !== input.expected.workspaceId || !authorityScopeMatches) {
      unknown("resolve-current-authority-scope");
    }
    }
  } catch {
    unknown(input.authority.kind === "lead" ? "resolve-current-lead-authority" : "resolve-current-cto-planning-authority");
    authority = null;
  }

  if (input.requireQa) {
    if (!registry?.lookupIndependentQa) unknown("lookup-independent-qa-evidence");
    else {
      const found = await safeLookup("lookup-independent-qa-evidence", () => registry.lookupIndependentQa!(input.expected));
      if (found.status !== "found") unknown("lookup-independent-qa-evidence");
      else {
        const qaRecord = found.value;
        qa = qaRecord;
        if (qaRecord.actorId === authority?.actorId) unknown("lookup-independent-qa-identity");
        if (!sameSnapshot(qaRecord.target, input.expected)) unknown("lookup-independent-qa-current-target");
        if (!qaRecord.command.trim() || qaRecord.exitCode !== 0 || qaRecord.result !== "passed") unknown("lookup-independent-qa-passing-result");
        if (!registry?.lookupSource) unknown("lookup-independent-qa-report-source");
        else {
          const report = await safeLookup("lookup-independent-qa-report-source", () => registry.lookupSource!(qaRecord.report.sourceId, input.expected.scopeId, qaRecord.report.revisionId));
          if (report.status !== "found" || report.value.scopeId !== input.expected.scopeId
            || report.value.sourceId !== qaRecord.report.sourceId || report.value.revisionId !== qaRecord.report.revisionId
            || sha256(report.value.bytes) !== qaRecord.report.sha256) unknown("lookup-independent-qa-report-source");
          else sources.push(qaRecord.report);
        }
      }
    }
  }

  if (registry?.lookupCurrentScope && currentScope) {
    const latest = await safeLookup("lookup-current-scope", () => registry.lookupCurrentScope!(input.expected.workspaceId, input.expected.projectId, input.expected.scopeId));
    if (latest.status !== "found" || !sameSnapshot(latest.value.snapshot, input.expected)
      || !recordsMatchScope(latest.value.snapshot, latest.value.records)) unknown("recheck-current-scope-revision-and-pins");
  }
  if (registry?.lookupCurrentRevision) {
    for (const pin of input.expected.pins) {
      const latest = await safeLookup("lookup-current-revision-journal", () => registry.lookupCurrentRevision!(input.expected.scopeId, pin));
      if (latest.status !== "found" || !samePin(latest.value, pin)) unknown(`recheck-current-revision:${pin.sourceId}`);
    }
  }
  if (registry && currentScope?.records.taskPacket) {
    for (const issue of await currentTaskDependencyIssues(registry, input.expected, currentScope.records.taskPacket)) {
      unknown(`recheck-${issue}`);
    }
  }
  if (authority) {
    try { await authority.check(); }
    catch { unknown("recheck-current-authority"); authority = null; }
  }

  // Injected adapters remain useful for deterministic validation tests, but
  // cannot become a production authority path. The code-owned Host factory is
  // the only source allowed to omit this dependency.
  if (!isHostBoundRegistry(registry)) required.add("trusted-production-registry-unavailable");
  const requiredLookups = [...required].sort((a, b) => a.localeCompare(b, "en"));
  const status = requiredLookups.length === 0 && isHostBoundRegistry(registry) ? "RESOLVED" as const : "UNKNOWN" as const;
  const base = { gateId: input.gateId, target: input.expected, status,
    requiredLookups: Object.freeze(requiredLookups), checker,
    resolved: Object.freeze({ currentScope, authority: requiredLookups.length === 0 ? authority : null, qa, sources: Object.freeze(sources) }),
    limitations: Object.freeze(["The Registry adapter must read authoritative stored records and return their original scope/revision identity.",
      "Registry resolution is not a Host/Runner enforcement point and cannot claim product acceptance.",
      "The existing revision journal CAS protects one head; this lookup does not create a multi-key transaction."]),
  };
  const result = { ...base } as RegistryResolution;
  Object.defineProperty(result, registryResolutionBrand, { value: true, enumerable: false });
  mintedResolutions.add(result);
  return Object.freeze(result);
}

export async function resolveBuilderGateRegistry(input: ResolveRegistryInput,
  registry: BuilderGateRegistry | undefined): Promise<RegistryResolution> {
  try { return await resolveBuilderGateRegistryFromProvider(input, registry); }
  catch {
    const result = { gateId: input?.gateId, target: input?.expected, status: "UNKNOWN" as const,
      requiredLookups: Object.freeze(["registry-provider-malformed-or-threw"]), checker: null,
      resolved: Object.freeze({ currentScope: null, authority: null, qa: null, sources: Object.freeze([]) }),
      limitations: Object.freeze(["No trusted production Registry provider is wired; this result cannot authorize."]) } as unknown as RegistryResolution;
    Object.defineProperty(result, registryResolutionBrand, { value: true, enumerable: false });
    mintedResolutions.add(result);
    return Object.freeze(result);
  }
}

export function isTrustedRegistryResolution(value: unknown): value is RegistryResolution {
  return Boolean(value && typeof value === "object" && mintedResolutions.has(value));
}

/** Adapter shape for existing Builder revision journals. */
export type CurrentRevisionJournal<T> = Readonly<{
  current(): Promise<Readonly<{ sequence: number; revision: T }> | null>;
  publishedRevision(revisionId: string, maximum?: number): Promise<Readonly<{ sequence: number; revision: T }> | null>;
}>;
export type NormalizedRecordDigest = Readonly<{ revisionId: string; normalizedRecordSha256: string }>;
export type CurrentJournalRevision = Readonly<{ sequence: number; revisionId: string }>;
/**
 * Read the current revision identity from the validated journal API. `found`
 * means the journal contains this current validated record; it is not proof
 * of source bytes, authority, approval, or approved current business state.
 */
export async function lookupJournalCurrentRevision<T>(journal: CurrentRevisionJournal<T>, expectedRevisionId: string,
  getRevisionId: (revision: T) => string, pin: EvidencePin): Promise<RegistryLookup<EvidencePin>> {
  try {
    const current = await journal.current();
    if (!current || getRevisionId(current.revision) !== expectedRevisionId
      || pin.revisionId !== expectedRevisionId) return { status: "missing" };
    // Preserve the original four-argument consumer contract. The returned pin
    // is the caller's value after a current journal ID match; it is not derived
    // from journal bytes and must never be used as original-source proof.
    return { status: "found", value: pin };
  } catch {
    return { status: "unavailable", reason: "revision-journal-unavailable-or-invalid" };
  }
}

/**
 * Digest of JSON.stringify(record) returned by the validated journal API;
 * `found` means stored validated-record digest match only, not journal
 * envelope/source-byte proof, authority, approval, or approved current
 * business state.
 */
export async function lookupJournalCurrentRecordDigest<T>(journal: CurrentRevisionJournal<T>, revisionId: string,
  getRevisionId: (revision: T) => string, expectedNormalizedRecordSha256: string): Promise<RegistryLookup<NormalizedRecordDigest>> {
  try {
    const current = await journal.current();
    if (!current || getRevisionId(current.revision) !== revisionId) return { status: "missing" };
    // This is only a digest of the normalized record returned by the journal.
    // The journal's head digest covers its full envelope; this is not source-byte verification.
    const bytes = new TextEncoder().encode(JSON.stringify(current.revision));
    const normalizedRecordSha256 = sha256(bytes);
    const actual = Object.freeze({ revisionId, normalizedRecordSha256 });
    return normalizedRecordSha256 === expectedNormalizedRecordSha256 ? { status: "found", value: actual } : { status: "missing" };
  } catch {
    return { status: "unavailable", reason: "revision-journal-unavailable-or-invalid" };
  }
}

/**
 * Current Graph revision adapter backed by the existing immutable CAS journal.
 * `found` means a stored validated current journal record, not source proof,
 * authority, approval, or approved current business state.
 */
export async function lookupCurrentSolutionRevision(workspaceId: string, projectId: string, state: RevisionState,
  expectedRevisionId: string): Promise<RegistryLookup<Readonly<{ sequence: number; revisionId: string }>>> {
  try {
    const current = await createSolutionRevisionStore(workspaceId, projectId, state).current();
    if (!current || current.revision.graphRevisionId !== expectedRevisionId) return { status: "missing" };
    return { status: "found", value: Object.freeze({ sequence: current.sequence, revisionId: current.revision.graphRevisionId }) };
  } catch {
    return { status: "unavailable", reason: "solution-revision-journal-unavailable-or-invalid" };
  }
}

/**
 * Digest of JSON.stringify(record) returned by the validated current journal
 * API; `found` is stored validated-record identity only, not authority,
 * approval, or approved current business state.
 */
export async function lookupCurrentSolutionRevisionRecordDigest(workspaceId: string, projectId: string, state: RevisionState,
  expectedRevisionId: string, expectedNormalizedRecordSha256: string): Promise<RegistryLookup<NormalizedRecordDigest>> {
  try {
    const journal = createSolutionRevisionStore(workspaceId, projectId, state);
    return await lookupJournalCurrentRecordDigest(journal, expectedRevisionId, revision => revision.graphRevisionId,
      expectedNormalizedRecordSha256);
  } catch {
    return { status: "unavailable", reason: "solution-revision-journal-unavailable-or-invalid" };
  }
}

/**
 * Reads a validated formal UI record through the existing publication lookup.
 * `found` means that stored record passed that lookup's checks; it does not
 * independently prove source bytes or current approved business state.
 */
export async function lookupPublishedFormalUiRevision(workspaceId: string, projectId: string, state: RevisionState,
  revisionId: string, runContext: unknown, platform: SpsPlatformInvocationContext): Promise<RegistryLookup<UiRevision>> {
  try {
    const store = createUiContractStore(workspaceId, projectId, state);
    const found = await store.publishedFormal(revisionId, runContext as Parameters<typeof store.publishedFormal>[1], platform);
    if (!found || found.revision.publication !== "formal") return { status: "missing" };
    return { status: "found", value: found.revision };
  } catch {
    return { status: "unavailable", reason: "published-formal-ui-revision-unavailable-or-unauthorized" };
  }
}

/**
 * Reads the current formal UI head through the existing current Lead authority
 * check. `found` is a validated stored record returned after that check, not
 * proof of original source bytes or a broader approval decision.
 */
export async function lookupCurrentFormalUiRevision(workspaceId: string, projectId: string, state: RevisionState,
  runContext: unknown, platform: SpsPlatformInvocationContext): Promise<RegistryLookup<UiRevision>> {
  try {
    const store = createUiContractStore(workspaceId, projectId, state);
    const found = await store.currentFormal(runContext as Parameters<typeof store.currentFormal>[0], platform);
    if (!found || found.revision.publication !== "formal") return { status: "missing" };
    return { status: "found", value: found.revision };
  } catch {
    return { status: "unavailable", reason: "current-formal-ui-revision-unavailable-or-unauthorized" };
  }
}

/**
 * Reads a Task Packet only from the current validated persisted board for its
 * exact project/CTO/Workstream tuple. `found` means stored validated record
 * only, not authority, approval, or approved current business state.
 */
export async function lookupCurrentTaskPacketRecord(workspaceId: string, projectId: string, ctoId: string,
  workstreamId: string, taskId: string, state: RevisionState): Promise<RegistryLookup<TaskPacketRecord>> {
  try {
    const board = await createTaskPacketStore(workspaceId, projectId, ctoId, workstreamId, state).current();
    if (!board) return { status: "missing" };
    const matches = board.revision.packets.filter(record => record.packet.taskId === taskId);
    return matches.length === 1 ? { status: "found", value: matches[0] } : { status: "missing" };
  } catch {
    return { status: "unavailable", reason: "current-task-packet-board-unavailable-or-invalid" };
  }
}

/**
 * Reads a Workstream only from the current validated persisted board. `found`
 * means stored validated record only, not authority, approval, or approved
 * current business state.
 */
export async function lookupCurrentWorkstreamRecord(workspaceId: string, projectId: string,
  workstreamId: string, state: RevisionState): Promise<RegistryLookup<WorkstreamRecord>> {
  try {
    const board = await createWorkstreamStore(workspaceId, projectId, state).current();
    if (!board) return { status: "missing" };
    const matches = board.revision.workstreams.filter(record => record.spec.id === workstreamId);
    return matches.length === 1 ? { status: "found", value: matches[0] } : { status: "missing" };
  } catch {
    return { status: "unavailable", reason: "current-workstream-board-unavailable-or-invalid" };
  }
}

/**
 * Reads a CTO delivery only from its current validated project/CTO journal.
 * `found` means stored validated record only, not execution proof, authority,
 * approval, or approved current business state.
 */
export async function lookupCurrentCtoDeliveryRecord(workspaceId: string, projectId: string, ctoId: string,
  workstreamId: string, state: RevisionState): Promise<RegistryLookup<CtoDelivery>> {
  try {
    const current = await createCtoDeliveryStore(workspaceId, projectId, ctoId, state).current();
    if (!current || current.revision.instruction.spec.id !== workstreamId) return { status: "missing" };
    return { status: "found", value: current.revision };
  } catch {
    return { status: "unavailable", reason: "current-cto-delivery-unavailable-or-invalid" };
  }
}
