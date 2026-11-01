import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
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
  const uiSha256 = createHash("sha256").update(await readFile(path.join(directory, "dist/ui-v0.1.0/index.js"))).digest("hex");
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
  const leadAgent = await request(`/api/companies/${company.id}/agents`, {
    method: "POST", body: { name: "Builder Lead selection fixture", role: "engineer", adapterType: "process", adapterConfig: {} },
  });
  const foreignAgent = await request(`/api/companies/${secondCompany.id}/agents`, {
    method: "POST", body: { name: "Other Workspace selection fixture", role: "engineer", adapterType: "process", adapterConfig: {} },
  });
  const leadOptions = companyId => request(`/api/plugins/${plugin.id}/data/builder.lead-agents`, {
    method: "POST", body: { companyId, params: {} },
  }).then(value => value.data);
  const initialLeadOptions = await leadOptions(company.id);
  assert.ok(initialLeadOptions.agents.some(agent => agent.id === leadAgent.id), "Existing Workspace Agent is absent from Builder options.");
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
  const visual = await workspace.evaluate(`(() => {
    const shell=document.querySelector('.builder-shell');
    return {background:getComputedStyle(shell).backgroundColor,scheme:getComputedStyle(shell).colorScheme,
      duplicateHeader:Boolean(document.querySelector('.builder-view-header')),
      title:document.querySelector('.builder-chat-heading h1')?.textContent,
      tabs:[...document.querySelectorAll('.builder-rail-tabs [role="tab"]')].map(item=>({label:item.textContent,disabled:item.disabled}))};
  })()`);
  assert.equal(visual.background, 'rgb(24, 24, 24)');
  assert.equal(visual.scheme, 'dark');
  assert.equal(visual.duplicateHeader, false);
  assert.equal(visual.title, 'Lead와 대화');
  assert.deepEqual(visual.tabs.map(value => value.label), ['수정사항','작업 지시','기록','작업 파일','설계']);
  assert.deepEqual(visual.tabs.map(value => value.disabled), [true,true,false,true,false]);
  assert.equal(await workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]').disabled`), true);
  await click(workspace, '[aria-label="상담 텍스트 가져오기"]', "Open Builder consultation import");
  const text = "Isolated actual Host consultation input";
  await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="상담 텍스트"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Retained pasted draft');
    field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await workspace.evaluate(`(() => {const input=document.querySelector('input[aria-label="상담 .txt 파일"]');
    const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([0xc3,0x28])],'invalid.txt',{type:'text/plain'}));
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`({text:document.querySelector('textarea[aria-label="상담 텍스트"]').value,
    status:document.querySelector('.builder-import [role="status"]')?.textContent})`),
    value => value.text === 'Retained pasted draft' && value.status?.includes('UTF-8'), "invalid file preserves the draft in actual Host");
  await workspace.evaluate(`(() => {const input=document.querySelector('input[aria-label="상담 .txt 파일"]');
    const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(text)}],'consultation.txt',{type:'text/plain'}));
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await eventually(() => workspace.evaluate(`({text:document.querySelector('textarea[aria-label="상담 텍스트"]').value,
    status:document.querySelector('.builder-import [role="status"]')?.textContent})`),
    value => value.text === text && value.status?.includes('미리보기'), "selected file preview in actual Host");
  assert.deepEqual((await data(company.id)).messages, [], "File selection must not save or start AI.");
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
  assert.deepEqual((await data(company.id)).documents, []);
  await click(workspace, '.builder-nav [aria-label="설계 문서"]', "Open stored Workspace document view");
  await eventually(() => workspace.evaluate(`(() => {
    const layout=document.querySelector('.builder-doc-layout');
    return {panes:layout?.querySelectorAll(':scope > .builder-card').length,
      headings:[...(layout?.querySelectorAll('h2')||[])].map(node=>node.textContent),
      empty:layout?.textContent.includes('저장된 프로젝트 문서가 없습니다.'),
      previewEmpty:layout?.textContent.includes('문서를 선택하면 저장된 내용이 표시됩니다.'),
      duplicatedRail:Boolean(document.querySelector('.builder-activity-rail')),
      overflow:document.querySelector('.builder-shell').scrollWidth>document.querySelector('.builder-shell').clientWidth};
  })()`), value => value.panes === 2 && value.empty && value.previewEmpty, "actual empty document panes");
  const documentView = await workspace.evaluate(`({
    headings:[...document.querySelectorAll('.builder-doc-layout h2')].map(node=>node.textContent),
    duplicatedRail:Boolean(document.querySelector('.builder-activity-rail')),
    overflow:document.querySelector('.builder-shell').scrollWidth>document.querySelector('.builder-shell').clientWidth})`);
  assert.deepEqual(documentView.headings, ['프로젝트 파일', '미리보기']);
  assert.equal(documentView.duplicatedRail, false);
  assert.equal(documentView.overflow, false);
  assert.deepEqual((await data(company.id)).actors, []);
  await click(workspace, '.builder-nav [aria-label="조직도"]', "Open saved Builder organization");
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-empty-card')?.textContent.includes('조직 정보가 없습니다')`),
    Boolean, "actual empty Builder organization without fabricated Actors");
  assert.equal(await workspace.evaluate(`Boolean(document.querySelector('.builder-activity-rail'))`), false);
  assert.equal(await workspace.evaluate(`document.querySelectorAll('.builder-org-card').length`), 0);
  await click(workspace, '.builder-nav [aria-label="시스템"]', "Open Builder Agent settings");
  await eventually(() => workspace.evaluate(`({disabled:document.querySelector('select[aria-label="Lead Agent"]')?.disabled,
    ids:[...(document.querySelector('select[aria-label="Lead Agent"]')?.options||[])].map(option=>option.value)})`),
    value => value.disabled === false && value.ids.includes(leadAgent.id), "real Workspace Agent options");
  assert.equal(await workspace.evaluate(`document.querySelector('select[aria-label="Lead Agent"]').querySelector('option[value="${foreignAgent.id}"]') !== null`), false);
  await workspace.evaluate(`(() => { const select=document.querySelector('select[aria-label="Lead Agent"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(leadAgent.id)});
    select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await click(workspace, 'section[aria-labelledby="lead-agent-settings-title"] button', "Save Lead binding without executing AI");
  const savedLead = await eventually(() => leadOptions(company.id), value => value.selectedAgentId === leadAgent.id, "saved Lead Agent");
  assert.equal(savedLead.revision, 1);
  assert.equal((await leadOptions(secondCompany.id)).selectedAgentId, null);
  assert.deepEqual((await request(`/api/agents/${leadAgent.id}`)).adapterConfig, leadAgent.adapterConfig);
  const foreignSelection = await workspace.evaluate(`fetch(${JSON.stringify(`/api/plugins/${plugin.id}/actions/builder.select-lead-agent`)}, {
    method:'POST',credentials:'include',headers:{'content-type':'application/json'},
    body:JSON.stringify({companyId:${JSON.stringify(company.id)},params:{agentId:${JSON.stringify(foreignAgent.id)},expectedRevision:1}})})
    .then(r=>({status:r.status}))`, true);
  assert.ok(foreignSelection.status >= 400, "An Agent from another Workspace cannot become this Builder Lead.");
  assert.equal((await leadOptions(company.id)).selectedAgentId, leadAgent.id);
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-lead-agent-host.png"));
  await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Return to unchanged consultation");
  assert.equal(await workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]').disabled`), true);
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
  assert.deepEqual(await leadOptions(company.id), savedLead, "Host restart lost the separate Lead binding.");
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-transcript')?.innerText.includes(${JSON.stringify(text)})`), Boolean, "restarted Builder UI");
  await activate(company.id, false);
  await activate(company.id, true);
  assert.deepEqual(await data(company.id), saved, "Workspace activation must not erase Builder state.");
  const shell = await request(`/api/companies/${company.id}/workspace-shell`);
  assert.ok(JSON.stringify(shell).includes(plugin.id), "Explicit Shell choice must survive restart.");
  console.log(JSON.stringify({ builderCoreHost: true, realUiBridge: true, actualWorkspaceState: true,
    workspaceIsolation: true, explicitShell: true, idempotentInput: true, hostRestart: true,
    aiExecuted: false, installedPackageTested: false, physicalTwoPcTested: false,
    leadAgentSelection: true, leadBindingRestart: true, originalAgentConfigPreserved: true,
    localTxtPreview: true, invalidFilePreservesDraft: true, fileSelectionDoesNotSave: true,
    uiSha256, blackNeutralTheme: true, singleLeadHeader: true, v9WorkPanelSlots: true, v9EmptyDocumentPanes: true, v9EmptyOrganization: true,
    cleanupQualificationPending: true }));
}
