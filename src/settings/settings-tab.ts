import {
  Notice,
  PluginSettingTab,
  SecretComponent,
  type App,
  type Setting,
  type SettingDefinitionItem
} from "obsidian";
import type AnythingLLMSyncPlugin from "../main";
import type { AnythingLLMSyncSettings } from "../types";
import { DEFAULT_SECRET_ID } from "./defaults";

export class AnythingLLMSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly syncPlugin: AnythingLLMSyncPlugin) {
    super(app, syncPlugin);
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
        action: async (el) => {
          const button = findButton(el);
          if (button) button.disabled = true;
          try {
            await this.syncPlugin.client.testConnection();
            new Notice("AnythingLLM Sync: connection successful.");
          } catch (error) {
            new Notice(`Connection failed: ${errorMessage(error)}`, 7000);
          } finally {
            if (button) button.disabled = false;
          }
        }
      },
      {
        name: "AnythingLLM workspace",
        desc: "Markdown notes are embedded into this workspace.",
        render: (setting) => this.renderWorkspace(setting)
      },
      {
        name: "Watch folder",
        desc: "Vault-relative folder to auto-sync. Subfolders are included. Leave blank to disable automatic folder sync.",
        control: {
          type: "text",
          key: "watchFolder",
          placeholder: "00-Inbox"
        }
      },
      {
        name: "Automatic sync",
        desc: "Sync created, edited, renamed and deleted Markdown notes inside the watch folder.",
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
            name: "Sync watched folder now",
            desc: "Upload or update all Markdown notes currently inside the watch folder.",
            action: async (el) => {
              const button = findButton(el);
              if (button) button.disabled = true;
              try {
                const result = await this.syncPlugin.syncWatchedFolderWithNotice();
                new Notice(
                  `AnythingLLM Sync: ${result.synced} synced, ${result.skipped} skipped, ${result.failed} failed.`,
                  7000
                );
              } finally {
                if (button) button.disabled = false;
              }
            }
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
    return this.syncPlugin.store.updateSettings({
      [key]: value
    } as unknown as Partial<AnythingLLMSyncSettings>);
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

function findButton(el: HTMLElement): HTMLButtonElement | null {
  return el instanceof HTMLButtonElement ? el : el.querySelector("button");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
