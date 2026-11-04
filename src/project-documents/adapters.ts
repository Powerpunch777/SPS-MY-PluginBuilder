import type { DesignBaseline } from "../domain/design-baseline.ts";
import type { AuthoredTechnologyDecisions } from "../domain/authored-technology-decisions.ts";
import type { WorkstreamRecord } from "../domain/workstreams.ts";
import type { TaskPacketRecord } from "../domain/task-packets.ts";
import type { ProjectConsultationMessage, ProjectConsultationSource } from "../consultation-import/batch.ts";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../technology-decision-tools.ts";
import { createWorkstreamStore } from "../workstream-tools.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import { parseProjectDocument, type DocumentFreshnessState, type DocumentReference, type ProjectDocumentRecord,
  type ProjectDocumentSource } from "./model.ts";

/** Map the existing immutable design-baseline journal entry into a read record. */
export function adaptDesignBaseline(input: Readonly<{
  workspaceId: string;
  projectId: string;
  sequence: number;
  revision: DesignBaseline;
  freshness?: Readonly<{ state: DocumentFreshnessState; reason: string | null }>;
}>): ProjectDocumentRecord {
  const { revision } = input;
  if (revision.projectId !== input.projectId || !Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error("Design baseline journal scope or sequence does not match the requested document.");
  }
  const references: DocumentReference[] = [
    { kind: "revision", id: revision.sourceDraftRevisionId, revisionId: revision.sourceDraftRevisionId, label: "원본 설계 초안" },
    { kind: "revision", id: revision.specification.revisionId, revisionId: revision.specification.revisionId, label: "승인 명세 Revision" },
    { kind: "revision", id: revision.graph.graphRevisionId, revisionId: revision.graph.graphRevisionId, label: "설계 Graph Revision" },
    { kind: "source", id: revision.userDecision.sourceId, revisionId: null, label: "결정 근거 입력" },
  ];
  const body = [
    "# 통합 설계 기준선",
    "",
    `- Baseline Revision: ${revision.revisionId}`,
    `- Specification Revision: ${revision.specification.revisionId}`,
    `- Graph Revision: ${revision.graph.graphRevisionId}`,
    `- 원본 초안 Revision: ${revision.sourceDraftRevisionId}`,
    `- 원본 입력: ${revision.userDecision.sourceId} (SHA-256 ${revision.userDecision.sourceSha256})`,
    `- 기록 시각: ${revision.createdAt}`,
    "",
    "## Lead의 설계 해석",
    "",
    revision.userDecision.interpretation,
    "",
    "## 요구사항 및 인수 기준",
    "",
    ...revision.specification.requirements.flatMap(requirement => [
      `### ${requirement.id}`,
      "",
      requirement.description,
      "",
      ...requirement.acceptanceCriteriaIds.map(id => `- ${id}`),
      "",
    ]),
    "## 구조화된 Baseline 데이터",
    "",
    "세부 명세 및 Graph 데이터는 아래 원본 Revision 참조와 연결됩니다.",
  ].join("\n");
  const freshness = input.freshness ?? { state: "unknown" as const, reason: "최신성 계산 어댑터가 연결되지 않았습니다." };
  return parseProjectDocument({
    workspaceId: input.workspaceId, projectId: input.projectId,
    id: `design-baseline:${revision.revisionId}`, category: "design", type: "design-baseline",
    title: "통합 설계 기준선", body, revisionId: revision.revisionId,
    createdAt: revision.createdAt, modifiedAt: revision.createdAt, authorId: revision.author.agentId,
    // Main publication records a baseline revision, not a user's approval of
    // the specific source and pack versions. Keep approval unknown until a
    // dedicated approval evidence adapter is available.
    approval: { state: "unknown", evidenceId: null, actorId: null, decidedAt: null },
    freshness: freshness.state, freshnessReason: freshness.reason, references,
  }, { workspaceId: input.workspaceId, projectId: input.projectId });
}

