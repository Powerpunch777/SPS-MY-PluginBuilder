import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { runAcceptance as baselineAcceptance } from "./core-host-acceptance.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await pause(300);
  }
  throw new Error(`Live design acceptance did not observe ${label}.`);
}

// Explicitly authorized operator only. No arbitrary code, shell, user profile
// changes or provider substitution; real account usage is never the default.
export async function runDesignAcceptance(context, questionAnswers = false, ctoRegistrations = false, recordBaseline = false, workstreamDelivery = false) {
  assert.equal(process.env.SPS_BUILDER_LIVE_CODEX, "1");
  assert.ok([questionAnswers, ctoRegistrations, recordBaseline, workstreamDelivery].filter(Boolean).length <= 1);
  const selectedOptIn = workstreamDelivery ? "SPS_BUILDER_LIVE_WORKSTREAMS" : recordBaseline ? "SPS_BUILDER_LIVE_BASELINE" : ctoRegistrations ? "SPS_BUILDER_LIVE_CTOS"
    : questionAnswers ? "SPS_BUILDER_LIVE_QUESTION" : "SPS_BUILDER_LIVE_DESIGN";
  assert.equal(process.env[selectedOptIn], "1");
  for (const key of ["SPS_BUILDER_LIVE_BASELINE", "SPS_BUILDER_LIVE_CTOS", "SPS_BUILDER_LIVE_QUESTION", "SPS_BUILDER_LIVE_DESIGN",
    "SPS_BUILDER_LIVE_MEMORY", "SPS_BUILDER_LIVE_CANCEL", "SPS_BUILDER_LIVE_WORKSTREAMS"]) if (key !== selectedOptIn) assert.ok(!process.env[key]);
  assert.ok(!process.env.OPENAI_API_KEY && !process.env.PAPERCLIP_CODEX_PROVIDERS);
  const baseline = await baselineAcceptance(context);
  let workspace = baseline.workspace;
  const { plugin } = baseline;
  const { company, secondCompany, api, click, restart, temporaryRoot, captureScreenshot, screenshotPath } = context;
  const request = (url, options) => api(workspace, url, options);
  const stage = value => console.log(JSON.stringify({ liveDesignStage: value }));
  const workingDirectory = path.join(temporaryRoot, "live-lead-design");
  await mkdir(workingDirectory);
  const sourceText = "Design-only trial: a read-only list of notes in a desktop application. Keep note content local. Ask whether a search field is needed. Do not implement or execute anything. This is not customer approval.";
  const sourceRequestId = randomUUID();
  await request(`/api/plugins/${plugin.id}/actions/builder.import-consultation`, { method: "POST", body: {
    companyId: company.id, params: { requestId: sourceRequestId, text: sourceText },
  } });
  const sourceId = `consultation-${sourceRequestId}`;
  const beforeOther = (await request(`/api/plugins/${plugin.id}/data/builder.snapshot`, {
    method: "POST", body: { companyId: secondCompany.id, params: {} },
  })).data;
  stage("create_isolated_tool_only_lead");
  const agent = await request(`/api/companies/${company.id}/agents`, { method: "POST", body: {
    name: "Isolated authorized design Lead", role: "engineer", adapterType: "codex_local",
    adapterConfig: { engine: "cli", cwd: workingDirectory, timeoutSec: 180, graceSec: 3,
      dangerouslyBypassApprovalsAndSandbox: false },
    instructionsBundle: { files: { "AGENTS.md": `Authorized design-only test. Use only the sps-plugin-session MCP list_plugin_tools and execute_plugin_tool tools, and only Builder read-design-sources, read-design-draft, propose-design${questionAnswers ? " and resolve-design-question" : ctoRegistrations ? ", create-cto and list-ctos (logical identity/session registration only, never execution)" : recordBaseline ? ", read-design-baseline, publish-design-baseline and read-solution (internal design decision record only)" : workstreamDelivery ? ", read-design-baseline, publish-design-baseline, read-solution, read-technology-decisions, publish-technology-decisions, create-cto, list-ctos, read-workstreams, publish-workstream and dispatch-workstream (Lead planning only); in the independent registered CTO session, only read-cto-memory, update-cto-memory, read-cto-workstream and acknowledge-workstream for the exact Core-bound assignment (private bounded planning notes, never other actors' memory or credentials)" : ""} operations. In workstream mode, follow the role in the current run message: Lead only in the prepared Lead session, CTO only in its registered independent session. Core's per-session tool policy is authoritative. Never run commands, edit/read files, generate code, search the web, create Core Agents or contact other services. Prepare only an unapproved draft from user input unless the user explicitly provides a planning decision to record as an internal baseline. A write with an unknown outcome must not be retried; reconcile it by reading. Do not claim external legal approval, implementation or delivery.` } },
  } });
  const data = (key, params = {}, companyId = company.id) => request(`/api/plugins/${plugin.id}/data/${key}`, {
    method: "POST", body: { companyId, params },
  }).then(value => value.data);
  const sessions = () => data("builder.lead-sessions");
  const conversation = () => data("builder.lead-conversation", { channel: "main", cursor: null });
  const draft = () => data("builder.design-draft", { projectId: company.id });
  await workspace.command("Page.bringToFront");
  await click(workspace, '.builder-nav [aria-label="시스템"]', "Open isolated Lead selection");
  await click(workspace, '[aria-label="Workspace 새로고침"]', "Refresh isolated Agent choices");
  await eventually(() => workspace.evaluate(`Boolean(document.querySelector('select[aria-label="Lead Agent"] option[value="${agent.id}"]'))`), Boolean, "temporary Agent choice");
  await workspace.evaluate(`(() => {const select=document.querySelector('select[aria-label="Lead Agent"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(agent.id)});
    select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('section[aria-labelledby="lead-agent-settings-title"] button[type="submit"]')?.disabled === false`), Boolean, "selection readiness");
  await click(workspace, 'section[aria-labelledby="lead-agent-settings-title"] button', "Select trial Lead");
  await eventually(() => data("builder.lead-agents"), value => value.selectedAgentId === agent.id, "saved Lead selection");
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="Lead 세션 준비 및 확인"]')?.disabled === false`), Boolean, "session preparation readiness");
  await click(workspace, '[aria-label="Lead 세션 준비 및 확인"]', "Prepare current Lead sessions");
  const prepared = await eventually(sessions, value => value.agentId === agent.id && Object.values(value.sessions).every(Boolean), "three prepared sessions");
  assert.equal(await draft(), null);
  await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Open tool-only Lead chat");
  const text = `Design-only request for Builder project ${company.id}. Discover the available Builder tools using list_plugin_tools. Read the latest consultation source with read-design-sources and read the current draft with read-design-draft. Derive a small requirements/Graph draft and one question with options about search from the consultation. Store it using propose-design, citing the exact consultation source ID returned by the tool (not this chat). Use a new revision ID, at least one requirement and one Graph entity linked by specRef, a nonempty acceptanceCriteriaIds list, target desktop, productTier S and dataPolicyRef unreviewed-local-policy. Do not add any approval fields. This is only a draft, not execution. If no current draft exists use expectedBaseRevisionId null. Do not repeat the write after an uncertain response. Read the stored draft back, then respond exactly SPS_LEAD_DESIGN_DRAFT_OK. Do not use any other tools, generate code or run commands.`;
  await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled === false`), Boolean, "message readiness");
  await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});
    field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('[aria-label="메시지 보내기"]')?.disabled === false`), Boolean, "send readiness");
  stage("send_one_design_request");
  await click(workspace, '[aria-label="메시지 보내기"]', "Send one explicitly authorized design-tool request");
  let status = null;
  const finished = await eventually(async () => {
    const page = await conversation();
    if (page.active?.runId) {
      const run = await request(`/api/heartbeat-runs/${page.active.runId}`);
      if (run.status !== status) {
        status = run.status;
        console.log(JSON.stringify({ liveDesignRunStatus: status, errorCode: run.errorCode ?? null }));
      }
      await request(`/api/plugins/${plugin.id}/actions/builder.refresh-lead-conversation`, { method: "POST", body: {
        companyId: company.id, params: { channel: "main" },
      } });
    }
    return conversation();
  }, value => value.totalTurns === 1 && value.active === null, "terminal provider response", 240_000);
  const turn = finished.turns[0];
  assert.equal(turn.state, "succeeded", "The actual provider must succeed; do not create a replacement request.");
  const log = await request(`/api/heartbeat-runs/${turn.runId}/log?offset=0&limitBytes=1048576`);
  assert.equal(log.nextOffset, undefined, "The full short log is required to check tool scope.");
  const stdout = log.content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.stream === "stdout").map(event => event.chunk).join("");
  const items = stdout.split(/\r?\n/).filter(line => line.trim().startsWith("{"))
    .map(line => JSON.parse(line)).filter(event => event.type === "item.completed" && event.item).map(event => event.item);
  assert.ok(items.length > 0);
  assert.ok(items.every(item => ["agent_message", "reasoning", "mcp_tool_call"].includes(item.type)),
    "Commands, code edits, web searches and other tools are forbidden in this trial.");
  const calls = items.filter(item => item.type === "mcp_tool_call");
  console.log(JSON.stringify({ liveDesignToolCalls: calls.map(call => ({ server: call.server,
    tool: call.tool, status: call.status, operation: call.arguments?.toolName ?? null,
    error: typeof call.error?.message === "string" ? call.error.message.slice(0, 180) : null,
    resultIsError: call.result?.isError ?? null })) }));
  assert.equal(turn.answer?.trim(), "SPS_LEAD_DESIGN_DRAFT_OK");
  assert.ok(calls.length >= 5, "Inventory, sources, draft read, write and read-back must be observed.");
  const prefix = "com.sonparkserver.my-plugin-builder:";
  const allowed = ["builder.read-design-sources", "builder.read-design-draft", "builder.propose-design"].map(name => prefix + name);
  for (const call of calls) {
    assert.equal(call.server, "sps-plugin-session");
    assert.ok(["list_plugin_tools", "execute_plugin_tool"].includes(call.tool));
    assert.equal(call.status, "completed");
    if (call.tool === "execute_plugin_tool") assert.ok(allowed.includes(call.arguments?.toolName));
  }
  const executed = calls.filter(call => call.tool === "execute_plugin_tool");
  assert.equal(executed.filter(call => call.arguments.toolName === prefix + "builder.propose-design").length, 1,
    "The write must not be repeated.");
  assert.ok(executed.some(call => call.arguments.toolName === prefix + "builder.read-design-sources"));
  const saved = await draft();
  assert.equal(saved.workspaceId, company.id);
  assert.equal(saved.projectId, company.id);
  assert.equal(saved.agentId, agent.id);
  assert.equal(saved.selectionRevision, prepared.selectionRevision);
  assert.deepEqual(saved.draft.sourceIds, [sourceId]);
  assert.ok(saved.draft.specification.requirements.length >= 1);
  assert.ok(saved.draft.graph.entities.some(entity => entity.specRef));
  assert.equal(saved.draft.questions.length, 1);
  assert.equal(Object.hasOwn(saved.draft.specification, "approvalEvidenceRef"), false);
  assert.equal(await data("builder.design-draft", { projectId: company.id }, secondCompany.id), null);
  assert.deepEqual(await data("builder.snapshot", {}, secondCompany.id), beforeOther);
  assert.deepEqual(await readdir(workingDirectory), [], "The tool-only Lead must not create project files.");
  await click(workspace, '[aria-label="Workspace 새로고침"]', "Render the actual stored AI draft");
  const summaryVisible = () => workspace.evaluate(`document.querySelector('[aria-label="Lead 설계 초안"]')?.textContent.includes(${JSON.stringify(saved.draft.revisionId)})`);
  await eventually(summaryVisible, Boolean, "real persisted draft in UI");
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-live-design.png"));
  stage("restart_and_verify_same_draft");
  workspace = await restart({ companyPrefix: company.issuePrefix, pluginId: plugin.id, readySelector: ".builder-shell" });
  assert.deepEqual(await draft(), saved);
  assert.deepEqual(await conversation(), finished);
  await eventually(summaryVisible, Boolean, "persisted real draft after restart");
  assert.equal((await request(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=100`)).length, 1);
  assert.deepEqual((await request(`/api/agents/${agent.id}`)).adapterConfig, agent.adapterConfig);
  assert.deepEqual(await readdir(workingDirectory), []);
  console.log(JSON.stringify({ liveLeadDesign: true, aiExecuted: true, actualUiSend: true,
    actualProviderSucceeded: true, liveLeadToolInvoked: true, realHostDraftWritten: true,
    restartRetainedDraft: true, otherWorkspaceUnchanged: true, writeCalls: 1,
    commandsOrCodeExecuted: false, installedProfileChanged: false,
    draftSha256: createHash("sha256").update(JSON.stringify(saved.draft)).digest("hex"), cleanupQualificationPending: true }));
  return { workspace, plugin, agent, prepared, saved, draft: saved, sourceId, beforeOther, workingDirectory, mainConversation: finished };
}

export async function runAcceptance(context) { await runDesignAcceptance(context); }
