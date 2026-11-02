import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsAgentSessionRunResult } from "@sonparkserver/plugin-sdk/platform";
import { createLeadConversationStore, parseLeadConversationPage } from "../src/lead-conversations.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import type { BuilderLeadSessions } from "../src/domain/model.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const MAIN = "44444444-4444-4444-8444-444444444444";
const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const sessions = (workspaceId = A): BuilderLeadSessions => ({ workspaceId, selectionRevision: 1, agentId: AGENT,
  sessions: { main: MAIN, "cto-inbox": "55555555-5555-4555-8555-555555555555", decisions: "66666666-6666-4666-8666-666666666666" } });
function fixture() {
  const state = new Map<string, JsonValue>();
  const receipts = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const runs = new Map<string, SpsAgentSessionRunResult>();
  const sends: Array<{ sessionId: string; workspaceId: string; requestId: string; prompt: string }> = [];
  let current = true, loseResponse = false, noAcceptance = false;
  const key = (input: { scopeId?: string; stateKey: string }) => `${input.scopeId}:${input.stateKey}`;
  const platform = {
    state: {
      async get(input: { scopeId?: string; stateKey: string }) { return structuredClone(state.get(key(input)) ?? null); },
      async set(input: { scopeId?: string; stateKey: string }, value: JsonValue) { state.set(key(input), structuredClone(value)); },
      async delete() { throw new Error("Chat must not delete history"); },
    }, agents: { sessions: {
      async sendMessage(sessionId: string, workspaceId: string, opts: { requestId: string; prompt: string }) {
        sends.push({ sessionId, workspaceId, ...opts });
        if (noAcceptance) throw new Error("unknown admission");
        const runId = uuid(1000 + sends.length);
        receipts.set(`${workspaceId}:${opts.requestId}`, { requestId: opts.requestId, state: "submitted", runId });
        runs.set(runId, { runId, status: "running", cancellationRequested: false, termination: "not_applicable",
          error: null, errorCode: null, output: { state: "not_ready", text: null } });
        if (loseResponse) throw new Error("response body lost");
        return { runId };
      },
      async getRequest(_sessionId: string, workspaceId: string, requestId: string) { return structuredClone(receipts.get(`${workspaceId}:${requestId}`) ?? null); },
      async getRun(_sessionId: string, _workspaceId: string, runId: string) { return structuredClone(runs.get(runId)); },
      async cancel(_sessionId: string, _workspaceId: string, runId: string) {
        const result: SpsAgentSessionRunResult = { ...runs.get(runId)!, status: "cancelled", cancellationRequested: true,
          termination: "pending", output: { state: "withheld", text: null, reason: "not_successful" } };
        runs.set(runId, result); return result;
      },
    } },
  } as unknown as SpsPlatformInvocationContext;
  const check = async () => { if (!current) throw new Error("selection retired"); };
  const store = createLeadConversationStore(platform, sessions(), check);
  function complete(runId = sends.length ? uuid(1000 + sends.length) : "", answer = "A real stored answer") {
    runs.set(runId, { ...runs.get(runId)!, status: "succeeded", output: { state: "available", text: answer } });
  }
  return { state, platform, sends, receipts, runs, store, check, complete,
    retire() { current = false; }, lose() { loseResponse = true; }, rejectAdmission() { noAcceptance = true; } };
}

test("writes bounded per-turn records, then reads persisted answers without growing the original snapshot", async () => {
  const f = fixture();
  await f.store.send("main", uuid(1), "First question");
  assert.equal(f.sends.length, 1);
  assert.equal(f.state.has(`${A}:snapshot.v1`), false);
  let page = await f.store.page("main");
  assert.equal(page.totalTurns, 1); assert.equal(page.active?.state, "submitted");
  assert.equal(page.turns[0]?.text, "First question");
  f.complete(); await f.store.refresh("main");
  page = await createLeadConversationStore(f.platform, sessions(), f.check).page("main");
  assert.equal(page.active, null); assert.equal(page.turns[0]?.answer, "A real stored answer");
  assert.equal(page.turns[0]?.state, "succeeded");
  assert.equal((await f.store.page("decisions")).totalTurns, 0);
  assert.equal((await createLeadConversationStore(f.platform, sessions(B), f.check).page("main")).totalTurns, 0);
});

