import { defineSpsPluginManifest } from "@sonparkserver/plugin-sdk/manifest";
import { defineSpsUiContributions } from "@sonparkserver/plugin-sdk/ui";
import { READ_SOLUTION_TOOL, PROPOSE_DESIGN_TOOL, READ_DESIGN_DRAFT_TOOL, READ_DESIGN_SOURCES_TOOL, READ_LEAD_MEMORY_TOOL, UPDATE_LEAD_MEMORY_TOOL, RESOLVE_DESIGN_QUESTION_TOOL, CREATE_CTO_TOOL, LIST_CTOS_TOOL, PUBLISH_DESIGN_BASELINE_TOOL, READ_DESIGN_BASELINE_TOOL } from "./tool-declarations.mjs";

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
  capabilities: [...surface.capabilities, "ui.workspaceShell.provide", "plugin.state.read", "plugin.state.write", "agent.tools.register", "agents.read", "agent.sessions.create",
    "agent.sessions.send", "agent.sessions.read", "agent.sessions.cancel"],
  entrypoints: { ...surface.entrypoints, worker: "./dist/worker.js", workspaceWorker: "./dist/worker.js" },
  companyActivation: { defaultEnabled: false },
  tools: [READ_SOLUTION_TOOL, PROPOSE_DESIGN_TOOL, READ_DESIGN_DRAFT_TOOL, READ_DESIGN_SOURCES_TOOL, READ_LEAD_MEMORY_TOOL, UPDATE_LEAD_MEMORY_TOOL, RESOLVE_DESIGN_QUESTION_TOOL, CREATE_CTO_TOOL, LIST_CTOS_TOOL, PUBLISH_DESIGN_BASELINE_TOOL, READ_DESIGN_BASELINE_TOOL],
  ui: {
    ...surface.ui,
    workspaceShell: {
      id: "my-plugin-builder", displayName: "SPS Builder",
      defaultRoute: "/builder",
      navigation: [{ id: "builder", displayName: "SPS Builder", target: "/builder", order: 0 }],
    },
  },
  sps: { contractVersion: "2.0", primitives: [] },
});
