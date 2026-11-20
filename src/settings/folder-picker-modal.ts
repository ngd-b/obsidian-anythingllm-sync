import { ButtonComponent, Modal, setIcon, TFolder, type App } from "obsidian";
import type { WatchFolderSelection } from "../types";
import { isPathInsideFolder, isPathInsideWatchFolders, normalizeWatchFolders, parentFolder } from "../utils/path";

interface FolderRow {
  row: HTMLElement;
  checkbox: HTMLInputElement;
  available: boolean;
  branch?: { group: HTMLElement; toggle: HTMLButtonElement; expanded: boolean };
}

export class FolderPickerModal extends Modal {
  #folderDraft: WatchFolderSelection;
  private readonly rows = new Map<string, FolderRow>();
  private countEl!: HTMLElement;
  private filtering = false;
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
    const folders = this.childFolders(this.app.vault.getRoot());
    const toolbar = contentEl.createDiv({ cls: "anythingllm-folder-toolbar" });
    const searchBox = toolbar.createDiv({ cls: "search-input-container" });
    const search = searchBox.createEl("input", {
      type: "search", cls: "anythingllm-folder-search",
      placeholder: "Filter folders", attr: { "aria-label": "Filter folders by name or path" }
    });
    const clearSearch = searchBox.createEl("button", {
      type: "button", cls: "search-input-clear-button",
      attr: { "aria-label": "Clear filter", title: "Clear filter" }
    });
    this.countEl = toolbar.createSpan({ cls: "anythingllm-folder-count", attr: { "aria-live": "polite" } });
    let matchingRoots: string[] = [];
    const selectAll = new ButtonComponent(toolbar).onClick(() => {
      if (search.value.trim()) {
        for (const path of matchingRoots) this.selectSubtree(path, true);
      } else {
        this.#folderDraft = { watchFolders: folders.map((folder) => folder.path), excludedFolders: [] };
      }
      this.refreshCheckboxes();
    });

    const tree = contentEl.createDiv({ cls: "anythingllm-folder-tree", attr: {
      role: "group", "aria-label": `Folders in ${this.app.vault.getName()}`
    } });
    for (const folder of folders) this.renderFolder(tree, folder, 0);

    const unavailable = this.#folderDraft.watchFolders.filter((path) => !this.app.vault.getFolderByPath(path));
    const warning = tree.createEl("p", { text: "Unavailable folders — uncheck to remove:", cls: "anythingllm-folder-message text-warning" });
    for (const path of unavailable) this.renderRow(tree, path, path, false);
    const empty = tree.createEl("p", { cls: "anythingllm-folder-message" });
    const filter = () => {
      const query = search.value.trim().toLowerCase();
      this.filtering = Boolean(query);
      const matched = new Set<string>();
      const ancestors = new Set<string>();
      for (const path of this.rows.keys()) {
        if (!path.toLowerCase().includes(query)) continue;
        matched.add(path);
        for (let parent = parentFolder(path); parent; parent = parentFolder(parent)) ancestors.add(parent);
      }
      matchingRoots = [];
      for (const [path, { row, available, branch }] of this.rows) {
        row.hidden = !matched.has(path) && !ancestors.has(path);
        if (available && matched.has(path) && !matched.has(parentFolder(path))) matchingRoots.push(path);
        if (branch) {
          const expanded = query ? ancestors.has(path) : branch.expanded;
          branch.group.hidden = row.hidden || !expanded;
          branch.toggle.setAttribute("aria-expanded", String(expanded));
        }
      }
      warning.hidden = !unavailable.some((path) => matched.has(path));
      empty.hidden = matched.size > 0;
      empty.setText(query ? "No matching folders." : "Create a folder in this vault to start syncing.");
      selectAll.setButtonText(query ? "Select matches" : "Select all").setDisabled(!matchingRoots.length);
    };
    search.addEventListener("input", filter);
    clearSearch.addEventListener("click", () => {
      search.value = "";
      filter();
      search.focus();
    });
    filter();
    this.refreshCheckboxes();

