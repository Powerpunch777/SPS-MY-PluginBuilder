import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { readWorkstreams } from "./workstream-tools.ts";
import { type RevisionState } from "./solution-revision-store.ts";
import { checkIntegrationPrerequisites, readCurrentIntegrationPlan } from "./builder-gates/integration-plan.ts";
import { managerRequestUuidForLedgerKey, resolveCurrentIntegrationManagerAuthority } from "./builder-gates/integration-manager-job.ts";
import { normalizeVerifiedWorkstreamSnapshot, readVerifiedWorkstreamReservation,
  type EvidencePin } from "./builder-gates/workstream-verification-consumer.ts";
import { createWorkstreamVerificationPublication, WORKSTREAM_VERIFIED_EVENT,
  WORKSTREAM_VERIFIED_JOB } from "./builder-gates/workstream-verification-publication.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const OPERATION = "events.observeJobWakeV1";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export type IntegrationWaitInterval = Readonly<{
  status: "measured" | "waiting" | "unavailable";
  fromAt: string | null; toAt: string | null; durationMs: number | null; reason: string | null;
}>;
export type IntegrationWaitMetric = Readonly<{
  workstreamId: string; status: "current" | "stale" | "unknown"; eventId: string | null;
  sourcePins: readonly EvidencePin[]; reason: string | null;
  queueWait: IntegrationWaitInterval;
  verifiedWakeToManagerStart: IntegrationWaitInterval;
  jobRunId: string | null;
  jobStatus: "pending" | "leased" | "delivered" | "dead" | null;
  jobRunStatus: "pending" | "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | null;
  manager: Readonly<{ agentId: string; sessionId: string; requestId: string; runId: string }> | null;
  currentPlanRevisionId: string | null;
}>;
export type IntegrationWaitMetricsRead = Readonly<{
  status: "ready"; workspaceId: string; projectId: string; observedAt: string;
  consistency: "rechecked-current-records-not-a-global-transaction";
  timeSource: "core-verified-wake-created-at-not-a-separate-publication-clock";
  planCoverage: "current-plan-context-not-historical-manager-plan-attestation";
  completionAuthority: "not-established"; workstreams: readonly IntegrationWaitMetric[];
}> | Readonly<{ status: "unknown"; reason: string }>;

const unavailable = (reason: string): IntegrationWaitInterval =>
  ({ status: "unavailable", fromAt: null, toAt: null, durationMs: null, reason });
const waiting = (fromAt: string, reason: string): IntegrationWaitInterval =>
  ({ status: "waiting", fromAt, toAt: null, durationMs: null, reason });
