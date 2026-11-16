import { TFile, type Plugin, type TAbstractFile } from "obsidian";
import type { SyncService } from "../services/sync-service";
import type { PluginStore } from "../store/plugin-store";
import { STATUS_LABELS, SyncStatusModal } from "./sync-status-modal";

/** Keep the explorer DOM adapter isolated: Obsidian has no public file decoration API. */
export class FileStatusDecorations {
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  private readonly unsubscribe: Array<() => void> = [];
  private timer?: number;
  private disposed = false;
  private revision = 0;

  constructor(private readonly plugin: Plugin, private readonly service: SyncService, private readonly store: PluginStore) {}

  register(): void {
    this.unsubscribe.push(this.service.subscribe(() => this.schedule()), this.store.subscribe(() => this.schedule()));
    this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.schedule()));
    const onFileChange = (file: TAbstractFile) => {
      if (file instanceof TFile) this.service.invalidateFileStatus(file);
      this.schedule();
    };
    this.plugin.registerEvent(this.plugin.app.vault.on("create", onFileChange));
    this.plugin.registerEvent(this.plugin.app.vault.on("modify", onFileChange));
    this.plugin.registerEvent(this.plugin.app.vault.on("delete", onFileChange));
    this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file) => {
      if (file instanceof TFile) this.service.invalidateFileStatus(file);
      this.schedule();
    }));
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.revision += 1;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    for (const [root, observer] of this.observers) {
      observer.disconnect();
      root.querySelectorAll(".anythingllm-sync-badge").forEach((badge) => badge.remove());
    }
    this.observers.clear();
  }

  private schedule(): void {
    if (this.disposed) return;
    this.revision += 1;
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch((error) => console.error("[AnythingLLM Sync] Unable to refresh file status", error));
    }, 100);
  }

  private async refresh(): Promise<void> {
    const revision = this.revision;
    const roots = new Set(this.plugin.app.workspace.getLeavesOfType("file-explorer").map((leaf) => leaf.view.containerEl));
    for (const [root, observer] of this.observers) {
      if (!roots.has(root)) {
        observer.disconnect();
        root.querySelectorAll(".anythingllm-sync-badge").forEach((badge) => badge.remove());
        this.observers.delete(root);
      }
    }
    for (const root of roots) {
      // An earlier explorer may have awaited a hash read while the layout changed
      // or the plugin unloaded. Never attach observers from that stale refresh.
      if (this.disposed || revision !== this.revision) return;
      if (!this.observers.has(root)) {
        const observer = new MutationObserver((mutations) => {
          const relevant = mutations.some((mutation) => {
            if (mutation.target.nodeType === 1 && (mutation.target as Element).closest(".anythingllm-sync-badge")) return false;
            if (mutation.type === "attributes") return true;
            return [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
              .some((node) => !(node.nodeType === 1 && (node as Element).matches(".anythingllm-sync-badge")));
          });
          if (relevant) this.schedule();
        });
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-path"] });
        this.observers.set(root, observer);
      }
      await Promise.all(Array.from(root.querySelectorAll<HTMLElement>(".nav-file-title[data-path]")).map(async (row) => {
        const path = row.getAttribute("data-path");
        const file = path ? this.plugin.app.vault.getAbstractFileByPath(path) : null;
        let badge = row.querySelector<HTMLButtonElement>(".anythingllm-sync-badge");
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") { badge?.remove(); return; }
        const status = await this.service.getFileStatus(file);
        if (this.disposed || revision !== this.revision || row.getAttribute("data-path") !== path) return;
        if (!badge) {
          badge = row.createEl("button", { type: "button", cls: "anythingllm-sync-badge" });
          badge.addEventListener("click", (event) => {
            event.stopPropagation();
            const current = this.plugin.app.vault.getAbstractFileByPath(row.getAttribute("data-path") ?? "");
            if (current instanceof TFile) new SyncStatusModal(this.plugin.app, current, this.service, this.store).open();
          });
          badge.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          });
        }
        if (badge.textContent !== STATUS_LABELS[status.state]) badge.setText(STATUS_LABELS[status.state]);
        badge.setAttribute("data-sync-state", status.state);
        badge.setAttribute("aria-label", `${file.name}: ${STATUS_LABELS[status.state]}. Check sync status`);
        badge.title = status.message;
      }));
    }
  }
}
