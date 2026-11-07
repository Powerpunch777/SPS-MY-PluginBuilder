import assert from "node:assert/strict";
import { test } from "node:test";
import { runDesignAcceptance } from "../scripts/live-design-acceptance.mjs";
import { resolveLiveDesignTestModel } from "../scripts/live-design-acceptance-model.mjs";

test("live design model is unchanged unless the exact test-only opt-in is supplied", () => {
  assert.equal(resolveLiveDesignTestModel(undefined), undefined);
  assert.deepEqual(resolveLiveDesignTestModel("gpt-5.6-luna/high"), {
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  });
});

test("live design model rejects every non-approved override", () => {
  for (const value of ["", "1", "true", "gpt-5.6-luna", "gpt-5.6-luna/medium", "gpt-5.6-terra/high", "other/high"]) {
    assert.throws(() => resolveLiveDesignTestModel(value), /must be omitted or exactly gpt-5\.6-luna\/high/);
  }
});

test("unsupported override fails before live acceptance can call the API", async () => {
  const previous = process.env.SPS_BUILDER_LIVE_DESIGN_TEST_MODEL;
  process.env.SPS_BUILDER_LIVE_DESIGN_TEST_MODEL = "gpt-5.6-terra/high";
  try {
    await assert.rejects(runDesignAcceptance({}), /must be omitted or exactly gpt-5\.6-luna\/high/);
  } finally {
    if (previous === undefined) delete process.env.SPS_BUILDER_LIVE_DESIGN_TEST_MODEL;
    else process.env.SPS_BUILDER_LIVE_DESIGN_TEST_MODEL = previous;
  }
});
