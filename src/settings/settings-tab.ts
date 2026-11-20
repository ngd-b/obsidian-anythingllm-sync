import {
  Notice,
  PluginSettingTab,
  SecretComponent,
  type App,
  type Setting,
  type SettingDefinitionItem
} from "obsidian";
import type AnythingLLMSyncPlugin from "../main";
import { DEFAULT_SECRET_ID } from "./defaults";
import { FolderPickerModal } from "./folder-picker-modal";

export class AnythingLLMSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly syncPlugin: AnythingLLMSyncPlugin) {
    super(app, syncPlugin);
    this.containerEl.addClass("anythingllm-sync-settings");
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "AnythingLLM URL",
        desc: "Base URL of your AnythingLLM instance, for example http://localhost:3001",
        control: {
          type: "text",
          key: "baseUrl",
          placeholder: "http://localhost:3001"
        }
      },
      {
        name: "Developer API key",
        desc: "Stored securely with Obsidian SecretStorage. Create the key in AnythingLLM Settings → Developer API.",
        render: (setting) => this.renderApiKey(setting)
      },
      {
        name: "Test connection",
        desc: "Verify the AnythingLLM URL and Developer API key.",
        action: (row) => void runSettingAction(row, async () => {
          try {
            await this.syncPlugin.client.testConnection();
            new Notice("AnythingLLM Sync: connection successful.");
          } catch (error) {
            new Notice(`Connection failed: ${errorMessage(error)}`, 7000);
          }
        })
      },
      {
        name: "AnythingLLM workspace",
        desc: "Markdown notes are embedded into this workspace.",
        render: (setting) => this.renderWorkspace(setting)
      },
      {
        name: "Watch folders",
        render: (setting) => this.renderWatchFolders(setting)
      },
      {
        name: "Automatic sync",
        desc: "Sync created, edited, renamed and deleted Markdown notes inside any selected folder.",
        control: { type: "toggle", key: "autoSync" }
      },
      {
        name: "Sync delay",
        desc: "Debounce file changes before syncing, useful for Web Clipper and active editing. Default: 1000 ms.",
        control: {
          type: "number",
          key: "syncDelayMs",
          placeholder: "1000",
          min: 100,
          max: 30000,
          validate: (value) =>
            value >= 100 && value <= 30000 ? undefined : "Must be between 100 and 30000 ms."
        }
      },
      {
        name: "Sync notifications",
        desc: "Show a small notice after successful automatic synchronization.",
        control: { type: "toggle", key: "showNotices" }
      },
      {
        type: "group",
        heading: "Maintenance",
        items: [
          {
            name: "Check remote sync status",
            desc: "Check whether tracked notes still exist in their AnythingLLM workspaces. Missing notes can be restored by syncing again.",
            action: (row) => void runSettingAction(row, () => this.syncPlugin.checkRemoteWithNotice())
          },
          {
            name: "Sync watched folders now",
            desc: "Upload or update Markdown notes in all selected folders. Overlapping folders are synced once.",
            action: (row) => void runSettingAction(row, async () => {
              try {
                const result = await this.syncPlugin.syncWatchedFolderWithNotice();
                new Notice(
                  `AnythingLLM Sync: ${result.synced} synced, ${result.skipped} skipped, ${result.failed} failed.`,
                  7000
                );
              } catch (error) {
                new Notice(`AnythingLLM Sync failed: ${errorMessage(error)}`, 7000);
              }
            })
          }
        ]
      },
      {
        name: "Tracked notes",
        desc: (() => {
          const tracked = this.syncPlugin.store.getAllSyncRecords().length;
          return `${tracked} note(s) tracked. AnythingLLM may keep superseded source files in its global document storage; this plugin keeps the selected workspace embeddings synchronized.`;
        })()
      }
    ];
  }

  getControlValue(key: string): unknown {
    return (this.syncPlugin.store.settings as unknown as Record<string, unknown>)[key];
  }

  setControlValue(key: string, value: unknown): void | Promise<void> {
    if (key === "baseUrl") {
      this.syncPlugin.clearWorkspaceCache();
      return this.syncPlugin.store.updateSettings({
        baseUrl: typeof value === "string" ? value.trim() : String(value),
        workspaceSlug: "",
        workspaceName: ""
      });
    }
    return this.syncPlugin.store.updateSettings({ [key]: value });
  }

  private renderApiKey(setting: Setting): void {
    setting.addComponent((el) =>
      new SecretComponent(this.app, el)
        .setValue(this.syncPlugin.store.settings.apiKeySecretId)
        .onChange(async (value) => {
          this.syncPlugin.clearWorkspaceCache();
          await this.syncPlugin.store.updateSettings({
            apiKeySecretId: value || DEFAULT_SECRET_ID,
            workspaceSlug: "",
            workspaceName: ""
          });
        })
    );
  }

  private renderWatchFolders(setting: Setting): void {
    const updateSummary = () => {
      const { watchFolders: folders, excludedFolders } = this.syncPlugin.store.settings;
      const preview = folders.slice(0, 3).join(", ");
      const scope = excludedFolders.length ? `${excludedFolders.length} folder(s) excluded.` : "Subfolders are included.";
      setting.setDesc(folders.length
        ? `${folders.length} folder(s): ${preview}${folders.length > 3 ? ", …" : ""}. ${scope}`
        : "No folders selected. Automatic folder sync is disabled.");
    };
    updateSummary();
    setting.addButton((button) => button.setButtonText("Choose folders").onClick(() => {
      new FolderPickerModal(this.app, this.syncPlugin.store.settings, async (selection) => {
        await this.syncPlugin.store.updateSettings(selection);
        updateSummary();
      }).open();
    }));
  }

  private renderWorkspace(setting: Setting): void {
    const settings = this.syncPlugin.store.settings;

    setting.addDropdown((dropdown) => {
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

    setting.addButton((button) =>
      button.setButtonText("Refresh workspaces").onClick(async () => {
        button.setDisabled(true);
        try {
          const workspaces = await this.syncPlugin.refreshWorkspaces();
          new Notice(`AnythingLLM Sync: found ${workspaces.length} workspace(s).`);
          this.update();
        } catch (error) {
          new Notice(`Unable to load workspaces: ${errorMessage(error)}`, 7000);
        } finally {
          button.setDisabled(false);
        }
      })
    );
  }
}

async function runSettingAction(row: HTMLElement, action: () => Promise<void>): Promise<void> {
  if (row.getAttribute("aria-busy") === "true") return;
  row.setAttribute("aria-busy", "true");
  try {
    await action();
  } catch (error) {
    new Notice(`AnythingLLM Sync: ${errorMessage(error)}`, 7000);
  } finally {
    row.removeAttribute("aria-busy");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
