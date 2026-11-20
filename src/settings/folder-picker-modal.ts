import { ButtonComponent, Modal, setIcon, TFolder, type App } from "obsidian";
import type { WatchFolderSelection } from "../types";
import { isPathInsideFolder, isPathInsideWatchFolders, normalizeWatchFolders, parentFolder } from "../utils/path";

export class FolderPickerModal extends Modal {
  #folderDraft: WatchFolderSelection;
  private readonly checkboxes = new Map<string, HTMLInputElement>();
  private countEl!: HTMLElement;
  private availableCount = 0;
  private saving = false;

  constructor(app: App, selection: WatchFolderSelection, private readonly save: (selection: WatchFolderSelection) => Promise<void>) {
    super(app);
    this.#folderDraft = normalizeWatchFolders(selection);
  }

  onOpen(): void {
    this.modalEl.addClass("anythingllm-folder-picker");
    this.setTitle("Sync folders");
    const { contentEl } = this;
    contentEl.empty();
    this.checkboxes.clear();
    const body = contentEl.createDiv({ cls: "anythingllm-folder-body" });
    body.createEl("p", {
      cls: "anythingllm-folder-intro",
      text: "Uncheck a folder to exclude it and its subfolders."
    });

    const folders = this.childFolders(this.app.vault.getRoot());
    const panel = body.createDiv({ cls: "anythingllm-folder-panel" });
    const toolbar = panel.createDiv({ cls: "anythingllm-folder-toolbar" });
    const icon = toolbar.createSpan({ cls: "anythingllm-vault-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "vault");
    const vault = toolbar.createDiv({ cls: "anythingllm-vault-info" });
    vault.createDiv({ cls: "anythingllm-vault-name", text: this.app.vault.getName() });
    this.countEl = vault.createDiv({ cls: "anythingllm-folder-count", attr: { "aria-live": "polite" } });
    const selectAll = new ButtonComponent(toolbar).setButtonText("Select all").setDisabled(!folders.length).onClick(() => {
      this.#folderDraft = { watchFolders: folders.map((folder) => folder.path), excludedFolders: [] };
      this.refreshCheckboxes();
    });

    const tree = panel.createDiv({ cls: "anythingllm-folder-tree", attr: {
      role: "group", "aria-label": `Folders in ${this.app.vault.getName()}`
    } });
    if (!folders.length) tree.createEl("p", { cls: "anythingllm-folder-message", text: "Create a folder in this vault to start syncing." });
    for (const folder of folders) this.renderFolder(tree, folder, 0);

    this.availableCount = this.checkboxes.size;
    const unavailable = this.#folderDraft.watchFolders.filter((path) => !this.app.vault.getFolderByPath(path));
    if (unavailable.length) {
      tree.createEl("p", { text: "Unavailable folders — uncheck these to remove them:", cls: "anythingllm-folder-message text-warning" });
      for (const path of unavailable) this.renderCheckbox(tree.createDiv({ cls: "anythingllm-folder-row" }), path, path);
    }
    this.refreshCheckboxes();

    const status = contentEl.createEl("p", { cls: "anythingllm-folder-status", attr: { role: "status", "aria-live": "polite" } });
    const footer = contentEl.createDiv({ cls: "modal-button-container" });
    footer.createSpan({ cls: "anythingllm-folder-note", text: "Excluding a folder keeps its existing uploads." });
    const cancel = new ButtonComponent(footer).setButtonText("Cancel").onClick(() => this.close());
    const confirm = new ButtonComponent(footer).setButtonText("Confirm").setCta().onClick(async () => {
      if (this.saving) return;
      const missing = this.#folderDraft.watchFolders.filter((path) => !this.app.vault.getFolderByPath(path));
      if (missing.length) {
        status.setText(`Folders no longer exist: ${missing.join(", ")}. Uncheck them or reopen this dialog to refresh.`);
        status.addClass("text-error");
        return;
      }
      this.saving = true;
      selectAll.setDisabled(true);
      cancel.setDisabled(true);
      confirm.setDisabled(true);
      this.refreshCheckboxes();
      status.removeClass("text-error");
      status.setText("Saving…");
      try {
        await this.save(this.#folderDraft);
        this.saving = false;
        this.close();
      } catch (error) {
        status.setText(`Unable to save folders: ${error instanceof Error ? error.message : String(error)}`);
        status.addClass("text-error");
      } finally {
        this.saving = false;
        selectAll.setDisabled(!folders.length);
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
    const row = parent.createDiv({ cls: "anythingllm-folder-row" });
    if (!children.length) {
      this.renderCheckbox(row, folder.path, folder.name);
      return;
    }

    const toggle = row.createEl("button", {
      cls: "anythingllm-folder-toggle", type: "button", attr: { "aria-label": `Subfolders of ${folder.path}` }
    });
    setIcon(toggle, "chevron-right");
    this.renderCheckbox(row, folder.path, folder.name);
    const group = parent.createDiv({ cls: "anythingllm-folder-children" });
    const setExpanded = (expanded: boolean) => {
      group.hidden = !expanded;
      toggle.setAttribute("aria-expanded", String(expanded));
    };
    const rules = [...this.#folderDraft.watchFolders, ...this.#folderDraft.excludedFolders];
    setExpanded(depth === 0 || rules.some((path) => isPathInsideFolder(path, folder.path)));
    toggle.addEventListener("click", () => setExpanded(group.hidden));
    for (const child of children) this.renderFolder(group, child, depth + 1);
  }

  private renderCheckbox(row: HTMLElement, path: string, name: string): void {
    const label = row.createEl("label", { cls: "anythingllm-folder-label", attr: { title: path } });
    const icon = label.createSpan({ cls: "anythingllm-folder-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "folder");
    label.createSpan({ cls: "anythingllm-folder-name", text: name });
    const checkbox = label.createEl("input", {
      type: "checkbox",
      attr: { "aria-label": `Sync ${path}` }
    });
    checkbox.addEventListener("change", () => {
      const outsideBranch = (folder: string) => !isPathInsideFolder(folder, path);
      this.#folderDraft.watchFolders = this.#folderDraft.watchFolders.filter(outsideBranch);
      this.#folderDraft.excludedFolders = this.#folderDraft.excludedFolders.filter(outsideBranch);
      if (checkbox.checked !== isPathInsideWatchFolders(path, this.#folderDraft)) {
        const rules = checkbox.checked ? this.#folderDraft.watchFolders : this.#folderDraft.excludedFolders;
        rules.push(path);
      }
      this.refreshCheckboxes();
    });
    this.checkboxes.set(path, checkbox);
  }

  private refreshCheckboxes(): void {
    const mixed = new Set<string>();
    for (const path of [...this.#folderDraft.watchFolders, ...this.#folderDraft.excludedFolders]) {
      for (let parent = parentFolder(path); parent; parent = parentFolder(parent)) mixed.add(parent);
    }
    let selectedCount = 0;
    for (const [path, checkbox] of this.checkboxes) {
      checkbox.indeterminate = mixed.has(path);
      checkbox.checked = isPathInsideWatchFolders(path, this.#folderDraft);
      checkbox.disabled = this.saving;
      if (checkbox.checked && this.app.vault.getFolderByPath(path)) selectedCount++;
    }
    this.countEl.setText(`${selectedCount} of ${this.availableCount} ${this.availableCount === 1 ? "folder" : "folders"} selected`);
  }
}
