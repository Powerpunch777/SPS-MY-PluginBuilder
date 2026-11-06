import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { build } from "esbuild";
import type { BuilderDocument } from "../src/domain/model.ts";
import type { DocumentCenterProps } from "../src/ui/DocumentCenter.tsx";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sha = "a".repeat(64);

// TEST_FIXTURE_ONLY: synthetic documents for local renderer and browser tests; never passed to production UI.
const fixtures: readonly BuilderDocument[] = [
  { id: "design:alpha", title: "Alpha architecture", revisionId: "design-r2", text: "Requirement REQ-ALPHA and graph.",
    createdAt: "2026-11-05T09:15:00.000Z", category: "design", sourceKind: "design-baseline", approvalStatus: "approved",
    freshnessStatus: "current", bodyAvailable: true, sourcePins: [{ sourceId: "baseline", revisionId: "base-r2", sha256: sha }], relatedIds: ["REQ-ALPHA"] },
  { id: "qa:beta", title: "Beta test report", revisionId: "qa-r3", text: "Coverage run BETA-42", createdAt: "2026-11-06T10:20:30.125Z",
    category: "test-qa", sourceKind: "builder-document", approvalStatus: "unapproved", freshnessStatus: "review-required",
    bodyAvailable: true, sourcePins: [], relatedIds: ["QA-42", "WS-7"] },
  { id: "source:unknown", title: "Unlinked source", revisionId: "source-r1", text: "",
    createdAt: "2026-11-04T01:02:03.004Z", category: "unclassified", sourceKind: "builder-document", approvalStatus: "unknown",
    freshnessStatus: "unknown", bodyAvailable: false, sourcePins: [], relatedIds: [] },
];

async function loadComponent() {
  const temporary = await mkdtemp(path.join(projectRoot, ".document-center-ui-test-"));
  const output = path.join(temporary, "DocumentCenter.mjs");
  await build({ entryPoints: [path.join(projectRoot, "src/ui/DocumentCenter.tsx")], outfile: output,
    bundle: true, external: ["react", "react/jsx-runtime"], platform: "node", format: "esm", jsx: "automatic" });
  const module = await import(pathToFileURL(output).href);
  return { DocumentCenter: module.DocumentCenter as typeof import("../src/ui/DocumentCenter.tsx").DocumentCenter, temporary };
}

