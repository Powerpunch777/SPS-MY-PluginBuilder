import assert from "node:assert/strict";
import test from "node:test";
import { parseDeliveryPreparation } from "../src/domain/delivery-preparation.ts";

const valid = () => ({ packageVersion: "1.0", targets: [{ target: "desktop", environments: ["Windows x64"],
  dependencies: [], entryPaths: ["dist/app.exe"], supplementaryPaths: ["docs/install.md"] }],
  limitationStatement: "No additional known limitations.", limitations: [], changeNotes: ["Initial delivery."] });

test("delivery preparation is a frozen declaration with explicit empty dependency/limitation lists", () => {
  const parsed = parseDeliveryPreparation(valid());
  assert.deepEqual(parsed, valid());
  assert.ok(Object.isFrozen(parsed.targets[0]?.entryPaths));
});

test("delivery preparation rejects missing environments, ambiguous paths, getters and caller gates", () => {
  const empty = valid(); empty.targets[0]!.environments = [];
  assert.throws(() => parseDeliveryPreparation(empty));
  const collision = valid(); collision.targets[0]!.entryPaths.push("DIST/APP.EXE");
  assert.throws(() => parseDeliveryPreparation(collision));
  const traversal = valid(); traversal.targets[0]!.entryPaths = ["../outside"];
  assert.throws(() => parseDeliveryPreparation(traversal));
  assert.throws(() => parseDeliveryPreparation({ ...valid(), qa: "PASS" }));
  assert.throws(() => parseDeliveryPreparation(Object.defineProperty(valid(), "packageVersion", { get() { throw new Error("invoked"); } })), /fields/u);
});
