import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";
type Declaration<Name extends string> = Readonly<{ name: Name; displayName: string; description: string; parametersSchema: JsonObject }>;
export const SPEC_ASSURANCE_PACK_PROPOSAL_TOOL: Declaration<"builder.propose-spec-assurance-pack">;
export const READ_SPEC_ASSURANCE_PACK_TOOL: Declaration<"builder.read-spec-assurance-pack">;
export const READ_FIRST_DESIGN_REVIEW_TOOL: Declaration<"builder.read-first-design-review">;
export const PROPOSE_FIRST_DESIGN_REVIEW_TOOL: Declaration<"builder.propose-first-design-review">;