test("empty/loading/error states do not inject documents or stale body text", async () => {
  const { DocumentCenter, temporary } = await loadComponent();
  try {
    const render = (props: DocumentCenterProps) => renderToStaticMarkup(createElement(DocumentCenter, props));
    const empty = render({ documents: [] });
    assert.match(empty, /현재 snapshot에 표시할 문서가 없습니다/u);
    assert.doesNotMatch(empty, /Alpha architecture|Beta test report/u);
    const loading = render({ documents: fixtures, loading: true });
    assert.match(loading, /role="status"/u);
    assert.match(loading, /불러오는 중/u);
    assert.doesNotMatch(loading, /Alpha architecture|Requirement REQ/u);
    const error = render({ documents: fixtures, error: "private source detail" });
    assert.match(error, /role="alert"/u);
    assert.doesNotMatch(error, /private source detail|Alpha architecture/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("renders exact createdAt, status, source pins, related IDs and escapes document body", async () => {
  const { DocumentCenter, temporary } = await loadComponent();
  try {
    const markup = renderToStaticMarkup(createElement(DocumentCenter, { documents: [
      { ...fixtures[0]!, title: "<script>not markup</script>", text: "<img src=x onerror=alert(1)>" },
      { ...fixtures[2]!, id: "consultation:source", sourceKind: "consultation-source", approvalStatus: "unknown", freshnessStatus: "unknown" },
    ] }));
    assert.match(markup, /2026-11-05T09:15:00\.000Z/u);
    assert.match(markup, /승인됨/u);
    assert.match(markup, /최신/u);
    assert.match(markup, /baseline · base-r2/u);
    assert.match(markup, /REQ-ALPHA/u);
    assert.match(markup, /&lt;script&gt;not markup&lt;\/script&gt;/u);
    assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/u);
    assert.match(markup, /상담 원문/u);
    assert.doesNotMatch(markup, /<script>|<img\b/u);
    assert.match(markup, /전체 Artifact inventory/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("unavailable bodies are neither displayed nor searched, while unknown statuses stay explicit", async () => {
  const { DocumentCenter, temporary } = await loadComponent();
  try {
    const unavailable = renderToStaticMarkup(createElement(DocumentCenter, { documents: [fixtures[2]!] }));
    assert.match(unavailable, /본문 사용 불가/u);
    assert.match(unavailable, /현재 연결된 source에서 사용할 수 없습니다/u);
    assert.match(unavailable, /미확인/u);
    assert.doesNotMatch(unavailable, /hidden private content/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("browser filters title and body, sorts by recorded time, preserves selection and fits a narrow viewport", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, ".document-center-browser-test-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = await build({ stdin: { sourcefile: "document-center-harness.tsx", resolveDir: projectRoot, contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { DocumentCenter } from "./src/ui/DocumentCenter.tsx";
      window.mountDocuments = (documents) => { const element = document.getElementById("root"); if (!element) return;
        createRoot(element).render(createElement(DocumentCenter, { documents })); };
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    page.setDefaultTimeout(5_000);
    await page.setContent("<body style='margin:0'><div style='width:min(700px, 100vw)'><div id='root'></div></div></body>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate(documents => (window as unknown as { mountDocuments: (value: unknown) => void }).mountDocuments(documents), fixtures);

    assert.equal(await page.getByRole("heading", { level: 2 }).innerText(), "문서센터");
    const list = page.getByRole("region", { name: "현재 snapshot 문서 목록" });
    const initialItems = await list.getByRole("button").allTextContents();
    assert.match(initialItems[0]!, /Beta test report/u);
    assert.match(initialItems[1]!, /Alpha architecture/u);
    assert.match(initialItems[2]!, /Unlinked source/u);
    const relatedId = page.getByRole("searchbox", { name: "관련 ID" });
    await relatedId.fill("REQ-ALPHA");
    assert.equal((await list.getByRole("button").allTextContents()).length, 1);
    assert.match((await list.getByRole("button").allTextContents())[0]!, /Alpha architecture/u);
    await relatedId.fill("REQ-ALP");
    assert.match(await list.innerText(), /현재 필터에 해당하는 문서가 없습니다/u);
    await relatedId.fill("");
    await page.getByRole("button", { name: /Alpha architecture/u }).click();
    await page.getByRole("searchbox", { name: "제목·본문 검색" }).fill("BETA-42");
    assert.match((await list.getByRole("button").allTextContents())[0]!, /Beta test report/u);
    assert.match(await page.getByRole("region", { name: "선택한 문서" }).innerText(), /Alpha architecture/u);
    assert.match(await page.getByRole("region", { name: "선택한 문서" }).innerText(), /현재 필터 결과 밖/u);
    await page.getByRole("searchbox", { name: "제목·본문 검색" }).fill("");
    await page.getByRole("button", { name: "오름차순으로 정렬" }).click();
    const oldestFirst = await list.getByRole("button").allTextContents();
    assert.match(oldestFirst[0]!, /Unlinked source/u);
    assert.match(oldestFirst[1]!, /Alpha architecture/u);
    assert.match(oldestFirst[2]!, /Beta test report/u);
    await page.getByRole("searchbox", { name: "제목·본문 검색" }).fill("hidden");
    assert.match(await list.innerText(), /검색어와 일치하는 문서가 없습니다/u);
    await page.getByRole("button", { name: "필터 초기화" }).click();
    const resetItems = await list.getByRole("button").allTextContents();
    assert.match(resetItems[0]!, /Beta test report/u);
    assert.match(resetItems[1]!, /Alpha architecture/u);
    assert.match(resetItems[2]!, /Unlinked source/u);
    assert.match(await page.getByRole("region", { name: "선택한 문서" }).innerText(), /Alpha architecture/u);
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    const embedded = page.locator(".sps-document-center");
    assert.equal(await embedded.evaluate(element => element.clientWidth), 700);
    assert.equal(await embedded.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await page.locator(".sps-dc-layout").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length), 1);
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
