import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const desktop = process.env.SPS_BUILDER_CORE_DESKTOP;
const liveCodex = process.env.SPS_BUILDER_LIVE_CODEX;
const liveCancel = process.env.SPS_BUILDER_LIVE_CANCEL;
const liveDesign = process.env.SPS_BUILDER_LIVE_DESIGN;
const liveMemory = process.env.SPS_BUILDER_LIVE_MEMORY;
const liveQuestion = process.env.SPS_BUILDER_LIVE_QUESTION;
const liveCtos = process.env.SPS_BUILDER_LIVE_CTOS;
const liveBaseline = process.env.SPS_BUILDER_LIVE_BASELINE;
const liveWorkstreams = process.env.SPS_BUILDER_LIVE_WORKSTREAMS;
assert.deepEqual(process.argv.slice(2), liveWorkstreams === "1" ? ["--live-workstreams"] : [],
  "Live Workstreams requires its exact operator flag; no extra test-core-host arguments are accepted.");
assert.ok(liveCodex === undefined || liveCodex === "1", "Live account use must be explicitly enabled with SPS_BUILDER_LIVE_CODEX=1.");
assert.ok(liveCancel === undefined || liveCancel === "1" && liveCodex === "1",
  "Live cancellation requires explicit live-account and cancellation opt-in.");
assert.ok(liveDesign === undefined || liveDesign === "1" && liveCodex === "1" && liveCancel === undefined,
  "Live design requires explicit live-account opt-in and cannot be combined with cancellation.");
assert.ok(liveMemory === undefined || liveMemory === "1" && liveCodex === "1" && liveCancel === undefined && liveDesign === undefined,
  "Live memory requires explicit account opt-in and cannot combine trial scopes.");
assert.ok(liveQuestion === undefined || liveQuestion === "1" && liveCodex === "1" && liveCancel === undefined && liveDesign === undefined && liveMemory === undefined,
  "Live question requires explicit account opt-in and cannot combine trial scopes.");
assert.ok(liveCtos === undefined || liveCtos === "1" && liveCodex === "1" && liveCancel === undefined
  && liveDesign === undefined && liveMemory === undefined && liveQuestion === undefined && liveBaseline === undefined,
  "Live CTOS requires explicit account opt-in and cannot combine cancellation or other scopes.");
assert.ok(liveBaseline === undefined || liveBaseline === "1" && liveCodex === "1" && liveCancel === undefined
  && liveDesign === undefined && liveMemory === undefined && liveQuestion === undefined && liveCtos === undefined,
  "Live baseline requires explicit account opt-in and cannot combine cancellation or other scopes.");
assert.ok(liveWorkstreams === undefined || liveWorkstreams === "1" && liveCodex === "1" && liveCancel === undefined
  && liveDesign === undefined && liveMemory === undefined && liveQuestion === undefined && liveCtos === undefined && liveBaseline === undefined
  && !process.env.SPS_DESKTOP_E2E_BINARY,
  "Live Workstreams requires its explicit account opt-in and isolated default source-host path, without other scopes.");
assert.ok(liveBaseline !== "1" || !process.env.SPS_DESKTOP_E2E_BINARY,
  "Live baseline cannot use installed binaries.");
assert.ok(liveCtos === undefined || liveCodex === "1" && process.argv.length === 2,
  "Live CTOS can only run through the isolated default source-host operator, not build-only flags.");
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
    liveWorkstreams === "1" ? "live-workstreams-acceptance.mjs" : liveCtos === "1" ? "live-ctos-acceptance.mjs" : liveBaseline === "1" ? "live-baseline-acceptance.mjs" : liveQuestion === "1" ? "live-question-acceptance.mjs" : liveMemory === "1" ? "live-memory-acceptance.mjs" : liveDesign === "1" ? "live-design-acceptance.mjs" : liveCodex === "1" ? "live-codex-acceptance.mjs" : "core-host-acceptance.mjs") },
});
const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
assert.deepEqual(result, { code: 0, signal: null }, "Actual Host acceptance and owned cleanup must both complete.");
