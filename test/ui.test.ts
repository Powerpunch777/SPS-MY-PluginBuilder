import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { BuilderShellProps } from "../src/domain/model.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("BuilderShell server-renders the Lead workspace without inventing activity", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, ".ui-test-"));
  try {
    const output = path.join(temporary, "BuilderShell.mjs");
    await build({
      entryPoints: [path.join(projectRoot, "src", "ui", "BuilderShell.tsx")],
      outfile: output,
      bundle: true,
      external: ["react", "react-dom", "react-dom/server"],
      platform: "node",
      format: "esm",
      jsx: "automatic",
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
    const { BuilderShell } = await import(pathToFileURL(output).href);
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
    assert.match(html, /Lead 대화/);
    assert.match(html, /Need a project brief/);
    assert.match(html, /CTO One/);
    assert.doesNotMatch(html, /Dev One/);
    assert.doesNotMatch(html, /Lead, 실행 중/);
    assert.match(html, /메시지 전송을 사용할 수 없습니다/);
    assert.match(html, /저장된 작업이 생기면 여기에 표시됩니다/);
    assert.match(html, /class="builder-shell"/);
    assert.match(html, /aria-label="상담 텍스트 가져오기"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /aria-label="상담 텍스트"/);
    assert.equal((html.match(/aria-label="Lead HTML 뷰어 열기"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /HTML 뷰어.*사용 가능/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
