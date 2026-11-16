import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { runDesignAcceptance } from "./live-design-acceptance.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prefix = "com.sonparkserver.my-plugin-builder:builder.";
async function eventually(read, check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await pause(300);
  }
  throw new Error(`Live design baseline did not observe ${label}.`);
}

export function summarizeScopedToolCalls(calls) {
  return calls.map(call => ({ server: call.server, tool: call.tool, status: call.status,
    operation: call.arguments?.toolName ?? null,
    error: typeof call.error?.message === "string" ? call.error.message
      .replace(/(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{48,})/gu, "[redacted]")
      .replace(/((?:authorization|token|secret|password|api[_ -]?key)\s*[:=]\s*)\S+/giu, "$1[redacted]").slice(0, 600) : null,
    resultIsError: call.result?.isError ?? null,
  }));
}

async function assertScopedTurn(request, turn, sessionId, answer, requiredTools, writeTool, inspectResult) {
  assert.equal(turn.state, "succeeded", "Do not replace failed or uncertain provider calls.");
  assert.equal(turn.answer?.trim(), answer);
  assert.equal(turn.sessionId, sessionId);
  assert.ok(turn.runId);
  const log = await request(`/api/heartbeat-runs/${turn.runId}/log?offset=0&limitBytes=1048576`);
  assert.equal(log.nextOffset, undefined);
  const stdout = log.content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.stream === "stdout").map(event => event.chunk).join("");
  const items = stdout.split(/\r?\n/).filter(line => line.trim().startsWith("{"))
    .map(line => JSON.parse(line)).filter(event => event.type === "item.completed" && event.item).map(event => event.item);
  assert.ok(items.length > 0 && items.every(item => ["agent_message", "reasoning", "mcp_tool_call"].includes(item.type)));
  const calls = items.filter(item => item.type === "mcp_tool_call");
  console.log(JSON.stringify({ liveBaselineToolCalls: summarizeScopedToolCalls(calls) }));
  assert.ok(calls.some(call => call.tool === "list_plugin_tools"));
  for (const call of calls) {
    assert.equal(call.server, "sps-plugin-session");
    assert.ok(["list_plugin_tools", "execute_plugin_tool"].includes(call.tool));
    assert.equal(call.status, "completed");
    assert.ok(!call.error && call.result?.isError !== true);
    if (call.tool === "execute_plugin_tool") assert.ok(requiredTools.some(name => call.arguments?.toolName === prefix + name));
  }
  for (const name of requiredTools) assert.ok(calls.some(call => call.arguments?.toolName === prefix + name));
  const writes = calls.filter(call => call.arguments?.toolName === prefix + writeTool);
  assert.equal(writes.length, 1);
  if (inspectResult) inspectResult(writes[0].result);
  const parameters = writes[0].arguments.parameters ?? writes[0].arguments.params;
  assert.ok(parameters && typeof parameters === "object" && !Array.isArray(parameters));
  return parameters;
}

