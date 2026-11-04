import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { LEAD_CONTEXTS, type BuilderLeadContexts, type LeadContextId } from "../domain/lead-contexts.ts";
import { readLeadUserSource } from "../lead-conversations.ts";
import { parseLeadToolContext, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import { createDesignDraftStore } from "../design-draft-store.ts";
import { createLeadMemoryStore } from "../lead-memory-store.ts";
import type { RevisionState } from "../solution-revision-store.ts";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const SOURCE_ID = /^(?:consultation-[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}|lead-turn:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;
const MAX_RANGE_LINES = 200;
const MAX_RANGE_BYTES = 32 * 1024;
const MAX_QUERY_BYTES = 96 * 1024;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export type LeadKnowledgeSourceRange = Readonly<{ sourceId: string; fromLine: number; throughLine: number }>;
export type LeadKnowledgeSourceExcerpt = Readonly<{
  sourceId: string;
  sha256: string;
  verification: "persisted-workspace-lead-turn-cited-by-current-project-record";
  fromLine: number;
  throughLine: number;
  text: string;
}>;

export type LeadContextKnowledgeSnapshot = Readonly<{
  consistency: "independent-current-journal-reads";
  identity: Readonly<{
    workspaceId: string;
    projectId: string;
    selectionRevision: number;
    agentId: string;
    contextId: LeadContextId;
    sessionId: string;
  }>;
  /** Latest published Main design baseline; its source reference is not approval proof. */
  formalDesignRevision: null | Readonly<{
    revisionId: string;
    sourceDraftRevisionId: string;
    specification: Readonly<{ revisionId: string; requirements: readonly Readonly<{ id: string; description: string; acceptanceCriteriaIds: readonly string[] }>[] }>;
    graphRevisionId: string;
    userDecision: Readonly<{ sourceId: string; sourceSha256: string; interpretation: string }>;
    createdAt: string;
  }>;
  /** User-answer interpretations published with the current draft, separate from the formal baseline. */
  designDecisions: readonly Readonly<{
    questionId: string;
    answerSourceId: string;
    answerSourceSha256: string;
    answerText: string;
    fromDraftRevisionId: string;
    appliedDraftRevisionId: string;
  }>[];
  currentDraftRevisionId: string | null;
  sharedMemory: null | Readonly<{
    revisionId: string;
    entries: readonly Readonly<{ id: string; kind: string; text: string; sourceIds: readonly string[] }>[];
  }>;
}>;

/** The current importer exposes consultation indexes, not an original-text read API. */
export const UNSUPPORTED_SOURCE_LOOKUPS = Object.freeze(["consultation-original-text"] as const);
export const LEAD_KNOWLEDGE_CONTEXTS = Object.freeze([
  Object.freeze({ id: "user_conversation", label: "Main", visible: true }),
  Object.freeze({ id: "ui_design", label: "UI Design", visible: true }),
  Object.freeze({ id: "background_planning", label: "Background", visible: false }),
  Object.freeze({ id: "question_intake", label: "Question Intake", visible: false }),
  Object.freeze({ id: "question_discussion", label: "Question Discussion", visible: false }),
] as const satisfies readonly Readonly<{ id: LeadContextId; label: string; visible: boolean }>[]);

function parseRanges(value: unknown): LeadKnowledgeSourceRange[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 16
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Invalid bounded source range query.");
  const seen = new Set<string>();
  return Array.from({ length: value.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item?.enumerable || !Object.hasOwn(item, "value")) throw new TypeError("Source ranges must be dense data.");
    const range: unknown = item.value;
    if (!range || typeof range !== "object" || Array.isArray(range)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(range))
      || Reflect.ownKeys(range).length !== 3
      || Reflect.ownKeys(range).some(key => typeof key !== "string" || !["sourceId", "fromLine", "throughLine"].includes(key))) {
      throw new TypeError(`Invalid source range at index ${index}.`);
    }
    const sourceId = Object.getOwnPropertyDescriptor(range, "sourceId");
    const fromLine = Object.getOwnPropertyDescriptor(range, "fromLine");
    const throughLine = Object.getOwnPropertyDescriptor(range, "throughLine");
    if (![sourceId, fromLine, throughLine].every(field => field?.enumerable && Object.hasOwn(field, "value"))) {
      throw new TypeError(`Invalid source range at index ${index}.`);
    }
    const id = sourceId!.value, from = fromLine!.value, through = throughLine!.value;
    if (typeof id !== "string" || !SOURCE_ID.test(id)
      || !Number.isSafeInteger(from) || !Number.isSafeInteger(through)
      || (from as number) < 1 || (through as number) < (from as number)
      || (through as number) - (from as number) + 1 > MAX_RANGE_LINES) {
      throw new TypeError(`Invalid source range at index ${index}.`);
    }
    if (seen.has(id)) throw new TypeError("A source may appear only once in a deterministic range query.");
    seen.add(id);
    return Object.freeze({ sourceId: id, fromLine: from as number, throughLine: through as number });
  });
}

