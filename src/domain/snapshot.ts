import type {
  BuilderActivity,
  BuilderActor,
  BuilderDocument,
  BuilderGraphEntity,
  BuilderGraphRelation,
  BuilderMessage,
  BuilderQuestion,
  BuilderSnapshot,
  LeadChannel,
} from "./model.ts";

const CHANNELS = ["main", "cto-inbox", "decisions"] as const;
const ROLES = ["lead", "cto", "development", "qa"] as const;
const STATUSES = ["idle", "running", "waiting", "failed", "archived"] as const;
const GRAPH_KINDS = ["requirement", "feature", "component", "agent", "external-system", "data", "workflow", "test", "environment", "approval"] as const;
const RELATION_KINDS = ["implements", "depends_on", "data_flow", "triggers", "integrates_with", "tested_by", "deployed_to", "requires_approval"] as const;

const MAX_ID = 160;
const MAX_LABEL = 500;
const MAX_TEXT = 1_000_000;
const MAX_DOCUMENT_TEXT = 4_000_000;
const MAX_ACTORS = 1_000;
const MAX_MESSAGES = 20_000;
const MAX_DOCUMENTS = 2_000;
const MAX_QUESTIONS = 5_000;
const MAX_OPTIONS = 100;
const MAX_GRAPH_ENTITIES = 20_000;
const MAX_GRAPH_RELATIONS = 40_000;
const MAX_EVIDENCE_REFS = 1_000;
const MAX_ACTIVITY = 20_000;

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain record.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data field.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    throw new TypeError(`${label} must be an array with at most ${maximum} entries.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw new TypeError(`${label} must be a dense plain array.`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must be a dense plain array.`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0)
    || value.includes("\0")) {
    throw new TypeError(`${label} must be ${allowEmpty ? "a" : "a nonempty"} string of at most ${maximum} characters.`);
  }
  return value;
}

function id(value: unknown, label: string): string {
  return text(value, label, MAX_ID);
}

function nullableId(value: unknown, label: string): string | null {
  return value === null ? null : id(value, label);
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new TypeError(`${label} is not supported.`);
  return value as T[number];
}

function unique(values: readonly string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (result.has(value)) throw new TypeError(`${label} contains a duplicate ID.`);
    result.add(value);
  }
  return result;
}

function parseActor(value: unknown, index: number): BuilderActor {
  const label = `actors[${index}]`;
  const row = record(value, ["id", "role", "label", "parentActorId", "agentId", "sessionId", "status"], label);
  return {
    id: id(row.id, `${label}.id`),
    role: oneOf(row.role, ROLES, `${label}.role`),
    label: text(row.label, `${label}.label`, MAX_LABEL),
    parentActorId: nullableId(row.parentActorId, `${label}.parentActorId`),
    agentId: nullableId(row.agentId, `${label}.agentId`),
    sessionId: nullableId(row.sessionId, `${label}.sessionId`),
    status: oneOf(row.status, STATUSES, `${label}.status`),
  };
}

function parseMessage(value: unknown, index: number): BuilderMessage {
  const label = `messages[${index}]`;
  const row = record(value, ["id", "channel", "actorId", "role", "text", "createdAt", "runId"], label);
  return {
    id: id(row.id, `${label}.id`),
    channel: oneOf(row.channel, CHANNELS, `${label}.channel`),
    actorId: nullableId(row.actorId, `${label}.actorId`),
    role: oneOf(row.role, ["user", "assistant", "system"] as const, `${label}.role`),
    text: text(row.text, `${label}.text`, MAX_TEXT, true),
    createdAt: text(row.createdAt, `${label}.createdAt`, 100),
    runId: nullableId(row.runId, `${label}.runId`),
  };
}

function parseDocument(value: unknown, index: number): BuilderDocument {
  const label = `documents[${index}]`;
  const row = record(value, ["id", "title", "revisionId", "text", "createdAt"], label);
  return {
    id: id(row.id, `${label}.id`),
    title: text(row.title, `${label}.title`, MAX_LABEL),
    revisionId: id(row.revisionId, `${label}.revisionId`),
    text: text(row.text, `${label}.text`, MAX_DOCUMENT_TEXT, true),
    createdAt: text(row.createdAt, `${label}.createdAt`, 100),
  };
}

