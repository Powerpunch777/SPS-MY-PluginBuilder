import { defineSpsPluginManifest } from "@sonparkserver/plugin-sdk/manifest";
import { SPS_PLATFORM_CAPABILITIES } from "@sonparkserver/plugin-sdk/platform";
import { defineSpsUiContributions } from "@sonparkserver/plugin-sdk/ui";
import { READ_SOLUTION_TOOL, PROPOSE_DESIGN_TOOL, READ_DESIGN_DRAFT_TOOL, READ_DESIGN_SOURCES_TOOL, READ_LEAD_MEMORY_TOOL, UPDATE_LEAD_MEMORY_TOOL, RESOLVE_DESIGN_QUESTION_TOOL, CREATE_CTO_TOOL, LIST_CTOS_TOOL, PUBLISH_DESIGN_BASELINE_TOOL, READ_DESIGN_BASELINE_TOOL, INSPECT_SPEC_ASSURANCE_TOOL } from "./tool-declarations.mjs";
import { PUBLISH_TECHNOLOGY_DECISIONS_TOOL, READ_TECHNOLOGY_DECISIONS_TOOL } from "./tool-declarations.mjs";
import { PUBLISH_WORKSTREAM_TOOL, READ_WORKSTREAMS_TOOL, READ_CTO_WORKSTREAM_TOOL, ACKNOWLEDGE_WORKSTREAM_TOOL } from "./workstream-tool-declarations.mjs";
import { DISPATCH_CTO_WORKSTREAM_TOOL, READ_CTO_WORKSTREAM_DELIVERY_TOOL, CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL } from "./delivery-tool-declarations.mjs";
import { READ_CTO_MEMORY_TOOL, UPDATE_CTO_MEMORY_TOOL } from "./cto-memory-tool-declarations.mjs";
import { SUBMIT_CTO_QUESTION_TOOL, READ_CTO_QUESTIONS_TOOL, READ_CTO_INTAKE_TOOL, READ_OWN_CTO_QUESTION_TOOL, REVIEW_CTO_QUESTION_TOOL } from "./cto-question-tool-declarations.mjs";
import { ANSWER_CTO_QUESTION_TOOL, READ_CTO_QUESTION_ANSWER_TOOL, ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL } from "./cto-question-reply-tool-declarations.mjs";
import { READ_CTO_TASK_PACKETS_TOOL, PUBLISH_CTO_TASK_PACKET_TOOL, PREPARE_TASK_WORKER_TOOL, READ_TASK_WORKERS_TOOL,
  DISPATCH_TASK_WORKER_TOOL, READ_TASK_SOURCE_FILE_TOOL, WRITE_TASK_SOURCE_FILE_TOOL, DELETE_TASK_SOURCE_FILE_TOOL,
  SUBMIT_TASK_SOURCE_TOOL, READ_TASK_SOURCE_SUBMISSIONS_TOOL, ACCEPT_TASK_SOURCE_SUBMISSION_TOOL,
  REQUEST_PROTECTED_TASK_QA_TOOL, READ_PROTECTED_TASK_QA_TOOL, READ_PROTECTED_TASK_QA_HISTORY_TOOL,
  PUBLISH_TASK_QA_REPORT_TOOL, VERIFY_WORKSTREAM_TOOL } from "./task-packet-tool-declarations.mjs";
import { READ_CONSULTATION_ANALYSIS_TOOL } from "./tool-declarations.mjs";
import { SPEC_ASSURANCE_PACK_PROPOSAL_TOOL, READ_SPEC_ASSURANCE_PACK_TOOL, READ_FIRST_DESIGN_REVIEW_TOOL, PROPOSE_FIRST_DESIGN_REVIEW_TOOL,
  RECORD_SPEC_GAPS_TOOL, READ_SPEC_GAPS_TOOL } from "./spec-assurance/tool-declarations.mjs";
import { PROPOSE_UI_CONTRACT_TOOL, PUBLISH_UI_CONTRACT_TOOL, READ_UI_CONTRACTS_TOOL } from "./ui-contracts/tool-declarations.mjs";
import { ATTEST_FINAL_PACKET_TOOL, READ_FINAL_REVIEW_TOOL, REQUEST_FINAL_REVIEW_TOOL } from "./delivery-evidence/tool-declarations.mjs";
import { PROPOSE_DELIVERY_DOCUMENTS_TOOL, READ_DELIVERY_DOCUMENTS_TOOL } from "./project-documents/tool-declarations.mjs";
import { OWNED_AGENT_CAPABILITIES, READ_CHANGE_IMPACT_TOOL } from "./tool-declarations.mjs";
import { READ_REUSE_CANDIDATES_TOOL, RECORD_REUSE_CANDIDATE_TOOL } from "./reuse-first/tool-declarations.mjs";
import { PUBLISH_INTEGRATION_PLAN_TOOL, READ_VERIFIED_WORKSTREAM_TOOL, INTEGRATE_VERIFIED_TASK_TOOL,
  READ_INTEGRATION_PROGRESS_TOOL, REQUEST_INTEGRATION_VALIDATION_TOOL, PUBLISH_INTEGRATION_PACKET_TOOL } from "./builder-gates/tool-declarations.mjs";

const surface = defineSpsUiContributions({
  entrypoint: "./dist/ui-v0.1.0",
  contributions: [{ surface: "page", id: "builder", label: "SPS Builder", exportName: "BuilderPage", routePath: "builder" }],
});
const taskFolderCapabilities = ["sps.workspaceSources.read", "local.folders", "sps.workspaceSources.gitWrite"]
  .filter(capability => SPS_PLATFORM_CAPABILITIES.includes(capability));
