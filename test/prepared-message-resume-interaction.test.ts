import assert from "node:assert/strict";
import test from "node:test";
import { performConversationControlAction, resumePreparedMessageInScope } from "../src/ui/prepared-message-resume.ts";

const requestId = "11111111-1111-4111-8111-111111111111";
const refreshNames = ["conversation", "lead", "design", "baseline", "technology", "workstreams", "memory", "projectCtos", "decisions", "contexts"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function interaction(scopeState: { current: string; token: object }, resume: () => Promise<{ saved: boolean; requestId: string }>, refreshed: string[]) {
  const scopeToken = scopeState.token;
  return () => resumePreparedMessageInScope({
    requestId,
    scopeToken,
    currentScopeToken: () => scopeState.token,
    resume,
    refreshCurrentScope: refreshNames.map(name => () => { refreshed.push(name); }),
  });
}

test("the resume control refreshes the current scope after success, including baseline and decisions", async () => {
  const scope = { current: "workspace-a:selection-4:user_conversation", token: {} };
  const refreshed: string[] = [];
  let busy = false;
  let feedback = "stale feedback";
  const action = interaction(scope, async () => ({ saved: true, requestId }), refreshed);

  await performConversationControlAction(action, busy, value => { busy = value; }, value => { feedback = value; });

  assert.equal(busy, false);
  assert.equal(feedback, "");
  assert.deepEqual(refreshed, refreshNames);
  assert.ok(refreshed.includes("baseline") && refreshed.includes("decisions"));
});

test("a failed resume refreshes the current scope and leaves a visible retry/status message", async () => {
  const scope = { current: "workspace-a:selection-4:user_conversation", token: {} };
  const refreshed: string[] = [];
  let busy = false;
  let feedback = "";
  const action = interaction(scope, async () => { throw new Error("fixture admission failed"); }, refreshed);

  await performConversationControlAction(action, busy, value => { busy = value; }, value => { feedback = value; });

  assert.equal(busy, false);
  assert.equal(feedback, "결과를 확인하지 못했습니다. 같은 실행의 상태를 다시 확인해 주세요.");
  assert.deepEqual(refreshed, refreshNames);
  assert.ok(refreshed.includes("baseline") && refreshed.includes("decisions"));
});

test("the UI action stays busy while pending and ignores a duplicate click", async () => {
  const operation = deferred<void>();
  let busy = false;
  let feedback = "";
  let actionCalls = 0;
  const action = async () => { actionCalls += 1; await operation.promise; };
  const setBusy = (value: boolean) => { busy = value; };
  const setFeedback = (value: string) => { feedback = value; };

  const first = performConversationControlAction(action, busy, setBusy, setFeedback);
  assert.equal(busy, true);
  const duplicate = await performConversationControlAction(action, busy, setBusy, setFeedback);
  assert.equal(duplicate, undefined);
  assert.equal(actionCalls, 1);
  assert.equal(feedback, "");

  operation.reject(new Error("fixture failure"));
  await first;
  assert.equal(busy, false);
  assert.equal(feedback, "결과를 확인하지 못했습니다. 같은 실행의 상태를 다시 확인해 주세요.");
});

test("a late success after pending A→B→A navigation cannot refresh the returned scope", async () => {
  const scope = { current: "workspace-a:selection-4:user_conversation", token: {} };
  const operation = deferred<{ saved: boolean; requestId: string }>();
  const refreshed: string[] = [];
  let feedback = "";
  let busy = false;
  const action = interaction(scope, () => operation.promise, refreshed);
  const pending = performConversationControlAction(action, busy, value => { busy = value; }, value => { feedback = value; });
  assert.equal(busy, true, "the explicit resume action stays busy while pending");
  scope.current = "workspace-a:selection-4:ui_design";
  scope.token = {};
  scope.current = "workspace-a:selection-4:user_conversation";
  scope.token = {};
  operation.resolve({ saved: true, requestId });
  await pending;

  assert.equal(busy, false);
  assert.equal(feedback, "");
  assert.deepEqual(refreshed, [], "the old A action cannot refresh the returned A scope");
});

test("a late error after pending A→B→A navigation cannot report or refresh in the returned scope", async () => {
  const scope = { current: "workspace-a:selection-4:user_conversation", token: {} };
  const operation = deferred<{ saved: boolean; requestId: string }>();
  const refreshed: string[] = [];
  let feedback = "";
  let busy = false;
  const action = interaction(scope, () => operation.promise, refreshed);
  const pending = performConversationControlAction(action, busy, value => { busy = value; }, value => { feedback = value; });
  scope.current = "workspace-a:selection-4:ui_design";
  scope.token = {};
  scope.current = "workspace-a:selection-4:user_conversation";
  scope.token = {};
  operation.reject(new Error("fixture failure after navigation"));
  await pending;

  assert.equal(busy, false);
  assert.deepEqual(refreshed, [], "the old A error cannot refresh the returned A scope");
  assert.equal(feedback, "", "the old A error cannot set feedback in the returned scope");
});

test("late success after leaving and returning to a Workspace cannot refresh that Workspace", async () => {
  const scope = { current: "workspace-a:selection-4:user_conversation", token: {} };
  const operation = deferred<{ saved: boolean; requestId: string }>();
  const refreshed: string[] = [];
  const action = interaction(scope, () => operation.promise, refreshed);
  const pending = performConversationControlAction(action, false, () => {}, () => {});
  scope.current = "";
  scope.token = {};
  scope.current = "workspace-a:selection-4:user_conversation";
  scope.token = {};
  operation.resolve({ saved: true, requestId });
  await pending;

  assert.deepEqual(refreshed, [], "returning to the same Workspace does not revive the old action");
});

test("late error after leaving and returning to a Workspace cannot report or refresh there", async () => {
  const scope = { current: "workspace-a:selection-4:user_conversation", token: {} };
  const operation = deferred<{ saved: boolean; requestId: string }>();
  const refreshed: string[] = [];
  let feedback = "";
  const action = interaction(scope, () => operation.promise, refreshed);
  const pending = performConversationControlAction(action, false, () => {}, value => { feedback = value; });
  scope.current = "";
  scope.token = {};
  scope.current = "workspace-a:selection-4:user_conversation";
  scope.token = {};
  operation.reject(new Error("fixture failure after Workspace return"));
  await pending;

  assert.deepEqual(refreshed, []);
  assert.equal(feedback, "", "the departed Workspace error cannot set feedback after return");
});
