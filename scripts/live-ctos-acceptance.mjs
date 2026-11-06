import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { runDesignAcceptance } from "./live-design-acceptance.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await pause(300);
  }
  throw new Error(`Live CTO registration did not observe ${label}.`);
}

// Explicitly authorized source-only operator. Registered CTO sessions stay unused.
export async function runAcceptance(context) {
  assert.equal(process.env.SPS_BUILDER_LIVE_CODEX, "1");
  assert.equal(process.env.SPS_BUILDER_LIVE_CTOS, "1");
  for (const key of ["SPS_BUILDER_LIVE_DESIGN", "SPS_BUILDER_LIVE_QUESTION", "SPS_BUILDER_LIVE_MEMORY",
    "SPS_BUILDER_LIVE_CANCEL", "OPENAI_API_KEY", "PAPERCLIP_CODEX_PROVIDERS"]) assert.ok(!process.env[key]);
  const baseline = await runDesignAcceptance(context, false, true);
  let { workspace } = baseline;
  const { plugin, agent, prepared, saved, beforeOther, workingDirectory } = baseline;
  const { api, click, company, secondCompany, restart, captureScreenshot, screenshotPath } = context;
  const request = (url, options) => api(workspace, url, options);
  const data = (key, params = {}, companyId = company.id) => request(`/api/plugins/${plugin.id}/data/${key}`, {
    method: "POST", body: { companyId, params },
  }).then(reply => reply.data);
  const registry = () => data("builder.project-ctos", { projectId: company.id });
  const conversation = () => data("builder.lead-conversation", { channel: "main", cursor: null });
  assert.deepEqual((await registry()).ctos, []);
  assert.equal((await request(`/api/agents/${agent.id}/task-sessions`)).length, 3);
  await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Open the same prepared Lead for a registration-only request");
  await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled===false`), Boolean, "resumed Lead composer");
  const prompt = `Authorized identity/session registration trial only, project ${company.id}. Discover the Builder tools. Read builder.list-ctos, which should be empty. Use builder.create-cto to register CTO id trial-ui and displayName Trial UI CTO, and CTO id trial-checks and displayName Trial Checks CTO. These are logical roles using the existing Agent and separate sessions, not new Core Agents or accounts. Explicitly call create-cto once more for trial-ui with the exact same name to verify keyed identity recovery. Then read builder.list-ctos again and reply exactly SPS_CTO_REGISTRATION_OK. Do not dispatch any CTO, create workstreams, alter the design, run code/commands, edit/read files, search the web or use any other tools. If a write has an unknown result do not repeat it; stop and report. Do not claim implementation or readiness.`;
  await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(prompt)});
    field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="메시지 보내기"]')?.disabled===false`), Boolean, "registration send readiness");
  await click(workspace, 'button[aria-label="메시지 보내기"]', "Send the authorized actual Lead registration trial");
  const finished = await eventually(async () => {
    const page = await conversation();
    if (page.active?.runId) await request(`/api/plugins/${plugin.id}/actions/builder.refresh-lead-conversation`, {
      method: "POST", body: { companyId: company.id, params: { channel: "main" } },
    });
    return conversation();
  }, page => page.totalTurns === 2 && page.active === null, "terminal registration response", 240_000);
  const turn = finished.turns[0];
  assert.equal(turn.state, "succeeded", "Do not substitute another request for a failed/uncertain run.");
  assert.equal(turn.answer?.trim(), "SPS_CTO_REGISTRATION_OK");
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
  for (const call of calls) {
    assert.equal(call.server, "sps-plugin-session");
    assert.ok(["list_plugin_tools", "execute_plugin_tool"].includes(call.tool));
    assert.equal(call.status, "completed");
    assert.ok(!call.error && call.result?.isError !== true);
    if (call.tool === "execute_plugin_tool") assert.ok([prefix + "builder.create-cto", prefix + "builder.list-ctos"].includes(call.arguments?.toolName));
  }
  assert.equal(calls.filter(call => call.arguments?.toolName === prefix + "builder.create-cto").length, 3);
  assert.ok(calls.filter(call => call.arguments?.toolName === prefix + "builder.list-ctos").length >= 2);
  const stored = await registry();
  assert.equal(stored.revision, 4);
  assert.deepEqual(stored.ctos.map(cto => cto.ctoId).sort(), ["trial-checks", "trial-ui"]);
  assert.equal(new Set(stored.ctos.map(cto => cto.sessionId)).size, 2);
  assert.ok(stored.ctos.every(cto => cto.agentId === agent.id && cto.status === "AVAILABLE" && cto.sessionId
    && !Object.values(prepared.sessions).includes(cto.sessionId)));
  const coreSessions = await request(`/api/agents/${agent.id}/task-sessions`);
  assert.equal(coreSessions.length, 5, "Exactly three Lead and two CTO sessions, not an extra retry session.");
  for (const cto of stored.ctos) {
    const session = coreSessions.find(session => session.id === cto.sessionId || session.sessionId === cto.sessionId);
    assert.ok(session);
    assert.equal(session.lastRunId, null, "CTO registration must not execute an AI run.");
  }
  assert.deepEqual(await data("builder.design-draft", { projectId: company.id }), saved);
  assert.deepEqual(await data("builder.snapshot", {}, secondCompany.id), beforeOther);
  assert.deepEqual((await data("builder.project-ctos", { projectId: company.id }, secondCompany.id)).ctos, []);
  await click(workspace, '[aria-label="Workspace 새로고침"]', "Refresh real registered CTO identities");
  await click(workspace, '.builder-nav [aria-label="조직도"]', "Read actual registered project CTOs");
  await eventually(() => workspace.evaluate(`({count:document.querySelectorAll('.builder-org-card').length,
    text:document.querySelector('.builder-org-page')?.textContent??document.querySelector('.builder-main')?.textContent})`),
  value => value.count === 2 && value.text.includes("Trial UI CTO") && value.text.includes("Trial Checks CTO"), "two registered CTO cards");
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-live-ctos.png"));
  workspace = await restart({ companyPrefix: company.issuePrefix, pluginId: plugin.id, readySelector: ".builder-shell" });
  assert.deepEqual(await registry(), stored);
  assert.deepEqual(await conversation(), finished);
  assert.equal((await request(`/api/agents/${agent.id}/task-sessions`)).length, 5);
  assert.equal((await request(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=100`)).length, 2);
  assert.deepEqual((await request(`/api/agents/${agent.id}`)).adapterConfig, agent.adapterConfig);
  assert.deepEqual(await readdir(workingDirectory), []);
  console.log(JSON.stringify({ liveCtoRegistration: true, actualLeadRuns: 2, ctoRegistrations: 2,
    repeatedRegistrationReusedIdentity: true, independentSessions: true, ctoProviderRuns: 0,
    coreAgentConfigurationPreserved: true, restartRetained: true, otherWorkspaceUnchanged: true,
    actualGoogleOauth: false, commandsOrCodeExecuted: false, workstreamsAssigned: false,
    privateCtoMemoryImplemented: false, ctoQuestionIntake: false, installedProfileChanged: false,
    registrySha256: createHash("sha256").update(JSON.stringify(stored)).digest("hex"), cleanupQualificationPending: true }));
}
