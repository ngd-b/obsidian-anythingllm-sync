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
    this.stat = { mtime: 1, size: 12 };
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
    settings: { baseUrl: "http://localhost:3001", workspaceSlug: "wiki", watchFolders: ["Inbox"], excludedFolders: [], autoSync: true, syncDelayMs: 1000 },
    apiKey: "test-key",
    getSyncRecord: (path) => records.get(path),
    getAllSyncRecords: () => [...records.values()],
    setSyncRecord: async (record) => { records.set(record.localPath, record); },
    replaceSyncRecord: async (oldPath, record) => {
      records.delete(oldPath);
      records.set(record.localPath, record);
    },
    deleteSyncRecord: async (path) => { records.delete(path); }
  };
  const client = {
    listWorkspaceDocuments: async () => new Set(active),
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
    getAbstractFileByPath: (path) => [...folders.values()].flatMap((folder) => folder.children).find((file) => file.path === path) ?? null,
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

test("watched sync respects nested exclusions, re-inclusions and folder boundaries", async () => {
  const s = setup();
  const excluded = new TFile("Inbox/Drafts/private.md");
  const kept = new TFile("Inbox/Drafts/Shared/public.md");
  const sibling = new TFile("Inbox/Drafts-old/sibling.md");
  const direct = new TFile("Inbox/direct.md");
  const shared = new TFolder("Inbox/Drafts/Shared", [kept]);
  const drafts = new TFolder("Inbox/Drafts", [excluded, shared]);
  s.folders.set("Inbox", new TFolder("Inbox", [direct, drafts, new TFolder("Inbox/Drafts-old", [sibling])]));
  s.folders.set(shared.path, shared);
  s.store.settings.watchFolders = ["Inbox", shared.path];
  s.store.settings.excludedFolders = [drafts.path];

  assert.equal((await s.service.syncWatchedFolder()).synced, 3);
  assert.deepEqual([...s.records.keys()].sort(), [direct.path, kept.path, sibling.path].sort());
  s.handlers.create(excluded);
  s.handlers.modify(excluded);
  assert.equal(s.timers.size, 0);
  assert.equal((await s.service.syncFile(excluded, "auto")).status, "ignored");
  await s.service.syncFile(excluded, "manual");
  s.handlers.delete(excluded);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(s.records.has(excluded.path));

  direct.move("Inbox/Drafts/direct.md");
  assert.equal((await s.service.handleRename(direct, "Inbox/direct.md")).status, "deleted");
  kept.move("Inbox/Drafts/Shared/new.md");
  assert.equal((await s.service.handleRename(kept, "Inbox/Drafts/Shared/public.md")).status, "synced");
});

test("excluding a subtree during a watched batch skips both the current read and queued files", async () => {
  const s = setup();
  const drafts = new TFolder("Inbox/Drafts", [
    new TFile("Inbox/Drafts/a.md"), new TFile("Inbox/Drafts/b.md")
  ]);
  s.folders.set("Inbox", new TFolder("Inbox", [drafts, new TFile("Inbox/keep.md")]));
  const read = s.app.vault.read;
  s.app.vault.read = async (file) => {
    if (file.name === "a.md") s.store.settings.excludedFolders = [drafts.path];
    return read(file);
  };
  const result = await s.service.syncWatchedFolder();
  assert.equal(result.skipped, 2);
  assertSingleDocument(s, "Inbox/keep.md");
  assert.equal((await s.service.syncFolder(drafts)).synced, 2);
});

test("a missing watched folder reports an error instead of false bulk success", async () => {
  const s = setup();
  await assert.rejects(s.service.syncWatchedFolder(), /Watch folder does not exist: Inbox/);
});

test("one-time folder sync recursively includes Markdown outside the watch scope", async () => {
  const s = setup();
  s.store.settings.watchFolders = [];
  s.store.settings.autoSync = false;
  const folder = new TFolder("Archive", [
    new TFile("Archive/a.md"),
    new TFile("Archive/image.png"),
    new TFolder("Archive/Sub", [new TFile("Archive/Sub/b.MD")])
  ]);
  const result = await s.service.syncFolder(folder);
  assert.equal(result.synced, 2);
  assert.equal(result.failed, 0);
  assert.equal(s.uploads.length, 2);
  assert.equal(s.store.settings.watchFolders.length, 0);
  assert.equal(s.store.settings.autoSync, false);
  assert.deepEqual([...s.records.keys()].sort(), ["Archive/Sub/b.MD", "Archive/a.md"]);
  const repeated = await s.service.syncFolder(folder);
  assert.equal(repeated.synced, 0);
  assert.equal(repeated.skipped, 2);
  assert.equal(s.active.size, 2);
});

test("one-time folder sync skips empty notes and continues after a file fails", async () => {
  const s = setup();
  s.app.vault.read = async (file) => {
    if (file.name === "bad.md") throw new Error("unreadable file");
    return file.name === "empty.md" ? "" : "note content";
  };
  const folder = new TFolder("Archive", [
    new TFile("Archive/bad.md"), new TFile("Archive/empty.md"), new TFile("Archive/good.md")
  ]);
  const result = await s.service.syncFolder(folder);
  assert.equal(result.synced, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 1);
  assertSingleDocument(s, "Archive/good.md");
});

test("one-time sync of a folder without Markdown completes without uploads", async () => {
  const s = setup();
  const result = await s.service.syncFolder(new TFolder("Archive", [new TFile("Archive/image.png")]));
  assert.equal(result.synced, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);
  assert.equal(s.uploads.length, 0);
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

test("saved exclusions and nested inclusions survive a reload", async () => {
  const s = persistedStore({ settings: { watchFolders: ["Inbox"] } });
  await s.store.load();
  assert.deepEqual(Array.from(s.store.settings.excludedFolders), []);
  await s.store.updateSettings({
    watchFolders: ["Inbox", "Inbox/Sub/Deep", "Inbox/Other"],
    excludedFolders: ["Inbox/Sub", "Inbox/Sub/Private", "Unused"]
  });
  const restored = persistedStore(s.saved());
  await restored.store.load();
  assert.deepEqual(Array.from(restored.store.settings.watchFolders), ["Inbox", "Inbox/Sub/Deep"]);
  assert.deepEqual(Array.from(restored.store.settings.excludedFolders), ["Inbox/Sub"]);
});

test("failed settings save restores the previous folders", async () => {
  const s = persistedStore({ settings: { watchFolders: ["Inbox"] } });
  await s.store.load();
  s.fail(true);
  await assert.rejects(s.store.updateSettings({ watchFolders: ["Knowledge"] }), /disk full/);
  assert.deepEqual(Array.from(s.store.settings.watchFolders), ["Inbox"]);
});

test("file status distinguishes unsynced, matching content and local edits", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  assert.equal((await s.service.getFileStatus(file)).state, "unsynced");
  await s.service.syncFile(file, "manual");
  assert.equal((await s.service.getFileStatus(file)).state, "synced");
  s.setContent("edited content");
  s.service.invalidateFileStatus(file);
  assert.equal((await s.service.getFileStatus(file)).state, "modified");
  await s.service.syncFile(file, "manual");
  assert.equal((await s.service.getFileStatus(file)).state, "synced");
});

test("status hashing is cached and invalidated by file events", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  const read = s.app.vault.read;
  let reads = 0;
  s.app.vault.read = async (file) => { reads++; return read(file); };
  await s.service.getFileStatus(file);
  await s.service.getFileStatus(file);
  assert.equal(reads, 1);
  s.service.invalidateFileStatus(file);
  await s.service.getFileStatus(file);
  assert.equal(reads, 2);
});

test("a late hash read cannot repopulate an invalidated cache with old content", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  let finish;
  let reads = 0;
  s.app.vault.read = async () => {
    if (++reads === 1) return new Promise((resolve) => { finish = resolve; });
    return "edited content";
  };
  const oldRead = s.service.getFileStatus(file);
  // Some filesystem events preserve size and timestamp; event invalidation must
  // still defeat a read that started before the event.
  s.service.invalidateFileStatus(file);
  finish("note content");
  await oldRead;
  assert.equal((await s.service.getFileStatus(file)).state, "modified");
  assert.equal(reads, 2);
});

