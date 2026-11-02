import type { JsonValue, SpsPlatformInvocationContext, SpsAgentSessionRunResult } from "@sonparkserver/plugin-sdk/platform";
import type { BuilderLeadSessions, LeadChannel } from "./domain/model.ts";
import { LEAD_CHANNELS, parseLeadSessions } from "./domain/lead-sessions.ts";
import { parseQuestionContext, type QuestionContext } from "./domain/question-context.ts";
import { assertSessionExecutionPolicySupport, LEAD_SESSION_EXECUTION_POLICY, type SessionExecutionPolicy } from "./session-execution-policy.ts";
import { PROTECTED_SEND_UNAVAILABLE } from "./lead-send-feedback.ts";

type Scope = { workspaceId: string; selectionRevision: number; agentId: string; sessionId: string; channel: LeadChannel };
type TurnState = "prepared" | "dispatching" | "submitted" | "uncertain" | "succeeded" | "failed" | "cancelled" | "interrupted" | "timed_out";
export type LeadTurn = Scope & {
  schemaVersion: 1; requestId: string; previousRequestId: string | null; sequence: number;
  text: string; createdAt: string; state: TurnState; runId: string | null;
  answer: string | null; outputState: "not_ready" | "available" | "withheld" | "unsupported";
  cancellationRequested: boolean; termination: "not_applicable" | "pending" | "confirmed";
  questionContext?: QuestionContext;
  executionPolicy?: SessionExecutionPolicy;
};
type Head = Scope & { schemaVersion: 1; totalTurns: number; lastRequestId: string | null; activeRequestId: string | null };
export type LeadConversationActivity = Pick<LeadTurn, "requestId" | "state" | "runId" | "cancellationRequested" | "termination">;
export type LeadConversationPage = Scope & { totalTurns: number; active: LeadConversationActivity | null; turns: LeadTurn[]; nextCursor: string | null };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const STATES: readonly TurnState[] = ["prepared", "dispatching", "submitted", "uncertain", "succeeded", "failed", "cancelled", "interrupted", "timed_out"];
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted", "timed_out"]);
const SCOPE_KEYS = ["workspaceId", "selectionRevision", "agentId", "sessionId", "channel"];
const TURN_KEYS = [...SCOPE_KEYS, "schemaVersion", "requestId", "previousRequestId", "sequence", "text", "createdAt", "state", "runId", "answer", "outputState", "cancellationRequested", "termination"];
const HEAD_KEYS = [...SCOPE_KEYS, "schemaVersion", "totalTurns", "lastRequestId", "activeRequestId"];
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_PAGE_BYTES = 128 * 1024;
const MAX_TURNS = 1_000_000;
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const error = () => new Error("Lead conversation is unavailable or changed. Refresh without automatically resending.");

