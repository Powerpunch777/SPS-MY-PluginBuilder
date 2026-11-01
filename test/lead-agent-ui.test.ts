import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { BuilderLeadAgentOptions } from "../src/domain/model.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function render(options: BuilderLeadAgentOptions | null, loading = false, error: string | null = null) {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".lead-agent-ui-test-"));
  try {
    const output = path.join(temporary, "LeadAgentSettings.mjs");
    await build({
      entryPoints: [path.join(projectRoot, "src", "ui", "LeadAgentSettings.tsx")],
      outfile: output,
      bundle: true,
      external: ["react", "react-dom", "react-dom/server"],
      platform: "node",
      format: "esm",
      jsx: "automatic",
    });
    const { LeadAgentSettings } = await import(pathToFileURL(output).href);
    return renderToStaticMarkup(createElement(LeadAgentSettings, { options, loading, error, onSave: async () => {} }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