test("question association is persisted with raw answer text and sent explicitly to the decisions session", async () => {
  const f = fixture();
  const context = { projectId: A, draftRevisionId: "draft-1", questionId: "Q-1" };
  await f.store.send("decisions", uuid(71), "Use a desktop app.", context);
  context.questionId = "caller-mutated";
  const page = await f.store.page("decisions");
  assert.deepEqual(page.turns[0]?.questionContext, { projectId: A, draftRevisionId: "draft-1", questionId: "Q-1" });
  assert.equal(page.turns[0]?.text, "Use a desktop app.");
  assert.match(f.sends[0]!.prompt, /not approval or execution authority/);
  assert.match(f.sends[0]!.prompt, /"questionId":"Q-1"/);
  assert.equal(f.sends[0]!.sessionId, sessions().sessions.decisions);
  await f.store.send("decisions", uuid(71), "Use a desktop app.", page.turns[0]!.questionContext);
  await assert.rejects(f.store.send("decisions", uuid(71), "Use a desktop app.", context));
  await assert.rejects(f.store.send("main", uuid(72), "Wrong channel", context));
  assert.equal(f.sends.length, 1);
});

test("prepared question resume rechecks exact association, while submitted request recovery skips new-dispatch validation", async () => {
  const f = fixture();
  const original = f.platform.state.set;
  let crash = true;
  f.platform.state.set = async (key, value) => {
    if (crash && (value as Record<string, JsonValue>).state === "dispatching") { crash = false; throw new Error("before dispatch"); }
    return original(key, value);
  };
  const context = { projectId: A, draftRevisionId: "draft-1", questionId: "Q-1" };
  await assert.rejects(f.store.send("decisions", uuid(73), "Desktop", context), /before dispatch/);
  let fresh = false;
  const store = createLeadConversationStore(f.platform, sessions(), f.check, async observed => {
    assert.deepEqual(observed, context);
    if (!fresh) throw new Error("stale question");
  });
  await assert.rejects(store.resumePrepared("decisions", uuid(73)), /stale question/);
  assert.equal(f.sends.length, 0);
  fresh = true;
  await store.resumePrepared("decisions", uuid(73));
  fresh = false;
  await store.send("decisions", uuid(73), "Desktop", context);
  assert.equal(f.sends.length, 1);
});

test("same request rechecks its run and never invokes a second send, including after a restart", async () => {
  const f = fixture();
  await f.store.send("main", uuid(1), "First question");
  const restarted = createLeadConversationStore(f.platform, sessions(), f.check);
  await restarted.send("main", uuid(1), "First question");
  await assert.rejects(restarted.send("main", uuid(1), "Different question"));
  await assert.rejects(restarted.send("decisions", uuid(1), "First question"));
  assert.equal(f.sends.length, 1);
});

test("an unavailable Agent blocks new sends but cannot prevent recovery of a previous request", async () => {
  const f = fixture(); let available = true;
  const store = createLeadConversationStore(f.platform, sessions(), f.check, async () => { if (!available) throw new Error("Agent unavailable"); });
  await store.send("main", uuid(1), "First question");
  f.complete(); await store.refresh("main"); available = false;
  await store.send("main", uuid(1), "First question");
  await assert.rejects(store.send("main", uuid(2), "Next question"), /Agent unavailable/);
  assert.equal(f.sends.length, 1);
});

test("lost send response reconciles the same Core request receipt and never resends", async () => {
  const f = fixture(); f.lose();
  await f.store.send("main", uuid(1), "First question");
  assert.equal((await f.store.page("main")).active?.state, "uncertain");
  await assert.rejects(f.store.resumePrepared("main", uuid(1)));
  assert.equal(f.sends.length, 1);
  await f.store.refresh("main");
  assert.equal((await f.store.page("main")).active?.state, "submitted");
  f.complete(); await f.store.refresh("main");
  assert.equal((await f.store.page("main")).turns[0]?.answer, "A real stored answer");
  assert.equal(f.sends.length, 1);
});

test("a persisted prepared turn resumes after a pre-dispatch crash and sends exactly once", async () => {
  const f = fixture(); const original = f.platform.state.set;
  let crash = true;
  f.platform.state.set = async (key, value) => {
    if (crash && (value as Record<string, JsonValue>).state === "dispatching") {
      crash = false;
      throw new Error("worker stopped before dispatch");
    }
    return original(key, value);
  };

  await assert.rejects(f.store.send("main", uuid(1), "First question"), /worker stopped/);
  assert.equal(f.sends.length, 0);
  const turn = f.state.get(`${A}:lead-chat.turn.v1.${uuid(1)}`) as Record<string, JsonValue>;
  assert.equal(turn.state, "prepared");
  assert.equal((await f.store.page("main")).active?.state, "prepared");

  const restarted = createLeadConversationStore(f.platform, sessions(), f.check);
  assert.deepEqual(await restarted.resumePrepared("main", uuid(1)), { saved: true, requestId: uuid(1) });
  await assert.rejects(restarted.resumePrepared("main", uuid(1)));
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0], { sessionId: MAIN, workspaceId: A, requestId: uuid(1), prompt: "First question" });
});

