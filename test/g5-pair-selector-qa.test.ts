import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = process.env.SPS_G5_QA_ROOT
  ? path.resolve(process.env.SPS_G5_QA_ROOT)
  : path.resolve(import.meta.dirname, "..");
const requireFromCopy = createRequire(path.join(projectRoot, "package.json"));
const { build } = requireFromCopy("esbuild") as { build: (options: Record<string, unknown>) => Promise<{ outputFiles: Array<{ text: string }> }> };
const { chromium } = requireFromCopy("playwright") as { chromium: { launch(options: { headless: boolean }): Promise<any> } };
const projectId = "11111111-1111-4111-8111-111111111111";

async function loadBrowserBundle() {
  const bundle = await build({
    stdin: { sourcefile: "g5-pair-selector-qa.tsx", resolveDir: projectRoot, contents: `
      import { createElement, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { ChangeImpactPanel } from "./src/ui/ChangeImpactPanel.tsx";
      const digest = "a".repeat(64);
      window.fixture = (projectId, pairRows = []) => {
        const suffix = projectId.slice(0, 8);
        const oldBaseline = "baseline-old-" + suffix;
        const newBaseline = "baseline-new-" + suffix;
        return { projectId, selectableBaselines: [
        { baselineRevisionId: oldBaseline, sequence: 1, sourceSpecRevisionId: "spec-old-" + suffix, digest,
          approvedFormalUi: [{ baselineRevisionId: oldBaseline, formalUiRevisionId: "formal-old-" + suffix, formalUiSequence: 1,
            proposalRevisionId: "proposal-old", approvalRevisionId: "approval-old", formalUiDigest: digest,
            approvalDigest: digest, contractRevisionId: "contract-old", htmlSha256: digest, approvedInteractionIds: ["interaction-old"] }] },
        { baselineRevisionId: newBaseline, sequence: 2, sourceSpecRevisionId: "spec-new-" + suffix, digest,
          approvedFormalUi: [{ baselineRevisionId: newBaseline, formalUiRevisionId: "formal-new-" + suffix, formalUiSequence: 2,
            proposalRevisionId: "proposal-new", approvalRevisionId: "approval-new", formalUiDigest: digest,
            approvalDigest: digest, contractRevisionId: "contract-new", htmlSha256: digest, approvedInteractionIds: ["interaction-new"] }] },
      ], comparisonPairs: pairRows, coverage: { limit: 20, baselineHasMore: false, formalUiHasMore: false,
        complete: true, scope: "QA_SOURCE_COPY", excluded: {}, currentPairInferred: false, writesPerformed: false } };
      };
      window.mountPairPanel = (id, read) => {
        window.pairRoot ??= createRoot(document.getElementById("root"));
        window.pairRoot.render(createElement(ChangeImpactPanel, { projectId: id, onReadComparisonPairs: read,
          onQueryImpact: async () => ({}) }));
      };
      window.mountChurningPairPanel = id => {
        function Parent() {
          const [revision, setRevision] = useState(0);
          const read = async () => {
            window.identityReadCount += 1;
            await new Promise(resolve => setTimeout(resolve, 15));
            if (!window.identityParentRerendered) {
              window.identityParentRerendered = true;
              setRevision(value => value + 1);
            }
            return window.fixture(id);
          };
          return createElement("div", null,
            createElement("span", { "data-testid": "pair-parent-revision" }, revision),
            createElement(ChangeImpactPanel, { projectId: id, onReadComparisonPairs: read, onQueryImpact: async () => ({}) }));
        }
        window.pairRoot ??= createRoot(document.getElementById("root"));
        window.identityReadCount = 0;
        window.identityParentRerendered = false;
        window.pairRoot.render(createElement(Parent));
      };
    ` },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
  });
  return bundle.outputFiles[0]!.text;
}

async function openPanel() {
  const browserBundle = await loadBrowserBundle();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  await page.setContent("<body><div id='root'></div></body>");
  await page.addScriptTag({ content: browserBundle });
  return { browser, page };
}

