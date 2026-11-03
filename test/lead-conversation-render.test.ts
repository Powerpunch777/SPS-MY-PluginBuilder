import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { BuilderSnapshot, BuilderShellProps } from "../src/domain/model.ts";
import type { BuilderLeadContexts, LeadContextId } from "../src/domain/lead-contexts.ts";
import { parseLeadConversationPage, type LeadConversationPage, type LeadTurn } from "../src/lead-conversations.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_IDS: Record<LeadContextId, string> = {
  user_conversation: "33333333-3333-4333-8333-333333333333",
  ui_design: "44444444-4444-4444-8444-444444444444",
  background_planning: "55555555-5555-4555-8555-555555555555",
  question_intake: "66666666-6666-4666-8666-666666666666",
  question_discussion: "77777777-7777-4777-8777-777777777777",
};
const LEGACY_SESSION_IDS = {
  main: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "cto-inbox": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  decisions: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

const contexts: BuilderLeadContexts = {
  schemaVersion: 2,
  workspaceId: WORKSPACE_ID,
  selectionRevision: 4,
  agentId: AGENT_ID,
  requestId: null,
  status: "ready",
  pendingContext: null,
  contexts: SESSION_IDS,
};

function snapshot(ai: BuilderSnapshot["integrations"]["ai"] = "ready"): BuilderSnapshot {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    revision: 2,
    leadSessions: LEGACY_SESSION_IDS,
    actors: [{ id: "lead-actor", role: "lead", label: "Lead", parentActorId: null, agentId: AGENT_ID,
      sessionId: LEGACY_SESSION_IDS.main, status: "running" }],
    messages: [],
    documents: [],
    questions: [],
    graph: { revisionId: null, entities: [], relations: [] },
    activity: [],
    integrations: { ai, github: "not_configured", htmlPreview: "unavailable" },
  };
}

function turn(overrides: Partial<LeadTurn> = {}): LeadTurn {
  return {
    workspaceId: WORKSPACE_ID,
    selectionRevision: 4,
    agentId: AGENT_ID,
    sessionId: SESSION_IDS.user_conversation,
    channel: "user_conversation",
    schemaVersion: 1,
    requestId: "66666666-6666-4666-8666-666666666666",
    previousRequestId: null,
    sequence: 0,
    text: "Need a bounded implementation plan",
    createdAt: "2026-11-02T00:00:00.000Z",
    state: "succeeded",
    runId: "77777777-7777-4777-8777-777777777777",
    answer: "Use a small domain module",
    outputState: "available",
    cancellationRequested: false,
    termination: "not_applicable",
    ...overrides,
  };
}

function conversationPage(turns: LeadTurn[], active: LeadConversationPage["active"] = null, nextCursor: string | null = null,
  totalTurns = turns.length) {
  const raw = {
    workspaceId: WORKSPACE_ID,
    selectionRevision: 4,
    agentId: AGENT_ID,
    sessionId: SESSION_IDS.user_conversation,
    channel: "user_conversation" as const,
    totalTurns,
    active,
    turns,
    nextCursor,
  };
  return parseLeadConversationPage(raw, contexts, "user_conversation");
}

function baseProps(overrides: Partial<BuilderShellProps> = {}): BuilderShellProps {
  return {
    snapshot: snapshot(),
    workspaceLabel: "Studio",
    conversation: conversationPage([turn()]),
    conversationChannel: "user_conversation",
    onRefresh() {},
    ...overrides,
  };
}

async function renderShell(props: BuilderShellProps): Promise<string> {
  const result = await build({
      entryPoints: [path.join(projectRoot, "src", "ui", "BuilderShell.tsx")],
      bundle: true,
      write: false,
      external: ["react", "react-dom", "react-dom/server"],
      platform: "node",
      format: "esm",
      jsx: "automatic",
      loader: { ".css": "text" },
      plugins: [{
        name: "react-flow-ssr-stub",
        setup(builder) {
          builder.onResolve({ filter: /^@xyflow\/react$/ }, () => ({ path: "xyflow", namespace: "conversation-test" }));
          builder.onResolve({ filter: /^@xyflow\/react\/dist\/style\.css$/ }, () => ({ path: "xyflow-css", namespace: "conversation-test" }));
          builder.onLoad({ filter: /.*/, namespace: "conversation-test" }, args => args.path === "xyflow-css"
            ? { contents: "", loader: "text" }
            : { contents: `import { jsx } from "react/jsx-runtime";
              export const MarkerType = { ArrowClosed: "arrowclosed" };
              export const ReactFlow = ({ children }) => jsx("div", { "data-test-react-flow": "true", children });
              export const Background = () => null;
              export const Controls = () => null;`, loader: "jsx" });
        },
      }],
    });
    const output = result.outputFiles[0];
    assert.ok(output, "esbuild returns the in-memory UI bundle");
    const filename = path.join(projectRoot, "node_modules", ".ui-test-BuilderShell.cjs");
    const compiled = new Module(filename) as unknown as {
      filename: string;
      paths: string[];
      exports: { BuilderShell: typeof import("../src/ui/BuilderShell.tsx").BuilderShell };
      _compile(source: string, filename: string): void;
    };
    compiled.filename = filename;
    compiled.paths = createRequire(import.meta.url).resolve.paths("react") ?? [];
    compiled._compile(output.text, filename);
    const { BuilderShell } = compiled.exports;
    return renderToStaticMarkup(createElement(BuilderShell, props));
}

