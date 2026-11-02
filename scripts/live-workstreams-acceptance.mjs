import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { runBaselineAcceptance } from "./live-baseline-acceptance.mjs";

const selectedOptIn = "SPS_BUILDER_LIVE_WORKSTREAMS";
assert.equal(process.env.SPS_BUILDER_LIVE_CODEX, "1", "Live Workstreams requires SPS_BUILDER_LIVE_CODEX=1.");
assert.equal(process.env[selectedOptIn], "1", "Live Workstreams requires SPS_BUILDER_LIVE_WORKSTREAMS=1.");
for (const name of ["SPS_BUILDER_LIVE_CANCEL", "SPS_BUILDER_LIVE_DESIGN", "SPS_BUILDER_LIVE_MEMORY",
  "SPS_BUILDER_LIVE_QUESTION", "SPS_BUILDER_LIVE_CTOS", "SPS_BUILDER_LIVE_BASELINE",
  "OPENAI_API_KEY", "PAPERCLIP_CODEX_PROVIDERS"]) assert.equal(process.env[name], undefined, `${name} is incompatible with this isolated trial.`);
assert.ok(!process.env.SPS_DESKTOP_E2E_BINARY, "Live Workstreams is source-app only; installed binaries are forbidden.");

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted", "timed_out"]);
const pluginPrefix = "com.sonparkserver.my-plugin-builder:";

async function eventually(read, check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await pause(300);
  }
  throw new Error(`Live Workstreams acceptance did not observe ${label}.`);
}

function itemsFromRunLog(log) {
  assert.equal(log.nextOffset, undefined, "The complete bounded run log is required to check tool scope.");
  const stdout = log.content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.stream === "stdout").map(event => event.chunk).join("");
  const items = stdout.split(/\r?\n/).filter(line => line.trim().startsWith("{"))
    .map(line => JSON.parse(line)).filter(event => event.type === "item.completed" && event.item).map(event => event.item);
  assert.ok(items.length > 0, "The provider run must expose bounded inspectable item logs.");
  assert.ok(items.every(item => ["agent_message", "reasoning", "mcp_tool_call"].includes(item.type)),
    "Commands, code edits, web searches and other item types are forbidden in this trial.");
  return items;
}

async function inspectScopedRun(request, runId, allowedToolNames) {
  const log = await request(`/api/heartbeat-runs/${runId}/log?offset=0&limitBytes=1048576`);
  const items = itemsFromRunLog(log);
  const calls = items.filter(item => item.type === "mcp_tool_call");
  assert.ok(calls.length > 0, "Each provider run must use the declared Builder planning tools.");
  for (const call of calls) {
    assert.equal(call.server, "sps-plugin-session");
    assert.ok(["list_plugin_tools", "execute_plugin_tool"].includes(call.tool));
    assert.equal(call.status, "completed");
    assert.ok(!call.error && call.result?.isError !== true, "A tool call must not be silently treated as success after an error.");
    if (call.tool === "execute_plugin_tool") assert.ok(allowedToolNames.includes(call.arguments?.toolName),
      `Undeclared planning tool call: ${call.arguments?.toolName}`);
  }
  return calls;
}

async function data(request, pluginId, key, params, companyId) {
  const result = await request(`/api/plugins/${pluginId}/data/${key}`, {
    method: "POST", body: { companyId, params },
  });
  return result.data;
}

