import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { build } from "esbuild";
import type { FirstDesignReviewBundle } from "../src/spec-assurance/review-first-design.ts";
import type { FirstDesignReviewPanelProps, FirstDesignReviewPanelView } from "../src/ui/FirstDesignReviewPanel.tsx";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sha = "a".repeat(64);
const proposalRevisionId = "first-review-fixture-r4";
const expectedHead = "head-fixture-r9";

// TEST_FIXTURE_ONLY: synthetic bundle values for isolated rendering and action-gating tests.
type ReadyFixture = Omit<Extract<FirstDesignReviewPanelView, { status: "ready" }>, "bundle"> & { bundle: FirstDesignReviewBundle };
function fixture(): ReadyFixture {
  const draft = {
    projectId: "workspace-fixture", revisionId: "draft-fixture-r3",
    sourceIds: ["lead-turn:turn-fixture-1", "consultation-capture-fixture-2"],
    specification: { revisionId: "spec-fixture-r2", productTier: "M" as const,
      requirements: [
        { id: "REQ-1", description: "사용자는 가입 안내를 확인할 수 있다.", acceptanceCriteriaIds: ["AC-1", "AC-2"] },
        { id: "REQ-2", description: "사용자는 나중에 이어서 진행할 수 있다.", acceptanceCriteriaIds: ["AC-3"] },
      ], targets: ["sps-plugin" as const], dataPolicyRef: "policy-fixture-r1" },
    graph: { graphRevisionId: "graph-fixture-r2", entities: [], relations: [], viewLayoutRef: "layout-fixture-r1" },
    questions: [],
  };
  const bundle: FirstDesignReviewBundle = {
    status: "PROPOSED", revisionId: proposalRevisionId, workspaceId: "workspace-fixture", projectId: "workspace-fixture",
    priorBaseline: null, draftRevisionId: draft.revisionId, draftDigest: sha, draft,
    sourcePins: [
      { requirementId: "REQ-1", acId: "AC-1", sourceId: "lead-turn:turn-fixture-1", sourceDigest: sha },
      { requirementId: "REQ-1", acId: null, sourceId: "consultation-capture-fixture-2", sourceDigest: "b".repeat(64) },
      { requirementId: "REQ-2", acId: "AC-3", sourceId: "consultation-capture-fixture-2", sourceDigest: "b".repeat(64) },
    ],
    pack: {
      packId: "onboarding-rules", version: "2.4.1",
      identity: { workspaceId: "workspace-fixture", projectId: "workspace-fixture", specRevisionId: "spec-fixture-r2", specDigest: "c".repeat(64) },
      applicability: { all: ["consumer-account"] },
      rules: [
        { id: "signup-visible", requirementIds: ["REQ-1"], appliesWhen: { all: ["new-user"] }, requiresCheck: true,
          modelCases: [{ when: {}, state: "draft", event: "continue", allowedNextStates: ["profile"] }] },
        { id: "resume-safe", requirementIds: ["REQ-2"], appliesWhen: {}, requiresCheck: false },
      ],
      transitions: [{ from: "draft", event: "continue", to: "profile" }],
      exceptions: [{ id: "resume-expired", from: "draft", event: "continue", to: "restart" }],
      excludedCombinations: [{ from: "locked", event: "continue", to: "profile", reason: "account is locked" }],
    },
    author: { agentId: "agent-fixture", sessionId: "session-fixture", runId: "run-fixture", selectionRevision: 4,
      createdAt: "2026-11-06T01:00:00.000Z" },
  };
  return { status: "ready", bundle, proposalRevisionId, expectedHead };
}

async function loadPanel() {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".first-design-review-test-"));
  const output = path.join(temporary, "FirstDesignReviewPanel.mjs");
  await build({ entryPoints: [path.join(projectRoot, "src/ui/FirstDesignReviewPanel.tsx")], outfile: output,
    bundle: true, external: ["react", "react/jsx-runtime"], platform: "node", format: "esm", jsx: "automatic" });
  const module = await import(pathToFileURL(output).href);
  return { Panel: module.FirstDesignReviewPanel as typeof import("../src/ui/FirstDesignReviewPanel.tsx").FirstDesignReviewPanel, temporary };
}

