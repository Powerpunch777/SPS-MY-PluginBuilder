import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

test("batch UI presents manual source, range preview, confirm/cancel and UNKNOWN coverage", async () => {
  const root = path.resolve(import.meta.dirname, ".."); const require = createRequire(import.meta.url);
  const built = await build({ entryPoints: [path.join(root, "src/ui/ConsultationBatchImport.tsx")], bundle: true,
    external: ["react", "react/jsx-runtime"], platform: "node", format: "esm", jsx: "automatic", write: false });
  const source = Buffer.from(built.outputFiles[0]!.contents).toString("utf8")
    .replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href))
    .replaceAll('"react"', JSON.stringify(pathToFileURL(require.resolve("react")).href));
  const { ConsultationBatchImport } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as typeof import("../src/ui/ConsultationBatchImport.tsx");
  const html = renderToStaticMarkup(createElement(ConsultationBatchImport, { batches: [], onConfirm: async () => {} }));
  for (const label of ["UTF-8 .txt 파일 선택", "시작 원문 줄", "끝 원문 줄", "범위 미리보기", "UNKNOWN", "현재 Workspace 상담 Batch 기록"]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /자동 수집|전체 크롤링/);
});
