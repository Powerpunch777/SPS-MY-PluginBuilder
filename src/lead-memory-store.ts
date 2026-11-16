import { parseLeadMemoryRevision, type LeadMemoryRevision } from "./domain/lead-memory.ts";
import { LEAD_CHANNELS } from "./domain/lead-sessions.ts";
import type { LeadChannel } from "./domain/model.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";

export type AuthoredLeadMemory = Readonly<{
  author: Readonly<{ agentId: string; sessionId: string; runId: string; selectionRevision: number; channel: LeadChannel }>;
  createdAt: string;
  sourceDigests: readonly Readonly<{ id: string; sha256: string }>[];
  memory: LeadMemoryRevision;
}>;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Project knowledge survives Lead selection changes; it never grants authority.
 * Only the service's current authenticated Lead boundary may publish here. */
export function createLeadMemoryStore(workspaceId: string, projectId: string, state: RevisionState) {
  const parse = (value: unknown): AuthoredLeadMemory => {
    const row = exactToolRecord(value, ["author", "createdAt", "sourceDigests", "memory"]);
    const author = exactToolRecord(row.author, ["agentId", "sessionId", "runId", "selectionRevision", "channel"]);
    if ([author.agentId, author.sessionId, author.runId].some(value => typeof value !== "string" || !UUID.test(value))
      || !Number.isSafeInteger(author.selectionRevision) || (author.selectionRevision as number) < 1
      || !LEAD_CHANNELS.includes(author.channel as LeadChannel)) throw new TypeError("Invalid Lead memory author.");
    if (typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
      || new Date(row.createdAt).toISOString() !== row.createdAt) throw new TypeError("Invalid memory creation time.");
    const memory = parseLeadMemoryRevision(row.memory, projectId);
    const ids = [...new Set(memory.entries.flatMap(entry => entry.sourceIds))];
    if (!Array.isArray(row.sourceDigests) || Object.getPrototypeOf(row.sourceDigests) !== Array.prototype
      || row.sourceDigests.length !== ids.length || Reflect.ownKeys(row.sourceDigests).length !== ids.length + 1) {
      throw new TypeError("Invalid memory source digests.");
    }
    const sourceDigests = ids.map((id, index) => {
      const field = Object.getOwnPropertyDescriptor(row.sourceDigests, String(index));
      if (!field?.enumerable || !("value" in field)) throw new TypeError("Invalid memory source digest.");
      const digest = exactToolRecord(field.value, ["id", "sha256"]);
      if (digest.id !== id || typeof digest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(digest.sha256)) {
        throw new TypeError("Invalid memory source digest.");
      }
      return Object.freeze({ id, sha256: digest.sha256 });
    });
    return Object.freeze({ author: Object.freeze({ agentId: author.agentId as string, sessionId: author.sessionId as string,
      runId: author.runId as string, selectionRevision: author.selectionRevision as number, channel: author.channel as LeadChannel }),
    createdAt: row.createdAt, sourceDigests: Object.freeze(sourceDigests), memory });
  };
  return createRevisionJournal(workspaceId, projectId, state, {
    prefix: "lead-memory", parse, revisionId: value => value.memory.revisionId,
  });
}