test("unknown admission stays blocked and does not turn a null receipt into replay permission", async () => {
  const f = fixture(); f.rejectAdmission();
  await f.store.send("main", uuid(1), "First question");
  await f.store.refresh("main");
  await f.store.send("main", uuid(1), "First question");
  await assert.rejects(f.store.send("main", uuid(2), "Next question"));
  await assert.rejects(f.store.cancel("main"));
  assert.equal(f.sends.length, 1);
  assert.equal((await f.store.page("main")).active?.state, "uncertain");
});

test("an older Host without request receipts is rejected before saving or sending a turn", async () => {
  const f = fixture();
  f.platform.agents.sessions.getRequest = async () => { throw new Error("Method not found"); };
  await assert.rejects(f.store.send("main", uuid(1), "First question"), /Method not found/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.state.size, 0);
});

test("failed acceptance persistence recovers after restart without a replacement request", async () => {
  const f = fixture(); const original = f.platform.state.set;
  let fail = true;
  f.platform.state.set = async (key, value) => {
    if (fail && (value as Record<string, JsonValue>).state === "submitted") { fail = false; throw new Error("disk unavailable"); }
    return original(key, value);
  };
  await f.store.send("main", uuid(1), "First question");
  await createLeadConversationStore(f.platform, sessions(), f.check).refresh("main");
  assert.equal((await f.store.page("main")).active?.state, "submitted");
  assert.equal(f.sends.length, 1);
});

test("a failed head save can recover only the same prepared turn, not an orphan or altered input", async () => {
  const f = fixture(); const original = f.platform.state.set;
  let fail = true;
  f.platform.state.set = async (key, value) => {
    if (fail && key.stateKey.startsWith("lead-chat.head")) { fail = false; throw new Error("head save failed"); }
    return original(key, value);
  };
  await assert.rejects(f.store.send("main", uuid(1), "First question"));
  assert.equal(f.sends.length, 0);
  await f.store.send("main", uuid(1), "First question");
  assert.equal(f.sends.length, 1);
  const g = fixture(); const save = g.platform.state.set; let rejectHead = true;
  g.platform.state.set = async (key, value) => {
    if (rejectHead && key.stateKey.startsWith("lead-chat.head")) { rejectHead = false; throw new Error("head save failed"); }
    return save(key, value);
  };
  await assert.rejects(g.store.send("main", uuid(1), "Orphan"));
  await g.store.send("main", uuid(2), "Published");
  await assert.rejects(g.store.page("main", uuid(1)));
  await assert.rejects(g.store.send("main", uuid(1), "Orphan"));
  assert.equal(g.sends.length, 1);
});

test("linked pagination returns exact bounded pages and preserves all older turns", async () => {
  const f = fixture();
  for (let n = 1; n <= 13; n++) {
    await f.store.send("main", uuid(n), `Question ${n}`); f.complete(); await f.store.refresh("main");
  }
  const first = await f.store.page("main");
  assert.equal(first.turns.length, 10); assert.equal(first.turns[0]?.sequence, 12);
  assert.equal(first.nextCursor, uuid(3));
  const second = await f.store.page("main", first.nextCursor);
  assert.equal(second.turns.length, 3); assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.turns, ...second.turns].map(t => t.sequence), Array.from({ length: 13 }, (_, n) => 12 - n));
  const g = fixture();
  for (let n = 1; n <= 3; n++) { await g.store.send("main", uuid(n), "x".repeat(16 * 1024)); g.complete(undefined, "y".repeat(65_536)); await g.store.refresh("main"); }
  const large = await g.store.page("main");
  assert.equal(large.turns.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(large)) < 132 * 1024);
});

test("cancel acknowledgement remains pending until termination is confirmed and does not permit new work", async () => {
  const f = fixture(); await f.store.send("main", uuid(1), "First question");
  assert.deepEqual(await f.store.cancel("main"), { cancellationRequested: true });
  assert.equal((await f.store.page("main")).active?.termination, "pending");
  await assert.rejects(f.store.send("main", uuid(2), "Next question"));
  const runId = uuid(1001); f.runs.set(runId, { ...f.runs.get(runId)!, termination: "confirmed" });
  await f.store.refresh("main");
  assert.equal((await f.store.page("main")).active, null);
  await f.store.send("main", uuid(2), "Next question"); assert.equal(f.sends.length, 2);
});

