import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { build } from "esbuild";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PANEL_TEMP_PREFIX = ".builder-execution-metrics-panel-";
const BROWSER_TEMP_PREFIX = ".builder-execution-metrics-browser-";
type MetricsPanel = typeof import("../../src/ui/ExecutionMetricsSection.tsx").ExecutionMetricsPanel;

async function removeOwnedTemp(directory: string, prefix: string) {
  const [root, resolved] = await Promise.all([realpath(projectRoot), realpath(directory)]);
  const relative = path.relative(root, resolved);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "temporary test directory must resolve beneath projectRoot");
  assert.ok(path.basename(resolved).startsWith(prefix), "temporary test directory must retain its owned prefix");
  await rm(resolved, { recursive: true, force: true });
}

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready", workspaceId: WORKSPACE, projectId: WORKSPACE, observedAt: "2026-11-07T00:00:03.000Z",
    consistency: "rechecked-current-records-not-a-global-transaction", completionAuthority: "not-established",
    runs: [
      { ctoId: "cto-one", workstreamId: "ws-1", taskId: "task-worker", role: "worker", packetRevision: 1,
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runStatus: "succeeded", normalEnded: true,
        timing: { createdAt: "2026-11-07T00:00:00.000Z", startedAt: "2026-11-07T00:00:00.500Z", finishedAt: "2026-11-07T00:00:01.750Z" },
        queueMs: 500, executionMs: 1_250, reason: null },
      { ctoId: "cto-one", workstreamId: "ws-1", taskId: "task-qa", role: "qa", packetRevision: 1,
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", runStatus: "failed", normalEnded: false,
        timing: null, queueMs: null, executionMs: null, reason: "host-run-timing-unavailable-or-inconsistent" },
    ],
    summary: { observedRuns: 2, normalEndedRuns: 1, measuredRuns: 1, totalExecutionMs: 1_250, totalQueueMs: 500 },
    unmeasured: { taskCompletionMs: null, permissionWaitMs: null, integrationWaitMs: null,
      reworkCount: null, manualInterventionCount: null },
    ...overrides,
  };
}

function metricsWithCommitAcceptance(overrides: Record<string, unknown> = {}) {
  const base = metrics();
  const runs = base.runs.map((run, index) => ({ ...run, commitAcceptanceMs: index === 0 ? 1_500 : null }));
  return { ...base, ...overrides, runs: (overrides.runs as typeof runs | undefined) ?? runs,
    summary: { ...base.summary, commitAcceptanceCount: 1, totalCommitAcceptanceMs: 1_500,
      ...(overrides.summary as Record<string, unknown> | undefined) } };
}

function metricsWithUnstartedRequest() {
  const base = metrics();
  const unresolved = { ...base.runs[0]!, runStatus: "unknown", normalEnded: false,
    timing: null, queueMs: null, executionMs: null };
  return { ...base, runs: [
    { ...unresolved, taskId: "task-skipped", runId: null, reason: "worker-session-request-confirmed-not-started-no-automatic-retry" },
    { ...unresolved, taskId: "task-unresolved", requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", runId: null,
      reason: "worker-session-request-state-uncertain" },
    { ...unresolved, taskId: "task-pending", requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff", runId: null, runStatus: "pending",
      reason: "worker-session-request-has-no-run-id-yet" },
  ], summary: { observedRuns: 0, normalEndedRuns: 0, measuredRuns: 0, totalExecutionMs: null, totalQueueMs: null } };
}