function record(value: unknown, keys: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error();
  const fields = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(fields);
  if (own.some(key => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))
    || optional.some(key => Object.hasOwn(fields, key) && (!fields[key]?.enumerable || !("value" in fields[key])))) throw error();
  return Object.fromEntries((own as string[]).map(key => [key, fields[key]!.value])) as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw error();
  return value;
}
function nullableId(value: unknown) { return value === null ? null : id(value); }
function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || byteLength(value) > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(value)
    || [...value].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) throw error();
  return value;
}
function matches(value: Record<string, unknown>, scope: Scope) {
  if (SCOPE_KEYS.some(key => value[key] !== scope[key as keyof Scope]) || value.schemaVersion !== 1) throw error();
}
function scopedKey(scope: Scope, stateKey: string) {
  return { scopeKind: "company" as const, scopeId: scope.workspaceId, namespace: "sonpark.my-builder", stateKey };
}
const headKey = (scope: Scope) => scopedKey(scope, `lead-chat.head.v1.${scope.selectionRevision}.${scope.channel}`);
const turnKey = (scope: Scope, requestId: string) => scopedKey(scope, `lead-chat.turn.v1.${id(requestId)}`);
const indexKey = (scope: Scope, sequence: number) => scopedKey(scope, `lead-chat.index.v1.${scope.selectionRevision}.${scope.channel}.${sequence}`);
function scopeFor(sessions: BuilderLeadSessions, channel: unknown): Scope {
  const selected = parseLeadSessions(sessions, sessions.workspaceId);
  if (typeof channel !== "string" || !LEAD_CHANNELS.includes(channel as LeadChannel) || !selected.agentId) throw error();
  const sessionId = selected.sessions[channel as LeadChannel];
  if (!sessionId) throw error();
  return { workspaceId: id(selected.workspaceId), selectionRevision: selected.selectionRevision,
    agentId: id(selected.agentId), sessionId: id(sessionId), channel: channel as LeadChannel };
}
function parseHead(value: unknown, scope: Scope): Head {
  if (value === null) return { ...scope, schemaVersion: 1, totalTurns: 0, lastRequestId: null, activeRequestId: null };
  const row = record(value, HEAD_KEYS); matches(row, scope);
  if (!Number.isSafeInteger(row.totalTurns) || (row.totalTurns as number) < 0 || (row.totalTurns as number) > MAX_TURNS) throw error();
  const lastRequestId = nullableId(row.lastRequestId), activeRequestId = nullableId(row.activeRequestId);
  if (row.totalTurns === 0 ? lastRequestId !== null || activeRequestId !== null : lastRequestId === null
    || activeRequestId !== null && activeRequestId !== lastRequestId) throw error();
  return { ...scope, schemaVersion: 1, totalTurns: row.totalTurns as number, lastRequestId, activeRequestId };
}
function parseTurn(value: unknown, scope: Scope): LeadTurn {
  const row = record(value, TURN_KEYS, ["questionContext", "executionPolicy"]); matches(row, scope);
  const questionContext = Object.hasOwn(row, "questionContext") ? parseQuestionContext(row.questionContext) : undefined;
  const executionPolicy = Object.hasOwn(row, "executionPolicy") ? parseStoredPolicy(row.executionPolicy) : undefined;
  if (questionContext && scope.channel !== "decisions") throw error();
  const requestId = id(row.requestId), previousRequestId = nullableId(row.previousRequestId), runId = nullableId(row.runId);
  if (requestId === previousRequestId || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 0
    || (row.sequence as number) >= MAX_TURNS || (row.sequence === 0) !== (previousRequestId === null)
    || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) || new Date(row.createdAt).toISOString() !== row.createdAt
    || !STATES.includes(row.state as TurnState) || !["not_ready", "available", "withheld", "unsupported"].includes(row.outputState as string)
    || typeof row.cancellationRequested !== "boolean" || !["not_applicable", "pending", "confirmed"].includes(row.termination as string)
    || row.cancellationRequested === false && row.termination !== "not_applicable"
    || row.cancellationRequested === true && row.termination === "not_applicable"
    || ["prepared", "dispatching", "uncertain"].includes(row.state as string) && runId !== null
    || !["prepared", "dispatching", "uncertain"].includes(row.state as string) && runId === null
    || (row.answer !== null) !== (row.outputState === "available") || row.answer !== null && row.state !== "succeeded") throw error();
  return { ...scope, schemaVersion: 1, requestId, previousRequestId, sequence: row.sequence as number,
    text: text(row.text, MAX_TEXT_BYTES), createdAt: row.createdAt, state: row.state as TurnState, runId,
    answer: row.answer === null ? null : text(row.answer, 65_536), outputState: row.outputState as LeadTurn["outputState"],
    cancellationRequested: row.cancellationRequested, termination: row.termination as LeadTurn["termination"],
    ...(questionContext ? { questionContext } : {}), ...(executionPolicy ? { executionPolicy } : {}) };
}
function parseStoredPolicy(value: unknown): SessionExecutionPolicy {
  const row = record(value, ["mode", "toolNames"]);
  if (row.mode !== "plugin-tools-only-v1" || !Array.isArray(row.toolNames) || Object.getPrototypeOf(row.toolNames) !== Array.prototype
    || row.toolNames.length < 1 || row.toolNames.length > 32 || Reflect.ownKeys(row.toolNames).length !== row.toolNames.length + 1) throw error();
  const names: string[] = [];
  for (let n = 0; n < row.toolNames.length; n++) {
    const field = Object.getOwnPropertyDescriptor(row.toolNames, String(n));
    if (!field?.enumerable || !Object.hasOwn(field, "value") || typeof field.value !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(field.value)) throw error();
    names.push(field.value);
  }
  if (new Set(names).size !== names.length) throw error();
  return Object.freeze({ mode: "plugin-tools-only-v1", toolNames: Object.freeze(names.sort()) });
}
const active = (turn: LeadTurn) => !TERMINAL.has(turn.state) || turn.cancellationRequested && turn.termination !== "confirmed";
async function save(platform: SpsPlatformInvocationContext, scope: Scope, key: string, value: unknown, check: () => Promise<void>) {
  await check();
  await platform.state.set(scopedKey(scope, key), value as JsonValue);
  await check();
}
async function writeTurn(platform: SpsPlatformInvocationContext, scope: Scope, turn: LeadTurn, check: () => Promise<void>) {
  const checked = parseTurn(turn, scope);
  await save(platform, scope, turnKey(scope, turn.requestId).stateKey, checked, check);
  return checked;
}
async function writeHead(platform: SpsPlatformInvocationContext, scope: Scope, head: Head, check: () => Promise<void>) {
  await save(platform, scope, headKey(scope).stateKey, parseHead(head, scope), check);
}
async function loadTurn(platform: SpsPlatformInvocationContext, scope: Scope, requestId: string) {
  const value = await platform.state.get(turnKey(scope, requestId));
  const turn = parseTurn(value, scope);
  if (turn.requestId !== requestId) throw error();
  return turn;
}

