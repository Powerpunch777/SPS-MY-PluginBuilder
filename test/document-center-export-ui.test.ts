import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { build } from "esbuild";

const projectRoot = path.resolve(import.meta.dirname, "..");
const safeTemporaryRoot = path.resolve(os.tmpdir());
const sha256 = "b".repeat(64);
const selectedDocument = {
  id: "delivery-document:guide-42",
  title: "../Install: guide?.md",
  revisionId: "delivery-revision-7",
  createdAt: "2026-11-07T10:20:30.125Z",
  text: "# Install guide\n\nExact selected UTF-8 body: 한글 · café\n\n<script>literal text</script>",
  category: "delivery",
  sourceKind: "delivery-document",
  approvalStatus: "unapproved",
  freshnessStatus: "stale",
  bodyAvailable: true,
  sourcePins: [{ sourceId: "delivery-bundle:42", revisionId: "bundle-r7", sha256 }],
};

function assertInside(parent: string, target: string) {
  const root = path.resolve(parent) + path.sep;
  const resolved = path.resolve(target);
  assert.ok(resolved.startsWith(root), `Refusing recursive cleanup outside ${root}`);
  return resolved;
}

test("browser export downloads exact selected snapshot bytes and preserves responsive evidence", async () => {
  const temporary = await mkdtemp(path.join(safeTemporaryRoot, "builder-document-export-ui-"));
  assertInside(safeTemporaryRoot, temporary);
  const evidenceRoot = process.env.DOCUMENT_CENTER_EXPORT_EVIDENCE_DIR
    ? assertInside(path.join(projectRoot, "artifacts", "document-center-export"), process.env.DOCUMENT_CENTER_EXPORT_EVIDENCE_DIR)
    : null;
  if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = await build({ stdin: { sourcefile: "document-center-export-harness.tsx", resolveDir: projectRoot, contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { DocumentCenter } from "./src/ui/DocumentCenter.tsx";
      const rootElement = document.getElementById("root");
      if (!rootElement) throw new Error("root missing");
      const root = createRoot(rootElement);
      window.mountDocuments = (documents, state = {}) => root.render(createElement(DocumentCenter, { documents, ...state }));
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    page.setDefaultTimeout(5_000);
    const requests: string[] = [];
    page.on("request", request => requests.push(request.url()));
    await page.setContent("<body style='margin:0'><div id='root'></div></body>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const mount = (documents: readonly object[], state?: { loading?: boolean; error?: string | null }) =>
      page.evaluate(({ documents, state }) => (window as unknown as { mountDocuments: (docs: unknown, state?: unknown) => void })
        .mountDocuments(documents, state), { documents, state });
    await mount([selectedDocument]);

    const exportButton = page.getByRole("button", { name: "선택 문서 Markdown 내보내기" });
    assert.equal(await exportButton.isEnabled(), true);
    assert.equal(await page.locator(".sps-dc-body").innerText(), selectedDocument.text);
    assert.equal(await page.locator(".sps-dc-body script").count(), 0);
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    if (evidenceRoot) await page.screenshot({ path: path.join(evidenceRoot, "document-center-export-390.png"), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    if (evidenceRoot) await page.screenshot({ path: path.join(evidenceRoot, "document-center-export-1440.png"), fullPage: true });

    const [download] = await Promise.all([page.waitForEvent("download"), exportButton.click()]);
    assert.match(download.suggestedFilename(), /\.md$/u);
    assert.doesNotMatch(download.suggestedFilename(), /[<>:"/\\|?*\u0000-\u001f\u007f]/u);
    const downloadedPath = await download.path();
    assert.ok(downloadedPath);
    const downloaded = await readFile(downloadedPath!);
    const markdown = downloaded.toString("utf8");
    for (const value of [selectedDocument.id, selectedDocument.revisionId, selectedDocument.sourcePins[0]!.sourceId,
      selectedDocument.sourcePins[0]!.revisionId, selectedDocument.sourcePins[0]!.sha256, selectedDocument.text,
      "내보낸 시점의 snapshot", "승인, 최신성 또는 납품 승인을 의미하지 않습니다."]) {
      assert.ok(markdown.includes(value), value);
    }
    assert.equal(Buffer.from(markdown, "utf8").equals(downloaded), true);
    assert.match(markdown, /내보낸 시각: `\d{4}-\d\d-\d\dT/u);
    assert.ok(markdown.includes("<script>literal text</script>"), "the export preserves the selected source body verbatim");
    assert.equal(requests.length, 0, "export must not refetch from a server or wake another producer");

    await mount([{ ...selectedDocument, id: "delivery-document:missing-body", bodyAvailable: false }]);
    assert.equal(await page.getByRole("button", { name: "선택 문서 Markdown 내보내기" }).isDisabled(), true);
    await mount([selectedDocument], { loading: true });
    assert.equal(await page.getByRole("button", { name: "선택 문서 Markdown 내보내기" }).count(), 0);
    await mount([selectedDocument], { error: "private source error" });
    assert.equal(await page.getByRole("button", { name: "선택 문서 Markdown 내보내기" }).count(), 0);

    await mount([{ ...selectedDocument, id: "delivery-document:empty", title: "Empty guide", text: "" }]);
    const emptyDownload = await Promise.all([page.waitForEvent("download"),
      page.getByRole("button", { name: "선택 문서 Markdown 내보내기" }).click()]);
    const emptyBytes = await readFile((await emptyDownload[0]!.path())!);
    assert.match(emptyBytes.toString("utf8"), /_\(빈 본문\)_/u);
  } finally {
    await browser?.close();
    await rm(assertInside(safeTemporaryRoot, temporary), { recursive: true, force: true });
  }
});