function metricsWithIntegration() {
  const base = metricsWithDevelopment();
  const unavailable = { status: "unavailable", fromAt: null, toAt: null, durationMs: null, reason: "verification-stale" };
  const current = { workstreamId: "ws-1", status: "current", eventId: "builder-verified-v1:fixture",
    sourcePins: [{ sourceId: "source-1", revisionId: "revision-1", sha256: "a".repeat(64) }], reason: null,
    queueWait: { status: "measured", fromAt: "2026-11-07T00:00:00.000Z", toAt: "2026-11-07T00:00:00.500Z", durationMs: 500, reason: null },
    verifiedWakeToManagerStart: { status: "measured", fromAt: "2026-11-07T00:00:00.000Z", toAt: "2026-11-07T00:00:01.250Z", durationMs: 1250, reason: null },
    jobRunId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", jobStatus: "delivered", jobRunStatus: "succeeded", currentPlanRevisionId: "plan-1",
    manager: { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } };
  const waiting = { status: "waiting", fromAt: "2026-11-07T00:00:00.000Z", toAt: null, durationMs: null, reason: "not-started" };
  return { ...base, integration: { status: "ready", workspaceId: WORKSPACE, projectId: WORKSPACE,
    observedAt: base.observedAt, consistency: "rechecked-current-records-not-a-global-transaction",
    timeSource: "core-verified-wake-created-at-not-a-separate-publication-clock",
    planCoverage: "current-plan-context-not-historical-manager-plan-attestation", completionAuthority: "not-established",
    workstreams: [current, { ...current, workstreamId: "ws-waiting", eventId: "builder-verified-v1:waiting",
      queueWait: waiting, verifiedWakeToManagerStart: waiting, jobRunId: null, jobStatus: "pending", jobRunStatus: null, manager: null, currentPlanRevisionId: null },
    { ...current, workstreamId: "ws-stale", status: "stale", eventId: null, sourcePins: [], reason: "verification-stale",
      queueWait: unavailable, verifiedWakeToManagerStart: unavailable, jobRunId: null, jobStatus: null, jobRunStatus: null, manager: null, currentPlanRevisionId: null }] } };
}

function metricsWithDevelopment() {
  const base = metricsWithCommitAcceptance();
  return { ...base, unmeasured: { ...base.unmeasured, reworkCount: 1 },
    development: { observedExecutionWindowMs: 1250, tasks: [{ ctoId: "cto-one", workstreamId: "ws-1", taskId: "task-worker",
      packetRevision: 1, preparedAt: "2026-11-07T00:00:00.000Z", submittedAt: "2026-11-07T00:00:01.500Z",
      sourceSubmissionMs: 1500, reworkCount: 1, reworkBasis: "failed-qa-then-changed-source-and-new-qa",
      historyCoverage: "complete-current-task-scope" }] } };
}

async function loadMetricsPanel() {
  const temporary = await mkdtemp(path.join(projectRoot, PANEL_TEMP_PREFIX));
  const output = path.join(temporary, "ExecutionMetricsSection.mjs");
  try {
    await build({ entryPoints: [path.join(projectRoot, "src/ui/ExecutionMetricsSection.tsx")], outfile: output,
      bundle: true, external: ["react", "react/jsx-runtime"], platform: "node", format: "esm", jsx: "automatic",
      plugins: [{ name: "plugin-data-test-stub", setup(builder) {
        builder.onResolve({ filter: /plugin-sdk.*ui.*bridge/ }, () => ({ path: "bridge", namespace: "metrics-test" }));
        builder.onLoad({ filter: /.*/, namespace: "metrics-test" }, () => ({
          contents: "export function usePluginData(){return {data:null,loading:false,error:null,refresh(){}}}", loader: "js",
        }));
      } }],
    });
    const module = await import(pathToFileURL(output).href);
    return { Panel: module.ExecutionMetricsPanel as MetricsPanel,
      parseDTO: module.parseExecutionMetricsDTO as (value: unknown, workspaceId: string) => unknown, temporary };
  } catch (error) {
    await removeOwnedTemp(temporary, PANEL_TEMP_PREFIX);
    throw error;
  }
}

function renderPanel(Panel: MetricsPanel, value: unknown, options: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(Panel, { workspaceId: WORKSPACE, value, ...options }));
}

