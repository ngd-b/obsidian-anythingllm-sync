import type { Plugin } from "obsidian";
import { DEFAULT_DATA, DEFAULT_SECRET_ID, DEFAULT_SETTINGS } from "../settings/defaults";
import type { AnythingLLMSyncSettings, PersistedPluginData, SyncRecord } from "../types";
import { normalizeWatchFolders } from "../utils/path";

type LegacySettings = Partial<AnythingLLMSyncSettings> & { apiKey?: string; watchFolder?: string };

interface LegacyData {
  settings?: LegacySettings;
  syncRecords?: Record<string, SyncRecord>;
  apiKey?: string;
  [key: string]: unknown;
}

export class PluginStore {
  private data: PersistedPluginData = structuredClone(DEFAULT_DATA);
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<void> {
    const raw = (await this.plugin.loadData()) as LegacyData | null;
    if (!raw) {
      this.data = structuredClone(DEFAULT_DATA);
      return;
    }

    const nestedSettings = raw.settings;
    const legacyFlat = !nestedSettings ? (raw as LegacySettings) : undefined;
    const sourceSettings = nestedSettings ?? legacyFlat ?? {};
    const legacyApiKey = nestedSettings?.apiKey ?? legacyFlat?.apiKey ?? raw.apiKey;
    const { apiKey: _legacyApiKey, watchFolder: legacyWatchFolder, ...safeSourceSettings } = sourceSettings;

    const settings: AnythingLLMSyncSettings = {
      ...DEFAULT_SETTINGS,
      ...safeSourceSettings,
      watchFolders: normalizeWatchFolders(
        Array.isArray(safeSourceSettings.watchFolders)
          ? safeSourceSettings.watchFolders
          : typeof legacyWatchFolder === "string" ? [legacyWatchFolder] : []
      ),
      apiKeySecretId: safeSourceSettings.apiKeySecretId || DEFAULT_SECRET_ID
    };

    if (legacyApiKey?.trim()) {
      this.plugin.app.secretStorage.setSecret(settings.apiKeySecretId, legacyApiKey.trim());
    }

    const syncRecords = isRecord(raw.syncRecords)
      ? sanitizeSyncRecords(raw.syncRecords)
      : {};

    this.data = { schemaVersion: 1, settings, syncRecords };
    await this.persist();
  }

  get settings(): AnythingLLMSyncSettings {
    return this.data.settings;
  }

  get apiKey(): string {
    return this.plugin.app.secretStorage.getSecret(this.data.settings.apiKeySecretId) ?? "";
  }

  getSyncRecord(localPath: string): SyncRecord | undefined {
    return this.data.syncRecords[localPath];
  }

  getAllSyncRecords(): SyncRecord[] {
    return Object.values(this.data.syncRecords);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async updateSettings(patch: Partial<AnythingLLMSyncSettings>): Promise<void> {
    const previous = this.data.settings;
    const next = {
      ...previous,
      ...patch,
      watchFolders: patch.watchFolders ? normalizeWatchFolders(patch.watchFolders) : previous.watchFolders
    };
    this.data.settings = next;
    try {
      await this.persist();
    } catch (error) {
      if (this.data.settings === next) this.data.settings = previous;
      this.notify();
      throw error;
    }
  }

  async setSyncRecord(record: SyncRecord): Promise<void> {
    this.data.syncRecords[record.localPath] = record;
    await this.persist();
  }

  async deleteSyncRecord(localPath: string): Promise<void> {
    delete this.data.syncRecords[localPath];
    await this.persist();
  }

  async replaceSyncRecord(oldPath: string, record: SyncRecord): Promise<void> {
    if (oldPath !== record.localPath) delete this.data.syncRecords[oldPath];
    this.data.syncRecords[record.localPath] = record;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.data);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.plugin.saveData(snapshot));
    await this.writeQueue;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSyncRecords(records: Record<string, SyncRecord>): Record<string, SyncRecord> {
  const result: Record<string, SyncRecord> = {};
  for (const [key, value] of Object.entries(records)) {
    if (!value || typeof value !== "object") continue;
    if (!value.localPath || !value.remoteLocation || !value.workspaceSlug || !value.contentHash) continue;
    result[key] = value;
  }
  return result;
}
