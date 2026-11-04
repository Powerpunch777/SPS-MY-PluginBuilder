import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import { parseProjectDeliverableSource, type ProjectDeliverableSource } from "./domain/project-deliverable-source.ts";

export type ProjectDeliverableRead = Readonly<{
  status: "found";
  authority: "unknown";
  sourceRevisionVerification: "unknown";
  value: ProjectDeliverableSource;
}> | Readonly<{ status: "missing" | "unknown" | "mismatched"; reason?: string }>;

/**
 * Project-scoped G7 source drafts on Builder's existing immutable CAS revision
 * journal. Callers must enforce the real authoring authority before writes.
 * A stored draft is never treated here as an approved contract or documentation.
 */
export function createProjectDeliverablesStore(workspaceId: string, projectId: string, state: RevisionState) {
  const store = createRevisionJournal(workspaceId, `project-deliverables:${projectId}`, state, {
    prefix: "project-deliverables",
    parse: value => parseProjectDeliverableSource(value, workspaceId, projectId),
    revisionId: value => value.revisionId,
  });

  return Object.freeze({
    async current() {
      return store.current();
    },
    async appendDraft(expectedBaseRevisionId: string | null, value: ProjectDeliverableSource) {
      const parsed = parseProjectDeliverableSource(value, workspaceId, projectId);
      return store.publish({ expectedBaseRevisionId, revision: parsed });
    },
    async readCurrentForSource(sourceRevision: ProjectDeliverableSource["sourceRevision"]): Promise<ProjectDeliverableRead> {
      if (!sourceRevision || typeof sourceRevision !== "object"
        || !["git-commit", "source-manifest", "other"].includes(sourceRevision.kind)
        || typeof sourceRevision.value !== "string" || !sourceRevision.value.trim()) {
        return Object.freeze({ status: "unknown", reason: "requested-source-revision-unavailable" });
      }
      let current: Awaited<ReturnType<typeof store.current>>;
      try {
        current = await store.current();
      } catch {
        // An unavailable or corrupt journal cannot establish either absence or
        // a source match. Keep the read observational and do not leak provider
        // errors into the project-facing status.
        return Object.freeze({ status: "unknown", reason: "project-record-read-failed" });
      }
      if (!current) return Object.freeze({ status: "missing" });
      const value = current.revision;
      if (value.sourceRevision.kind !== sourceRevision.kind || value.sourceRevision.value !== sourceRevision.value) {
        return Object.freeze({ status: "mismatched", reason: "project-record-source-revision-differs" });
      }
      return Object.freeze({ status: "found", authority: "unknown", sourceRevisionVerification: "unknown", value });
    },
  });
}
