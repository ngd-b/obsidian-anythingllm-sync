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
    private readonly onSuccess: (message: string) => void,
    private readonly onError: (message: string, error: unknown) => void
  ) {}

  register(): void {
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => this.handleCandidate(file))
    );

    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => this.handleCandidate(file))
    );

    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => {
        if (!this.store.settings.autoSync) return;
        if (!isPathInsideFolder(file.path, this.store.settings.watchFolder)) return;
        this.cancel(file.path);
        void this.syncService
          .deleteByPath(file.path)
          .then((result) => {
            if (result.status === "deleted") this.onSuccess(`Removed ${file.name} from AnythingLLM`);
          })
          .catch((error) => this.onError(`Failed to remove ${file.name}`, error));
      })
    );

    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        if (!this.store.settings.autoSync) return;
        this.cancel(oldPath);
        this.cancel(file.path);
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
          void this.syncService.deleteByPath(oldPath).catch((error) => this.onError(`Failed to handle rename of ${file.name}`, error));
          return;
        }
        this.schedule(file, oldPath);
      })
    );
  }

  dispose(): void {
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  private handleCandidate(file: TAbstractFile): void {
    const settings = this.store.settings;
    if (!settings.autoSync) return;
    if (!(file instanceof TFile)) return;
    if (file.extension.toLowerCase() !== "md") return;
    if (!isPathInsideFolder(file.path, settings.watchFolder)) return;
    this.schedule(file);
  }

  private schedule(file: TFile, oldPath?: string): void {
    const key = oldPath ?? file.path;
    this.cancel(key);
    if (key !== file.path) this.cancel(file.path);

    const delay = Math.max(0, Math.min(this.store.settings.syncDelayMs, 30_000));
    const timer = window.setTimeout(() => {
      this.timers.delete(key);
      const task = oldPath
        ? this.syncService.handleRename(file, oldPath)
        : this.syncService.syncFile(file, "auto");

      void task
        .then((result) => {
          if (result.status === "synced") {
            const verb = result.operation === "created" ? "Synced" : result.operation === "updated" ? "Updated" : "Moved";
            this.onSuccess(`${verb} ${file.name}`);
          }
        })
        .catch((error) => this.onError(`Failed to sync ${file.name}`, error));
    }, delay);

    this.timers.set(key, timer);
  }

  private cancel(path: string): void {
    const timer = this.timers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.timers.delete(path);
  }
}