/** Read adapter over the existing CAS journal; it creates no document storage. */
export function createDesignBaselineSource(workspaceId: string, projectId: string, state: RevisionState): ProjectDocumentSource {
  const store = createDesignBaselineStore(workspaceId, projectId, state);
  async function documents() {
    const history = await store.recent(50);
    return { records: history.revisions.map(item => adaptDesignBaseline({ workspaceId, projectId, sequence: item.sequence, revision: item.revision })), hasOlder: history.hasMore };
  }
  return Object.freeze({
    id: "design-baseline-journal",
    category: "design" as const,
    read: async (input: Parameters<ProjectDocumentSource["read"]>[0]) => {
      if (input.workspaceId !== workspaceId || input.projectId !== projectId) throw new Error("Design baseline source scope mismatch.");
      const offset = input.cursor === null ? 0 : Number(input.cursor);
      return pageBoundedHistory(await documents(), offset, input.limit, "Invalid baseline document cursor.");
    },
    readOne: async (input: Parameters<ProjectDocumentSource["readOne"]>[0]) => {
      if (input.workspaceId !== workspaceId || input.projectId !== projectId) throw new Error("Design baseline source scope mismatch.");
      const prefix = "design-baseline:";
      if (!input.documentId.startsWith(prefix)) return null;
      const revisionId = input.documentId.slice(prefix.length);
      const found = await store.publishedRevision(revisionId, 1_000);
      return found ? adaptDesignBaseline({ workspaceId, projectId, sequence: found.sequence, revision: found.revision }) : null;
    },
  });
}

export function createTechnologyDecisionSource(workspaceId: string, projectId: string, state: RevisionState): ProjectDocumentSource {
  const store = createTechnologyDecisionStore(workspaceId, projectId, state);
  return Object.freeze({
    id: "technology-decision-journal", category: "technology" as const,
    read: async (input: Parameters<ProjectDocumentSource["read"]>[0]) => {
      assertScope(input.workspaceId, input.projectId, workspaceId, projectId, "Technology decision");
      const history = await store.recent(50);
      const records = history.revisions.map(item => adaptTechnologyDecisions({ workspaceId, projectId, sequence: item.sequence, revision: item.revision }));
      return pageBoundedHistory({ records, hasOlder: history.hasMore }, parseOffset(input.cursor, "Technology decision"), input.limit, "Invalid technology decision cursor.");
    },
    readOne: async (input: Parameters<ProjectDocumentSource["readOne"]>[0]) => {
      assertScope(input.workspaceId, input.projectId, workspaceId, projectId, "Technology decision");
      const prefix = "technology-decisions:";
      if (!input.documentId.startsWith(prefix)) return null;
      const found = await store.publishedRevision(input.documentId.slice(prefix.length), 1_000);
      return found ? adaptTechnologyDecisions({ workspaceId, projectId, sequence: found.sequence, revision: found.revision }) : null;
    },
  });
}

export function createWorkstreamSource(workspaceId: string, projectId: string, state: RevisionState): ProjectDocumentSource {
  const store = createWorkstreamStore(workspaceId, projectId, state);
  async function documents() {
    const history = await store.recent(50);
    const records = history.revisions.flatMap(item => item.revision.workstreams.map(record =>
      adaptWorkstream({ workspaceId, projectId, boardRevisionId: item.revision.revisionId, record })));
    return { records, hasOlder: history.hasMore };
  }
  return Object.freeze({
    id: "workstream-journal", category: "development" as const,
    read: async (input: Parameters<ProjectDocumentSource["read"]>[0]) => {
      assertScope(input.workspaceId, input.projectId, workspaceId, projectId, "Workstream");
      return pageBoundedHistory(await documents(), parseOffset(input.cursor, "Workstream"), input.limit, "Invalid Workstream cursor.");
    },
    readOne: async (input: Parameters<ProjectDocumentSource["readOne"]>[0]) => {
      assertScope(input.workspaceId, input.projectId, workspaceId, projectId, "Workstream");
      const match = /^workstream:(.+):r([1-9][0-9]*)$/u.exec(input.documentId);
      if (!match) return null;
      const history = await store.recent(50);
      const known = history.revisions.flatMap(item => item.revision.workstreams.map(record =>
        adaptWorkstream({ workspaceId, projectId, boardRevisionId: item.revision.revisionId, record })));
      const found = known.find(document => document.id === input.documentId);
      if (found) return found;
      if (history.hasMore) throw new Error("Workstream detail is outside the observed 50-revision history bound.");
      return null;
    },
  });
}

function assertScope(actualWorkspaceId: string, actualProjectId: string, workspaceId: string, projectId: string, source: string) {
  if (actualWorkspaceId !== workspaceId || actualProjectId !== projectId) throw new Error(`${source} source scope mismatch.`);
}

