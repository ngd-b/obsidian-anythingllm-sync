import type { AnythingLLMSyncSettings, PersistedPluginData } from "../types";

export const DEFAULT_SECRET_ID = "anythingllm-sync-api-key";

export const DEFAULT_SETTINGS: AnythingLLMSyncSettings = {
  baseUrl: "http://localhost:3001",
  apiKeySecretId: DEFAULT_SECRET_ID,
  workspaceSlug: "",
  workspaceName: "",
  watchFolder: "",
  autoSync: true,
  syncDelayMs: 1000,
  showNotices: true
};

export const DEFAULT_DATA: PersistedPluginData = {
  schemaVersion: 1,
  settings: { ...DEFAULT_SETTINGS },
  syncRecords: {}
};
