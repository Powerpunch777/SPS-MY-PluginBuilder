import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";

export const READ_SOLUTION_TOOL: Readonly<{
  name: "builder.read-solution";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const PROPOSE_DESIGN_TOOL: Readonly<{
  name: "builder.propose-design";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const READ_DESIGN_DRAFT_TOOL: Readonly<{
  name: "builder.read-design-draft";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const READ_DESIGN_SOURCES_TOOL: Readonly<{
  name: "builder.read-design-sources";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
