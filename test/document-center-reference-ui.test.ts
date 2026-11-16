import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { build } from "esbuild";

const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoot = path.resolve(os.tmpdir());
const hash = "d".repeat(64);
const owner = { id: "doc:owner", title: "Owner <img src=x onerror=alert(1)>", revisionId: "owner-r1",
  createdAt: "2026-11-07T10:00:00.000Z", text: "Owner body", category: "consultation", sourceKind: "builder-document",
  sourcePins: [{ sourceId: "doc:target", revisionId: "target-r2", sha256: hash },
    { sourceId: "doc:missing", revisionId: "missing-r1", sha256: "e".repeat(64) }],
  relatedIds: ["doc:target", "REQ-1", "https://example.invalid/doc:target", "<img src=x onerror=alert(1)>"] };
const target = { id: "doc:target", title: "Linked guide", revisionId: "target-r2", createdAt: "2026-11-07T11:00:00.000Z",
  text: "Target body", category: "design", sourceKind: "builder-document",
  sourcePins: [{ sourceId: "doc:target", revisionId: "target-r2", sha256: hash }], relatedIds: [] };

function assertInside(parent: string, targetPath: string) {
  assert.ok(path.resolve(targetPath).startsWith(path.resolve(parent) + path.sep), `Refusing cleanup outside ${parent}`);
  return path.resolve(targetPath);
}

test("reference navigation uses only exact snapshot matches and keeps filtered-out selection at mobile and desktop widths", async () => {
  const temporary = await mkdtemp(path.join(temporaryRoot, "builder-document-reference-ui-"));
  assertInside(temporaryRoot, temporary);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = await build({ stdin: { sourcefile: "document-reference-harness.tsx", resolveDir: projectRoot, contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { DocumentCenter } from "./src/ui/DocumentCenter.tsx";
      const host = document.getElementById("root");
      if (!host) throw new Error("root missing");
      const root = createRoot(host);
      window.mountDocuments = documents => root.render(createElement(DocumentCenter, { documents }));
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5_000);
    const requests: string[] = [];
    page.on("request", request => requests.push(request.url()));
    await page.setContent("<body style='margin:0;padding:16px;box-sizing:border-box;background:#202020'><div id='root'></div></body>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate(documents => (window as unknown as { mountDocuments: (docs: unknown) => void }).mountDocuments(documents), [owner, target]);
    await page.getByRole("combobox", { name: "분류", exact: true }).selectOption("consultation");
    const list = page.getByRole("region", { name: "현재 snapshot 문서 목록" });
    assert.equal(await list.getByRole("button").count(), 1);
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("img").count(), 0);
    assert.equal(await page.getByRole("button", { name: "참조 문서 열기: Linked guide" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "관련 문서 열기: Linked guide" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: /REQ-1/u }).count(), 0);
    assert.equal(await page.getByRole("link").count(), 0, "no external URL is inferred from IDs");

    await page.getByRole("button", { name: "참조 문서 열기: Linked guide" }).click();
    const detail = page.getByRole("region", { name: "선택한 문서" });
    assert.match(await detail.innerText(), /Linked guide/u);
    assert.match(await detail.innerText(), /현재 필터 결과 밖/u);
    assert.equal(await list.getByRole("button").count(), 1);
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);

    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    await list.getByRole("button", { name: /Owner/u }).click();
    await page.getByRole("button", { name: "관련 문서 열기: Linked guide" }).click();
    assert.match(await detail.innerText(), /Linked guide/u);
    assert.match(await detail.innerText(), /현재 필터 결과 밖/u);
    assert.equal(await page.locator("img").count(), 0);
    assert.equal(requests.length, 0, "navigation stays within the supplied snapshot");
  } finally {
    await browser?.close();
    await rm(assertInside(temporaryRoot, temporary), { recursive: true, force: true });
  }
});
