import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../src/manifest.mjs";
import { CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL, DISPATCH_CTO_WORKSTREAM_TOOL, READ_CTO_WORKSTREAM_DELIVERY_TOOL } from "../src/delivery-tool-declarations.mjs";

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
