import { createHash, randomUUID } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import { readLeadUserTurn } from "../lead-conversations.ts";
import type { ReuseFirstScope, ReuseFirstSourceReader, ReuseFirstState } from "./index.ts";
import { createReuseFirstStore } from "./index.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_LINES = 200;
const scopeFor = (workspaceId: string, projectId: string): ReuseFirstScope => Object.freeze({ workspaceId, projectId });

function project(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("A bounded Builder project ID is required.");
  }
  return value;
}

function expectedRevision(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("An exact current Reuse-First revision ID or null is required.");
  }
  return value;
}

function candidateReference(value: unknown) {
  const fields = exactToolRecord(value, ["candidateId", "name", "kind", "originUrl", "originVersion", "source",
    "productTier", "route", "deliveryTargets"]);
  const source = exactToolRecord(fields.source, ["sourceId", "fromLine", "throughLine"]);
  if (typeof source.sourceId !== "string" || !source.sourceId.startsWith("lead-turn:")) {
    throw new TypeError("Reuse evidence must cite an existing authenticated Lead user turn, not consultation material.");
  }
  const requestId = source.sourceId.slice("lead-turn:".length);
  if (!UUID.test(requestId) || !Number.isSafeInteger(source.fromLine) || !Number.isSafeInteger(source.throughLine)
    || (source.fromLine as number) < 1 || (source.throughLine as number) < (source.fromLine as number)
    || (source.throughLine as number) - (source.fromLine as number) >= MAX_LINES) {
    throw new TypeError("Reuse evidence must cite a bounded line range in an existing Lead user turn.");
  }
  return Object.freeze({ ...fields, source: Object.freeze({ sourceId: source.sourceId,
    fromLine: source.fromLine, throughLine: source.throughLine }) });
}

function ensureProjectContext(inputProject: string, workspaceId: string, contextProject: string | undefined) {
  if (inputProject !== workspaceId || contextProject !== undefined && contextProject !== inputProject) {
    throw new Error("Reuse-First project does not match the current Host project scope.");
  }
}

function guardedState(platform: SpsPlatformInvocationContext, check: () => Promise<void>, checkSource?: () => Promise<void>): ReuseFirstState {
  const state = platform.state as typeof platform.state & ReuseFirstState;
  if (typeof state.compareAndSet !== "function") throw new Error("Unsupported Host: atomic state.compareAndSet is required.");
  return Object.freeze({
    async get(key) {
      await check();
      const value = await state.get(key);
      await check();
      return value;
    },
    async compareAndSet(key, expected, value) {
      await check();
      if (key.stateKey.startsWith("reuse-first-head.v1.")) await checkSource?.();
      const result = await state.compareAndSet!(key, expected, value);
      await check();
      if (result.swapped && key.stateKey.startsWith("reuse-first-head.v1.")) await checkSource?.();
      return result;
    },
  });
}

function sourceReader(scope: ReuseFirstScope, authority: Awaited<ReturnType<typeof resolveLeadToolAuthority>>,
  platform: SpsPlatformInvocationContext): ReuseFirstSourceReader {
  return Object.freeze({
    async currentScope() {
      await authority.check();
      return scope;
    },
    async readCurrentExcerpt(input) {
      await authority.check();
      if (!input.sourceId.startsWith("lead-turn:") || input.sourceId.startsWith("consultation-")) return null;
      const requestId = input.sourceId.slice("lead-turn:".length);
      if (!UUID.test(requestId)) return null;
      const turn = await readLeadUserTurn(requestId, authority.sessions, platform);
      if (`lead-turn:${turn.requestId}` !== input.sourceId || turn.workspaceId !== scope.workspaceId
        || !["main", "decisions"].includes(turn.channel)) return null;
      const starts = [0], ends: number[] = [];
      for (const newline of turn.text.matchAll(/\r\n|\n|\r/gu)) {
        ends.push(newline.index);
        starts.push(newline.index + newline[0].length);
      }
      ends.push(turn.text.length);
      if (input.fromLine > starts.length || input.throughLine > starts.length) return null;
      const excerptText = turn.text.slice(starts[input.fromLine - 1], ends[input.throughLine - 1]);
      if (!excerptText.trim() || Buffer.byteLength(excerptText, "utf8") > 32 * 1024) return null;
      const reread = await readLeadUserTurn(requestId, authority.sessions, platform);
      await authority.check();
      if (reread.workspaceId !== turn.workspaceId || reread.selectionRevision !== turn.selectionRevision
        || reread.agentId !== turn.agentId || reread.sessionId !== turn.sessionId || reread.channel !== turn.channel
        || reread.runId !== turn.runId || reread.text !== turn.text) return null;
      return Object.freeze({ workspaceId: scope.workspaceId, projectId: scope.projectId, sourceId: input.sourceId,
        fromLine: input.fromLine, throughLine: input.throughLine,
        sha256: createHash("sha256").update(excerptText, "utf8").digest("hex"), text: excerptText });
    },
  });
}