test("metrics projection distinguishes unknown, unmeasured timings, Run end, and business completion", async () => {
  const { Panel, parseDTO, temporary } = await loadMetricsPanel();
  try {
    const loading = renderPanel(Panel, null, { loading: true });
    assert.match(loading, /실행 기록을 읽는 중입니다/u);
    assert.doesNotMatch(loading, /0초/u);

    const unavailable = renderPanel(Panel, { status: "unknown", reason: "fixture only" });
    assert.match(unavailable, /현재 실행 지표를 확인할 수 없습니다/u);
    assert.doesNotMatch(unavailable, /fixture only|0초|0.00초/u);

    const current = renderPanel(Panel, metricsWithCommitAcceptance());
    assert.match(current, /정상 종료 Run/u);
    assert.match(current, /Run 종료는 Task·QA·프로젝트 완료가 아닙니다/u);
    assert.match(current, /worker/u);
    assert.match(current, /qa/u);
    assert.match(current, /succeeded/u);
    assert.match(current, /failed/u);
    assert.match(current, /1\.25초/u);
    assert.match(current, /0\.5초/u);
    assert.match(current, /Task 완료 시간/u);
    assert.match(current, /Commit 인수 대기/u);
    assert.match(current, /1\.5초/u);
    assert.match(current, /미측정/u);

    const unresolved = metrics({ runs: [...metrics().runs,
      { ...metrics().runs[0], taskId: "task-unresolved", requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        runId: "ffffffff-ffff-4fff-8fff-ffffffffffff", runStatus: "pending", normalEnded: false,
        timing: null, queueMs: null, executionMs: null, reason: "run-observation-pending" },
    ], summary: metrics().summary });
    assert.equal((parseDTO(unresolved, WORKSPACE) as { summary: { observedRuns: number } }).summary.observedRuns, 2,
      "pending/unknown observations with a known run ID are not counted as observed Runs");

    const unstarted = metricsWithUnstartedRequest();
    const unstartedMarkup = renderPanel(Panel, unstarted);
    assert.match(unstartedMarkup, /task-skipped<\/td><td>worker<\/td><td>미시작 확인/u);
    assert.match(unstartedMarkup, /task-unresolved<\/td><td>worker<\/td><td>상태 미확인/u);
    assert.match(unstartedMarkup, /task-pending<\/td><td>worker<\/td><td>실행 배정 대기/u);
    assert.doesNotMatch(unstartedMarkup, /confirmed-not-started|재실행/u);
    const contradictory = { ...unstarted, runs: unstarted.runs.map((run, index) => index === 0
      ? { ...run, runId: metrics().runs[0]!.runId } : run) };
    assert.doesNotMatch(renderPanel(Panel, contradictory), /미시작 확인/u);

    const oldHost = metrics({ runs: [
      { ...metrics().runs[0], timing: null, queueMs: null, executionMs: null, reason: "host-run-timing-unavailable-or-inconsistent" },
    ], summary: { observedRuns: 1, normalEndedRuns: 1, measuredRuns: 0, totalExecutionMs: null, totalQueueMs: null } });
    const oldHostMarkup = renderPanel(Panel, oldHost);
    assert.match(oldHostMarkup, /미측정/u);
    assert.doesNotMatch(oldHostMarkup, /0초|0\.00초/u);
  } finally { await removeOwnedTemp(temporary, PANEL_TEMP_PREFIX); }
});

test("strict metrics parser rejects false, incomplete, foreign, role-invalid, and accessor DTOs", async () => {
  const { Panel, parseDTO, temporary } = await loadMetricsPanel();
  try {
    const valid = metrics();
    const omitted = structuredClone(valid) as Record<string, any>;
    delete omitted.unmeasured.taskCompletionMs;
    const invalidRole = structuredClone(valid) as Record<string, any>;
    invalidRole.runs[0].role = "manager";
    const falseSummary = { ...valid, summary: { ...valid.summary, observedRuns: 0, normalEndedRuns: 0 } };
    const extra = { ...valid, untrustedSummary: { completion: "done" } };
    const foreign = { ...valid, workspaceId: "22222222-2222-4222-8222-222222222222" };
    let getterReads = 0;
    const accessor = { ...valid };
    Object.defineProperty(accessor, "workspaceId", { enumerable: true, get() { getterReads += 1; return WORKSPACE; } });
    const nestedAccessor = structuredClone(valid) as Record<string, any>;
    Object.defineProperty(nestedAccessor.summary, "normalEndedRuns", {
      enumerable: true, get() { getterReads += 1; return 1; },
    });

    const falseCommitSummary = metricsWithCommitAcceptance({ summary: { ...metricsWithCommitAcceptance().summary,
      commitAcceptanceCount: 0 } });
    const qaCommitInterval = metricsWithCommitAcceptance({ runs: metricsWithCommitAcceptance().runs.map((run, index) =>
      index === 1 ? { ...run, commitAcceptanceMs: 1 } : run) });
    for (const value of [omitted, invalidRole, falseSummary, extra, foreign, accessor, nestedAccessor, falseCommitSummary, qaCommitInterval]) {
      assert.equal(parseDTO(value, WORKSPACE), null);
      const html = renderPanel(Panel, value);
      assert.match(html, /현재 실행 지표를 확인할 수 없습니다/u);
      assert.doesNotMatch(html, /task-worker|task-qa|fixture only/u);
    }
    assert.equal(getterReads, 0, "DTO accessors must not execute while parsing Host data");
    assert.ok(parseDTO(valid, WORKSPACE), "the exact legacy metrics DTO remains readable");
  } finally { await removeOwnedTemp(temporary, PANEL_TEMP_PREFIX); }
});

