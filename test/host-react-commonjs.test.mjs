import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { hostReactCommonJs } from "../scripts/host-react-commonjs.mjs";

test("CommonJS dependency consumes external Host React without a browser require global", async () => {
  const marker = `data:text/javascript,${encodeURIComponent('export const marker="same-host-react";')}`;
  const result = await build({
    stdin: { contents: 'import * as direct from "react"; const indirect=require("react"); export const same=direct===indirect; export const value=indirect.marker;', resolveDir: process.cwd() },
    bundle: true, format: "esm", platform: "browser", write: false,
    plugins: [hostReactCommonJs(), { name: "test-host-react", setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: marker, external: true }));
    } }],
  });
  const source = result.outputFiles[0].text;
  assert.doesNotMatch(source, /Dynamic require of/);
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.equal(loaded.same, true);
  assert.equal(loaded.value, "same-host-react");
});
