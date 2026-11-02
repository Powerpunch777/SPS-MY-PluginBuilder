import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../src/manifest.mjs";
import { CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL, DISPATCH_CTO_WORKSTREAM_TOOL, READ_CTO_WORKSTREAM_DELIVERY_TOOL } from "../src/delivery-tool-declarations.mjs";
import { READ_CTO_MEMORY_TOOL, UPDATE_CTO_MEMORY_TOOL } from "../src/cto-memory-tool-declarations.mjs";

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