test("renders scoped user and assistant text as escaped content", async () => {
  const userText = '<img src=x onerror="alert(1)">';
  const answer = "<script>not executable</script>";
  const page = conversationPage([turn({ text: userText, answer })]);
  const html = await renderShell(baseProps({ conversation: page }));

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.doesNotMatch(html, /<script>not executable<\/script>/);
});

test("renders failed turns as system messages without fabricating an assistant answer", async () => {
  const page = conversationPage([turn({ state: "failed", answer: null, outputState: "not_ready" })]);
  const html = await renderShell(baseProps({ conversation: page }));

  assert.match(html, /실행 실패/);
  assert.doesNotMatch(html, /Use a small domain module/);
});

test("shows active cancellation and pending termination state", async () => {
  const current = turn({ state: "submitted", answer: null, outputState: "not_ready", cancellationRequested: true, termination: "pending" });
  const page = conversationPage([current], {
    requestId: current.requestId,
    state: current.state,
    runId: current.runId,
    cancellationRequested: true,
    termination: "pending",
  });
  const html = await renderShell(baseProps({ conversation: page, onCancelLeadMessage: async () => {} }));

  assert.match(html, /실행 중단/);
  assert.match(html, /종료 확인 대기/);
  assert.match(html, /실행 중 · 응답 확인 가능/);
});

test("renders the explicit resume action for a prepared Main turn without invoking it", async () => {
  const prepared = turn({ state: "prepared", runId: null, answer: null, outputState: "not_ready" });
  let resumeCalls = 0;
  const html = await renderShell(baseProps({
    conversation: conversationPage([prepared], {
      requestId: prepared.requestId,
      state: prepared.state,
      runId: null,
      cancellationRequested: false,
      termination: "not_applicable",
    }),
    onResumePreparedLeadMessage: async () => { resumeCalls += 1; },
  }));

  assert.match(html, /저장된 메시지 전송/);
  assert.match(html, /저장됨 · 전송 준비 중/);
  assert.equal(resumeCalls, 0, "rendering does not automatically invoke the explicit resume action");
});

test("renders older/latest page controls from scoped cursor props", async () => {
  const oldestOnPage = turn({
    requestId: "99999999-9999-4999-8999-999999999999",
    previousRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sequence: 1,
  });
  const newestOnPage = turn({
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    previousRequestId: oldestOnPage.requestId,
    sequence: 2,
  });
  const html = await renderShell(baseProps({
    conversation: conversationPage([newestOnPage, oldestOnPage], null, oldestOnPage.previousRequestId, 3),
    conversationHasNewer: true,
    onOlderConversation() {},
    onLatestConversation() {},
  }));

  assert.match(html, />이전 대화<\/button>/);
  assert.match(html, />최신 대화<\/button>/);
});

test("does not automatically retry an unknown admission and keeps the turn explicitly uncertain", async () => {
  const refresh = () => { throw new Error("SSR must not initiate a retry"); };
  const current = turn({ state: "uncertain", runId: null, answer: null, outputState: "not_ready" });
  const page = conversationPage([current], {
    requestId: current.requestId,
    state: "uncertain",
    runId: null,
    cancellationRequested: false,
    termination: "not_applicable",
  });
  const html = await renderShell(baseProps({ conversation: page, onRefreshConversation: refresh }));

  assert.match(html, /접수 불명확 · 자동 재전송하지 않음/);
  assert.match(html, />응답 확인<\/button>/);
});

test("audits not-configured AI without enabling message send or inventing conversation output", async () => {
  const html = await renderShell(baseProps({
    snapshot: snapshot("not_configured"),
    conversation: null,
    conversationChannel: "user_conversation",
  }));

  assert.match(html, /메시지 전송을 사용할 수 없습니다/);
  assert.match(html, /AI 메시지 연결을 사용할 수 없어 입력이 비활성화되었습니다/);
  assert.doesNotMatch(html, /Lead 대화는 현재 Workspace에 저장됩니다/);
  assert.doesNotMatch(html, /Use a small domain module/);
  assert.match(html, /aria-label="메시지 보내기"[^>]*disabled/);
});
