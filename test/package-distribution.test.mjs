import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectPluginDirectory } from "@sonparkserver/plugin-sdk/authoring/plugin-package-v1.mjs";

const bundledUiLicenses = [
  "@xyflow/react/LICENSE",
  "@xyflow/system/LICENSE",
  "classcat/LICENSE.md",
  "d3-color/LICENSE",
  "d3-dispatch/LICENSE",
  "d3-drag/LICENSE",
  "d3-ease/LICENSE",
  "d3-interpolate/LICENSE",
  "d3-selection/LICENSE",
  "d3-timer/LICENSE",
  "d3-transition/LICENSE",
  "d3-zoom/LICENSE",
  "lucide-react/LICENSE",
  "use-sync-external-store/LICENSE",
  "zustand/LICENSE",
];

test("built Builder package is valid and distributes only runtime and legal artifacts", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const inspection = await inspectPluginDirectory(projectRoot);
  assert.equal(inspection.valid, true, inspection.errors.join("\n"));
  assert.ok(inspection.source);

  const paths = new Set(inspection.files.map(file => file.relative));
  const required = [
    "package.json",
    "sps-plugin.json",
    "THIRD_PARTY_NOTICES.md",
    "dist/manifest.js",
    "dist/worker.js",
    "dist/ui-v0.1.0/index.js",
    "dist/ui-v0.1.0/index.js.LEGAL.txt",
    "dist/third-party-notices/@sonparkserver/plugin-sdk/LICENSE",
    "dist/third-party-notices/@sonparkserver/plugin-sdk/NOTICE.md",
    ...bundledUiLicenses.map(file => `dist/third-party-notices/${file}`),
  ];
  for (const file of required) assert.ok(paths.has(file), `distribution is missing ${file}`);

  for (const file of inspection.files) {
    const relative = file.relative;
    assert.ok(
      relative === "package.json"
        || relative === "sps-plugin.json"
        || relative === "THIRD_PARTY_NOTICES.md"
        || relative === "dist/manifest.js"
        || relative === "dist/worker.js"
        || relative.startsWith("dist/ui-v0.1.0/")
        || relative.startsWith("dist/third-party-notices/"),
      `unexpected source or development file in distribution: ${relative}`,
    );
    assert.doesNotMatch(relative, /(?:^|\/)(?:Core|core|node_modules|artifacts|docs|src|test|scripts)(?:\/|$)/,
      `private Core, dependency, source, test, or tooling path is not distributable: ${relative}`);
  }

  const legalPath = path.join(projectRoot, "dist", "ui-v0.1.0", "index.js.LEGAL.txt");
  const legalText = await readFile(legalPath, "utf8");
  assert.match(legalText, /Bundled license information:/);
  assert.ok(legalText.trim().length > 100, "linked UI legal sidecar must contain the bundled notices");
});