test("retired selections, malformed input, unknown fields and foreign stored state fail closed", async () => {
  const f = fixture();
  for (const value of ["", "x".repeat(16 * 1024 + 1), "\u0000", "\ud800"]) await assert.rejects(f.store.send("main", uuid(1), value));
  await assert.rejects(f.store.send("main", "not-a-uuid", "Question"));
  await f.store.send("main", uuid(1), "Question");
  const key = `${A}:lead-chat.turn.v1.${uuid(1)}`;
  const saved = structuredClone(f.state.get(key)!);
  f.state.set(key, { ...(saved as Record<string, JsonValue>), privateField: "not permitted" });
  await assert.rejects(f.store.page("main"));
  f.state.set(key, { ...(saved as Record<string, JsonValue>), workspaceId: B });
  await assert.rejects(f.store.page("main"));
  f.state.set(key, saved); f.retire();
  await assert.rejects(f.store.refresh("main")); await assert.rejects(f.store.cancel("main"));
  assert.equal(f.sends.length, 1);
});

test("bad run identity or invalid successful output never becomes an assistant answer", async () => {
  const f = fixture(); await f.store.send("main", uuid(1), "Question");
  f.runs.set(uuid(1001), { ...f.runs.get(uuid(1001))!, runId: uuid(999) });
  await assert.rejects(f.store.refresh("main"));
  f.runs.set(uuid(1001), { ...f.runs.get(uuid(1001))!, runId: uuid(1001), status: "succeeded", output: { state: "available", text: "x".repeat(65_537) } });
  await assert.rejects(f.store.refresh("main"));
  assert.equal((await f.store.page("main")).turns[0]?.answer, null);
});

test("the public page parser rejects foreign sessions, sparse pages and unknown activity fields", async () => {
  const f = fixture(); await f.store.send("main", uuid(1), "Question");
  const page = await f.store.page("main");
  assert.deepEqual(parseLeadConversationPage(page, sessions(), "main"), page);
  for (const patch of [{ workspaceId: B }, { sessionId: uuid(999) }, { turns: Array(1) },
    { active: { ...page.active!, token: "not allowed" } }, { nextCursor: uuid(999) }]) {
    assert.throws(() => parseLeadConversationPage({ ...page, ...patch }, sessions(), "main"));
  }
});

test("Host render environment metadata is excluded from strict conversation data input", async () => {
  const f = fixture();
  f.state.set(`${A}:lead-agent.v1`, { workspaceId: A, revision: 1, selectedAgentId: AGENT });
  f.state.set(`${A}:lead-sessions.v1.1`, sessions() as unknown as JsonValue);
  const handler = createBuilderPlatform().data.find(value => value.key === "builder.lead-conversation")!;
  const page = await handler.handler({ companyId: A, channel: "main", cursor: null,
    renderEnvironment: { colorScheme: "dark", resolvedTheme: "dark" } }, f.platform);
  assert.equal((page as Record<string, JsonValue>).totalTurns, 0);
  assert.equal(Object.hasOwn(page as object, "renderEnvironment"), false);
  assert.equal(f.sends.length, 0);
});

test("conversation actions reject non-user scope and internal Lead intake before any execution", async () => {
  const f = fixture(); const contract = createBuilderPlatform();
  for (const key of ["builder.send-lead-message", "builder.refresh-lead-conversation", "builder.cancel-lead-message", "builder.resume-prepared-lead-message"]) {
    const handler = contract.actions.find(value => value.key === key)!;
    await assert.rejects(Promise.resolve().then(() => handler.handler({ channel: "main", requestId: uuid(1), text: "question" }, {
      ...f.platform, companyId: A, actor: { type: "agent", companyId: A },
    })), /authenticated user/);
    await assert.rejects(Promise.resolve().then(() => handler.handler({ companyId: B, channel: "main" }, {
      ...f.platform, companyId: A, actor: { type: "user", companyId: A },
    })), /trusted Workspace/);
  }
  const send = contract.actions.find(value => value.key === "builder.send-lead-message")!;
  await assert.rejects(Promise.resolve().then(() => send.handler({ channel: "cto-inbox", requestId: uuid(1), text: "question" }, {
    ...f.platform, companyId: A, actor: { type: "user", companyId: A },
  })), /internal Lead intake/);
  assert.equal(f.sends.length, 0); assert.equal(f.state.size, 0);
});