test("loading, empty, and error states never expose fixture content or enable approval", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    for (const view of [{ status: "loading" }, { status: "empty" }, { status: "error" }] as const) {
      const html = renderToStaticMarkup(createElement(Panel, { view } as FirstDesignReviewPanelProps));
      assert.match(html, view.status === "error" ? /role="alert"/u : /role="status"/u);
      assert.doesNotMatch(html, /first-review-fixture|REQ-1|onboarding-rules/u);
      assert.doesNotMatch(html, /<button/u);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("shows exact Draft, source pin IDs and digests, and the specific rule-pack scope read-only", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    const html = renderToStaticMarkup(createElement(Panel, { view: fixture() }));
    for (const value of ["draft-fixture-r3", "graph-fixture-r2", "REQ-1", "AC-2", "lead-turn:turn-fixture-1", "consultation-capture-fixture-2",
      "a".repeat(64), "b".repeat(64), "onboarding-rules", "2.4.1", "spec-fixture-r2", "signup-visible",
      "resume-safe", "new-user", "resume-expired", "account is locked"]) assert.ok(html.includes(value), value);
    assert.match(html, /읽기 전용/u);
    assert.doesNotMatch(html, /<input|<textarea|contenteditable/u);
    assert.match(html, /QA 합격·Baseline 발행을 뜻하지 않습니다/u);
    assert.match(html, /<button[^>]*>정확한 제안 승인/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("stale proposals, mismatched IDs, missing pins, and absent callback stay non-approvable", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    const ready = fixture();
    const stale = { ...ready, status: "stale" as const };
    const staleHtml = renderToStaticMarkup(createElement(Panel, { view: stale, onApprove() {} }));
    assert.match(staleHtml, /현재 head와 일치하지 않습니다/u);
    assert.match(staleHtml, /<button[^>]*disabled=""/u);

    const mismatch = { ...ready, proposalRevisionId: "different-proposal" };
    assert.match(renderToStaticMarkup(createElement(Panel, { view: mismatch, onApprove() {} })), /revision 또는 예상 head/u);

    const incomplete = { ...ready, bundle: { ...ready.bundle,
      sourcePins: ready.bundle.sourcePins.filter(pin => pin.requirementId !== "REQ-2") } };
    const incompleteHtml = renderToStaticMarkup(createElement(Panel, { view: incomplete, onApprove() {} }));
    assert.match(incompleteHtml, /REQ-2: 연결된 원문 핀이 없습니다/u);
    assert.match(incompleteHtml, /미확인 범위가 있어 승인을 차단했습니다/u);
    assert.match(incompleteHtml, /<button[^>]*disabled=""/u);

    const noCallback = renderToStaticMarkup(createElement(Panel, { view: ready }));
    assert.match(noCallback, /승인 action이 연결되지 않아 비활성 상태입니다/u);
    assert.match(noCallback, /<button[^>]*disabled=""/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("callback receives only proposalRevisionId and expectedHead; CAS conflict marks the view stale", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".first-design-review-browser-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const contents = [
      'import { createElement } from "react";',
      'import { createRoot } from "react-dom/client";',
      'import { FirstDesignReviewPanel } from "./src/ui/FirstDesignReviewPanel.tsx";',
      "window.calls = [];",
      "window.mount = (view) => createRoot(document.getElementById('root')).render(createElement(FirstDesignReviewPanel, {",
      " view, onApprove: async (input) => { window.calls.push(input); return { status: 'conflict' }; },",
      "}));",
    ].join("\n");
    const result = await build({ stdin: { sourcefile: "review-harness.tsx", resolveDir: projectRoot, contents },
      bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent("<div id='root'></div>");
    await page.addScriptTag({ content: result.outputFiles[0]!.text });
    await page.evaluate(view => (window as unknown as { mount: (value: unknown) => void }).mount(view), fixture());
    await page.getByRole("button", { name: "정확한 제안 승인" }).click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls), [
      { proposalRevisionId, expectedHead },
    ]);
    await page.getByText("head가 바뀌었습니다. 최신 제안을 다시 불러오세요.").waitFor();
    assert.equal(await page.getByRole("button", { name: "정확한 제안 승인" }).isDisabled(), true);
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
