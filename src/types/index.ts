export interface WorkspaceOption {
  name: string;
  slug: string;
}

export interface WatchFolderSelection {
  watchFolders: string[];
  excludedFolders: string[];
}

export interface AnythingLLMSyncSettings extends WatchFolderSelection {
  baseUrl: string;
  apiKeySecretId: string;
  workspaceSlug: string;
  workspaceName: string;
  autoSync: boolean;
  syncDelayMs: number;
  showNotices: boolean;
}

export interface SyncRecord {
  localPath: string;
  contentHash: string;
  remoteLocation: string;
  remoteName?: string;
  workspaceSlug: string;
  lastSyncedAt: number;
  pendingRename?: boolean;
  remoteMissing?: boolean;
  lastCheckedAt?: number;
}

export type FileSyncState = "unsynced" | "synced" | "modified" | "syncing" | "missing" | "checking" | "error";

export interface FileSyncStatus {
  state: FileSyncState;
  message: string;
}

export interface RemoteCheckSummary {
  present: number;
  missing: number;
  failed: number;
  skipped: number;
}

export interface PersistedPluginData {
  schemaVersion: 1;
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

export type SyncOrigin = "auto" | "manual" | "bulk" | "watched-bulk" | "rename";

export type SyncResult =
  | { status: "synced"; operation: "created" | "updated" | "migrated"; record: SyncRecord }
  | { status: "skipped"; reason: "unchanged" | "empty" }
  | { status: "ignored"; reason: "unsupported-file" | "outside-watch-folder" };

export type DeleteResult =
  | { status: "deleted"; record: SyncRecord }
  | { status: "skipped"; reason: "not-synced" };