/** Internal source identity for tools that must bind a decision to its current run. */
export async function readLeadUserTurn(requestId: string, sessions: BuilderLeadSessions, platform: SpsPlatformInvocationContext) {
  const raw = await platform.state.get({ scopeKind: "company", scopeId: sessions.workspaceId,
    namespace: "sonpark.my-builder", stateKey: `lead-chat.turn.v1.${id(requestId)}` });
  const row = record(raw, TURN_KEYS, ["questionContext", "executionPolicy"]);
  if (row.channel !== "main" && row.channel !== "decisions") throw error();
  const scope = scopeFor(sessions, row.channel);
  const turn = parseTurn(raw, scope);
  if (turn.requestId !== requestId) throw error();
  return Object.freeze(turn);
}

/** User input only; assistant answers never become customer approval evidence. */
export async function readLeadUserSource(requestId: string, sessions: BuilderLeadSessions, platform: SpsPlatformInvocationContext) {
  const turn = await readLeadUserTurn(requestId, sessions, platform);
  return Object.freeze({ id: `lead-turn:${requestId}`, text: turn.text,
    ...(turn.questionContext ? { questionContext: turn.questionContext } : {}) });
}
function runProjection(turn: LeadTurn, result: SpsAgentSessionRunResult): LeadTurn {
  if (!result || result.runId !== turn.runId || !["queued", "running", "cancelling", ...TERMINAL].includes(result.status)
    || typeof result.cancellationRequested !== "boolean" || !["not_applicable", "pending", "confirmed"].includes(result.termination)) throw error();
  const state = TERMINAL.has(result.status) ? result.status as TurnState : "submitted";
  const output = result.output;
  const answer = state === "succeeded" && output?.state === "available" ? text(output.text, 65_536) : null;
  return { ...turn, state, answer,
    outputState: answer !== null ? "available" : output === undefined ? "unsupported" : output.state === "withheld" ? "withheld" : "not_ready",
    cancellationRequested: result.cancellationRequested, termination: result.termination };
}

