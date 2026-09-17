import { Notice, Plugin, TFile } from "obsidian";
import { VaultListener } from "./listeners/vault-listener";
import { AnythingLLMSyncSettingTab } from "./settings/settings-tab";
import { AnythingLLMClient } from "./services/anythingllm-client";
import { SyncService } from "./services/sync-service";
import { PluginStore } from "./store/plugin-store";
import type { WorkspaceOption } from "./types";

export default class AnythingLLMSyncPlugin extends Plugin {
  store!: PluginStore;
  client!: AnythingLLMClient;
  syncService!: SyncService;
  workspaceCache: WorkspaceOption[] = [];
  private vaultListener?: VaultListener;

  async onload(): Promise<void> {
    this.store = new PluginStore(this);
    await this.store.load();

    this.client = new AnythingLLMClient(() => this.store.settings, () => this.store.apiKey);
    this.syncService = new SyncService(this.app, this.client, this.store);

    this.addSettingTab(new AnythingLLMSyncSettingTab(this.app, this));
    this.registerCommands();

    this.app.workspace.onLayoutReady(() => {
      this.vaultListener = new VaultListener(
        this,
        this.syncService,
        this.store,
        (message) => {
          if (this.store.settings.showNotices) new Notice(`AnythingLLM Sync: ${message}`);
        },
        (message, error) => {
          console.error(`[AnythingLLM Sync] ${message}`, error);
          new Notice(`AnythingLLM Sync: ${message}: ${errorMessage(error)}`, 8000);
        }
      );
      this.vaultListener.register();
    });
  }

  onunload(): void {
    this.vaultListener?.dispose();
  }

  clearWorkspaceCache(): void {
    this.workspaceCache = [];
  }

  async refreshWorkspaces(): Promise<WorkspaceOption[]> {
    this.workspaceCache = await this.client.listWorkspaces();
    return this.workspaceCache;
  }

  async syncWatchedFolderWithNotice(): Promise<{ synced: number; skipped: number; failed: number }> {
    if (!this.store.settings.watchFolder.trim()) {
      new Notice("AnythingLLM Sync: watch folder is not configured.");
      return { synced: 0, skipped: 0, failed: 0 };
    }
    return this.syncService.syncWatchedFolder();
  }

  private registerCommands(): void {
    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note to AnythingLLM",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== "md") return false;
        if (!checking) void this.runManualSync(file);
        return true;
      }
    });

    this.addCommand({
      id: "sync-watched-folder",
      name: "Sync watched folder to AnythingLLM",
      callback: () => void this.runBulkSync()
    });
  }

  private async runManualSync(file: TFile): Promise<void> {
    try {
      const result = await this.syncService.syncFile(file, "manual");
      if (result.status === "synced") {
        const verb = result.operation === "created" ? "synced" : result.operation === "updated" ? "updated" : "moved";
        new Notice(`AnythingLLM Sync: ${verb} ${file.basename}.`);
      } else if (result.status === "skipped" && result.reason === "unchanged") {
        new Notice("AnythingLLM Sync: note is already synchronized and unchanged.");
      } else if (result.status === "skipped" && result.reason === "empty") {
        new Notice("AnythingLLM Sync: note is empty.");
      }
    } catch (error) {
      console.error("[AnythingLLM Sync] Manual sync failed", file.path, error);
      new Notice(`AnythingLLM Sync failed: ${errorMessage(error)}`, 8000);
    }
  }

  private async runBulkSync(): Promise<void> {
    try {
      const result = await this.syncWatchedFolderWithNotice();
      new Notice(`AnythingLLM Sync: ${result.synced} synced, ${result.skipped} skipped, ${result.failed} failed.`, 8000);
    } catch (error) {
      console.error("[AnythingLLM Sync] Bulk sync failed", error);
      new Notice(`AnythingLLM Sync failed: ${errorMessage(error)}`, 8000);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
