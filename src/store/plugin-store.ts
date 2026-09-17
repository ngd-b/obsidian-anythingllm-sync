import type { Plugin } from "obsidian";
import { DEFAULT_DATA, DEFAULT_SECRET_ID, DEFAULT_SETTINGS } from "../settings/defaults";
import type { AnythingLLMSyncSettings, PersistedPluginData, SyncRecord } from "../types";

interface LegacyData {
  settings?: Partial<AnythingLLMSyncSettings> & { apiKey?: string };
  syncRecords?: Record<string, SyncRecord>;
  apiKey?: string;
  [key: string]: unknown;
}

export class PluginStore {
  private data: PersistedPluginData = structuredClone(DEFAULT_DATA);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<void> {
    const raw = (await this.plugin.loadData()) as LegacyData | null;
    if (!raw) {
      this.data = structuredClone(DEFAULT_DATA);
      return;
    }

    const nestedSettings = raw.settings;
    const legacyFlat = !nestedSettings ? (raw as Partial<AnythingLLMSyncSettings> & { apiKey?: string }) : undefined;
    const sourceSettings = nestedSettings ?? legacyFlat ?? {};
    const legacyApiKey = nestedSettings?.apiKey ?? legacyFlat?.apiKey ?? raw.apiKey;
    const { apiKey: _legacyApiKey, ...safeSourceSettings } = sourceSettings;

    const settings: AnythingLLMSyncSettings = {
      ...DEFAULT_SETTINGS,
      ...safeSourceSettings,
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

  async updateSettings(patch: Partial<AnythingLLMSyncSettings>): Promise<void> {
    this.data.settings = { ...this.data.settings, ...patch };
    await this.persist();
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
