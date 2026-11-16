import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";
import { readDesignBaseline } from "../design-baseline-tools.ts";
import { readWorkstreams } from "../workstream-tools.ts";
import { parseUiRevision, type UiRevision } from "../ui-contracts/domain.ts";
import { createUiContractStore } from "../ui-contracts/store.ts";
import { createWorkstreamVerificationPublication } from "./workstream-verification-publication.ts";
import { parseDeliverySourcePath } from "../delivery-evidence/source-snapshot.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const BRANCH = /^(?![/.])(?!.*(?:\.\.|\.lock(?:\/|$)|\/\.|\/\/|@\{))[A-Za-z0-9._/-]{1,240}(?<![./])$/u;

export type IntegrationValidationPlan = Readonly<{ approvalTemplateId: string; planSha256: string }>;
export const INTEGRATION_VALIDATION_PHASES = ["ci", "e2e", "regression"] as const;
export type IntegrationValidationPhase = typeof INTEGRATION_VALIDATION_PHASES[number];
export type IntegrationValidationPlans = Readonly<{ ci: IntegrationValidationPlan; e2e: IntegrationValidationPlan;
  regression?: IntegrationValidationPlan }>;

export type IntegrationPlan = Readonly<{
  schemaVersion: 1; revisionId: string; workspaceId: string;
  baselineRevisionId: string; baselineDigest: string; uiRevisionId: string; uiDigest: string;
  sourceId: string; folderKey: string; baseBranch: string; baseCommit: string; baseTree: string; candidateBranch: string;
  validationPlans?: IntegrationValidationPlans;
  validationRequestScope?: "candidate-v2";
  deliveryInventoryPath?: string;
  author: Readonly<{ agentId: string; sessionId: string; runId: string; selectionRevision: number }>;
}>;

function validationPlans(value: unknown): IntegrationValidationPlans {
  const plans = exactToolRecord(value, ["ci", "e2e"], ["regression"]);
  const parse = (input: unknown): IntegrationValidationPlan => {
    const row = exactToolRecord(input, ["approvalTemplateId", "planSha256"]);
    if (typeof row.approvalTemplateId !== "string" || !UUID.test(row.approvalTemplateId)
      || typeof row.planSha256 !== "string" || !SHA.test(row.planSha256)) {
      throw new TypeError("Integration validation requires an exact Host template ID and plan hash.");
    }
    return Object.freeze({ approvalTemplateId: row.approvalTemplateId, planSha256: row.planSha256 });
  };
  return Object.freeze({ ci: parse(plans.ci), e2e: parse(plans.e2e),
    ...(Object.hasOwn(plans, "regression") ? { regression: parse(plans.regression) } : {}) });
}

function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("A bounded integration identifier is required.");
  return value;
}

export function parseIntegrationPlan(value: unknown): IntegrationPlan {
  const row = exactToolRecord(value, ["schemaVersion", "revisionId", "workspaceId", "baselineRevisionId", "baselineDigest",
    "uiRevisionId", "uiDigest", "sourceId", "folderKey", "baseBranch", "baseCommit", "baseTree", "candidateBranch", "author"],
    ["validationPlans", "validationRequestScope", "deliveryInventoryPath"]);
  const author = exactToolRecord(row.author, ["agentId", "sessionId", "runId", "selectionRevision"]);
  if (row.schemaVersion !== 1 || [row.workspaceId, row.sourceId, author.agentId, author.sessionId, author.runId]
    .some(value => typeof value !== "string" || !UUID.test(value))
    || [row.baselineDigest, row.uiDigest].some(value => typeof value !== "string" || !SHA.test(value))
    || [row.baseCommit, row.baseTree].some(value => typeof value !== "string" || !OID.test(value))
    || [row.baseBranch, row.candidateBranch].some(value => typeof value !== "string" || !BRANCH.test(value))
    || row.baseBranch === row.candidateBranch || typeof row.folderKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(row.folderKey)
    || Object.hasOwn(row, "validationRequestScope") && (row.validationRequestScope !== "candidate-v2" || !Object.hasOwn(row, "validationPlans"))
    || !Number.isSafeInteger(author.selectionRevision) || (author.selectionRevision as number) < 0) throw new TypeError("Invalid exact integration plan.");
  const content = { schemaVersion: 1 as const, workspaceId: row.workspaceId as string,
    baselineRevisionId: id(row.baselineRevisionId), baselineDigest: row.baselineDigest as string,
    uiRevisionId: id(row.uiRevisionId), uiDigest: row.uiDigest as string, sourceId: row.sourceId as string,
    folderKey: row.folderKey, baseBranch: row.baseBranch as string, baseCommit: row.baseCommit as string,
    baseTree: row.baseTree as string, candidateBranch: row.candidateBranch as string,
    ...(Object.hasOwn(row, "validationPlans") ? { validationPlans: validationPlans(row.validationPlans) } : {}),
    ...(row.validationRequestScope === "candidate-v2" ? { validationRequestScope: "candidate-v2" as const } : {}),
    ...(Object.hasOwn(row, "deliveryInventoryPath") ? { deliveryInventoryPath: parseDeliverySourcePath(row.deliveryInventoryPath) } : {}),
    author: { agentId: author.agentId as string, sessionId: author.sessionId as string, runId: author.runId as string,
      selectionRevision: author.selectionRevision as number } };
  const revisionId = `integration-plan-v1:${digest(content)}`;
  if (row.revisionId !== revisionId) throw new TypeError("Integration plan digest mismatch.");
  return Object.freeze({ ...content, revisionId, author: Object.freeze(content.author) });
}

