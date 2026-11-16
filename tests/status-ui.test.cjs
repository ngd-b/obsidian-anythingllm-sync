const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

class Element {
  constructor(tag, options = {}) {
    this.nodeType = 1;
    this.tag = tag;
    this.attrs = { ...options.attr };
    this.classes = new Set((options.cls || "").split(" "));
    this.textContent = options.text || "";
    this.children = [];
    this.events = {};
  }
  createEl(tag, options) {
    const child = new Element(tag, options);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  createDiv(options) { return this.createEl("div", options); }
  setText(value) { this.textContent = value; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addClass(value) { this.classes.add(value); }
  removeClass(value) { this.classes.delete(value); }
  addEventListener(event, callback) { this.events[event] = callback; }
  empty() { this.children = []; }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
  matches(selector) {
    if (selector === ".nav-file-title[data-path]") return this.classes.has("nav-file-title") && "data-path" in this.attrs;
    return this.classes.has(selector.slice(1));
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll(selector) { return this.all().filter((child) => child.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
class Modal {
  static last;
  constructor(app) { this.app = app; this.contentEl = new Element("div"); Modal.last = this; }
  setTitle(title) { this.title = title; }
  open() { this.onOpen(); }
  close() { this.closed = true; this.onClose(); }
}
class ButtonComponent {
  constructor(parent) { this.el = parent.createEl("button"); }
  setButtonText(text) { this.el.setText(text); return this; }
  setDisabled(value) { this.el.disabled = value; return this; }
  setCta() { return this; }
  onClick(callback) { this.el.addEventListener("click", callback); return this; }
}
class TFile {
  constructor(path) { this.path = path; this.name = path.split("/").pop(); this.extension = this.name.split(".").pop(); }
}
class MutationObserver {
  static all = [];
  constructor(callback) { this.callback = callback; MutationObserver.all.push(this); }
  observe(root) { this.root = root; }
  disconnect() { this.disconnected = true; }
}
const timers = new Map();
let nextTimer = 0;
const code = buildSync({ entryPoints: ["src/ui/file-status-decorations.ts"], bundle: true,
  platform: "node", format: "cjs", external: ["obsidian"], write: false }).outputFiles[0].text;
const context = {
  module: { exports: {} }, console, MutationObserver,
  window: { setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: (id) => timers.delete(id) },
  require: () => ({ TFile, Modal, ButtonComponent })
};
vm.runInNewContext(code, context);
const { FileStatusDecorations } = context.module.exports;
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function flush() {
  const callbacks = [...timers.values()];
  timers.clear();
  for (const callback of callbacks) callback();
  await settle();
}

function setup() {
  timers.clear();
  MutationObserver.all = [];
  const root = new Element("div");
  const roots = [root];
  const row = root.createDiv({ cls: "nav-file-title", attr: { "data-path": "Inbox/a.md" } });
  root.createDiv({ cls: "nav-file-title", attr: { "data-path": "Inbox/image.png" } });
  const file = new TFile("Inbox/a.md");
  const image = new TFile("Inbox/image.png");
  const serviceListeners = new Set();
  const storeListeners = new Set();
  const handlers = {};
  let state = "unsynced";
  let checks = 0;
  let invalidations = 0;
  const service = {
    subscribe: (callback) => { serviceListeners.add(callback); return () => serviceListeners.delete(callback); },
    getFileStatus: async () => ({ state, message: `status: ${state}` }),
    invalidateFileStatus: () => { invalidations++; },
    checkFiles: async () => { checks++; },
    syncFile: async () => { state = "synced"; return { status: "synced" }; }
  };
  const store = { subscribe: (callback) => { storeListeners.add(callback); return () => storeListeners.delete(callback); }, getSyncRecord: () => undefined };
  const plugin = { registerEvent: () => {}, app: {
    workspace: { getLeavesOfType: () => roots.map((containerEl) => ({ view: { containerEl } })), on: (event, callback) => { handlers[event] = callback; } },
    vault: { getAbstractFileByPath: (path) => path === file.path ? file : image, on: (event, callback) => { handlers[event] = callback; } }
  } };
  const decorations = new FileStatusDecorations(plugin, service, store);
  decorations.register();
  return {
    root, roots, row, file, service, decorations, handlers, serviceListeners, storeListeners,
    setState: (value) => { state = value; for (const callback of serviceListeners) callback(); },
    checks: () => checks, invalidations: () => invalidations
  };
}

test("explorer decorates Markdown rows and updates their badge without duplicates", async () => {
  const s = setup();
  await flush();
  assert.equal(s.root.querySelectorAll(".anythingllm-sync-badge").length, 1);
  const badge = s.row.querySelector(".anythingllm-sync-badge");
  assert.equal(badge.textContent, "Not synced");
  s.setState("synced");
  await flush();
  assert.equal(badge.textContent, "Synced");
  assert.equal(badge.getAttribute("data-sync-state"), "synced");
  assert.equal(s.row.querySelectorAll(".anythingllm-sync-badge").length, 1);
  s.decorations.dispose();
});

test("badge DOM mutations do not cause a refresh loop", async () => {
  const s = setup();
  await flush();
  const badge = s.row.querySelector(".anythingllm-sync-badge");
  const observer = MutationObserver.all[0];
  observer.callback([{ target: s.row, type: "childList", addedNodes: [badge], removedNodes: [] }]);
  observer.callback([{ target: badge, type: "childList", addedNodes: [{ nodeType: 3 }], removedNodes: [] }]);
  assert.equal(timers.size, 0);
  observer.callback([{ target: s.row, type: "attributes" }]);
  assert.equal(timers.size, 1);
  s.decorations.dispose();
});

test("file changes invalidate local status and unloading removes observers, badges and subscriptions", async () => {
  const s = setup();
  await flush();
  s.handlers.modify(s.file);
  assert.equal(s.invalidations(), 1);
  s.decorations.dispose();
  assert.equal(timers.size, 0);
  assert.equal(s.root.querySelectorAll(".anythingllm-sync-badge").length, 0);
  assert.equal(s.serviceListeners.size, 0);
  assert.equal(s.storeListeners.size, 0);
  assert.ok(MutationObserver.all[0].disconnected);
});

test("clicking a badge opens an inline-status dialog with check and resync actions", async () => {
  const s = setup();
  await flush();
  let stopped = false;
  s.row.querySelector(".anythingllm-sync-badge").events.click({ stopPropagation: () => { stopped = true; } });
  await settle();
  assert.ok(stopped);
  const modal = Modal.last;
  assert.equal(s.checks(), 1);
  const sync = modal.contentEl.all().find((el) => el.textContent === "Sync now");
  await sync.events.click();
  const status = modal.contentEl.all().find((el) => el.attrs.role === "status");
  assert.match(status.textContent, /Synced/);
  modal.close();
  assert.equal(modal.contentEl.children.length, 0);
  s.decorations.dispose();
});

test("status dialog keeps failures inside the dialog and permits retry", async () => {
  const s = setup();
  await flush();
  s.service.checkFiles = async () => { throw new Error("offline"); };
  s.row.querySelector(".anythingllm-sync-badge").events.click({ stopPropagation() {} });
  await settle();
  const modal = Modal.last;
  const status = modal.contentEl.all().find((el) => el.attrs.role === "status");
  assert.match(status.textContent, /offline/);
  assert.ok(!modal.closed);
  const retry = modal.contentEl.all().find((el) => el.textContent === "Check remote");
  assert.ok(!retry.disabled);
  s.service.checkFiles = async () => {};
  await retry.events.click();
  assert.match(status.textContent, /Not synced/);
  modal.close();
  s.decorations.dispose();
});

test("closing a dialog while checking does not write into the closed dialog", async () => {
  const s = setup();
  await flush();
  let finish;
  s.service.checkFiles = () => new Promise((resolve) => { finish = resolve; });
  s.row.querySelector(".anythingllm-sync-badge").events.click({ stopPropagation() {} });
  Modal.last.close();
  finish();
  await settle();
  assert.equal(Modal.last.contentEl.children.length, 0);
  s.decorations.dispose();
});

test("an old asynchronous status read cannot overwrite a newer badge", async () => {
  const s = setup();
  let finish;
  let reads = 0;
  s.service.getFileStatus = async () => {
    if (++reads === 1) return new Promise((resolve) => { finish = resolve; });
    return { state: "synced", message: "current" };
  };
  await flush();
  s.setState("synced");
  await flush();
  finish({ state: "unsynced", message: "stale" });
  await settle();
  assert.equal(s.row.querySelector(".anythingllm-sync-badge").textContent, "Synced");
  s.decorations.dispose();
});

test("unloading during a refresh cannot attach observers to another explorer", async () => {
  const s = setup();
  s.roots.push(new Element("div"));
  let finish;
  s.service.getFileStatus = () => new Promise((resolve) => { finish = resolve; });
  await flush();
  s.decorations.dispose();
  finish({ state: "synced", message: "completed after unload" });
  await settle();
  assert.equal(MutationObserver.all.length, 1);
  assert.ok(MutationObserver.all[0].disconnected);
});

test("closing an explorer cleans its badges before dropping its observer", async () => {
  const s = setup();
  await flush();
  s.roots.length = 0;
  s.handlers["layout-change"]();
  await flush();
  assert.equal(s.root.querySelectorAll(".anythingllm-sync-badge").length, 0);
  assert.ok(MutationObserver.all[0].disconnected);
  s.decorations.dispose();
});
