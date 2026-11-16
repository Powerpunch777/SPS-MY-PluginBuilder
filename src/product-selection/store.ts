import type { SpsActionContext } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord } from "../lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";
import { parseProductSelectionDraft, type ProductSelectionDraftInput } from "./index.ts";

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fields = ["productId", "productTier", "route", "deliveryTargets", "deliveredProductUsesAI", "addOnIds"] as const;

function requestId(value: unknown) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw new TypeError("A valid selection request ID is required.");
  return value;
}

export function createProductSelectionStore(workspaceId: string, projectId: string, state: RevisionState) {
  const expected = { workspaceId, projectId };
  const parseRevision = (value: unknown) => {
    const record = exactToolRecord(value, ["revisionId", "baseRevisionId", "selection"]);
    const revisionId = requestId(record.revisionId);
    const baseRevisionId = record.baseRevisionId === null ? null : requestId(record.baseRevisionId);
    if (revisionId === baseRevisionId) throw new TypeError("Selection revision must differ from its base.");
    const { draft, status } = parseProductSelectionDraft(record.selection, expected);
    if (!draft || status === "invalid") throw new TypeError("Invalid product selection draft.");
    const selection: ProductSelectionDraftInput = {
      ...expected,
      sourceContext: { sourceIds: draft.sourceContext.sourceIds, revisionRefs: draft.sourceContext.revisionRefs },
      ...(draft.productId === null ? {} : { productId: draft.productId }),
      ...(draft.productTier === null ? {} : { productTier: draft.productTier }),
      ...(draft.route === null ? {} : { route: draft.route }),
      ...(draft.deliveryTargets === null ? {} : { deliveryTargets: draft.deliveryTargets }),
      ...(draft.deliveredProductUsesAI === null ? {} : { deliveredProductUsesAI: draft.deliveredProductUsesAI }),
      ...(draft.addOnIds === null ? {} : { addOnIds: draft.addOnIds }),
    };
    return { revisionId, baseRevisionId, selection };
  };
  const journal = createRevisionJournal(workspaceId, projectId, state, {
    prefix: "product-selection",
    parse: parseRevision,
    revisionId: revision => revision.revisionId,
  });
  const view = ({ sequence, revision }: NonNullable<Awaited<ReturnType<typeof journal.current>>>) => {
    const result = parseProductSelectionDraft(revision.selection, expected);
    return { sequence, revisionId: revision.revisionId, status: result.status, draft: result.draft };
  };

  return {
    async current() {
      const current = await journal.current();
      return current === null ? null : view(current);
    },
    async save(value: unknown) {
      const input = exactToolRecord(value, ["requestId", "expectedRevisionId", "selection"]);
      const selection = exactToolRecord(input.selection, ["sourceContext"], fields);
      const revision = parseRevision({ revisionId: input.requestId, baseRevisionId: input.expectedRevisionId,
        selection: { ...selection, ...expected } });
      const checkReplay = async () => {
        const known = await journal.publishedRevision(revision.revisionId);
        if (!known) return null;
        if (JSON.stringify(known.revision) !== JSON.stringify(revision)) {
          throw new Error("Selection request ID already refers to a different draft.");
        }
        return { status: "saved" as const, record: view(known), replayed: true };
      };
      const replay = await checkReplay();
      if (replay) return replay;
      const result = await journal.publish({ expectedBaseRevisionId: revision.baseRevisionId, revision });
      if (result.status === "conflict") {
        return await checkReplay() ?? { status: "conflict" as const, actualRevisionId: result.actualBaseRevisionId };
      }
      return { status: "saved" as const, record: view(result), replayed: false };
    },
  };
}

/** Host-authenticated user action, scoped to the current single project per Workspace. */
export async function saveProductSelectionAction(params: unknown, context: Pick<SpsActionContext, "companyId" | "actor"> & { state: RevisionState }) {
  if (context.actor.type !== "user" || context.actor.companyId !== context.companyId) {
    throw new Error("Product selection requires an authenticated Workspace user.");
  }
  const input = exactToolRecord(params, ["requestId", "expectedRevisionId", "selection"], ["companyId"]);
  const { companyId, ...draft } = input;
  if (companyId !== undefined && companyId !== context.companyId) {
    throw new Error("Product selection metadata must match the Workspace.");
  }
  return createProductSelectionStore(context.companyId, context.companyId, context.state).save(draft);
}
