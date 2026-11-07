import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { build } from "esbuild";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "66666666-6666-4666-8666-666666666666";
const baseline = (projectId: string, interpretation: string) => ({
  projectId,
  revisionId: "baseline-r01",
  sourceDraftRevisionId: "draft-r01",
  draftDigest: "a".repeat(64),
  createdAt: "2026-11-02T01:02:03.004Z",
  author: { agentId: "22222222-2222-4222-8222-222222222222", sessionId: "33333333-3333-4333-8333-333333333333",
    runId: "44444444-4444-4444-8444-444444444444", selectionRevision: 1 },
  userDecision: { sourceId: "lead-turn:55555555-5555-4555-8555-555555555555", sourceSha256: "b".repeat(64), interpretation },
  specification: { projectId, revisionId: "spec-r01", productTier: "M",
    requirements: [{ id: "REQ-1", description: "Feature", acceptanceCriteriaIds: ["AC-1"] }], targets: ["sps-plugin"],
    dataPolicyRef: "policy-r01", approvalEvidenceRef: "lead-turn:55555555-5555-4555-8555-555555555555" },
  graph: { approvedSpecRevisionId: "spec-r01", graphRevisionId: "graph-r01",
    entities: [{ id: "feature-a", kind: "feature", specRef: "REQ-1", contractRefs: [] }], relations: [], viewLayoutRef: "layout-r01" },
});

declare global {
  interface Window {
    __builderContext: Record<string, unknown>;
    __builderData: Record<string, unknown>;
    __setBuilderData(key: string, value: unknown): void;
    __setBuilderContext(context: Record<string, unknown>): void;
    __baselineDigestPending: Array<{ resolve(value: ArrayBuffer): void }>;
    __resolveBaselineDigest(index: number, hex: string): Promise<void>;
    mountBuilder(): void;
  }
}

async function removeOwnedTemp(directory: string, prefix: string) {
  const [root, resolved] = await Promise.all([realpath(projectRoot), realpath(directory)]);
  const relative = path.relative(root, resolved);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "temporary test directory must resolve beneath projectRoot");
  assert.ok(path.basename(resolved).startsWith(prefix), "temporary test directory must retain its owned prefix");
  await rm(resolved, { recursive: true, force: true });
}

test("late Baseline digest projection cannot replace the latest data or Workspace", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, ".builder-baseline-projection-ui-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = await build({ stdin: { sourcefile: "baseline-projection-harness.tsx", resolveDir: projectRoot, contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { BuilderPage } from "./src/ui/index.tsx";
      const root = createRoot(document.getElementById("root"));
      window.mountBuilder = () => root.render(createElement(BuilderPage));
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    plugins: [{ name: "builder-test-stubs", setup(builder) {
      builder.onResolve({ filter: /plugin-sdk.ui.bridge$/ }, () => ({ path: "bridge", namespace: "builder-test" }));
      builder.onLoad({ filter: /.*/, namespace: "builder-test" }, () => ({
        loader: "js",
        resolveDir: projectRoot,
        contents: `
          import { useSyncExternalStore } from "react";
          const listeners = new Set();
          const notify = () => listeners.forEach(listener => listener());
          window.__builderData = Object.create(null);
          window.__setBuilderData = (key, value) => { window.__builderData[key] = value; notify(); };
          window.__setBuilderContext = context => { window.__builderContext = context; notify(); };
          export function useHostContext() { return window.__builderContext; }
          export function usePluginData(key) {
            const data = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); },
              () => window.__builderData[key] ?? null);
            return { data, loading: false, error: null, refresh() {} };
          }
          export function usePluginAction() { return async () => ({}); }
        `,
      }));
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: "empty-css" }));
      builder.onLoad({ filter: /.*/, namespace: "empty-css" }, () => ({ loader: "js", contents: "export default '';" }));
    } }],
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.setDefaultTimeout(5_000);
    await page.setContent("<body><div id='root'></div></body>");
    await page.evaluate(() => {
      window.__builderContext = { companyId: "11111111-1111-4111-8111-111111111111", companyPrefix: null,
        projectId: null, entityId: null, entityType: null, userId: null };
      const pending: Array<{ algorithm: AlgorithmIdentifier; bytes: Uint8Array<ArrayBuffer>; resolve(value: ArrayBuffer): void }> = [];
      Object.defineProperty(window, "__baselineDigestPending", { value: pending });
      Object.defineProperty(window, "__resolveBaselineDigest", { value: async (index: number, hex: string) => {
        const entry = pending[index];
        entry.resolve(Uint8Array.from(hex.match(/../gu)!, pair => Number.parseInt(pair, 16)).buffer);
      } });
      Object.defineProperty(window, "crypto", { configurable: true, value: { subtle: { digest(algorithm: AlgorithmIdentifier, bytes: Uint8Array<ArrayBuffer>) {
        return new Promise(resolve => pending.push({ algorithm, bytes: Uint8Array.from(bytes), resolve }));
      } } } });
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const first = baseline(workspaceA, "OLD_BASELINE_PROJECTION_SENTINEL");
    const second = baseline(workspaceB, "CURRENT_BASELINE_PROJECTION_SENTINEL");
    const firstDigest = createHash("sha256").update(JSON.stringify(first), "utf8").digest("hex");
    const secondDigest = createHash("sha256").update(JSON.stringify(second), "utf8").digest("hex");
    await page.evaluate(({ first, firstDigest }) => {
      window.__setBuilderData("builder.design-baseline", { workspaceId: window.__builderContext.companyId,
        projectId: window.__builderContext.companyId, sequence: 1, baseline: first, baselineDigest: firstDigest });
      window.mountBuilder();
    }, { first, firstDigest });
    await page.waitForFunction(() => window.__baselineDigestPending.length >= 1);
    await page.evaluate(({ second, secondDigest }) => {
      window.__setBuilderContext({ ...window.__builderContext, companyId: "66666666-6666-4666-8666-666666666666" });
      window.__setBuilderData("builder.design-baseline", {
        workspaceId: window.__builderContext.companyId, projectId: window.__builderContext.companyId, sequence: 2,
        baseline: second, baselineDigest: secondDigest,
      });
    }, { second, secondDigest });
    await page.waitForFunction(() => window.__baselineDigestPending.length >= 2);
    await page.evaluate(digest => window.__resolveBaselineDigest(1, digest), secondDigest);
    await page.getByRole("button", { name: "설계 문서" }).click();
    const detail = page.getByRole("region", { name: "선택한 문서" });
    await detail.getByText("CURRENT_BASELINE_PROJECTION_SENTINEL").waitFor();
    await page.evaluate(digest => window.__resolveBaselineDigest(0, digest), firstDigest);
    await page.waitForTimeout(50);
    assert.match(await detail.innerText(), /CURRENT_BASELINE_PROJECTION_SENTINEL/u);
    assert.doesNotMatch(await detail.innerText(), /OLD_BASELINE_PROJECTION_SENTINEL/u);
  } finally {
    await browser?.close();
    await removeOwnedTemp(temporary, ".builder-baseline-projection-ui-");
  }
});
