const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

class TFile {
  constructor(path) { this.move(path); }
  move(path) {
    this.path = path;
    this.name = path.split("/").pop();
    this.extension = this.name.split(".").pop();
  }
}

class TFolder {
  constructor(path, children = []) {
    this.path = path;
    this.name = path.split("/").pop();
    this.children = children;
  }
}

const obsidian = { TFile, TFolder, normalizePath: (path) => path.replace(/\\/g, "/") };

function load(entry, window = {}) {
  const code = buildSync({
    entryPoints: [entry], bundle: true, platform: "node", format: "cjs",
    external: ["obsidian"], write: false
  }).outputFiles[0].text;
  const context = { module: { exports: {} }, require: () => obsidian, window, console, structuredClone };
  vm.runInNewContext(code, context);
  return context.module.exports;
}

const { SyncService } = load("src/services/sync-service.ts");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const records = new Map();
  const active = new Set();
  const uploads = [];
  const handlers = {};
  const errors = [];
  const timers = new Map();
  let timerId = 0;
  let content = "note content";
  const store = {
    settings: { baseUrl: "http://localhost:3001", workspaceSlug: "wiki", watchFolders: ["Inbox"], autoSync: true, syncDelayMs: 1000 },
    apiKey: "test-key",
    getSyncRecord: (path) => records.get(path),
    setSyncRecord: async (record) => { records.set(record.localPath, record); },
    replaceSyncRecord: async (oldPath, record) => {
      records.delete(oldPath);
      records.set(record.localPath, record);
    },
    deleteSyncRecord: async (path) => { records.delete(path); }
  };
  const client = {
    uploadMarkdown: async (params) => {
      uploads.push(params);
      return { location: `doc-${uploads.length}`, name: params.filename };
    },
    updateWorkspaceEmbeddings: async ({ adds = [], deletes = [] }) => {
      for (const location of deletes) active.delete(location);
      for (const location of adds) active.add(location);
    }
  };
  const folders = new Map();
  const app = { vault: {
    getFolderByPath: (path) => folders.get(path) ?? null,
    read: async () => content,
    on: (event, handler) => { handlers[event] = handler; }
  } };
  const service = new SyncService(app, client, store);
  const renames = [];
  const handleRename = service.handleRename.bind(service);
  service.handleRename = (...args) => {
    const task = handleRename(...args);
    renames.push(task);
    return task;
  };
  const { VaultListener } = load("src/listeners/vault-listener.ts", {
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => { timers.delete(id); }
  });
  const listener = new VaultListener({ app, registerEvent: () => {} }, service, store,
    () => {}, (message, error) => errors.push({ message, error }));
  listener.register();
  return {
    records, active, uploads, handlers, errors, timers, store, client, app, service, listener, renames, folders,
    setContent: (value) => { content = value; }
  };
}

function assertSingleDocument(s, path) {
  assert.deepEqual([...s.records.keys()], [path]);
  assert.deepEqual([...s.active], [s.records.get(path).remoteLocation]);
}

test("rename and simultaneous edit leave one tracked remote document", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  file.move("Inbox/b.md");
  await Promise.all([s.service.handleRename(file, "Inbox/a.md"), s.service.syncFile(file, "auto")]);
  assertSingleDocument(s, file.path);
  assert.equal(s.uploads.length, 2);
});

test("an upload already in progress keeps its original path through a rename", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  const started = deferred();
  const release = deferred();
  const upload = s.client.uploadMarkdown;
  s.client.uploadMarkdown = async (params) => {
    const result = await upload(params);
    if (s.uploads.length === 1) { started.resolve(); await release.promise; }
    return result;
  };
  const initial = s.service.syncFile(file, "auto");
  await started.promise;
  file.move("Inbox/b.md");
  const renamed = s.service.handleRename(file, "Inbox/a.md");
  const edited = s.service.syncFile(file, "manual");
  release.resolve();
  await Promise.all([initial, renamed, edited]);
  assertSingleDocument(s, file.path);
  assert.deepEqual(s.uploads.map((u) => u.filename), ["a.md", "b.md"]);
});

test("rapid consecutive renames preserve the full path chain", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  file.move("Inbox/b.md");
  const first = s.service.handleRename(file, "Inbox/a.md");
  file.move("Inbox/c.md");
  const second = s.service.handleRename(file, "Inbox/b.md");
  await Promise.all([first, second, s.service.syncFile(file, "auto")]);
  assertSingleDocument(s, file.path);
  assert.deepEqual(s.uploads.map((u) => u.filename), ["a.md", "b.md", "c.md"]);
});

test("rename reserves paths before a manual sync or debounced edit can run", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  s.handlers.modify(file);
  file.move("Inbox/b.md");
  s.handlers.rename(file, "Inbox/a.md");
  assert.equal(s.timers.size, 0);
  s.handlers.modify(file);
  for (const callback of s.timers.values()) callback();
  await s.service.syncFile(file, "manual");
  assertSingleDocument(s, file.path);
  assert.equal(s.uploads.length, 2);
  assert.equal(s.errors.length, 0);
});

