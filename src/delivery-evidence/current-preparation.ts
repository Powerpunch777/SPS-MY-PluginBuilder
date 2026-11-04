import type { PluginSpsClient } from "@sonparkserver/plugin-sdk/runtime";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { TaskPacketTestPlan } from "../domain/task-packets.ts";
import type { CurrentDeliveryAuthority, DeliveryAttemptRead, ReceiptHostFacade, ReceiptTaskScope } from "./receipt-store.ts";
import { taskPacketRecordDigest } from "../domain/task-packets.ts";
import { readLatestCurrentDeliveryAttempt } from "./receipt-store.ts";
import type { DeliveryEvidenceManifest, DeliveryInstructions, PersistedPlanningLookup, QaObservation,
  RunEvidence, SourceRevision, ApprovedDeliverableContract } from "./index.ts";
import { adaptAgentSessionRun, createDeliveryEvidenceManifest, readPersistedPlanningRecords } from "./index.ts";

type CurrentContractLookup = Readonly<{
  status: "found";
  authority: "approved" | "unknown";
  sourceRevision: SourceRevision;
  contract: ApprovedDeliverableContract;
}> | Readonly<{ status: "missing" | "unknown" }>;

type CurrentDocumentationLookup = Readonly<{
  status: "found";
  authority: "approved" | "unknown";
  sourceRevision: SourceRevision;
  instructions: DeliveryInstructions;
}> | Readonly<{ status: "missing" | "unknown" }>;

export type CurrentDeliveryPreparationProviders = Readonly<{
  authority: CurrentDeliveryAuthority;
  platform: ReceiptHostFacade & Readonly<{ agents: Readonly<{ sessions: Pick<
    SpsPlatformInvocationContext["agents"]["sessions"], "getRequest" | "getRun"> }> }>;
  artifacts: Pick<PluginSpsClient, "artifacts">;
  client?: PluginSpsClient;
  /** Must read the approved project's current contract and bind it to this source revision. */
  readCurrentContract?: (scope: ReceiptTaskScope & Readonly<{ sourceRevision: SourceRevision }>) => Promise<CurrentContractLookup>;
  /** Must read current installation/usage documentation and its known limits for this revision. */
  readCurrentDocumentation?: (scope: ReceiptTaskScope & Readonly<{ sourceRevision: SourceRevision }>) => Promise<CurrentDocumentationLookup>;
  /** Optional QA observation is retained as a claim; it does not establish independent product QA. */
  readQaObservation?: (scope: ReceiptTaskScope & Readonly<{ sourceRevision: SourceRevision }>) => Promise<QaObservation | null>;
}>;

export type CurrentDeliveryPreparation = Readonly<{
  /**
   * "matched" preserves the established API value and means only that the
   * separate reads agreed during this call. It does not mean an atomic current
   * snapshot or authorize a mutation.
   */
  status: "matched" | "missing" | "mismatched" | "unknown";
  /** Sources whose successful re-reads differed from their initial observations. */
  mismatchSources?: readonly ("authority" | "planning" | "attempt" | "contract" | "documentation" | "qa")[];
  sourceRevision: SourceRevision | null;
  sourceRevisionVerification: "unknown";
  attempt: DeliveryAttemptRead;
  execution: RunEvidence | null;
  testPlan: TaskPacketTestPlan | null;
  contract: "approved" | "missing" | "unknown";
  documentation: "available" | "missing" | "unknown";
  manifest: DeliveryEvidenceManifest | null;
}>;

const sameRevision = (left: SourceRevision, right: SourceRevision): boolean =>
  left.kind === right.kind && left.value === right.value;

const unknownAttempt = (): DeliveryAttemptRead => Object.freeze({ status: "unknown", journalLinkage: "unknown",
  evidenceAuthority: "unknown", attempt: null, artifactIds: Object.freeze([]), reason: "provider-error" });

type ReadResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;
const captureRead = async <T>(read: () => Promise<T>): Promise<ReadResult<T>> => {
  try { return Object.freeze({ ok: true, value: await read() }); }
  catch { return Object.freeze({ ok: false }); }
};

/**
 * Prepare G6/G7 evidence from planning and receipt journals. Positive
 * contract/documentation lookups are accepted only when their provider marks
 * them approved and binds them to the same current source revision. This
 * preparation is observational: matching re-reads do not establish an atomic
 * current snapshot, mutation authorization, gate enforcement, or acceptance.
 */
