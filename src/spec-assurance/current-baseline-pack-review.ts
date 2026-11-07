import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import { createSpecAssurancePackStore } from "./pack-store.ts";

const ID = (value: unknown): value is string => typeof value === "string" && !!value.trim()
  && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export type CurrentBaselinePackReviewRead = Readonly<{
  status: "empty" | "ready" | "stale";
  data?: Readonly<{
    workspaceId: string;
    projectId: string;
    packId: string;
    current: Readonly<{ sequence: number; revision: unknown }>;
    currentBaselineRevisionId: string;
    currentBaselineSequence: number;
    matchesCurrentBaseline: boolean;
    currentApproval: Readonly<{ sequence: number; revision: unknown }> | null;
  }>;
}>;

/** Display projection only. The existing user action remains the sole approval writer. */
export async function readCurrentBaselinePackReview(input: Readonly<{
  workspaceId: string;
  projectId: string;
  packId: string;
  platform: SpsPlatformInvocationContext;
}>): Promise<CurrentBaselinePackReviewRead> {
  if (!ID(input.workspaceId) || !ID(input.projectId) || input.projectId !== input.workspaceId || !ID(input.packId)) {
    throw new TypeError("The exact authenticated Workspace project and pack IDs are required.");
  }
  const state = input.platform.state as typeof input.platform.state & RevisionState;
  const [baseline, proposal, approval] = await Promise.all([
    createDesignBaselineStore(input.workspaceId, input.projectId, state).current(),
    createSpecAssurancePackStore(input.workspaceId, input.projectId, state).current(input.packId),
    createSpecAssurancePackStore(input.workspaceId, input.projectId, state).currentApproval(input.packId),
  ]);
  if (!baseline || !proposal) return Object.freeze({ status: "empty" });
  const revision = proposal.revision;
  const matchesCurrentBaseline = revision.workspaceId === input.workspaceId && revision.projectId === input.projectId
    && revision.pack?.packId === input.packId && revision.baselineRevisionId === baseline.revision.revisionId
    && revision.baselineSequence === baseline.sequence
    && revision.identity.specRevisionId === baseline.revision.specification.revisionId
    && revision.identity.specDigest === hash(baseline.revision.specification);
  return Object.freeze({ status: matchesCurrentBaseline ? "ready" : "stale",
    data: Object.freeze({ workspaceId: input.workspaceId, projectId: input.projectId, packId: input.packId,
      current: Object.freeze({ sequence: proposal.sequence, revision }), currentBaselineRevisionId: baseline.revision.revisionId,
      currentBaselineSequence: baseline.sequence, matchesCurrentBaseline,
      currentApproval: approval ? Object.freeze({ sequence: approval.sequence, revision: approval.revision }) : null }) });
}
