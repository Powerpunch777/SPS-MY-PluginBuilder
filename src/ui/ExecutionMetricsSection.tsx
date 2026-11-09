import { RefreshCw } from "lucide-react";
import { usePluginData } from "@sonparkserver/plugin-sdk/ui/bridge";
import type { ExecutionMetrics } from "../execution-metrics.ts";
import type { IntegrationWaitMetricsRead } from "../integration-wait-metrics.ts";

function fields(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid metrics record.");
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) throw new TypeError("Invalid metrics fields.");
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError("Invalid metrics field.");
    copy[key] = field.value;
  }
  return copy;
}

function fieldsWithLegacyShape(value: unknown, legacy: readonly string[], current: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid metrics record.");
  const keys = Reflect.ownKeys(value);
  const shape = keys.length === legacy.length && keys.every(key => typeof key === "string" && legacy.includes(key))
    ? legacy : current;
  return { row: fields(value, shape), hasCurrentFields: shape === current };
}

function parseIntegrationWaitDTO(value: unknown, workspaceId: string, observedAt: string): IntegrationWaitMetricsRead {
  const id = (value: unknown) => typeof value === "string" && Boolean(value.trim()) && value.length <= 160
    && !/[\u0000-\u001f\u007f]/u.test(value);
  const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
  const instant = (value: unknown): number => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value
      || Date.parse(value) > Date.parse(observedAt)) throw new TypeError("Invalid integration metrics timestamp.");
    return Date.parse(value);
  };
  const array = (value: unknown, maximum: number): unknown[] => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Invalid integration metrics array.");
    return Array.from({ length: value.length }, (_, index) => {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item?.enumerable || !Object.hasOwn(item, "value")) throw new TypeError("Invalid integration metrics item.");
      return item.value;
    });
  };
  if (value && typeof value === "object" && Object.getOwnPropertyDescriptor(value, "status")?.value === "unknown") {
    const row = fields(value, ["status", "reason"]);
    if (!id(row.reason)) throw new TypeError("Invalid integration metrics reason.");
    return row as IntegrationWaitMetricsRead;
  }
  const row = fields(value, ["status", "workspaceId", "projectId", "observedAt", "consistency", "timeSource",
    "planCoverage", "completionAuthority", "workstreams"]);
  instant(row.observedAt);
  if (row.status !== "ready" || row.workspaceId !== workspaceId || row.projectId !== workspaceId
    || row.consistency !== "rechecked-current-records-not-a-global-transaction"
    || row.timeSource !== "core-verified-wake-created-at-not-a-separate-publication-clock"
    || row.planCoverage !== "current-plan-context-not-historical-manager-plan-attestation"
    || row.completionAuthority !== "not-established") throw new TypeError("Invalid integration metrics scope.");
  const interval = (value: unknown) => {
    const part = fields(value, ["status", "fromAt", "toAt", "durationMs", "reason"]);
    if (part.status === "measured") {
      const elapsed = instant(part.toAt) - instant(part.fromAt);
      if (!Number.isSafeInteger(elapsed) || elapsed < 0 || part.durationMs !== elapsed || part.reason !== null) {
        throw new TypeError("Invalid measured integration interval.");
      }
    } else if (part.status === "waiting") {
      instant(part.fromAt);
      if (part.toAt !== null || part.durationMs !== null || !id(part.reason)) throw new TypeError("Invalid waiting integration interval.");
    } else if (part.status !== "unavailable" || part.fromAt !== null || part.toAt !== null
      || part.durationMs !== null || !id(part.reason)) throw new TypeError("Invalid unavailable integration interval.");
    return part;
  };
  const seen = new Set<string>();
  row.workstreams = array(row.workstreams, 128).map(value => {
    const item = fields(value, ["workstreamId", "status", "eventId", "sourcePins", "reason", "queueWait",
      "verifiedWakeToManagerStart", "jobRunId", "jobStatus", "jobRunStatus", "manager", "currentPlanRevisionId"]);
    if (!id(item.workstreamId) || seen.has(item.workstreamId as string) || !["current", "stale", "unknown"].includes(String(item.status))
      || item.reason !== null && !id(item.reason) || item.currentPlanRevisionId !== null && !id(item.currentPlanRevisionId)
      || item.jobRunId !== null && !uuid(item.jobRunId)
      || item.jobStatus !== null && !["pending", "leased", "delivered", "dead"].includes(String(item.jobStatus))
      || item.jobRunStatus !== null && !["pending", "queued", "running", "cancelling", "succeeded", "failed", "cancelled"].includes(String(item.jobRunStatus))
      || (item.jobRunId === null) !== (item.jobRunStatus === null)
      || item.jobRunStatus !== null && item.jobStatus === null
      || ["leased", "delivered"].includes(String(item.jobStatus)) && item.jobRunId === null
      || item.jobStatus === "delivered" && item.jobRunStatus !== "succeeded") throw new TypeError("Invalid integration Workstream identity.");
    seen.add(item.workstreamId as string);
    const pins = new Set<string>();
    item.sourcePins = array(item.sourcePins, 4096).map(value => {
      const pin = fields(value, ["sourceId", "revisionId", "sha256"]);
      if (!id(pin.sourceId) || !id(pin.revisionId) || typeof pin.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(pin.sha256)
        || pins.has(pin.sourceId as string)) throw new TypeError("Invalid integration evidence pin.");
      pins.add(pin.sourceId as string); return pin;
    });
    item.queueWait = interval(item.queueWait);
    item.verifiedWakeToManagerStart = interval(item.verifiedWakeToManagerStart);
    const queue = item.queueWait as Record<string, unknown>, managerWait = item.verifiedWakeToManagerStart as Record<string, unknown>;
    if (item.status === "current" ? !id(item.eventId) || pins.size === 0
      : item.eventId !== null || pins.size !== 0 || item.manager !== null || item.jobRunId !== null || item.jobStatus !== null || item.jobRunStatus !== null
        || queue.status !== "unavailable" || managerWait.status !== "unavailable") throw new TypeError("Invalid current integration evidence.");
    if (queue.status === "measured" && item.jobRunId === null
      || managerWait.status === "measured" && item.manager === null
      || queue.fromAt !== null && managerWait.fromAt !== null && queue.fromAt !== managerWait.fromAt) {
      throw new TypeError("Invalid integration timing binding.");
    }
    if (item.manager !== null) {
      const manager = fields(item.manager, ["agentId", "sessionId", "requestId", "runId"]);
      if (!Object.values(manager).every(uuid) || item.currentPlanRevisionId === null || item.status !== "current") {
        throw new TypeError("Invalid integration Manager receipt.");
      }
      item.manager = manager;
    }
    return item;
  });
  return row as IntegrationWaitMetricsRead;
}

