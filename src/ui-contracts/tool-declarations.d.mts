import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";
type Declaration<Name extends string> = Readonly<{ name: Name; displayName: string; description: string; parametersSchema: JsonObject }>;
export const PROPOSE_UI_CONTRACT_TOOL: Declaration<"builder.propose-ui-contract">;
export const PUBLISH_UI_CONTRACT_TOOL: Declaration<"builder.publish-ui-contract">;
export const READ_UI_CONTRACTS_TOOL: Declaration<"builder.read-ui-contracts">;