test("record-backed development DTO renders measured source work without promoting absent completion, permission or manual evidence", async () => {
  const { Panel, parseDTO, temporary } = await loadMetricsPanel();
  try {
    const value = metricsWithDevelopment();
    assert.ok(parseDTO(value, WORKSPACE));
    const html = renderPanel(Panel, value);
    assert.match(html, /관측 실행 구간\(중복 제외\)/u);
    assert.match(html, /Task 준비→소스 제출/u);
    assert.match(html, /기록 기반 재작업 횟수/u);
    assert.match(html, /1회/u);
    assert.match(html, /Task 완료 시간<\/dt><dd[^>]*>미측정/u);
    assert.match(html, /수동 개입 횟수<\/dt><dd[^>]*>미측정/u);
    for (const invalid of [
      { ...value, development: { ...value.development, observedExecutionWindowMs: 2500 } },
      { ...value, unmeasured: { ...value.unmeasured, reworkCount: 2 } },
      { ...value, unmeasured: { ...value.unmeasured, taskCompletionMs: 1250 } },
      { ...value, unmeasured: { ...value.unmeasured, manualInterventionCount: 0 } },
      { ...value, development: { ...value.development, tasks: value.development.tasks.map(task => ({ ...task, sourceSubmissionMs: 1 })) } },
      { ...value, development: { ...value.development, tasks: value.development.tasks.map(task => ({ ...task, taskId: "foreign-task" })) } },
      { ...value, development: { ...value.development, tasks: value.development.tasks.map(task => ({ ...task, historyCoverage: "unavailable-or-incomplete" })) } },
      { ...value, development: { ...value.development, tasks: [...value.development.tasks, ...value.development.tasks] } },
    ]) assert.equal(parseDTO(invalid, WORKSPACE), null);
    let reads = 0;
    const accessor = metricsWithDevelopment();
    Object.defineProperty(accessor.development.tasks[0], "sourceSubmissionMs", { enumerable: true, get() { reads++; return 1500; } });
    assert.equal(parseDTO(accessor, WORKSPACE), null);
    assert.equal(reads, 0);
  } finally { await removeOwnedTemp(temporary, PANEL_TEMP_PREFIX); }
});

test("integration wait DTO preserves measured, waiting and stale evidence without asserting completion", async () => {
  const { Panel, parseDTO, temporary } = await loadMetricsPanel();
  try {
    const value = metricsWithIntegration();
    assert.ok(parseDTO(value, WORKSPACE));
    const html = renderPanel(Panel, value);
    assert.match(html, /통합 실행 대기/u);
    assert.match(html, /Job 큐 대기/u);
    assert.match(html, /검증 이벤트→Manager 시작/u);
    assert.match(html, /실행 대기/u);
    assert.match(html, /변경됨/u);
    assert.match(html, /이벤트 처리됨/u);
    assert.match(html, /배정 대기/u);
    assert.match(html, /1\.25초/u);
    assert.doesNotMatch(html, /0초|통합 완료|QA 합격/u);
    const unknown = { ...value, integration: { status: "unknown", reason: "observation-denied" } };
    assert.ok(parseDTO(unknown, WORKSPACE));
    assert.match(renderPanel(Panel, unknown), /통합 실행 기록을 확인할 수 없습니다/u);
    assert.match(renderPanel(Panel, unknown), /task-worker/u);
    const bad = (mutate: (copy: any) => void) => { const copy = structuredClone(value); mutate(copy); return copy; };
    const failed = bad(copy => { copy.integration.workstreams[0].jobStatus = "dead"; copy.integration.workstreams[0].jobRunStatus = "failed"; });
    assert.ok(parseDTO(failed, WORKSPACE));
    assert.match(renderPanel(Panel, failed), /실행 오류/u);
    let getterReads = 0;
    for (const invalid of [
      bad(copy => { copy.integration.workspaceId = "22222222-2222-4222-8222-222222222222"; }),
      bad(copy => { copy.integration.completionAuthority = "verified"; }),
      bad(copy => { copy.integration.observedAt = "2026-11-07T00:00:04.000Z"; }),
      bad(copy => { copy.integration.workstreams[0].queueWait.durationMs = 1; }),
      bad(copy => { copy.integration.workstreams[0].manager = null; }),
      bad(copy => { copy.integration.workstreams[0].jobRunId = null; }),
      bad(copy => { copy.integration.workstreams[0].jobRunStatus = "unrecognized"; }),
      bad(copy => { copy.integration.workstreams[0].jobStatus = "leased"; copy.integration.workstreams[0].jobRunStatus = null; }),
      bad(copy => { copy.integration.workstreams[1].queueWait.durationMs = 0; }),
      bad(copy => { copy.integration.workstreams[2].queueWait = copy.integration.workstreams[0].queueWait; }),
      bad(copy => { copy.integration.workstreams.push(copy.integration.workstreams[0]); }),
      bad(copy => { copy.integration.workstreams[0].sourcePins.push(copy.integration.workstreams[0].sourcePins[0]); }),
      bad(copy => { copy.integration.workstreams[0].verifiedWakeToManagerStart.fromAt = "2026-11-07T00:00:00.100Z";
        copy.integration.workstreams[0].verifiedWakeToManagerStart.durationMs = 1150; }),
      bad(copy => Object.defineProperty(copy.integration.workstreams[0], "manager", {
        enumerable: true, get() { getterReads++; return value.integration.workstreams[0]!.manager; } })),
      bad(copy => Object.defineProperty(copy.integration, "status", { enumerable: true, get() { getterReads++; return "ready"; } })),
    ]) assert.equal(parseDTO(invalid, WORKSPACE), null);
    assert.equal(getterReads, 0);
  } finally { await removeOwnedTemp(temporary, PANEL_TEMP_PREFIX); }
});

