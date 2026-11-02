import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { BuilderSnapshot, BuilderShellProps } from "../src/domain/model.ts";

const root = path.resolve(import.meta.dirname, "..");

test("a CTO intake decision question is visibly read-only until answer binding exists", async () => {
  const temporary = await mkdtemp(path.join(root, "node_modules", ".question-composer-test-"));
  try {
    const output = path.join(temporary, "BuilderShell.mjs");
    await build({
      entryPoints: [path.join(root, "src", "ui", "BuilderShell.tsx")],
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
          builder.onResolve({ filter: /^@xyflow\/react$/ }, () => ({ path: "xyflow", namespace: "question-test" }));
          builder.onResolve({ filter: /^@xyflow\/react\/dist\/style\.css$/ }, () => ({ path: "xyflow-css", namespace: "question-test" }));
          builder.onLoad({ filter: /.*/, namespace: "question-test" }, args => args.path === "xyflow-css"
            ? { contents: "", loader: "text" }
            : { contents: `import { jsx } from "react/jsx-runtime";
              export const MarkerType = { ArrowClosed: "arrowclosed" };
              export const ReactFlow = ({ children }) => jsx("div", { children });
              export const Background = () => null;
              export const Controls = () => null;`, loader: "jsx" });
        },
      }],
    });
    const { DecisionsView } = await import(pathToFileURL(output).href);
    const snapshot: BuilderSnapshot = {
      schemaVersion: 1,
      workspaceId: "workspace-1",
      revision: 1,
      leadSessions: { main: null, "cto-inbox": null, decisions: "decisions-session" },
      actors: [],
      messages: [],
      documents: [],
      questions: [{
        id: "question-1",
        title: "Choose a deployment target",
        text: "Which target should the draft use?",
        status: "open",
        options: [],
        recommendation: null,
        decisionOrigin: "cto-intake",
        ctoRecommendation: "desktop",
        answerUnavailableReason: "이 CTO 질문의 답변 연결은 아직 준비되지 않았습니다.",
        originQuestionId: "proposal-1",
        originWorkstreamId: "workstream-1",
        answer: null,
        revisionId: null,
      }],
      graph: { revisionId: null, entities: [], relations: [] },
      activity: [],
      integrations: { ai: "ready", github: "not_configured", htmlPreview: "unavailable" },
    };
    const props: BuilderShellProps = { snapshot, workspaceLabel: "Studio", onRefresh() {} };
    const html = renderToStaticMarkup(createElement(DecisionsView, {
      props,
      drawerOpen: false,
      onDrawerToggle() {},
      onDrawerClose() {},
    }));

    assert.match(html, /Choose a deployment target/);
    assert.match(html, /답변 필요/);
    assert.match(html, /CTO 작업 질문 · Lead 검토 완료 · 부분 지원, 읽기 전용/);
    assert.match(html, /CTO 권고\(Lead 추천 아님\): desktop/);
    assert.match(html, /이 CTO 질문의 답변 연결은 아직 준비되지 않았습니다\./);
    assert.match(html, /<textarea[^>]*disabled/);
    assert.match(html, /<button[^>]*disabled[^>]*type="submit"/);
    assert.doesNotMatch(html, /project-1|draft-2/);
    assert.doesNotMatch(html, /결정된 답변|승인됨|approved/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
