import type { Plugin, TAbstractFile } from "obsidian";
import { TFile } from "obsidian";
import { SyncService } from "../services/sync-service";
import { PluginStore } from "../store/plugin-store";
import { isPathInsideFolder } from "../utils/path";

export class VaultListener {
  private readonly timers = new Map<string, number>();

  constructor(
    private readonly plugin: Plugin,
    private readonly syncService: SyncService,
    private readonly store: PluginStore,
    private readonly onAutoSyncSuccess: (file: TFile) => void,
    private readonly onAutoSyncError: (file: TFile, error: unknown) => void,
  ) {}

  register(): void {
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => {
        this.handleCreate(file);
      }),
    );

    // v0.1 intentionally syncs new files only.
    // Future modify/delete/rename support belongs here, while SyncService stays
    // responsible for synchronization decisions and AnythingLLMClient stays API-only.
  }

  dispose(): void {
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  private handleCreate(file: TAbstractFile): void {
    const settings = this.store.settings;
    if (!settings.autoSync) return;
    if (!(file instanceof TFile)) return;
    if (file.extension.toLowerCase() !== "md") return;
    if (!isPathInsideFolder(file.path, settings.watchFolder)) return;

    this.schedule(file);
  }

  private schedule(file: TFile): void {
    const previous = this.timers.get(file.path);
    if (previous !== undefined) window.clearTimeout(previous);

    const delay = Math.max(0, Math.min(this.store.settings.syncDelayMs, 30_000));
    const timer = window.setTimeout(() => {
      this.timers.delete(file.path);
      void this.syncService
        .syncFile(file, "auto")
        .then((result) => {
          if (result.status === "synced") this.onAutoSyncSuccess(file);
        })
        .catch((error) => this.onAutoSyncError(file, error));
    }, delay);

    this.timers.set(file.path, timer);
  }
}
