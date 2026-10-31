export type BuilderView = "lead" | "architecture" | "organization" | "documents" | "decisions" | "system";
export type LeadChannel = "main" | "cto-inbox" | "decisions";
export type BuilderRole = "lead" | "cto" | "development" | "qa";
export type ActorStatus = "idle" | "running" | "waiting" | "failed" | "archived";

export interface BuilderActor {
  id: string;
  role: BuilderRole;
  label: string;
  parentActorId: string | null;
  agentId: string | null;
  sessionId: string | null;
  status: ActorStatus;
}

export interface BuilderMessage {
  id: string;
  channel: LeadChannel;
  actorId: string | null;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  runId: string | null;
}

export interface BuilderDocument {
  id: string;
  title: string;
  revisionId: string;
  text: string;
  createdAt: string;
}

export interface BuilderQuestion {
  id: string;
  title: string;
  text: string;
  status: "open" | "answered";
  options: Array<{ id: string; label: string; tradeoff: string }>;
  recommendation: string | null;
  answer: string | null;
  revisionId: string | null;
}

export interface BuilderGraphEntity {
  id: string;
  kind: "requirement" | "feature" | "component" | "agent" | "external-system" | "data" | "workflow" | "test" | "environment" | "approval";
  label: string;
  ownerActorId: string | null;
  status: "planned" | "running" | "verified" | "blocked";
  evidenceRefs: string[];
}

export interface BuilderGraphRelation {
  id: string;
  sourceId: string;
  targetId: string;
  kind: "implements" | "depends_on" | "data_flow" | "triggers" | "integrates_with" | "tested_by" | "deployed_to" | "requires_approval";
}

export interface BuilderActivity {
  id: string;
  actorId: string | null;
  label: string;
  createdAt: string;
  evidenceRef: string | null;
}

// These are Builder-owned records, not SPS Core role or task contracts.
export interface BuilderSnapshot {
  schemaVersion: 1;
  workspaceId: string;
  revision: number;
  leadSessions: Record<LeadChannel, string | null>;
  actors: BuilderActor[];
  messages: BuilderMessage[];
  documents: BuilderDocument[];
  questions: BuilderQuestion[];
  graph: { revisionId: string | null; entities: BuilderGraphEntity[]; relations: BuilderGraphRelation[] };
  activity: BuilderActivity[];
  integrations: {
    ai: "not_configured" | "ready" | "unavailable";
    github: "not_configured" | "ready" | "unavailable";
    htmlPreview: "unavailable" | "ready";
  };
}

export interface BuilderShellProps {
  snapshot: BuilderSnapshot;
  workspaceLabel: string;
  loading?: boolean;
  error?: string | null;
  onRefresh(): void;
  onSendMessage?(text: string, channel: LeadChannel): Promise<void>;
  onImportConsultation?(text: string): Promise<void>;
  onOpenCoreSettings?(): void;
  onOpenHtmlPreview?(): void;
}
