import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("development server rejects invalid port settings before starting", () => {
  for (const value of ["", "abc", "-1", "1.5", "65536"]) {
    const result = spawnSync(process.execPath, ["scripts/dev.mjs"], {
      env: { ...process.env, SPS_BUILDER_DEV_PORT: value },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `port ${JSON.stringify(value)} should be rejected`);
    assert.match(result.stderr, /SPS_BUILDER_DEV_PORT must be/);
  }
});
