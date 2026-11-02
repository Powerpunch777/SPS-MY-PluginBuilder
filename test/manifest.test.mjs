import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../src/manifest.mjs";
import { CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL, DISPATCH_CTO_WORKSTREAM_TOOL, READ_CTO_WORKSTREAM_DELIVERY_TOOL } from "../src/delivery-tool-declarations.mjs";
import { READ_CTO_MEMORY_TOOL, UPDATE_CTO_MEMORY_TOOL } from "../src/cto-memory-tool-declarations.mjs";
import { SUBMIT_CTO_QUESTION_TOOL, READ_CTO_QUESTIONS_TOOL, READ_CTO_INTAKE_TOOL, READ_OWN_CTO_QUESTION_TOOL, REVIEW_CTO_QUESTION_TOOL } from "../src/cto-question-tool-declarations.mjs";
import { ANSWER_CTO_QUESTION_TOOL, READ_CTO_QUESTION_ANSWER_TOOL, ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL } from "../src/cto-question-reply-tool-declarations.mjs";

test("Host installation does not implicitly enable Builder in every Workspace", () => {
  assert.equal(manifest.companyActivation?.defaultEnabled, false);
});

test("Workspace Shell routes match the declared page route rather than a package-key URL", () => {
  const pages = manifest.ui.slots.filter(slot => slot.type === "page");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].exportName, "BuilderPage");
  const pageRoute = `/${pages[0].routePath}`;
  assert.equal(manifest.ui.workspaceShell.defaultRoute, pageRoute);
  assert.deepEqual(manifest.ui.workspaceShell.navigation.map(item => item.target), [pageRoute]);
  assert.equal(manifest.entrypoints.workspaceWorker, manifest.entrypoints.worker);
  assert.ok(manifest.capabilities.includes("ui.workspaceShell.provide"));
  assert.ok(manifest.capabilities.includes("agent.sessions.create"));
  for (const capability of ["agent.sessions.send", "agent.sessions.read", "agent.sessions.cancel"]) {
    assert.ok(manifest.capabilities.includes(capability));
  }
});

test("CTO delivery tools expose exact bounded Lead contracts in the manifest", () => {
  const declarations = [DISPATCH_CTO_WORKSTREAM_TOOL, READ_CTO_WORKSTREAM_DELIVERY_TOOL, CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL];
  const tools = declarations.map(declaration => manifest.tools.find(tool => tool.name === declaration.name));
  assert.deepEqual(tools, declarations);
  assert.deepEqual(DISPATCH_CTO_WORKSTREAM_TOOL.parametersSchema.required,
    ["projectId", "workstreamId", "specRevision", "boardRevisionId"]);
  assert.equal(DISPATCH_CTO_WORKSTREAM_TOOL.parametersSchema.additionalProperties, false);
  assert.equal(DISPATCH_CTO_WORKSTREAM_TOOL.parametersSchema.properties.specRevision.minimum, 1);
  for (const declaration of [READ_CTO_WORKSTREAM_DELIVERY_TOOL, CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL]) {
    assert.deepEqual(declaration.parametersSchema.required, ["projectId", "ctoId"]);
    assert.equal(declaration.parametersSchema.additionalProperties, false);
  }
  assert.match(DISPATCH_CTO_WORKSTREAM_TOOL.description, /planning-only/i);
  assert.match(DISPATCH_CTO_WORKSTREAM_TOOL.description, /unknown write/i);
  assert.match(CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL.description, /process exit/i);
});

