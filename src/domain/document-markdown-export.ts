import type { BuilderDocument } from "./model.ts";

const SHA256 = /^[a-f0-9]{64}$/u;

function markdownHeading(value: string) {
  return value.replace(/([\\`*_{}[\]()#+.!|<>~-])/gu, "\\$1").replace(/[\r\n]+/gu, " ");
}

function inlineCode(value: string) {
  const runs = value.match(/`+/gu) ?? [];
  const fence = "`".repeat(Math.max(1, ...runs.map(run => run.length + 1)));
  const padded = value.startsWith("`") || value.endsWith("`") || /^\s|\s$/u.test(value);
  return `${fence}${padded ? " " : ""}${value}${padded ? " " : ""}${fence}`;
}

function exactString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`Invalid document ${label}.`);
  return value;
}

export function safeDocumentMarkdownFilename(title: string) {
  const stem = Array.from(title.normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "-")
    .replace(/\s+/gu, " ").replace(/\.md$/iu, "").replace(/[. ]+$/u, "").trim()).slice(0, 100).join("");
  const safeStem = !stem || /^[-. ]+$/u.test(stem) ? "document"
    : /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem) ? `_${stem}` : stem;
  return `${safeStem}.md`;
}

/** Serializes an already-authorized current Document Center body; it performs no reads or writes. */
export function exportDocumentMarkdown(document: BuilderDocument, exportedAt: string) {
  if (document.bodyAvailable === false) throw new Error("Document body is unavailable.");
  const id = exactString(document.id, "ID", 512);
  const title = exactString(document.title, "title", 1_024);
  const revisionId = exactString(document.revisionId, "revision", 512);
  const createdAt = exactString(document.createdAt, "recorded time", 64);
  const body = document.text;
  if (typeof body !== "string") throw new TypeError("Document body is unavailable.");
  const exported = new Date(exportedAt);
  if (!Number.isFinite(exported.getTime()) || exported.toISOString() !== exportedAt) {
    throw new TypeError("Invalid export timestamp.");
  }
  const pins = document.sourcePins ?? [];
  if (!Array.isArray(pins)) throw new TypeError("Invalid document source pins.");
  const pinRows = pins.map(pin => {
    const sourceId = exactString(pin.sourceId, "source ID", 512);
    const sourceRevisionId = exactString(pin.revisionId, "source revision", 512);
    if (!SHA256.test(pin.sha256)) throw new TypeError("Invalid source SHA-256.");
    return `- ${inlineCode(sourceId)} · Revision ${inlineCode(sourceRevisionId)} · SHA-256 ${inlineCode(pin.sha256)}`;
  });
  const lines = [
    `# ${markdownHeading(title)}`,
    "",
    "> 이 파일은 내보낸 시점의 snapshot입니다. 승인, 최신성 또는 납품 승인을 의미하지 않습니다.",
    "",
    "## 문서 참조",
    `- 문서 ID: ${inlineCode(id)}`,
    `- Revision: ${inlineCode(revisionId)}`,
    `- 기록 시각: ${inlineCode(createdAt)}`,
    `- 내보낸 시각: ${inlineCode(exportedAt)}`,
    "- 원본 참조와 해시:",
    ...(pinRows.length ? pinRows : ["  - 고정된 원본 참조 없음"]),
    "",
    "## 본문",
    "",
    ...(body.length ? [body] : ["_(빈 본문)_"]),
    "",
  ];
  return lines.join("\n");
}