test("upload progress and failures appear in the file status", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  const started = deferred();
  const gate = deferred();
  s.client.uploadMarkdown = async () => { started.resolve(); await gate.promise; throw new Error("upload failed"); };
  const task = s.service.syncFile(file, "manual");
  await started.promise;
  assert.equal((await s.service.getFileStatus(file)).state, "syncing");
  s.service.invalidateFileStatus(file);
  assert.equal((await s.service.getFileStatus(file)).state, "syncing");
  gate.resolve();
  await assert.rejects(task, /upload failed/);
  assert.equal((await s.service.getFileStatus(file)).state, "error");
});

test("remote check finds removed documents and unchanged sync restores them", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  s.active.clear();
  const result = await s.service.checkFiles([file]);
  assert.equal(result.missing, 1);
  assert.equal(s.records.get(file.path).remoteMissing, true);
  assert.ok(s.records.get(file.path).lastCheckedAt);
  assert.equal((await s.service.getFileStatus(file)).state, "missing");
  await s.service.syncFile(file, "manual");
  assertSingleDocument(s, file.path);
  assert.equal(s.uploads.length, 2);
  assert.equal((await s.service.getFileStatus(file)).state, "synced");
});

test("batch remote checks query each workspace once and skip untracked files", async () => {
  const s = setup();
  const files = [new TFile("Inbox/a.md"), new TFile("Inbox/b.md")];
  for (const file of files) await s.service.syncFile(file, "manual");
  let queries = 0;
  s.client.listWorkspaceDocuments = async () => { queries++; return new Set(s.active); };
  const result = await s.service.checkFiles([...files, files[0], new TFile("Inbox/new.md")]);
  assert.equal(queries, 1);
  assert.equal(result.present, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
});

test("failed remote checks never mark a document as removed", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  s.client.listWorkspaceDocuments = async () => { throw new Error("offline"); };
  const result = await s.service.checkFiles([file]);
  assert.equal(result.failed, 1);
  assert.equal(result.missing, 0);
  assert.equal(s.records.get(file.path).remoteMissing, undefined);
  assert.equal(s.records.get(file.path).lastCheckedAt, undefined);
  assert.equal((await s.service.getFileStatus(file)).state, "error");
  assertSingleDocument(s, file.path);
});

