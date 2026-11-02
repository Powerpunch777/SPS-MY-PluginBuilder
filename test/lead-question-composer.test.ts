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

test("a question context remains an association, not an answer or approval", async () => {
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
        answer: null,
        revisionId: null,
        questionContext: { projectId: "project-1", draftRevisionId: "draft-2", questionId: "question-1" },
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
    assert.doesNotMatch(html, /project-1|draft-2/);
    assert.doesNotMatch(html, /결정된 답변|승인됨|approved/);
    snapshot.questions[0]!.status = "answered";
    snapshot.questions[0]!.answer = "Use desktop.";
    const answered = renderToStaticMarkup(createElement(DecisionsView, { props, drawerOpen: false, onDrawerToggle() {}, onDrawerClose() {} }));
    assert.match(answered, /이 질문의 답변이 설계에 반영되었습니다/);
    assert.doesNotMatch(answered, /AI 메시지 연결을 사용할 수 없어/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