export function createIntegrationPlanStore(workspaceId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, workspaceId, state, { prefix: "integration-plan",
    parse(value: unknown) { const plan = parseIntegrationPlan(value); if (plan.workspaceId !== workspaceId) throw new Error("Foreign integration plan."); return plan; },
    revisionId: value => value.revisionId });
}
export const readCurrentIntegrationPlan = (workspaceId: string, platform: SpsPlatformInvocationContext) =>
  createIntegrationPlanStore(workspaceId, platform.state).current();

function formalUi(workspaceId: string, state: RevisionState) {
  return createRevisionJournal<UiRevision>(workspaceId, workspaceId, state, { prefix: "ui-contracts",
    parse: value => parseUiRevision(value, workspaceId), revisionId: value => value.revisionId });
}

export async function checkIntegrationPrerequisites(workspaceId: string, workstreamId: string, platform: SpsPlatformInvocationContext) {
  try {
    const plan = await readCurrentIntegrationPlan(workspaceId, platform);
    if (!plan) return { status: "unknown" as const, reason: "main-integration-plan-unavailable" };
    const baseline = await readDesignBaseline(workspaceId, workspaceId, platform), ui = await formalUi(workspaceId, platform.state).current();
    if (!baseline || baseline.revision.revisionId !== plan.revision.baselineRevisionId || digest(baseline.revision) !== plan.revision.baselineDigest
      || !ui || ui.revision.revisionId !== plan.revision.uiRevisionId || digest(ui.revision) !== plan.revision.uiDigest) {
      return { status: "unknown" as const, reason: "integration-plan-design-or-ui-changed" };
    }
    const board = await readWorkstreams(workspaceId, workspaceId, platform);
    const workstream = board?.revision.workstreams.find(row => row.spec.id === workstreamId);
    if (!workstream || workstream.sourceBaselineRevisionId !== plan.revision.baselineRevisionId || workstream.baselineDigest !== plan.revision.baselineDigest) {
      return { status: "unknown" as const, reason: "integration-workstream-not-current" };
    }
    // A verified dependency is eligible for independent candidate integration;
    // it is not a claim that its Git/CI integration has finished.
    const publication = createWorkstreamVerificationPublication(platform.state as typeof platform.state & RevisionState);
    for (const dependencyId of workstream.spec.dependencies) {
      const dependency = board!.revision.workstreams.find(row => row.spec.id === dependencyId);
      if (!dependency) return { status: "waiting-dependencies" as const, reason: "integration-dependency-instruction-unavailable" };
      const read = await publication.readLatestCurrent({ workspaceId, projectId: workspaceId, workstreamId: dependencyId });
      if (read.status !== "current") return { status: "waiting-dependencies" as const, reason: "integration-dependency-evidence-not-current" };
    }
    return { status: "ready" as const };
  } catch { return { status: "unknown" as const, reason: "integration-prerequisite-read-unavailable" }; }
}

