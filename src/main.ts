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

    this.client = new AnythingLLMClient(() => this.store.settings);
    this.syncService = new SyncService(this.app, this.client, this.store);

    this.addSettingTab(new AnythingLLMSyncSettingTab(this.app, this));
    this.registerCommands();

    // Obsidian fires vault create events while initializing existing files.
    // Register the listener only after the workspace layout is ready.
    this.app.workspace.onLayoutReady(() => {
      this.vaultListener = new VaultListener(
        this,
        this.syncService,
        this.store,
        (file) => new Notice(`AnythingLLM Sync: synced ${file.basename}`),
        (file, error) => {
          console.error("[AnythingLLM Sync] Auto sync failed", file.path, error);
          new Notice(`AnythingLLM Sync failed for ${file.basename}: ${errorMessage(error)}`, 7000);
        },
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

  private registerCommands(): void {
    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note to AnythingLLM",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== "md") return false;
        if (!checking) void this.runManualSync(file);
        return true;
      },
    });
  }

  private async runManualSync(file: TFile): Promise<void> {
    try {
      const result = await this.syncService.syncFile(file, "manual");
      if (result.status === "synced") {
        new Notice(`AnythingLLM Sync: synced ${file.basename}`);
      } else if (result.status === "skipped" && result.reason === "unchanged") {
        new Notice("AnythingLLM Sync: note is already synced and unchanged.");
      } else if (result.status === "skipped" && result.reason === "empty") {
        new Notice("AnythingLLM Sync: note is empty.");
      }
    } catch (error) {
      console.error("[AnythingLLM Sync] Manual sync failed", file.path, error);
      new Notice(`AnythingLLM Sync failed: ${errorMessage(error)}`, 7000);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
