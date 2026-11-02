import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";

export const READ_SOLUTION_TOOL: Readonly<{
  name: "builder.read-solution";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
