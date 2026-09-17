import type { AnythingLLMSyncSettings, PersistedPluginData } from "../types";

export const DEFAULT_SETTINGS: AnythingLLMSyncSettings = {
  baseUrl: "http://localhost:3001",
  apiKey: "",
  workspaceSlug: "",
  workspaceName: "",
  watchFolder: "",
  autoSync: true,
  syncDelayMs: 700,
};

export const DEFAULT_DATA: PersistedPluginData = {
  settings: DEFAULT_SETTINGS,
  syncRecords: {},
};
