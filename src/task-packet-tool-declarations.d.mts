import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";
type Tool<Name extends string> = Readonly<{ name: Name; displayName: string; description: string; parametersSchema: JsonObject }>;
export const READ_CTO_TASK_PACKETS_TOOL: Tool<"builder.read-task-packets">;
export const PUBLISH_CTO_TASK_PACKET_TOOL: Tool<"builder.publish-task-packet">;
