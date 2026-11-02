export const READ_SOLUTION_TOOL = Object.freeze({
  name: "builder.read-solution",
  displayName: "Read Builder solution revision",
  description: "Read the stored solution revision for a Builder project. Only the current prepared Lead sessions may call this tool. Stored data does not prove customer approval or delivery.",
  parametersSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({ projectId: Object.freeze({ type: "string", minLength: 1, maxLength: 160 }) }),
    required: Object.freeze(["projectId"]),
    additionalProperties: false,
  }),
});
