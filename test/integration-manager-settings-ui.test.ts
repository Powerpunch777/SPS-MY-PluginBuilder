import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { build } from "esbuild";
import type { IntegrationManagerDTO, IntegrationManagerSettingsProps } from "../src/ui/IntegrationManagerSettings.tsx";

const projectRoot = path.resolve(import.meta.dirname, "..");
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const agentA = "33333333-3333-4333-8333-333333333333";
const agentB = "44444444-4444-4444-8444-444444444444";

function dto(workspaceId = workspaceA, revision = 4): IntegrationManagerDTO {
  return { workspaceId, revision, selectedAgentId: agentA, agents: [
    { id: agentA, name: "Selected Manager", status: "paused" },
    { id: agentB, name: "Running Manager", status: "running" },
  ], sessionId: null, executionReadiness: "unknown", aiRunStarted: false };
}

async function loadUI() {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".integration-manager-ui-test-"));
  const output = path.join(temporary, "IntegrationManagerSettings.mjs");
  await build({ entryPoints: [path.join(projectRoot, "src/ui/IntegrationManagerSettings.tsx")], outfile: output,
    bundle: true, external: ["react", "react/jsx-runtime"], platform: "node", format: "esm", jsx: "automatic" });
  const module = await import(pathToFileURL(output).href);
  return { Component: module.IntegrationManagerSettings as typeof import("../src/ui/IntegrationManagerSettings.tsx").IntegrationManagerSettings,
    parseDTO: module.parseIntegrationManagerDTO as typeof import("../src/ui/IntegrationManagerSettings.tsx").parseIntegrationManagerDTO,
    temporary };
}