function instant(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError("Invalid integration wait timing.");
  }
  return Date.parse(value);
}
function interval(fromAt: string, toAt: string): IntegrationWaitInterval {
  const durationMs = instant(toAt) - instant(fromAt);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || instant(toAt) > Date.now()) {
    throw new TypeError("Inconsistent integration wait timing.");
  }
  return { status: "measured", fromAt, toAt, durationMs, reason: null };
}
function data(value: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property?.enumerable && Object.hasOwn(property, "value") ? property.value : undefined;
}
function observer(platform: SpsPlatformInvocationContext) {
  try {
    const support = exactToolRecord(data(platform, "hostSupport"), ["state", "contractVersion", "operations"]);
    const operations = support.operations;
    if (support.state !== "reported" || support.contractVersion !== "1.0" || !Array.isArray(operations)
      || operations.length > 256 || Reflect.ownKeys(operations).length !== operations.length + 1) return null;
    const names = Array.from({ length: operations.length }, (_, i) => data(operations, String(i)));
    if (names.some(name => typeof name !== "string" || !name.length || name.length > 160)
      || new Set(names).size !== names.length || !names.includes(OPERATION)) return null;
    const api = data(platform.events, "observeJobWakeV1");
    return typeof api === "function"
      ? (input: { jobKey: string; eventId: string }): Promise<unknown> => api.call(platform.events, input) : null;
  } catch { return null; }
}
function observation(raw: unknown, eventId: string) {
  const result = exactToolRecord(raw, ["status"], ["event", "run"]);
  if (result.status === "missing") { exactToolRecord(raw, ["status"]); return null; }
  exactToolRecord(raw, ["status", "event", "run"]);
  const event = exactToolRecord(result.event,
    ["eventId", "eventType", "jobKey", "status", "attemptCount", "createdAt", "deliveredAt", "nextAttemptAt"]);
  const created = instant(event.createdAt);
  instant(event.nextAttemptAt);
  if (result.status !== "observed" || event.eventId !== eventId || event.eventType !== WORKSTREAM_VERIFIED_EVENT
    || event.jobKey !== WORKSTREAM_VERIFIED_JOB || !["pending", "leased", "delivered", "dead"].includes(String(event.status))
    || !Number.isSafeInteger(event.attemptCount) || (event.attemptCount as number) < 0 || created > Date.now()
    || event.deliveredAt !== null && (instant(event.deliveredAt) < created || instant(event.deliveredAt) > Date.now()
      || event.status !== "delivered") || ["leased", "delivered"].includes(String(event.status)) && result.run === null) {
    throw new TypeError("Mismatched integration Job event.");
  }
  let run: null | { runId: string; status: NonNullable<IntegrationWaitMetric["jobRunStatus"]>; startedAt: string | null } = null;
  if (result.run !== null) {
    const row = exactToolRecord(result.run, ["runId", "status", "createdAt", "startedAt", "finishedAt"]);
    const runCreated = instant(row.createdAt);
    if (typeof row.runId !== "string" || !UUID.test(row.runId)
      || !["pending", "queued", "running", "cancelling", "succeeded", "failed", "cancelled"].includes(String(row.status))
      || runCreated < created || runCreated > Date.now()
      || row.startedAt !== null && (instant(row.startedAt) < runCreated || instant(row.startedAt) > Date.now())
      || row.finishedAt !== null && (instant(row.finishedAt) < runCreated || instant(row.finishedAt) > Date.now()
        || row.startedAt !== null && instant(row.finishedAt) < instant(row.startedAt)
        || event.deliveredAt !== null && instant(event.deliveredAt) < instant(row.finishedAt))
      || ["pending", "queued", "running", "cancelling"].includes(String(row.status)) && row.finishedAt !== null
      || event.status === "delivered" && row.status !== "succeeded") {
      throw new TypeError("Invalid integration Job Run.");
    }
    run = { runId: row.runId, status: row.status as NonNullable<IntegrationWaitMetric["jobRunStatus"]>, startedAt: row.startedAt as string | null };
  }
  return { createdAt: event.createdAt as string, status: event.status as NonNullable<IntegrationWaitMetric["jobStatus"]>, run };
}
function blank(workstreamId: string, status: IntegrationWaitMetric["status"], reason: string): IntegrationWaitMetric {
  return { workstreamId, status, eventId: null, sourcePins: [], reason, queueWait: unavailable(reason),
    verifiedWakeToManagerStart: unavailable(reason), jobRunId: null, jobStatus: null, jobRunStatus: null,
    manager: null, currentPlanRevisionId: null };
}

/** Metadata projection only. Existing current readers may perform their same-value guarded
 * observation CAS; this function never publishes a revision, schedules a Job, or starts an AI. */
