import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const probeRequests = [];
let bundle = "";
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/probe/")) probeRequests.push(url.pathname);
  if (url.pathname === "/app.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(bundle);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body style=\"margin:0;background:#181818;color:#ededed;font:14px sans-serif\"><main id=\"root\"></main><script type=\"module\" src=\"/app.js\"></script></body></html>");
});

let browser;
let serverAddress;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  serverAddress = server.address();
  const origin = `http://127.0.0.1:${serverAddress.port}`;
  const demoHtml = `<!doctype html><html><head><style>
    body { font: 16px sans-serif; padding: 20px; }
    #details { display: none; }
    #toggle:checked ~ #details { display: block; }
    body { background-image: url("${origin}/probe/css-background"); }
  </style><link rel="stylesheet" href="${origin}/probe/pre-csp.css"><meta http-equiv="refresh" content="0;url=${origin}/probe/refresh"></head><body>
    <main><h1 id="demo-title">Prototype screen</h1>
      <input id="toggle" type="checkbox"><label for="toggle">Show details</label><p id="details">CSS interaction works</p>
      <a id="external-link" href="${origin}/probe/link" target="_top">External link</a>
      <a id="popup-link" href="${origin}/probe/popup" target="_blank">Popup link</a>
      <a id="download-link" href="${origin}/probe/download" download="untrusted.txt">Download</a>
      <form id="external-form" action="${origin}/probe/form"><button id="submit-form" type="submit">Submit</button></form>
      <button id="script-attempt" onclick="parent.document.body.dataset.compromised='yes'">Run script</button>
      <img id="remote-image" src="${origin}/probe/image" alt="remote image">
      <iframe id="remote-frame" src="${origin}/probe/frame"></iframe>
      <script>parent.document.body.dataset.compromised='yes'; fetch('${origin}/probe/fetch')</script>
    </main>
  </body></html>`;
  const htmlSha256 = createHash("sha256").update(demoHtml, "utf8").digest("hex");
  const props = {
    artifactId: "artifact-browser-smoke", revisionId: "ui-revision-browser-smoke", htmlSha256, html: demoHtml,
    source: { kind: "draft", revisionId: "draft-browser-smoke" },
    contractRevisionId: "contract-browser-smoke",
    approvalAction: { revisionId: "approval-browser-smoke", expectedBaseRevisionId: "approval-head-6" },
    interactions: [{ id: "save", screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: ["save-record"],
      stateRefs: ["saved"], apiRefs: ["POST /records"], preconditions: ["valid record"], outcomes: ["receipt shown"],
      prohibited: ["implicit publication"], validationCriteria: ["explicit action"], status: "specified" }],
  };
  const entry = `import React from "react";
    import { createRoot } from "react-dom/client";
    import { UiHtmlReview } from "./src/ui/UiHtmlReview.tsx";
    const props = ${JSON.stringify(props)};
    const actions = [];
    window.__uiReviewActions = actions;
    const root = createRoot(document.getElementById("root"));
    const render = (overrides = {}, connectActions = true) => root.render(React.createElement(UiHtmlReview, { ...props, ...overrides,
      ...(connectActions ? {
        onUserApprove: target => actions.push({ action: "approve", target }),
        onRequestChanges: target => actions.push({ action: "changes", target }),
        onHold: target => actions.push({ action: "hold", target }),
      } : {}),
    }));
    window.__uiReviewRender = render;
    render({});`;
  const buildResult = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "ui-html-review-smoke.tsx", loader: "tsx" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  bundle = buildResult.outputFiles[0].text;

  browser = await chromium.launch({ headless: true });
  const browserVersion = browser.version();
  for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const blockedRequests = [];
    let downloadCount = 0;
    page.on("download", () => { downloadCount += 1; });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        blockedRequests.push(url.href);
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await page.goto(origin);
    const iframe = page.getByTitle("HTML 시안 artifact-browser-smoke · ui-revision-browser-smoke");
    await iframe.waitFor();
    const approve = page.getByRole("button", { name: "사용자 승인", exact: true });
    await approve.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("button[disabled]")?.textContent?.includes("승인"));
    assert.equal(await approve.isDisabled(), false, "A supplied action becomes available only after the exact HTML hash passes.");
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
    assert.equal(await page.locator("iframe").getAttribute("allow"), null);

    const preview = page.frameLocator("iframe[title^='HTML 시안']");
    await preview.getByRole("heading", { name: "Prototype screen" }).waitFor();
    const boundary = await preview.locator("body").evaluate(() => ({
      origin: location.origin,
      scriptCount: document.querySelectorAll("script").length,
      nestedFrameCount: document.querySelectorAll("iframe").length,
      linkCount: document.querySelectorAll("link").length,
      remoteImageSrc: document.querySelector("#remote-image")?.getAttribute("src") ?? null,
      externalLinkHref: document.querySelector("#external-link")?.getAttribute("href") ?? null,
      refreshMetaCount: document.querySelectorAll("meta[http-equiv='refresh' i]").length,
      csp: document.querySelector("meta[http-equiv='Content-Security-Policy' i]")?.getAttribute("content") ?? "",
      parentReadBlocked: (() => { try { void parent.document.title; return false; } catch { return true; } })(),
    }));
    assert.equal(boundary.origin, "null", "The frame runs with an opaque origin.");
    assert.equal(boundary.scriptCount, 0, "Submitted script blocks are removed, not executed.");
    assert.equal(boundary.nestedFrameCount, 0, "Submitted nested frames are removed.");
    assert.equal(boundary.linkCount, 0, "Submitted linked resources are removed.");
    assert.equal(boundary.remoteImageSrc, null, "External resource URLs are removed.");
    assert.equal(boundary.externalLinkHref, null, "External navigation URLs are removed.");
    assert.equal(boundary.refreshMetaCount, 0, "Meta refresh navigation is removed.");
    assert.equal(boundary.parentReadBlocked, true, "The preview cannot read the parent document.");
    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "script-src 'none'", "object-src 'none'"])
      assert.ok(boundary.csp.includes(directive), `Preview CSP is missing ${directive}.`);

    const details = preview.locator("#details");
    assert.equal(await details.isVisible(), false);
    await preview.locator("#toggle").check();
    assert.equal(await details.isVisible(), true, "CSS-only prototype interaction remains reviewable.");
    await preview.locator("#script-attempt").click();
    await preview.locator("#external-link").click();
    await preview.locator("#popup-link").click();
    await preview.locator("#download-link").click();
    await preview.locator("#submit-form").click();
    await page.waitForTimeout(100);
    assert.equal(downloadCount, 0, "Preview links cannot download files.");
    assert.equal(context.pages().length, 1, "Preview links cannot open popups.");
    assert.equal(await page.evaluate(() => document.body.dataset.compromised ?? null), null);
    assert.equal(page.url(), origin + "/", "Preview interactions cannot navigate the top-level page.");
    const pageWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth,
      body: document.body.getBoundingClientRect().toJSON(), root: document.querySelector("#root").getBoundingClientRect().toJSON(),
      section: document.querySelector("section").getBoundingClientRect().toJSON(), iframe: document.querySelector("iframe").getBoundingClientRect().toJSON() }));
    assert.equal(pageWidth.scrollWidth > pageWidth.innerWidth, false, `${name} viewport overflows: ${JSON.stringify(pageWidth)}`);
    assert.equal(await preview.locator("body").evaluate(element => element.scrollWidth > element.clientWidth), false, `${name} preview has no horizontal overflow.`);

    if (name === "desktop") {
      const saveReview = page.getByRole("checkbox", { name: "save 동작 검토 승인", exact: true });
      assert.equal(await saveReview.isChecked(), false, "Contract interactions require an explicit reviewer choice.");
      await saveReview.click({ noWaitAfter: true });
      assert.equal(await saveReview.isChecked(), true, "The reviewer can explicitly select this contract interaction.");
      await approve.click();
      await page.waitForFunction(() => window.__uiReviewActions?.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__uiReviewActions[0]), {
        action: "approve", target: { revisionId: "approval-browser-smoke", expectedBaseRevisionId: "approval-head-6",
          proposalRevisionId: "ui-revision-browser-smoke", htmlSha256, approvedInteractionIds: ["save"] },
      }, "Approval callbacks receive the exact authenticated-user action input contract.");
      await page.screenshot({ path: `${process.env.TEMP ?? process.env.TMP ?? "."}/ui-html-review-desktop.png`, fullPage: true });
      await page.evaluate(() => window.__uiReviewRender({ htmlSha256: "0".repeat(64) }));
      await page.getByRole("alert").getByText("HTML 내용의 SHA-256이 저장된 해시와 다릅니다.", { exact: true }).waitFor();
      assert.equal(await page.locator("iframe").count(), 0, "A mismatched hash hides the preview.");
      for (const label of ["사용자 승인", "수정 요청", "보류"])
        assert.equal(await page.getByRole("button", { name: label, exact: true }).isDisabled(), true, `${label} remains disabled on a hash mismatch.`);
      await page.evaluate(() => window.__uiReviewRender({}, false));
      await page.locator("iframe").waitFor();
      await page.locator('[aria-label="사용자 검토 상태"]').getByText("사용자 검토 필요", { exact: true }).waitFor();
      for (const label of ["사용자 승인", "수정 요청", "보류"])
        assert.equal(await page.getByRole("button", { name: label, exact: true }).isDisabled(), true, `${label} is disabled without a connected user action.`);
    } else {
      await page.screenshot({ path: `${process.env.TEMP ?? process.env.TMP ?? "."}/ui-html-review-mobile.png`, fullPage: true });
    }
    await context.close();
    assert.deepEqual(blockedRequests, [], "No preview-initiated off-origin requests were attempted.");
  }

  assert.deepEqual(probeRequests, [], "No external URL, refresh, form, CSS image, or remote image request reached the local probe server.");
  console.log(JSON.stringify({ uiHtmlReview: "passed", browser: "Chromium", browserVersion, viewports: ["1440x900", "390x844"], probeRequests }));
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
