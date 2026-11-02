import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { runDesignAcceptance } from "./live-design-acceptance.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function eventually(read, check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await pause(300);
  }
  throw new Error(`Live design baseline did not observe ${label}.`);
}

// Explicitly authorized internal planning trial; not a customer signature or execution approval.
export async function runBaselineAcceptance(context, workstreamDelivery = false) {
  assert.equal(process.env.SPS_BUILDER_LIVE_CODEX, "1");
  const selectedOptIn = workstreamDelivery ? "SPS_BUILDER_LIVE_WORKSTREAMS" : "SPS_BUILDER_LIVE_BASELINE";
  assert.equal(process.env[selectedOptIn], "1");
  for (const name of ["SPS_BUILDER_LIVE_DESIGN", "SPS_BUILDER_LIVE_QUESTION", "SPS_BUILDER_LIVE_MEMORY",
    "SPS_BUILDER_LIVE_CTOS", "SPS_BUILDER_LIVE_CANCEL", "SPS_BUILDER_LIVE_BASELINE", "SPS_BUILDER_LIVE_WORKSTREAMS",
    "OPENAI_API_KEY", "PAPERCLIP_CODEX_PROVIDERS"]) if (name !== selectedOptIn) assert.ok(!process.env[name]);
  const before = await runDesignAcceptance(context, false, false, !workstreamDelivery, workstreamDelivery);
  let { workspace } = before;
  const { plugin, agent, saved, prepared, workingDirectory, beforeOther } = before;
  const { company, secondCompany, api, click, restart, captureScreenshot, screenshotPath } = context;
  const request = (url, options) => api(workspace, url, options);
  const data = (key, params = {}, companyId = company.id) => request(`/api/plugins/${plugin.id}/data/${key}`, {
    method: "POST", body: { companyId, params },
  }).then(reply => reply.data);
  const baseline = () => data("builder.design-baseline", { projectId: company.id });
  const conversation = () => data("builder.lead-conversation", { channel: "main", cursor: null });
  assert.equal(await baseline(), null);
  await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Open actual Lead to record the test user's design decision");
  await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled===false`), Boolean, "baseline composer");
  const message = `For this isolated planning trial I accept the stored draft ${saved.draft.revisionId} as the internal design baseline. The search question remains explicitly open, and I am NOT approving code implementation, a legal contract, deployment or data deletion. Use only Builder planning tools: discover them, read latest main user source and current draft, read current baseline, and call builder.publish-design-baseline exactly once with projectId ${company.id}, sourceDraftRevisionId ${saved.draft.revisionId}, revisionId trial-baseline-1 and expectedBaseRevisionId null. Cite the exact latest lead-turn user source ID, and record your interpretation of my planning decision. The server derives specification/Graph IDs and copies the draft. Do not alter the draft or resolve its question. Read back the baseline and builder.read-solution. Then respond exactly SPS_DESIGN_BASELINE_OK. Do not use other tools, generate code, execute commands, read/write files, create CTOs or perform work. Unknown writes must not be retried; read to reconcile and stop.`;
  await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(message)});
    field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="메시지 보내기"]')?.disabled===false`), Boolean, "baseline send readiness");
  await click(workspace, 'button[aria-label="메시지 보내기"]', "Record one internal user design decision through the real Lead");
  const completed = await eventually(async () => {
    const page = await conversation();
    if (page.active?.runId) await request(`/api/plugins/${plugin.id}/actions/builder.refresh-lead-conversation`, {
      method: "POST", body: { companyId: company.id, params: { channel: "main" } },
    });
    return conversation();
  }, value => value.totalTurns === 2 && value.active === null, "terminal baseline run", 240_000);
  const turn = completed.turns[0];
  assert.equal(turn.state, "succeeded", "Do not replace failed or uncertain provider calls.");
  assert.equal(turn.answer?.trim(), "SPS_DESIGN_BASELINE_OK");
  assert.equal(turn.sessionId, prepared.sessions.main);
  const log = await request(`/api/heartbeat-runs/${turn.runId}/log?offset=0&limitBytes=1048576`);
  assert.equal(log.nextOffset, undefined);
  const stdout = log.content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.stream === "stdout").map(event => event.chunk).join("");
  const items = stdout.split(/\r?\n/).filter(line => line.trim().startsWith("{"))
    .map(line => JSON.parse(line)).filter(event => event.type === "item.completed" && event.item).map(event => event.item);
  assert.ok(items.length > 0 && items.every(item => ["agent_message", "reasoning", "mcp_tool_call"].includes(item.type)));
  const calls = items.filter(item => item.type === "mcp_tool_call");
  const prefix = "com.sonparkserver.my-plugin-builder:";
  const allowed = ["read-design-sources", "read-design-draft", "read-design-baseline", "publish-design-baseline", "read-solution"].map(name => prefix + "builder." + name);
  for (const call of calls) {
    assert.equal(call.server, "sps-plugin-session");
    assert.ok(["list_plugin_tools", "execute_plugin_tool"].includes(call.tool));
    assert.equal(call.status, "completed");
    assert.ok(!call.error && call.result?.isError !== true);
    if (call.tool === "execute_plugin_tool") assert.ok(allowed.includes(call.arguments?.toolName));
  }
  assert.equal(calls.filter(call => call.arguments?.toolName === prefix + "builder.publish-design-baseline").length, 1);
  for (const name of ["read-design-sources", "read-design-draft", "read-design-baseline", "read-solution"]) {
    assert.ok(calls.some(call => call.arguments?.toolName === prefix + "builder." + name));
  }
  const stored = await baseline();
  assert.equal(stored.sequence, 1);
  assert.equal(stored.baseline.revisionId, "trial-baseline-1");
  assert.equal(stored.baseline.sourceDraftRevisionId, saved.draft.revisionId);
  assert.equal(stored.baseline.userDecision.sourceId, `lead-turn:${turn.requestId}`);
  assert.equal(stored.baseline.userDecision.sourceSha256, createHash("sha256").update(message).digest("hex"));
  assert.equal(stored.baseline.author.runId, turn.runId);
  assert.deepEqual(stored.baseline.specification.requirements, saved.draft.specification.requirements);
  assert.deepEqual(stored.baseline.graph.entities, saved.draft.graph.entities);
  assert.equal(stored.baseline.graph.approvedSpecRevisionId, stored.baseline.specification.revisionId);
  assert.equal(stored.baseline.specification.approvalEvidenceRef, `lead-turn:${turn.requestId}`);
  assert.deepEqual(await data("builder.design-draft", { projectId: company.id }), saved);
  assert.equal(await data("builder.design-baseline", { projectId: company.id }, secondCompany.id), null);
  assert.deepEqual(await data("builder.snapshot", {}, secondCompany.id), beforeOther);
  await click(workspace, '[aria-label="Workspace 새로고침"]', "Refresh the actual stored internal baseline document");
  await click(workspace, '.builder-nav [aria-label="설계 문서"]', "Inspect actual baseline record without execution controls");
  await eventually(() => workspace.evaluate(`Boolean([...document.querySelectorAll('.builder-record-button')].find(node=>node.textContent.includes('설계 기준 · Lead 해석 기록')))`), Boolean, "baseline document button");
  await workspace.evaluate(`[...document.querySelectorAll('.builder-record-button')].find(node=>node.textContent.includes('설계 기준 · Lead 해석 기록')).click()`);
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-document-preview')?.textContent`),
    value => value?.includes("trial-baseline-1") && value.includes("외부 계약 체결이나 코드 실행 권한이 아닙니다"), "actual baseline interpretation display");
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-live-baseline.png"));
  workspace = await restart({ companyPrefix: company.issuePrefix, pluginId: plugin.id, readySelector: ".builder-shell" });
  assert.deepEqual(await baseline(), stored);
  assert.deepEqual(await conversation(), completed);
  assert.equal((await request(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=100`)).length, 2);
  assert.equal((await request(`/api/agents/${agent.id}/task-sessions`)).length, 3);
  assert.deepEqual((await request(`/api/agents/${agent.id}`)).adapterConfig, agent.adapterConfig);
  assert.deepEqual(await readdir(workingDirectory), []);
  console.log(JSON.stringify({ liveDesignBaseline: true, actualUiDecision: true, actualLeadRuns: 2,
    baselineWriteCalls: 1, sourceRunBound: true, pinnedSpecificationAndGraph: true, sourceDraftUnchanged: true,
    restartRetained: true, otherWorkspaceUnchanged: true, legalApprovalVerified: false, executionAuthorized: false,
    commandsOrCodeExecuted: false, actualGoogleOauth: false, installedProfileChanged: false,
    baselineDtoSha256: sha(stored), cleanupQualificationPending: true }));
  return { workspace, plugin, agent, prepared, draft: saved, baseline: stored, beforeOther, workingDirectory,
    mainConversation: completed, leadRuns: [before.mainConversation.turns[0], turn] };
}

export async function runAcceptance(context) { await runBaselineAcceptance(context); }
