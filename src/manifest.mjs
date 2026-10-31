import { defineSpsPluginManifest } from "@sonparkserver/plugin-sdk/manifest";
import { defineSpsUiContributions } from "@sonparkserver/plugin-sdk/ui";

const surface = defineSpsUiContributions({
  entrypoint: "./dist/ui-v0.1.0",
  contributions: [{ surface: "page", id: "builder", label: "SPS Builder", exportName: "BuilderPage", routePath: "builder" }],
});

export default defineSpsPluginManifest({
  id: "com.sonparkserver.my-plugin-builder",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "SPS MY Plugin Builder",
  description: "Private solution authoring, consultation and delivery workspace.",
  author: "SonParkServer",
  categories: ["automation"],
  minimumHostVersion: "0.4.137",
  ...surface,
  capabilities: [...surface.capabilities, "ui.workspaceShell.provide", "plugin.state.read", "plugin.state.write"],
  entrypoints: { ...surface.entrypoints, worker: "./dist/worker.js", workspaceWorker: "./dist/worker.js" },
  ui: {
    ...surface.ui,
    workspaceShell: {
      id: "my-plugin-builder", displayName: "SPS Builder",
      defaultRoute: "/plugins/com.sonparkserver.my-plugin-builder/builder",
      navigation: [{ id: "builder", displayName: "SPS Builder", target: "/plugins/com.sonparkserver.my-plugin-builder/builder", order: 0 }],
    },
  },
  sps: { contractVersion: "2.0", primitives: [] },
});