test("CTO memory tools expose strict private-memory contracts in the manifest", () => {
  const declarations = [READ_CTO_MEMORY_TOOL, UPDATE_CTO_MEMORY_TOOL];
  assert.deepEqual(declarations.map(declaration => manifest.tools.find(tool => tool.name === declaration.name)), declarations);
  assert.deepEqual(READ_CTO_MEMORY_TOOL.parametersSchema.required, ["projectId", "ctoId", "workstreamId"]);
  assert.deepEqual(Object.keys(READ_CTO_MEMORY_TOOL.parametersSchema.properties).sort(), ["ctoId", "projectId", "workstreamId"]);
  assert.equal(READ_CTO_MEMORY_TOOL.parametersSchema.additionalProperties, false);
  assert.deepEqual(UPDATE_CTO_MEMORY_TOOL.parametersSchema.required,
    ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "memory"]);
  assert.equal(UPDATE_CTO_MEMORY_TOOL.parametersSchema.additionalProperties, false);
  assert.deepEqual(UPDATE_CTO_MEMORY_TOOL.parametersSchema.properties.expectedBaseRevisionId.type, ["string", "null"]);
  const memory = UPDATE_CTO_MEMORY_TOOL.parametersSchema.properties.memory;
  assert.deepEqual(memory.required, ["projectId", "ctoId", "revisionId", "entries"]);
  assert.equal(memory.additionalProperties, false);
  assert.equal(memory.properties.entries.maxItems, 128);
  const entry = memory.properties.entries.items;
  assert.deepEqual(entry.required, ["id", "kind", "text", "sourceRequestIds"]);
  assert.deepEqual(entry.properties.kind.enum, ["context", "decision", "assumption", "open-question"]);
  assert.equal(entry.properties.text.maxLength, 4096);
  assert.equal(entry.properties.sourceRequestIds.uniqueItems, true);
  assert.equal(entry.properties.sourceRequestIds.items.pattern, "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  assert.match(memory.description, /128 KiB UTF-8 JSON limit/);
  assert.match(entry.properties.text.description, /4096-byte UTF-8 limit/);
  assert.match(READ_CTO_MEMORY_TOOL.description, /exact active Core-bound Workstream run/);
  assert.match(READ_CTO_MEMORY_TOOL.description, /project-and-CTO-scoped/);
  assert.match(UPDATE_CTO_MEMORY_TOOL.description, /never automatically retry/);
  assert.match(UPDATE_CTO_MEMORY_TOOL.description, /not approval or evidence/);
});