// Explicitly authorized internal planning trial; not a customer signature or execution approval.
export async function runBaselineAcceptance(context, workstreamDelivery = false) {
  assert.equal(process.env.SPS_BUILDER_LIVE_CODEX, "1");
  const designModelReview = process.env.SPS_BUILDER_LIVE_D3 === "1";
  assert.ok(!designModelReview || !workstreamDelivery, "D3 is a separate initial-review trial, not a Workstream execution trial.");
  const selectedOptIn = workstreamDelivery ? "SPS_BUILDER_LIVE_WORKSTREAMS" : "SPS_BUILDER_LIVE_BASELINE";
  assert.equal(process.env[selectedOptIn], "1");
  for (const name of ["SPS_BUILDER_LIVE_DESIGN", "SPS_BUILDER_LIVE_QUESTION", "SPS_BUILDER_LIVE_MEMORY",
    "SPS_BUILDER_LIVE_CTOS", "SPS_BUILDER_LIVE_CANCEL", "SPS_BUILDER_LIVE_BASELINE", "SPS_BUILDER_LIVE_WORKSTREAMS",
    "OPENAI_API_KEY", "PAPERCLIP_CODEX_PROVIDERS"]) if (name !== selectedOptIn) assert.ok(!process.env[name]);
  const before = await runDesignAcceptance(context, false, false, !workstreamDelivery, workstreamDelivery);
  let { workspace } = before;
  const { plugin, agent, saved, prepared, workingDirectory, beforeOther, sourceId, sourceText } = before;
  const { company, secondCompany, api, click, restart, captureScreenshot, screenshotPath } = context;
  const request = (url, options) => api(workspace, url, options);
  const data = (key, params = {}, companyId = company.id) => request(`/api/plugins/${plugin.id}/data/${key}`, {
    method: "POST", body: { companyId, params },
  }).then(reply => reply.data);
  const baseline = () => data("builder.design-baseline", { projectId: company.id });
  const review = () => data("builder.first-design-review");
  const conversation = () => data("builder.lead-conversation", { channel: "main", cursor: null });
  const runs = () => request(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=100`);
  assert.equal(await baseline(), null);
  assert.deepEqual(await review(), { status: "empty" });
  await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Open actual Main for first design review");
  async function sendOnce(message, totalTurns, label) {
    assert.equal((await conversation()).totalTurns, totalTurns - 1);
    await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled===false`), Boolean, label + " composer");
    await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(message)});
      field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="메시지 보내기"]')?.disabled===false`), Boolean, label + " send readiness");
    await click(workspace, 'button[aria-label="메시지 보내기"]', label);
    return eventually(async () => {
      const page = await conversation();
      if (page.active?.runId) await request(`/api/plugins/${plugin.id}/actions/builder.refresh-lead-conversation`, {
        method: "POST", body: { companyId: company.id, params: { channel: "main" } },
      });
      return conversation();
    }, value => value.totalTurns === totalTurns && value.active === null, "terminal " + label, 240_000);
  }

  const requirements = saved.draft.specification.requirements;
  const acSources = requirements.flatMap(requirement => requirement.acceptanceCriteriaIds.map(acId => ({
    requirementId: requirement.id, acId, sourceId,
  })));
  const trialModel = {
    facts: ["trial-read-only-local"], rulesVersion: "trial-static-model-1",
    coverageRules: [{ id: "trial-review-check", requiresCheck: true, requiredEvidenceKinds: ["specification", "source"] }],
    coverageTargets: [...requirements.map(requirement => ({ targetKind: "requirement", targetId: requirement.id, ruleIds: ["trial-review-check"] })),
      ...[...new Set(acSources.map(item => item.acId))].map(acId => ({ targetKind: "ac", targetId: acId, ruleIds: ["trial-review-check"] }))],
    scenarios: [], itemDecisions: requirements.map(requirement => ({ requirementId: requirement.id, status: "UNDECIDED",
      reason: "This trial preserves unresolved design decisions and establishes no runtime or QA result.", sourceIds: [] })),
    acceptanceCriteria: acSources.map(item => ({ ...item, quote: sourceText })),
  };
  const modelInstruction = designModelReview
    ? ` Also add these exact AC sourcePins: ${JSON.stringify(acSources)}. Include this exact static designModel: ${JSON.stringify(trialModel)}. Do not resolve the UNDECIDED items or claim their checker/QA passed.` : "";
  const propose = await sendOnce(`For the isolated design trial, prepare a first-design review, not approval or publication. Discover tools, read current draft and review head. Then call builder.propose-first-design-review exactly once for projectId ${company.id}, expectedDraftRevisionId ${saved.draft.revisionId}, expectedReviewHeadRevisionId null. Use packId trial-first-design, version 1.0.0, empty applicability, and a rule trial-review-check with appliesWhen {}, requiresCheck true, and every requirement ID from the stored draft. Use empty transitions, exceptions and excludedCombinations. In sourcePins link every requirement to its exact captured consultation source ${sourceId}, with acId null, and do not provide a digest or identity.${modelInstruction} Read back builder.read-first-design-review. Leave the draft and open search question unchanged. Use only these tools. Do not publish a Baseline or approve. Do not repeat an uncertain write. Respond exactly SPS_FIRST_REVIEW_PROPOSED.`, 2, "Propose exact first-design review");
  const proposalTurn = propose.turns[0];
  const proposalArgs = await assertScopedTurn(request, proposalTurn, prepared.sessions.main, "SPS_FIRST_REVIEW_PROPOSED",
    ["read-design-draft", "read-first-design-review", "propose-first-design-review"], "propose-first-design-review");
  assert.equal(proposalArgs.expectedDraftRevisionId, saved.draft.revisionId);
  const proposal = await review();
  assert.equal(proposal.status, "ready");
  assert.equal(proposal.bundle.status, "PROPOSED");
  assert.equal(proposal.bundle.author.runId, proposalTurn.runId);
  assert.equal(proposal.bundle.draftDigest, sha(saved.draft));
  assert.equal(proposal.bundle.pack.packId, "trial-first-design");
  assert.equal(proposal.bundle.pack.version, "1.0.0");
  const sourceDigest = createHash("sha256").update(sourceText, "utf8").digest("hex");
  for (const requirement of saved.draft.specification.requirements) {
    assert.ok(proposal.bundle.sourcePins.some(pin => pin.requirementId === requirement.id && pin.sourceId === sourceId && pin.sourceDigest === sourceDigest));
  }
  if (designModelReview) {
    assert.equal(proposal.bundle.designModel.kind, "design-model-v1");
    assert.deepEqual(proposal.bundle.designModel.facts, trialModel.facts);
    assert.deepEqual(proposal.bundle.designModel.itemDecisions, trialModel.itemDecisions);
    assert.equal(proposal.bundle.designModel.acceptanceCriteria.length, acSources.length);
    for (const ac of proposal.bundle.designModel.acceptanceCriteria) {
      assert.equal(ac.sourceId, sourceId);
      assert.equal(ac.sourceDigest, sourceDigest);
      assert.equal(ac.text, sourceText);
      assert.equal(ac.textSha256, sourceDigest);
    }
  }
  assert.equal(await baseline(), null);
  assert.equal((await runs()).length, 2);
  await click(workspace, ".builder-first-design-review > summary", "Show exact review to the authenticated trial user");
  await eventually(() => workspace.evaluate(`document.querySelector('.sps-fdr')?.textContent`),
    value => value?.includes(saved.draft.revisionId) && value.includes(sourceId) && value.includes("trial-first-design @ 1.0.0"),
    "rendered exact draft, source and pack");
  await eventually(() => workspace.evaluate(`document.querySelector('.sps-fdr-actions button')?.disabled===false`), Boolean, "user approval readiness");
  await click(workspace, ".sps-fdr-actions button", "Approve only the displayed first-design version as the trial user");
  const approved = await eventually(review, value => value.status === "ready" && value.bundle.status === "APPROVED", "stored user approval");
  assert.equal(approved.bundle.approval.attestedBundleRevisionId, proposal.bundle.revisionId);
  assert.ok(approved.bundle.approval.userId);
  assert.notEqual(approved.bundle.revisionId, proposal.bundle.revisionId);
  for (const field of ["draft", "draftDigest", "pack", "sourcePins"]) assert.deepEqual(approved.bundle[field], proposal.bundle[field]);
  if (designModelReview) assert.deepEqual(approved.bundle.designModel, proposal.bundle.designModel);
  assert.equal(await baseline(), null, "The user action is not formal publication.");
  assert.equal((await runs()).length, 2, "Approval does not start a new model turn.");

  const approvalRef = `first-design-review:${approved.bundle.revisionId}`;
  const completed = await sendOnce(`For this isolated planning trial, publish the exact already approved internal design. Discover tools and read current draft, review approval and Baseline. Use builder.publish-design-baseline exactly once with projectId ${company.id}, sourceDraftRevisionId ${saved.draft.revisionId}, revisionId trial-baseline-1, expectedBaseRevisionId null and userSourceId ${approvalRef}. In interpretation note that this is the exact user-approved trial design; the search question remains open. Do not cite this chat as approval or change any draft content. Read back the Baseline and builder.read-solution. Respond exactly SPS_DESIGN_BASELINE_OK. Only these tools are allowed. Do not write files, execute commands, implement or deploy. Reconcile an uncertain write by reading only.`, 3, "Publish exact approved first Baseline");
  const turn = completed.turns[0];
  const publishArgs = await assertScopedTurn(request, turn, prepared.sessions.main, "SPS_DESIGN_BASELINE_OK",
    ["read-design-draft", "read-first-design-review", "read-design-baseline", "publish-design-baseline", "read-solution"], "publish-design-baseline");
  assert.equal(publishArgs.userSourceId, approvalRef);
  const stored = await baseline();
  assert.equal(stored.sequence, 1);
  assert.equal(stored.baseline.revisionId, "trial-baseline-1");
  assert.equal(stored.baseline.sourceDraftRevisionId, saved.draft.revisionId);
  assert.equal(stored.baseline.userDecision.sourceId, approvalRef);
  assert.equal(stored.baseline.userDecision.sourceSha256, sha(approved.bundle));
  assert.equal(stored.baseline.author.runId, turn.runId);
  assert.deepEqual(stored.baseline.specification.requirements, saved.draft.specification.requirements);
  assert.deepEqual(stored.baseline.graph.entities, saved.draft.graph.entities);
  assert.equal(stored.baseline.graph.approvedSpecRevisionId, stored.baseline.specification.revisionId);
  assert.equal(stored.baseline.specification.approvalEvidenceRef, approvalRef);
  assert.deepEqual(await data("builder.design-draft", { projectId: company.id }), saved);
  assert.equal(await data("builder.design-baseline", { projectId: company.id }, secondCompany.id), null);
  assert.deepEqual(await data("builder.snapshot", {}, secondCompany.id), beforeOther);
  let finalConversation = completed;
  let inspectionTurn = null;
  if (designModelReview) {
    finalConversation = await sendOnce(`Read-only D3 inspection for the current trial project ${company.id}. Discover tools and invoke builder.inspect-spec-assurance exactly once with projectId ${company.id}. Do not write, approve, resolve questions, execute tests or claim QA. The approved model deliberately retains UNDECIDED items, so UNKNOWN is expected. Respond exactly SPS_D3_APPROVED_MODEL_OBSERVED.`, 4, "Inspect the actually approved static model");
    inspectionTurn = finalConversation.turns[0];
    await assertScopedTurn(request, inspectionTurn, prepared.sessions.main, "SPS_D3_APPROVED_MODEL_OBSERVED",
      ["inspect-spec-assurance"], "inspect-spec-assurance", result => {
        const textBlocks = result?.content?.filter(block => block.type === "text");
        assert.equal(textBlocks?.length, 1, "The actual MCP result must contain one serialized tool response.");
        const response = JSON.parse(textBlocks[0].text);
        const assurance = response.data?.result;
        assert.equal(assurance?.coverageAuthority, "verified");
        assert.equal(assurance.status, "UNKNOWN", "Unresolved trial decisions cannot be promoted to completion.");
        assert.equal(assurance.identity.specRevisionId, stored.baseline.specification.revisionId);
        assert.deepEqual(assurance.designModelEvidence, { kind: "design-model-v1", approvalRevisionId: approved.bundle.revisionId,
          materialSha256: sha(approved.bundle.designModel) });
        assert.ok(assurance.itemDecisions.length === requirements.length && assurance.itemDecisions.every(item => item.status === "UNDECIDED"));
        assert.ok(assurance.sourceEvidence.some(item => item.sourceId === sourceId && item.sourceDigest === sourceDigest));
      });
    assert.deepEqual(await baseline(), stored, "Inspection must not change the published Baseline.");
    assert.deepEqual(await review(), approved, "Inspection must not change the user's approved bundle.");
  }
  await click(workspace, '[aria-label="Workspace 새로고침"]', "Refresh the actual stored internal baseline document");
  await click(workspace, '.builder-nav [aria-label="설계 문서"]', "Inspect actual baseline record without execution controls");
  const publishedDocument = await data("builder.baseline-document");
  assert.equal(publishedDocument.read.source, "current");
  assert.equal(publishedDocument.read.document.sourceBaselineRevisionId, stored.baseline.revisionId);
  assert.equal(publishedDocument.read.document.bodySha256, createHash("sha256").update(publishedDocument.read.document.body).digest("hex"));
  await eventually(() => workspace.evaluate(`Boolean([...document.querySelectorAll('.sps-dc-item')].find(node=>node.textContent.includes('통합 설계 기준선')))`), Boolean, "canonical baseline document button");
  await workspace.evaluate(`[...document.querySelectorAll('.sps-dc-item')].find(node=>node.textContent.includes('통합 설계 기준선')).click()`);
  await eventually(() => workspace.evaluate(`document.querySelector('.sps-dc-body')?.textContent`),
    value => value === publishedDocument.read.document.body, "exact published baseline document body");
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-live-baseline.png"));
  workspace = await restart({ companyPrefix: company.issuePrefix, pluginId: plugin.id, readySelector: ".builder-shell" });
  assert.deepEqual(await baseline(), stored);
  assert.deepEqual(await review(), approved);
  assert.deepEqual(await conversation(), finalConversation);
  assert.equal((await runs()).length, designModelReview ? 4 : 3);
  assert.equal((await request(`/api/agents/${agent.id}/task-sessions`)).length, 6);
  assert.deepEqual((await request(`/api/agents/${agent.id}`)).adapterConfig, agent.adapterConfig);
  assert.deepEqual(await readdir(workingDirectory), []);
  console.log(JSON.stringify({ liveDesignBaseline: true, actualUiDecision: true, actualLeadRuns: designModelReview ? 4 : 3,
    approvedStaticModelObserved: designModelReview, unresolvedDesignRetained: designModelReview,
    baselineWriteCalls: 1, exactApprovedBundleBound: true, approvalStartedNoRun: true, pinnedSpecificationAndGraph: true, sourceDraftUnchanged: true,
    restartRetained: true, otherWorkspaceUnchanged: true, legalApprovalVerified: false, executionAuthorized: false,
    commandsOrCodeExecuted: false, actualGoogleOauth: false, installedProfileChanged: false,
    baselineDtoSha256: sha(stored), cleanupQualificationPending: true }));
  return { workspace, plugin, agent, prepared, draft: saved, baseline: stored, beforeOther, workingDirectory,
    mainConversation: finalConversation, leadRuns: [before.mainConversation.turns[0], proposalTurn, turn, ...(inspectionTurn ? [inspectionTurn] : [])] };
}

export async function runAcceptance(context) { await runBaselineAcceptance(context); }
