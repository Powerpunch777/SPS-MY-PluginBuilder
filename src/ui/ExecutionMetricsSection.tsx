import { RefreshCw } from "lucide-react";
import { usePluginData } from "@sonparkserver/plugin-sdk/ui/bridge";
import type { ExecutionMetrics } from "../execution-metrics.ts";

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

export function parseExecutionMetricsDTO(value: unknown, workspaceId: string): ExecutionMetrics | null {
  const safeDuration = (value: unknown) => value === null || Number.isSafeInteger(value) && (value as number) >= 0;
  const id = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
  const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
  const instant = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
  try {
    const row = fields(value, ["status", "workspaceId", "projectId", "observedAt", "consistency", "runs", "summary", "unmeasured", "completionAuthority"]);
    if (row.status !== "ready" || !uuid(workspaceId) || row.workspaceId !== workspaceId || row.projectId !== workspaceId
      || !instant(row.observedAt) || row.consistency !== "rechecked-current-records-not-a-global-transaction"
      || row.completionAuthority !== "not-established" || !Array.isArray(row.runs) || Object.getPrototypeOf(row.runs) !== Array.prototype
      || row.runs.length > 128 || Reflect.ownKeys(row.runs).length !== row.runs.length + 1) return null;
    const summaryShapes = fieldsWithLegacyShape(row.summary,
      ["observedRuns", "normalEndedRuns", "measuredRuns", "totalExecutionMs", "totalQueueMs"],
      ["observedRuns", "normalEndedRuns", "measuredRuns", "totalExecutionMs", "totalQueueMs", "commitAcceptanceCount", "totalCommitAcceptanceMs"]);
    const summary = summaryShapes.row;
    const unmeasured = fields(row.unmeasured, ["taskCompletionMs", "permissionWaitMs", "integrationWaitMs", "reworkCount", "manualInterventionCount"]);
    if (!Object.values(unmeasured).every(value => value === null)) return null;
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
          ["누적 실행 큐 대기", duration(metrics.summary.totalQueueMs)], ["Commit 인수 대기", duration(metrics.summary.totalCommitAcceptanceMs)],
          ["Task 완료 시간", "미측정"], ["권한 대기", "미측정"],
          ["통합 대기", "미측정"], ["재작업 횟수", "미측정"], ["수동 개입 횟수", "미측정"]].map(([label, result]) =>
          <div key={label}><dt style={{ color: "var(--builder-muted,#b6b6b6)" }}>{label}</dt><dd style={{ margin: "4px 0 0" }}>{result}</dd></div>)}
      </dl>
      <p style={{ color: "var(--builder-muted,#b6b6b6)" }}>Run 종료는 Task·QA·프로젝트 완료가 아닙니다. 기록된 시각만 측정하며 미측정 값을 0으로 계산하지 않습니다.</p>
      {!metrics.runs.length ? <p>현재 Task에 등록된 Worker 실행 기록이 없습니다.</p> : <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table style={{ width: "100%", minWidth: 600, borderCollapse: "collapse", textAlign: "left", color: "var(--builder-text,#ededed)" }}><thead><tr>
          {["Workstream / Task", "역할", "Run 상태", "실행 시간", "큐 대기", "Commit 인수 대기"].map(label => <th key={label} style={{ padding: 8 }}>{label}</th>)}
        </tr></thead><tbody>{metrics.runs.map(run => <tr key={JSON.stringify([run.ctoId, run.workstreamId,
          run.taskId, run.role, run.requestId, run.runId, run.reason])}>
          <td style={{ padding: 8, overflowWrap: "anywhere" }}>{run.workstreamId} / {run.taskId}</td><td>{run.role}</td><td>{runStatusLabel(run)}</td>
          <td>{duration(run.executionMs)}</td><td>{duration(run.queueMs)}</td><td>{duration(run.commitAcceptanceMs ?? null)}</td>
        </tr>)}</tbody></table>
      </div>}
    </>}
  </section>;
}

export function ExecutionMetricsSection({ workspaceId }: { workspaceId: string }) {
  const metrics = usePluginData<unknown>("builder.execution-metrics", { projectId: workspaceId });
  return <ExecutionMetricsPanel workspaceId={workspaceId} value={metrics.data} loading={metrics.loading}
    error={Boolean(metrics.error)} onRefresh={metrics.refresh} />;
}
