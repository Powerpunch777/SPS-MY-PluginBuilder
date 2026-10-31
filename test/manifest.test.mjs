import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../src/manifest.mjs";

test("Workspace Shell routes match the declared page route rather than a package-key URL", () => {
  const pages = manifest.ui.slots.filter(slot => slot.type === "page");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].exportName, "BuilderPage");
  const pageRoute = `/${pages[0].routePath}`;
  assert.equal(manifest.ui.workspaceShell.defaultRoute, pageRoute);
  assert.deepEqual(manifest.ui.workspaceShell.navigation.map(item => item.target), [pageRoute]);
  assert.equal(manifest.entrypoints.workspaceWorker, manifest.entrypoints.worker);
  assert.ok(manifest.capabilities.includes("ui.workspaceShell.provide"));
});