test("registered comparison-pair action accepts only authenticated same-Workspace users and performs reads only", async () => {
  const modulePath = path.join(projectRoot, "src", "platform.ts");
  const { createBuilderPlatform } = await import(pathToFileURL(modulePath).href) as { createBuilderPlatform: () => any };
  const action = createBuilderPlatform().actions.find((item: { key: string }) => item.key === "builder.read-g5-comparison-pairs");
  assert.ok(action, "canonical platform must register the selector as a user action");

  const reads: unknown[] = [];
  const writes: unknown[] = [];
  const context = {
    companyId: projectId,
    actor: { type: "user", companyId: projectId, userId: "22222222-2222-4222-8222-222222222222" },
    state: {
      async get(key: unknown) { reads.push(key); return null; },
      async set(key: unknown, value: unknown) { writes.push([key, value]); },
    },
  };
  const result = await action.handler({ projectId, companyId: projectId }, context);
  assert.equal(result.projectId, projectId);
  assert.equal(result.coverage.writesPerformed, false);
  assert.ok(reads.length > 0, "registered handler should read scoped revision journals");
  assert.deepEqual(writes, []);
  for (const key of reads as Array<{ scopeKind: string; scopeId: string }>) {
    assert.equal(key.scopeKind, "company");
    assert.equal(key.scopeId, projectId);
  }
  await assert.rejects(() => action.handler({ projectId }, { ...context, actor: { ...context.actor, type: "agent" } }), /authenticated user action/u);
  await assert.rejects(() => action.handler({ projectId, companyId: "33333333-3333-4333-8333-333333333333" }, context), /trusted Workspace/u);
  await assert.rejects(() => action.handler({ projectId: "33333333-3333-4333-8333-333333333333" }, context), /authenticated Workspace/u);
  assert.deepEqual(writes, []);
});

test("callback identity churn must not refetch pair options on every parent render", async () => {
  const { browser, page } = await openPanel();
  try {
    await page.evaluate((id: string) => (window as any).mountChurningPairPanel(id), projectId);
    await page.getByTestId("pair-parent-revision").getByText("1", { exact: true }).waitFor();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const reads = await page.evaluate(() => (window as any).identityReadCount);
    assert.equal(reads, 1, `one unchanged project should require one initial pair read; observed ${reads} after parent callback identities changed`);
  } finally {
    await page.evaluate(() => (window as any).pairRoot?.unmount());
    await browser.close();
  }
});

test("late pair response from the previous project is ignored", async () => {
  const { browser, page } = await openPanel();
  try {
    await page.evaluate((id: string) => {
      (window as any).pendingPairReads = [];
      (window as any).readPairs = (request: { projectId: string }) => new Promise(resolve => (window as any).pendingPairReads.push({ request, resolve }));
      (window as any).mountPairPanel(id, (window as any).readPairs);
    }, projectId);
    await page.waitForFunction(() => (window as any).pendingPairReads?.length === 1);
    const nextProject = "44444444-4444-4444-8444-444444444444";
    await page.evaluate((id: string) => (window as any).mountPairPanel(id, (window as any).readPairs), nextProject);
    await page.waitForFunction(() => (window as any).pendingPairReads?.length === 2);
    await page.evaluate((id: string) => (window as any).pendingPairReads[1].resolve((window as any).fixture(id)), nextProject);
    const nextOld = `baseline-old-${nextProject.slice(0, 8)}`;
    const previousOld = `baseline-old-${projectId.slice(0, 8)}`;
    await page.getByLabel("이전 Baseline").locator(`option[value="${nextOld}"]`).waitFor({ state: "attached" });
    await page.evaluate((id: string) => (window as any).pendingPairReads[0].resolve((window as any).fixture(id)), projectId);
    await page.waitForTimeout(80);
    assert.equal(await page.locator(`option[value="${nextOld}"]`).count(), 2);
    assert.equal(await page.locator(`option[value="${previousOld}"]`).count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0);
  } finally {
    await page.evaluate(() => (window as any).pairRoot?.unmount());
    await browser.close();
  }
});

test("malformed comparisonPairs rows must fail closed with an incomplete DTO", async () => {
  const { browser, page } = await openPanel();
  try {
    await page.evaluate((id: string) => {
      const malformed = (window as any).fixture(id, [{ oldBaselineRevisionId: "forged", newBaselineRevisionId: "wrong" }]);
      (window as any).mountPairPanel(id, async () => malformed);
    }, projectId);
    await page.getByRole("alert").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("alert").count(), 1, "malformed pair rows should invalidate the selector DTO");
    assert.equal(await page.locator(".sps-g5-pair-toolbar select option").count(), 0);
  } finally {
    await page.evaluate(() => (window as any).pairRoot?.unmount());
    await browser.close();
  }
});