test("Builder mounts execution metrics only in System and has no page-level horizontal overflow", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, BROWSER_TEMP_PREFIX));
  const evidenceDirectory = process.env.SPS_EXECUTION_METRICS_QA_EVIDENCE_DIR?.trim();
  const evidencePaths: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
  const bundle = await build({ stdin: { sourcefile: "execution-metrics-harness.tsx", resolveDir: projectRoot, contents: `
    import { createElement } from "react";
    import { createRoot } from "react-dom/client";
    import { BuilderShell } from "./src/ui/BuilderShell.tsx";
    import { ExecutionMetricsPanel } from "./src/ui/ExecutionMetricsSection.tsx";
    const workspaceId = "${WORKSPACE}";
    const snapshot = { schemaVersion: 1, workspaceId, revision: 1,
      leadSessions: { main:null,"ui-design":null,background:null,"cto-inbox":null,decisions:null,"integration-review":null },
      actors:[],messages:[],documents:[],questions:[],graph:{revisionId:null,entities:[],relations:[]},activity:[],
      integrations:{ai:"not_configured",github:"not_configured",htmlPreview:"unavailable"} };
    let root;
    window.mountBuilder = (value, loading = false) => {
      const node = document.getElementById("root"); if (!node) return;
      root ??= createRoot(node);
      root.render(createElement(BuilderShell, { workspaceLabel:"Metrics fixture", snapshot, onRefresh(){},
        executionMetrics:createElement(ExecutionMetricsPanel, { workspaceId, value, loading }) }));
    };
  ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "text" },
  plugins: [
    { name: "react-flow-test-stub", setup(builder) {
      builder.onResolve({ filter: /xyflow/ }, args => args.path.endsWith(".css")
        ? ({ path: "xyflow-css", namespace: "metrics-flow" }) : ({ path: "xyflow", namespace: "metrics-flow" }));
      builder.onLoad({ filter: /.*/, namespace: "metrics-flow" }, args => args.path === "xyflow-css"
        ? { contents: "", loader: "text", resolveDir: projectRoot }
        : { contents: `import { jsx } from "react/jsx-runtime";
          export const MarkerType={ArrowClosed:"arrowclosed"};
          export const ReactFlow=({children})=>jsx("div",{"data-test-react-flow":"true",children});
          export const Background=()=>null; export const Controls=()=>null;`, loader: "jsx", resolveDir: projectRoot });
    } },
    { name: "plugin-data-test-stub", setup(builder) {
      builder.onResolve({ filter: /plugin-sdk.*ui.*bridge/ }, () => ({ path: "bridge", namespace: "metrics-bridge" }));
      builder.onLoad({ filter: /.*/, namespace: "metrics-bridge" }, () => ({
        contents: "export function usePluginData(){return {data:null,loading:false,error:null,refresh(){}}}", loader: "js", resolveDir: projectRoot,
      }));
    } },
  ],
  });
  browser = await chromium.launch({ headless: true });
  const saveScreenshot = async (page: import("playwright").Page, name: string) => {
    if (!evidenceDirectory) return;
    const directory = path.resolve(evidenceDirectory);
    await mkdir(directory, { recursive: true });
    const output = path.join(directory, name);
    if (name.includes("integration")) await page.getByRole("heading", { name: "통합 실행 대기" }).scrollIntoViewIfNeeded();
    else await page.getByRole("region", { name: "개발 실행 지표" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: output });
    evidencePaths.push(output);
  };
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const keyWarnings: string[] = [];
    page.on("console", message => {
      if (/same key|unique ["']key["']/iu.test(message.text())) keyWarnings.push(message.text());
    });
    await page.setContent("<div id='root'></div>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate(value => (window as unknown as { mountBuilder(value: unknown): void }).mountBuilder(value), metricsWithUnstartedRequest());
    assert.equal(await page.getByRole("region", { name: "개발 실행 지표" }).count(), 0, "the panel is absent from the default Lead view");
    await page.getByRole("button", { name: "시스템" }).click();
    assert.equal(await page.getByRole("region", { name: "개발 실행 지표" }).count(), 1);
    assert.equal(await page.getByRole("cell", { name: "미시작 확인", exact: true }).count(), 1);
    assert.equal(await page.getByRole("cell", { name: "상태 미확인", exact: true }).count(), 1);
    assert.notEqual(await page.getByRole("region", { name: "개발 실행 지표" }).locator("table").evaluate(element => getComputedStyle(element).color),
      "rgb(0, 0, 0)", "the table must not fall back to black text on the dark Workspace background");
    assert.equal(await page.locator("html").evaluate(element => element.scrollWidth <= window.innerWidth), true, "390px viewport must not overflow horizontally");
    await saveScreenshot(page, "builder-metrics-390.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator("html").evaluate(element => element.scrollWidth <= window.innerWidth), true, "1440px viewport must not overflow horizontally");
    await saveScreenshot(page, "builder-metrics-1440.png");
    await page.evaluate(value => (window as unknown as { mountBuilder(value: unknown): void }).mountBuilder(value), metricsWithDevelopment());
    await page.getByText("1회", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("html").evaluate(element => element.scrollWidth <= window.innerWidth), true);
    await saveScreenshot(page, "builder-metrics-development-390.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator("html").evaluate(element => element.scrollWidth <= window.innerWidth), true);
    await saveScreenshot(page, "builder-metrics-development-1440.png");
    await page.evaluate(value => (window as unknown as { mountBuilder(value: unknown): void }).mountBuilder(value), metricsWithIntegration());
    await page.getByRole("heading", { name: "통합 실행 대기" }).waitFor();
    assert.equal(await page.getByRole("cell", { name: "실행 대기", exact: true }).count(), 2);
    assert.equal(await page.locator("html").evaluate(element => element.scrollWidth <= window.innerWidth), true);
    await saveScreenshot(page, "builder-metrics-integration-1440.png");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("html").evaluate(element => element.scrollWidth <= window.innerWidth), true);
    await saveScreenshot(page, "builder-metrics-integration-390.png");
    const pending = metricsWithUnstartedRequest();
    const initial = { ...pending.runs[0]!, taskId: "task-qa", role: "qa", reason: "qa-origin-not-observed" };
    const continuation = { ...initial, reason: "qa-continuation-current-session-unavailable" };
    await page.evaluate(value => (window as unknown as { mountBuilder(value: unknown): void }).mountBuilder(value),
      { ...pending, runs: [initial, continuation] });
    await page.waitForFunction(() => document.querySelector('section[aria-label="개발 실행 지표"] tbody')?.children.length === 2);
    assert.equal(await page.getByRole("cell", { name: "ws-1 / task-qa", exact: true }).count(), 2);
    assert.deepEqual(keyWarnings, [], "initial and unmeasured continuation rows must retain distinct React keys");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("html").evaluate(element => element.scrollWidth <= window.innerWidth), true);
    await saveScreenshot(page, "builder-metrics-continuation-390.png");
    await page.getByRole("button", { name: "Lead 대화" }).click();
    assert.equal(await page.getByRole("region", { name: "개발 실행 지표" }).count(), 0, "leaving System unmounts the metrics panel");
  }
  if (evidencePaths.length) console.log(`Execution metrics UI evidence: ${evidencePaths.join(", ")}`);
  } finally {
    await browser?.close();
    await removeOwnedTemp(temporary, BROWSER_TEMP_PREFIX);
  }
});