function lineOffsets(text: string): Readonly<{ starts: number[]; ends: number[] }> {
  const starts = [0], ends: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" || text[index] === "\n") {
      ends.push(index);
      if (text[index] === "\r" && text[index + 1] === "\n") index += 1;
      starts.push(index + 1);
    }
  }
  if (ends.length < starts.length) ends.push(text.length);
  return { starts, ends };
}

type SourceRecords = Readonly<{ citations: ReadonlySet<string>; digests: ReadonlyMap<string, readonly string[]> }>;

function projectSourceEvidence(baseline: Awaited<ReturnType<ReturnType<typeof createDesignBaselineStore>["current"]>>,
  draft: Awaited<ReturnType<ReturnType<typeof createDesignDraftStore>["current"]>>,
  memory: Awaited<ReturnType<ReturnType<typeof createLeadMemoryStore>["current"]>>): SourceRecords {
  const citations = new Set<string>();
  const digests = new Map<string, string[]>();
  const cite = (sourceId: string) => citations.add(sourceId);
  const addDigest = (sourceId: string, sha256: string) => {
    const values = digests.get(sourceId) ?? [];
    values.push(sha256);
    digests.set(sourceId, values);
  };
  if (baseline) {
    cite(baseline.revision.userDecision.sourceId);
    addDigest(baseline.revision.userDecision.sourceId, baseline.revision.userDecision.sourceSha256);
  }
  if (draft) {
    draft.revision.draft.sourceIds.forEach(cite);
    draft.revision.sourceDigests.forEach(digest => addDigest(digest.id, digest.sha256));
    draft.revision.decisions?.forEach(decision => {
      cite(decision.answerSourceId);
      addDigest(decision.answerSourceId, decision.answerSourceSha256);
    });
  }
  if (memory) {
    memory.revision.memory.entries.forEach(entry => entry.sourceIds.forEach(cite));
    memory.revision.sourceDigests.forEach(digest => addDigest(digest.id, digest.sha256));
  }
  return { citations, digests };
}

/**
 * Resolve read authority from the real Host run and current stored Lead selection.
 * The returned service is bound to that Workspace/context and one explicit project journal.
 */
