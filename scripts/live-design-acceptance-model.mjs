const APPROVED_TEST_MODEL = "gpt-5.6-luna/high";

export function resolveLiveDesignTestModel(value) {
  if (value === undefined) return undefined;
  if (value !== APPROVED_TEST_MODEL) {
    throw new Error(`SPS_BUILDER_LIVE_DESIGN_TEST_MODEL must be omitted or exactly ${APPROVED_TEST_MODEL}.`);
  }
  return { model: "gpt-5.6-luna", reasoningEffort: "high" };
}
