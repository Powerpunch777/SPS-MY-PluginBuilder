import type { BuilderSnapshot } from "./model.ts";
import { parseDesignDraft, type DesignDraft } from "./design-drafts.ts";

export type DesignDraftView = Readonly<{ workspaceId: string; projectId: string; selectionRevision: number;
  agentId: string; sequence: number; createdAt: string; draft: DesignDraft }>;

export function parseDesignDraftView(value: unknown, workspaceId: string, selectionRevision: number, agentId: string): DesignDraftView {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid design draft view.");
  const keys = ["workspaceId", "projectId", "selectionRevision", "agentId", "sequence", "createdAt", "draft"];
  if (Reflect.ownKeys(value).length !== keys.length) throw new TypeError("Invalid design draft view fields.");
  const row: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !("value" in field)) throw new TypeError("Invalid design draft view field.");
    row[key] = field.value;
  }
  if (row.workspaceId !== workspaceId || row.projectId !== workspaceId || row.selectionRevision !== selectionRevision
    || row.agentId !== agentId || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1
    || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
    || new Date(row.createdAt).toISOString() !== row.createdAt) throw new TypeError("Stale or cross-scope design draft view.");
  return Object.freeze({ workspaceId, projectId: workspaceId, selectionRevision, agentId,
    sequence: row.sequence as number, createdAt: row.createdAt, draft: parseDesignDraft(row.draft, workspaceId) });
}

/** Read-only presentation. Draft nodes are planned, never verified work. */
export function projectDesignDraft(snapshot: BuilderSnapshot, view: DesignDraftView): BuilderSnapshot {
  if (snapshot.workspaceId !== view.workspaceId) throw new TypeError("Draft projection belongs to a different Workspace.");
  const draft = view.draft;
  const labels = new Map(draft.specification.requirements.map(requirement => [requirement.id, requirement.description]));
  return { ...snapshot,
    documents: [...snapshot.documents, { id: `draft:${draft.revisionId}`, title: "설계 초안 · 승인 전",
      revisionId: draft.revisionId, createdAt: view.createdAt, text: JSON.stringify(draft.specification, null, 2) }],
    questions: [...snapshot.questions, ...draft.questions.map(question => ({ id: `draft:${draft.revisionId}:${question.id}`,
      title: question.title, text: question.text, status: "open" as const,
      options: question.options.map(option => ({ ...option })),
      recommendation: question.options.find(option => option.id === question.recommendation)?.label ?? null,
      answer: null, revisionId: draft.revisionId }))],
    graph: { revisionId: draft.graph.graphRevisionId,
      entities: draft.graph.entities.map(entity => ({ id: entity.id, kind: entity.kind,
        label: entity.specRef ? labels.get(entity.specRef) ?? entity.id : entity.id,
        ownerActorId: null, status: "planned" as const, evidenceRefs: [] })),
      relations: draft.graph.relations.map(relation => ({ id: relation.id, sourceId: relation.sourceId,
        targetId: relation.targetId, kind: relation.kind })) },
  };
}