export function parseExecutionMetricsDTO(value: unknown, workspaceId: string): ExecutionMetrics | null {
  const safeDuration = (value: unknown) => value === null || Number.isSafeInteger(value) && (value as number) >= 0;
  const id = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
  const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
  const instant = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
  try {
    const legacyFields = ["status", "workspaceId", "projectId", "observedAt", "consistency", "runs", "summary", "unmeasured", "completionAuthority"];
    const optionalFields = value && typeof value === "object"
      ? ["development", "integration"].filter(key => Object.hasOwn(value, key)) : [];
    const row = fields(value, [...legacyFields, ...optionalFields]);
    if (row.status !== "ready" || !uuid(workspaceId) || row.workspaceId !== workspaceId || row.projectId !== workspaceId
      || !instant(row.observedAt) || row.consistency !== "rechecked-current-records-not-a-global-transaction"
      || row.completionAuthority !== "not-established" || !Array.isArray(row.runs) || Object.getPrototypeOf(row.runs) !== Array.prototype
      || row.runs.length > 128 || Reflect.ownKeys(row.runs).length !== row.runs.length + 1) return null;
    const summaryShapes = fieldsWithLegacyShape(row.summary,
      ["observedRuns", "normalEndedRuns", "measuredRuns", "totalExecutionMs", "totalQueueMs"],
      ["observedRuns", "normalEndedRuns", "measuredRuns", "totalExecutionMs", "totalQueueMs", "commitAcceptanceCount", "totalCommitAcceptanceMs"]);
    const summary = summaryShapes.row;
    const unmeasured = fields(row.unmeasured, ["taskCompletionMs", "permissionWaitMs", "integrationWaitMs", "reworkCount", "manualInterventionCount"]);
    if ([unmeasured.taskCompletionMs, unmeasured.permissionWaitMs, unmeasured.integrationWaitMs, unmeasured.manualInterventionCount]
      .some(value => value !== null) || !safeDuration(unmeasured.reworkCount)) return null;
    const runs: Record<string, unknown>[] = [];
    for (let index = 0; index < row.runs.length; index++) {
      const item = Object.getOwnPropertyDescriptor(row.runs, String(index));
      if (!item?.enumerable || !Object.hasOwn(item, "value")) return null;
      const runShape = fieldsWithLegacyShape(item.value,
        ["ctoId", "workstreamId", "taskId", "role", "packetRevision", "requestId", "runId", "runStatus",
          "normalEnded", "timing", "queueMs", "executionMs", "reason"],
        ["ctoId", "workstreamId", "taskId", "role", "packetRevision", "requestId", "runId", "runStatus",
          "normalEnded", "timing", "queueMs", "executionMs", "reason", "commitAcceptanceMs"]);
      const run = runShape.row;
      if (!runShape.hasCurrentFields) run.commitAcceptanceMs = null;
      if (![run.ctoId, run.workstreamId, run.taskId].every(id) || !["worker", "qa"].includes(run.role as string)
        || !Number.isSafeInteger(run.packetRevision) || (run.packetRevision as number) < 1 || !uuid(run.requestId)
        || run.runId !== null && !uuid(run.runId) || typeof run.normalEnded !== "boolean"
        || !["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "timed_out", "pending", "unknown", "unsupported"].includes(run.runStatus as string)
        || run.normalEnded && (run.runStatus !== "succeeded" || run.runId === null)
        || ![run.queueMs, run.executionMs, run.commitAcceptanceMs].every(safeDuration)
        || run.role !== "worker" && run.commitAcceptanceMs !== null
        || run.reason !== null && !id(run.reason)) return null;
      if (run.timing === null) {
        if (run.queueMs !== null || run.executionMs !== null) return null;
      } else {
        const timing = fields(run.timing, ["createdAt", "startedAt", "finishedAt"]);
        if (!instant(timing.createdAt) || timing.startedAt !== null && !instant(timing.startedAt)
          || timing.finishedAt !== null && !instant(timing.finishedAt) || run.runId === null) return null;
        const created = Date.parse(timing.createdAt as string), started = timing.startedAt === null ? null : Date.parse(timing.startedAt as string);
        const finished = timing.finishedAt === null ? null : Date.parse(timing.finishedAt as string), observed = Date.parse(row.observedAt as string);
        if (created > observed || started !== null && (started < created || started > observed)
          || finished !== null && (started === null || finished < started || finished > observed)
          || ["queued", "running"].includes(run.runStatus as string) && finished !== null
          || run.queueMs !== (started === null ? null : started - created)
          || run.executionMs !== (started === null || finished === null ? null : finished - started)) return null;
        run.timing = timing;
      }
      runs.push(run);
    }
    if (Object.hasOwn(row, "development")) {
      const development = fields(row.development, ["tasks", "observedExecutionWindowMs"]);
      if (!Array.isArray(development.tasks) || Object.getPrototypeOf(development.tasks) !== Array.prototype
        || development.tasks.length > 128 || Reflect.ownKeys(development.tasks).length !== development.tasks.length + 1) return null;
      const tasks: Record<string, unknown>[] = [], identities = new Set<string>();
      for (let index = 0; index < development.tasks.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(development.tasks, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
        const task = fields(descriptor.value, ["ctoId", "workstreamId", "taskId", "packetRevision", "preparedAt", "submittedAt",
          "sourceSubmissionMs", "reworkCount", "reworkBasis", "historyCoverage"]);
        const identity = JSON.stringify([task.ctoId, task.workstreamId, task.taskId]);
        const prepared = instant(task.preparedAt) ? Date.parse(task.preparedAt as string) : null;
        const submitted = task.submittedAt === null ? null : instant(task.submittedAt) ? Date.parse(task.submittedAt as string) : NaN;
        if (![task.ctoId, task.workstreamId, task.taskId].every(id) || identities.has(identity)
          || !Number.isSafeInteger(task.packetRevision) || (task.packetRevision as number) < 1
          || prepared === null || ![task.sourceSubmissionMs, task.reworkCount].every(safeDuration)
          || submitted !== null && (!Number.isFinite(submitted) || submitted > Date.parse(row.observedAt as string))
          || task.sourceSubmissionMs !== null && (submitted === null || prepared > submitted || task.sourceSubmissionMs !== submitted - prepared)
          || task.reworkBasis !== "failed-qa-then-changed-source-and-new-qa"
          || !["complete-current-task-scope", "unavailable-or-incomplete"].includes(String(task.historyCoverage))
          || (task.reworkCount === null) !== (task.historyCoverage === "unavailable-or-incomplete")
          || !runs.some(run => run.role === "worker" && run.ctoId === task.ctoId && run.workstreamId === task.workstreamId
            && run.taskId === task.taskId && run.packetRevision === task.packetRevision)) return null;
        identities.add(identity); tasks.push(task);
      }
      const intervals = runs.filter(run => run.executionMs !== null).map(run => {
        const timing = run.timing as { startedAt: string; finishedAt: string };
        return [Date.parse(timing.startedAt), Date.parse(timing.finishedAt)];
      }).sort((a, b) => a[0]! - b[0]!);
      let union: number | null = null;
      if (intervals.length) {
        let total = 0, start = intervals[0]![0]!, end = intervals[0]![1]!;
        for (const interval of intervals.slice(1)) {
          if (interval[0]! > end) { total += end - start; start = interval[0]!; }
          end = Math.max(end, interval[1]!);
        }
        union = total + end - start;
      }
      if (!safeDuration(development.observedExecutionWindowMs) || development.observedExecutionWindowMs !== union
        || unmeasured.reworkCount !== (tasks.length && tasks.every(task => task.reworkCount !== null)
          ? tasks.reduce((total, task) => total + (task.reworkCount as number), 0) : null)) return null;
      row.development = { tasks, observedExecutionWindowMs: union };
    } else if (unmeasured.reworkCount !== null) return null;
    const sum = (key: "queueMs" | "executionMs") => {
      const measured = runs.filter(run => run[key] !== null);
      return measured.length ? measured.reduce((total, run) => total + (run[key] as number), 0) : null;
    };
    const acceptedCommits = runs.filter(run => run.commitAcceptanceMs !== null);
    if (!summaryShapes.hasCurrentFields) {
      summary.commitAcceptanceCount = 0;
      summary.totalCommitAcceptanceMs = null;
    }
    if (summary.observedRuns !== runs.filter(run => run.runId !== null && !["unknown", "unsupported", "pending"].includes(run.runStatus as string)).length
      || summary.normalEndedRuns !== runs.filter(run => run.normalEnded).length
      || summary.measuredRuns !== runs.filter(run => run.executionMs !== null).length
      || summary.commitAcceptanceCount !== acceptedCommits.length
      || summary.totalCommitAcceptanceMs !== (acceptedCommits.length
        ? acceptedCommits.reduce((total, run) => total + (run.commitAcceptanceMs as number), 0) : null)
      || summary.totalExecutionMs !== sum("executionMs") || summary.totalQueueMs !== sum("queueMs")
      || ![summary.totalExecutionMs, summary.totalQueueMs, summary.totalCommitAcceptanceMs].every(safeDuration)) return null;
    if (Object.hasOwn(row, "integration")) row.integration = parseIntegrationWaitDTO(row.integration, workspaceId, row.observedAt as string);
    return { ...row, runs, summary, unmeasured } as unknown as ExecutionMetrics;
  } catch { return null; }
}
const duration = (value: number | null) => value === null ? "미측정" : `${(value / 1000).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}초`;

function runStatusLabel(run: ExecutionMetrics["runs"][number]) {
  if (run.runStatus === "unknown" && run.runId === null
    && run.reason === "worker-session-request-confirmed-not-started-no-automatic-retry") return "미시작 확인";
  if (run.runStatus === "unknown") return "상태 미확인";
  if (run.runStatus === "pending") return "실행 배정 대기";
  if (run.runStatus === "unsupported") return "조회 미지원";
  return run.runStatus;
}

export function ExecutionMetricsPanel({ value, workspaceId, loading, error, onRefresh }: {
  value: unknown; workspaceId: string; loading?: boolean; error?: boolean; onRefresh?(): void;
}) {
  const metrics = error ? null : parseExecutionMetricsDTO(value, workspaceId);
  return <section aria-label="개발 실행 지표" style={{ minWidth: 0, borderTop: "1px solid var(--builder-border,#414141)", paddingTop: 16 }}>
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}><h2>개발 실행 지표</h2>
      <button type="button" className="builder-icon-button" aria-label="개발 실행 지표 새로고침" title="개발 실행 지표 새로고침"
        onClick={onRefresh} disabled={loading || !onRefresh}><RefreshCw size={14} /></button></header>
    {loading ? <p role="status">실행 기록을 읽는 중입니다.</p> : !metrics ? <p role="status">현재 실행 지표를 확인할 수 없습니다.</p> : <>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,150px),1fr))", gap: 12, margin: "12px 0" }}>
        {[["관측 Run", String(metrics.summary.observedRuns)], ["정상 종료 Run", String(metrics.summary.normalEndedRuns)],
          ["실행 시간 측정 Run", String(metrics.summary.measuredRuns)], ["누적 AI 실행 시간", duration(metrics.summary.totalExecutionMs)],
          ["관측 실행 구간(중복 제외)", duration(metrics.development?.observedExecutionWindowMs ?? null)],
          ["누적 실행 큐 대기", duration(metrics.summary.totalQueueMs)], ["Commit 인수 대기", duration(metrics.summary.totalCommitAcceptanceMs)],
          ["Task 완료 시간", "미측정"], ["권한 대기", "미측정"],
          ["전체 통합 소요", "미측정"], ["기록 기반 재작업 횟수", metrics.unmeasured.reworkCount === null ? "미측정" : `${metrics.unmeasured.reworkCount}회`],
          ["수동 개입 횟수", "미측정"]].map(([label, result]) =>
          <div key={label}><dt style={{ color: "var(--builder-muted,#b6b6b6)" }}>{label}</dt><dd style={{ margin: "4px 0 0" }}>{result}</dd></div>)}
      </dl>
      <p style={{ color: "var(--builder-muted,#b6b6b6)" }}>Run 종료는 Task·QA·프로젝트 완료가 아닙니다. 기록된 시각만 측정하며 미측정 값을 0으로 계산하지 않습니다.</p>
      {!metrics.runs.length ? <p>현재 Task에 등록된 Worker 실행 기록이 없습니다.</p> : <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table style={{ width: "100%", minWidth: 600, borderCollapse: "collapse", textAlign: "left", color: "var(--builder-text,#ededed)" }}><thead><tr>
          {["Workstream / Task", "역할", "Run 상태", "실행 시간", "큐 대기", "Task 준비→소스 제출", "Commit 인수 대기"].map(label => <th key={label} style={{ padding: 8 }}>{label}</th>)}
        </tr></thead><tbody>{metrics.runs.map(run => <tr key={JSON.stringify([run.ctoId, run.workstreamId,
          run.taskId, run.role, run.requestId, run.runId, run.reason])}>
          <td style={{ padding: 8, overflowWrap: "anywhere" }}>{run.workstreamId} / {run.taskId}</td><td>{run.role}</td><td>{runStatusLabel(run)}</td>
          <td>{duration(run.executionMs)}</td><td>{duration(run.queueMs)}</td><td>{duration(run.role === "worker"
            ? metrics.development?.tasks.find(task => task.ctoId === run.ctoId && task.workstreamId === run.workstreamId
              && task.taskId === run.taskId && task.packetRevision === run.packetRevision)?.sourceSubmissionMs ?? null : null)}</td>
          <td>{duration(run.commitAcceptanceMs ?? null)}</td>
        </tr>)}</tbody></table>
      </div>}
      {metrics.integration && <>
        <h3>통합 실행 대기</h3>
        {metrics.integration.status === "unknown" ? <p role="status">통합 실행 기록을 확인할 수 없습니다.</p>
          : !metrics.integration.workstreams.length ? <p>통합 대기 기록이 없습니다.</p>
            : <div style={{ overflowX: "auto", maxWidth: "100%" }}><table style={{ width: "100%", minWidth: 600,
              borderCollapse: "collapse", textAlign: "left", color: "var(--builder-text,#ededed)" }}><thead><tr>
              {["Workstream", "검증 기록", "Job 상태", "Job 큐 대기", "검증 이벤트→Manager 시작"].map(label => <th key={label} style={{ padding: 8 }}>{label}</th>)}
            </tr></thead><tbody>{metrics.integration.workstreams.map(row => <tr key={row.workstreamId}>
              <td style={{ padding: 8, overflowWrap: "anywhere" }}>{row.workstreamId}</td>
              <td>{row.status === "current" ? "현재 증거" : row.status === "stale" ? "변경됨" : "미확인"}</td>
              <td>{row.jobStatus === "dead" || row.jobRunStatus === "failed" ? "실행 오류"
                : row.jobRunStatus === "cancelled" ? "취소됨" : row.jobStatus === "pending" ? "배정 대기"
                  : row.jobStatus === "leased" ? "배정됨" : row.jobStatus === "delivered" ? "이벤트 처리됨" : "미확인"}</td>
              {[row.queueWait, row.verifiedWakeToManagerStart].map((part, index) => <td key={index}>
                {part.status === "waiting" ? "실행 대기" : duration(part.durationMs)}</td>)}
            </tr>)}</tbody></table></div>}
      </>}
    </>}
  </section>;
}

export function ExecutionMetricsSection({ workspaceId }: { workspaceId: string }) {
  const metrics = usePluginData<unknown>("builder.execution-metrics", { projectId: workspaceId });
  return <ExecutionMetricsPanel workspaceId={workspaceId} value={metrics.data} loading={metrics.loading}
    error={Boolean(metrics.error)} onRefresh={metrics.refresh} />;
}
