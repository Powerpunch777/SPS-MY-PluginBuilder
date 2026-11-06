import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseProjectCtos, type ProjectCto, type ProjectCtoRegistry } from "./domain/project-ctos.ts";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { OWNED_AGENT_CAPABILITIES } from "./tool-declarations.mjs";

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

type OwnedProfileClient = Readonly<{
  get(input: { companyId: string; pluginAgentKey: string }): Promise<unknown>;
  ensure(input: { companyId: string; pluginAgentKey: string; config: { name: string; role: "engineer"; title: "Builder CTO"; instructions: string };
    adapterPreference?: readonly string[] }): Promise<unknown>;
}>;
const ownedProfileClient = (platform: SpsPlatformInvocationContext) =>
  (platform.agents as typeof platform.agents & { owned?: OwnedProfileClient }).owned;
const ownedProfileKey = (projectId: string, ctoId: string) => `builder-cto:${hash(JSON.stringify([projectId, ctoId]))}`;
const activeProfile = (status: string) => status === "idle" || status === "running";

function readOwnedProfile(receipt: unknown): { agentId: string; status: string } | null {
  const row = exactToolRecord(receipt, ["status"], ["revision", "agent"]);
  if (!["created", "resolved"].includes(row.status as string) || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1) return null;
  const agent = exactToolRecord(row.agent, ["agentId", "status"],
    ["name", "role", "title", "icon", "capabilities", "adapterType", "instructions", "executionDefaults"]);
  if (typeof agent.agentId !== "string" || !uuid.test(agent.agentId) || typeof agent.status !== "string") return null;
  return { agentId: agent.agentId, status: agent.status };
}

export async function assertCtoProfileCanBeDispatched(workspaceId: string, projectId: string, cto: ProjectCto,
  platform: SpsPlatformInvocationContext) {
  if (cto.agentId === cto.createdBy.agentId) return; // Existing scoped planning-session path.
  const owned = ownedProfileClient(platform);
  if (projectId !== workspaceId || typeof owned?.get !== "function") throw new Error("The CTO's current Host ownership is unavailable.");
  const profile = readOwnedProfile(await owned.get({ companyId: workspaceId, pluginAgentKey: ownedProfileKey(projectId, cto.ctoId) }));
  if (!profile || profile.agentId !== cto.agentId || !activeProfile(profile.status)) {
    throw new Error("The CTO profile is inactive or its current Host ownership changed. No send is authorized.");
  }
}

/** Prepares an identity and a keyed session without acquiring execution or starting a Run. */
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
  requireLeadFormalPublicationAuthority(authority);
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
  const owned = ownedProfileClient(platform);
  const useOwned = OWNED_AGENT_CAPABILITIES.length > 0 || owned !== undefined || Boolean(cto && cto.agentId !== cto.createdBy.agentId);
  let agentId = cto?.agentId ?? context.agentId;
  let profileStatus: string | null = null;
  if (useOwned) {
    if (projectId !== context.companyId || context.projectId !== undefined && context.projectId !== projectId) {
      throw new Error("A CTO profile requires the authenticated single-project Workspace.");
    }
    if (!owned || typeof owned.get !== "function" || typeof owned.ensure !== "function") {
      return profilePending("host-owned-agent-api-unavailable");
    }
    if (cto && cto.agentId === cto.createdBy.agentId) return profilePending("existing-shared-planning-identity-preserved");
    const pluginAgentKey = ownedProfileKey(projectId, ctoId);
    await authority.check();
    const before = await owned.get({ companyId: context.companyId, pluginAgentKey });
    await authority.check();
    const row = exactToolRecord(before, ["status"], ["revision", "agent"]);
    let receipt = before;
    if (row.status === "missing" && !cto) {
      let adapterPreference: readonly string[];
      try {
        await authority.check();
        const descriptor = exactToolRecord(await platform.agents.describeExecution(context.agentId, context.companyId),
          ["agentId", "adapterType", "state", "adapterRegistration", "executionOwner", "authorization", "readiness", "node"]);
        if (descriptor.agentId !== context.agentId || typeof descriptor.adapterType !== "string"
          || !descriptor.adapterType.trim() || descriptor.adapterType.length > 80
          || descriptor.state !== "configured" || descriptor.adapterRegistration !== "registered"
          || descriptor.executionOwner !== "adapter") return profilePending("current-lead-adapter-not-confirmed");
        adapterPreference = [descriptor.adapterType];
      } catch {
        return profilePending("current-lead-adapter-observation-unavailable");
      }
      await authority.check();
      receipt = await owned.ensure({ companyId: context.companyId, pluginAgentKey, adapterPreference,
        config: { name: displayName, role: "engineer", title: "Builder CTO",
          instructions: "Work only on the assigned Builder workstream under its current Task, Revision and Host permissions. Registration does not authorize execution or changes outside scope." } });
    }
    await authority.check();
    const profile = readOwnedProfile(receipt);
    if (!profile) return profilePending("host-owned-profile-unavailable");
    if (profile.agentId === context.agentId || cto && profile.agentId !== cto.agentId
      || current.value.ctos.some(record => record.ctoId !== ctoId && record.agentId === profile.agentId)) {
      return profilePending("owned-profile-identity-conflict");
    }
    if (!activeProfile(profile.status) && profile.status !== "paused") {
      return profilePending("host-profile-not-active", profile.agentId);
    }
    agentId = profile.agentId;
    profileStatus = profile.status;
  }
  const agents = await platform.agents.list({ companyId: context.companyId, limit: 100 });
  await authority.check();
  if (!Array.isArray(agents) || agents.length > 100 || agents.some(agent => agent.companyId !== context.companyId)
    || !agents.some(agent => agent.id === agentId && (useOwned ? agent.status === profileStatus : activeProfile(agent.status as string)))) {
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
    || Object.values(authority.sessions.sessions).includes(result.sessionId)
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
  return { content: useOwned
    ? "A distinct Host-owned CTO profile and its keyed session are registered. No execution readiness, technical permission, QA or task progress is established."
    : "A project-local planning session on the existing Lead execution Agent is registered. This is not a distinct CTO Agent or execution readiness.",
    data: { status: "registered", executionStarted: false, identityKind: useOwned ? "plugin-owned" : "shared-planning",
      observedProfileStatus: profileStatus, executionReadiness: "unknown", cto: registered } as unknown as JsonValue };
}
function profilePending(reason: string, agentId: string | null = null) {
  return { content: "No CTO session or Run was started. Inspect the same profile/Host delegation before an explicit recheck.",
    data: { status: "profile-pending", reason, agentId, executionStarted: false } as JsonValue };
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
