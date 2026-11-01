import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, check, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await pause(150);
  }
  throw new Error(`Builder Host acceptance did not observe ${label}.`);
}

// Loaded explicitly by the Core's source-only isolated Desktop acceptance.
// No actual account, installed user profile, AI, or customer data is used.
export async function runAcceptance({ cdp, company, secondCompany, api, click, restart,
  temporaryRoot, captureScreenshot, screenshotPath }) {
  let workspace = cdp;
  const request = (url, options) => api(workspace, url, options);
  const directory = path.join(temporaryRoot, "reference-plugins", "my-plugin-builder");
  await mkdir(directory);
  for (const file of ["package.json", "sps-plugin.json", "THIRD_PARTY_NOTICES.md", "dist"]) {
    await cp(path.join(root, file), path.join(directory, file), { recursive: true, errorOnExist: true, force: false });
  }
  await request("/api/plugins/install", { method: "POST", body: { packageName: directory, isLocalPath: true } });
  const plugin = (await eventually(() => request("/api/plugins"),
    values => values.some(value => value.pluginKey === "com.sonparkserver.my-plugin-builder" && value.status === "ready"),
    "installed Builder")).find(value => value.pluginKey === "com.sonparkserver.my-plugin-builder");
  const data = companyId => request(`/api/plugins/${plugin.id}/data/builder.snapshot`, {
    method: "POST", body: { companyId, params: {} },
  }).then(value => value.data);
  const activate = (companyId, enabled) => request(`/api/plugins/${plugin.id}/companies/${companyId}/activation`, {
    method: "PUT", body: { enabled },
  });
  const action = (companyId, params) => request(`/api/plugins/${plugin.id}/actions/builder.import-consultation`, {
    method: "POST", body: { companyId, params },
  }).then(value => value.data);
  const denied = await workspace.evaluate(`fetch(${JSON.stringify(`/api/plugins/${plugin.id}/data/builder.snapshot`)}, {
    method:'POST', credentials:'include', headers:{'content-type':'application/json'},
    body:JSON.stringify({companyId:${JSON.stringify(company.id)},params:{}})}).then(async r=>({status:r.status,body:await r.json()}))`, true);
  assert.ok([400, 403, 502].includes(denied.status), `Inactive Builder must not read Workspace state: ${JSON.stringify(denied)}`);
  assert.match(JSON.stringify(denied.body), /not enabled|disabled|not active|scope|permission/i,
    "Inactive denial must explain the activation boundary, not an unrelated runtime failure.");
  await activate(company.id, true);
  await activate(secondCompany.id, true);
  assert.deepEqual((await data(company.id)).messages, []);
  assert.deepEqual((await data(secondCompany.id)).messages, []);
  const provider = (await eventually(() => request(`/api/companies/${company.id}/workspace-shell/providers`),
    values => values.some(value => value.pluginId === plugin.id), "Builder Shell provider"))
    .find(value => value.pluginId === plugin.id);
  assert.equal(provider.shell.defaultRoute, "/builder");
  await request(`/api/companies/${company.id}/workspace-shell`, {
    method: "PUT", body: { pluginId: plugin.id, shellId: provider.shell.id },
  });
  await workspace.evaluate(`location.assign(${JSON.stringify(`/${company.issuePrefix}`)})`);
  await eventually(() => workspace.evaluate(`({ready:Boolean(document.querySelector('.builder-shell')),path:location.pathname,
    loading:document.body.innerText.includes('Workspace 상태를 불러오는 중입니다.'),
    failed:Boolean(document.querySelector('.builder-status-strip.is-error'))})`),
  value => value.ready && value.path === `/${company.issuePrefix}/builder` && !value.loading && !value.failed, "actual Builder Shell route");
  assert.equal(await workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]').disabled`), true);
  await click(workspace, '[aria-label="상담 텍스트 가져오기"]', "Open Builder consultation import");
  const text = "Isolated actual Host consultation input";
  await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="상담 텍스트"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});
    field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-import-form button')?.disabled === false`), Boolean, "Builder Save");
  await click(workspace, ".builder-import-form button", "Save Builder consultation through real UI bridge");
  const saved = await eventually(() => data(company.id), value => value.messages.length === 1, "real persisted Builder input");
  assert.equal(saved.messages[0].text, text);
  assert.equal(saved.integrations.ai, "not_configured");
  const originalRequest = saved.messages[0].id.slice("consultation-".length);
  const retry = await action(company.id, { requestId: originalRequest, text });
  assert.equal(retry.saved, true);
  assert.equal(retry.analysisStarted, false);
  assert.equal((await data(company.id)).messages.length, 1);
  assert.deepEqual((await data(secondCompany.id)).messages, []);
  const injected = await workspace.evaluate(`fetch(${JSON.stringify(`/api/plugins/${plugin.id}/actions/builder.import-consultation`)}, {
    method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({companyId:${JSON.stringify(company.id)},
      params:{requestId:${JSON.stringify(randomUUID())},text:'Must not reach B',targetCompanyId:${JSON.stringify(secondCompany.id)}}})})
    .then(async r=>({status:r.status,body:await r.json()}))`, true);
  assert.ok(injected.status >= 400, "Builder must reject an extra Workspace target, not move its scope.");
  assert.equal((await data(company.id)).messages.length, 1);
  assert.deepEqual((await data(secondCompany.id)).messages, []);
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-transcript')?.innerText.includes(${JSON.stringify(text)})`), Boolean, "saved input rendered");
  const fit = await workspace.evaluate(`(() => {const shell=document.querySelector('.builder-shell');
    const main=document.querySelector('.builder-message-main');const rail=document.querySelector('.builder-activity-rail');
    return {width:shell.clientWidth,mainWidth:main.clientWidth,overflow:shell.scrollWidth>shell.clientWidth,
      railHidden:getComputedStyle(rail).display==='none'};})()`);
  assert.equal(fit.overflow, false);
  if (fit.width <= 1100) {
    assert.equal(fit.railHidden, true);
    assert.ok(fit.mainWidth >= Math.min(500, fit.width - 70), "Embedded main column must remain readable.");
    await click(workspace, '[aria-label="작업 기록 열기"]', "Open embedded Builder activity drawer");
    await eventually(() => workspace.evaluate(`getComputedStyle(document.querySelector('.builder-activity-rail')).display !== 'none'`), Boolean, "Builder activity drawer");
    await click(workspace, '.builder-activity-rail .builder-drawer-close', "Close embedded Builder activity drawer");
  }
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-real-host.png"));
  workspace = await restart({ companyPrefix: company.issuePrefix, pluginId: plugin.id, readySelector: ".builder-shell" });
  assert.deepEqual(await data(company.id), saved, "Host restart lost Builder state.");
  assert.deepEqual((await data(secondCompany.id)).messages, []);
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-transcript')?.innerText.includes(${JSON.stringify(text)})`), Boolean, "restarted Builder UI");
  await activate(company.id, false);
  await activate(company.id, true);
  assert.deepEqual(await data(company.id), saved, "Workspace activation must not erase Builder state.");
  const shell = await request(`/api/companies/${company.id}/workspace-shell`);
  assert.ok(JSON.stringify(shell).includes(plugin.id), "Explicit Shell choice must survive restart.");
  console.log(JSON.stringify({ builderCoreHost: true, realUiBridge: true, actualWorkspaceState: true,
    workspaceIsolation: true, explicitShell: true, idempotentInput: true, hostRestart: true,
    aiExecuted: false, installedPackageTested: false, physicalTwoPcTested: false,
    cleanupQualificationPending: true }));
}