function parseQuestion(value: unknown, index: number): BuilderQuestion {
  const label = `questions[${index}]`;
  const row = record(value, ["id", "title", "text", "status", "options", "recommendation", "answer", "revisionId"], label);
  const options = list(row.options, MAX_OPTIONS, `${label}.options`).map((option, optionIndex) => {
    const optionLabel = `${label}.options[${optionIndex}]`;
    const item = record(option, ["id", "label", "tradeoff"], optionLabel);
    return {
      id: id(item.id, `${optionLabel}.id`),
      label: text(item.label, `${optionLabel}.label`, MAX_LABEL),
      tradeoff: text(item.tradeoff, `${optionLabel}.tradeoff`, MAX_TEXT, true),
    };
  });
  unique(options.map(option => option.id), `${label}.options`);
  return {
    id: id(row.id, `${label}.id`),
    title: text(row.title, `${label}.title`, MAX_LABEL),
    text: text(row.text, `${label}.text`, MAX_TEXT, true),
    status: oneOf(row.status, ["open", "answered"] as const, `${label}.status`),
    options,
    recommendation: row.recommendation === null ? null : text(row.recommendation, `${label}.recommendation`, MAX_TEXT, true),
    answer: row.answer === null ? null : text(row.answer, `${label}.answer`, MAX_TEXT, true),
    revisionId: nullableId(row.revisionId, `${label}.revisionId`),
  };
}

function parseGraphEntity(value: unknown, index: number): BuilderGraphEntity {
  const label = `graph.entities[${index}]`;
  const row = record(value, ["id", "kind", "label", "ownerActorId", "status", "evidenceRefs"], label);
  const evidenceRefs = list(row.evidenceRefs, MAX_EVIDENCE_REFS, `${label}.evidenceRefs`)
    .map((entry, refIndex) => id(entry, `${label}.evidenceRefs[${refIndex}]`));
  unique(evidenceRefs, `${label}.evidenceRefs`);
  const status = oneOf(row.status, ["planned", "running", "verified", "blocked"] as const, `${label}.status`);
  if (status === "verified" && evidenceRefs.length === 0) {
    throw new TypeError(`${label} cannot be verified without an evidence reference.`);
  }
  return {
    id: id(row.id, `${label}.id`),
    kind: oneOf(row.kind, GRAPH_KINDS, `${label}.kind`),
    label: text(row.label, `${label}.label`, MAX_LABEL),
    ownerActorId: nullableId(row.ownerActorId, `${label}.ownerActorId`),
    status,
    evidenceRefs,
  };
}

function parseGraphRelation(value: unknown, index: number): BuilderGraphRelation {
  const label = `graph.relations[${index}]`;
  const row = record(value, ["id", "sourceId", "targetId", "kind"], label);
  return {
    id: id(row.id, `${label}.id`),
    sourceId: id(row.sourceId, `${label}.sourceId`),
    targetId: id(row.targetId, `${label}.targetId`),
    kind: oneOf(row.kind, RELATION_KINDS, `${label}.kind`),
  };
}

function parseActivity(value: unknown, index: number): BuilderActivity {
  const label = `activity[${index}]`;
  const row = record(value, ["id", "actorId", "label", "createdAt", "evidenceRef"], label);
  return {
    id: id(row.id, `${label}.id`),
    actorId: nullableId(row.actorId, `${label}.actorId`),
    label: text(row.label, `${label}.label`, MAX_LABEL),
    createdAt: text(row.createdAt, `${label}.createdAt`, 100),
    evidenceRef: row.evidenceRef === null ? null : id(row.evidenceRef, `${label}.evidenceRef`),
  };
}

export function createEmptyBuilderSnapshot(workspaceId: string): BuilderSnapshot {
  const safeWorkspaceId = id(workspaceId, "workspaceId");
  return {
    schemaVersion: 1,
    workspaceId: safeWorkspaceId,
    revision: 0,
    leadSessions: { main: null, "cto-inbox": null, decisions: null },
    actors: [],
    messages: [],
    documents: [],
    questions: [],
    graph: { revisionId: null, entities: [], relations: [] },
    activity: [],
    integrations: { ai: "not_configured", github: "not_configured", htmlPreview: "unavailable" },
  };
}

