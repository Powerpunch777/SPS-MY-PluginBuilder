import assert from "node:assert/strict";
import test from "node:test";
import { parseMainG7Review } from "../src/domain/main-g7-review.ts";
import { mainG7ReviewFixture } from "./fixtures/main-g7-review-fixture.ts";

const pin = (sourceId: string) => ({ sourceId });
const packet = { packetSha256: "a".repeat(64), baseline: pin("baseline"), uiRevision: pin("ui"), manifest: pin("manifest"),
  integration: { build: pin("build"), ciEvidence: [pin("ci")], e2eEvidence: [pin("e2e")], regressionEvidence: [pin("regression")] },
  documents: [{ kind: "installation-guide", pin: pin("install") }, { kind: "user-guide", pin: pin("usage") }],
  qaEvidence: [pin("qa")], g6Evidence: [pin("g6")], g7Evidence: [pin("preparation")] };
const pins = "b".repeat(64);
const review = () => mainG7ReviewFixture(packet, pins);

test("Main assessment binds every required area to exact server evidence and keeps its authored summary", () => {
  const parsed = parseMainG7Review(review(), packet, pins);
  assert.equal(parsed.checks.length, 5);
  assert.ok(parsed.checks[4]!.evidenceSourceIds.includes("regression"));
  assert.ok(Object.isFrozen(parsed.checks[0]!.evidenceSourceIds));
  const failures = [
    { ...review(), packetSha256: "c".repeat(64) },
    { ...review(), currentPinsSha256: "c".repeat(64) },
    { ...review(), checks: review().checks.slice(1) },
    { ...review(), checks: [review().checks[0], ...review().checks.slice(0, 4)] },
    { ...review(), checks: review().checks.map((check, index) => index ? check : { ...check, summary: " " }) },
    { ...review(), checks: review().checks.map((check, index) => index ? check : { ...check, evidenceSourceIds: ["unknown"] }) },
    { ...review(), checks: review().checks.map((check, index) => index !== 4 ? check : { ...check, evidenceSourceIds: check.evidenceSourceIds.filter(id => id !== "regression") }) },
    { ...review(), pass: true },
  ];
  for (const value of failures) assert.throws(() => parseMainG7Review(value, packet, pins));
});

test("Main assessment parsing never invokes accessors or accepts sparse lists", () => {
  let calls = 0;
  const value = Object.defineProperty({ ...review() }, "checks", { enumerable: true, get() { calls++; return []; } });
  assert.throws(() => parseMainG7Review(value, packet, pins));
  const sparse = [...review().checks];
  delete sparse[2];
  assert.throws(() => parseMainG7Review({ ...review(), checks: sparse }, packet, pins));
  assert.equal(calls, 0);
});