export async function prepareCurrentDeliveryEvidence(input: PersistedPlanningLookup,
  providers: CurrentDeliveryPreparationProviders): Promise<CurrentDeliveryPreparation> {
  const scope: ReceiptTaskScope = { workspaceId: input.workspaceId, projectId: input.projectId, ctoId: input.ctoId,
    workstreamId: input.workstreamId, taskId: input.taskId, taskRevision: input.taskRevision };
  let planning: Awaited<ReturnType<typeof readPersistedPlanningRecords>>;
  try { planning = await readPersistedPlanningRecords(input); }
  catch { return Object.freeze({ status: "unknown", mismatchSources: Object.freeze([]), sourceRevision: null, sourceRevisionVerification: "unknown",
    attempt: unknownAttempt(), execution: null, testPlan: null, contract: "unknown", documentation: "unknown", manifest: null }); }
  if (planning.status !== "matched" || !planning.packet || !planning.delivery) {
    return Object.freeze({ status: planning.status === "matched" ? "unknown" : planning.status, sourceRevision: null,
      mismatchSources: Object.freeze([]), sourceRevisionVerification: "unknown", attempt: unknownAttempt(), execution: null, testPlan: null,
      contract: "unknown", documentation: "unknown", manifest: null });
  }

  let authority: Awaited<ReturnType<CurrentDeliveryAuthority["readCurrent"]>>;
  try { authority = await providers.authority.readCurrent(scope); } catch { authority = null; }
  if (!authority) return Object.freeze({ status: "unknown", mismatchSources: Object.freeze([]), sourceRevision: null, sourceRevisionVerification: "unknown",
    attempt: unknownAttempt(), execution: null, testPlan: planning.packet.packet.testPlan,
    contract: "unknown", documentation: "unknown", manifest: null });

  const sourceRevision = authority.sourceRevision;
  let attempt = await readLatestCurrentDeliveryAttempt(scope, providers.platform, providers.authority, providers.artifacts);
  let execution: RunEvidence | null = null;
  if (attempt.status === "observed" && attempt.attempt) {
    try {
      const run = await providers.platform.agents.sessions.getRun(attempt.attempt.sessionId,
        attempt.attempt.companyId, attempt.attempt.runId);
      if (run.runId === attempt.attempt.runId) execution = adaptAgentSessionRun(run);
    } catch { /* unavailable run history remains unknown */ }
  }

  let contractLookup: CurrentContractLookup = { status: "unknown" };
  if (providers.readCurrentContract) {
    try { contractLookup = await providers.readCurrentContract({ ...scope, sourceRevision }); } catch { /* remains unknown */ }
  }
  const contractMatches = contractLookup.status === "found" && contractLookup.authority === "approved"
    && sameRevision(contractLookup.sourceRevision, sourceRevision);
  const contract = contractLookup.status === "missing" ? "missing" : contractMatches ? "approved" : "unknown";
  let documentationLookup: CurrentDocumentationLookup = { status: "unknown" };
  if (providers.readCurrentDocumentation) {
    try { documentationLookup = await providers.readCurrentDocumentation({ ...scope, sourceRevision }); } catch { /* remains unknown */ }
  }
  const documentationMatches = documentationLookup.status === "found" && documentationLookup.authority === "approved"
    && sameRevision(documentationLookup.sourceRevision, sourceRevision);
  const documentation = documentationLookup.status === "missing" ? "missing" : documentationMatches ? "available" : "unknown";

  let qa: QaObservation | null = null;
  if (providers.readQaObservation) {
    try { qa = await providers.readQaObservation({ ...scope, sourceRevision }); } catch { /* remains not-run/unknown */ }
  }
  let manifest: DeliveryEvidenceManifest | null = null;
  try {
    manifest = await createDeliveryEvidenceManifest({ packet: planning.packet, delivery: planning.delivery,
      sourceRevision,
      contract: contractMatches && contractLookup.status === "found"
        ? Object.freeze({ ...contractLookup.contract, authority: "approved" })
        : contractLookup.status === "found"
          ? Object.freeze({ ...contractLookup.contract, authority: "unknown" }) : null,
      contractAuthority: contractLookup.status === "missing" ? "missing" : "unknown",
      qa,
      instructions: documentationMatches && documentationLookup.status === "found" ? documentationLookup.instructions : null,
      artifactLookup: attempt.status === "observed" && attempt.attempt ? {
        companyId: attempt.attempt.companyId, subjectKey: attempt.attempt.subjectKey, runId: attempt.attempt.runId,
      } : null,
      executionCompanyId: attempt.attempt?.companyId ?? null,
    }, providers.client);
  } catch { manifest = null; }

  const [authorityRead, planningRead, attemptRead, contractRead, documentationRead, qaRead] = await Promise.all([
    captureRead(() => providers.authority.readCurrent(scope)),
    captureRead(() => readPersistedPlanningRecords(input)),
    captureRead(() => readLatestCurrentDeliveryAttempt(scope, providers.platform, providers.authority, providers.artifacts)),
    captureRead(() => providers.readCurrentContract
      ? providers.readCurrentContract({ ...scope, sourceRevision }) : Promise.resolve({ status: "unknown" as const })),
    captureRead(() => providers.readCurrentDocumentation
      ? providers.readCurrentDocumentation({ ...scope, sourceRevision }) : Promise.resolve({ status: "unknown" as const })),
    captureRead(() => providers.readQaObservation
      ? providers.readQaObservation({ ...scope, sourceRevision }) : Promise.resolve(null)),
  ]);
  // A failed or explicitly unavailable re-read is UNKNOWN, not evidence that
  // a binding changed. The independently read values still are not atomic.
  if (!authorityRead.ok || !planningRead.ok || !attemptRead.ok || !contractRead.ok
    || !documentationRead.ok || !qaRead.ok) {
    return Object.freeze({ status: "unknown", mismatchSources: Object.freeze([]), sourceRevision, sourceRevisionVerification: "unknown",
      attempt: unknownAttempt(), execution: null, testPlan: planning.packet.packet.testPlan,
      contract: "unknown", documentation: "unknown", manifest: null });
  }
  const finalAuthority = authorityRead.value;
  const finalPlanning = planningRead.value;
  const finalAttempt = attemptRead.value;
  const finalContract = contractRead.value;
  const finalDocumentation = documentationRead.value;
  const finalQa = qaRead.value;
  if (!finalAuthority || !finalPlanning || finalAttempt.status === "unknown"
    || (contractLookup.status !== "unknown" && finalContract.status === "unknown")
    || (documentationLookup.status !== "unknown" && finalDocumentation.status === "unknown")
    || (qa !== null && finalQa === null)) {
    return Object.freeze({ status: "unknown", mismatchSources: Object.freeze([]), sourceRevision, sourceRevisionVerification: "unknown",
      attempt: unknownAttempt(), execution: null, testPlan: planning.packet.packet.testPlan,
      contract: "unknown", documentation: "unknown", manifest: null });
  }

  const attemptMatches = finalAttempt.status === attempt.status
    && finalAttempt.reason === attempt.reason
    && finalAttempt.journalLinkage === attempt.journalLinkage
    && JSON.stringify(finalAttempt.attempt) === JSON.stringify(attempt.attempt)
    && JSON.stringify(finalAttempt.artifactIds) === JSON.stringify(attempt.artifactIds);
  const authorityMatches = sameRevision(finalAuthority.sourceRevision, sourceRevision)
    && JSON.stringify(finalAuthority) === JSON.stringify(authority);
  const planningMatches = finalPlanning.status === "matched" && finalPlanning.packet && finalPlanning.delivery
    && taskPacketRecordDigest(finalPlanning.packet, input.projectId, input.ctoId, input.workstreamId)
      === taskPacketRecordDigest(planning.packet, input.projectId, input.ctoId, input.workstreamId)
    && JSON.stringify(finalPlanning.delivery) === JSON.stringify(planning.delivery);
  const contractMatchesObservation = JSON.stringify(finalContract) === JSON.stringify(contractLookup);
  const documentationMatchesObservation = JSON.stringify(finalDocumentation) === JSON.stringify(documentationLookup);
  const qaMatchesObservation = JSON.stringify(finalQa) === JSON.stringify(qa);
  const mismatchSources = Object.freeze([
    ...(!authorityMatches ? ["authority" as const] : []),
    ...(!planningMatches ? ["planning" as const] : []),
    ...(!attemptMatches ? ["attempt" as const] : []),
    ...(!contractMatchesObservation ? ["contract" as const] : []),
    ...(!documentationMatchesObservation ? ["documentation" as const] : []),
    ...(!qaMatchesObservation ? ["qa" as const] : []),
  ]);
  const matched = mismatchSources.length === 0;
  if (!matched) {
    attempt = finalAttempt;
    execution = null;
    manifest = null;
  }
  return Object.freeze({ status: matched ? "matched" : "mismatched", mismatchSources, sourceRevision,
    sourceRevisionVerification: "unknown", attempt, execution, testPlan: planning.packet.packet.testPlan,
    contract: matched ? contract : "unknown", documentation: matched ? documentation : "unknown", manifest });
}