test("CTO question tools expose strict planning-only contracts in the manifest", () => {
  const declarations = [SUBMIT_CTO_QUESTION_TOOL, READ_CTO_QUESTIONS_TOOL, READ_CTO_INTAKE_TOOL, READ_OWN_CTO_QUESTION_TOOL, REVIEW_CTO_QUESTION_TOOL];
  assert.deepEqual(declarations.map(declaration => manifest.tools.find(tool => tool.name === declaration.name)), declarations);
  const replyDeclarations = [ANSWER_CTO_QUESTION_TOOL, READ_CTO_QUESTION_ANSWER_TOOL, ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL];
  assert.deepEqual(replyDeclarations.map(declaration => manifest.tools.find(tool => tool.name === declaration.name)), replyDeclarations);
  const answerSchema = ANSWER_CTO_QUESTION_TOOL.parametersSchema;
  assert.deepEqual(answerSchema.required, ["projectId", "questionId", "answer"]);
  assert.equal(answerSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(answerSchema.properties).sort(), ["answer", "projectId", "questionId"]);
  const answer = answerSchema.properties.answer;
  assert.deepEqual(answer.required, ["text", "selectedOptionId", "evidenceRefs"]);
  assert.equal(answer.additionalProperties, false);
  assert.equal(answer.properties.text.maxLength, 8192);
  assert.deepEqual(answer.properties.selectedOptionId.type, ["string", "null"]);
  assert.equal(answer.properties.evidenceRefs.minItems, 1);
  assert.equal(answer.properties.evidenceRefs.maxItems, 32);
  assert.equal(answer.properties.evidenceRefs.uniqueItems, true);
  assert.deepEqual(READ_CTO_QUESTION_ANSWER_TOOL.parametersSchema.required,
    ["projectId", "ctoId", "workstreamId", "questionId"]);
  for (const declaration of [READ_CTO_QUESTION_ANSWER_TOOL, ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL]) {
    assert.deepEqual(Object.keys(declaration.parametersSchema.properties).filter(key => key !== "understanding").sort(),
      ["ctoId", "projectId", "questionId", "workstreamId"]);
    assert.equal(declaration.parametersSchema.additionalProperties, false);
  }
  const acknowledgement = ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL.parametersSchema;
  assert.deepEqual(acknowledgement.required, ["projectId", "ctoId", "workstreamId", "questionId", "understanding"]);
  assert.equal(acknowledgement.properties.understanding.maxLength, 4096);
  assert.match(ANSWER_CTO_QUESTION_TOOL.description, /stable admission only/);
  assert.match(ANSWER_CTO_QUESTION_TOOL.description, /never resend automatically/);
  assert.match(ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL.description, /not implementation approval/);
  const submit = SUBMIT_CTO_QUESTION_TOOL.parametersSchema;
  assert.deepEqual(submit.required, ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "proposal"]);
  assert.equal(submit.additionalProperties, false);
  assert.deepEqual(submit.properties.expectedBaseRevisionId.type, ["string", "null"]);
  const proposal = submit.properties.proposal;
  assert.deepEqual(proposal.required, ["id", "title", "context", "reasonNeeded", "options", "recommendation", "delayImpact", "scopeNodeIds", "evidenceRefs"]);
  assert.equal(proposal.additionalProperties, false);
  assert.equal(proposal.properties.title.maxLength, 512);
  assert.equal(proposal.properties.options.minItems, 2);
  assert.equal(proposal.properties.options.maxItems, 8);
  assert.deepEqual(proposal.properties.options.items.required, ["id", "label", "tradeoff"]);
  assert.equal(proposal.properties.scopeNodeIds.minItems, 1);
  assert.equal(proposal.properties.scopeNodeIds.maxItems, 64);
  assert.equal(proposal.properties.evidenceRefs.maxItems, 32);
  assert.deepEqual(READ_CTO_QUESTIONS_TOOL.parametersSchema.required, ["projectId"]);
  assert.equal(READ_CTO_QUESTIONS_TOOL.parametersSchema.additionalProperties, false);
  assert.deepEqual(READ_CTO_INTAKE_TOOL.parametersSchema.required, ["projectId", "questionId"]);
  assert.deepEqual(Object.keys(READ_CTO_INTAKE_TOOL.parametersSchema.properties).sort(), ["projectId", "questionId"]);
  assert.equal(READ_CTO_INTAKE_TOOL.parametersSchema.additionalProperties, false);
  assert.match(READ_CTO_INTAKE_TOOL.description, /registered Lead CTO-intake run bound to the stable Core admission receipt/);
  assert.match(READ_CTO_INTAKE_TOOL.description, /never a user answer, approval, private CTO memory/);
  assert.deepEqual(READ_OWN_CTO_QUESTION_TOOL.parametersSchema.required, ["projectId", "ctoId", "workstreamId", "questionId"]);
  assert.equal(READ_OWN_CTO_QUESTION_TOOL.parametersSchema.additionalProperties, false);
  assert.match(READ_OWN_CTO_QUESTION_TOOL.description, /exact active Core-bound CTO session/);
  assert.match(READ_OWN_CTO_QUESTION_TOOL.description, /No other CTO question/);
  assert.match(READ_OWN_CTO_QUESTION_TOOL.description, /never resends/);
  const review = REVIEW_CTO_QUESTION_TOOL.parametersSchema;
  assert.deepEqual(review.required, ["projectId", "questionId", "expectedBaseRevisionId", "revisionId", "reviewId", "disposition", "rationale", "evidenceRefs"]);
  assert.deepEqual(review.properties.disposition.enum, ["existing-specification", "delegated-choice", "user-decision-needed"]);
  assert.equal(review.additionalProperties, false);
  for (const declaration of declarations.filter(item => item !== READ_OWN_CTO_QUESTION_TOOL)) {
    assert.match(declaration.description, /planning/i);
    assert.match(declaration.description, /implementation/i);
  }
  assert.match(SUBMIT_CTO_QUESTION_TOOL.description, /exact active Core-bound/);
  assert.match(SUBMIT_CTO_QUESTION_TOOL.description, /never automatically retry/);
  assert.match(REVIEW_CTO_QUESTION_TOOL.description, /does not generate a user answer/);
});
