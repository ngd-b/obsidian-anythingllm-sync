const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

// Exercise the modal lifecycle and controls without requiring a running Obsidian.
class Element {
  constructor(tag, options = {}) {
    this.tag = tag;
    this.children = [];
    this.attrs = { ...options.attr };
    this.text = options.text || "";
    this.type = options.type;
    this.value = "";
    this.listeners = {};
    this.classes = new Set((options.cls || "").split(" "));
  }
  createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  setText(text) { this.text = text; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addClass(value) { this.classes.add(value); }
  removeClass(value) { this.classes.delete(value); }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  focus() { this.focused = true; }
  prepend(child) { this.children = [child, ...this.children.filter((el) => el !== child)]; }
  empty() { this.children = []; }
  all() { return [this, ...this.children.flatMap((child) => child.all())]; }
}

class Modal {
  constructor(app) { this.app = app; this.modalEl = new Element("div"); this.contentEl = this.modalEl.createDiv(); this.closed = false; }
  setTitle(title) { this.title = title; }
  open() {
    // Obsidian's Modal.open saves the editor selection before invoking plugin code.
    this.selection = null;
    this.onOpen();
  }
  close() { this.closed = true; this.onClose(); }
}

class ButtonComponent {
  constructor(parent) { this.button = parent.createEl("button"); }
  setButtonText(text) { this.button.text = text; return this; }
  setCta() { return this; }
  setDisabled(value) { this.button.disabled = value; return this; }
  onClick(callback) { this.button.addEventListener("click", callback); return this; }
}

class TFolder {
  constructor(path, children = []) { this.path = path; this.name = path.split("/").pop(); this.children = children; }
}

const code = buildSync({
  entryPoints: ["src/settings/folder-picker-modal.ts"], bundle: true,
  platform: "node", format: "cjs", external: ["obsidian"], write: false
}).outputFiles[0].text;
function setup(selected = [], save, excludedFolders = []) {
  const context = { module: { exports: {} }, require: () => ({ Modal, ButtonComponent, TFolder, setIcon() {}, normalizePath: (p) => p }) };
  vm.runInNewContext(code, context);
  const { FolderPickerModal } = context.module.exports;
  const deep = new TFolder("Inbox/Sub/Deep");
  const sub = new TFolder("Inbox/Sub", [deep]);
  const inbox = new TFolder("Inbox", [sub, { path: "Inbox/a.md", name: "a.md" }]);
  const knowledge = new TFolder("Knowledge");
  const folders = new Map([inbox, sub, deep, knowledge].map((folder) => [folder.path, folder]));
  const saved = [];
  const modal = new FolderPickerModal({ vault: {
    getRoot: () => new TFolder("/", [inbox, knowledge]),
    getName: () => "Test vault",
    getFolderByPath: (path) => folders.get(path) ?? null
  } }, { watchFolders: selected, excludedFolders }, save || (async (values) => { saved.push(structuredClone(values)); }));
  modal.open();
  const checkbox = (path) => modal.contentEl.all().find((el) => el.attrs["aria-label"] === `Sync ${path}`);
  const button = (text) => modal.contentEl.all().find((el) => el.tag === "button" && el.text === text);
  const check = (path, value) => {
    const input = checkbox(path);
    assert.ok(input);
    assert.ok(!input.disabled);
    input.checked = value;
    input.listeners.change();
  };
  const search = (value) => {
    const input = modal.contentEl.all().find((el) => el.type === "search");
    input.value = value;
    input.listeners.input();
  };
  const row = (path) => modal.contentEl.all().find((el) => el.classes.has("anythingllm-folder-row") && el.all().includes(checkbox(path)));
  const status = modal.contentEl.all().find((el) => el.attrs.role === "status");
  return { modal, saved, checkbox, button, check, row, search, status };
}

test("toolbar shows the draft count and changes are saved only on Confirm", async () => {
  const s = setup();
  const toolbar = s.modal.contentEl.all().find((el) => el.classes.has("anythingllm-folder-toolbar"));
  const [searchBox, count, selectAll] = toolbar.children;
  assert.equal(toolbar.children.length, 3);
  assert.equal(searchBox.children[0].type, "search");
  assert.equal(count.text, "0/4 selected");
  assert.equal(selectAll, s.button("Select all"));
  s.button("Select all").listeners.click();
  s.check("Inbox/Sub", false);
  s.check("Knowledge", false);
  assert.equal(count.text, "1/4 selected");
  assert.equal(s.saved.length, 0);
  assert.ok(s.checkbox("Inbox").indeterminate);
  assert.equal(s.checkbox("Inbox/Sub/Deep").checked, false);
  await s.button("Confirm").listeners.click();
  assert.deepEqual(s.saved, [{ watchFolders: ["Inbox"], excludedFolders: ["Inbox/Sub"] }]);
  assert.ok(s.modal.closed);
});

test("search reveals matching paths and ancestors, restores expansion and never saves", async () => {
  const s = setup(["Knowledge"]);
  const toggle = s.modal.contentEl.all().find((el) => el.attrs["aria-label"] === "Subfolders of Inbox");
  toggle.listeners.click();
  assert.equal(toggle.attrs["aria-expanded"], "false");
  s.search("  SUb/DEep ");
  assert.equal(toggle.attrs["aria-expanded"], "true");
  for (const path of ["Inbox", "Inbox/Sub", "Inbox/Sub/Deep"]) assert.equal(s.row(path).hidden, false);
  assert.equal(s.row("Knowledge").hidden, true);
  s.search("absent");
  assert.ok(s.button("Select matches").disabled);
  assert.ok(s.modal.contentEl.all().some((el) => el.text === "No matching folders." && !el.hidden));
  const clear = s.modal.contentEl.all().find((el) => el.attrs["aria-label"] === "Clear filter");
  clear.listeners.click();
  const input = s.modal.contentEl.all().find((el) => el.type === "search");
  assert.equal(input.value, "");
  assert.ok(input.focused);
  assert.equal(s.row("Knowledge").hidden, false);
  assert.equal(toggle.attrs["aria-expanded"], "false");
  assert.equal(s.checkbox("Knowledge").checked, true);
  assert.equal(s.saved.length, 0);
});

test("select matches keeps unrelated selections and selects only matching subtrees", async () => {
  const s = setup(["Knowledge"]);
  s.search("sub");
  s.button("Select matches").listeners.click();
  s.search("");
  assert.equal(s.checkbox("Inbox").checked, false);
  assert.ok(s.checkbox("Inbox").indeterminate);
  assert.ok(s.checkbox("Inbox/Sub/Deep").checked);
  assert.equal(s.saved.length, 0);
  await s.button("Confirm").listeners.click();
  assert.deepEqual(s.saved, [{ watchFolders: ["Inbox/Sub", "Knowledge"], excludedFolders: [] }]);
});

test("repeated Confirm and close during a save commit exactly once", async () => {
  const snapshots = [];
  let finish;
  const s = setup([], async (snapshot) => {
    snapshots.push(snapshot);
    await new Promise((resolve) => { finish = resolve; });
  });
  s.check("Inbox", true);
  const pending = s.button("Confirm").listeners.click();
  assert.ok(s.checkbox("Inbox").disabled);
  await s.button("Confirm").listeners.click();
  s.modal.close();
  assert.equal(s.modal.closed, false);
  finish();
  await pending;
  assert.deepEqual(structuredClone(snapshots), [{ watchFolders: ["Inbox"], excludedFolders: [] }]);
  assert.ok(s.modal.closed);
});

test("closing discards changes from search, select all and individual checkboxes", () => {
  const original = ["Knowledge"];
  const s = setup(original);
  s.button("Select all").listeners.click();
  s.search("sub");
  s.check("Inbox/Sub", false);
  s.modal.close();
  assert.equal(s.saved.length, 0);
  assert.deepEqual(original, ["Knowledge"]);
  assert.ok(s.modal.closed);
});

test("Confirm can save an empty selection", async () => {
  const s = setup(["Inbox"]);
  s.check("Inbox", false);
  await s.button("Confirm").listeners.click();
  assert.deepEqual(s.saved, [{ watchFolders: [], excludedFolders: [] }]);
});

test("a failed Confirm keeps the draft and error in the modal for retry", async () => {
  let attempts = 0;
  const s = setup([], async () => { if (++attempts === 1) throw new Error("disk full"); });
  s.check("Inbox/Sub", true);
  await s.button("Confirm").listeners.click();
  assert.equal(s.modal.closed, false);
  assert.match(s.status.text, /disk full/);
  assert.ok(s.checkbox("Inbox/Sub").checked);
  await s.button("Confirm").listeners.click();
  assert.equal(s.modal.closed, true);
  assert.equal(attempts, 2);
});

test("unavailable folders can be found and removed after a validation failure", async () => {
  const s = setup(["Missing"]);
  s.check("Knowledge", true);
  await s.button("Confirm").listeners.click();
  assert.match(s.status.text, /Missing/);
  assert.equal(s.saved.length, 0);
  s.search("miss");
  s.check("Missing", false);
  await s.button("Confirm").listeners.click();
  assert.deepEqual(s.saved, [{ watchFolders: ["Knowledge"], excludedFolders: [] }]);
});
