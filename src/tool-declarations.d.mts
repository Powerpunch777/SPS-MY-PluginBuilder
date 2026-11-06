import type { JsonObject, SpsPlatformCapability } from "@sonparkserver/plugin-sdk/platform";

export const OWNED_AGENT_CAPABILITIES: readonly SpsPlatformCapability[];

export const READ_SOLUTION_TOOL: Readonly<{
  name: "builder.read-solution";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const READ_CHANGE_IMPACT_TOOL: Readonly<{
  name: "builder.read-change-impact";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const PROPOSE_DESIGN_TOOL: Readonly<{
  name: "builder.propose-design";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const READ_DESIGN_DRAFT_TOOL: Readonly<{
  name: "builder.read-design-draft";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const READ_DESIGN_SOURCES_TOOL: Readonly<{
  name: "builder.read-design-sources";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
export const READ_CONSULTATION_ANALYSIS_TOOL: Readonly<{
  name: "builder.read-consultation-analysis";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const READ_LEAD_MEMORY_TOOL: Readonly<{
  name: "builder.read-lead-memory";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
export const UPDATE_LEAD_MEMORY_TOOL: Readonly<{
  name: "builder.update-lead-memory";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
export const RESOLVE_DESIGN_QUESTION_TOOL: Readonly<{
  name: "builder.resolve-design-question";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const CREATE_CTO_TOOL: Readonly<{
  name: "builder.create-cto";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
export const LIST_CTOS_TOOL: Readonly<{
  name: "builder.list-ctos";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const PUBLISH_DESIGN_BASELINE_TOOL: Readonly<{
  name: "builder.publish-design-baseline";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
export const READ_DESIGN_BASELINE_TOOL: Readonly<{
  name: "builder.read-design-baseline";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
export const INSPECT_SPEC_ASSURANCE_TOOL: Readonly<{
  name: "builder.inspect-spec-assurance";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;

export const PUBLISH_TECHNOLOGY_DECISIONS_TOOL: Readonly<{
  name: "builder.publish-technology-decisions";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
export const READ_TECHNOLOGY_DECISIONS_TOOL: Readonly<{
  name: "builder.read-technology-decisions";
  displayName: string;
  description: string;
  parametersSchema: JsonObject;
}>;
