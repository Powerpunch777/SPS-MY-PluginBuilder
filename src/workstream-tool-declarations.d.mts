import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";
type Tool<Name extends string> = Readonly<{ name: Name; displayName: string; description: string; parametersSchema: JsonObject }>;
export const PUBLISH_WORKSTREAM_TOOL: Tool<"builder.publish-workstream">;
export const READ_WORKSTREAMS_TOOL: Tool<"builder.read-workstreams">;
export const READ_CTO_WORKSTREAM_TOOL: Tool<"builder.read-cto-workstream">;
export const ACKNOWLEDGE_WORKSTREAM_TOOL: Tool<"builder.acknowledge-workstream">;