function parseOffset(cursor: string | null, source: string) {
  if (cursor === null) return 0;
  if (!/^\d+$/u.test(cursor)) throw new TypeError(`Invalid ${source} source cursor.`);
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new TypeError(`Invalid ${source} source cursor.`);
  return offset;
}

function pageBoundedHistory<T extends ProjectDocumentRecord>(history: Readonly<{ records: readonly T[]; hasOlder: boolean }>,
  offset: number, limit: number, error: string) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new TypeError(error);
  const items = history.records.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const sizeBoundReached = nextOffset >= history.records.length && history.hasOlder;
  const hasMore = nextOffset < history.records.length || history.hasOlder && !sizeBoundReached;
  return { items, nextCursor: hasMore ? String(nextOffset) : null, hasMore,
    ...(sizeBoundReached ? { unavailableReason: "size-limit" as const } : {}) };
}

export function adaptConsultationSource(source: ProjectConsultationSource): ProjectDocumentRecord {
  return parseProjectDocument({
    workspaceId: source.workspaceId, projectId: source.projectId,
    id: `consultation-source:${source.sourceId}`, category: "consultation", type: "consultation-source",
    title: source.sourceName, body: source.originalText, revisionId: source.sha256,
    createdAt: source.receivedAt, modifiedAt: source.receivedAt, authorId: null,
    approval: { state: "unknown", evidenceId: null, actorId: null, decidedAt: null },
    freshness: "unknown", freshnessReason: "원본 수신 기록의 승인·최신성 관계는 별도 근거가 없습니다.",
    references: [{ kind: "source", id: source.sourceId, revisionId: source.sha256, label: "수신한 상담 원문" }],
  }, { workspaceId: source.workspaceId, projectId: source.projectId });
}

export function adaptConsultationMessage(message: ProjectConsultationMessage): ProjectDocumentRecord {
  return parseProjectDocument({
    workspaceId: message.workspaceId, projectId: message.projectId,
    id: `consultation-message:${message.sourceId}:${message.messageId}`, category: "consultation", type: "consultation-message",
    title: `${message.sender} · ${message.sourceMessageAt ?? message.receivedAt}`,
    body: message.originalText, revisionId: message.sha256, createdAt: message.receivedAt, modifiedAt: message.receivedAt,
    authorId: null, approval: { state: "unknown", evidenceId: null, actorId: null, decidedAt: null },
    freshness: "unknown", freshnessReason: "상담 원문 수신은 분석·설계 승인 또는 최신성 판정이 아닙니다.",
    references: [{ kind: "source", id: message.sourceId, revisionId: message.sha256, label: "상담 원문" },
      { kind: "source", id: message.snapshotSourceId, revisionId: null, label: "분석 snapshot 출처 ID" }],
  }, { workspaceId: message.workspaceId, projectId: message.projectId });
}

export function adaptTechnologyDecisions(input: Readonly<{
  workspaceId: string; projectId: string; sequence: number; revision: AuthoredTechnologyDecisions;
  freshness?: Readonly<{ state: DocumentFreshnessState; reason: string | null }>;
}>): ProjectDocumentRecord {
  const { register } = input.revision;
  if (register.projectId !== input.projectId || !Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error("Technology decision journal scope or sequence does not match the requested document.");
  }
  const references: DocumentReference[] = [
    { kind: "revision", id: register.sourceBaselineRevisionId, revisionId: register.sourceBaselineRevisionId, label: "기준 설계 Revision" },
    { kind: "revision", id: register.sourceSpecRevisionId, revisionId: register.sourceSpecRevisionId, label: "승인 명세 Revision" },
    { kind: "revision", id: register.sourceGraphRevisionId, revisionId: register.sourceGraphRevisionId, label: "설계 Graph Revision" },
  ];
  const body = JSON.stringify({ revisionId: register.revisionId, register, author: input.revision.author,
    createdAt: input.revision.createdAt, baselineDigest: input.revision.baselineDigest }, null, 2);
  const freshness = input.freshness ?? { state: "unknown" as const, reason: "기준 Revision 최신성 제공자가 연결되지 않았습니다." };
  return parseProjectDocument({ workspaceId: input.workspaceId, projectId: input.projectId,
    id: `technology-decisions:${register.revisionId}`, category: "technology", type: "technology-decision-register",
    title: "기술 선정 및 재사용 기록", body, revisionId: register.revisionId,
    createdAt: input.revision.createdAt, modifiedAt: input.revision.createdAt, authorId: input.revision.author.agentId,
    approval: { state: "unknown", evidenceId: null, actorId: null, decidedAt: null },
    freshness: freshness.state, freshnessReason: freshness.reason, references,
  }, { workspaceId: input.workspaceId, projectId: input.projectId });
}

