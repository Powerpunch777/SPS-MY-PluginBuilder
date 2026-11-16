import assert from "node:assert/strict";
import test from "node:test";
import type { BuilderDocument } from "../src/domain/model.ts";
import { exportDocumentMarkdown, safeDocumentMarkdownFilename } from "../src/domain/document-markdown-export.ts";

const exportedAt = "2026-11-07T12:34:56.789Z";
const document: BuilderDocument = {
  id: "delivery-document:installation",
  title: "Install guide",
  revisionId: "delivery-r4",
  createdAt: "2026-11-07T10:20:30.125Z",
  text: "# Install\n\n<script>literal source text</script>",
  category: "delivery",
  sourceKind: "delivery-document",
  approvalStatus: "unapproved",
  freshnessStatus: "stale",
  bodyAvailable: true,
  sourcePins: [{ sourceId: "delivery-bundle:revision-4", revisionId: "bundle-r4", sha256: "a".repeat(64) }],
};

test("exports exact snapshot identity, source pins, body, and a non-approval boundary", () => {
  const markdown = exportDocumentMarkdown(document, exportedAt);
  for (const value of [document.id, document.revisionId, document.sourcePins![0]!.sourceId,
    document.sourcePins![0]!.revisionId, document.sourcePins![0]!.sha256, exportedAt, document.text,
    "내보낸 시점의 snapshot", "승인, 최신성 또는 납품 승인을 의미하지 않습니다."]) {
    assert.ok(markdown.includes(value), value);
  }
  assert.match(markdown, /^# Install guide/mu);
  const hostileTitle = exportDocumentMarkdown({ ...document, title: "<script>title</script>" }, exportedAt).split("\n", 1)[0]!;
  assert.doesNotMatch(hostileTitle, /<script>/u);
  assert.equal(exportDocumentMarkdown({ ...document, text: "" }, exportedAt).includes("_(빈 본문)_"), true);
  assert.throws(() => exportDocumentMarkdown({ ...document, bodyAvailable: false }, exportedAt), /unavailable/u);
  assert.throws(() => exportDocumentMarkdown(document, "not-a-time"), /timestamp/u);
  assert.throws(() => exportDocumentMarkdown({ ...document, sourcePins: [{ ...document.sourcePins![0]!, sha256: "invalid" }] }, exportedAt), /SHA-256/u);
});

test("filename sanitization prevents path, control, and reserved-device names", () => {
  assert.equal(safeDocumentMarkdownFilename("../folder\\CON: guide?.md"), "..-folder-CON- guide-.md");
  assert.equal(safeDocumentMarkdownFilename("NUL.txt"), "_NUL.txt.md");
  assert.equal(safeDocumentMarkdownFilename("\u0000\u001f"), "document.md");
  assert.ok(safeDocumentMarkdownFilename("x".repeat(300)).length <= 103);
});
