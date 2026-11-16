import { createHash, randomUUID } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";
import { createCurrentBaselineAssuranceProvider } from "./current-baseline-provider.ts";
import { assuranceGapFingerprint, createSpecAssuranceConsumer, type AssuranceGap, type AssuranceResult,
  type CoverageAuthorityStatus } from "./evaluator.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CANDIDATES = 256;

type SpecGapObservation = Readonly<{
  schemaVersion: 1;
  revisionId: string;
  baselineRevisionId: string;
  requirementId: string;
  identity: AssuranceResult["identity"];
  checkerStatus: AssuranceResult["status"];
  coverageAuthority: CoverageAuthorityStatus;
  observationSha256: string;
  observedAt: string;
  observerRunId: string;
  observedFingerprints: readonly string[];
  candidates: readonly AssuranceGap[];
}>;

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function ids(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES || Object.keys(value).length !== value.length) {
    throw new TypeError(`Invalid ${label}.`);
  }
  const result = value.map(item => id(item, label));
  if (new Set(result).size !== result.length) throw new TypeError(`Duplicate ${label}.`);
  return Object.freeze(result);
}

function parseCandidate(value: unknown, requirementId: string, identity: AssuranceResult["identity"]): AssuranceGap {
  const row = exactToolRecord(value, ["id", "fingerprint", "requirementId", "ruleId", "sourceIds", "uiIds",
    "contractIds", "workstreamIds", "taskIds", "severity", "decisionOwnerId", "detectionMethod", "resolutionEvidence", "reason", "status"]);
  const ruleId = id(row.ruleId, "rule ID");
  const sourceIds = ids(row.sourceIds, "source ID"), uiIds = ids(row.uiIds, "UI ID"), contractIds = ids(row.contractIds, "contract ID");
  const workstreamIds = ids(row.workstreamIds, "Workstream ID"), taskIds = ids(row.taskIds, "Task ID");
  if (typeof row.reason !== "string" || !row.reason.trim() || Buffer.byteLength(row.reason, "utf8") > 4_096
    || row.status !== "candidate" || row.requirementId !== requirementId || row.severity !== null
    || row.decisionOwnerId !== null || ids(row.resolutionEvidence, "resolution evidence").length !== 0) {
    throw new TypeError("Invalid unresolved specification gap observation.");
  }
  const fingerprint = assuranceGapFingerprint(identity, { requirementId, ruleId, sourceIds, uiIds, contractIds,
    workstreamIds, taskIds, reason: row.reason });
  if (row.fingerprint !== fingerprint || row.id !== `gap-${fingerprint.slice(0, 24)}`) {
    throw new TypeError("Specification gap fingerprint does not match the observed evidence.");
  }
  return Object.freeze({ id: row.id, fingerprint, requirementId, ruleId, sourceIds, uiIds, contractIds, workstreamIds,
    taskIds, severity: null, decisionOwnerId: null, detectionMethod: id(row.detectionMethod, "detection method"),
    resolutionEvidence: Object.freeze([]), reason: row.reason, status: "candidate" });
}

function sortedCandidates(rows: readonly AssuranceGap[]) {
  return Object.freeze([...rows].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)));
}

