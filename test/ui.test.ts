import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { BuilderShellProps } from "../src/domain/model.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

function importBundleInMemory(contents: Uint8Array) {
  const source = Buffer.from(contents).toString("utf8")
    .replaceAll('"react-dom/server"', JSON.stringify(pathToFileURL(require.resolve("react-dom/server")).href))
    .replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href))
    .replaceAll('"react"', JSON.stringify(pathToFileURL(require.resolve("react")).href));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("BuilderShell server-renders the Lead workspace without inventing activity", async () => {
  const result = await build({
      entryPoints: [path.join(projectRoot, "src", "ui", "BuilderShell.tsx")],
      bundle: true,
      external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
      platform: "node",
      format: "esm",
      jsx: "automatic",
      nodePaths: [path.join(projectRoot, "node_modules")],
      write: false,
      loader: { ".css": "text" },
      plugins: [{
        name: "react-flow-ssr-stub",
        setup(builder) {
          builder.onResolve({ filter: /^@xyflow\/react$/ }, () => ({ path: "xyflow", namespace: "ui-test" }));
          builder.onResolve({ filter: /^@xyflow\/react\/dist\/style\.css$/ }, () => ({ path: "xyflow-css", namespace: "ui-test" }));
          builder.onLoad({ filter: /.*/, namespace: "ui-test" }, args => args.path === "xyflow-css"
            ? { contents: "", loader: "text" }
            : { contents: `import { jsx } from "react/jsx-runtime";
              export const MarkerType = { ArrowClosed: "arrowclosed" };
              export const ReactFlow = ({ children }) => jsx("div", { "data-test-react-flow": "true", children });
              export const Background = () => null;
              export const Controls = () => null;`, loader: "jsx" });
        },
      }],
    });
    const output = result.outputFiles[0];
    assert.ok(output, "esbuild should return the in-memory UI bundle");
    const { BuilderShell, resolveSelectedGraphEntity, resolveSelectedDocument } = await importBundleInMemory(output.contents) as
      typeof import("../src/ui/BuilderShell.tsx");
    const graphEntities = [
      { id: "node-first", kind: "feature" as const, label: "First feature", ownerActorId: null, status: "planned" as const, evidenceRefs: [] },
      { id: "node-second", kind: "component" as const, label: "Second component", ownerActorId: null, status: "verified" as const, evidenceRefs: [] },
    ];
    assert.equal(resolveSelectedGraphEntity(graphEntities, "node-second")?.id, "node-second");
    assert.equal(resolveSelectedGraphEntity(graphEntities, "removed-node")?.id, "node-first", "A stale selection falls back to the current snapshot.");
    assert.equal(resolveSelectedGraphEntity([], "removed-node"), null, "An empty refreshed graph has no selected node.");
    const documents = [
      { id: "doc-first", title: "First document", revisionId: "r01", text: "First body", createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "doc-second", title: "Second document", revisionId: "r02", text: "Second body", createdAt: "2026-11-01T01:00:00.000Z" },
    ];
    assert.equal(resolveSelectedDocument(documents, "doc-second")?.id, "doc-second");
    assert.equal(resolveSelectedDocument(documents.slice(1), "doc-first")?.id, "doc-second", "A removed selected document falls back to the current first document.");
    assert.equal(resolveSelectedDocument([], "doc-first"), null, "An empty refreshed document list clears the selection.");
    const props: BuilderShellProps = {
      workspaceLabel: "Studio",
      snapshot: {
        schemaVersion: 1,
        workspaceId: "workspace-test",
        revision: 3,
        leadSessions: { main: null, "cto-inbox": null, decisions: null },
        actors: [
          { id: "lead-1", role: "lead", label: "Lead", parentActorId: null, agentId: null, sessionId: null, status: "running" },
          { id: "cto-1", role: "cto", label: "CTO One", parentActorId: "lead-1", agentId: "agent-1", sessionId: "session-1", status: "running" },
          { id: "dev-1", role: "development", label: "Dev One", parentActorId: "cto-1", agentId: "agent-2", sessionId: "session-2", status: "idle" },
        ],
        messages: [{ id: "message-1", channel: "main", actorId: null, role: "user", text: "Need a project brief", createdAt: "2026-10-31T12:00:00.000Z", runId: null }],
        documents: [], questions: [], graph: { revisionId: null, entities: [], relations: [] }, activity: [],
        integrations: { ai: "not_configured", github: "not_configured", htmlPreview: "unavailable" },
      },
      onRefresh() {},
      onImportConsultation: async () => {},
      onOpenHtmlPreview() {},
    };
    const html = renderToStaticMarkup(createElement(BuilderShell, props));
    assert.match(html, /aria-label="Main"/);
    assert.match(html, /aria-label="UI Design"/);
    assert.match(html, /aria-label="미결정사항"/);
    assert.ok(html.indexOf('aria-label="Main"') < html.indexOf('aria-label="UI Design"'));
    assert.ok(html.indexOf('aria-label="UI Design"') < html.indexOf('aria-label="미결정사항"'));
    assert.match(html, /Need a project brief/);
    assert.match(html, /CTO One/);
    assert.doesNotMatch(html, /Dev One/);
    assert.doesNotMatch(html, /Lead, 실행 중/);
    assert.match(html, /메시지 전송을 사용할 수 없습니다/);
    assert.match(html, /저장된 작업이 생기면 여기에 표시됩니다/);
    assert.match(html, /class="builder-shell"/);
    assert.doesNotMatch(html, /class="builder-view-header"/);
    assert.match(html, /Main/);
    assert.match(html, /role="tablist"/);
    for (const tab of ["수정사항", "작업 지시", "기록", "작업 파일", "설계"]) assert.ok(html.includes(`>${tab}</button>`));
    const css = await readFile(path.join(projectRoot, "src/ui/builder.css"), "utf8");
    assert.match(css, /--builder-bg: #181818/);
    assert.doesNotMatch(css, /var\(--sps-host-(?:accent|surface|background)/);
    assert.match(html, /aria-label="상담 텍스트 가져오기"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /aria-label="상담 텍스트"/);
    assert.equal((html.match(/aria-label="Lead HTML 뷰어 열기"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /HTML 뷰어.*사용 가능/);
});
