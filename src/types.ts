export interface Destination { id: string; name: string; path: string; description: string; enabled: boolean }
export interface Settings {
  provider: string; apiKey: string; baseUrl: string; model: string; chunkSize: number;
  initialized: boolean; destinations: Destination[];
  searchApiKey?: string;
  searchProvider?: 'tavily' | 'agnes' | 'langsearch';
  langSearchApiKey?: string;
  agnesSearchKey?: string;
  agnesSearchUseAIKey?: boolean;
  agnesSearchModel?: string;
}
export interface Analysis {
  title: string; summary: string; keyPoints: string[]; tags: string[];
  destinationId: string; reason: string; body: string;
  hasKnowledge?: boolean;
  goal?: string; process?: string[]; reasoning?: string[]; results?: string[]; todos?: string[];
}
export type Status = 'queued' | 'parsing' | 'analyzing' | 'review' | 'archiving' | 'done' | 'failed' | 'retained' | 'superseded';
export interface Task {
  roleContext?: import('./role-workflow').RoleContext;
  id: string; name: string; sourcePath: string; createdAt: string; status: Status;
  progress?: string; error?: string; analysis?: Analysis;
  originalPath?: string; notePath?: string; archivedAt?: string; archiveContent?: string;
  sourceHash?: string;
  conversationKey?: string; revision?: number; transcriptText?: string;
  conversationArchive?: { notePath: string; originalPath?: string; content: string; original?: string; expected?: string; previousNotePath?: string };
  research?: import('./research').ResearchMeta;
  projectProposalIds?: string[];
}
export interface SyncSource {
  id: string; kind: 'codex' | 'workbuddy' | 'trae'; name: string;
  executablePath: string; directory: string; enabled: boolean;
  initialized: boolean; cursors: Record<string, FileCursor>;
  lastScanAt?: string; error?: string; detected?: string;
  startedAt?: number;
  historyPending?: Array<{ from: string; to: string }>;
}
export interface FileCursor { offset: number; identity: string; signature: string; size: number; mtime: number; baseline?: boolean; sessionId?: string; internal?: boolean; metadataVerified?: boolean; appName?: string; turnComplete?: boolean }
export interface ConversationMessage { id: string; role: 'user' | 'assistant'; timestamp: string; text: string }
export interface Conversation {
  roleContext?: import('./role-workflow').RoleContext; roleBound?: boolean;
  key: string; sourceId: string; sessionId: string; title: string; messages?: ConversationMessage[];
  transcriptPath?: string; transcriptHash?: string; revision: number; lastChangedAt: number; pendingSince: number;
  analyzedRevision: number; lastAnalysisAt?: number; notePath?: string; archivedContent?: string;
  excluded?: boolean;
  messageIndex?: Record<string, string>; knowledge?: Analysis; firstMessageAt?: string; lastMessageAt?: string;
  pendingCount?: number; migrationWarning?: string;
  archivedHash?: string;
  appName?: string;
  completedRevision?: number;
}
export interface SyncState { sources: SyncSource[]; conversations: Conversation[]; modeVersion?: number; migrationWarnings?: string[] }
export interface State { version: 1; settings: Settings; tasks: Task[]; sync?: SyncState; projects?: import('./project-types').ProjectState; diary?: import('./diary-sync').DiaryState; company?:import('./company-types').CompanyState }
export type Chat = (system: string, user: string) => Promise<string>;
