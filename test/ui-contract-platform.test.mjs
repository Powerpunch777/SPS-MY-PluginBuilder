import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createBuilderPlatform } from "../src/platform.ts";
import { createDesignDraftStore } from "../src/design-draft-store.ts";
import { readLeadUserSource } from "../src/lead-conversations.ts";
import { LEAD_CHANNELS } from "../src/domain/lead-sessions.ts";

const uuid = n => `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const W = uuid(1), A = uuid(2), U = uuid(3), R = uuid(4);
const hash = value => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const values = new Map(), receipts = new Map(), sends = [];
  let runStatus = "running", loseAdmission = false;
  const state = {
    async get(key) { return structuredClone(values.get(JSON.stringify(key)) ?? null); },
    async set(key, value) { values.set(JSON.stringify(key), structuredClone(value)); },
    async compareAndSet(key, expected, value) {
      const id = JSON.stringify(key), exists = values.has(id);
      const swapped = expected.exists ? exists && JSON.stringify(values.get(id)) === JSON.stringify(expected.value) : !exists;
      if (swapped) values.set(id, structuredClone(value));
      return { swapped };
    },
  };
  const key = stateKey => ({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey });
  const sessions = Object.fromEntries(LEAD_CHANNELS.map((channel, index) => [channel, uuid(index + 20)]));
  await state.set(key("lead-agent.v1"), { workspaceId: W, revision: 1, selectedAgentId: A });
  await state.set(key("lead-sessions.v1.1"), { workspaceId: W, selectionRevision: 1, agentId: A, sessions });
  const platform = { state, agents: {
    async list() { return [{ id: A, name: "Lead", companyId: W, status: "idle" }]; },
    sessions: {
      async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run", readiness: "unknown", osIsolation: "not-certified" }; },
      async getRequest(_session, _workspace, requestId) { return receipts.get(requestId) ?? null; },
      async sendMessage(sessionId, companyId, input) {
        const runId = uuid(100 + sends.length);
        sends.push({ sessionId, companyId, ...input, runId });
        if (loseAdmission) throw new Error("Unconfirmed Host admission");
        receipts.set(input.requestId, { state: "submitted", requestId: input.requestId, runId });
        return { runId };
      },
      async getRun(_session, _workspace, runId) { return { runId, status: runStatus, cancellationRequested: false,
        termination: "not_applicable", output: runStatus === "succeeded" ? { state: "available", text: "Done" }
          : { state: "not_ready", text: null }, error: null, errorCode: null }; },
    },
  } };
  const draft = { projectId: W, revisionId: "draft-1", sourceIds: [`consultation-${uuid(9)}`],
    specification: { revisionId: "spec-1", productTier: "S", requirements: [{ id: "REQ-1", description: "Show a save action.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["web-api"], dataPolicyRef: "policy-1" },
    graph: { graphRevisionId: "graph-1", entities: [], relations: [], viewLayoutRef: "layout-1" }, questions: [] };
  await createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, state).publish({ expectedBaseRevisionId: null,
    revision: { status: "draft", selectionRevision: 1, author: { agentId: A, sessionId: sessions.main, runId: R },
      sourceDigests: [{ id: draft.sourceIds[0], sha256: hash("Customer source") }], createdAt: "2026-11-06T00:00:00.000Z", draft } });
  const contract = createBuilderPlatform();
  const tool = name => contract.tools.find(row => row.name === name).handler;
  const actionFor = key => contract.actions.find(row => row.key === key).handler;
  const action = actionFor("builder.approve-ui-proposal");
  const data = contract.data.find(row => row.key === "builder.ui-contracts").handler;
  const context = channel => ({ companyId: W, agentId: A, runId: R, sessionId: sessions[channel] });
  const html = "<main><button>Save</button></main>";
  const proposal = { revisionId: "ui-proposal-1", expectedBaseRevisionId: null, source: { kind: "draft", revisionId: "draft-1" },
    artifact: { artifactId: "ui-html-1", html, htmlSha256: hash(html), screenIds: ["home"], viewport: { width: 1280, height: 800 },
      sourceSessionId: sessions["ui-design"], sourceSpecRevisionId: "spec-1" },
    contract: { projectId: W, revisionId: "ui-contract-1", screenIds: ["home"], interactions: [{ id: "save", screenId: "home",
      requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [], outcomes: ["saved"], prohibited: [],
      validationCriteria: ["explicit action"], status: "specified" }] } };
  const user = { ...platform, companyId: W, actor: { type: "user", companyId: W, userId: U } };
  return { platform, sessions, sends, tool, action, actionFor, data, context, proposal, user,
    complete: () => { runStatus = "succeeded"; }, loseAdmission: () => { loseAdmission = true; } };
}

test("registered draft-to-UI approval flow keeps user approval, Main publication and notification provenance separate", async () => {
  const f = await fixture();
  await assert.rejects(() => f.tool("builder.propose-ui-contract")(f.proposal, f.context("main"), f.platform), /Only UI Design/);
  assert.equal((await f.tool("builder.propose-ui-contract")(f.proposal, f.context("ui-design"), f.platform)).data.status, "published");
  const current = await f.data({ companyId: W }, f.platform);
  assert.equal(current.proposalCurrent, true);
  assert.equal(current.approval, null);
  assert.equal(f.sends.length, 0);
  const input = { revisionId: uuid(50), expectedBaseRevisionId: null, proposalRevisionId: f.proposal.revisionId,
    htmlSha256: f.proposal.artifact.htmlSha256, approvedInteractionIds: ["save"] };
  await assert.rejects(() => f.action(input, { ...f.user, actor: { type: "agent", companyId: W } }), /authenticated user/);
  const approved = await f.action(input, f.user);
  assert.equal(approved.status, "published");
  assert.equal(approved.mainNotification.status, "run-accepted");
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].sessionId, f.sessions.main);
  assert.equal((await f.action(input, f.user)).status, "replayed");
  assert.equal(f.sends.length, 1);
  await assert.rejects(() => readLeadUserSource(f.sends[0].requestId,
    { workspaceId: W, selectionRevision: 1, agentId: A, sessions: f.sessions }, f.platform), /not user-provided/);
  const formal = await f.tool("builder.publish-ui-contract")({ revisionId: "ui-formal-1", expectedBaseRevisionId: null,
    proposalRevisionId: f.proposal.revisionId, approvalRevisionId: input.revisionId },
  { ...f.context("main"), runId: f.sends[0].runId }, f.platform);
  assert.equal(formal.data.status, "published");
  assert.equal(formal.data.revision.reviewByInteractionId.save, "APPROVED");
  assert.equal((await f.data({ companyId: W }, f.platform)).formal.sourceProposalRevisionId, f.proposal.revisionId);
});

test("the owning Workspace action retries only the current approval with the same request key after Main is idle", async () => {
  const f = await fixture();
  await f.tool("builder.propose-ui-contract")(f.proposal, f.context("ui-design"), f.platform);
  await f.actionFor("builder.send-lead-message")({ channel: "main", requestId: uuid(60), text: "Existing work" }, f.user);
  const input = { revisionId: uuid(61), expectedBaseRevisionId: null, proposalRevisionId: f.proposal.revisionId,
    htmlSha256: f.proposal.artifact.htmlSha256, approvedInteractionIds: ["save"] };
  const approval = await f.action(input, f.user);
  assert.equal(approval.mainNotification.status, "unconfirmed");
  assert.equal(approval.status, "published");
  const retry = f.actionFor("builder.retry-ui-approval-notification");
  await assert.rejects(() => retry({ approvalRevisionId: input.revisionId }, { ...f.user, actor: { type: "agent", companyId: W } }), /authenticated user/);
  assert.equal((await retry({ approvalRevisionId: uuid(62) }, f.user)).status, "stale");
  assert.equal(f.sends.length, 1);
  f.complete();
  const [first, repeated] = await Promise.all([retry({ approvalRevisionId: input.revisionId }, f.user), retry({ approvalRevisionId: input.revisionId }, f.user)]);
  assert.equal(first.status, "run-accepted");
  assert.deepEqual(repeated, first);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].sessionId, f.sessions.main);
});

test("unconfirmed Host admission never becomes a duplicate send", async () => {
  const f = await fixture();
  await f.tool("builder.propose-ui-contract")(f.proposal, f.context("ui-design"), f.platform);
  f.loseAdmission();
  const input = { revisionId: uuid(63), expectedBaseRevisionId: null, proposalRevisionId: f.proposal.revisionId,
    htmlSha256: f.proposal.artifact.htmlSha256, approvedInteractionIds: ["save"] };
  assert.equal((await f.action(input, f.user)).mainNotification.status, "unconfirmed");
  assert.equal((await f.actionFor("builder.retry-ui-approval-notification")({ approvalRevisionId: input.revisionId }, f.user)).status, "unconfirmed");
  assert.equal(f.sends.length, 1);
});

test("a replaced proposal cannot be newly approved using a stale screen", async () => {
  const f = await fixture();
  await f.tool("builder.propose-ui-contract")(f.proposal, f.context("ui-design"), f.platform);
  await f.tool("builder.propose-ui-contract")({ ...f.proposal, revisionId: "ui-proposal-2", expectedBaseRevisionId: f.proposal.revisionId },
    f.context("ui-design"), f.platform);
  await assert.rejects(() => f.action({ revisionId: uuid(64), expectedBaseRevisionId: null, proposalRevisionId: f.proposal.revisionId,
    htmlSha256: f.proposal.artifact.htmlSha256, approvedInteractionIds: ["save"] }, f.user), /no longer current/);
  assert.equal((await f.data({ companyId: W }, f.platform)).approval, null);
  assert.equal(f.sends.length, 0);
});
