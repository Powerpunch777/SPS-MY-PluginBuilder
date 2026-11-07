import assert from "node:assert/strict";
import test from "node:test";
import { hasUndecidedTaskRequirement } from "../src/builder-gates/task-decision-scope.ts";

const decisions = [
  { requirementId: "REQ-A", status: "UNDECIDED", reason: "Explicitly unresolved." },
  { requirementId: "REQ-B", status: "NOT_CHECKED", reason: "Outside this gate's confirmed policy." },
  { requirementId: "REQ-C", status: "INCONCLUSIVE", reason: "Outside this gate's confirmed policy." },
] as const;

test("only an explicitly UNDECIDED requirement directly named by the Task blocks", () => {
  assert.equal(hasUndecidedTaskRequirement(["REQ-A"], decisions), true);
  assert.equal(hasUndecidedTaskRequirement(["REQ-B"], decisions), false);
  assert.equal(hasUndecidedTaskRequirement(["REQ-C"], decisions), false);
  assert.equal(hasUndecidedTaskRequirement(["REQ-OTHER"], decisions), false);
  assert.equal(hasUndecidedTaskRequirement(["REQ-A", "REQ-OTHER"], decisions), true);
  assert.equal(hasUndecidedTaskRequirement(["REQ-A"], undefined), false);
});
