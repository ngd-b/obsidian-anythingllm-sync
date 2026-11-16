import { ButtonComponent, Modal, type App, type TFile } from "obsidian";
import type { SyncService } from "../services/sync-service";
import type { PluginStore } from "../store/plugin-store";
import type { FileSyncState } from "../types";

export const STATUS_LABELS: Record<FileSyncState, string> = {
  unsynced: "Not synced", synced: "Synced", modified: "Needs sync", syncing: "Syncing",
  missing: "Remote missing", checking: "Checking", error: "Error"
};

export class SyncStatusModal extends Modal {
  private active = false;
  private busy = false;
  private statusEl!: HTMLElement;
  private detailsEl!: HTMLElement;
  private readonly buttons: ButtonComponent[] = [];

  constructor(app: App, private readonly file: TFile, private readonly service: SyncService, private readonly store: PluginStore) {
    super(app);
  }

  onOpen(): void {
    this.active = true;
    this.setTitle("AnythingLLM sync status");
    this.contentEl.createEl("p", { text: this.file.path });
    this.statusEl = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
    this.detailsEl = this.contentEl.createEl("p", { cls: "setting-item-description" });
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    this.buttons.push(new ButtonComponent(footer).setButtonText("Check remote").onClick(() => this.check()));
    this.buttons.push(new ButtonComponent(footer).setButtonText("Sync now").setCta().onClick(() =>
      this.run("Synchronizing…", async () => {
        const result = await this.service.syncFile(this.file, "manual");
        if (result.status === "skipped" && result.reason === "empty") {
          throw new Error("This note is empty. Add content before syncing; any previous remote content has been kept.");
        }
      })));
    new ButtonComponent(footer).setButtonText("Close").onClick(() => this.close());
    void this.check();
  }

  onClose(): void {
    this.active = false;
    this.contentEl.empty();
    this.buttons.length = 0;
  }

  private check(): Promise<void> {
    return this.run("Checking remote presence…", async () => {
      await this.service.checkFiles([this.file]);
    });
  }

  private async run(message: string, action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    for (const button of this.buttons) button.setDisabled(true);
    this.statusEl.setText(message);
    this.statusEl.removeClass("text-error");
    try {
      await action();
      const status = await this.service.getFileStatus(this.file);
      if (!this.active) return;
      this.statusEl.setText(`${STATUS_LABELS[status.state]} — ${status.message}`);
      if (status.state === "error") this.statusEl.addClass("text-error");
      const record = this.store.getSyncRecord(this.file.path);
      this.detailsEl.setText(record
        ? `Workspace: ${record.workspaceSlug}. Last synced: ${new Date(record.lastSyncedAt).toLocaleString()}. ${record.lastCheckedAt ? `Last remote check: ${new Date(record.lastCheckedAt).toLocaleString()}.` : "Remote presence has not been verified."}`
        : "Sync this note to upload it to the selected workspace.");
    } catch (error) {
      if (this.active) {
        this.statusEl.setText(error instanceof Error ? error.message : String(error));
        this.statusEl.addClass("text-error");
      }
    } finally {
      this.busy = false;
      if (this.active) for (const button of this.buttons) button.setDisabled(false);
    }
  }
}
