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

function modelFixture(): ReadyFixture {
  const ready = fixture();
  const longSourceId = "consultation-capture:workspace-fixture:source-" + "long-id-".repeat(12);
  const sourceDigest = "b".repeat(64);
  const quote = "원문 인용: 사용자는 가입 안내를 확인하고 나중에 이어서 진행할 수 있어야 합니다. ".repeat(12);
  const bundle = { ...ready.bundle,
    draft: { ...ready.bundle.draft, sourceIds: [ready.bundle.draft.sourceIds[0]!, longSourceId] },
    sourcePins: ready.bundle.sourcePins.map(pin => pin.sourceId === "consultation-capture-fixture-2"
      ? { ...pin, sourceId: longSourceId } : pin),
    designModel: {
      kind: "design-model-v1" as const,
      facts: ["가입 경로: 신규 사용자", "원문 인용은 그대로 확인"],
      rulesManifest: {
        rulesVersion: "coverage-r3", digest: "d".repeat(64),
        identity: { workspaceId: ready.bundle.workspaceId, projectId: ready.bundle.projectId,
          specRevisionId: ready.bundle.pack.identity.specRevisionId, specDigest: ready.bundle.pack.identity.specDigest },
        scope: { requirementIds: ["REQ-1", "REQ-2"], acIds: ["AC-1", "AC-3"] },
        rules: [{ id: "coverage-presence", requiresCheck: true, requiredEvidenceKinds: ["specification"] }],
        targets: [{ targetId: "REQ-1", targetKind: "requirement", ruleIds: ["coverage-presence"] }],
      },
      scenarios: [{ id: "scenario-long-source", state: "draft", event: "continue", nextState: "profile", exceptionId: null }],
      itemDecisions: [
        { requirementId: "REQ-1", status: "RESOLVED", reason: "원문 핀에 연결된 조건으로 확인했습니다.",
          sourceIds: ["lead-turn:turn-fixture-1"] },
        { requirementId: "REQ-2", status: "INCONCLUSIVE", reason: "추가 확인이 필요한 원문 범위입니다.", sourceIds: [longSourceId] },
      ],
      acceptanceCriteria: [
        { requirementId: "REQ-1", acId: "AC-1", sourceId: "lead-turn:turn-fixture-1", sourceDigest: "a".repeat(64),
          text: quote, textSha256: createHash("sha256").update(quote, "utf8").digest("hex") },
        { requirementId: "REQ-2", acId: "AC-3", sourceId: longSourceId, sourceDigest,
          text: "나중에 다시 시작할 때 입력이 보존됩니다.",
          textSha256: createHash("sha256").update("나중에 다시 시작할 때 입력이 보존됩니다.", "utf8").digest("hex") },
      ],
    },
  } as unknown as FirstDesignReviewBundle;
  return { ...ready, bundle };
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
    assert.match(html, /QA 합격이나 실행 권한은 아닙니다/u);
    assert.match(html, /<button[^>]*>정확한 제안 승인/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("follow-up review renders the exact prior Baseline revision, sequence, and digest", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    const ready = fixture();
    const priorBaseline = { revisionId: "baseline-fixture-r8", sequence: 8, digest: "f".repeat(64) };
    const followup = { ...ready, bundle: { ...ready.bundle, priorBaseline } };
    const html = renderToStaticMarkup(createElement(Panel, { view: followup, onApprove() {} }));
    assert.match(html, /baseline-fixture-r8 · seq 8/u);
    assert.ok(html.includes(priorBaseline.digest));
    assert.match(html, /이전 Baseline digest \(SHA-256\)/u);
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

test("design model requires its kind, exact identity, and complete arrays before approval", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    const ready = modelFixture();
    const invalidModels = [
      { ...ready.bundle.designModel!, kind: "design-model-v2" },
      { ...ready.bundle.designModel!, rulesManifest: { ...ready.bundle.designModel!.rulesManifest,
        identity: { ...ready.bundle.designModel!.rulesManifest.identity, projectId: "other-project" } } },
      { ...ready.bundle.designModel!, scenarios: undefined },
    ];
    for (const designModel of invalidModels) {
      const html = renderToStaticMarkup(createElement(Panel, { view: { ...ready,
        bundle: { ...ready.bundle, designModel } }, onApprove() {} }));
      assert.match(html, /제안 구조가 올바르지 않아 검토와 승인을 차단했습니다/u);
      assert.doesNotMatch(html, /<button\b[^>]*>정확한 제안 승인<\/button>/u);
    }

    const legacy = fixture();
    const legacyHtml = renderToStaticMarkup(createElement(Panel, { view: legacy, onApprove() {} }));
    assert.match(legacyHtml, /<button[^>]*>정확한 제안 승인/u);
    assert.doesNotMatch(legacyHtml, /명세 모델 검사 입력/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("design model renders pinned quotes responsively and approval sends only the unchanged revision pair", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".first-design-review-model-browser-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const contents = [
      'import { createElement } from "react";',
      'import { createRoot } from "react-dom/client";',
      'import { FirstDesignReviewPanel } from "./src/ui/FirstDesignReviewPanel.tsx";',
      "window.calls = [];",
      "window.mount = (view) => createRoot(document.getElementById('root')).render(createElement(FirstDesignReviewPanel, {",
      " view, onApprove: async (input) => { window.calls.push(input); return { status: 'accepted' }; },",
      "}));",
    ].join("\n");
    const result = await build({ stdin: { sourcefile: "review-harness.tsx", resolveDir: projectRoot, contents },
      bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.setContent("<div id='root'></div>");
    await page.addScriptTag({ content: result.outputFiles[0]!.text });
    const ready = modelFixture();
    await page.evaluate(view => (window as unknown as { mount: (value: unknown) => void }).mount(view), ready);

    const quote = ("원문 인용: 사용자는 가입 안내를 확인하고 나중에 이어서 진행할 수 있어야 합니다. ").repeat(12);
    const longSourceId = "consultation-capture:workspace-fixture:source-" + "long-id-".repeat(12);
    await page.getByText(quote, { exact: true }).waitFor();
    await page.getByText(longSourceId, { exact: true }).first().waitFor();
    await page.getByText("coverage-r3", { exact: true }).waitFor();

    const inspectLayout = () => page.evaluate(() => {
      const overflowing = Array.from(document.querySelectorAll<HTMLElement>(".sps-fdr *"))
        .filter(element => element.scrollWidth > element.clientWidth + 1)
        .map(element => element.tagName + "." + element.className);
      const selectors = ".sps-fdr-item, .sps-fdr-rule, blockquote, .sps-fdr-actions > *";
      const overlaps: string[] = [];
      for (const parent of Array.from(document.querySelectorAll<HTMLElement>(".sps-fdr *"))) {
        const children = Array.from(parent.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches(selectors));
        for (let left = 0; left < children.length; left++) for (let right = left + 1; right < children.length; right++) {
          const a = children[left]!.getBoundingClientRect(), b = children[right]!.getBoundingClientRect();
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(children[left]!.className + " / " + children[right]!.className);
        }
      }
      return { pageFits: document.documentElement.scrollWidth <= innerWidth,
        panelFits: document.querySelector<HTMLElement>(".sps-fdr")!.scrollWidth <= document.querySelector<HTMLElement>(".sps-fdr")!.clientWidth + 1,
        overflowing, overlaps };
    });
    assert.deepEqual(await inspectLayout(), { pageFits: true, panelFits: true, overflowing: [], overlaps: [] });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(await inspectLayout(), { pageFits: true, panelFits: true, overflowing: [], overlaps: [] });
    await page.getByRole("button", { name: "정확한 제안 승인" }).click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls), [
      { proposalRevisionId, expectedHead },
    ]);
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