const taskProtectedQaCapabilities = ["sps.runs.dispatch", "sps.executions.read", "sps.artifacts.read"].filter(capability => SPS_PLATFORM_CAPABILITIES.includes(capability));

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
    "agent.sessions.send", "agent.sessions.read", "agent.sessions.list", "agent.sessions.cancel", ...OWNED_AGENT_CAPABILITIES, ...taskFolderCapabilities,
    ...taskProtectedQaCapabilities, "events.emit", "jobs.schedule"],
  jobs: [{ jobKey: "builder.integrate-verified-workstream", displayName: "Integrate a verified Workstream", scope: "workspace",
    description: "Event-driven consumption of current guarded Workstream verification. No periodic schedule or AI wake is implied." },
  { jobKey: "agent-session-terminal", displayName: "Reconcile owned session terminal handoffs", scope: "workspace",
    description: "Reconciles exact Worker, QA, CTO, Main, Integration Review and Manager terminal events. A normal Run end is not task completion; failures never create replacement sessions." },
  { jobKey: "builder.review-integration-packet", displayName: "Review an exact integration packet", scope: "workspace",
    description: "A persisted Manager packet requests the current Main's G7 review once through the existing keyed conversation." },
  { jobKey: "builder.request-packet-user-review", displayName: "Prepare the exact user package review", scope: "workspace",
    description: "A stored Main attestation requests the existing Integration Review session to prepare the user's approval request." }],
  entrypoints: { ...surface.entrypoints, worker: "./dist/worker.js", workspaceWorker: "./dist/worker.js" },
  companyActivation: { defaultEnabled: false },
  ...(taskFolderCapabilities.includes("local.folders") ? { localFolders: [{
    folderKey: "project-source", displayName: "Project source", access: "readWrite",
    description: "Select this Workspace's project source root. Task path restrictions and separate Git/Runner permissions still apply.",
  }] } : {}),
  tools: [READ_SOLUTION_TOOL, PROPOSE_DESIGN_TOOL, READ_DESIGN_DRAFT_TOOL, READ_DESIGN_SOURCES_TOOL, READ_CONSULTATION_ANALYSIS_TOOL, READ_LEAD_MEMORY_TOOL, UPDATE_LEAD_MEMORY_TOOL, RESOLVE_DESIGN_QUESTION_TOOL, CREATE_CTO_TOOL, LIST_CTOS_TOOL, PUBLISH_DESIGN_BASELINE_TOOL, READ_DESIGN_BASELINE_TOOL, INSPECT_SPEC_ASSURANCE_TOOL, PUBLISH_TECHNOLOGY_DECISIONS_TOOL, READ_TECHNOLOGY_DECISIONS_TOOL,
    PUBLISH_WORKSTREAM_TOOL, READ_WORKSTREAMS_TOOL, READ_CTO_WORKSTREAM_TOOL, ACKNOWLEDGE_WORKSTREAM_TOOL,
    DISPATCH_CTO_WORKSTREAM_TOOL, READ_CTO_WORKSTREAM_DELIVERY_TOOL, CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL,
    READ_CTO_MEMORY_TOOL, UPDATE_CTO_MEMORY_TOOL,
    SUBMIT_CTO_QUESTION_TOOL, READ_CTO_QUESTIONS_TOOL, READ_CTO_INTAKE_TOOL, READ_OWN_CTO_QUESTION_TOOL, REVIEW_CTO_QUESTION_TOOL,
    ANSWER_CTO_QUESTION_TOOL, READ_CTO_QUESTION_ANSWER_TOOL, ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL,
    READ_CTO_TASK_PACKETS_TOOL, PUBLISH_CTO_TASK_PACKET_TOOL, PREPARE_TASK_WORKER_TOOL, READ_TASK_WORKERS_TOOL,
    DISPATCH_TASK_WORKER_TOOL, READ_TASK_SOURCE_FILE_TOOL, WRITE_TASK_SOURCE_FILE_TOOL, DELETE_TASK_SOURCE_FILE_TOOL, SUBMIT_TASK_SOURCE_TOOL,
    READ_TASK_SOURCE_SUBMISSIONS_TOOL, ACCEPT_TASK_SOURCE_SUBMISSION_TOOL,
    REQUEST_PROTECTED_TASK_QA_TOOL, READ_PROTECTED_TASK_QA_TOOL, READ_PROTECTED_TASK_QA_HISTORY_TOOL, PUBLISH_TASK_QA_REPORT_TOOL, VERIFY_WORKSTREAM_TOOL,
    SPEC_ASSURANCE_PACK_PROPOSAL_TOOL, READ_SPEC_ASSURANCE_PACK_TOOL, RECORD_SPEC_GAPS_TOOL, READ_SPEC_GAPS_TOOL,
    PROPOSE_UI_CONTRACT_TOOL, PUBLISH_UI_CONTRACT_TOOL, READ_UI_CONTRACTS_TOOL,
    READ_FIRST_DESIGN_REVIEW_TOOL, PROPOSE_FIRST_DESIGN_REVIEW_TOOL,
    ATTEST_FINAL_PACKET_TOOL, READ_FINAL_REVIEW_TOOL, REQUEST_FINAL_REVIEW_TOOL, READ_CHANGE_IMPACT_TOOL,
    PROPOSE_DELIVERY_DOCUMENTS_TOOL, READ_DELIVERY_DOCUMENTS_TOOL,
    READ_REUSE_CANDIDATES_TOOL, RECORD_REUSE_CANDIDATE_TOOL, PUBLISH_INTEGRATION_PLAN_TOOL,
    READ_VERIFIED_WORKSTREAM_TOOL, INTEGRATE_VERIFIED_TASK_TOOL, READ_INTEGRATION_PROGRESS_TOOL, REQUEST_INTEGRATION_VALIDATION_TOOL,
    PUBLISH_INTEGRATION_PACKET_TOOL],
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
