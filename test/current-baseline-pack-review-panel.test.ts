import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { build } from "esbuild";
import type { CurrentBaselinePackReviewPanelProps, CurrentBaselinePackReviewView } from "../src/ui/CurrentBaselinePackReviewPanel.tsx";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sha = "a".repeat(64);
const proposalRevisionId = "current-pack-proposal-r7";
const approvalRevisionId = "current-pack-approval-r2";
type ReadyFixture = Readonly<{ status: "ready"; data: Readonly<{
  current: Readonly<{ sequence: number; revision: Record<string, unknown> }>;
  currentBaselineRevisionId: string;
  currentBaselineSequence: number;
  matchesCurrentBaseline: boolean;
  currentApproval: unknown;
}> }>;

// TEST_FIXTURE_ONLY: synthetic current-Baseline pins for isolated panel behavior tests.
function fixture(): ReadyFixture {
  const quote = "사용자는 저장된 진행 상태를 안전하게 다시 열 수 있어야 합니다.";
  return { status: "ready", data: {
    current: { sequence: 7, revision: {
      status: "PROPOSED", revisionId: proposalRevisionId, workspaceId: "workspace-fixture", projectId: "workspace-fixture",
      baselineRevisionId: "baseline-r12", baselineSequence: 12,
      identity: { workspaceId: "workspace-fixture", projectId: "workspace-fixture", specRevisionId: "spec-r8", specDigest: sha },
      scopeBindings: [{ requirementId: "REQ-1", acIds: ["AC-1"] }],
      author: { agentId: "lead-fixture", sessionId: "main-fixture", runId: "run-fixture", selectionRevision: 4 },
      createdAt: "2026-11-07T00:00:00.000Z",
      pack: { packId: "resume-flow", version: "3.2", identity: { workspaceId: "workspace-fixture", projectId: "workspace-fixture",
        specRevisionId: "spec-r8", specDigest: sha }, applicability: { all: ["saved-session"] },
        rules: [{ id: "resume-preserves-state", requirementIds: ["REQ-1"], appliesWhen: {}, requiresCheck: true,
          modelCases: [{ when: {}, state: "paused", event: "resume", allowedNextStates: ["active"] }] }],
        transitions: [{ from: "paused", event: "resume", to: "active" }], exceptions: [], excludedCombinations: [] },
      rulesManifest: { rulesVersion: "coverage-r8", digest: "b".repeat(64), identity: { workspaceId: "workspace-fixture",
        projectId: "workspace-fixture", specRevisionId: "spec-r8", specDigest: sha }, scope: { requirementIds: ["REQ-1"], acIds: ["AC-1"] }, rules: [], targets: [] },
      sourceRefs: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: "lead-turn:main-turn-17", sourceDigest: "c".repeat(64), revisionId: "spec-r8" }],
      designModel: { kind: "design-model-v1", facts: ["saved-session"],
        rulesManifest: { rulesVersion: "coverage-r8", digest: "d".repeat(64), identity: { workspaceId: "workspace-fixture",
          projectId: "workspace-fixture", specRevisionId: "spec-r8", specDigest: sha }, scope: { requirementIds: ["REQ-1"], acIds: ["AC-1"] }, rules: [], targets: [] },
        scenarios: [{ id: "resume-scenario", state: "paused", event: "resume", nextState: "active", exceptionId: null }],
        itemDecisions: [{ requirementId: "REQ-1", status: "RESOLVED", reason: "핀에 연결된 요구사항으로 확인", sourceIds: ["lead-turn:main-turn-17"] }],
        acceptanceCriteria: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: "lead-turn:main-turn-17", sourceDigest: "c".repeat(64),
          text: quote, textSha256: createHash("sha256").update(quote, "utf8").digest("hex") }] },
    } },
    currentBaselineRevisionId: "baseline-r12", currentBaselineSequence: 12, matchesCurrentBaseline: true,
    currentApproval: { sequence: 2, revision: { status: "APPROVED", revisionId: approvalRevisionId, workspaceId: "workspace-fixture",
      projectId: "workspace-fixture", packId: "resume-flow", proposalRevisionId: "older-pack-r6", proposalDigest: "e".repeat(64),
      baselineRevisionId: "baseline-r12", baselineSequence: 12,
      identity: { workspaceId: "workspace-fixture", projectId: "workspace-fixture", specRevisionId: "spec-r8", specDigest: sha },
      designModelDigest: "f".repeat(64), user: { userId: "user-fixture", agentId: "lead-fixture", sessionId: "main-fixture",
        selectionRevision: 4, approvedAt: "2026-11-06T22:00:00.000Z" } } },
  } };
}

