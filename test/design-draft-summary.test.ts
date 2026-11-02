import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { DesignDraft } from "../src/domain/design-drafts.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const draft: DesignDraft = {
  projectId: "project-1",
  revisionId: "draft-r01",
  sourceIds: ["consultation-123e4567-e89b-42d3-a456-426614174000"],
  specification: {
    revisionId: "spec-r01",
    productTier: "M",
    requirements: [{
      id: "REQ-1",
      description: "Render <script>alert('x')</script> as plain text",
      acceptanceCriteriaIds: ["AC-1", "AC-2"],
    }],
    targets: ["desktop"],
    dataPolicyRef: "policy-r01",
  },
  graph: { graphRevisionId: "graph-r01", entities: [], relations: [], viewLayoutRef: "layout-r01" },
  questions: [{
    id: "question-1",
    title: "출력 형식",
    text: "어떤 형식이 필요한가요?",
    options: [
      { id: "csv", label: "CSV", tradeoff: "처리하기 쉽습니다." },
      { id: "json", label: "JSON", tradeoff: "구조를 보존합니다." },
    ],
    recommendation: "csv",
  }],
};

async function loadComponent() {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".ui-test-"));
  const output = path.join(temporary, "DesignDraftSummary.mjs");
  await build({
    entryPoints: [path.join(projectRoot, "src/ui/DesignDraftSummary.tsx")],
    outfile: output,
    bundle: true,
    external: ["react", "react/jsx-runtime"],
    platform: "node",
    format: "esm",
    jsx: "automatic",
  });
  const module = await import(pathToFileURL(output).href);
  return { DesignDraftSummary: module.DesignDraftSummary as typeof import("../src/ui/DesignDraftSummary.tsx").DesignDraftSummary, temporary };
}

test("renders the read-only draft summary and its details as escaped text", async () => {
  const { DesignDraftSummary, temporary } = await loadComponent();
  try {
    const html = renderToStaticMarkup(createElement(DesignDraftSummary, { draft, loading: false, error: null }));
    assert.match(html, /aria-label="Lead 설계 초안"/);
    assert.match(html, /설계 초안 · 승인·실행 전/);
    assert.match(html, /draft-r01/);
    assert.match(html, /요구사항 1개/);
    assert.match(html, /미결정질문 1개/);
    assert.match(html, /<details\b/);
    assert.match(html, /요구사항/);
    assert.match(html, /REQ-1/);
    assert.match(html, /AC-1, AC-2/);
    assert.match(html, /출력 형식/);
    assert.match(html, /CSV/);
    assert.match(html, /초안 권장안/);
    assert.match(html, /상담근거/);
    assert.match(html, /consultation-123e4567-e89b-42d3-a456-426614174000/);
    assert.match(html, /&lt;script&gt;alert\(&#x27;x&#x27;\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<(?:button|input|textarea|select)\b/i);
    assert.doesNotMatch(html, /승인됨|검증 완료|호출 완료|실행 완료|코드 생성 완료/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("keeps empty, loading, and error states free of stale draft content", async () => {
  const { DesignDraftSummary, temporary } = await loadComponent();
  try {
    const render = (props: { draft: DesignDraft | null; loading: boolean; error: string | null }) =>
      renderToStaticMarkup(createElement(DesignDraftSummary, props));

    assert.equal(render({ draft: null, loading: false, error: null }), "");

    const loading = render({ draft, loading: true, error: null });
    assert.match(loading, /role="status"/);
    assert.match(loading, /설계 초안을 불러오는 중입니다/);
    assert.doesNotMatch(loading, /draft-r01|REQ-1/);

    const error = render({ draft, loading: false, error: "internal detail" });
    assert.match(error, /role="alert"/);
    assert.match(error, /설계 초안을 불러오지 못했습니다\./);
    assert.doesNotMatch(error, /draft-r01|REQ-1|internal detail/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("resolved question history stays visible but no longer inflates the unresolved count", async () => {
  const { DesignDraftSummary, temporary } = await loadComponent();
  try {
    const html = renderToStaticMarkup(createElement(DesignDraftSummary, { draft, loading: false, error: null,
      resolvedQuestionIds: ["question-1", "not-in-this-draft"] }));
    assert.match(html, /미결정질문 0개/);
    assert.match(html, /답변 완료/);
    assert.match(html, /출력 형식/);
    assert.match(html, /설계 초안 · 승인·실행 전/);
    assert.doesNotMatch(html, /미결정질문 1개/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
