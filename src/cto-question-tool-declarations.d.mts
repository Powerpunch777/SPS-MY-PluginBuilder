import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";
type Tool<Name extends string> = Readonly<{ name: Name; displayName: string; description: string; parametersSchema: JsonObject }>;
export const SUBMIT_CTO_QUESTION_TOOL: Tool<"builder.submit-cto-question">;
export const READ_CTO_QUESTIONS_TOOL: Tool<"builder.read-cto-questions">;
export const READ_CTO_INTAKE_TOOL: Tool<"builder.read-cto-intake">;
export const READ_OWN_CTO_QUESTION_TOOL: Tool<"builder.read-own-cto-question">;
export const REVIEW_CTO_QUESTION_TOOL: Tool<"builder.review-cto-question">;