async function runWorkstreamsAcceptance(context) {
  const prepared = await runBaselineAcceptance(context, true);
  let { workspace } = prepared;
  const { plugin, agent, prepared: leadSessions, draft, baseline, beforeOther, workingDirectory, leadRuns } = prepared;
  const { company, secondCompany, api, click, restart } = context;
  const request = (url, options) => api(workspace, url, options);
  const projectId = company.id;
  const conversation = () => data(request, plugin.id, "builder.lead-conversation", { channel: "main", cursor: null }, projectId);
  const getBaseline = () => data(request, plugin.id, "builder.design-baseline", { projectId }, projectId);
  const getTechnology = () => data(request, plugin.id, "builder.technology-decisions", { projectId }, projectId);
  const getCtos = () => data(request, plugin.id, "builder.project-ctos", { projectId }, projectId);
  const getBoard = () => data(request, plugin.id, "builder.workstreams", { projectId }, projectId);
  const runs = () => request(`/api/companies/${projectId}/heartbeat-runs?agentId=${agent.id}&limit=100`);
  const sessions = () => request(`/api/agents/${agent.id}/task-sessions`);

  assert.equal(process.env.SPS_BUILDER_LIVE_CODEX, "1");
  assert.equal(process.env.SPS_BUILDER_LIVE_WORKSTREAMS, "1");
  assert.deepEqual(await getTechnology(), null);
  assert.deepEqual((await getCtos()).ctos, []);
  assert.equal(await getBoard(), null);
  assert.equal((await runs()).length, 2);
  assert.equal((await sessions()).length, 3);
  assert.equal(leadRuns.length, 2);
  const draftCalls = await inspectScopedRun(request, leadRuns[0].runId,
    ["builder.read-design-sources", "builder.read-design-draft", "builder.propose-design"].map(name => pluginPrefix + name));
  assert.equal(draftCalls.filter(call => call.arguments?.toolName === pluginPrefix + "builder.propose-design").length, 1);
  const baselineCalls = await inspectScopedRun(request, leadRuns[1].runId,
    ["builder.read-design-sources", "builder.read-design-draft", "builder.read-design-baseline",
      "builder.publish-design-baseline", "builder.read-solution"].map(name => pluginPrefix + name));
  assert.equal(baselineCalls.filter(call => call.arguments?.toolName === pluginPrefix + "builder.publish-design-baseline").length, 1);

  const graphNode = baseline.baseline.graph.entities.find(node => node.specRef);
  assert.ok(graphNode, "The baseline must contain an actual requirement-linked Graph node to assign.");
  const ctoId = "trial-workstreams-cto";
  const workstreamId = "trial-workstream-node-1";
  const techRevisionId = "trial-workstreams-tech-1";
  const boardRevisionId = "trial-workstreams-board-1";
  const technologyName = "Existing SPS Plugin SDK integration";

  await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Open the prepared Lead for one planning-only Workstream request");
  await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled===false`), Boolean, "third Lead composer");
  const message = `Authorized planning-only Workstream trial for Builder project ${projectId}. The current saved draft revision is ${draft.draft.revisionId}; the exact existing internal baseline revision is ${baseline.baseline.revisionId}, its specification revision is ${baseline.baseline.specification.revisionId}, Graph revision is ${baseline.baseline.graph.graphRevisionId}, and one actual Graph node to assign is ${graphNode.id} (kind ${graphNode.kind}, specRef ${graphNode.specRef}).

Discover tools and read the current design baseline, current technology register, CTO registry, and Workstream board. Then in this Lead turn perform exactly these four writes once each, in order: (1) publish one technology register revision ${techRevisionId} pinned to the exact baseline/specification/Graph above. Record only the existing ${technologyName} integration as required for this already existing Builder plugin. Explicitly set licenseReview status unreviewed with null expression and no evidence, and verification level not-verified with no evidence. State that no new research, license check, version compatibility, cost, or integration verification was performed. Do not invent alternatives or research. (2) register exactly one stable logical CTO id ${ctoId}, display name "Isolated Workstream Trial CTO", using this already selected Lead Agent and a separate keyed session; do not create an Agent or change account/configuration. Read the registry to verify that exact identity and session. (3) publish exactly one Workstream id ${workstreamId}, revision 1, for only Graph node ${graphNode.id}, using sourceSpecRevisionId ${baseline.baseline.specification.revisionId}, assignedCtoId ${ctoId}, and technologyDecisionsRef ${techRevisionId}. Specify included and excluded planning scope, no dependencies or interface contracts, acceptance/evidence that require only exact CTO read and acknowledgement, and change.previousRevision null with impactNodeIds containing only ${graphNode.id}. Use a new board revision id ${boardRevisionId}; read the board and capture its exact current revision id. (4) dispatch exactly once with projectId ${projectId}, workstreamId ${workstreamId}, specRevision 1, and the exact boardRevisionId returned by the board read. Dispatch must be your final tool operation. Immediately respond exactly SPS_WORKSTREAMS_DISPATCHED; do not wait for the CTO, read again, or dispatch again.

Unknown writes are never repeated: reconcile only by reading the same record, and an unknown dispatch must end this turn without another send. Use only these Lead tools: read-design-sources, read-design-draft, read-design-baseline, read-technology-decisions, publish-technology-decisions, create-cto, list-ctos, read-workstreams, publish-workstream, dispatch-workstream. Do not use code, commands, workers, QA, implementation, files, web search, or any other tool. This records a planning instruction and Core admission only, not implementation approval or completion.`;
  await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(message)});
    field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="메시지 보내기"]')?.disabled===false`), Boolean, "Workstream Lead send readiness");
  await click(workspace, 'button[aria-label="메시지 보내기"]', "Send one explicit planning-only Lead request");
  const completed = await eventually(async () => {
    const page = await conversation();
    if (page.active?.runId) await request(`/api/plugins/${plugin.id}/actions/builder.refresh-lead-conversation`, {
      method: "POST", body: { companyId: projectId, params: { channel: "main" } },
    });
    return conversation();
  }, page => page.totalTurns === 3 && page.active === null, "terminal third Lead run", 240_000);
  const leadTurn = completed.turns[0];
  assert.equal(leadTurn.state, "succeeded", "Do not create a replacement request after a failed/uncertain run.");
  assert.equal(leadTurn.answer?.trim(), "SPS_WORKSTREAMS_DISPATCHED");
  assert.equal(leadTurn.sessionId, leadSessions.sessions.main);

  const leadAllowed = ["builder.read-design-sources", "builder.read-design-draft", "builder.read-design-baseline",
    "builder.read-technology-decisions", "builder.publish-technology-decisions", "builder.create-cto", "builder.list-ctos",
    "builder.read-workstreams", "builder.publish-workstream", "builder.dispatch-workstream"].map(name => pluginPrefix + name);
  const leadCalls = await inspectScopedRun(request, leadTurn.runId, leadAllowed);
  const executedLeadCalls = leadCalls.filter(call => call.tool === "execute_plugin_tool");
  for (const [toolName, expected] of [["builder.publish-technology-decisions", 1], ["builder.create-cto", 1],
    ["builder.publish-workstream", 1], ["builder.dispatch-workstream", 1]]) {
    assert.equal(executedLeadCalls.filter(call => call.arguments?.toolName === pluginPrefix + toolName).length, expected,
      `${toolName} must be called exactly once.`);
  }
  for (const name of ["builder.read-design-baseline", "builder.read-technology-decisions", "builder.list-ctos", "builder.read-workstreams"]) {
    assert.ok(executedLeadCalls.some(call => call.arguments?.toolName === pluginPrefix + name), `${name} must be read before publication/dispatch.`);
  }
  const dispatchCall = executedLeadCalls.find(call => call.arguments?.toolName === pluginPrefix + "builder.dispatch-workstream");
  assert.ok(dispatchCall);
  assert.deepEqual(dispatchCall.arguments?.params, { projectId, workstreamId, specRevision: 1, boardRevisionId });
  assert.equal(leadCalls.at(-1), dispatchCall, "Dispatch must be the Lead's final tool operation; CTO observation happens after the Lead run ends.");

  const technology = await getTechnology();
  assert.equal(technology.sequence, 1);
  assert.equal(technology.record.register.revisionId, techRevisionId);
  assert.equal(technology.record.register.sourceBaselineRevisionId, baseline.baseline.revisionId);
  assert.equal(technology.record.register.sourceSpecRevisionId, baseline.baseline.specification.revisionId);
  assert.equal(technology.record.register.sourceGraphRevisionId, baseline.baseline.graph.graphRevisionId);
  assert.equal(technology.record.register.entries.length, 1);
  const techEntry = technology.record.register.entries[0];
  assert.equal(techEntry.technology, technologyName);
  assert.deepEqual(techEntry.scopeNodeIds, [graphNode.id]);
  assert.match(techEntry.selectionReason, /existing.*SDK/i);
  assert.equal(techEntry.licenseReview.status, "unreviewed");
  assert.equal(techEntry.licenseReview.licenseExpression, null);
  assert.deepEqual(techEntry.licenseReview.evidenceRefs, []);
  assert.equal(techEntry.verification.level, "not-verified");
  assert.deepEqual(techEntry.verification.evidenceRefs, []);

  const registry = await getCtos();
  assert.equal(registry.ctos.length, 1);
  const cto = registry.ctos[0];
  assert.equal(cto.ctoId, ctoId);
  assert.equal(cto.agentId, agent.id);
  assert.ok(cto.sessionId && !Object.values(leadSessions.sessions).includes(cto.sessionId));
  assert.equal((await sessions()).length, 4, "Three prepared Lead sessions and one independent CTO session are expected.");
  const boardNow = await getBoard();
  assert.ok(boardNow?.board);
  const workstream = boardNow.board.workstreams.find(row => row.spec.id === workstreamId);
  assert.ok(workstream);
  assert.equal(workstream.spec.revision, 1);
  assert.equal(workstream.spec.sourceSpecRevisionId, baseline.baseline.specification.revisionId);
  assert.equal(workstream.spec.technologyDecisionsRef, techRevisionId);
  assert.deepEqual(workstream.spec.scopeNodeIds, [graphNode.id]);
  assert.equal(workstream.sourceBaselineRevisionId, baseline.baseline.revisionId);
  assert.equal(workstream.baselineDigest, sha(baseline.baseline));
  assert.equal(workstream.technologyDigest, sha(technology.record));
  assert.equal(workstream.ctoAgentId, agent.id);
  assert.equal(workstream.ctoSessionId, cto.sessionId);
  assert.equal(workstream.author.runId, leadTurn.runId);
  assert.equal(workstream.change.previousRevision, null);
  assert.deepEqual(workstream.change.impactNodeIds, [graphNode.id]);
  assert.deepEqual(workstream.change.impactInterfaceContracts, []);
  assert.deepEqual(workstream.change.impactTaskIds, []);
  assert.ok(workstream.spec.excluded.some(text => /code|worker|qa|deployment/i.test(text)));

  // Dispatch is the Lead's final tool call. Observe the queued independent run only after its turn has ended.
  const ctoSession = await eventually(async () => (await sessions()).find(row => row.id === cto.sessionId),
    row => typeof row?.lastRunId === "string", "Core-scheduled registered CTO run", 120_000);
  const ctoRunId = ctoSession.lastRunId;
  const ctoRun = await eventually(() => request(`/api/heartbeat-runs/${ctoRunId}`), value => terminal.has(value.status),
    "terminal Core CTO run", 240_000);
  assert.equal(ctoRun.id, ctoRunId, "The Core heartbeat-run route returns its raw database id.");
  assert.equal(ctoRun.status, "succeeded", "A failed or uncertain CTO run is observed, never resent.");
  const acknowledged = await eventually(getBoard, value => value?.board?.workstreams?.some(row => row.spec.id === workstreamId
    && row.receipt?.runId === ctoRunId), "Core-bound CTO read and acknowledgement receipt", 45_000);
  const acknowledgedWorkstream = acknowledged.board.workstreams.find(row => row.spec.id === workstreamId);
  assert.equal(acknowledgedWorkstream.receipt.agentId, agent.id);
  assert.equal(acknowledgedWorkstream.receipt.sessionId, cto.sessionId);
  assert.equal(acknowledgedWorkstream.receipt.revision, 1);
  assert.ok(["ready", "needs-clarification", "blocked"].includes(acknowledgedWorkstream.receipt.readiness));
  assert.equal(acknowledgedWorkstream.spec.revision, 1);
  assert.equal(acknowledgedWorkstream.spec.sourceSpecRevisionId, baseline.baseline.specification.revisionId);
  assert.equal(acknowledgedWorkstream.ctoSessionId, cto.sessionId);

  const ctoAllowed = [pluginPrefix + "builder.read-cto-workstream", pluginPrefix + "builder.acknowledge-workstream"];
  const ctoCalls = await inspectScopedRun(request, ctoRunId, ctoAllowed);
  const executedCtoCalls = ctoCalls.filter(call => call.tool === "execute_plugin_tool");
  assert.equal(executedCtoCalls.filter(call => call.arguments?.toolName === pluginPrefix + "builder.read-cto-workstream").length, 1);
  assert.equal(executedCtoCalls.filter(call => call.arguments?.toolName === pluginPrefix + "builder.acknowledge-workstream").length, 1);
  const ctoRead = executedCtoCalls.find(call => call.arguments?.toolName === pluginPrefix + "builder.read-cto-workstream");
  const ctoAck = executedCtoCalls.find(call => call.arguments?.toolName === pluginPrefix + "builder.acknowledge-workstream");
  assert.deepEqual(ctoRead.arguments?.params, { projectId, ctoId, workstreamId });
  assert.equal(ctoAck.arguments?.params?.projectId, projectId);
  assert.equal(ctoAck.arguments?.params?.ctoId, ctoId);
  assert.equal(ctoAck.arguments?.params?.workstreamId, workstreamId);
  assert.equal(ctoAck.arguments?.params?.expectedBaseRevisionId, boardRevisionId);
  assert.equal(ctoAck.arguments?.params?.specRevision, 1);

  const allRuns = await runs();
  assert.equal(allRuns.length, 4, "Exactly three Lead runs and one registered CTO run are expected.");
  const runIds = new Set(allRuns.map(run => run.runId ?? run.id));
  for (const runId of [...leadRuns.map(run => run.runId), leadTurn.runId, ctoRunId]) assert.ok(runIds.has(runId));
  const agentAfter = await request(`/api/agents/${agent.id}`);
  assert.deepEqual(agentAfter.adapterConfig, agent.adapterConfig, "The existing trial Agent configuration must remain unchanged.");
  assert.deepEqual(await readdir(workingDirectory), [], "The temporary Agent working directory must remain empty.");
  assert.deepEqual(await data(request, plugin.id, "builder.snapshot", {}, secondCompany.id), beforeOther);

  workspace = await restart({ companyPrefix: company.issuePrefix, pluginId: plugin.id, readySelector: ".builder-shell" });
  const baselineAfter = await getBaseline();
  assert.deepEqual(baselineAfter, baseline);
  assert.deepEqual(await getTechnology(), technology);
  assert.deepEqual(await getCtos(), registry);
  const boardAfter = await getBoard();
  assert.deepEqual(boardAfter, acknowledged);
  assert.deepEqual(await conversation(), completed);
  assert.deepEqual(await data(request, plugin.id, "builder.design-draft", { projectId }, projectId), draft);
  assert.deepEqual(await data(request, plugin.id, "builder.snapshot", {}, secondCompany.id), beforeOther);
  assert.equal((await runs()).length, 4);
  assert.equal((await sessions()).length, 4);
  assert.deepEqual((await request(`/api/agents/${agent.id}`)).adapterConfig, agent.adapterConfig);
  assert.deepEqual(await readdir(workingDirectory), []);

  console.log(JSON.stringify({ liveWorkstreams: true, aiExecuted: true, actualUiLeadTurns: 3, actualProviderRuns: 4,
    leadRuns: 3, independentCtoRuns: 1, registeredCtoSessions: 1, technologyRegisterWrites: 1,
    workstreamWrites: 1, dispatchCalls: 1, ctoReadCalls: 1, ctoAcknowledgementCalls: 1,
    exactCoreReceiptObserved: true, terminalCoreRunObserved: true, readinessIsNotImplementation: true,
    sourceRevisionBound: true, sameAgentConfigurationPreserved: true, temporaryWorkingDirectoryEmpty: true,
    restartRetained: true, otherWorkspaceUnchanged: true, codeWorkersQaAndCommands: false,
    installedProfileChanged: false, mcpApprovalPolicyOverridden: false, cleanupQualificationPending: true }));
}

export async function runAcceptance(context) {
  await runWorkstreamsAcceptance(context);
}