test("nested folder rename migrates every child record and cancels pending edits", async () => {
  const s = setup();
  const first = new TFile("Inbox/Old/a.md");
  const nested = new TFile("Inbox/Old/Sub/b.md");
  await s.service.syncFile(first, "manual");
  await s.service.syncFile(nested, "manual");
  s.handlers.modify(nested);
  first.move("Inbox/New/a.md");
  nested.move("Inbox/New/Sub/b.md");
  const folder = new TFolder("Inbox/New", [first, new TFolder("Inbox/New/Sub", [nested])]);
  s.handlers.rename(folder, "Inbox/Old");
  await Promise.all([s.service.syncFile(first, "manual"), s.service.syncFile(nested, "manual")]);
  assert.equal(s.timers.size, 0);
  assert.deepEqual([...s.records.keys()].sort(), [first.path, nested.path].sort());
  assert.equal(s.active.size, 2);
  assert.equal(s.errors.length, 0);
});

test("moving a folder out of the watched directory removes all child embeddings", async () => {
  const s = setup();
  const file = new TFile("Inbox/Old/Sub/a.md");
  await s.service.syncFile(file, "manual");
  file.move("Archive/Old/Sub/a.md");
  s.handlers.rename(new TFolder("Archive/Old", [new TFolder("Archive/Old/Sub", [file])]), "Inbox/Old");
  // This deletion waits on the destination path reserved by the folder move.
  await s.service.deleteByPath(file.path);
  assert.equal(s.records.size, 0);
  assert.equal(s.active.size, 0);
});

test("moving a folder into the watched directory syncs nested Markdown only", async () => {
  const s = setup();
  const file = new TFile("Inbox/New/Sub/a.md");
  const image = new TFile("Inbox/New/image.png");
  s.handlers.rename(new TFolder("Inbox/New", [new TFolder("Inbox/New/Sub", [file]), image]), "Archive/Old");
  await Promise.all(s.renames);
  assertSingleDocument(s, file.path);
  assert.equal(s.uploads.length, 1);
});

test("moving an ancestor folder also handles children crossing the watch boundary", async () => {
  const s = setup();
  s.store.settings.watchFolders = ["Parent/Inbox"];
  const file = new TFile("Parent/Inbox/a.md");
  await s.service.syncFile(file, "manual");
  file.move("Renamed/Inbox/a.md");
  s.handlers.rename(new TFolder("Renamed", [new TFolder("Renamed/Inbox", [file])]), "Parent");
  await s.service.deleteByPath(file.path);
  assert.equal(s.records.size, 0);
  assert.equal(s.active.size, 0);
});

test("deleting a note immediately after rename leaves no orphan embedding", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  file.move("Inbox/b.md");
  s.handlers.rename(file, "Inbox/a.md");
  s.handlers.delete(file);
  await s.service.deleteByPath(file.path);
  assert.equal(s.records.size, 0);
  assert.equal(s.active.size, 0);
});

test("renaming a Markdown file to another extension removes its embedding", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  file.move("Inbox/a.txt");
  s.handlers.rename(file, "Inbox/a.md");
  await s.service.deleteByPath(file.path);
  assert.equal(s.records.size, 0);
  assert.equal(s.active.size, 0);
});

test("empty renamed note retains a reachable mapping for later deletion", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  s.setContent("");
  file.move("Inbox/b.md");
  await s.service.handleRename(file, "Inbox/a.md");
  assertSingleDocument(s, file.path);
  await s.service.deleteByPath(file.path);
  assert.equal(s.active.size, 0);
});

test("a failed task does not prevent subsequent syncs on the same path", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  const upload = s.client.uploadMarkdown;
  s.client.uploadMarkdown = async () => { throw new Error("offline"); };
  await assert.rejects(s.service.syncFile(file, "manual"), /offline/);
  s.client.uploadMarkdown = upload;
  await s.service.syncFile(file, "manual");
  assertSingleDocument(s, file.path);
});

test("editing after a failed rename replaces the old embedding instead of duplicating it", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  const upload = s.client.uploadMarkdown;
  s.client.uploadMarkdown = async () => { throw new Error("offline"); };
  file.move("Inbox/b.md");
  await assert.rejects(s.service.handleRename(file, "Inbox/a.md"), /offline/);
  assertSingleDocument(s, file.path);
  assert.equal(s.records.get(file.path).pendingRename, true);
  s.client.uploadMarkdown = upload;
  // Even unchanged content must retry, so the remote filename is updated too.
  await s.service.syncFile(file, "auto");
  assertSingleDocument(s, file.path);
  assert.equal(s.uploads.at(-1).filename, "b.md");
  assert.equal(s.records.get(file.path).pendingRename, undefined);
});

test("deletion cleans up the renamed mapping even if the file is already unreadable", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  file.move("Inbox/b.md");
  s.app.vault.read = async () => { throw new Error("file no longer exists"); };
  s.handlers.rename(file, "Inbox/a.md");
  s.handlers.delete(file);
  await s.service.deleteByPath(file.path);
  assert.equal(s.records.size, 0);
  assert.equal(s.active.size, 0);
  assert.equal(s.errors.length, 1);
});

