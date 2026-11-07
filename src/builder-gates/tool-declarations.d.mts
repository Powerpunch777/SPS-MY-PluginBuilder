import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";
type Tool<Name extends string> = Readonly<{ name: Name; displayName: string; description: string; parametersSchema: JsonObject }>;
export const PUBLISH_INTEGRATION_PLAN_TOOL: Tool<"builder.publish-integration-plan">;
export const READ_VERIFIED_WORKSTREAM_TOOL: Tool<"builder.read-verified-workstream">;
export const INTEGRATE_VERIFIED_TASK_TOOL: Tool<"builder.integrate-verified-task">;
export const READ_INTEGRATION_PROGRESS_TOOL: Tool<"builder.read-integration-progress">;
