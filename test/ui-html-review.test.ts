import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { UiHtmlReviewProps } from "../src/ui/UiHtmlReview.tsx";
import type { UiInteraction } from "../src/ui-contracts/domain.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("HTML review requires exact identified content and connected user actions", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".ui-html-review-test-"));
  try {
    const output = path.join(temporary, "UiHtmlReview.mjs");
    await build({
      entryPoints: [path.join(projectRoot, "src", "ui", "UiHtmlReview.tsx")],
      outfile: output,
      bundle: true,
      external: ["react", "react-dom", "react-dom/server"],
      platform: "node",
      format: "esm",
      jsx: "automatic",
    });
    const { UiHtmlReview } = await import(pathToFileURL(output).href) as typeof import("../src/ui/UiHtmlReview.tsx");
    const html = "<main>untrusted design content</main>";
    const htmlSha256 = createHash("sha256").update(html, "utf8").digest("hex");
    const interaction: UiInteraction = { id: "save", screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: ["save-record"],
      stateRefs: ["saved"], apiRefs: ["POST /records"], preconditions: ["record is valid"], outcomes: ["saved receipt shown"],
      prohibited: ["implicit publication"], validationCriteria: ["explicit action"], status: "specified" };
    const base: UiHtmlReviewProps = {
      artifactId: "artifact-exact-1",
      revisionId: "ui-revision-exact-7",
      htmlSha256,
      html,
      source: { kind: "draft", revisionId: "draft-r2" },
      contractRevisionId: "contract-r4",
      interactions: [interaction],
      approvalAction: { revisionId: "approval-r1", expectedBaseRevisionId: null },
      onUserApprove() {},
      onRequestChanges() {},
      onHold() {},
    };

    const pending = renderToStaticMarkup(createElement(UiHtmlReview, base));
    assert.match(pending, /artifact-exact-1/);
    assert.match(pending, /ui-revision-exact-7/);
    assert.match(pending, /draft-r2/);
    assert.match(pending, /contract-r4/);
    assert.match(pending, new RegExp(htmlSha256));
    assert.match(pending, /HTML 내용을 확인하는 중입니다/);
    assert.match(pending, /save 동작 검토 승인/);
    assert.match(pending, /POST \/records/);
    assert.doesNotMatch(pending, /untrusted design content/);
    assert.doesNotMatch(pending, /<iframe\b/u, "Unverified HTML must not reach a preview browsing context.");
    assert.equal((pending.match(/disabled=""/gu) ?? []).length, 3, "Actions stay disabled until the browser verifies exact HTML bytes.");

    const unavailable = renderToStaticMarkup(createElement(UiHtmlReview, { ...base,
      onUserApprove: undefined, onRequestChanges: undefined, onHold: undefined }));
    assert.equal((unavailable.match(/disabled=""/gu) ?? []).length, 3, "No user-action callback means no enabled review action.");

    const loading = renderToStaticMarkup(createElement(UiHtmlReview, { ...base, loading: true }));
    assert.match(loading, /HTML 시안을 불러오는 중입니다/);
    assert.doesNotMatch(loading, /<iframe\b/u);
    assert.equal((loading.match(/disabled=""/gu) ?? []).length, 3);

    const failed = renderToStaticMarkup(createElement(UiHtmlReview, { ...base, error: "revision unavailable" }));
    assert.match(failed, /revision unavailable/);
    assert.match(failed, /role="alert"/);
    assert.doesNotMatch(failed, /<iframe\b/u);
    assert.equal((failed.match(/disabled=""/gu) ?? []).length, 3);

    const empty = renderToStaticMarkup(createElement(UiHtmlReview, { ...base,
      artifactId: null, revisionId: null, htmlSha256: null, html: null }));
    assert.match(empty, /검토할 HTML artifact가 없습니다/);
    assert.doesNotMatch(empty, /<iframe\b/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
