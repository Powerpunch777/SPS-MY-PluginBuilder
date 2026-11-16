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
  throw new Error(`Live question acceptance did not observe ${label}.`);
}
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Explicit account opt-in; only ephemeral planning tools, never code execution.
export async function runAcceptance(context) {
  assert.equal(process.env.SPS_BUILDER_LIVE_CODEX, "1");
  assert.equal(process.env.SPS_BUILDER_LIVE_QUESTION, "1");
  for (const name of ["SPS_BUILDER_LIVE_DESIGN", "SPS_BUILDER_LIVE_MEMORY", "SPS_BUILDER_LIVE_CANCEL",
    "OPENAI_API_KEY", "PAPERCLIP_CODEX_PROVIDERS"]) assert.ok(!process.env[name], `Mixed scope: ${name}`);
  const baseline = await runDesignAcceptance(context, true);
  let { workspace } = baseline;
  const { plugin, agent, prepared, saved, sourceId, beforeOther, workingDirectory, mainConversation } = baseline;
  const { company, secondCompany, api, click, restart, captureScreenshot, screenshotPath } = context;
  const request = (url, options) => api(workspace, url, options);
  const data = (key, params = {}, companyId = company.id) => request(`/api/plugins/${plugin.id}/data/${key}`, {
    method: "POST", body: { companyId, params },
  }).then(reply => reply.data);
  const conversation = () => data("builder.lead-conversation", { channel: "decisions", cursor: null });
  const draft = () => data("builder.design-draft", { projectId: company.id });
  const question = saved.draft.questions[0];
  assert.ok(question);
  assert.equal((await conversation()).totalTurns, 0);
  await click(workspace, '.builder-nav [aria-label="미결정사항"]', "Answer the actual AI-authored stored question");
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-question-detail')?.textContent.includes(${JSON.stringify(question.title)})`), Boolean, "actual pending question");
  await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled===false`), Boolean, "actual decisions composer");
  const answer = `Yes, include a local search field for notes. This is a design answer, not contract approval or permission to implement anything. For this authorized tool-only trial: discover Builder tools, read the latest decisions source and current design draft. The persisted question association identifies the exact question and base. Use builder.resolve-design-question once to store your interpretation and revise the draft specification and Graph to include local search. Retain the original question objects unchanged, include the actual answer source ID and ${sourceId} in sourceIds, and create new draft, specification and Graph revision IDs. Do not call propose-design, repeat a write, run commands, generate code or use other tools. Read back the stored draft and then reply exactly SPS_LEAD_QUESTION_REVISION_OK.`;
  await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(answer)});
    field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="메시지 보내기"]')?.disabled===false`), Boolean, "question send readiness");
  await click(workspace, 'button[aria-label="메시지 보내기"]', "Send one actual scoped user answer (no duplicate approval)");
  const completed = await eventually(async () => {
    const current = await conversation();
    if (current.active?.runId) await request(`/api/plugins/${plugin.id}/actions/builder.refresh-lead-conversation`, {
      method: "POST", body: { companyId: company.id, params: { channel: "decisions" } },
    });
    return conversation();
  }, value => value.totalTurns === 1 && value.active === null, "terminal question response", 240_000);
  const turn = completed.turns[0];
  assert.equal(turn.state, "succeeded", "Do not replace a failed or uncertain provider request.");
  assert.equal(turn.text, answer);
  assert.deepEqual(turn.questionContext, { projectId: company.id, draftRevisionId: saved.draft.revisionId, questionId: question.id });
  assert.equal(turn.sessionId, prepared.sessions.decisions);
  assert.equal(turn.answer?.trim(), "SPS_LEAD_QUESTION_REVISION_OK");
  const log = await request(`/api/heartbeat-runs/${turn.runId}/log?offset=0&limitBytes=1048576`);
  assert.equal(log.nextOffset, undefined);
  const stdout = log.content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.stream === "stdout").map(event => event.chunk).join("");
  const items = stdout.split(/\r?\n/).filter(line => line.trim().startsWith("{"))
    .map(line => JSON.parse(line)).filter(event => event.type === "item.completed" && event.item).map(event => event.item);
  assert.ok(items.length > 0 && items.every(item => ["agent_message", "reasoning", "mcp_tool_call"].includes(item.type)));
  const calls = items.filter(item => item.type === "mcp_tool_call");
  const prefix = "com.sonparkserver.my-plugin-builder:";
  const allowed = ["builder.read-design-sources", "builder.read-design-draft", "builder.resolve-design-question"].map(name => prefix + name);
  for (const call of calls) {
    assert.equal(call.server, "sps-plugin-session");
    assert.ok(["list_plugin_tools", "execute_plugin_tool"].includes(call.tool));
    assert.equal(call.status, "completed");
    if (call.tool === "execute_plugin_tool") assert.ok(allowed.includes(call.arguments?.toolName));
  }
  const executed = calls.filter(call => call.tool === "execute_plugin_tool");
  assert.equal(executed.filter(call => call.arguments.toolName === prefix + "builder.resolve-design-question").length, 1);
  assert.ok(executed.some(call => call.arguments.toolName === prefix + "builder.read-design-sources"));
  assert.ok(executed.some(call => call.arguments.toolName === prefix + "builder.read-design-draft"));
  const revised = await draft();
  assert.equal(revised.sequence, saved.sequence + 1);
  assert.notEqual(revised.draft.revisionId, saved.draft.revisionId);
  assert.notEqual(revised.draft.specification.revisionId, saved.draft.specification.revisionId);
  assert.notEqual(revised.draft.graph.graphRevisionId, saved.draft.graph.graphRevisionId);
  assert.notDeepEqual(revised.draft.specification.requirements, saved.draft.specification.requirements);
  assert.notDeepEqual(revised.draft.graph.entities, saved.draft.graph.entities);
  assert.deepEqual(revised.draft.questions, saved.draft.questions);
  assert.equal(revised.decisions.length, 1);
  assert.equal(revised.decisions[0].answerSourceId, `lead-turn:${turn.requestId}`);
  assert.equal(revised.decisions[0].answerSourceSha256, createHash("sha256").update(answer).digest("hex"));
  assert.equal(revised.decisions[0].questionId, question.id);
  assert.equal(revised.decisions[0].fromDraftRevisionId, saved.draft.revisionId);
  assert.equal(revised.decisions[0].appliedDraftRevisionId, revised.draft.revisionId);
  assert.ok(revised.draft.sourceIds.includes(`lead-turn:${turn.requestId}`));
  const answeredVisible = () => workspace.evaluate(`document.querySelector('.builder-question-detail')?.textContent.includes(${JSON.stringify(revised.decisions[0].answerText)})`);
  await eventually(answeredVisible, Boolean, "actual saved answer interpretation in UI");
  assert.equal(await workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled`), true);
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-live-question-revision.png"));
  workspace = await restart({ companyPrefix: company.issuePrefix, pluginId: plugin.id, readySelector: ".builder-shell" });
  assert.deepEqual(await draft(), revised);
  assert.deepEqual(await conversation(), completed);
  assert.deepEqual(await data("builder.lead-conversation", { channel: "main", cursor: null }), mainConversation);
  assert.equal((await data("builder.lead-conversation", { channel: "cto-inbox", cursor: null })).totalTurns, 0);
  assert.deepEqual(await data("builder.snapshot", {}, secondCompany.id), beforeOther);
  assert.equal(await data("builder.design-draft", { projectId: company.id }, secondCompany.id), null);
  assert.equal((await request(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=100`)).length, 2);
  assert.deepEqual((await request(`/api/agents/${agent.id}`)).adapterConfig, agent.adapterConfig);
  assert.deepEqual(await readdir(workingDirectory), []);
  console.log(JSON.stringify({ liveQuestionRevision: true, actualUiAnswer: true, aiExecuted: true,
    answerAndDraftStoredTogether: true, restartRetained: true, writes: 1, providerRuns: 2,
    questionSession: "decisions", internalCtoRuns: 0, commandsOrCodeExecuted: false,
    actualGoogleOauth: false, installedProfileChanged: false, otherWorkspaceUnchanged: true,
    sharedMemoryUpdated: false, downstreamPropagation: false, approvedContract: false,
    draftDtoSha256: digest(revised), cleanupQualificationPending: true }));
}
