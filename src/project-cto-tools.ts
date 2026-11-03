import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseProjectCtos, type ProjectCto, type ProjectCtoRegistry } from "./domain/project-ctos.ts";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const json = (value: unknown) => value as JsonValue;
function identifier(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("A bounded project/CTO ID is required.");
  }
  return value;
}
function registryKey(workspaceId: string, projectId: string) {
  // Validate both scope IDs before any Host access.
  parseProjectCtos({ schemaVersion: 1, workspaceId, projectId, revision: 0, ctos: [] }, workspaceId, projectId);
  return { scopeKind: "company" as const, scopeId: workspaceId, namespace: "sonpark.my-builder",
    stateKey: `project-ctos.v1.${hash(projectId)}` };
}
export async function readProjectCtos(workspaceId: string, projectId: string, platform: SpsPlatformInvocationContext) {
  const key = registryKey(workspaceId, projectId);
  const raw = await platform.state.get(key);
  return parseProjectCtos(raw ?? { schemaVersion: 1, workspaceId, projectId, revision: 0, ctos: [] }, workspaceId, projectId);
}

/** Logical CTO identity + one Core-owned session, never a new account or task execution. */
export async function createProjectCto(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "displayName"]);
  const projectId = identifier(input.projectId), ctoId = identifier(input.ctoId);
  if (typeof input.displayName !== "string" || !input.displayName.trim()
    || Buffer.byteLength(input.displayName, "utf8") > 512 || /[\u0000-\u001f\u007f]/.test(input.displayName)) {
    throw new TypeError("A bounded CTO display name is required.");
  }
  const displayName = input.displayName;
  const context = parseLeadToolContext(runContext);
  const key = registryKey(context.companyId, projectId);
  const authority = await resolveLeadToolAuthority(context, platform);
  if (typeof platform.state.compareAndSet !== "function" || typeof platform.agents.sessions.ensure !== "function") {
    throw new Error("Supported Host CAS and keyed session ensure are required; no get/set or create fallback.");
  }
  async function read() {
    await authority.check();
    const raw = await platform.state.get(key);
    await authority.check();
    return { raw, value: parseProjectCtos(raw ?? { schemaVersion: 1, workspaceId: context.companyId,
      projectId, revision: 0, ctos: [] }, context.companyId, projectId) };
  }
  async function save(base: Awaited<ReturnType<typeof read>>, ctos: readonly ProjectCto[]) {
    const value = parseProjectCtos({ ...base.value, revision: base.value.revision + 1, ctos }, context.companyId, projectId);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 192 * 1024) throw new Error("The project CTO registry is full.");
    await authority.check();
    const receipt = exactToolRecord(await platform.state.compareAndSet!(key,
      base.raw === null ? { exists: false } : { exists: true, value: base.raw }, json(value)), ["swapped"]);
    await authority.check();
    if (typeof receipt.swapped !== "boolean") throw new TypeError("Invalid conditional state receipt.");
    return receipt.swapped;
  }
  let current = await read();
  let cto = current.value.ctos.find(record => record.ctoId === ctoId);
  if (cto && (cto.displayName !== displayName || cto.status === "RETIRED")) {
    throw new Error("This CTO ID already refers to different or retired identity; existing history is unchanged.");
  }
  const agentId = cto?.agentId ?? context.agentId;
  const agents = await platform.agents.list({ companyId: context.companyId, limit: 100 });
  await authority.check();
  if (!Array.isArray(agents) || agents.length > 100 || agents.some(agent => agent.companyId !== context.companyId)
    || !agents.some(agent => agent.id === agentId && ["idle", "running"].includes(agent.status as string))) {
    throw new Error("The registered CTO execution Agent is unavailable in this Workspace.");
  }
  if (!cto) {
    cto = { ctoId, displayName, agentId, sessionId: null, status: "AVAILABLE", createdAt: new Date().toISOString(),
      createdBy: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId, selectionRevision: authority.selectionRevision } };
    if (!await save(current, [...current.value.ctos, cto])) return conflict();
    current = await read();
    cto = current.value.ctos.find(record => record.ctoId === ctoId)!;
  }
  if (!cto || cto.agentId !== agentId || cto.displayName !== displayName || cto.status === "RETIRED") throw new Error("The CTO identity changed.");
  await authority.check();
  const result = exactToolRecord(await platform.agents.sessions.ensure(agentId, context.companyId, {
    taskKey: `plugin:com.sonparkserver.my-plugin-builder:session:cto:${hash(`${context.companyId}\0${projectId}\0${ctoId}`)}`,
    ...(cto.sessionId === null ? {} : { expectedSessionId: cto.sessionId }),
  }), ["sessionId", "created"]);
  await authority.check();
  if (typeof result.sessionId !== "string" || !uuid.test(result.sessionId) || typeof result.created !== "boolean"
    || (authority.contexts !== null ? Object.values(authority.contexts.contexts).includes(result.sessionId)
      : Object.values(authority.sessions!.sessions).includes(result.sessionId))
    || cto.sessionId !== null && (result.sessionId !== cto.sessionId || result.created !== false)) {
    throw new TypeError("Invalid Host CTO session identity; no replacement or dispatch was attempted.");
  }
  if (cto.sessionId === null) {
    const latest = await read();
    const reserved = latest.value.ctos.find(record => record.ctoId === ctoId);
    if (JSON.stringify(reserved) !== JSON.stringify(cto)) return conflict();
    const updated = latest.value.ctos.map(record => record.ctoId === ctoId ? { ...record, sessionId: result.sessionId as string } : record);
    if (!await save(latest, updated)) return conflict();
  }
  const final = await read();
  const registered = final.value.ctos.find(record => record.ctoId === ctoId);
  if (!registered || registered.sessionId !== result.sessionId || registered.status === "RETIRED") return conflict();
  return { content: "Project-local logical CTO and a single independent session registered. The existing execution Agent/account configuration is unchanged. No task, code, provider execution, backend readiness, workstream approval or Graph completion is implied.",
    data: { status: "registered", executionStarted: false, cto: registered } as unknown as JsonValue };
}
function conflict() {
  return { content: "The CTO registry changed. Read current identities before an explicit retry; an existing keyed session may already be reserved. No execution was requested.",
    data: { status: "conflict", executionStarted: false } as JsonValue };
}

export async function listProjectCtos(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId"]);
  const projectId = identifier(input.projectId);
  const context = parseLeadToolContext(runContext);
  const authority = await resolveLeadToolAuthority(context, platform);
  const registry: ProjectCtoRegistry = await readProjectCtos(context.companyId, projectId, platform);
  await authority.check();
  return { content: "Project-local CTO identity/session records only. Session presence is not a live run or completed work; no private memory or transcript is included.",
    data: registry as unknown as JsonValue };
}
