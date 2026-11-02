import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { runAcceptance as baselineAcceptance } from "./core-host-acceptance.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await pause(500);
  }
  throw new Error(`Live Builder acceptance did not observe ${label}.`);
}

// Operator-only opt-in: never imported by the shipped Plugin or default smoke.
// Uses the existing adapter's managed temporary home and default auth link.
export async function runAcceptance(context) {
  assert.equal(process.env.SPS_BUILDER_LIVE_CODEX, "1", "Account usage requires explicit opt-in.");
  const baseline = await baselineAcceptance(context);
  let workspace = baseline.workspace;
  const { plugin } = baseline;
  const { company, api, click, restart, temporaryRoot, captureScreenshot, screenshotPath } = context;
  const request = (url, options) => api(workspace, url, options);
  const stage = value => console.log(JSON.stringify({ liveLeadStage: value }));
  const workingDirectory = path.join(temporaryRoot, "live-lead-chat");
  await mkdir(workingDirectory);
  const extraArgs = ["--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "-c", 'web_search="disabled"'];
  for (const feature of ["shell_tool", "multi_agent", "plugins", "apps", "hooks", "computer_use",
    "browser_use", "in_app_browser", "code_mode_host", "image_generation", "workspace_dependencies"]) {
    extraArgs.push("--disable", feature);
  }
  const adapterConfig = { engine: "cli", cwd: workingDirectory, timeoutSec: 120, graceSec: 3,
    dangerouslyBypassApprovalsAndSandbox: false, extraArgs };
  stage("create_temporary_agent");
  const agent = await request(`/api/companies/${company.id}/agents`, { method: "POST", body: {
    name: "Isolated authorized Lead chat", role: "engineer", adapterType: "codex_local", adapterConfig,
    instructionsBundle: { files: { "AGENTS.md": "This is an authorized short conversation test, not a development task. Do not use tools, run commands, read or write files, generate code, or contact other services. Answer the user's latest message with exactly SPS_LEAD_CHAT_OK and nothing else." } },
  } });
  const options = () => request(`/api/plugins/${plugin.id}/data/builder.lead-agents`, {
    method: "POST", body: { companyId: company.id, params: {} },
  }).then(value => value.data);
  const sessions = () => request(`/api/plugins/${plugin.id}/data/builder.lead-sessions`, {
    method: "POST", body: { companyId: company.id, params: {} },
  }).then(value => value.data);
  const conversation = () => request(`/api/plugins/${plugin.id}/data/builder.lead-conversation`, {
    method: "POST", body: { companyId: company.id, params: { channel: "main", cursor: null } },
  }).then(value => value.data);
  stage("select_lead");
  await workspace.command("Page.bringToFront");
  await click(workspace, '.builder-nav [aria-label="시스템"]', "Open temporary live Lead settings");
  await click(workspace, 'button[aria-label="Workspace 새로고침"]', "Refresh temporary Agent choices");
  await eventually(() => workspace.evaluate(`Boolean(document.querySelector('select[aria-label="Lead Agent"] option[value="${agent.id}"]'))`), Boolean, "temporary Codex Agent option");
  await workspace.evaluate(`(() => {const select=document.querySelector('select[aria-label="Lead Agent"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(agent.id)});
    select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('section[aria-labelledby="lead-agent-settings-title"] button[type="submit"]')?.disabled === false`), Boolean, "live Lead binding button");
  await click(workspace, 'section[aria-labelledby="lead-agent-settings-title"] button', "Bind the explicitly authorized trial Agent");
  await eventually(options, value => value.selectedAgentId === agent.id, "live Lead binding");
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="Lead 세션 준비 및 확인"]')?.disabled === false`), Boolean, "live session preparation");
  stage("prepare_sessions");
  await click(workspace, 'button[aria-label="Lead 세션 준비 및 확인"]', "Prepare isolated Codex chat sessions");
  const prepared = await eventually(sessions, value => value.agentId === agent.id && Object.values(value.sessions).every(Boolean), "live three-session binding");
  await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Open actual Lead conversation");
  await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled === false`), Boolean, "actual message readiness");
  const text = "Short conversation check only. Please reply with SPS_LEAD_CHAT_OK. Do not use tools or generate code.";
  await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});
    field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="메시지 보내기"]')?.disabled === false`), Boolean, "live send button");
  stage("send_short_chat");
  await click(workspace, 'button[aria-label="메시지 보내기"]', "Send one authorized nonsecret live Lead message");
  let observedStatus = null;
  const finished = await eventually(async () => {
    const page = await conversation();
    if (page.active?.runId) {
      const currentRun = await request(`/api/heartbeat-runs/${page.active.runId}`);
      if (currentRun.status !== observedStatus) {
        observedStatus = currentRun.status;
        console.log(JSON.stringify({ liveLeadRunState: observedStatus,
          errorCode: currentRun.errorCode ?? null, error: String(currentRun.error ?? "").slice(0, 1000) }));
      }
      await request(`/api/plugins/${plugin.id}/actions/builder.refresh-lead-conversation`, { method: "POST", body: {
        companyId: company.id, params: { channel: "main" },
      } });
    }
    return conversation();
  }, value => value.totalTurns === 1 && value.active === null,
    "terminal live response", 180_000);
  stage("inspect_provider_result");
  const turn = finished.turns[0];
  const run = await request(`/api/heartbeat-runs/${turn.runId}`);
  if (turn.state !== "succeeded") {
    console.log(JSON.stringify({ liveLeadChat: "failed", status: turn.state,
      errorCode: run.errorCode ?? null, error: String(run.error ?? "").slice(0, 1000) }));
  }
  assert.equal(turn.state, "succeeded", "The actual provider run must succeed, not merely accept the message.");
  assert.equal(turn.answer?.trim(), "SPS_LEAD_CHAT_OK");
  assert.equal(run.status, "succeeded");
  const log = await request(`/api/heartbeat-runs/${turn.runId}/log?offset=0&limitBytes=262144`);
  assert.equal(log.nextOffset, undefined, "The entire short run log must be checked for unexpected tool execution.");
  assert.equal(typeof log.content, "string");
  const stdout = log.content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.stream === "stdout").map(event => event.chunk).join("");
  const items = stdout.split(/\r?\n/).filter(line => line.trim().startsWith("{"))
    .map(line => JSON.parse(line)).filter(event => event.item).map(event => event.item);
  assert.ok(items.some(item => item.type === "agent_message"), "The real CLI must emit its assistant response.");
  assert.ok(items.every(item => ["agent_message", "reasoning"].includes(item.type)),
    "Short-chat acceptance must not perform commands, file edits, MCP, search or subagent work.");
  assert.deepEqual(await readdir(workingDirectory), [], "No generated code or workspace files may be created.");
  await click(workspace, 'button[aria-label="Workspace 새로고침"]', "Read the completed real conversation into the visible UI");
  const assistantVisible = () => workspace.evaluate(`document.querySelector('.builder-message.is-assistant .builder-message-bubble')?.textContent.trim() === 'SPS_LEAD_CHAT_OK'`);
  await eventually(assistantVisible, Boolean, "actual assistant response in Builder UI, excluding user prompt text");
  await request(`/api/plugins/${plugin.id}/actions/builder.send-lead-message`, { method: "POST", body: {
    companyId: company.id, params: { channel: "main", requestId: turn.requestId, text },
  } });
  assert.equal((await request(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=100`)).length, 1);
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-live-lead.png"));
  workspace = await restart({ companyPrefix: company.issuePrefix, pluginId: plugin.id, readySelector: ".builder-shell" });
  assert.deepEqual(await sessions(), prepared);
  assert.deepEqual(await conversation(), finished, "Restart must retain the exact real answer and run identity.");
  await eventually(assistantVisible, Boolean, "restarted actual assistant response, excluding user prompt text");
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-live-lead-restarted.png"));
  assert.deepEqual((await request(`/api/agents/${agent.id}`)).adapterConfig, agent.adapterConfig);
  console.log(JSON.stringify({ liveLeadChat: true, aiExecuted: true, defaultCliAccount: true,
    actualUiSend: true, actualProviderSucceeded: true, actualAnswerRendered: true, restartRetainedAnswer: true,
    repeatedRequestDidNotExecuteAgain: true, commandsOrCodeExecuted: false, installedProfileChanged: false,
    answerSha256: createHash("sha256").update(turn.answer).digest("hex"), cleanupQualificationPending: true }));
}
