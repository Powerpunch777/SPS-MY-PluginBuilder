import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";
type Tool<Name extends string> = Readonly<{ name: Name; displayName: string; description: string; parametersSchema: JsonObject }>;
export const DISPATCH_CTO_WORKSTREAM_TOOL: Tool<"builder.dispatch-workstream">;
export const READ_CTO_WORKSTREAM_DELIVERY_TOOL: Tool<"builder.read-workstream-delivery">;
export const CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL: Tool<"builder.cancel-workstream-delivery">;
