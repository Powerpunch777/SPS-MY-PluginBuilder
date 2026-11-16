import assert from "node:assert/strict";
import test from "node:test";
import { summarizeScopedToolCalls } from "../scripts/live-baseline-acceptance.mjs";

test("live Baseline diagnostics preserve failed tool cause but omit inputs, result bodies and credentials", () => {
  const calls = summarizeScopedToolCalls([{ server: "sps-plugin-session", tool: "execute_plugin_tool", status: "failed",
    arguments: { toolName: "builder.propose-first-design-review", parameters: { secret: "private-input" } },
    error: { message: "Invalid rule requirementIds; token=fixture-private-token" }, result: { isError: true, data: "private-result" } }]);
  assert.match(calls[0].error, /Invalid rule requirementIds/u);
  assert.match(calls[0].error, /token=\[redacted\]/u);
  assert.equal(calls[0].resultIsError, true);
  assert.doesNotMatch(JSON.stringify(calls), /private-input|private-result|fixture-private-token/u);
  assert.equal(summarizeScopedToolCalls([{ error: { message: "x".repeat(1000) } }])[0].error.length <= 600, true);
});