export async function createLeadContextKnowledge(input: Readonly<{
  runContext: unknown;
  projectId: string;
  platform: SpsPlatformInvocationContext;
}>) {
  const host = parseLeadToolContext(input.runContext);
  if (typeof input.projectId !== "string" || !input.projectId.trim() || input.projectId.length > 160
    || /[\u0000-\u001f\u007f]/u.test(input.projectId)
    || host.projectId !== undefined && host.projectId !== input.projectId) {
    throw new TypeError("A bounded project ID matching any Host-supplied project binding is required.");
  }
  const authority = await resolveLeadToolAuthority(host, input.platform);
  const contexts = authority.contexts;
  const contextId = authority.logicalContext;
  if (!contexts || !contextId) throw new Error("Knowledge preparation requires the current five-context Lead selection; legacy sessions are unsupported.");
  const workspaceId = host.companyId;
  const projectId = input.projectId;
  const selection = { selectionRevision: authority.selectionRevision, agentId: host.agentId };
  const state = input.platform.state as typeof input.platform.state & RevisionState;
  const baselineStore = createDesignBaselineStore(workspaceId, projectId, state);
  const draftStore = createDesignDraftStore(workspaceId, projectId, selection, state);
  const memoryStore = createLeadMemoryStore(workspaceId, projectId, state);

  async function currentRecords() {
    await authority.check();
    const baseline = await baselineStore.current();
    await authority.check();
    const draft = await draftStore.current();
    await authority.check();
    const memory = await memoryStore.current();
    await authority.check();
    return { baseline, draft, memory };
  }

  return Object.freeze({
    async prepare(): Promise<LeadContextKnowledgeSnapshot> {
      const { baseline, draft, memory } = await currentRecords();
      const selectedSessionId = contexts.contexts[contextId];
      if (!selectedSessionId || selectedSessionId !== host.sessionId) throw new Error("The authorized Lead session identity changed.");
      const revision = baseline?.revision;
      const decisions = draft?.revision.decisions ?? [];
      return Object.freeze({
        consistency: "independent-current-journal-reads",
        identity: Object.freeze({ workspaceId, projectId, selectionRevision: contexts.selectionRevision,
          agentId: contexts.agentId, contextId, sessionId: selectedSessionId }),
        formalDesignRevision: revision ? Object.freeze({ revisionId: revision.revisionId,
          sourceDraftRevisionId: revision.sourceDraftRevisionId,
          specification: Object.freeze({ revisionId: revision.specification.revisionId,
            requirements: revision.specification.requirements }), graphRevisionId: revision.graph.graphRevisionId,
          userDecision: revision.userDecision, createdAt: revision.createdAt }) : null,
        designDecisions: Object.freeze(decisions.map(decision => Object.freeze({ questionId: decision.questionId,
          answerSourceId: decision.answerSourceId, answerSourceSha256: decision.answerSourceSha256,
          answerText: decision.answerText, fromDraftRevisionId: decision.fromDraftRevisionId,
          appliedDraftRevisionId: decision.appliedDraftRevisionId }))),
        currentDraftRevisionId: draft?.revision.draft.revisionId ?? null,
        sharedMemory: memory ? Object.freeze({ revisionId: memory.revision.memory.revisionId,
          entries: memory.revision.memory.entries }) : null,
      });
    },

    /** Resolve exact persisted user turns only when a current project record cites the source ID. */
    async querySources(value: unknown): Promise<readonly LeadKnowledgeSourceExcerpt[]> {
      const ranges = parseRanges(value);
      const { baseline, draft, memory } = await currentRecords();
      const evidence = projectSourceEvidence(baseline, draft, memory);
      const output: LeadKnowledgeSourceExcerpt[] = [];
      let totalBytes = 0;
      for (const range of ranges) {
        if (!evidence.citations.has(range.sourceId)) {
          if (range.sourceId.startsWith("consultation-")) throw new Error("Consultation original-text lookup is unsupported by the current source API.");
          throw new Error(`Source ${range.sourceId} is absent from current Workspace/project records.`);
        }
        if (range.sourceId.startsWith("consultation-")) throw new Error("Consultation original-text lookup is unsupported by the current source API.");
        if (!range.sourceId.startsWith("lead-turn:")) throw new Error(`Source ${range.sourceId} has no supported original-text lookup.`);
        await authority.check();
        const source = await readLeadUserSource(range.sourceId.slice("lead-turn:".length), contexts, input.platform);
        await authority.check();
        if (source.id !== range.sourceId) throw new Error(`Source ${range.sourceId} does not match a persisted user turn in the current Workspace selection.`);
        const sourceSha256 = hash(source.text);
        const citedDigests = evidence.digests.get(range.sourceId) ?? [];
        if (citedDigests.length === 0) throw new Error(`Source ${range.sourceId} has no verifiable digest in current Workspace/project records.`);
        if (new Set(citedDigests).size !== 1) throw new Error(`Source ${range.sourceId} has conflicting digests in current Workspace/project records.`);
        if (citedDigests[0] !== sourceSha256) throw new Error(`Source ${range.sourceId} text does not match its current Workspace/project record digest.`);
        const lineMap = lineOffsets(source.text);
        if (range.throughLine > lineMap.starts.length) throw new RangeError(`Source ${range.sourceId} has no line ${range.throughLine}.`);
        const excerpt = source.text.slice(lineMap.starts[range.fromLine - 1]!, lineMap.ends[range.throughLine - 1]!);
        const bytes = new TextEncoder().encode(excerpt).byteLength;
        if (bytes > MAX_RANGE_BYTES || totalBytes + bytes > MAX_QUERY_BYTES) throw new RangeError("Requested source excerpts exceed the bounded query size.");
        totalBytes += bytes;
        output.push(Object.freeze({ sourceId: range.sourceId, sha256: sourceSha256,
          verification: "persisted-workspace-lead-turn-cited-by-current-project-record",
          fromLine: range.fromLine, throughLine: range.throughLine, text: excerpt }));
      }
      await authority.check();
      return Object.freeze(output);
    },
  });
}

export type { LeadContextId };