test("restoring unchanged content after an empty rename updates the remote filename", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  s.setContent("");
  file.move("Inbox/b.md");
  await s.service.handleRename(file, "Inbox/a.md");
  s.setContent("note content");
  await s.service.syncFile(file, "auto");
  assertSingleDocument(s, file.path);
  assert.equal(s.uploads.at(-1).filename, "b.md");
});

test("automatic events watch multiple roots and ignore paths outside them", async () => {
  const s = setup();
  s.store.settings.watchFolders = ["Inbox", "Knowledge"];
  s.handlers.modify(new TFile("Inbox/a.md"));
  s.handlers.create(new TFile("Knowledge/Sub/b.md"));
  s.handlers.modify(new TFile("Knowledge-other/c.md"));
  assert.equal(s.timers.size, 2);
  const ignored = await s.service.syncFile(new TFile("Private/note.md"), "auto");
  assert.equal(ignored.status, "ignored");
});

test("moving between two watched folders replaces rather than deletes the document", async () => {
  const s = setup();
  s.store.settings.watchFolders = ["Inbox", "Knowledge"];
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "auto");
  file.move("Knowledge/a.md");
  s.handlers.rename(new TFolder("Knowledge", [file]), "Inbox");
  await Promise.all(s.renames);
  assertSingleDocument(s, file.path);
});

test("bulk sync includes multiple roots and processes overlapping subfolders once", async () => {
  const s = setup();
  const nested = new TFolder("Inbox/Sub", [new TFile("Inbox/Sub/a.md")]);
  s.folders.set("Inbox", new TFolder("Inbox", [nested, new TFile("Inbox/b.md")]));
  s.folders.set("Inbox/Sub", nested);
  s.folders.set("Knowledge", new TFolder("Knowledge", [new TFile("Knowledge/c.md")]));
  s.store.settings.watchFolders = ["Inbox/Sub", "Knowledge", "Inbox", "Inbox"];
  const result = await s.service.syncWatchedFolder();
  assert.equal(result.synced, 3);
  assert.equal(result.skipped, 0);
  assert.equal(s.uploads.length, 3);
});

test("a missing watched folder reports an error instead of false bulk success", async () => {
  const s = setup();
  await assert.rejects(s.service.syncWatchedFolder(), /Watch folder does not exist: Inbox/);
});

test("removing a configured folder preserves its remote documents and stops tracking events", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "auto");
  s.store.settings.watchFolders = [];
  s.handlers.modify(file);
  s.handlers.delete(file);
  assert.equal(s.timers.size, 0);
  assertSingleDocument(s, file.path);
});

test("renaming an unselected note to another extension preserves its existing remote document", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "auto");
  s.store.settings.watchFolders = ["Knowledge"];
  file.move("Inbox/a.txt");
  s.handlers.rename(file, "Inbox/a.md");
  await Promise.all(s.renames);
  assertSingleDocument(s, "Inbox/a.md");
  assert.equal(s.uploads.length, 1);
});

const { PluginStore } = load("src/store/plugin-store.ts");

function persistedStore(data, fail = false) {
  let saved;
  const store = new PluginStore({
    loadData: async () => data,
    saveData: async (value) => {
      if (fail) throw new Error("disk full");
      saved = structuredClone(value);
    },
    app: { secretStorage: { getSecret: () => "", setSecret: () => {} } }
  });
  return { store, saved: () => saved, fail: (value) => { fail = value; } };
}

test("legacy nested and flat folder settings migrate without retaining watchFolder", async () => {
  for (const raw of [{ settings: { watchFolder: " /Inbox/ " } }, { watchFolder: "Inbox" }]) {
    const s = persistedStore(raw);
    await s.store.load();
    assert.deepEqual(Array.from(s.store.settings.watchFolders), ["Inbox"]);
    assert.equal(s.saved().settings.watchFolder, undefined);
  }
});

test("an explicit empty multi-folder selection overrides a legacy folder", async () => {
  const s = persistedStore({ settings: { watchFolders: [], watchFolder: "Inbox" } });
  await s.store.load();
  assert.equal(s.store.settings.watchFolders.length, 0);
});

test("saving folder choices normalizes overlaps and persists the result", async () => {
  const s = persistedStore(null);
  await s.store.load();
  await s.store.updateSettings({ watchFolders: ["Inbox/Sub", "Inbox", "/Knowledge/", "Inbox"] });
  assert.deepEqual(Array.from(s.store.settings.watchFolders), ["Inbox", "Knowledge"]);
  assert.deepEqual(s.saved().settings.watchFolders, ["Inbox", "Knowledge"]);
});

test("failed settings save restores the previous folders", async () => {
  const s = persistedStore({ settings: { watchFolders: ["Inbox"] } });
  await s.store.load();
  s.fail(true);
  await assert.rejects(s.store.updateSettings({ watchFolders: ["Knowledge"] }), /disk full/);
  assert.deepEqual(Array.from(s.store.settings.watchFolders), ["Inbox"]);
});
