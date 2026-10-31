import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import type { BuilderSnapshot } from "../src/domain/model.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const primaryBridge = "__spsPluginBridge__";
const legacyBridge = "__paperclipPluginBridge__";

const reactFlowStub = {
  name: "react-flow-ssr-stub",
  setup(builder: import("esbuild").PluginBuild) {
    builder.onResolve({ filter: /^@xyflow\/react$/ }, () => ({ path: "xyflow", namespace: "ui-bridge-test" }));
    builder.onResolve({ filter: /^@xyflow\/react\/dist\/style\.css$/ }, () => ({ path: "xyflow-css", namespace: "ui-bridge-test" }));
    builder.onLoad({ filter: /.*/, namespace: "ui-bridge-test" }, args => args.path === "xyflow-css"
      ? { contents: "", loader: "text" }
      : { contents: `import { jsx } from "react/jsx-runtime";
        export const MarkerType = { ArrowClosed: "arrowclosed" };
        export const ReactFlow = ({ children }) => jsx("div", { "data-test-react-flow": "true", children });
        export const Background = () => null;
        export const Controls = () => null;`, loader: "jsx" });
  },
};

function snapshotWithMessage(workspaceId: string, text: string): BuilderSnapshot {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  snapshot.messages.push({ id: `message-${workspaceId}`, channel: "main", actorId: null, role: "user",
    text, createdAt: "2026-11-01T00:00:00.000Z", runId: null });
  return snapshot;
}

test("BuilderPage uses the public UI bridge for scoped data and action hooks", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, ".ui-bridge-test-"));
  const previousPrimary = globalThis[primaryBridge as keyof typeof globalThis];
  const previousLegacy = globalThis[legacyBridge as keyof typeof globalThis];
  try {
    const output = path.join(temporary, "BuilderPage.mjs");
    await build({
      entryPoints: [path.join(projectRoot, "src", "ui", "index.tsx")],
      outfile: output,
      bundle: true,
      external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
      platform: "node",
      format: "esm",
      jsx: "automatic",
      loader: { ".css": "text" },
      plugins: [reactFlowStub],
    });
    const { BuilderPage } = await import(pathToFileURL(output).href);

    const hookCalls: Array<[string, unknown[]]> = [];
    let hostContext = { companyId: null as string | null, companyPrefix: null as string | null };
    let pluginData: { data: unknown; loading: boolean; error: { message: string } | null; refresh(): void } = {
      data: null, loading: false, error: null, refresh() {},
    };
    let actionCalls = 0;
    (globalThis as Record<string, unknown>)[primaryBridge] = {
      sdkUi: {
        useHostContext() { hookCalls.push(["context", []]); return hostContext; },
        usePluginData(...args: unknown[]) { hookCalls.push(["data", args]); return pluginData; },
        usePluginAction(...args: unknown[]) {
          hookCalls.push(["action", args]);
          return async () => { actionCalls += 1; return { saved: true, analysisStarted: false }; };
        },
      },
    };
    delete (globalThis as Record<string, unknown>)[legacyBridge];

    const render = () => renderToStaticMarkup(createElement(BuilderPage));
    hostContext = { companyId: null, companyPrefix: null };
    let html = render();
    assert.match(html, /Select an SPS Workspace to open Builder\./);

    hookCalls.length = 0;
    const workspaceA = "11111111-1111-4111-8111-111111111111";
    hostContext = { companyId: workspaceA, companyPrefix: "Studio" };
    pluginData = { data: null, loading: false, error: null, refresh() {} };
    html = render();
    assert.match(html, /Lead 대화가 아직 없습니다/);
    assert.match(html, /textarea[^>]*disabled/);
    assert.match(html, /button[^>]*disabled[^>]*>.*보내기/s);
    assert.match(html, /상담 텍스트 가져오기/);
    assert.ok(hookCalls.some(([hook, args]) => hook === "context" && args.length === 0));
    assert.ok(hookCalls.some(([hook, args]) => hook === "data" && args[0] === "builder.snapshot"));
    assert.ok(hookCalls.some(([hook, args]) => hook === "action" && args[0] === "builder.import-consultation"));
    assert.equal(actionCalls, 0, "SSR wiring must not execute a user action");

    const foreignWorkspace = "22222222-2222-4222-8222-222222222222";
    pluginData = { data: snapshotWithMessage(foreignWorkspace, "FOREIGN_WORKSPACE_SECRET_MARKER"), loading: false, error: null, refresh() {} };
    html = render();
    assert.match(html, /Workspace 상태를 불러오지 못했습니다/);
    assert.doesNotMatch(html, /FOREIGN_WORKSPACE_SECRET_MARKER/);

    pluginData = {
      data: snapshotWithMessage(workspaceA, "VALID SAME-WORKSPACE CACHED MESSAGE"),
      loading: false,
      error: { message: "host data request failed" },
      refresh() {},
    };
    html = render();
    assert.match(html, /Workspace 상태를 불러오지 못했습니다/);
    assert.match(html, /VALID SAME-WORKSPACE CACHED MESSAGE/);
    assert.doesNotMatch(html, /FOREIGN_WORKSPACE_SECRET_MARKER/);
  } finally {
    delete (globalThis as Record<string, unknown>)[primaryBridge];
    delete (globalThis as Record<string, unknown>)[legacyBridge];
    if (previousPrimary !== undefined) (globalThis as Record<string, unknown>)[primaryBridge] = previousPrimary;
    if (previousLegacy !== undefined) (globalThis as Record<string, unknown>)[legacyBridge] = previousLegacy;
    await rm(temporary, { recursive: true, force: true });
  }
});
