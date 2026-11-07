import type { AssuranceResult, SpecAssuranceAuthoritySnapshot } from "../spec-assurance/evaluator.ts";

/**
 * Restrict an explicit unresolved decision to Tasks that name its requirement.
 * Other decision states and requirements outside the Task remain unaffected.
 */
export function hasUndecidedTaskRequirement(requirementIds: readonly string[],
  decisions: SpecAssuranceAuthoritySnapshot["itemDecisions"] | AssuranceResult["itemDecisions"] | undefined): boolean {
  if (!decisions) return false;
  const taskRequirements = new Set(requirementIds);
  return decisions.some(decision => decision.status === "UNDECIDED" && taskRequirements.has(decision.requirementId));
}
