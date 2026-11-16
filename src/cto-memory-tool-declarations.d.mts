import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";
type Tool<Name extends string> = Readonly<{ name: Name; displayName: string; description: string; parametersSchema: JsonObject }>;
export const READ_CTO_MEMORY_TOOL: Tool<"builder.read-cto-memory">;
export const UPDATE_CTO_MEMORY_TOOL: Tool<"builder.update-cto-memory">;
