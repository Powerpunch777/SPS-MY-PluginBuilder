import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const options of [
  { SPS_BUILDER_LIVE_D3: "1" },
  { SPS_BUILDER_LIVE_D3: "1", SPS_BUILDER_LIVE_BASELINE: "1" },
  { SPS_BUILDER_LIVE_D3: "invalid", SPS_BUILDER_LIVE_BASELINE: "1", SPS_BUILDER_LIVE_CODEX: "1" },
]) test(`D3 live trial rejects incomplete explicit opt-in ${JSON.stringify(options)}`, () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("SPS_BUILDER_LIVE_") || name === "SPS_BUILDER_CORE_DESKTOP") delete env[name];
  const result = spawnSync(process.execPath, ["scripts/test-core-host.mjs"], { cwd: root,
    env: { ...env, ...options }, encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /D3 requires the explicit isolated live-account Baseline trial/u);
  assert.doesNotMatch(result.stderr, /Set SPS_BUILDER_CORE_DESKTOP/u);
  assert.equal(result.stdout, "");
});