    const footer = contentEl.createDiv({ cls: "anythingllm-folder-footer" });
    const status = footer.createEl("p", { cls: "anythingllm-folder-status", attr: { role: "status", "aria-live": "polite" } });
    const confirm = new ButtonComponent(footer).setButtonText("Confirm").setCta().onClick(async () => {
      if (this.saving) return;
      const snapshot = normalizeWatchFolders(this.#folderDraft);
      const missing = snapshot.watchFolders.filter((path) => !this.app.vault.getFolderByPath(path));
      if (missing.length) {
        status.addClass("text-error");
        status.setText(`Uncheck unavailable folders: ${missing.join(", ")}`);
        return;
      }
      this.saving = true;
      confirm.setDisabled(true);
      selectAll.setDisabled(true);
      search.disabled = true;
      clearSearch.disabled = true;
      this.refreshCheckboxes();
      status.removeClass("text-error");
      status.setText("Saving…");
      try {
        await this.save(snapshot);
      } catch (error) {
        this.saving = false;
        confirm.setDisabled(false);
        selectAll.setDisabled(!matchingRoots.length);
        search.disabled = false;
        clearSearch.disabled = false;
        this.refreshCheckboxes();
        status.addClass("text-error");
        status.setText(`Unable to save folders: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      this.saving = false;
      this.close();
    });
  }

  close(): void {
    if (!this.saving) super.close();
  }

  onClose(): void {
    this.rows.clear();
    this.contentEl.empty();
  }

  private childFolders(folder: TFolder): TFolder[] {
    return folder.children.filter((child): child is TFolder => child instanceof TFolder)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private renderFolder(parent: HTMLElement, folder: TFolder, depth: number): void {
    const children = this.childFolders(folder);
    const node = this.renderRow(parent, folder.path, folder.name, true);
    if (!children.length) return;
    const toggle = node.row.createEl("button", {
      cls: "anythingllm-folder-toggle", type: "button", attr: { "aria-label": `Subfolders of ${folder.path}` }
    });
    node.row.prepend(toggle);
    setIcon(toggle, "chevron-right");
    const group = parent.createDiv({ cls: "anythingllm-folder-children" });
    const rules = [...this.#folderDraft.watchFolders, ...this.#folderDraft.excludedFolders];
    const branch = node.branch = { group, toggle, expanded: depth === 0 || rules.some((path) => isPathInsideFolder(path, folder.path)) };
    toggle.addEventListener("click", () => {
      group.hidden = !group.hidden;
      if (!this.filtering) branch.expanded = !group.hidden;
      toggle.setAttribute("aria-expanded", String(!group.hidden));
    });
    for (const child of children) this.renderFolder(group, child, depth + 1);
  }

  private selectSubtree(path: string, checked: boolean): void {
    const outsideBranch = (folder: string) => !isPathInsideFolder(folder, path);
    const draft = this.#folderDraft;
    draft.watchFolders = draft.watchFolders.filter(outsideBranch);
    draft.excludedFolders = draft.excludedFolders.filter(outsideBranch);
    if (checked !== isPathInsideWatchFolders(path, draft)) {
      (checked ? draft.watchFolders : draft.excludedFolders).push(path);
    }
  }

  private renderRow(parent: HTMLElement, path: string, name: string, available: boolean): FolderRow {
    const row = parent.createDiv({ cls: "anythingllm-folder-row" });
    const label = row.createEl("label", { cls: "anythingllm-folder-label", attr: { title: path } });
    const icon = label.createSpan({ cls: "anythingllm-folder-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "folder");
    label.createSpan({ cls: "anythingllm-folder-name", text: name });
    const checkbox = label.createEl("input", { type: "checkbox", attr: { "aria-label": `Sync ${path}` } });
    checkbox.addEventListener("change", () => {
      this.selectSubtree(path, checkbox.checked);
      this.refreshCheckboxes();
    });
    const node = { row, checkbox, available };
    this.rows.set(path, node);
    return node;
  }

  private refreshCheckboxes(): void {
    const mixed = new Set<string>();
    for (const path of [...this.#folderDraft.watchFolders, ...this.#folderDraft.excludedFolders]) {
      for (let parent = parentFolder(path); parent; parent = parentFolder(parent)) mixed.add(parent);
    }
    let selected = 0;
    let availableCount = 0;
    for (const [path, { checkbox, available }] of this.rows) {
      checkbox.disabled = this.saving;
      checkbox.indeterminate = mixed.has(path);
      checkbox.checked = isPathInsideWatchFolders(path, this.#folderDraft);
      if (available) {
        availableCount++;
        if (checkbox.checked) selected++;
      }
    }
    this.countEl.setText(`${selected}/${availableCount} selected`);
  }
}