export function adaptWorkstream(input: Readonly<{
  workspaceId: string; projectId: string; boardRevisionId: string; record: WorkstreamRecord;
  freshness?: Readonly<{ state: DocumentFreshnessState; reason: string | null }>;
}>): ProjectDocumentRecord {
  const { record } = input;
  if (record.spec.projectId !== input.projectId) throw new Error("Workstream belongs to a different project.");
  const references: DocumentReference[] = [
    { kind: "revision", id: record.sourceBaselineRevisionId, revisionId: record.sourceBaselineRevisionId, label: "원본 Baseline Revision" },
    { kind: "revision", id: record.spec.sourceSpecRevisionId, revisionId: record.spec.sourceSpecRevisionId, label: "원본 명세 Revision" },
    { kind: "revision", id: record.spec.technologyDecisionsRef, revisionId: record.spec.technologyDecisionsRef, label: "기술 결정 참조" },
    ...record.spec.dependencies.map(id => ({ kind: "workstream" as const, id, revisionId: null, label: `의존 Workstream ${id}` })),
    ...record.spec.scopeNodeIds.map(id => ({ kind: "requirement" as const, id, revisionId: null, label: `범위 노드 ${id}` })),
  ];
  const freshness = input.freshness ?? { state: "unknown" as const, reason: "Workstream 원본 Revision의 최신성 판정이 연결되지 않았습니다." };
  return parseProjectDocument({ workspaceId: input.workspaceId, projectId: input.projectId,
    id: `workstream:${record.spec.id}:r${record.spec.revision}`, category: "development", type: "workstream",
    title: record.spec.title, body: JSON.stringify(record, null, 2), revisionId: String(record.spec.revision),
    createdAt: record.createdAt, modifiedAt: record.createdAt, authorId: record.author.agentId,
    approval: { state: "unknown", evidenceId: null, actorId: null, decidedAt: null },
    freshness: freshness.state, freshnessReason: freshness.reason,
    references: [...references, { kind: "revision", id: input.boardRevisionId, revisionId: input.boardRevisionId, label: "Workstream 보드 Revision" }],
  }, { workspaceId: input.workspaceId, projectId: input.projectId });
}

export function adaptTaskPacket(input: Readonly<{
  workspaceId: string; projectId: string; ctoId: string; workstreamId: string; record: TaskPacketRecord;
  freshness?: Readonly<{ state: DocumentFreshnessState; reason: string | null }>;
}>): ProjectDocumentRecord {
  const { record } = input, packet = record.packet;
  if (packet.projectId !== input.projectId || packet.ctoId !== input.ctoId || packet.workstreamId !== input.workstreamId) {
    throw new Error("Task Packet belongs to a different project, CTO, or Workstream.");
  }
  const freshness = input.freshness ?? { state: "unknown" as const, reason: "Task source Workstream 및 dependency pin 최신성 판정이 연결되지 않았습니다." };
  return parseProjectDocument({ workspaceId: input.workspaceId, projectId: input.projectId,
    id: `task:${packet.taskId}:r${packet.revision}`, category: "development", type: packet.kind === "qa" ? "qa-task-packet" : "development-task-packet",
    title: packet.title, body: JSON.stringify(record, null, 2), revisionId: String(packet.revision),
    createdAt: record.createdAtISO, modifiedAt: record.createdAtISO, authorId: record.author.agentId,
    approval: { state: "unknown", evidenceId: null, actorId: null, decidedAt: null },
    freshness: freshness.state, freshnessReason: freshness.reason,
    references: [
      { kind: "workstream", id: packet.workstreamId, revisionId: String(packet.revision), label: "담당 Workstream" },
      ...packet.requirementIds.map(id => ({ kind: "requirement" as const, id, revisionId: null, label: `요구사항 ${id}` })),
      ...packet.dependencies.map(id => ({ kind: "task" as const, id, revisionId: null, label: `의존 Task ${id}` })),
    ],
  }, { workspaceId: input.workspaceId, projectId: input.projectId });
}

