export interface WorkspaceOption {
  name: string;
  slug: string;
}

export interface AnythingLLMSyncSettings {
  baseUrl: string;
  apiKey: string;
  workspaceSlug: string;
  workspaceName: string;
  watchFolder: string;
  autoSync: boolean;
  syncDelayMs: number;
}

export interface SyncRecord {
  localPath: string;
  contentHash: string;
  remoteLocation: string;
  remoteName?: string;
  workspaceSlug: string;
  lastSyncedAt: number;
}

export interface PersistedPluginData {
  settings: AnythingLLMSyncSettings;
  syncRecords: Record<string, SyncRecord>;
}

export interface AnythingLLMDocument {
  location: string;
  name?: string;
  title?: string;
  url?: string;
  docAuthor?: string;
  description?: string;
  docSource?: string;
  chunkSource?: string;
  published?: string;
  wordCount?: number;
  token_count_estimate?: number;
}

export interface UploadDocumentResult {
  success: boolean;
  error?: string | null;
  documents: AnythingLLMDocument[];
}

export type SyncOrigin = "auto" | "manual";

export type SyncResult =
  | { status: "synced"; record: SyncRecord }
  | { status: "skipped"; reason: "unchanged" | "empty" }
  | { status: "ignored"; reason: "unsupported-file" | "outside-watch-folder" };