export function parseLeadConversationPage(value: unknown, sessions: BuilderLeadSessions, channel: LeadChannel): LeadConversationPage {
  const scope = scopeFor(sessions, channel);
  const row = record(value, [...SCOPE_KEYS, "totalTurns", "active", "turns", "nextCursor"]);
  if (SCOPE_KEYS.some(key => row[key] !== scope[key as keyof Scope]) || !Number.isSafeInteger(row.totalTurns)
    || (row.totalTurns as number) < 0 || (row.totalTurns as number) > MAX_TURNS
    || !Array.isArray(row.turns) || row.turns.length > 10
    || Reflect.ownKeys(row.turns).length !== row.turns.length + 1) throw error();
  const turns = row.turns.map(entry => parseTurn(entry, scope));
  const seen = new Set<string>();
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]!;
    if (seen.has(turn.requestId) || turn.sequence >= (row.totalTurns as number)
      || index > 0 && (turn.sequence !== turns[index - 1]!.sequence - 1 || turns[index - 1]!.previousRequestId !== turn.requestId)) throw error();
    seen.add(turn.requestId);
  }
  const nextCursor = nullableId(row.nextCursor);
  if (turns.length === 0 ? row.totalTurns !== 0 || nextCursor !== null : nextCursor !== turns[turns.length - 1]!.previousRequestId) throw error();
  let activity: LeadConversationActivity | null = null;
  if (row.active !== null) {
    const value = record(row.active, ["requestId", "state", "runId", "cancellationRequested", "termination"]);
    if (!STATES.includes(value.state as TurnState) || typeof value.cancellationRequested !== "boolean"
      || !["not_applicable", "pending", "confirmed"].includes(value.termination as string)
      || value.cancellationRequested === false && value.termination !== "not_applicable"
      || value.cancellationRequested === true && value.termination === "not_applicable") throw error();
    const runId = nullableId(value.runId);
    if (["prepared", "dispatching", "uncertain"].includes(value.state as string) ? runId !== null : runId === null) throw error();
    activity = { requestId: id(value.requestId), state: value.state as TurnState, runId,
      cancellationRequested: value.cancellationRequested, termination: value.termination as LeadTurn["termination"] };
  }
  const result = { ...scope, totalTurns: row.totalTurns as number, active: activity, turns, nextCursor };
  if (byteLength(JSON.stringify(result)) > MAX_PAGE_BYTES + 8_192) throw error();
  return result;
}

/** Called only under the owning Workspace Worker's serialized write boundary.
 * Per-turn records plus a linked head avoid an ever-growing snapshot. This is
 * not cross-process CAS; Core must fence retired Worker invocations. */