/** Background records reuse candidates from exact existing same-Workspace Lead user evidence only. */
export async function recordLeadReuseFirstCandidate(params: unknown, runContext: unknown,
  platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "expectedRevisionId", "candidate"]);
  const projectId = project(input.projectId);
  const expectedRevisionId = expectedRevision(input.expectedRevisionId);
  const candidate = candidateReference(input.candidate);
  const context = parseLeadToolContext(runContext);
  const authority = await resolveLeadToolAuthority(context, platform);
  ensureProjectContext(projectId, context.companyId, context.projectId);
  if (authority.channel !== "background") throw new Error("Only the Background Lead context may record Reuse-First candidates.");
  await authority.check();
  const scope = scopeFor(context.companyId, projectId);
  const reader = sourceReader(scope, authority, platform);
  const sourceRef = candidate.source as { sourceId: string; fromLine: number; throughLine: number };
  const original = await reader.readCurrentExcerpt(sourceRef);
  if (!original) throw new Error("Current project research source is unavailable.");
  const checkSource = async () => {
    const latest = await reader.readCurrentExcerpt(sourceRef);
    if (JSON.stringify(latest) !== JSON.stringify(original)) throw new Error("Reuse research source changed before the result could be confirmed.");
  };
  const pinnedReader: ReuseFirstSourceReader = { ...reader, async readCurrentExcerpt(ref) {
    const latest = await reader.readCurrentExcerpt(ref);
    if (JSON.stringify(latest) !== JSON.stringify(original)) throw new Error("Reuse research source changed before publication.");
    return latest;
  } };
  const store = createReuseFirstStore(scope, guardedState(platform, authority.check, checkSource), pinnedReader);
  const result = await store.publish({ expectedRevisionId, revisionId: randomUUID(), candidate });
  await authority.check();
  return { content: result.status === "published"
    ? "Reuse candidate recorded from current same-Workspace Lead source evidence. License and reuse eligibility remain unverified and blocked."
    : result.status === "conflict" ? "Reuse-First changed. Read the current revision before preparing a new CAS request."
    : "Current same-project source evidence is unavailable; no candidate was recorded.",
  data: result as unknown as JsonValue };
}

/** Main and Background can read only the current immutable Reuse-First project journal. */
export async function readLeadReuseFirstCandidates(params: unknown, runContext: unknown,
  platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId"]);
  const projectId = project(input.projectId);
  const context = parseLeadToolContext(runContext);
  const authority = await resolveLeadToolAuthority(context, platform);
  ensureProjectContext(projectId, context.companyId, context.projectId);
  if (authority.channel !== "main" && authority.channel !== "background") {
    throw new Error("Only Main or Background may read Reuse-First candidates.");
  }
  await authority.check();
  const scope = scopeFor(context.companyId, projectId);
  const current = await createReuseFirstStore(scope, guardedState(platform, authority.check), sourceReader(scope, authority, platform)).current();
  await authority.check();
  return { content: current
    ? "Current project-scoped Reuse-First candidate journal. Source quotes are reports, not license, compatibility, capability, or reuse approval."
    : "No Reuse-First candidate revision is recorded for this project.",
  data: { projectId, current } as unknown as JsonValue };
}
