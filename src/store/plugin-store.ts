import type { Plugin } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import type {
  AnythingLLMSyncSettings,
  PersistedPluginData,
  SyncRecord,
} from "../types";

export class PluginStore {
  private data: PersistedPluginData = {
    settings: { ...DEFAULT_SETTINGS },
    syncRecords: {},
  };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<void> {
    const raw = (await this.plugin.loadData()) as Record<string, unknown> | null;
    const nestedSettings = raw?.settings as Partial<AnythingLLMSyncSettings> | undefined;

    // Migration from v0.1: settings previously lived directly at data.json root.
    const legacySettings = raw && !nestedSettings
      ? (raw as unknown as Partial<AnythingLLMSyncSettings>)
      : undefined;

    const rawRecords = raw?.syncRecords;
    const syncRecords = isRecord(rawRecords)
      ? (rawRecords as Record<string, SyncRecord>)
      : {};

    this.data = {
      settings: {
        ...DEFAULT_SETTINGS,
        ...(legacySettings ?? nestedSettings ?? {}),
      },
      syncRecords,
    };
  }

  get settings(): AnythingLLMSyncSettings {
    return this.data.settings;
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

  async moveSyncRecord(oldPath: string, newPath: string): Promise<void> {
    const record = this.data.syncRecords[oldPath];
    if (!record) return;

    delete this.data.syncRecords[oldPath];
    this.data.syncRecords[newPath] = { ...record, localPath: newPath };
    await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.data)) as PersistedPluginData;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.plugin.saveData(snapshot));
    await this.writeQueue;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