export function createLeadConversationStore(platform: SpsPlatformInvocationContext, sessions: BuilderLeadSessions,
  check: () => Promise<void>, beforeDispatch: (questionContext?: QuestionContext) => Promise<void> = check) {
  async function requireSupportedPolicy(scope: Scope) {
    try { await assertSessionExecutionPolicySupport(platform, scope.sessionId, scope.workspaceId); }
    catch { throw new Error(PROTECTED_SEND_UNAVAILABLE); }
    await check();
  }
  async function refreshTurn(scope: Scope, turn: LeadTurn): Promise<LeadTurn> {
    await check();
    let current = turn;
    if (current.runId === null && current.state !== "prepared") {
      const receipt = await platform.agents.sessions.getRequest(scope.sessionId, scope.workspaceId, current.requestId);
      await check();
      if (receipt !== null && receipt.requestId !== current.requestId) throw error();
      if (receipt?.state === "submitted" && receipt.runId !== null) {
        current = await writeTurn(platform, scope, { ...current, runId: id(receipt.runId), state: "submitted" }, check);
      } else {
        // Unknown does not mean not executed. This path never invokes send.
        return writeTurn(platform, scope, { ...current, state: "uncertain" }, check);
      }
    }
    if (current.runId === null) return current;
    const result = await platform.agents.sessions.getRun(scope.sessionId, scope.workspaceId, current.runId);
    await check();
    return writeTurn(platform, scope, runProjection(current, result), check);
  }
  async function reconcile(scope: Scope, head: Head) {
    if (head.activeRequestId === null) return head;
    const turn = await refreshTurn(scope, await loadTurn(platform, scope, head.activeRequestId));
    if (turn.sequence !== head.totalTurns - 1) throw error();
    if (active(turn)) return head;
    const updated = { ...head, activeRequestId: null };
    await writeHead(platform, scope, updated, check);
    return updated;
  }
  return {
    async page(channel: LeadChannel, cursor: string | null = null): Promise<LeadConversationPage> {
      const scope = scopeFor(sessions, channel);
      await check();
      const head = parseHead(await platform.state.get(headKey(scope)), scope);
      let next = cursor === null ? head.lastRequestId : id(cursor);
      const turns: LeadTurn[] = [];
      const seen = new Set<string>();
      let bytes = 0;
      while (next !== null && turns.length < 10) {
        if (seen.has(next)) throw error();
        seen.add(next);
        const turn = await loadTurn(platform, scope, next);
        const indexed = record(await platform.state.get(indexKey(scope, turn.sequence)), ["requestId"]);
        if (indexed.requestId !== turn.requestId || turn.sequence >= head.totalTurns
          || cursor === null && turns.length === 0 && turn.sequence !== head.totalTurns - 1
          || turns.length && turn.sequence !== turns[turns.length - 1]!.sequence - 1) throw error();
        const size = byteLength(JSON.stringify(turn));
        if (turns.length && bytes + size > MAX_PAGE_BYTES) break;
        if (size > MAX_PAGE_BYTES) throw error();
        turns.push(turn); bytes += size; next = turn.previousRequestId;
      }
      const activeTurn = head.activeRequestId === null ? null : await loadTurn(platform, scope, head.activeRequestId);
      if (activeTurn && activeTurn.sequence !== head.totalTurns - 1) throw error();
      await check();
      const activity = activeTurn === null ? null : { requestId: activeTurn.requestId, state: activeTurn.state,
        runId: activeTurn.runId, cancellationRequested: activeTurn.cancellationRequested, termination: activeTurn.termination };
      return { ...scope, totalTurns: head.totalTurns, active: activity, turns, nextCursor: next };
    },
    async refresh(channel: LeadChannel) {
      const scope = scopeFor(sessions, channel);
      await check();
      const head = parseHead(await platform.state.get(headKey(scope)), scope);
      await reconcile(scope, head);
      await check();
      return { refreshed: true };
    },
    async send(channel: LeadChannel, requestId: string, value: string, questionValue?: QuestionContext) {
      const scope = scopeFor(sessions, channel);
      const questionContext = questionValue === undefined ? undefined : parseQuestionContext(questionValue);
      if (questionContext && channel !== "decisions") throw error();
      id(requestId); text(value, MAX_TEXT_BYTES);
      await check();
      let head = parseHead(await platform.state.get(headKey(scope)), scope);
      const existing = await platform.state.get(turnKey(scope, requestId));
      await check();
      let turn: LeadTurn;
      if (existing !== null) {
        turn = parseTurn(existing, scope);
        if (turn.requestId !== requestId || turn.text !== value
          || JSON.stringify(turn.questionContext) !== JSON.stringify(questionContext)) throw error();
        if (turn.state !== "prepared") {
          if (head.lastRequestId !== requestId && turn.sequence >= head.totalTurns) throw error();
          await reconcile(scope, head);
          return { saved: true, requestId };
        }
        // Recover only an unpublished prepared record with the same head. No
        // execution has been attempted before the dispatching record is saved.
        if (head.lastRequestId !== requestId
          && (turn.previousRequestId !== head.lastRequestId || turn.sequence !== head.totalTurns)) throw error();
        await beforeDispatch(questionContext);
        if (!turn.executionPolicy) throw new Error("This historical prepared turn has no execution restriction. Review it without resending.");
        await requireSupportedPolicy(scope);
      } else {
        head = await reconcile(scope, head);
        if (head.activeRequestId !== null || head.totalTurns >= MAX_TURNS) throw error();
        await beforeDispatch(questionContext);
        await requireSupportedPolicy(scope);
        // Probe the explicit receipt contract before ever sending. Older Hosts
        // must not silently ignore requestId and fall back to unkeyed execution.
        const prior = await platform.agents.sessions.getRequest(scope.sessionId, scope.workspaceId, requestId);
        await check();
        if (prior !== null) throw error();
        turn = await writeTurn(platform, scope, { ...scope, schemaVersion: 1, requestId,
          previousRequestId: head.lastRequestId, sequence: head.totalTurns, text: value, createdAt: new Date().toISOString(),
          state: "prepared", runId: null, answer: null, outputState: "not_ready",
          cancellationRequested: false, termination: "not_applicable",
          executionPolicy: LEAD_SESSION_EXECUTION_POLICY,
          ...(questionContext ? { questionContext } : {}) }, check);
      }
      if (head.lastRequestId !== requestId) {
        if (head.activeRequestId !== null) throw error();
        await save(platform, scope, indexKey(scope, turn.sequence).stateKey, { requestId }, check);
        head = { ...head, totalTurns: turn.sequence + 1, lastRequestId: requestId, activeRequestId: requestId };
        await writeHead(platform, scope, head, check);
      }
      if (head.activeRequestId !== requestId) throw error();
      turn = await writeTurn(platform, scope, { ...turn, state: "dispatching" }, check);
      await check();
      try {
        const prompt = turn.questionContext
          ? `Builder question association (not approval or execution authority): ${JSON.stringify(turn.questionContext)}\nUser message:\n${value}` : value;
        if (!turn.executionPolicy) throw error();
        const result = await platform.agents.sessions.sendMessage(scope.sessionId, scope.workspaceId,
          { prompt, requestId, executionPolicy: turn.executionPolicy });
        await check();
        await writeTurn(platform, scope, { ...turn, state: "submitted", runId: id(result.runId) }, check);
      } catch {
        // A failure to save this state still leaves the prior dispatching
        // marker. A later read recovers the same Core receipt, never resends.
        await writeTurn(platform, scope, { ...turn, state: "uncertain" }, check);
      }
      return { saved: true, requestId };
    },
    async cancel(channel: LeadChannel) {
      const scope = scopeFor(sessions, channel);
      await check();
      let head = parseHead(await platform.state.get(headKey(scope)), scope);
      head = await reconcile(scope, head);
      if (head.activeRequestId === null) return { cancellationRequested: false };
      const turn = await loadTurn(platform, scope, head.activeRequestId);
      if (turn.runId === null) throw error();
      await check();
      const result = await platform.agents.sessions.cancel(scope.sessionId, scope.workspaceId, turn.runId);
      await check();
      await writeTurn(platform, scope, runProjection(turn, result), check);
      await reconcile(scope, head);
      return { cancellationRequested: result.cancellationRequested };
    },
    async resumePrepared(channel: LeadChannel, requestId: string): Promise<{ saved: boolean; requestId: string }> {
      const scope = scopeFor(sessions, channel);
      await check();
      const head = parseHead(await platform.state.get(headKey(scope)), scope);
      if (head.activeRequestId !== id(requestId)) throw error();
      const turn = await loadTurn(platform, scope, requestId);
      if (turn.state !== "prepared") throw error();
      return this.send(channel, requestId, turn.text, turn.questionContext);
    },
  };
}