export async function readIntegrationWaitMetrics(rawScope: Readonly<{ workspaceId: string; projectId: string }>,
  platform: SpsPlatformInvocationContext): Promise<IntegrationWaitMetricsRead> {
  let workspaceId: string, projectId: string;
  try {
    const scope = exactToolRecord(rawScope, ["workspaceId", "projectId"]);
    if (typeof scope.workspaceId !== "string" || !UUID.test(scope.workspaceId) || scope.projectId !== scope.workspaceId) throw new Error();
    workspaceId = scope.workspaceId; projectId = scope.projectId as string;
  } catch { return { status: "unknown", reason: "integration-wait-scope-invalid" }; }
  const heads = new Map<string, { key: SpsStateKey; value: unknown }>();
  const state: RevisionState = { ...platform.state, async get(key) {
    if (key.scopeKind !== "company" || key.scopeId !== workspaceId) throw new Error("Foreign metrics scope.");
    const value = await platform.state.get(key);
    if (!key.stateKey.includes("-revision.v1.")) {
      const id = JSON.stringify([key.namespace ?? "default", key.stateKey]), prior = heads.get(id);
      if (prior && JSON.stringify(prior.value) !== JSON.stringify(value)) throw new Error("Metrics source changed.");
      if (!prior) heads.set(id, { key, value: structuredClone(value) });
    }
    return value;
  } };
  const tracked = { ...platform, state: state as typeof platform.state };
  const check = async () => {
    for (const { key, value } of heads.values()) {
      if (JSON.stringify(await platform.state.get(key)) !== JSON.stringify(value)) throw new Error("Metrics source changed.");
    }
  };
  try {
    const board = await readWorkstreams(workspaceId, projectId, tracked);
    if (!board || board.revision.workstreams.length > 128) return { status: "unknown", reason: "integration-wait-inventory-unavailable-or-over-bound" };
    const publication = createWorkstreamVerificationPublication(state), readWake = observer(platform);
    const workstreams: IntegrationWaitMetric[] = [];
    const verifiedDigests = new Map<string, string>();
    for (const workstream of board.revision.workstreams) {
      const workstreamId = workstream.spec.id;
      const verified = await publication.readLatestCurrent({ workspaceId, projectId, workstreamId });
      if (verified.status !== "current") {
        workstreams.push(blank(workstreamId, verified.status, verified.status === "stale"
          ? "integration-wait-verification-stale" : "integration-wait-current-verification-unavailable"));
        continue;
      }
      const { snapshot } = verified, eventId = snapshot.eventId;
      verifiedDigests.set(workstreamId, digest(normalizeVerifiedWorkstreamSnapshot(snapshot)));
      const row: { -readonly [K in keyof IntegrationWaitMetric]: IntegrationWaitMetric[K] } = {
        ...blank(workstreamId, "current", "integration-wait-job-observation-unsupported"),
        eventId, sourcePins: snapshot.sourcePins.map(pin => ({ ...pin })),
      };
      if (!readWake) { workstreams.push(row); continue; }
      let managerContext;
      try {
        const plan = await readCurrentIntegrationPlan(workspaceId, tracked);
        const reservation = await readVerifiedWorkstreamReservation({ workspaceId, projectId, workstreamId, verifiedEventId: eventId }, state);
        const authority = await resolveCurrentIntegrationManagerAuthority(workspaceId, tracked);
        managerContext = plan ? { plan, reservation, authority } : null;
      } catch { managerContext = null; }
      let wake;
      try { wake = observation(await readWake({ jobKey: WORKSTREAM_VERIFIED_JOB, eventId }), eventId); }
      catch {
        workstreams.push({ ...row, reason: "integration-wait-job-observation-unavailable",
          queueWait: unavailable("integration-wait-job-observation-unavailable"),
          verifiedWakeToManagerStart: unavailable("integration-wait-job-observation-unavailable") });
        continue;
      }
      if (!wake) {
        workstreams.push({ ...row, reason: "integration-wait-job-event-missing", queueWait: unavailable("integration-wait-job-event-missing"),
          verifiedWakeToManagerStart: unavailable("integration-wait-job-event-missing") });
        continue;
      }
      row.reason = null; row.jobRunId = wake.run?.runId ?? null;
      row.jobStatus = wake.status; row.jobRunStatus = wake.run?.status ?? null;
      row.queueWait = wake.run?.startedAt ? interval(wake.createdAt, wake.run.startedAt)
        : wake.status === "pending" || wake.status === "leased" || wake.run && ["pending", "queued"].includes(wake.run.status)
          ? waiting(wake.createdAt, "integration-job-not-started") : unavailable("integration-job-start-timing-unavailable");
      row.verifiedWakeToManagerStart = unavailable("integration-manager-current-plan-or-receipt-unavailable");
      try {
        if (!managerContext) { workstreams.push(row); continue; }
        const { plan, reservation, authority } = managerContext;
        const prerequisites = await checkIntegrationPrerequisites(workspaceId, workstreamId, tracked);
        if (prerequisites.status !== "ready") { workstreams.push(row); continue; }
        row.currentPlanRevisionId = plan.revision.revisionId;
        if (!reservation || reservation.evidenceDigest !== digest(normalizeVerifiedWorkstreamSnapshot(snapshot))) {
          workstreams.push(row); continue;
        }
        if (reservation.status === "uncertain") {
          row.verifiedWakeToManagerStart = unavailable("integration-manager-request-uncertain");
          workstreams.push(row); continue;
        }
        if (reservation.status !== "accepted" || !reservation.requestId || !reservation.receipt) {
          row.verifiedWakeToManagerStart = waiting(wake.createdAt, "integration-manager-request-not-accepted");
          workstreams.push(row); continue;
        }
        const requestId = managerRequestUuidForLedgerKey(reservation.requestId);
        if (reservation.receipt.receiptId !== requestId || !UUID.test(reservation.receipt.runId)) throw new Error("Mismatched Manager receipt.");
        const request = exactToolRecord(await platform.agents.sessions.getRequest(authority.sessionId, workspaceId, requestId),
          ["requestId", "state", "runId"]);
        if (request.requestId !== requestId || request.state !== "submitted" || request.runId !== reservation.receipt.runId) {
          throw new Error("Mismatched Manager Core request.");
        }
        const run = exactToolRecord(await platform.agents.sessions.getRun(authority.sessionId, workspaceId, reservation.receipt.runId),
          ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"], ["timing", "execution", "output", "systemEvent"]);
        if (run.runId !== reservation.receipt.runId || typeof run.cancellationRequested !== "boolean"
          || !["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(String(run.status))
          || !["not_applicable", "pending", "confirmed"].includes(String(run.termination))) throw new Error("Invalid Manager Core Run.");
        row.manager = { agentId: authority.agentId, sessionId: authority.sessionId, requestId, runId: reservation.receipt.runId };
        row.verifiedWakeToManagerStart = unavailable("integration-manager-run-timing-unavailable");
        if (run.timing !== undefined) {
          const timing = exactToolRecord(run.timing, ["createdAt", "startedAt", "finishedAt"]);
          const created = instant(timing.createdAt);
          if (created < instant(wake.createdAt) || created > Date.now()
            || timing.startedAt !== null && instant(timing.startedAt) < created
            || timing.finishedAt !== null && (instant(timing.finishedAt) < created || instant(timing.finishedAt) > Date.now()
              || timing.startedAt !== null && instant(timing.finishedAt) < instant(timing.startedAt))
            || ["queued", "running", "cancelling"].includes(String(run.status)) && timing.finishedAt !== null) throw new Error("Invalid Manager timing.");
          row.verifiedWakeToManagerStart = timing.startedAt !== null ? interval(wake.createdAt, timing.startedAt as string)
            : ["queued", "running"].includes(String(run.status)) ? waiting(wake.createdAt, "integration-manager-not-started")
              : unavailable("integration-manager-start-timing-unavailable");
        }
        const latest = await resolveCurrentIntegrationManagerAuthority(workspaceId, tracked);
        if (JSON.stringify(latest) !== JSON.stringify(authority)) throw new Error("Manager identity changed.");
      } catch {
        row.manager = null;
        row.verifiedWakeToManagerStart = unavailable("integration-manager-current-plan-or-receipt-unavailable");
      }
      workstreams.push(row);
    }
    // Publication guards include design heads observed atomically inside the existing
    // reader, not necessarily through tracked.get. Recheck them after remote metadata reads.
    for (const row of workstreams) {
      if (row.status !== "current" || row.eventId === null) continue;
      const current = await publication.readCurrent({ workspaceId, projectId, workstreamId: row.workstreamId, eventId: row.eventId });
      if (current.status !== "current"
        || digest(normalizeVerifiedWorkstreamSnapshot(current.snapshot)) !== verifiedDigests.get(row.workstreamId)) {
        throw new Error("Verified source changed during metrics observation.");
      }
    }
    await check();
    return { status: "ready", workspaceId, projectId, observedAt: new Date().toISOString(), workstreams,
      consistency: "rechecked-current-records-not-a-global-transaction",
      timeSource: "core-verified-wake-created-at-not-a-separate-publication-clock",
      planCoverage: "current-plan-context-not-historical-manager-plan-attestation", completionAuthority: "not-established" };
  } catch { return { status: "unknown", reason: "integration-wait-current-records-changed-or-unavailable" }; }
}
