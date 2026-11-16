import type { ToolDeclaration } from "@sonparkserver/plugin-sdk/platform";
export const READ_FINAL_REVIEW_TOOL: Readonly<ToolDeclaration & { name: "builder.read-final-review" }>;
export const ATTEST_FINAL_PACKET_TOOL: Readonly<ToolDeclaration & { name: "builder.attest-final-packet" }>;
export const REQUEST_FINAL_REVIEW_TOOL: Readonly<ToolDeclaration & { name: "builder.request-final-review" }>;
