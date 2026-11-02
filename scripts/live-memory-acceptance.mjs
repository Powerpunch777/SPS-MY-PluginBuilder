import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { runAcceptance as baselineAcceptance } from "./core-host-acceptance.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, check, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (check(value)) return value;
    await pause(300);
  }
  throw new Error(`Live memory acceptance did not observe ${label}.`);
}

// Account-using source operator. Never shipped or enabled by the default smoke.
// The internal intake transport is not implemented; do not simulate that role.
export async function runAcceptance(context) {
  assert.equal(process.env.SPS_BUILDER_LIVE_CODEX, "1");
  assert.equal(process.env.SPS_BUILDER_LIVE_MEMORY, "1");
  assert.ok(!process.env.OPENAI_API_KEY && !process.env.PAPERCLIP_CODEX_PROVIDERS);
  const baseline = await baselineAcceptance(context);
  let workspace = baseline.workspace;
  const { plugin } = baseline;
  const { company, secondCompany, api, click, restart, temporaryRoot, captureScreenshot, screenshotPath } = context;
  const request = (url, options) => api(workspace, url, options);
  const data = (key, params = {}, companyId = company.id) => request(`/api/plugins/${plugin.id}/data/${key}`, {
    method: "POST", body: { companyId, params },
  }).then(value => value.data);
  const action = (key, params) => request(`/api/plugins/${plugin.id}/actions/${key}`, {
    method: "POST", body: { companyId: company.id, params },
  }).then(value => value.data);
  const memory = () => data("builder.lead-memory", { projectId: company.id });
  const conversation = channel => data("builder.lead-conversation", { channel, cursor: null });
  const directory = path.join(temporaryRoot, "live-lead-memory");
  await mkdir(directory);
  const agent = await request(`/api/companies/${company.id}/agents`, { method: "POST", body: {
    name: "Isolated authorized shared-memory Lead", role: "engineer", adapterType: "codex_local",
    adapterConfig: { engine: "cli", cwd: directory, timeoutSec: 180, graceSec: 3,
      dangerouslyBypassApprovalsAndSandbox: false },
    instructionsBundle: { files: { "AGENTS.md": "Authorized memory-only trial. Use only sps-plugin-session list_plugin_tools and execute_plugin_tool for Builder read-design-sources, read-lead-memory, update-lead-memory. Never run commands, read/edit files, generate code, use web/apps/subagents or contact other services. Memory is interpretation, not customer approval or execution authority. Unknown write outcomes require read reconciliation and must not be resent." } },
  } });
  await click(workspace, '.builder-nav [aria-label="시스템"]', "Select temporary memory trial Lead");
  await click(workspace, '[aria-label="Workspace 새로고침"]', "Refresh trial Agent choices");
  await eventually(() => workspace.evaluate(`Boolean(document.querySelector('select[aria-label="Lead Agent"] option[value="${agent.id}"]'))`), Boolean, "trial Agent option");
  await workspace.evaluate(`(() => {const field=document.querySelector('select[aria-label="Lead Agent"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(field,${JSON.stringify(agent.id)});
    field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('section[aria-labelledby="lead-agent-settings-title"] button[type="submit"]')?.disabled === false`), Boolean, "Lead selection readiness");
  await click(workspace, 'section[aria-labelledby="lead-agent-settings-title"] button', "Save trial Lead selection");
  await eventually(() => data("builder.lead-agents"), value => value.selectedAgentId === agent.id, "saved Lead");
  await eventually(() => workspace.evaluate(`document.querySelector('[aria-label="Lead 세션 준비 및 확인"]')?.disabled === false`), Boolean, "session preparation readiness");
  await click(workspace, '[aria-label="Lead 세션 준비 및 확인"]', "Prepare three distinct Lead sessions without dispatching intake");
  const sessions = await eventually(() => data("builder.lead-sessions"), value => value.agentId === agent.id && Object.values(value.sessions).every(Boolean), "three saved session IDs");
  const sourceRequest = randomUUID();
  await action("builder.import-consultation", { requestId: sourceRequest,
    text: "Memory trial: build a desktop notes list, keeping note contents local. A search field is undecided. Do not implement anything." });
  const otherBefore = await data("builder.snapshot", {}, secondCompany.id);
  assert.equal(await memory(), null);
  const prefix = "com.sonparkserver.my-plugin-builder:";
  const completedRuns = [];
  async function send(channel, text, marker, viaUi = false) {
    console.log(JSON.stringify({ liveMemoryStage: channel, expectedTurns: channel === "main" ? completedRuns.filter(run => run.channel === "main").length + 1 : 1 }));
    if (viaUi) {
      await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Open actual Lead chat");
      await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled === false`), Boolean, "chat readiness");
      await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});
        field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await eventually(() => workspace.evaluate(`document.querySelector('[aria-label="메시지 보내기"]')?.disabled === false`), Boolean, "message readiness");
      await click(workspace, '[aria-label="메시지 보내기"]', "Send authorized memory-only message through actual UI");
    } else await action("builder.send-lead-message", { channel, requestId: randomUUID(), text });
    const total = completedRuns.filter(run => run.channel === channel).length + 1;
    const finished = await eventually(async () => {
      await action("builder.refresh-lead-conversation", { channel });
      return conversation(channel);
    }, value => value.totalTurns === total && value.active === null, `${channel} terminal response`, 240_000);
    const turn = finished.turns[0];
    assert.equal(turn.state, "succeeded", "Do not create replacement executions on failure.");
    const run = await request(`/api/heartbeat-runs/${turn.runId}`);
    assert.equal(run.contextSnapshot.spsPluginConversation.sessionId, sessions.sessions[channel]);
    const log = await request(`/api/heartbeat-runs/${turn.runId}/log?offset=0&limitBytes=1048576`);
    assert.equal(log.nextOffset, undefined);
    const stdout = log.content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      .filter(event => event.stream === "stdout").map(event => event.chunk).join("");
    const items = stdout.split(/\r?\n/).filter(line => line.trim().startsWith("{"))
      .map(line => JSON.parse(line)).filter(event => event.type === "item.completed" && event.item).map(event => event.item);
    assert.ok(items.length > 0 && items.every(item => ["agent_message", "reasoning", "mcp_tool_call"].includes(item.type)));
    const calls = items.filter(item => item.type === "mcp_tool_call");
    console.log(JSON.stringify({ liveMemoryCalls: calls.map(call => ({ server: call.server, tool: call.tool,
      operation: call.arguments?.toolName ?? null, status: call.status,
      error: typeof call.error?.message === "string" ? call.error.message.slice(0, 300) : typeof call.error === "string" ? call.error.slice(0, 300) : null,
      resultIsError: call.result?.isError ?? null })) }));
    for (const call of calls) {
      assert.equal(call.server, "sps-plugin-session");
      assert.equal(call.status, "completed");
      assert.ok(["list_plugin_tools", "execute_plugin_tool"].includes(call.tool));
      if (call.tool === "execute_plugin_tool") assert.ok(["builder.read-design-sources", "builder.read-lead-memory", "builder.update-lead-memory"]
        .map(name => prefix + name).includes(call.arguments?.toolName));
    }
    assert.ok(calls.some(call => call.arguments?.toolName === prefix + "builder.read-lead-memory"));
    assert.equal(turn.answer?.trim(), marker);
    completedRuns.push({ channel, runId: turn.runId, writes: calls.filter(call => call.arguments?.toolName === prefix + "builder.update-lead-memory").length });
    assert.deepEqual(await readdir(directory), []);
    return finished;
  }
  const scope = `Builder project ${company.id}. Use the available sps-plugin-session tools only. Discover the Builder memory tools if needed. No commands, files, code generation or external services.`;
  await send("main", `${scope} Read the latest consultation user source and current shared Lead memory. Store exactly one goal entry id notes-goal saying to build a desktop notes list with local note content, citing only the actual consultation ID returned by the source tool. If current memory is null use expectedBaseRevisionId null. Use revisionId memory-main-1. Read memory back, then answer exactly SPS_MEMORY_MAIN_OK. Store only a knowledge interpretation, no approval or execution claim. Do not retry a write with uncertain outcome.`, "SPS_MEMORY_MAIN_OK", true);
  const first = await memory();
  assert.equal(first.memory.revisionId, "memory-main-1");
  assert.equal(first.memory.entries.length, 1);
  assert.deepEqual(first.memory.entries[0].sourceIds, [`consultation-${sourceRequest}`]);
  await send("decisions", `${scope} User answer for this trial: include a search field. Read shared Lead memory and keep the existing notes-goal entry EXACTLY unchanged. Read the latest decisions user source to obtain this actual turn's ID. Store a new revisionId memory-decisions-2 with the retained goal and one new decision entry id search-decision saying to include a search field, citing the actual decisions user turn ID. Use the current memory revision as expectedBaseRevisionId. This records a design interpretation, not customer contract approval. Read back, then answer exactly SPS_MEMORY_DECISIONS_OK. Do not repeat an uncertain write.`, "SPS_MEMORY_DECISIONS_OK");
  const second = await memory();
  assert.equal(second.memory.revisionId, "memory-decisions-2");
  assert.equal(second.memory.entries.length, 2);
  assert.deepEqual(second.memory.entries.find(entry => entry.id === "notes-goal"), first.memory.entries[0]);
  const decisionsPage = await conversation("decisions");
  assert.deepEqual(second.memory.entries.find(entry => entry.id === "search-decision").sourceIds, [`lead-turn:${decisionsPage.turns[0].requestId}`]);
  await send("main", `${scope} Read shared Lead memory, confirm it contains notes-goal plus the search-decision from the other Lead session. Do not update memory. Respond exactly SPS_MEMORY_SHARED_OK.`, "SPS_MEMORY_SHARED_OK");
  assert.deepEqual(await memory(), second);
  assert.deepEqual(completedRuns.map(run => run.writes), [1, 1, 0]);
  const mainPage = await conversation("main");
  assert.equal(mainPage.totalTurns, 2);
  assert.equal(decisionsPage.totalTurns, 1);
  assert.ok(mainPage.turns.every(turn => turn.sessionId === sessions.sessions.main));
  assert.ok(decisionsPage.turns.every(turn => turn.sessionId === sessions.sessions.decisions));
  assert.equal((await conversation("cto-inbox")).totalTurns, 0, "The internal intake must not accept a user test message.");
  await click(workspace, '[aria-label="Workspace 새로고침"]', "Refresh the real stored shared-memory document");
  await click(workspace, '.builder-nav [aria-label="설계 문서"]', "Inspect stored Lead knowledge in existing documents view");
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-document-preview')?.textContent`),
    value => value?.includes("memory-decisions-2") && value.includes("search-decision"), "actual memory document");
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-live-memory.png"));
  workspace = await restart({ companyPrefix: company.issuePrefix, pluginId: plugin.id, readySelector: ".builder-shell" });
  assert.deepEqual(await memory(), second);
  assert.deepEqual(await conversation("main"), mainPage);
  assert.deepEqual(await conversation("decisions"), decisionsPage);
  assert.deepEqual(await data("builder.snapshot", {}, secondCompany.id), otherBefore);
  assert.equal(await data("builder.lead-memory", { projectId: company.id }, secondCompany.id), null);
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await request(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=100`)).length, 3);
  assert.deepEqual((await request(`/api/agents/${agent.id}`)).adapterConfig, agent.adapterConfig);
  console.log(JSON.stringify({ liveLeadMemory: true, aiExecuted: true, actualLeadRuns: 3,
    actualSessionChannels: ["main", "decisions"], internalIntakeExecuted: false,
    actualUiFirstSend: true, laterSendsViaAuthenticatedAction: true, realHostMemoryWritten: true,
    restartRetainedMemoryAndSeparateTranscripts: true, writesPerRun: completedRuns.map(run => run.writes),
    otherWorkspaceUnchanged: true, commandsOrCodeExecuted: false, installedProfileChanged: false,
    memorySha256: createHash("sha256").update(JSON.stringify(second)).digest("hex"), cleanupQualificationPending: true }));
}
