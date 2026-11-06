import { parseDesignDraft, type DesignDraft } from "./domain/design-drafts.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import { createHash } from "node:crypto";
import { parseDesignDecisions, type DesignDecision } from "./domain/design-decisions.ts";

export type AuthoredDesignDraft = Readonly<{
  status: "draft";
  selectionRevision: number;
  author: Readonly<{ agentId: string; sessionId: string; runId: string }>;
  sourceDigests: readonly Readonly<{ id: string; sha256: string }>[];
  createdAt: string;
  draft: DesignDraft;
  decisions?: readonly DesignDecision[];
}>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** A retired Lead selection cannot publish into its successor's draft branch.
 * Old branches remain stored; selection does not approve, migrate or erase them. */
export function createDesignDraftStore(workspaceId: string, projectId: string,
  owner: { selectionRevision: number; agentId: string }, state: RevisionState) {
  if (!Number.isSafeInteger(owner.selectionRevision) || owner.selectionRevision < 1
    || typeof owner.agentId !== "string" || !UUID.test(owner.agentId)) throw new TypeError("A saved Lead selection is required.");
  const selectionRevision = owner.selectionRevision;
  const agentId = owner.agentId;
  const parse = (value: unknown): AuthoredDesignDraft => {
    const row = exactToolRecord(value, ["status", "selectionRevision", "author", "sourceDigests", "createdAt", "draft"], ["decisions"]);
    if (row.status !== "draft" || row.selectionRevision !== selectionRevision) throw new TypeError("Invalid draft selection or approval claim.");
    const author = exactToolRecord(row.author, ["agentId", "sessionId", "runId"]);
    if (author.agentId !== agentId || Object.values(author).some(id => typeof id !== "string" || !UUID.test(id))) {
      throw new TypeError("Invalid design draft author.");
    }
    const draft = parseDesignDraft(row.draft, projectId);
    const decisions = parseDesignDecisions(row.decisions, draft);
    for (const decision of decisions) {
      const question = draft.questions.find(question => question.id === decision.questionId)!;
      if (createHash("sha256").update(JSON.stringify(question), "utf8").digest("hex") !== decision.questionDigest) {
        throw new TypeError("A resolved question cannot silently change its meaning.");
      }
    }
    if (!Array.isArray(row.sourceDigests) || Object.getPrototypeOf(row.sourceDigests) !== Array.prototype
      || row.sourceDigests.length !== draft.sourceIds.length || Reflect.ownKeys(row.sourceDigests).length !== row.sourceDigests.length + 1) {
      throw new TypeError("Invalid design draft source digests.");
    }
    const sourceDigests = Array.from({ length: row.sourceDigests.length }, (_, index) => {
      const field = Object.getOwnPropertyDescriptor(row.sourceDigests, String(index));
      if (!field?.enumerable || !("value" in field)) throw new TypeError("Invalid design draft source digest.");
      const digest = exactToolRecord(field.value, ["id", "sha256"]);
      if (digest.id !== draft.sourceIds[index] || typeof digest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(digest.sha256)) {
        throw new TypeError("Invalid design draft source digest.");
      }
      return Object.freeze({ id: digest.id as string, sha256: digest.sha256 });
    });
    if (typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
      || new Date(row.createdAt).toISOString() !== row.createdAt) throw new TypeError("Invalid draft creation time.");
    return Object.freeze({ status: "draft", selectionRevision,
      author: Object.freeze({ agentId, sessionId: author.sessionId as string, runId: author.runId as string }),
      sourceDigests: Object.freeze(sourceDigests), createdAt: row.createdAt, draft,
      ...(Object.hasOwn(row, "decisions") ? { decisions } : {}) });
  };
  return createRevisionJournal(workspaceId, projectId, state, {
    prefix: `design-draft-lead-${selectionRevision}`, parse, revisionId: value => value.draft.revisionId,
  });
}