/** Main approves workflow scope; the Host's separate Git and execution grants
 * remain necessary for every technical effect. No AI run starts here. */
export async function publishIntegrationPlan(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["expectedBaseRevisionId", "sourceId", "folderKey", "baseBranch", "baseCommit", "candidateBranch"],
    ["validationPlans", "deliveryInventoryPath"]);
  const selectedValidation = Object.hasOwn(input, "validationPlans") ? validationPlans(input.validationPlans) : undefined;
  const deliveryInventoryPath = Object.hasOwn(input, "deliveryInventoryPath") ? parseDeliverySourcePath(input.deliveryInventoryPath) : undefined;
  const context = parseLeadToolContext(runContext), authority = await resolveLeadToolAuthority(context, platform);
  requireLeadFormalPublicationAuthority(authority);
  if (context.projectId !== undefined && context.projectId !== context.companyId) throw new Error("Integration plan requires this Workspace project.");
  const baseline = await readDesignBaseline(context.companyId, context.companyId, platform);
  const ui = await createUiContractStore(context.companyId, context.companyId, platform.state).currentFormal(runContext, platform);
  if (!baseline || !ui || ui.revision.source.kind !== "baseline" || ui.revision.source.revisionId !== baseline.revision.revisionId) {
    throw new Error("An exact current Main Baseline and formal approved UI Contract are required.");
  }
  const folders = platform as typeof platform & { localFolders?: { matchWorkspaceSourceV1?: (folder: string, source: string) => Promise<unknown>;
    readWorkspaceSourceGitTipV1?: (source: string, folder: string, branch: string) => Promise<unknown> } };
  if (typeof folders.localFolders?.matchWorkspaceSourceV1 !== "function" || typeof folders.localFolders.readWorkspaceSourceGitTipV1 !== "function") {
    return { status: "unsupported" as const, reason: "integration-source-proof-unavailable" };
  }
  const sourceId = id(input.sourceId), folderKey = id(input.folderKey), baseBranch = id(input.baseBranch), candidateBranch = id(input.candidateBranch);
  const root = exactToolRecord(await folders.localFolders.matchWorkspaceSourceV1(folderKey, sourceId), ["folderKey", "workspaceSourceId", "match"]);
  const tip = exactToolRecord(await folders.localFolders.readWorkspaceSourceGitTipV1(sourceId, folderKey, baseBranch),
    ["status", "sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt"]);
  if (root.folderKey !== folderKey || root.workspaceSourceId !== sourceId || root.match !== "same_root"
    || tip.status !== "current" || tip.sourceId !== sourceId || tip.folderKey !== folderKey || tip.branch !== baseBranch || tip.commitSha !== input.baseCommit) {
    throw new Error("The exact authorized integration Source and base branch head must be current.");
  }
  const content = { schemaVersion: 1 as const, workspaceId: context.companyId, baselineRevisionId: baseline.revision.revisionId,
    baselineDigest: digest(baseline.revision), uiRevisionId: ui.revision.revisionId, uiDigest: digest(ui.revision), sourceId, folderKey,
    baseBranch, baseCommit: tip.commitSha, baseTree: tip.treeSha, candidateBranch,
    ...(selectedValidation ? { validationPlans: selectedValidation, validationRequestScope: "candidate-v2" as const } : {}),
    ...(deliveryInventoryPath ? { deliveryInventoryPath } : {}),
    author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId, selectionRevision: authority.selectionRevision } };
  const plan = parseIntegrationPlan({ ...content, revisionId: `integration-plan-v1:${digest(content)}` });
  const store = createIntegrationPlanStore(context.companyId, platform.state);
  const expected = input.expectedBaseRevisionId === null ? null : id(input.expectedBaseRevisionId);
  await authority.check();
  const current = await readDesignBaseline(context.companyId, context.companyId, platform);
  const currentUi = await createUiContractStore(context.companyId, context.companyId, platform.state).currentFormal(runContext, platform);
  if (digest(current?.revision) !== plan.baselineDigest || digest(currentUi?.revision) !== plan.uiDigest) throw new Error("Integration design changed before publication.");
  const result = await store.publish({ expectedBaseRevisionId: expected, revision: plan });
  await authority.check();
  return { ...result, executionStarted: false, technicalAuthority: "separate-host-grants-required" as const };
}
