import { ButtonComponent, Modal, TFolder, type App } from "obsidian";
import { isPathInsideFolder, normalizeWatchFolders } from "../utils/path";

export class FolderPickerModal extends Modal {
  private selected: Set<string>;
  private readonly checkboxes = new Map<string, HTMLInputElement>();
  private saving = false;

  constructor(app: App, folders: string[], private readonly save: (folders: string[]) => Promise<void>) {
    super(app);
    this.selected = new Set(normalizeWatchFolders(folders));
  }

  onOpen(): void {
    this.setTitle("Choose watch folders");
    const { contentEl } = this;
    contentEl.empty();
    this.checkboxes.clear();
    contentEl.createEl("p", {
      text: "Select folders to sync. Subfolders are included automatically. Changes apply only after you confirm."
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Removing a folder stops automatic tracking and keeps its existing AnythingLLM documents. Use Sync watched folders now to upload existing notes."
    });

    const tree = contentEl.createDiv({ cls: "anythingllm-folder-tree" });
    tree.setAttribute("aria-label", `Folders in ${this.app.vault.getName()}`);
    const folders = this.childFolders(this.app.vault.getRoot());
    if (!folders.length) tree.createEl("p", { text: "This vault has no folders. Create a folder first." });
    for (const folder of folders) this.renderFolder(tree, folder, 0);

    const unavailable = [...this.selected].filter((path) => !this.app.vault.getFolderByPath(path));
    if (unavailable.length) {
      tree.createEl("p", { text: "Unavailable folders — uncheck these to remove them:", cls: "text-warning" });
      for (const path of unavailable) this.renderCheckbox(tree.createDiv({ cls: "anythingllm-folder-leaf" }), path, path);
    }
    this.refreshCheckboxes();

    const status = contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
    const footer = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = new ButtonComponent(footer).setButtonText("Cancel").onClick(() => this.close());
    const confirm = new ButtonComponent(footer).setButtonText("Confirm").setCta().onClick(async () => {
      if (this.saving) return;
      const selected = normalizeWatchFolders([...this.selected]);
      const missing = selected.filter((path) => !this.app.vault.getFolderByPath(path));
      if (missing.length) {
        status.setText(`Folders no longer exist: ${missing.join(", ")}. Uncheck them or reopen this dialog to refresh.`);
        status.addClass("text-error");
        return;
      }
      this.saving = true;
      cancel.setDisabled(true);
      confirm.setDisabled(true);
      this.refreshCheckboxes();
      status.removeClass("text-error");
      status.setText("Saving…");
      try {
        await this.save(selected);
        this.saving = false;
        this.close();
      } catch (error) {
        status.setText(`Unable to save folders: ${error instanceof Error ? error.message : String(error)}`);
        status.addClass("text-error");
      } finally {
        this.saving = false;
        cancel.setDisabled(false);
        confirm.setDisabled(false);
        this.refreshCheckboxes();
      }
    });
  }

  close(): void {
    if (!this.saving) super.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.checkboxes.clear();
  }

  private childFolders(folder: TFolder): TFolder[] {
    return folder.children.filter((child): child is TFolder => child instanceof TFolder)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private renderFolder(parent: HTMLElement, folder: TFolder, depth: number): void {
    const children = this.childFolders(folder);
    if (!children.length) {
      this.renderCheckbox(parent.createDiv({ cls: "anythingllm-folder-leaf" }), folder.path, folder.name);
      return;
    }
    const branch = parent.createEl("details", { cls: "anythingllm-folder-node" });
    branch.open = depth === 0 || [...this.selected].some((path) => isPathInsideFolder(path, folder.path));
    this.renderCheckbox(branch.createEl("summary"), folder.path, folder.name);
    const group = branch.createDiv({ cls: "anythingllm-folder-children" });
    for (const child of children) this.renderFolder(group, child, depth + 1);
  }

  private renderCheckbox(row: HTMLElement, path: string, name: string): void {
    row.createSpan({ text: name });
    const checkbox = row.createEl("input", {
      type: "checkbox",
      attr: { "aria-label": `Sync ${path}`, title: path }
    });
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) this.selected.add(path);
      else this.selected.delete(path);
      this.selected = new Set(normalizeWatchFolders([...this.selected]));
      this.refreshCheckboxes();
    });
    this.checkboxes.set(path, checkbox);
  }

  private refreshCheckboxes(): void {
    for (const [path, checkbox] of this.checkboxes) {
      const inherited = [...this.selected].some((parent) => parent !== path && isPathInsideFolder(path, parent));
      checkbox.checked = inherited || this.selected.has(path);
      checkbox.disabled = this.saving || inherited;
      checkbox.title = inherited ? `${path} — included by a selected parent folder` : path;
    }
  }
}
