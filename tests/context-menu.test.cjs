const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split("/").pop();
    this.extension = this.name.split(".").pop();
    this.basename = this.name.slice(0, -(this.extension.length + 1));
  }
}
class TFolder { constructor(path) { this.path = path; } }
class Plugin {
  async loadData() { return null; }
  addSettingTab() {}
  addCommand() {}
  registerEvent(event) { this.registered.push(event); }
}
class Notice {
  static all = [];
  constructor(message, duration) {
    this.message = message;
    this.duration = duration;
    this.hidden = false;
    Notice.all.push(this);
  }
  hide() { this.hidden = true; }
}
const code = buildSync({
  entryPoints: ["src/main.ts"], bundle: true, platform: "node", format: "cjs",
  external: ["obsidian"], write: false
}).outputFiles[0].text;
const context = {
  module: { exports: {} }, structuredClone,
  console: { error: () => {} },
  require: () => ({ Plugin, Notice, TFile, TFolder, PluginSettingTab: class {}, Modal: class {} })
};
vm.runInNewContext(code, context);
const SyncPlugin = context.module.exports.default;

async function setup() {
  Notice.all = [];
  const events = {};
  const plugin = new SyncPlugin();
  plugin.registered = [];
  plugin.app = { workspace: {
    on: (name, callback) => { events[name] = callback; return { event: name }; },
    onLayoutReady: () => {}
  } };
  await plugin.onload();
  const itemsFor = (file) => {
    const items = [];
    events["file-menu"]({ addItem: (create) => {
      const item = {
        setTitle(value) { this.title = value; return this; },
        setIcon(value) { this.icon = value; return this; },
        onClick(callback) { this.click = callback; return this; }
      };
      create(item);
      items.push(item);
    } }, file);
    return items;
  };
  return { plugin, itemsFor };
}

test("right-click sync targets the clicked Markdown file rather than the active note", async () => {
  const { plugin, itemsFor } = await setup();
  const target = new TFile("Archive/note.MD");
  let synced;
  plugin.syncService.syncFile = async (file, origin) => {
    synced = { file, origin };
    return { status: "synced", operation: "created" };
  };
  const items = itemsFor(target);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Sync file to AnythingLLM");
  await items[0].click();
  assert.equal(synced.file, target);
  assert.equal(synced.origin, "manual");
  assert.equal(plugin.registered.length, 1);
});

test("right-click folder sync does not require watched folders and reports totals", async () => {
  const { plugin, itemsFor } = await setup();
  const folder = new TFolder("Archive");
  let synced;
  plugin.syncService.syncFolder = async (target) => {
    synced = target;
    return { synced: 3, skipped: 1, failed: 2 };
  };
  const items = itemsFor(folder);
  assert.equal(items[0].title, "Sync folder to AnythingLLM");
  await items[0].click();
  assert.equal(synced, folder);
  assert.equal(plugin.store.settings.watchFolders.length, 0);
  const progress = Notice.all.find((notice) => notice.duration === 0);
  assert.ok(progress.hidden);
  assert.ok(Notice.all.some((notice) => notice.message.includes("3 synced, 1 skipped, 2 failed")));
});

test("unsupported files have no sync menu item", async () => {
  const { itemsFor } = await setup();
  assert.equal(itemsFor(new TFile("Archive/image.png")).length, 0);
});

test("folder sync errors close the progress notice and display the failure", async () => {
  const { plugin, itemsFor } = await setup();
  plugin.syncService.syncFolder = async () => { throw new Error("workspace not selected"); };
  await itemsFor(new TFolder("Archive"))[0].click();
  assert.ok(Notice.all.find((notice) => notice.duration === 0).hidden);
  assert.ok(Notice.all.some((notice) => notice.message.includes("workspace not selected")));
});