export function createSpecGapObservationStore(workspaceId: string, baselineRevisionId: string, requirementId: string,
  identity: AssuranceResult["identity"], state: RevisionState) {
  const specIdentity = { ...identity };
  if (specIdentity.workspaceId !== workspaceId || specIdentity.projectId !== workspaceId
    || !SHA256.test(specIdentity.specDigest)) throw new TypeError("Invalid gap observation specification binding.");
  id(baselineRevisionId, "Baseline revision");
  id(requirementId, "requirement ID");
  id(specIdentity.specRevisionId, "specification revision");
  const namespace = `d3-gap-${digest([baselineRevisionId, requirementId]).slice(0, 48)}`;
  return createRevisionJournal<SpecGapObservation>(workspaceId, workspaceId, state, { prefix: namespace, revisionId: row => row.revisionId,
    parse(value) {
      const row = exactToolRecord(value, ["schemaVersion", "revisionId", "baselineRevisionId", "requirementId", "identity",
        "checkerStatus", "coverageAuthority", "observationSha256", "observedAt", "observerRunId", "observedFingerprints", "candidates"]);
      const bound = exactToolRecord(row.identity, ["workspaceId", "projectId", "specRevisionId", "specDigest"]);
      if (row.schemaVersion !== 1 || row.baselineRevisionId !== baselineRevisionId || row.requirementId !== requirementId
        || Object.entries(specIdentity).some(([key, value]) => bound[key] !== value)
        || !Array.isArray(row.candidates) || row.candidates.length > MAX_CANDIDATES) throw new TypeError("Invalid gap observation scope.");
      if (row.checkerStatus !== "PASS" && row.checkerStatus !== "FAIL" && row.checkerStatus !== "UNKNOWN" && row.checkerStatus !== "NOT_CHECKED") {
        throw new TypeError("Invalid assurance checker status.");
      }
      const coverageAuthority = id(row.coverageAuthority, "coverage observation");
      if (!["verified", "unavailable", "failed", "timeout", "identity-mismatch", "scope-mismatch"].includes(coverageAuthority)) {
        throw new TypeError("Invalid coverage observation.");
      }
      const candidates = sortedCandidates(row.candidates.map(candidate => parseCandidate(candidate, requirementId, specIdentity)));
      const byFingerprint = new Map(candidates.map(candidate => [candidate.fingerprint, candidate]));
      const observedFingerprints = [...ids(row.observedFingerprints, "observed fingerprint")].sort();
      if (byFingerprint.size !== candidates.length || observedFingerprints.some(key => !byFingerprint.has(key))
        || row.observationSha256 !== digest([row.checkerStatus, coverageAuthority, observedFingerprints.map(key => byFingerprint.get(key))])) {
        throw new TypeError("Gap observation content does not match its digest.");
      }
      const observedAt = id(row.observedAt, "observation time");
      if (!Number.isFinite(Date.parse(observedAt))) throw new TypeError("Invalid gap observation time.");
      return Object.freeze({ schemaVersion: 1 as const, revisionId: id(row.revisionId, "observation revision"),
        baselineRevisionId, requirementId, identity: Object.freeze(specIdentity), checkerStatus: row.checkerStatus,
        coverageAuthority: coverageAuthority as CoverageAuthorityStatus, observationSha256: row.observationSha256 as string, observedAt,
        observerRunId: id(row.observerRunId, "observer Run"), observedFingerprints: Object.freeze(observedFingerprints), candidates });
    } });
}

async function resolveScope(input: Record<string, unknown>, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  if (input.projectId !== context.companyId || context.projectId !== undefined && context.projectId !== context.companyId) {
    throw new TypeError("Gap observation requires the authenticated Workspace project.");
  }
  const expected = id(input.expectedBaselineRevisionId, "Baseline revision");
  const requirementId = id(input.requirementId, "requirement ID");
  const authority = await resolveLeadToolAuthority(context, platform);
  requireLeadFormalPublicationAuthority(authority);
  await authority.check();
  const state = platform.state as RevisionState;
  const baselineStore = createDesignBaselineStore(context.companyId, context.companyId, state);
  const captured = await baselineStore.current();
  if (!captured || captured.revision.revisionId !== expected) return null;
  const specification = captured.revision.specification;
  if (!specification.requirements.some(row => row.id === requirementId)) throw new Error("Requirement is not in the current approved Baseline.");
  const identity = { workspaceId: context.companyId, projectId: context.companyId, specRevisionId: specification.revisionId,
    specDigest: digest(specification) };
  const store = createSpecGapObservationStore(context.companyId, expected, requirementId, identity, state);
  const check = async () => {
    await authority.check();
    const latest = await baselineStore.current();
    return latest?.sequence === captured.sequence && digest(latest.revision) === digest(captured.revision);
  };
  return { context, authority, expected, identity, requirementId, store, check };
}

