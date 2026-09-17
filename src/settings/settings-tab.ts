import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AnythingLLMSyncPlugin from "../main";

export class AnythingLLMSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly syncPlugin: AnythingLLMSyncPlugin) {
    super(app, syncPlugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.syncPlugin.store.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AnythingLLM Sync" });

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
              workspaceName: "",
            });
          }),
      );

    new Setting(containerEl)
      .setName("Developer API key")
      .setDesc("Create this in AnythingLLM Settings → Developer API. It is stored in this vault's plugin data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Paste API key")
          .setValue(settings.apiKey)
          .onChange(async (value) => {
            this.syncPlugin.clearWorkspaceCache();
            await this.syncPlugin.store.updateSettings({
              apiKey: value.trim(),
              workspaceSlug: "",
              workspaceName: "",
            });
          });
      });

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
        }),
      );

    const workspaceSetting = new Setting(containerEl)
      .setName("AnythingLLM workspace")
      .setDesc("New notes are uploaded and embedded into this workspace.");

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
          workspaceName: selected?.name ?? "",
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
      }),
    );

    new Setting(containerEl)
      .setName("Watch folder")
      .setDesc("Vault-relative folder to auto-sync, for example 00-Inbox. Subfolders are included. Leave blank to disable watching.")
      .addText((text) =>
        text
          .setPlaceholder("00-Inbox")
          .setValue(settings.watchFolder)
          .onChange(async (value) => {
            await this.syncPlugin.store.updateSettings({ watchFolder: value });
          }),
      );

    new Setting(containerEl)
      .setName("Automatic sync")
      .setDesc("Automatically sync newly created Markdown files inside the watch folder.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (value) => {
          await this.syncPlugin.store.updateSettings({ autoSync: value });
        }),
      );

    new Setting(containerEl)
      .setName("Sync delay (ms)")
      .setDesc("Wait after file creation so Web Clipper can finish writing. Default: 700 ms.")
      .addText((text) =>
        text
          .setPlaceholder("700")
          .setValue(String(settings.syncDelayMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 30_000) {
              await this.syncPlugin.store.updateSettings({ syncDelayMs: parsed });
            }
          }),
      );

    containerEl.createEl("h3", { text: "Current v0.1 scope" });
    containerEl.createEl("p", {
      text: "New Markdown files are synced automatically. The project already stores local↔remote sync state so update, delete, and rename synchronization can be added without changing the architecture.",
      cls: "setting-item-description",
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
