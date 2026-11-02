import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const desktop = process.env.SPS_BUILDER_CORE_DESKTOP;
const liveCodex = process.env.SPS_BUILDER_LIVE_CODEX;
assert.ok(liveCodex === undefined || liveCodex === "1", "Live account use must be explicitly enabled with SPS_BUILDER_LIVE_CODEX=1.");
if (liveCodex === "1") {
  assert.ok(!process.env.OPENAI_API_KEY && !process.env.PAPERCLIP_CODEX_PROVIDERS,
    "Live subscription smoke must not inherit an API key or an alternate provider.");
}
assert.ok(typeof desktop === "string" && path.isAbsolute(desktop), "Set SPS_BUILDER_CORE_DESKTOP to the private Core Desktop checkout.");
assert.equal(process.platform, "win32", "Actual source Desktop acceptance currently targets Windows.");
await access(path.join(desktop, "scripts", "external-plugin-acceptance.mjs"));
const child = spawn(process.execPath, ["scripts/smoke-workspace-surfaces-desktop.mjs", "--no-ai-checklist", "--external-plugin-acceptance"], {
  cwd: desktop, windowsHide: true, shell: false, stdio: "inherit",
  env: { ...process.env, SPS_DESKTOP_E2E_SOURCE: "1", SPS_DESKTOP_E2E_BINARY: "",
    SPS_DESKTOP_E2E_KEEP_DATA: "0", SPS_DESKTOP_E2E_PLUGIN_ACCEPTANCE: path.join(import.meta.dirname,
      liveCodex === "1" ? "live-codex-acceptance.mjs" : "core-host-acceptance.mjs") },
});
const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
assert.deepEqual(result, { code: 0, signal: null }, "Actual Host acceptance and owned cleanup must both complete.");