export async function recordCurrentSpecGaps(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const scope = await resolveScope(exactToolRecord(params, ["projectId", "expectedBaselineRevisionId", "requirementId"]),
    runContext, platform);
  if (!scope) return { status: "stale" as const };
  const { context, authority, expected, identity, requirementId, store, check } = scope;
  const assertActiveRun = async () => {
    const run = await platform.agents.sessions.getRun(context.sessionId, context.companyId, context.runId);
    if (!run || run.runId !== context.runId || run.status !== "running"
      || run.cancellationRequested !== false || run.termination !== "not_applicable") {
      throw new Error("Recording gap candidates requires the exact active, uncancelled Main Run.");
    }
  };
  await assertActiveRun();
  const provider = createCurrentBaselineAssuranceProvider({ workspaceId: context.companyId, projectId: context.companyId,
    sessions: authority.sessions, platform });
  const result = await createSpecAssuranceConsumer(provider)({ identity, scope: { requirementIds: [requirementId] },
    facts: [], packs: [], scenarios: [] });
  if (!await check()) return { status: "stale" as const };
  if (result.gaps.length > MAX_CANDIDATES) return { status: "unknown" as const, reason: "gap-observation-limit-exceeded" };
  const observed = sortedCandidates(result.gaps.map(gap => parseCandidate(gap, requirementId, identity)));
  const observationSha256 = digest([result.status, result.coverageAuthority, observed]);
  const head = await store.current();
  const existing = head?.revision;
  const summary = (revision: SpecGapObservation) => ({
    revisionId: revision.revisionId, baselineRevisionId: expected, requirementId, checkerStatus: revision.checkerStatus,
    coverageAuthority: revision.coverageAuthority, observedCount: revision.observedFingerprints.length,
    retainedCandidateCount: revision.candidates.length, resolution: "not-established" as const,
  });
  if (existing?.observationSha256 === observationSha256) {
    if (!await check()) return { status: "stale" as const };
    return { status: "existing" as const, ...summary(existing) };
  }
  const byFingerprint = new Map((existing?.candidates ?? []).map(gap => [gap.fingerprint, gap]));
  for (const gap of observed) byFingerprint.set(gap.fingerprint, gap);
  if (byFingerprint.size > MAX_CANDIDATES) return { status: "unknown" as const, reason: "gap-observation-limit-exceeded" };
  const revision = { schemaVersion: 1, revisionId: randomUUID(), baselineRevisionId: expected, requirementId, identity,
    checkerStatus: result.status, coverageAuthority: result.coverageAuthority, observationSha256, observedAt: new Date().toISOString(),
    observerRunId: context.runId, observedFingerprints: observed.map(gap => gap.fingerprint), candidates: sortedCandidates([...byFingerprint.values()]) };
  if (Buffer.byteLength(JSON.stringify(revision), "utf8") > 160 * 1024) {
    return { status: "unknown" as const, reason: "gap-observation-byte-limit-exceeded" };
  }
  await assertActiveRun();
  if (!await check()) return { status: "stale" as const };
  // This journal is tied to the immutable Baseline, so a later Baseline cannot inherit its candidate state.
  let confirmed: SpecGapObservation | undefined;
  try {
    const saved = await store.publish({ expectedBaseRevisionId: existing?.revisionId ?? null, revision });
    if (saved.status !== "published") return saved;
    confirmed = saved.revision;
  } catch {
    // After response loss, only the published chain can establish the write.
    try { confirmed = (await store.publishedRevision(revision.revisionId))?.revision; } catch { /* Unknown remains unknown. */ }
    if (!confirmed) return { status: "unknown" as const, reason: "gap-observation-publication-unconfirmed" };
  }
  return { status: await check() ? "recorded" as const : "recorded-historical" as const, ...summary(confirmed) };
}

export async function readCurrentSpecGaps(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "expectedBaselineRevisionId", "requirementId"],
    ["observationRevisionId", "offset"]);
  const offset = input.offset === undefined ? 0 : input.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_CANDIDATES
    || offset > 0 && input.observationRevisionId === undefined) throw new TypeError("Gap pages require a bounded offset and exact revision.");
  const expected = input.observationRevisionId === undefined ? null : id(input.observationRevisionId, "observation revision");
  const scope = await resolveScope(input, runContext, platform);
  if (!scope) return { status: "stale" as const };
  const current = await scope.store.current();
  if (!await scope.check() || expected && current?.revision.revisionId !== expected) return { status: "stale" as const };
  if (!current) return { status: "not-checked" as const };
  const { candidates, observedFingerprints, ...head } = current.revision;
  if (offset > candidates.length) throw new TypeError("Offset exceeds the observed candidate inventory.");
  const observed = new Set(observedFingerprints);
  const page = [];
  let bytes = 0;
  for (const candidate of candidates.slice(offset, offset + 20)) {
    const item = { ...candidate, presentInLatestObservation: observed.has(candidate.fingerprint) };
    bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes > 32 * 1024) break;
    page.push(item);
  }
  if (!page.length && offset < candidates.length) return { status: "unknown" as const, reason: "gap-candidate-response-limit-exceeded" };
  return { status: "available" as const, head, candidates: page, candidateCount: candidates.length, observedCount: observed.size,
    nextOffset: offset + page.length < candidates.length ? offset + page.length : null, resolution: "not-established" as const };
}