test("a check queued behind an upload cannot mark the new upload missing", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  s.setContent("changed");
  const started = deferred();
  const gate = deferred();
  const upload = s.client.uploadMarkdown;
  s.client.uploadMarkdown = async (params) => { started.resolve(); await gate.promise; return upload(params); };
  const sync = s.service.syncFile(file, "manual");
  await started.promise;
  const check = s.service.checkFiles([file]);
  gate.resolve();
  await sync;
  const result = await check;
  assert.equal(result.skipped, 1);
  assert.equal(result.missing, 0);
  assertSingleDocument(s, file.path);
});

test("connection changes during a check discard its remote result", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  const started = deferred();
  const gate = deferred();
  s.client.listWorkspaceDocuments = async () => { started.resolve(); await gate.promise; return new Set(); };
  const check = s.service.checkFiles([file]);
  await started.promise;
  s.store.settings.baseUrl = "http://different-server:3001";
  gate.resolve();
  const result = await check;
  assert.equal(result.failed, 1);
  assert.equal(s.records.get(file.path).remoteMissing, undefined);
});

test("remote presence does not hide pending local changes or a workspace switch", async () => {
  const s = setup();
  const file = new TFile("Inbox/a.md");
  await s.service.syncFile(file, "manual");
  s.setContent("new local content");
  const check = await s.service.checkFiles([file]);
  assert.equal(check.present, 1);
  assert.equal((await s.service.getFileStatus(file)).state, "modified");
  s.store.settings.workspaceSlug = "other";
  assert.equal((await s.service.getFileStatus(file)).state, "modified");
});

test("remote check metadata survives reloading the plugin store", async () => {
  const s = persistedStore(null);
  await s.store.load();
  await s.store.setSyncRecord({ localPath: "Inbox/a.md", contentHash: "hash", remoteLocation: "doc-1",
    workspaceSlug: "wiki", lastSyncedAt: 1, remoteMissing: true, lastCheckedAt: 2 });
  const reloaded = persistedStore(s.saved());
  await reloaded.store.load();
  assert.equal(reloaded.store.getSyncRecord("Inbox/a.md").remoteMissing, true);
  assert.equal(reloaded.store.getSyncRecord("Inbox/a.md").lastCheckedAt, 2);
});
