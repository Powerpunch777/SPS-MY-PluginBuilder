import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectCtos, type ProjectCto, type ProjectCtoRegistry } from "../src/domain/project-ctos.ts";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CREATOR_SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CREATED_AT = "2026-11-02T03:04:05.006Z";

function cto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ctoId: "cto-1",
    displayName: "Build coordinator",
    agentId: AGENT,
    sessionId: SESSION,
    status: "ACTIVE",
    createdAt: CREATED_AT,
    createdBy: { agentId: AGENT, sessionId: CREATOR_SESSION, runId: RUN, selectionRevision: 1 },
    ...overrides,
  };
}

function registry(ctos: unknown[] = [cto()], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, workspaceId: WORKSPACE, projectId: "project-1", revision: 1, ctos, ...overrides };
}

function parse(value: unknown): ProjectCtoRegistry {
  return parseProjectCtos(value, WORKSPACE, "project-1");
}

test("returns a deeply frozen detached clone", () => {
  const input = registry();
  const parsed = parse(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.ctos, input.ctos);
  assert.notEqual(parsed.ctos[0], (input.ctos as object[])[0]);
  assert.notEqual(parsed.ctos[0]!.createdBy, ((input.ctos as Record<string, unknown>[])[0]!.createdBy));
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.ctos));
  assert(Object.isFrozen(parsed.ctos[0]));
  assert(Object.isFrozen(parsed.ctos[0]!.createdBy));

  ((input.ctos as Record<string, unknown>[])[0]!).displayName = "Changed";
  ((input.ctos as unknown[])).push(cto({ ctoId: "cto-2" }));
  assert.equal(parsed.ctos[0]!.displayName, "Build coordinator");
  assert.equal(parsed.ctos.length, 1);
  assert.throws(() => { (parsed.ctos[0] as { displayName: string }).displayName = "mutated"; }, TypeError);
});

test("enforces workspace and project isolation and allows only the empty initial revision", () => {
  assert.deepEqual(parseProjectCtos({ schemaVersion: 1, workspaceId: WORKSPACE, projectId: "project-1", revision: 0, ctos: [] }, WORKSPACE, "project-1").ctos, []);
  assert.throws(() => parseProjectCtos(registry(), "ffffffff-ffff-4fff-8fff-ffffffffffff", "project-1"), /cross-workspace\/project/);
  assert.throws(() => parseProjectCtos(registry(), WORKSPACE, "project-2"), /cross-workspace\/project/);
  assert.throws(() => parse(registry([], { revision: 1 })), /inconsistent/);
  assert.throws(() => parse(registry([cto()], { revision: 0 })), /inconsistent/);
});

test("accepts all statuses, nullable sessions, and retired records without policy inference", () => {
  const entries = [
    cto({ ctoId: "available", sessionId: null, status: "AVAILABLE" }),
    cto({ ctoId: "active", sessionId: SESSION, status: "ACTIVE" }),
    cto({ ctoId: "retired", sessionId: null, status: "RETIRED" }),
  ];
  const parsed = parse(registry(entries));
  assert.deepEqual(parsed.ctos.map(item => item.status), ["AVAILABLE", "ACTIVE", "RETIRED"]);
  assert.equal(parsed.ctos[0]!.sessionId, null);
  assert.equal(parsed.ctos[2]!.sessionId, null);
});

test("rejects non-record values, fields, symbols, prototypes, and accessors without invoking getters", () => {
  for (const value of [null, undefined, false, 3, "registry", [], () => undefined]) {
    assert.throws(() => parse(value), TypeError);
  }
  const missing = registry();
  delete missing.revision;
  assert.throws(() => parse(missing), /unknown or missing fields/);
  assert.throws(() => parse(registry([cto({ unexpected: true })])), /unknown or missing fields/);
  const withSymbol = registry();
  Object.defineProperty(withSymbol, Symbol("extra"), { value: true });
  assert.throws(() => parse(withSymbol), /unknown or missing fields/);
  assert.throws(() => parse(Object.assign(Object.create({ inherited: true }), registry())), /plain record/);

  let calls = 0;
  const accessor = cto();
  Object.defineProperty(accessor, "displayName", { enumerable: true, get() { calls += 1; return "Build coordinator"; } });
  assert.throws(() => parse(registry([accessor])), /data field/);
  const creatorAccessor = cto({ createdBy: { agentId: AGENT, sessionId: CREATOR_SESSION, runId: RUN, selectionRevision: 1 } });
  Object.defineProperty(creatorAccessor.createdBy as object, "runId", { enumerable: true, get() { calls += 1; return RUN; } });
  assert.throws(() => parse(registry([creatorAccessor])), /data field/);
  assert.equal(calls, 0);
});

test("rejects sparse, accessor, custom-prototype, and extra-property arrays", () => {
  const sparse = new Array(1);
  assert.throws(() => parse(registry(sparse)), /dense/);
  const extra = [cto()] as unknown[] & { extra?: boolean };
  extra.extra = true;
  assert.throws(() => parse(registry(extra)), /dense/);
  const accessor = [cto()];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => parse(registry(accessor)), /dense data/);
  assert.throws(() => parse(registry(Object.setPrototypeOf([cto()], {}) as unknown[])), /standard array/);
});

test("validates canonical UUIDs, IDs, display-name UTF-8 bounds, statuses, timestamps, and revisions", () => {
  assert.throws(() => parseProjectCtos(registry(), WORKSPACE.toUpperCase(), "project-1"), /canonical lowercase UUID/);
  assert.throws(() => parse(registry([cto({ agentId: AGENT.toUpperCase() })])), /canonical lowercase UUID/);
  assert.throws(() => parse(registry([cto({ sessionId: "not-a-uuid" })])), /canonical lowercase UUID/);
  for (const value of ["", "  ", "x".repeat(161), "bad\u0000id", "bad\u007fid"]) {
    assert.throws(() => parse(registry([cto({ ctoId: value })])), /identifier/);
  }
  assert.throws(() => parse(registry([], { projectId: "\n" })), /projectId/);
  assert.throws(() => parse(registry([cto({ displayName: "  " })])), /displayName/);
  assert.throws(() => parse(registry([cto({ displayName: "bad\u0001name" })])), /displayName/);
  assert.equal(parse(registry([cto({ displayName: "😀".repeat(128) })])).ctos[0]!.displayName.length, 256);
  assert.throws(() => parse(registry([cto({ displayName: "😀".repeat(129) })])), /512 UTF-8 bytes/);
  assert.throws(() => parse(registry([cto({ status: "PAUSED" })])), /status/);
  for (const createdAt of ["2026-11-02T03:04:05Z", "2026-02-30T03:04:05.006Z", "2026-11-02T03:04:05.006+00:00"]) {
    assert.throws(() => parse(registry([cto({ createdAt })])), /canonical ISO/);
  }
  for (const selectionRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parse(registry([cto({ createdBy: { agentId: AGENT, sessionId: CREATOR_SESSION, runId: RUN, selectionRevision } })])), /positive safe integer/);
  }
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parse(registry([cto()], { revision })), /nonnegative safe integer/);
  }
});

test("rejects duplicate CTO IDs, duplicate non-null sessions, and more than 100 entries", () => {
  assert.throws(() => parse(registry([cto(), cto({ displayName: "Second" })])), /duplicate CTO IDs/);
  assert.throws(() => parse(registry([cto(), cto({ ctoId: "cto-2" })])), /duplicate non-null session IDs/);
  assert.throws(() => parse(registry(Array.from({ length: 101 }, (_, index) => cto({ ctoId: `cto-${index}`, sessionId: null })))), /at most 100/);
});