async function loadPanel() {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".current-baseline-pack-review-test-"));
  const output = path.join(temporary, "CurrentBaselinePackReviewPanel.mjs");
  await build({ entryPoints: [path.join(projectRoot, "src/ui/CurrentBaselinePackReviewPanel.tsx")], outfile: output,
    bundle: true, external: ["react", "react/jsx-runtime"], platform: "node", format: "esm", jsx: "automatic" });
  const module = await import(pathToFileURL(output).href);
  return { Panel: module.CurrentBaselinePackReviewPanel as typeof import("../src/ui/CurrentBaselinePackReviewPanel.tsx").CurrentBaselinePackReviewPanel,
    temporary };
}

test("loading, empty, and error states never show an old approval as new data or enable confirmation", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    for (const view of [{ status: "loading" }, { status: "empty" }, { status: "error" }] as const) {
      const html = renderToStaticMarkup(createElement(Panel, { view } as CurrentBaselinePackReviewPanelProps));
      assert.match(html, view.status === "error" ? /role="alert"/u : /role="status"/u);
      assert.doesNotMatch(html, /current-pack-approval-r2|REQ-1|resume-flow/u);
      assert.doesNotMatch(html, /<button/u);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("renders exact current Baseline, proposed pack, source pins, model scenario and pinned AC quote read-only", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    const html = renderToStaticMarkup(createElement(Panel, { view: fixture(), onConfirm() { return { status: "published" }; } }));
    for (const value of ["baseline-r12", proposalRevisionId, "resume-flow", "3.2", "coverage-r8", "REQ-1", "AC-1",
      "lead-turn:main-turn-17", "c".repeat(64), "resume-preserves-state", "saved-session", "resume-scenario",
      "사용자는 저장된 진행 상태를 안전하게 다시 열 수 있어야 합니다.", approvalRevisionId]) assert.ok(html.includes(value), value);
    assert.match(html, /실제 코드 실행이나 QA 합격이 아닙니다/u);
    assert.match(html, /Baseline 발행이나 실행·QA 권한을 부여하지 않습니다/u);
    assert.doesNotMatch(html, /<input|<textarea|contenteditable/u);
    assert.match(html, /<button[^>]*>이 규칙 팩·모델 확인/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("stale, mismatched, malformed or unbound views cannot confirm", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    const ready = fixture();
    const stale = renderToStaticMarkup(createElement(Panel, { view: { ...ready, status: "stale" }, onConfirm() {} }));
    assert.match(stale, /다시 불러오기 전까지 확인할 수 없습니다/u);
    assert.match(stale, /<button[^>]*disabled=""/u);
    const mismatched = { ...ready, data: { ...ready.data, matchesCurrentBaseline: false } };
    assert.match(renderToStaticMarkup(createElement(Panel, { view: mismatched, onConfirm() {} })), /<button[^>]*disabled=""/u);
    const badPins = { ...ready, data: { ...ready.data, currentBaselineRevisionId: "baseline-r11" } };
    assert.match(renderToStaticMarkup(createElement(Panel, { view: badPins, onConfirm() {} })), /<button[^>]*disabled=""/u);
    const malformed = { ...ready, data: { ...ready.data, currentApproval: { sequence: 3, revision: { status: "APPROVED" } } } };
    assert.match(renderToStaticMarkup(createElement(Panel, { view: malformed, onConfirm() {} })), /구조가 올바르지 않아 새 확인을 차단/u);
    assert.match(renderToStaticMarkup(createElement(Panel, { view: ready })), /<button[^>]*disabled=""/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("sends exact approval CAS pins and preserves the prior approval after unknown or conflicting results", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".current-baseline-pack-review-browser-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const contents = [
      'import { createElement } from "react";',
      'import { createRoot } from "react-dom/client";',
      'import { CurrentBaselinePackReviewPanel } from "./src/ui/CurrentBaselinePackReviewPanel.tsx";',
      "window.calls = []; window.refreshes = 0;",
      "window.mount = (view, result) => createRoot(document.getElementById('root')).render(createElement(CurrentBaselinePackReviewPanel, {",
      " view, onConfirm: async (input) => { window.calls.push(input); if (result === 'throw') throw new Error('response lost'); return result === 'conflict' ? { status: 'conflict' } : { status: 'unknown' }; },",
      " onRefresh: () => { window.refreshes++; },",
      "}));",
    ].join("\n");
    const result = await build({ stdin: { sourcefile: "current-pack-review-harness.tsx", resolveDir: projectRoot, contents },
      bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent("<div id='root'></div>");
    await page.addScriptTag({ content: result.outputFiles[0]!.text });
    await page.evaluate(({ view, mode }) => (window as unknown as { mount: (value: unknown, mode: string) => void }).mount(view, mode),
      { view: fixture(), mode: "throw" });
    await page.getByRole("button", { name: "이 규칙 팩·모델 확인" }).click();
    await page.getByText("저장 결과를 확인할 수 없습니다. 기존 확인을 보존해 표시하며 재전송하지 않았습니다.").waitFor();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls), [{
      projectId: "workspace-fixture", packId: "resume-flow", expectedProposalRevisionId: proposalRevisionId,
      expectedBaselineRevisionId: "baseline-r12", expectedApprovalRevisionId: approvalRevisionId,
    }]);
    assert.ok(await page.getByText(approvalRevisionId, { exact: true }).count() >= 1);
    assert.equal(await page.getByRole("button", { name: "이 규칙 팩·모델 확인" }).isDisabled(), true);
    assert.equal(await page.evaluate(() => (window as unknown as { refreshes: number }).refreshes), 0);
    await page.getByRole("button", { name: "최신 기록 다시 읽기" }).click();
    assert.equal(await page.evaluate(() => (window as unknown as { refreshes: number }).refreshes), 1);
    const conflictPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await conflictPage.setContent("<div id='root'></div>");
    await conflictPage.addScriptTag({ content: result.outputFiles[0]!.text });
    await conflictPage.evaluate(view => (window as unknown as { mount: (value: unknown, mode: string) => void }).mount(view, "conflict"), fixture());
    await conflictPage.getByRole("button", { name: "이 규칙 팩·모델 확인" }).click();
    await conflictPage.getByText("제안 또는 확인 head가 바뀌었습니다. 자동 재시도하지 않았습니다.").waitFor();
    assert.equal(await conflictPage.getByText(approvalRevisionId, { exact: true }).count() >= 1, true);
    assert.equal(await conflictPage.getByRole("button", { name: "이 규칙 팩·모델 확인" }).isDisabled(), true);
    await conflictPage.close();
    const layout = () => page.evaluate(() => ({ pageFits: document.documentElement.scrollWidth <= innerWidth,
      panelFits: document.querySelector<HTMLElement>(".sps-cbpr")!.scrollWidth <= document.querySelector<HTMLElement>(".sps-cbpr")!.clientWidth + 1 }));
    assert.deepEqual(await layout(), { pageFits: true, panelFits: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.deepEqual(await layout(), { pageFits: true, panelFits: true });
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
