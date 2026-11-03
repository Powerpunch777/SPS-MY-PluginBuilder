import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { BuilderLeadAgentOptions } from "../src/domain/model.js";
import type { BuilderLeadContexts } from "../src/domain/lead-contexts.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

async function render(options: BuilderLeadAgentOptions | null, loading = false, error: string | null = null,
  contexts: BuilderLeadContexts | null = null) {
  const result = await build({
      entryPoints: [path.join(projectRoot, "src", "ui", "LeadAgentSettings.tsx")],
      bundle: true,
      external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
      platform: "node",
      format: "esm",
      jsx: "automatic",
      nodePaths: [path.join(projectRoot, "node_modules")],
      write: false,
    });
  const output = result.outputFiles[0];
  if (!output) throw new Error("esbuild did not return the in-memory Lead settings bundle.");
  const source = Buffer.from(output.contents).toString("utf8")
    .replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href))
    .replaceAll('"react"', JSON.stringify(pathToFileURL(require.resolve("react")).href));
  const { LeadAgentSettings } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as
    typeof import("../src/ui/LeadAgentSettings.tsx");
  return renderToStaticMarkup(createElement(LeadAgentSettings, { options, loading, error, contexts,
    onSave: async () => {}, onPrepareContexts: async () => {} }));
}

const options: BuilderLeadAgentOptions = {
  workspaceId: "workspace-1",
  revision: 7,
  selectedAgentId: "agent-1",
  agents: [
    { id: "agent-1", name: "Lead <One>", status: "running" },
    { id: "agent-2", name: "Paused Agent", status: "paused" },
  ],
};

test("renders accessible selection, escaped names, and an explicit unconfigured choice", async () => {
  const html = await render(options);
  assert.match(html, /aria-label="Lead Agent"/);
  assert.match(html, /Lead Agent 저장/);
  assert.match(html, /설정 안 함/);
  assert.match(html, /Lead &lt;One&gt;/);
  assert.match(html, /value="agent-1" selected/);
  assert.match(html, /<option disabled="" value="agent-2">/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Lead Agent 저장/);
});

test("keeps a removed selected agent visible and does not choose a fallback", async () => {
  const html = await render({ ...options, agents: [{ id: "agent-2", name: "Available", status: "idle" }] });
  assert.match(html, /현재 선택된 Lead Agent를 사용할 수 없음 \(agent-1\)/);
  assert.match(html, /다른 Agent로 자동 변경되지 않았습니다/);
  assert.match(html, /value="agent-1" selected/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Lead Agent 저장/);
});

test("disables saving for non-runnable states and exposes loading and errors", async () => {
  const disabled = await render({ ...options, selectedAgentId: "agent-2" });
  assert.match(disabled, /<button[^>]*disabled=""[^>]*>Lead Agent 저장/);

  const loading = await render(options, true, "설정을 불러오지 못했습니다");
  assert.match(loading, /설정을 불러오지 못했습니다/);
  assert.match(loading, /<select[^>]*disabled=""/);
  assert.match(loading, /<button[^>]*disabled=""[^>]*>Lead Agent 저장/);
});

test("supports an unconfigured state without inventing an agent", async () => {
  const html = await render({ ...options, selectedAgentId: null, agents: [] });
  assert.match(html, /value="" selected/);
  assert.doesNotMatch(html, /현재 선택된 Lead Agent를 사용할 수 없음/);
});

test("v2 creation is a separate explicit action and uncertain ensure state disables retry", async () => {
  const available = await render(options);
  assert.match(available, /새 5개 Lead 구성 명시 시작/);
  assert.match(available, /왼쪽 화면 이동은 세션을 만들지 않습니다/);
  assert.match(available, /aria-label="5개 논리 Lead 컨텍스트"/);
  for (const label of ["Main", "UI Design", "Background", "Question Intake", "Question Discussion"]) {
    assert.match(available, new RegExp(label));
  }
  assert.match(available, /세션 없음/);
  assert.doesNotMatch(available, /Lead 세션 준비|저장된 Lead 세션/);
  const uncertain: BuilderLeadContexts = { schemaVersion: 2, workspaceId: options.workspaceId,
    selectionRevision: options.revision, agentId: options.selectedAgentId!, requestId: "11111111-1111-4111-8111-111111111111",
    status: "uncertain", pendingContext: "ui_design", contexts: { user_conversation: "22222222-2222-4222-8222-222222222222",
      ui_design: null, background_planning: null, question_intake: null, question_discussion: null } };
  const blocked = await render(options, false, null, uncertain);
  assert.match(blocked, /Host SDK는 taskKey만으로 동일 세션이 복구된다고 보장하지 않습니다/);
  assert.match(blocked, /UI Design/);
  assert.match(blocked, /새 Lead 구성 상태 확인 필요/);
  assert.doesNotMatch(blocked, /새 5개 Lead 구성 명시 시작/);
});