test("strictly parses the registered DTO and rejects cross-workspace, unknown and accessor data", async () => {
  const { parseDTO, temporary } = await loadUI();
  try {
    assert.deepEqual(parseDTO(dto(), workspaceA), dto());
    const longName = { ...dto(), agents: [{ ...dto().agents[0]!, name: "Manager ".repeat(50) }] };
    assert.deepEqual(parseDTO(longName, workspaceA), longName);
    assert.throws(() => parseDTO({ ...dto(), agents: [{ ...dto().agents[0]!, name: "x".repeat(501) }] }, workspaceA));
    assert.throws(() => parseDTO(dto(workspaceB), workspaceA));
    assert.throws(() => parseDTO({ ...dto(), secret: "must-not-display" }, workspaceA));
    const accessor = Object.defineProperty({ ...dto() }, "revision", { enumerable: true, get: () => 4 });
    assert.throws(() => parseDTO(accessor, workspaceA));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("backward-compatible missing data is explicit and never invents an agent or execution state", async () => {
  const { Component, temporary } = await loadUI();
  try {
    const loading = renderToStaticMarkup(createElement(Component, { workspaceId: workspaceA, projectId: workspaceA,
      options: null, loading: true, error: null } satisfies IntegrationManagerSettingsProps));
    assert.match(loading, /Manager 설정을 불러오는 중/u);
    assert.doesNotMatch(loading, /기본 프로필 준비/u);
    const failed = renderToStaticMarkup(createElement(Component, { workspaceId: workspaceA, projectId: workspaceA,
      options: null, loading: false, error: "설정 오류" } satisfies IntegrationManagerSettingsProps));
    assert.match(failed, /설정 오류/u);
    assert.doesNotMatch(failed, /기본 프로필 준비/u);
    const missing = renderToStaticMarkup(createElement(Component, { workspaceId: workspaceA, projectId: workspaceA,
      options: null, loading: false, error: null } satisfies IntegrationManagerSettingsProps));
    assert.match(missing, /이 Host에서 Manager 설정을 사용할 수 없습니다/u);
    assert.doesNotMatch(missing, /통합 완료되었습니다|실행 완료되었습니다/u);
    const existing = renderToStaticMarkup(createElement(Component, { workspaceId: workspaceA, projectId: workspaceA,
      options: dto(), loading: false, error: null } satisfies IntegrationManagerSettingsProps));
    assert.match(existing, /Integration Manager/u);
    assert.match(existing, /Selected Manager · 일시 정지/u);
    assert.match(existing, /기본 프로필 준비/u);
    assert.match(existing, /실행 준비 상태 미확인/u);
    assert.match(existing, /Lead Agent와 별도로/u);
    assert.doesNotMatch(existing, /api[-_ ]?key|secret|token/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("selection and explicit profile preparation use exact callbacks and report no AI execution", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".integration-manager-ui-browser-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = await build({ stdin: { sourcefile: "manager-harness.tsx", resolveDir: projectRoot, contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { IntegrationManagerSettings } from "./src/ui/IntegrationManagerSettings.tsx";
      window.calls = [];
      window.mountManager = (workspaceId, options, prepare = async () => ({ status: "preserved", projectId: workspaceId,
        workspaceId, reason: "already-ready", managerAgentId: options.selectedAgentId, managerSessionId: null,
        managerRevision: options.revision, profileProvisioning: "already-present", sessionProvisioning: "not-required",
        profileStatus: "paused", executionReadiness: "unknown", aiRunStarted: false,
        authorityConsistency: "cross-key-reads-are-not-atomic" })) => {
        const root = document.getElementById("root"); if (!root) return;
        createRoot(root).render(createElement(IntegrationManagerSettings, { workspaceId, projectId: workspaceId,
          options, loading: false, error: null,
          onSelect: async (agentId, expectedRevision) => { window.calls.push({ type: "select", agentId, expectedRevision }); },
          onPrepare: async (projectId, expectedManagerRevision) => { window.calls.push({ type: "prepare", projectId, expectedManagerRevision }); return prepare(); },
        }));
      };
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent("<div id='root'></div>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const options = dto();
    await page.evaluate(({ workspaceId, options }) => (window as unknown as { mountManager: (id: string, dto: unknown) => void })
      .mountManager(workspaceId, options), { workspaceId: workspaceA, options });
    await page.getByLabel("Integration Manager Agent").selectOption(agentB);
    await page.getByRole("button", { name: "Manager 선택 저장" }).click();
    await page.getByRole("status").filter({ hasText: "선택 저장을 요청했습니다" }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls), [
      { type: "select", agentId: agentB, expectedRevision: 4 },
    ]);
    assert.equal(await page.getByRole("button", { name: "기본 프로필 준비" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "새 설정 확인" }).isEnabled(), true);

    const profilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await profilePage.setContent("<div id='root'></div>");
    await profilePage.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await profilePage.evaluate(({ workspaceId, options }) => (window as unknown as { mountManager: (id: string, dto: unknown) => void })
      .mountManager(workspaceId, options), { workspaceId: workspaceA, options });
    await profilePage.getByRole("button", { name: "기본 프로필 준비" }).click();
    await profilePage.getByRole("status").filter({ hasText: "기존 기본 프로필과 세션 설정을 유지했습니다" }).waitFor();
    assert.deepEqual(await profilePage.evaluate(() => (window as unknown as { calls: unknown[] }).calls), [
      { type: "prepare", projectId: workspaceA, expectedManagerRevision: 4 },
    ]);
    const copy = await profilePage.locator("body").innerText();
    assert.match(copy, /AI 실행이나 통합 완료가 아닙니다/u);
    assert.doesNotMatch(copy, /실행 성공|통합이 완료되었습니다/u);
    assert.equal(await profilePage.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    await profilePage.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await profilePage.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("late preparation responses are ignored after switching Workspaces", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".integration-manager-ui-late-test-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = await build({ stdin: { sourcefile: "manager-late-harness.tsx", resolveDir: projectRoot, contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { IntegrationManagerSettings } from "./src/ui/IntegrationManagerSettings.tsx";
      let root;
      function render(workspaceId, options, prepare) { if (!root) { const element = document.getElementById("root"); if (!element) return; root = createRoot(element); }
        root.render(createElement(IntegrationManagerSettings, { workspaceId, projectId: workspaceId, options,
          loading: false, error: null, onPrepare: async () => prepare })); }
      window.startLate = options => { let finish; const promise = new Promise(resolve => { finish = resolve; });
        window.finishLate = finish; render("11111111-1111-4111-8111-111111111111", options, promise); };
      window.switchWorkspace = options => render("22222222-2222-4222-8222-222222222222", options, Promise.resolve(null));
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent("<div id='root'></div>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate(options => (window as unknown as { startLate: (dto: unknown) => void }).startLate(options), dto());
    await page.getByRole("button", { name: "기본 프로필 준비" }).click();
    await page.evaluate(options => (window as unknown as { switchWorkspace: (dto: unknown) => void }).switchWorkspace(options), dto(workspaceB));
    await page.evaluate(() => (window as unknown as { finishLate: (value: unknown) => void }).finishLate({ status: "provisioned",
      projectId: "11111111-1111-4111-8111-111111111111", workspaceId: "11111111-1111-4111-8111-111111111111",
      managerAgentId: "33333333-3333-4333-8333-333333333333", managerSessionId: null, managerRevision: 4,
      reason: "created", profileProvisioning: "created-or-resolved", sessionProvisioning: "not-required",
      profileStatus: "paused", executionReadiness: "unknown", aiRunStarted: false,
      authorityConsistency: "cross-key-reads-are-not-atomic" }));
    await page.waitForTimeout(20);
    assert.doesNotMatch(await page.locator("body").innerText(), /기본 프로필 준비 요청이 확인/u);
    assert.match(await page.locator("body").innerText(), /Integration Manager/u);
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