export function parseBuilderSnapshot(value: unknown, expectedWorkspaceId: string): BuilderSnapshot {
  const expected = id(expectedWorkspaceId, "expectedWorkspaceId");
  const root = record(value, ["schemaVersion", "workspaceId", "revision", "leadSessions", "actors", "messages", "documents", "questions", "graph", "activity", "integrations"], "snapshot");
  if (root.schemaVersion !== 1) throw new TypeError("snapshot.schemaVersion is unsupported.");
  const workspaceId = id(root.workspaceId, "snapshot.workspaceId");
  if (workspaceId !== expected) throw new TypeError("snapshot belongs to a different Workspace.");
  if (!Number.isSafeInteger(root.revision) || (root.revision as number) < 0) throw new TypeError("snapshot.revision must be a nonnegative safe integer.");

  const sessionInput = record(root.leadSessions, CHANNELS, "snapshot.leadSessions");
  const leadSessions = Object.fromEntries(CHANNELS.map(channel => [channel,
    nullableId(sessionInput[channel], `snapshot.leadSessions.${channel}`)])) as Record<LeadChannel, string | null>;
  const leadSessionIds = CHANNELS.flatMap(channel => leadSessions[channel] === null ? [] : [leadSessions[channel] as string]);
  unique(leadSessionIds, "snapshot.leadSessions");

  const actors = list(root.actors, MAX_ACTORS, "snapshot.actors").map(parseActor);
  const messages = list(root.messages, MAX_MESSAGES, "snapshot.messages").map(parseMessage);
  const documents = list(root.documents, MAX_DOCUMENTS, "snapshot.documents").map(parseDocument);
  const questions = list(root.questions, MAX_QUESTIONS, "snapshot.questions").map(parseQuestion);
  const graphInput = record(root.graph, ["revisionId", "entities", "relations"], "snapshot.graph");
  const graph = {
    revisionId: nullableId(graphInput.revisionId, "snapshot.graph.revisionId"),
    entities: list(graphInput.entities, MAX_GRAPH_ENTITIES, "snapshot.graph.entities").map(parseGraphEntity),
    relations: list(graphInput.relations, MAX_GRAPH_RELATIONS, "snapshot.graph.relations").map(parseGraphRelation),
  };
  const activity = list(root.activity, MAX_ACTIVITY, "snapshot.activity").map(parseActivity);
  const integrationsInput = record(root.integrations, ["ai", "github", "htmlPreview"], "snapshot.integrations");
  const integrations = {
    ai: oneOf(integrationsInput.ai, ["not_configured", "ready", "unavailable"] as const, "snapshot.integrations.ai"),
    github: oneOf(integrationsInput.github, ["not_configured", "ready", "unavailable"] as const, "snapshot.integrations.github"),
    htmlPreview: oneOf(integrationsInput.htmlPreview, ["unavailable", "ready"] as const, "snapshot.integrations.htmlPreview"),
  };

  const actorIds = unique(actors.map(actor => actor.id), "snapshot.actors");
  const messageIds = unique(messages.map(message => message.id), "snapshot.messages");
  const documentIds = unique(documents.map(document => document.id), "snapshot.documents");
  const questionIds = unique(questions.map(question => question.id), "snapshot.questions");
  const entityIds = unique(graph.entities.map(entity => entity.id), "snapshot.graph.entities");
  const relationIds = unique(graph.relations.map(relation => relation.id), "snapshot.graph.relations");
  const activityIds = unique(activity.map(item => item.id), "snapshot.activity");
  void messageIds; void documentIds; void questionIds; void relationIds; void activityIds;

  const actorById = new Map(actors.map(actor => [actor.id, actor]));
  for (const actor of actors) {
    if (actor.parentActorId !== null && (!actorIds.has(actor.parentActorId) || actor.parentActorId === actor.id)) {
      throw new TypeError(`Actor ${actor.id} has a dangling or self parent reference.`);
    }
  }
  const completedActors = new Set<string>();
  const visitingActors = new Set<string>();
  const visitActor = (actorId: string): void => {
    if (completedActors.has(actorId)) return;
    if (visitingActors.has(actorId)) throw new TypeError("snapshot.actors contains a parent cycle.");
    visitingActors.add(actorId);
    const parentId = actorById.get(actorId)?.parentActorId;
    if (parentId !== null && parentId !== undefined) visitActor(parentId);
    visitingActors.delete(actorId);
    completedActors.add(actorId);
  };
  for (const actor of actors) visitActor(actor.id);

  for (const message of messages) {
    if (message.actorId !== null && !actorIds.has(message.actorId)) throw new TypeError(`Message ${message.id} has a dangling actor reference.`);
  }
  for (const item of activity) {
    if (item.actorId !== null && !actorIds.has(item.actorId)) throw new TypeError(`Activity ${item.id} has a dangling actor reference.`);
  }
  const revisionIds = unique(documents.map(document => document.revisionId), "snapshot.documents.revisionId");
  if (graph.revisionId !== null && !revisionIds.has(graph.revisionId)) throw new TypeError("snapshot.graph has a dangling revision reference.");
  for (const question of questions) {
    if (question.revisionId !== null && !revisionIds.has(question.revisionId)) throw new TypeError(`Question ${question.id} has a dangling revision reference.`);
  }
  for (const entity of graph.entities) {
    if (entity.ownerActorId !== null && !actorIds.has(entity.ownerActorId)) throw new TypeError(`Graph entity ${entity.id} has a dangling actor reference.`);
  }
  for (const relation of graph.relations) {
    if (!entityIds.has(relation.sourceId) || !entityIds.has(relation.targetId)) {
      throw new TypeError(`Graph relation ${relation.id} has a dangling entity reference.`);
    }
  }

  const actorSessionIds = actors.flatMap(actor => actor.sessionId === null ? [] : [actor.sessionId]);
  unique([...leadSessionIds, ...actorSessionIds], "snapshot session IDs");

  return {
    schemaVersion: 1,
    workspaceId,
    revision: root.revision as number,
    leadSessions,
    actors,
    messages,
    documents,
    questions,
    graph,
    activity,
    integrations,
  };
}
