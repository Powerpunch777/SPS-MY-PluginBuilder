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
  const leadSessions = companyId => request(`/api/plugins/${plugin.id}/data/builder.lead-sessions`, {
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
    const bounds=shell.getBoundingClientRect();
    return {background:getComputedStyle(shell).backgroundColor,scheme:getComputedStyle(shell).colorScheme,
      coreFrame:Boolean(document.querySelector('#main-content')),left:bounds.left,top:bounds.top,
      width:bounds.width,height:bounds.height,viewportWidth:innerWidth,viewportHeight:innerHeight,
      duplicateHeader:Boolean(document.querySelector('.builder-view-header')),
      title:document.querySelector('.builder-chat-heading h1')?.textContent,
      tabs:[...document.querySelectorAll('.builder-rail-tabs [role="tab"]')].map(item=>({label:item.textContent,disabled:item.disabled}))};
  })()`);
  assert.equal(visual.background, 'rgb(24, 24, 24)');
  assert.equal(visual.scheme, 'dark');
  assert.equal(visual.coreFrame, false, "Builder must not inherit the Core compatibility frame.");
  assert.ok(Math.abs(visual.left) <= 1 && visual.width >= visual.viewportWidth - 20,
    "Builder must own the available window width without the Core sidebar.");
  assert.ok(Math.abs(visual.top) <= 1 && Math.abs(visual.height - visual.viewportHeight) <= 1,
    "Builder must fill the window height without a leftover Core canvas.");
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
  const systemView = await workspace.evaluate(`(() => {
    const page=document.querySelector('.builder-system-page');
    const headings=[...(page?.querySelectorAll('.builder-card > h2')||[])].map(node=>node.textContent.trim());
    const select=page?.querySelector('select[aria-label="Lead Agent"]');
    const save=page?.querySelector('section[aria-labelledby="lead-agent-settings-title"] button[type="submit"]');
    return {pageClass:page?.className||null,
      pageHeading:page?.querySelector('.builder-page-intro h2')?.textContent.trim()||null,
      scopeDescription:page?.querySelector('.builder-page-intro p')?.textContent.trim()||null,
      headings,runnerUnavailableMessage:page?.querySelector('.builder-runner-unavailable strong')?.textContent.trim()||null,
      runnerUnavailableDetail:page?.querySelector('.builder-runner-unavailable p')?.textContent.trim()||null,
      activityRailCount:document.querySelectorAll('.builder-activity-rail').length,
      activityOpenToggleCount:document.querySelectorAll('button[aria-label="작업 기록 열기"]').length,
      activityCloseToggleCount:document.querySelectorAll('button[aria-label="작업 기록 닫기"]').length,
      leadSelectCount:page?.querySelectorAll('select[aria-label="Lead Agent"]').length||0,
      leadSelectVisible:Boolean(select?.getClientRects().length),
      leadSaveCount:page?.querySelectorAll('section[aria-labelledby="lead-agent-settings-title"] button[type="submit"]').length||0,
      leadSaveText:save?.textContent.trim()||null,
      leadSaveVisible:Boolean(save?.getClientRects().length),
      leadSaveDisabled:save?.disabled??null};
  })()`);
  assert.ok(systemView.pageClass?.split(/\s+/).includes('builder-system-page'), "Actual System view must use the dedicated System layout.");
  assert.equal(systemView.pageHeading, 'Workspace 상태');
  assert.equal(systemView.scopeDescription, '이 Workspace의 AI와 GitHub 연결 상태입니다.');
  assert.deepEqual(systemView.headings, ['연결 상태', 'Runner 정보']);
  assert.equal(systemView.runnerUnavailableMessage, 'Runner 정보가 아직 연결되지 않았습니다');
  assert.equal(systemView.runnerUnavailableDetail, '접속 상태, 운영체제, 라벨, 최근 작업은 현재 화면에서 확인할 수 없습니다.');
  assert.equal(systemView.activityRailCount, 0, "System view must not render the AI activity rail.");
  assert.equal(systemView.activityOpenToggleCount, 0, "System view must not render the activity rail open toggle.");
  assert.equal(systemView.activityCloseToggleCount, 0, "System view must not render the activity rail close toggle.");
  assert.equal(systemView.leadSelectCount, 1);
  assert.equal(systemView.leadSelectVisible, true);
  assert.equal(systemView.leadSaveCount, 1);
  assert.equal(systemView.leadSaveText, 'Lead Agent 저장');
  assert.equal(systemView.leadSaveVisible, true);
  await eventually(() => workspace.evaluate(`({disabled:document.querySelector('select[aria-label="Lead Agent"]')?.disabled,
    ids:[...(document.querySelector('select[aria-label="Lead Agent"]')?.options||[])].map(option=>option.value)})`),
    value => value.disabled === false && value.ids.includes(leadAgent.id), "real Workspace Agent options");
  assert.equal(await workspace.evaluate(`document.querySelector('select[aria-label="Lead Agent"]').querySelector('option[value="${foreignAgent.id}"]') !== null`), false);
  await workspace.evaluate(`(() => { const select=document.querySelector('select[aria-label="Lead Agent"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(leadAgent.id)});
    select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const selectedLeadControl = await eventually(() => workspace.evaluate(`(() => ({
    value:document.querySelector('.builder-system-page select[aria-label="Lead Agent"]')?.value||null,
    saveDisabled:document.querySelector('.builder-system-page section[aria-labelledby="lead-agent-settings-title"] button[type="submit"]')?.disabled??null}))()`),
    value => value.value === leadAgent.id && value.saveDisabled === false, "selected Lead Agent and enabled System save control");
  assert.equal(selectedLeadControl.value, leadAgent.id);
  assert.equal(selectedLeadControl.saveDisabled, false);
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
  assert.deepEqual(await request(`/api/agents/${leadAgent.id}/task-sessions`), [], "Agent selection alone must not create sessions.");
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="Lead 세션 준비 및 확인"]')?.disabled === false`),
    Boolean, "explicit Lead session preparation");
  await click(workspace, 'button[aria-label="Lead 세션 준비 및 확인"]', "Prepare three Lead sessions without executing AI");
  const preparedSessions = await eventually(() => leadSessions(company.id),
    value => Object.values(value.sessions).every(id => typeof id === "string"), "three persisted Lead session IDs");
  assert.equal(new Set(Object.values(preparedSessions.sessions)).size, 3);
  const storedSessions = await request(`/api/agents/${leadAgent.id}/task-sessions`);
  assert.equal(storedSessions.length, 3);
  assert.deepEqual(storedSessions.map(row => row.id).sort(), Object.values(preparedSessions.sessions).sort());
  assert.ok(storedSessions.every(row => row.lastRunId === null), "Preparing sessions must not start Agent runs.");
  assert.deepEqual((await leadSessions(secondCompany.id)).sessions, { main: null, "cto-inbox": null, decisions: null });
  await eventually(() => workspace.evaluate(`({disabled:document.querySelector('button[aria-label="Lead 세션 준비 및 확인"]')?.disabled,
    text:document.querySelector('button[aria-label="Lead 세션 준비 및 확인"]')?.textContent})`),
    value => value.disabled === false && value.text === "Lead 세션 확인", "prepared session check button");
  await click(workspace, 'button[aria-label="Lead 세션 준비 및 확인"]', "Recheck existing session IDs, not duplicate them");
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="Lead 세션 준비 및 확인"]')?.disabled === false`),
    Boolean, "session recheck complete");
  assert.deepEqual(await leadSessions(company.id), preparedSessions);
  assert.equal((await request(`/api/agents/${leadAgent.id}/task-sessions`)).length, 3);
  const registeredTools = await request(`/api/plugins/tools?pluginId=${encodeURIComponent(plugin.pluginKey)}`);
  assert.ok(Array.isArray(registeredTools) && registeredTools.some(tool => tool.pluginId === plugin.id
    && tool.name === "com.sonparkserver.my-plugin-builder:builder.read-solution"),
  "Declared Builder read tool must be present in the actual Host inventory (not an Agent grant).");
  const forgedTool = await workspace.evaluate(`fetch('/api/plugins/tools/execute', {
    method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({
      tool:'com.sonparkserver.my-plugin-builder:builder.read-solution',parameters:{projectId:'test-project'},
      runContext:{companyId:${JSON.stringify(company.id)},agentId:${JSON.stringify(leadAgent.id)},
        runId:'11111111-1111-4111-8111-111111111111',sessionId:${JSON.stringify(preparedSessions.sessions.main)},role:'lead'}
    })}).then(async r=>({status:r.status,body:await r.json()}))`, true);
  assert.equal(forgedTool.status, 403, "A user UI request cannot impersonate the prepared Lead Agent run.");
  assert.equal((await request(`/api/agents/${leadAgent.id}/task-sessions`)).length, 3);
  const proposedTool = await workspace.evaluate(`fetch('/api/plugins/tools/execute', {
    method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({
      tool:'com.sonparkserver.my-plugin-builder:builder.propose-design',parameters:{projectId:${JSON.stringify(company.id)}},
      runContext:{companyId:${JSON.stringify(company.id)},agentId:${JSON.stringify(leadAgent.id)},
        runId:'11111111-1111-4111-8111-111111111111',sessionId:${JSON.stringify(preparedSessions.sessions.main)}}
    })}).then(r=>({status:r.status}))`, true);
  assert.equal(proposedTool.status, 403, "User UI cannot call the Lead draft-writing tool.");

  // Presentation fixture only. It exercises the actual compiled UI with an
  // explicitly intercepted DTO, not Host persistence, AI output or approval.
  const draftFixture = { workspaceId: company.id, projectId: company.id, selectionRevision: 1, agentId: leadAgent.id,
    sequence: 1, createdAt: "2026-11-02T00:00:00.000Z", draft: { projectId: company.id, revisionId: "fixture-draft-1",
      sourceIds: [saved.messages[0].id], specification: { revisionId: "fixture-spec-1", productTier: "M",
        requirements: [{ id: "REQ-FIXTURE", description: "Display the fixture requirement as an unapproved draft", acceptanceCriteriaIds: ["AC-FIXTURE"] }],
        targets: ["desktop"], dataPolicyRef: "fixture-unverified-policy" },
      graph: { graphRevisionId: "fixture-graph-1", entities: [{ id: "REQ-FIXTURE", kind: "requirement", specRef: "REQ-FIXTURE" }],
        relations: [], viewLayoutRef: "fixture-layout-1" }, questions: [{ id: "Q-FIXTURE", title: "Fixture question",
        text: "This UI fixture is not a customer decision.", options: [{ id: "A", label: "Fixture option", tradeoff: "Not executed" }], recommendation: "A" }] } };
  await workspace.evaluate(`(() => {
    if(globalThis.__spsBuilderSavedFetch) throw new Error('Unexpected existing fixture interceptor');
    globalThis.__spsBuilderQuestionDraftFixture=${JSON.stringify(draftFixture)};
    globalThis.__spsBuilderQuestionSends=[];
    const original=globalThis.fetch; globalThis.__spsBuilderSavedFetch=original;
    globalThis.fetch=function(input,init){
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.pathname===${JSON.stringify(`/api/plugins/${plugin.id}/data/builder.design-draft`)})
        return Promise.resolve(new Response(JSON.stringify({data:globalThis.__spsBuilderQuestionDraftFixture}),{status:200,headers:{'content-type':'application/json'}}));
      if(url.pathname===${JSON.stringify(`/api/plugins/${plugin.id}/actions/builder.send-lead-message`)}){
        const body=JSON.parse(init.body);globalThis.__spsBuilderQuestionSends.push(body);
        return Promise.resolve(new Response(JSON.stringify({data:{saved:true,requestId:body.params.requestId}}),{status:200,headers:{'content-type':'application/json'}}));
      }
      return original.call(this,input,init);
    };
  })()`);
  try {
    await click(workspace, '[aria-label="Workspace 새로고침"]', "Refresh actual UI with a clearly marked draft DTO fixture");
    await eventually(() => workspace.evaluate(`document.querySelector('[aria-label="Lead 설계 초안"]')?.innerText`),
      value => value?.includes("설계 초안 · 승인·실행 전") && value.includes("fixture-draft-1"), "unapproved draft summary");
    await click(workspace, '[aria-label="Lead 설계 초안"] summary', "Expand read-only draft source/requirement details");
    await eventually(() => workspace.evaluate(`document.querySelector('[aria-label="Lead 설계 초안"] details')?.open`), Boolean, "draft details open");
    await click(workspace, '.builder-nav [aria-label="설계 시각화"]', "Read the draft Graph in the actual app");
    await eventually(() => workspace.evaluate(`({nodes:document.querySelectorAll('.react-flow__node').length,
      text:document.querySelector('.builder-graph-note')?.textContent})`),
    value => value.nodes === 1 && value.text?.includes("fixture-graph-1"), "draft Graph node and revision");
    await click(workspace, '.react-flow__node', "Select read-only draft node");
    await eventually(() => workspace.evaluate(`document.querySelector('.builder-graph-meta')?.textContent`),
      value => value?.includes("계획") && !value.includes("검증 완료"), "draft is planned, not verified work");
    await click(workspace, '.builder-nav [aria-label="설계 문서"]', "Read the draft specification document");
    await eventually(() => workspace.evaluate(`document.querySelector('.builder-document-preview')?.textContent`),
      value => value?.includes("REQ-FIXTURE"), "draft document projection");
    await click(workspace, '.builder-nav [aria-label="미결정사항"]', "Read the draft question");
    await eventually(() => workspace.evaluate(`document.querySelector('.builder-question-detail')?.textContent`),
      value => value?.includes("Fixture question") && value.includes("답변 필요"), "draft question is unanswered");
    await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled===false`), Boolean, "question fixture composer");
    await workspace.evaluate(`(() => {const field=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Fixture answer only');
      field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="메시지 보내기"]')?.disabled===false`), Boolean, "question answer fixture send");
    await click(workspace, 'button[aria-label="메시지 보내기"]', "Inspect question association using a UI-only intercepted action (no AI/Host write)");
    const questionSends = await eventually(() => workspace.evaluate(`globalThis.__spsBuilderQuestionSends`), value => value.length === 1, "one fixture action");
    assert.deepEqual(questionSends[0].params.questionContext, { projectId: company.id, draftRevisionId: "fixture-draft-1", questionId: "Q-FIXTURE" });
    assert.equal(questionSends[0].params.channel, "decisions");
    assert.equal(questionSends[0].params.text, "Fixture answer only");
    assert.equal(questionSends[0].companyId, company.id);
    await eventually(() => workspace.evaluate(`document.querySelector('.builder-question-detail')?.textContent.includes('답변 필요')`), Boolean,
      "A send receipt alone cannot mark the question answered");
    await workspace.evaluate(`(() => {const doc=globalThis.__spsBuilderQuestionDraftFixture;
      doc.decisions=[{questionId:'Q-FIXTURE',questionDigest:${JSON.stringify(createHash("sha256").update(JSON.stringify(draftFixture.draft.questions[0])).digest("hex"))},
        answerSourceId:'lead-turn:'+globalThis.__spsBuilderQuestionSends[0].params.requestId,answerSourceSha256:'a'.repeat(64),
        answerText:'Fixture stored interpretation, not approval.',fromDraftRevisionId:'fixture-draft-0',appliedDraftRevisionId:'fixture-draft-1'}];})()`);
    await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Return to Lead to refresh marked question DTO");
    await click(workspace, '[aria-label="Workspace 새로고침"]', "Load the marked answered-question presentation fixture");
    await click(workspace, '.builder-nav [aria-label="미결정사항"]', "Inspect stored-answer presentation");
    await eventually(() => workspace.evaluate(`document.querySelector('.builder-question-detail')?.textContent`),
      value => value?.includes("Fixture stored interpretation, not approval.") && !value.includes("답변 필요"), "answered fixture projection");
    assert.equal(await workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled`), true);
    await eventually(() => workspace.evaluate(`document.querySelector('.builder-composer .builder-composer-note')?.textContent`),
      value => value === "이 질문의 답변이 설계에 반영되었습니다.", "answered composer reason, not an AI connection error");
    assert.equal(await workspace.evaluate(`Boolean(document.querySelector('[aria-label="미결정질문 0개"]'))`), true);
    assert.ok(await workspace.evaluate(`(() => {const question=document.querySelector('.builder-question-detail');const main=question.closest('.builder-message-main');
      return question.getBoundingClientRect().height<=main.getBoundingClientRect().height*0.41;})()`));
    if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-question-answer-fixture.png"));
    const layout = await workspace.evaluate(`({overflow:document.querySelector('.builder-shell').scrollWidth>document.querySelector('.builder-shell').clientWidth,
      nodeEditable:document.querySelectorAll('.react-flow__node.draggable').length})`);
    assert.equal(layout.overflow, false);
    assert.equal(layout.nodeEditable, 0);
  } finally {
    await workspace.evaluate(`(() => { if(globalThis.__spsBuilderSavedFetch){globalThis.fetch=globalThis.__spsBuilderSavedFetch;delete globalThis.__spsBuilderSavedFetch;}
      delete globalThis.__spsBuilderQuestionDraftFixture;delete globalThis.__spsBuilderQuestionSends;})()`);
  }
  await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Return to Lead before using its refresh control");
  await click(workspace, '[aria-label="Workspace 새로고침"]', "Restore real Host data after UI-only fixture");
  await eventually(() => workspace.evaluate(`document.querySelector('[aria-label="Lead 설계 초안"]') === null`), Boolean, "draft fixture removed");
  assert.deepEqual(await data(company.id), saved, "Presentation fixture must not persist a design or alter consultation state.");
  if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-lead-agent-host.png"));
  await click(workspace, '.builder-nav [aria-label="Lead 대화"]', "Return to unchanged consultation");
  await eventually(() => workspace.evaluate(`document.querySelector('textarea[aria-label="Lead에게 메시지"]')?.disabled === false`),
    Boolean, "explicit Lead send readiness after session preparation (no execution requested)");
  const conversation = () => request(`/api/plugins/${plugin.id}/data/builder.lead-conversation`, {
    method: "POST", body: { companyId: company.id, params: { channel: "main", cursor: null } },
  }).then(value => value.data);
  const runsForLead = () => request(`/api/companies/${company.id}/heartbeat-runs?agentId=${leadAgent.id}&limit=100`);
  assert.deepEqual(await runsForLead(), []);
  const dispatchText = "Builder durable dispatch probe: no AI or process command is configured.";
  await workspace.evaluate(`(() => { const input=document.querySelector('textarea[aria-label="Lead에게 메시지"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(dispatchText)});
    input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await eventually(() => workspace.evaluate(`document.querySelector('button[aria-label="메시지 보내기"]')?.disabled === false`), Boolean, "send button for fixed non-AI probe");
  await click(workspace, 'button[aria-label="메시지 보내기"]', "Send one explicit probe to the unconfigured Process adapter");
  const failedConversation = await eventually(conversation,
    value => value.totalTurns === 1 && value.active === null && value.turns[0]?.state === "failed", "durable failed run and completed UI observation");
  const failedTurn = failedConversation.turns[0];
  assert.equal(failedTurn.text, dispatchText);
  assert.equal(failedTurn.answer, null, "A Process adapter failure must not invent an AI answer.");
  assert.ok(failedTurn.runId);
  assert.equal((await runsForLead()).length, 1);
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-transcript')?.innerText.includes('실행 실패')`), Boolean, "actual failure state in transcript");
  const duplicate = await request(`/api/plugins/${plugin.id}/actions/builder.send-lead-message`, {
    method: "POST", body: { companyId: company.id, params: { channel: "main", requestId: failedTurn.requestId, text: dispatchText } },
  });
  assert.equal(duplicate.data.saved, true);
  assert.equal((await runsForLead()).length, 1, "A repeated request must not schedule another run.");
  assert.deepEqual(await data(company.id), saved, "Conversation turns must not enlarge the initial snapshot.");
  const leadAfterDispatch = await leadOptions(company.id);
  assert.equal(leadAfterDispatch.selectedAgentId, savedLead.selectedAgentId);
  assert.equal(leadAfterDispatch.revision, savedLead.revision);
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
  assert.deepEqual(await leadOptions(company.id), leadAfterDispatch, "Host restart lost the Lead binding or actual post-dispatch Agent status.");
  assert.deepEqual(await leadSessions(company.id), preparedSessions, "Host restart lost Lead sessions.");
  assert.deepEqual(await conversation(), failedConversation, "Host restart lost the exact turn/run identity.");
  assert.equal((await runsForLead()).length, 1);
  assert.equal((await request(`/api/agents/${leadAgent.id}/task-sessions`)).length, 3);
  assert.deepEqual((await request(`/api/agents/${leadAgent.id}`)).adapterConfig, leadAgent.adapterConfig,
    "Host restart or Lead binding changed the original Agent configuration.");
  await eventually(() => workspace.evaluate(`document.querySelector('.builder-transcript')?.innerText.includes(${JSON.stringify(text)})`), Boolean, "restarted Builder UI");
  await activate(company.id, false);
  await activate(company.id, true);
  assert.deepEqual(await data(company.id), saved, "Workspace activation must not erase Builder state.");
  const shell = await request(`/api/companies/${company.id}/workspace-shell`);
  assert.ok(JSON.stringify(shell).includes(plugin.id), "Explicit Shell choice must survive restart.");
  // UI-only long transcript fixture; never writes a synthetic conversation to Host.
  await workspace.evaluate(`(() => {
    if(globalThis.__spsBuilderSavedFetch) throw new Error('Unexpected existing fixture interceptor');
    globalThis.__spsBuilderScrollFixture=${JSON.stringify(saved)};
    globalThis.__spsBuilderScrollFixture.messages=Array.from({length:32},(_,index)=>({
      id:'scroll-fixture-'+index,channel:'main',actorId:null,role:'user',
      text:'SCROLL_FIXTURE_'+index+' '+('Read-only transcript fixture. '.repeat(12)),
      createdAt:'2026-11-02T00:00:00.000Z',runId:null}));
    const original=globalThis.fetch; globalThis.__spsBuilderSavedFetch=original;
    globalThis.fetch=function(input,init){
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.pathname===${JSON.stringify(`/api/plugins/${plugin.id}/data/builder.snapshot`)})
        return Promise.resolve(new Response(JSON.stringify({data:globalThis.__spsBuilderScrollFixture}),{status:200,headers:{'content-type':'application/json'}}));
      return original.call(this,input,init);
    };
  })()`);
  const transcriptPosition = () => workspace.evaluate(`(() => {const e=document.querySelector('.builder-transcript');
    return e && {top:e.scrollTop,gap:e.scrollHeight-e.clientHeight-e.scrollTop,height:e.scrollHeight,client:e.clientHeight};})()`);
  try {
    await click(workspace, '[aria-label="Workspace 새로고침"]', "Load a marked long-transcript UI fixture");
    await eventually(() => workspace.evaluate(`document.querySelector('.builder-transcript')?.textContent.includes('SCROLL_FIXTURE_31')`), Boolean, "long fixture transcript");
    await eventually(transcriptPosition, value => value.height > value.client && value.gap <= 2, "initial transcript follows latest message");
    await workspace.evaluate(`(() => {const e=document.querySelector('.builder-transcript');e.scrollTop=0;e.dispatchEvent(new Event('scroll'));})()`);
    await eventually(() => workspace.evaluate(`Boolean(document.querySelector('[aria-label="최근 메시지로 이동"]'))`), Boolean, "explicit jump control while reading older text");
    await workspace.evaluate(`globalThis.__spsBuilderScrollFixture.messages.push({id:'scroll-new',channel:'main',actorId:null,role:'assistant',
      text:'SCROLL_NEW_ANSWER '+('Additional read-only content. '.repeat(50)),createdAt:'2026-11-02T00:01:00.000Z',runId:null})`);
    await click(workspace, '[aria-label="Workspace 새로고침"]', "Observe an incoming message without moving an older-text reader");
    await eventually(() => workspace.evaluate(`document.querySelector('.builder-transcript')?.textContent.includes('SCROLL_NEW_ANSWER')`), Boolean, "new fixture answer");
    assert.ok((await transcriptPosition()).top <= 2, "Incoming content must not force a scrolled-up reader to the bottom.");
    await click(workspace, '[aria-label="최근 메시지로 이동"]', "Explicitly return to latest messages");
    await eventually(transcriptPosition, value => value.gap <= 2, "explicit jump reaches the end");
    if (screenshotPath) await captureScreenshot(workspace, path.join(path.dirname(screenshotPath), "my-builder-transcript-follow.png"));
  } finally {
    await workspace.evaluate(`(() => {if(globalThis.__spsBuilderSavedFetch){globalThis.fetch=globalThis.__spsBuilderSavedFetch;delete globalThis.__spsBuilderSavedFetch;}
      delete globalThis.__spsBuilderScrollFixture;})()`);
  }
  await click(workspace, '[aria-label="Workspace 새로고침"]', "Restore real Host transcript after presentation fixture");
  await eventually(() => workspace.evaluate(`!document.querySelector('.builder-transcript')?.textContent.includes('SCROLL_FIXTURE_')`), Boolean, "scroll fixture removed");
  assert.deepEqual(await data(company.id), saved);
  console.log(JSON.stringify({ builderCoreHost: true, realUiBridge: true, actualWorkspaceState: true,
    workspaceIsolation: true, explicitShell: true, idempotentInput: true, hostRestart: true,
    aiExecuted: false, installedPackageTested: false, physicalTwoPcTested: false,
    actualNonAiFailedDispatch: true, duplicateDispatchPrevented: true, conversationRunRestart: true,
    leadAgentSelection: true, leadBindingRestart: true, originalAgentConfigPreserved: true,
    leadThreeSessionPreparation: true, leadSessionRecheckNoDuplicates: true, leadSessionsRestart: true,
    leadReadToolRegistered: true, userToolImpersonationDenied: true, liveLeadToolInvoked: false,
    userDraftWriteImpersonationDenied: true, draftUiPresentationFixture: true, realHostDraftWritten: false,
    questionAnswerAssociationPresentationFixture: true, sendReceiptDoesNotResolveQuestion: true, storedAnswerPresentationFixture: true,
    transcriptScrollPresentationFixture: true, olderReaderPositionPreserved: true, explicitJumpToLatest: true,
    localTxtPreview: true, invalidFilePreservesDraft: true, fileSelectionDoesNotSave: true,
    uiSha256, independentPluginSurface: true, blackNeutralTheme: true, singleLeadHeader: true, v9WorkPanelSlots: true, v9EmptyDocumentPanes: true, v9EmptyOrganization: true,
    systemView: { pageHeading: systemView.pageHeading, scopeDescription: systemView.scopeDescription,
      runnerMessage: systemView.runnerUnavailableMessage, activityRailCount: systemView.activityRailCount,
      activityOpenToggleCount: systemView.activityOpenToggleCount, activityCloseToggleCount: systemView.activityCloseToggleCount,
      leadSelectCount: systemView.leadSelectCount, leadSaveCount: systemView.leadSaveCount,
      savedAgentId: savedLead.selectedAgentId },
    cleanupQualificationPending: true }));
  return { workspace, plugin, preparedSessions, savedLead };
}
