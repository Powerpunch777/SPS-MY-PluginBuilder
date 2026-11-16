import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";

export const READ_REUSE_CANDIDATES_TOOL: Readonly<{
  name: "builder.read-reuse-candidates"; displayName: string; description: string; parametersSchema: JsonObject;
}>;
export const RECORD_REUSE_CANDIDATE_TOOL: Readonly<{
  name: "builder.record-reuse-candidate"; displayName: string; description: string; parametersSchema: JsonObject;
}>;
