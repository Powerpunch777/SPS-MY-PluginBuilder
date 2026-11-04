import { createHash } from "node:crypto";
import type { SolutionRevision } from "../domain/graph-revisions.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import { createSolutionRevisionStore } from "../solution-revision-store.ts";
import type { DocumentSourcePin } from "./index.ts";

export type PublishedRevisionPinLookup =
  | Readonly<{ status: "found"; pin: DocumentSourcePin; sequence: number }>
  | Readonly<{ status: "missing" | "unavailable" }>;

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Reads only revisions reachable through the existing immutable solution journal.
 * Returned pins prove stored revision content only; they do not establish caller
 * authorization, publication approval, source collection coverage, or document trace.
 */
export function createSolutionRevisionPinReader(input: Readonly<{
  workspaceId: string;
  projectId: string;
  sourceId: string;
  state: RevisionState;
}>) {
  const sourceId = id(input.sourceId, "sourceId");
  const journal = createSolutionRevisionStore(input.workspaceId, input.projectId, input.state);

  function found(value: Readonly<{ sequence: number; revision: SolutionRevision }>): PublishedRevisionPinLookup {
    return Object.freeze({ status: "found", sequence: value.sequence,
      pin: Object.freeze({ sourceId, revisionId: value.revision.graphRevisionId,
        sourceSha256: sha256(JSON.stringify(value.revision)) }) });
  }

  return Object.freeze({
    async current(): Promise<PublishedRevisionPinLookup> {
      try {
        const current = await journal.current();
        return current ? found(current) : Object.freeze({ status: "missing" });
      } catch { return Object.freeze({ status: "unavailable" }); }
    },

    async published(revisionIdValue: string): Promise<PublishedRevisionPinLookup> {
      const revisionId = id(revisionIdValue, "revisionId");
      try {
        const revision = await journal.publishedRevision(revisionId);
        return revision ? found(revision) : Object.freeze({ status: "missing" });
      } catch { return Object.freeze({ status: "unavailable" }); }
    },
  });
}
