import type { JsonObject } from "@sonparkserver/plugin-sdk/platform";
type Tool<Name extends string> = Readonly<{ name: Name; displayName: string; description: string; parametersSchema: JsonObject }>;
export const ANSWER_CTO_QUESTION_TOOL: Tool<"builder.answer-cto-question">;
export const READ_CTO_QUESTION_ANSWER_TOOL: Tool<"builder.read-cto-question-answer">;
export const ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL: Tool<"builder.acknowledge-cto-question-answer">;
