import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type AnythingLLMSyncPlugin from "../main";

export class AnythingLLMSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly syncPlugin: AnythingLLMSyncPlugin) {
    super(app, syncPlugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.syncPlugin.store.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("AnythingLLM URL")
      .setDesc("Base URL of your AnythingLLM instance, for example http://localhost:3001")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:3001")
          .setValue(settings.baseUrl)
          .onChange(async (value) => {
            this.syncPlugin.clearWorkspaceCache();
            await this.syncPlugin.store.updateSettings({
              baseUrl: value.trim(),
              workspaceSlug: "",
              workspaceName: ""
            });
          })
      );

    new Setting(containerEl)
      .setName("Developer API key")
      .setDesc("Stored securely with Obsidian SecretStorage. Create the key in AnythingLLM Settings → Developer API.")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(settings.apiKeySecretId)
          .onChange(async (value) => {
            this.syncPlugin.clearWorkspaceCache();
            await this.syncPlugin.store.updateSettings({
              apiKeySecretId: value || "anythingllm-sync-api-key",
              workspaceSlug: "",
              workspaceName: ""
            });
          })
      );

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Verify the AnythingLLM URL and Developer API key.")
      .addButton((button) =>
        button.setButtonText("Test connection").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.syncPlugin.client.testConnection();
            new Notice("AnythingLLM Sync: connection successful.");
          } catch (error) {
            new Notice(`Connection failed: ${errorMessage(error)}`, 7000);
          } finally {
            button.setDisabled(false);
          }
        })
      );

    const workspaceSetting = new Setting(containerEl)
      .setName("AnythingLLM workspace")
      .setDesc("Markdown notes are embedded into this workspace.");

    workspaceSetting.addDropdown((dropdown) => {
      dropdown.addOption("", "Select a workspace");
      for (const workspace of this.syncPlugin.workspaceCache) {
        dropdown.addOption(workspace.slug, workspace.name);
      }
      if (
        settings.workspaceSlug &&
        !this.syncPlugin.workspaceCache.some((workspace) => workspace.slug === settings.workspaceSlug)
      ) {
        dropdown.addOption(settings.workspaceSlug, settings.workspaceName || settings.workspaceSlug);
      }
      dropdown.setValue(settings.workspaceSlug);
      dropdown.onChange(async (slug) => {
        const selected = this.syncPlugin.workspaceCache.find((workspace) => workspace.slug === slug);
        await this.syncPlugin.store.updateSettings({
          workspaceSlug: slug,
          workspaceName: selected?.name ?? ""
        });
      });
    });

    workspaceSetting.addButton((button) =>
      button.setButtonText("Refresh workspaces").onClick(async () => {
        button.setDisabled(true);
        try {
          const workspaces = await this.syncPlugin.refreshWorkspaces();
          new Notice(`AnythingLLM Sync: found ${workspaces.length} workspace(s).`);
          this.display();
        } catch (error) {
          new Notice(`Unable to load workspaces: ${errorMessage(error)}`, 7000);
        } finally {
          button.setDisabled(false);
        }
      })
    );

    new Setting(containerEl)
      .setName("Watch folder")
      .setDesc("Vault-relative folder to auto-sync. Subfolders are included. Leave blank to disable automatic folder sync.")
      .addText((text) =>
        text
          .setPlaceholder("00-Inbox")
          .setValue(settings.watchFolder)
          .onChange(async (value) => this.syncPlugin.store.updateSettings({ watchFolder: value }))
      );

    new Setting(containerEl)
      .setName("Automatic sync")
      .setDesc("Sync created, edited, renamed and deleted Markdown notes inside the watch folder.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (value) => {
          await this.syncPlugin.store.updateSettings({ autoSync: value });
        })
      );

    new Setting(containerEl)
      .setName("Sync delay")
      .setDesc("Debounce file changes before syncing, useful for Web Clipper and active editing. Default: 1000 ms.")
      .addText((text) =>
        text
          .setPlaceholder("1000")
          .setValue(String(settings.syncDelayMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 30_000) {
              await this.syncPlugin.store.updateSettings({ syncDelayMs: parsed });
            }
          })
      );

    new Setting(containerEl)
      .setName("Sync notifications")
      .setDesc("Show a small notice after successful automatic synchronization.")
      .addToggle((toggle) =>
        toggle.setValue(settings.showNotices).onChange(async (value) => {
          await this.syncPlugin.store.updateSettings({ showNotices: value });
        })
      );

    new Setting(containerEl).setName("Maintenance").setHeading();

    new Setting(containerEl)
      .setName("Sync watched folder now")
      .setDesc("Upload or update all Markdown notes currently inside the watch folder.")
      .addButton((button) =>
        button.setButtonText("Sync now").setCta().onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await this.syncPlugin.syncWatchedFolderWithNotice();
            new Notice(`AnythingLLM Sync: ${result.synced} synced, ${result.skipped} skipped, ${result.failed} failed.`, 7000);
          } finally {
            button.setDisabled(false);
          }
        })
      );

    const tracked = this.syncPlugin.store.getAllSyncRecords().length;
    containerEl.createEl("p", {
      text: `Tracked notes: ${tracked}. AnythingLLM may keep superseded source files in its global document storage; this plugin keeps the selected workspace embeddings synchronized.`,
      cls: "setting-item-description"
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
