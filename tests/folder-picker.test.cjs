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
const context = { module: { exports: {} }, require: () => ({ Modal, ButtonComponent, TFolder, setIcon: () => {}, normalizePath: (p) => p }) };
vm.runInNewContext(code, context);
const { FolderPickerModal } = context.module.exports;

function setup(selected = [], save, excludedFolders = []) {
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
  return { modal, saved, folders, checkbox, button, check };
}

test("folder tree lists nested folders, not notes, and saves only on confirm", async () => {
  const s = setup();
  assert.ok(s.checkbox("Inbox/Sub"));
  assert.equal(s.checkbox("Inbox/a.md"), undefined);
  s.check("Inbox/Sub", true);
  s.check("Knowledge", true);
  assert.equal(s.saved.length, 0);
  await s.button("Confirm").listeners.click();
  assert.deepEqual(s.saved, [{ watchFolders: ["Inbox/Sub", "Knowledge"], excludedFolders: [] }]);
  assert.ok(s.modal.closed);
});

test("cancel discards draft folder choices", () => {
  const original = ["Inbox"];
  const s = setup(original);
  s.button("Select all").listeners.click();
  s.check("Inbox/Sub", false);
  s.button("Cancel").listeners.click();
  assert.deepEqual(original, ["Inbox"]);
  assert.equal(s.saved.length, 0);
  assert.ok(s.modal.closed);
});

test("selected parents include descendants and allow changing them", async () => {
  const s = setup(["Inbox/Sub"]);
  s.check("Inbox", true);
  assert.ok(s.checkbox("Inbox/Sub").checked);
  assert.ok(!s.checkbox("Inbox/Sub").disabled);
  await s.button("Confirm").listeners.click();
  assert.deepEqual(s.saved, [{ watchFolders: ["Inbox"], excludedFolders: [] }]);
});

test("select all followed by exclusions keeps the parent selected on reopen", async () => {
  const s = setup();
  s.button("Select all").listeners.click();
  for (const path of s.folders.keys()) {
    assert.equal(s.checkbox(path).checked, true);
    assert.equal(s.checkbox(path).disabled, false);
  }
  s.check("Knowledge", false);
  s.check("Inbox/Sub", false);
  assert.equal(s.checkbox("Inbox").indeterminate, true);
  assert.equal(s.checkbox("Inbox/Sub/Deep").checked, false);
  await s.button("Confirm").listeners.click();
  assert.deepEqual(s.saved, [{ watchFolders: ["Inbox"], excludedFolders: ["Inbox/Sub"] }]);

  const restored = setup(s.saved[0].watchFolders, undefined, s.saved[0].excludedFolders);
  assert.equal(restored.checkbox("Inbox").indeterminate, true);
  assert.equal(restored.checkbox("Inbox/Sub").checked, false);
  restored.check("Inbox/Sub/Deep", true);
  assert.equal(restored.checkbox("Inbox/Sub").indeterminate, true);
  restored.button("Select all").listeners.click();
  assert.equal(restored.checkbox("Inbox").indeterminate, false);
  await restored.button("Confirm").listeners.click();
  assert.deepEqual(restored.saved, [{ watchFolders: ["Inbox", "Knowledge"], excludedFolders: [] }]);
});

test("expanding a branch preserves the selection and the summary counts nested folders", () => {
  const s = setup(["Inbox"], undefined, ["Inbox/Sub"]);
  const nodes = s.modal.contentEl.all();
  const toggle = nodes.find((el) => el.attrs["aria-label"] === "Subfolders of Inbox");
  const count = nodes.find((el) => el.classes.has("anythingllm-folder-count"));
  assert.equal(count.text, "1 of 4 folders selected");
  assert.equal(toggle.attrs["aria-expanded"], "true");
  toggle.listeners.click();
  assert.equal(toggle.attrs["aria-expanded"], "false");
  assert.equal(count.text, "1 of 4 folders selected");
  s.button("Select all").listeners.click();
  assert.equal(count.text, "4 of 4 folders selected");
  assert.equal(toggle.attrs["aria-expanded"], "false");
});

test("clearing every checkbox confirms an empty selection", async () => {
  const s = setup(["Inbox"]);
  s.check("Inbox", false);
  assert.ok(!s.checkbox("Inbox/Sub").checked);
  assert.ok(!s.checkbox("Inbox/Sub").disabled);
  await s.button("Confirm").listeners.click();
  assert.deepEqual(s.saved, [{ watchFolders: [], excludedFolders: [] }]);
});

test("save failure stays in the modal with feedback and allows a retry", async () => {
  let attempts = 0;
  const s = setup(["Inbox"], async () => { if (++attempts === 1) throw new Error("disk full"); });
  await s.button("Confirm").listeners.click();
  assert.ok(!s.modal.closed);
  const status = s.modal.contentEl.all().find((el) => el.attrs.role === "status");
  assert.match(status.text, /disk full/);
  assert.ok(!s.button("Confirm").disabled);
  await s.button("Confirm").listeners.click();
  assert.ok(s.modal.closed);
});

test("missing folders are visible and must be unchecked before saving", async () => {
  const s = setup(["Missing"]);
  assert.ok(s.checkbox("Missing").checked);
  await s.button("Confirm").listeners.click();
  assert.equal(s.saved.length, 0);
  assert.ok(!s.modal.closed);
  s.check("Missing", false);
  await s.button("Confirm").listeners.click();
  assert.deepEqual(s.saved, [{ watchFolders: [], excludedFolders: [] }]);
});

test("closing is blocked while folder settings are being saved", async () => {
  let finish;
  const s = setup(["Inbox"], () => new Promise((resolve) => { finish = resolve; }));
  const pending = s.button("Confirm").listeners.click();
  s.modal.close();
  assert.ok(!s.modal.closed);
  assert.ok(s.checkbox("Inbox").disabled);
  finish();
  await pending;
  assert.ok(s.modal.closed);
});
