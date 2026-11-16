import type { Plugin, TAbstractFile } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { SyncService } from "../services/sync-service";
import { PluginStore } from "../store/plugin-store";
import { isPathInsideWatchFolders } from "../utils/path";

export class VaultListener {
  private readonly timers = new Map<TFile, number>();

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
        if (!isPathInsideWatchFolders(file.path, this.store.settings.watchFolders)) return;
        if (file instanceof TFile) this.cancel(file);
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
        if (file instanceof TFolder) {
          this.handleFolderRename(file, oldPath);
        } else if (file instanceof TFile) {
          this.handleFileRename(file, oldPath);
        }
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
    if (!isPathInsideWatchFolders(file.path, settings.watchFolders)) return;
    this.schedule(file);
  }

  private handleFolderRename(folder: TFolder, oldPath: string): void {
    for (const child of folder.children) {
      const previousPath = `${oldPath}/${child.name}`;
      if (child instanceof TFolder) {
        this.handleFolderRename(child, previousPath);
      } else if (child instanceof TFile && child.extension.toLowerCase() === "md") {
        this.handleFileRename(child, previousPath);
      }
    }
  }

  private handleFileRename(file: TFile, oldPath: string): void {
    this.cancel(file);
    // Enqueue the move now: a debounced rename would let manual/automatic edits
    // upload the new path before its old sync record has been moved.
    void this.syncService.handleRename(file, oldPath)
      .then((result) => {
        if (result.status === "deleted") this.onSuccess(`Removed ${file.name} from AnythingLLM`);
        else if (result.status === "synced") this.onSuccess(`Updated ${file.name}`);
      })
      .catch((error) => this.onError(`Failed to handle rename of ${file.name}`, error));
  }

  private schedule(file: TFile): void {
    this.cancel(file);

    const delay = Math.max(0, Math.min(this.store.settings.syncDelayMs, 30_000));
    const timer = window.setTimeout(() => {
      this.timers.delete(file);
      const task = this.syncService.syncFile(file, "auto");

      void task
        .then((result) => {
          if (result.status === "synced") {
            const verb = result.operation === "created" ? "Synced" : result.operation === "updated" ? "Updated" : "Moved";
            this.onSuccess(`${verb} ${file.name}`);
          }
        })
        .catch((error) => this.onError(`Failed to sync ${file.name}`, error));
    }, delay);

    this.timers.set(file, timer);
  }

  private cancel(file: TFile): void {
    const timer = this.timers.get(file);
    if (timer !== undefined) window.clearTimeout(timer);
    this.timers.delete(file);
  }
}
