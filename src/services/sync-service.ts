import { TFile, TFolder, type App } from "obsidian";
import type { DeleteResult, FileSyncStatus, RemoteCheckSummary, SyncOrigin, SyncRecord, SyncResult } from "../types";
import { hashContent } from "../utils/hash";
import { isPathInsideWatchFolders, normalizeBaseUrl, normalizeWatchFolders } from "../utils/path";
import { AnythingLLMClient } from "./anythingllm-client";
import { PluginStore } from "../store/plugin-store";

/** Recursively collect Markdown files inside a folder without enumerating the whole vault. */
function collectMarkdownFiles(folder: TFolder, out: TFile[] = []): TFile[] {
  for (const child of folder.children) {
    if (child instanceof TFolder) {
      collectMarkdownFiles(child, out);
    } else if (child instanceof TFile && child.extension.toLowerCase() === "md") {
      out.push(child);
    }
  }
  return out;
}

export class SyncService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly statuses = new Map<string, FileSyncStatus>();
  private readonly listeners = new Set<() => void>();
  private readonly hashes = new WeakMap<TFile, { mtime: number; size: number; hash: string }>();
  private readonly hashVersions = new WeakMap<TFile, number>();

  constructor(
    private readonly app: App,
    private readonly client: AnythingLLMClient,
    private readonly store: PluginStore
  ) {}

  syncFile(file: TFile, origin: SyncOrigin, previousPath?: string): Promise<SyncResult> {
    this.invalidateHash(file);
    const path = file.path;
    const filename = file.name;
    const extension = file.extension;
    return this.enqueue([previousPath ?? path, path], () => this.withStatus(path, "syncing", () =>
      this.syncFileUnlocked(file, origin, path, filename, extension, previousPath))
    );
  }

  deleteByPath(localPath: string): Promise<DeleteResult> {
    return this.enqueue([localPath], () => this.withStatus(localPath, "syncing", () => this.deleteByPathUnlocked(localPath)));
  }

  handleRename(file: TFile, oldPath: string): Promise<SyncResult | DeleteResult> {
    const path = file.path;
    const filename = file.name;
    const extension = file.extension;
    // Reserve both paths immediately, so edits and subsequent renames wait for this move.
    return this.enqueue([oldPath, path], () => this.withStatus(path, "syncing", () =>
      this.handleRenameUnlocked(file, oldPath, path, filename, extension))
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidateFileStatus(file: TFile): void {
    this.invalidateHash(file);
    if (this.statuses.get(file.path)?.state === "error") this.statuses.delete(file.path);
    this.notify();
  }

  private invalidateHash(file: TFile): void {
    this.hashes.delete(file);
    this.hashVersions.set(file, (this.hashVersions.get(file) ?? 0) + 1);
  }

  async getFileStatus(file: TFile): Promise<FileSyncStatus> {
    const transient = this.statuses.get(file.path);
    if (transient) return transient;
    const record = this.store.getSyncRecord(file.path);
    if (!record) return { state: "unsynced", message: "This note has not been synchronized." };
    if (record.workspaceSlug !== this.store.settings.workspaceSlug) {
      return { state: "modified", message: "This note needs to be synchronized to the selected workspace." };
    }
    if (record.remoteMissing) return { state: "missing", message: "The document is missing from its AnythingLLM workspace. Sync again to restore it." };
    try {
      const { mtime, size } = file.stat;
      let cached = this.hashes.get(file);
      if (!cached || cached.mtime !== mtime || cached.size !== size) {
        const version = this.hashVersions.get(file) ?? 0;
        const hash = hashContent(await this.app.vault.read(file));
        cached = { mtime, size, hash };
        if ((this.hashVersions.get(file) ?? 0) === version && file.stat.mtime === mtime && file.stat.size === size) this.hashes.set(file, cached);
        else return { state: "modified", message: "This note changed while its status was being checked." };
      }
      if (record.pendingRename || cached.hash !== record.contentHash) {
        return { state: "modified", message: "Local changes need to be synchronized." };
      }
      return { state: "synced", message: record.lastCheckedAt
        ? `Local content matches the last upload. Remote presence last checked: ${new Date(record.lastCheckedAt).toLocaleString()}.`
        : "Local content matches the last upload. Remote presence has not been checked; use Check sync status." };
    } catch (error) {
      return { state: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  checkFolder(folder: TFolder): Promise<RemoteCheckSummary> {
    return this.checkFiles(collectMarkdownFiles(folder));
  }

  checkTrackedFiles(): Promise<RemoteCheckSummary> {
    const files = this.store.getAllSyncRecords().map((record) => this.app.vault.getAbstractFileByPath(record.localPath))
      .filter((file): file is TFile => file instanceof TFile && file.extension.toLowerCase() === "md");
    return this.checkFiles(files);
  }

  async checkFiles(files: TFile[]): Promise<RemoteCheckSummary> {
    const summary: RemoteCheckSummary = { present: 0, missing: 0, failed: 0, skipped: 0 };
    const documents = new Map<string, Promise<Set<string>>>();
    const connection = this.connectionKey();
    const snapshots = [...new Map(files.map((file) => [file.path, file])).values()]
      .map((file) => ({ path: file.path, record: this.store.getSyncRecord(file.path) }));
    for (const { path, record } of snapshots) {
      if (!record) { summary.skipped += 1; continue; }
      try {
        await this.enqueue([path], () => this.withStatus(path, "checking", async () => {
          if (this.store.getSyncRecord(path) !== record) { summary.skipped += 1; return; }
          if (connection !== this.connectionKey()) throw new Error("Connection settings changed; check again.");
          let request = documents.get(record.workspaceSlug);
          if (!request) {
            request = this.client.listWorkspaceDocuments(record.workspaceSlug);
            documents.set(record.workspaceSlug, request);
          }
          const locations = await request;
          if (connection !== this.connectionKey()) throw new Error("Connection settings changed; check again.");
          if (this.store.getSyncRecord(path) !== record) { summary.skipped += 1; return; }
          const remoteMissing = !locations.has(record.remoteLocation);
          await this.store.setSyncRecord({ ...record, remoteMissing, lastCheckedAt: Date.now() });
          if (remoteMissing) summary.missing += 1;
          else summary.present += 1;
        }));
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }

  private connectionKey(): string {
    return `${normalizeBaseUrl(this.store.settings.baseUrl)}\0${this.store.apiKey}`;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async withStatus<T>(path: string, state: "syncing" | "checking", task: () => Promise<T>): Promise<T> {
    this.statuses.set(path, { state, message: state === "syncing" ? "Synchronizing with AnythingLLM…" : "Checking remote presence…" });
    this.notify();
    try {
      const result = await task();
      this.statuses.delete(path);
      return result;
    } catch (error) {
      this.statuses.set(path, { state: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.notify();
    }
  }

  async syncWatchedFolder(): Promise<{ synced: number; skipped: number; failed: number }> {
    const watchFolders = normalizeWatchFolders(this.store.settings.watchFolders);
    const filesByPath = new Map<string, TFile>();
    for (const path of watchFolders) {
      const folder = this.app.vault.getFolderByPath(path);
      if (!folder) throw new Error(`Watch folder does not exist: ${path}`);
      for (const file of collectMarkdownFiles(folder)) filesByPath.set(file.path, file);
    }
    return this.syncFiles([...filesByPath.values()]);
  }

  /** One-time recursive sync; does not change the automatic watch scope. */
  syncFolder(folder: TFolder): Promise<{ synced: number; skipped: number; failed: number }> {
    return this.syncFiles(collectMarkdownFiles(folder));
  }

  private async syncFiles(files: TFile[]): Promise<{ synced: number; skipped: number; failed: number }> {
    let synced = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of files) {
      try {
        const result = await this.syncFile(file, "bulk");
        if (result.status === "synced") synced += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        console.error("[AnythingLLM Sync] Bulk sync failed", file.path, error);
      }
    }
    return { synced, skipped, failed };
  }

  private async syncFileUnlocked(
    file: TFile,
    origin: SyncOrigin,
    path: string,
    filename: string,
    extension: string,
    previousPath?: string
  ): Promise<SyncResult> {
    if (extension.toLowerCase() !== "md") {
      return { status: "ignored", reason: "unsupported-file" };
    }
    if (origin === "auto" && !isPathInsideWatchFolders(path, this.store.settings.watchFolders)) {
      return { status: "ignored", reason: "outside-watch-folder" };
    }

    this.validateSyncSettings();

    const content = await this.app.vault.read(file);
    const oldPath = previousPath ?? path;
    const existing = this.store.getSyncRecord(oldPath) ?? this.store.getSyncRecord(path);
    if (!content.trim()) {
      // Keep the mapping reachable after a rename, even when there is nothing to upload.
      if (existing && oldPath !== path) {
        await this.store.replaceSyncRecord(oldPath, { ...existing, localPath: path, pendingRename: true });
      }
      return { status: "skipped", reason: "empty" };
    }

    const contentHash = hashContent(content);
    const targetWorkspace = this.store.settings.workspaceSlug;

    if (
      existing &&
      !existing.pendingRename &&
      !existing.remoteMissing &&
      existing.contentHash === contentHash &&
      existing.workspaceSlug === targetWorkspace &&
      existing.localPath === path &&
      (oldPath === path || !this.store.getSyncRecord(oldPath))
    ) {
      return { status: "skipped", reason: "unchanged" };
    }

    const uploaded = await this.client.uploadMarkdown({ filename, content });

    if (!existing) {
      await this.client.updateWorkspaceEmbeddings({
        workspaceSlug: targetWorkspace,
        adds: [uploaded.location]
      });
      const record = this.createRecord(path, contentHash, uploaded.location, uploaded.name, targetWorkspace);
      await this.store.setSyncRecord(record);
      return { status: "synced", operation: "created", record };
    }

    if (existing.workspaceSlug === targetWorkspace) {
      await this.client.updateWorkspaceEmbeddings({
        workspaceSlug: targetWorkspace,
        adds: [uploaded.location],
        deletes: [existing.remoteLocation]
      });
    } else {
      await this.client.updateWorkspaceEmbeddings({
        workspaceSlug: targetWorkspace,
        adds: [uploaded.location]
      });
      try {
        await this.client.updateWorkspaceEmbeddings({
          workspaceSlug: existing.workspaceSlug,
          deletes: [existing.remoteLocation]
        });
      } catch (error) {
        try {
          await this.client.updateWorkspaceEmbeddings({
            workspaceSlug: targetWorkspace,
            deletes: [uploaded.location]
          });
        } catch {
          // Best-effort rollback only. Keep the original error because it is actionable.
        }
        throw error;
      }
    }

    const record = this.createRecord(path, contentHash, uploaded.location, uploaded.name, targetWorkspace);
    await this.store.replaceSyncRecord(oldPath, record);
    return {
      status: "synced",
      operation: existing.workspaceSlug === targetWorkspace ? "updated" : "migrated",
      record
    };
  }

  private async deleteByPathUnlocked(localPath: string): Promise<DeleteResult> {
    const existing = this.store.getSyncRecord(localPath);
    if (!existing) return { status: "skipped", reason: "not-synced" };

    this.validateConnectionOnly();
    await this.client.updateWorkspaceEmbeddings({
      workspaceSlug: existing.workspaceSlug,
      deletes: [existing.remoteLocation]
    });
    await this.store.deleteSyncRecord(localPath);
    return { status: "deleted", record: existing };
  }

  private async handleRenameUnlocked(
    file: TFile,
    oldPath: string,
    path: string,
    filename: string,
    extension: string
  ): Promise<SyncResult | DeleteResult> {
    const isMarkdown = extension.toLowerCase() === "md";
    const oldInside = isPathInsideWatchFolders(oldPath, this.store.settings.watchFolders);
    const newInside = isPathInsideWatchFolders(path, this.store.settings.watchFolders);
    if (!oldInside && !newInside) {
      return { status: "ignored", reason: "outside-watch-folder" };
    }

    // The local rename has already happened, even if reading/uploading now fails.
    // Persist its mapping first so the next edit, rename or delete can find it.
    const existing = this.store.getSyncRecord(oldPath);
    if (existing && oldPath !== path) {
      await this.store.replaceSyncRecord(oldPath, { ...existing, localPath: path, pendingRename: true });
    }
    if (!isMarkdown || (oldInside && !newInside)) {
      return this.deleteByPathUnlocked(path);
    }
    return this.syncFileUnlocked(file, "rename", path, filename, extension);
  }

  private enqueue<T>(paths: string[], task: () => Promise<T>): Promise<T> {
    const keys = [...new Set(paths)];
    const previous = keys.map((key) => (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined));
    const next = Promise.all(previous).then(task);
    for (const key of keys) this.queues.set(key, next);
    const cleanup = () => {
      for (const key of keys) {
        if (this.queues.get(key) === next) this.queues.delete(key);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  private createRecord(
    localPath: string,
    contentHash: string,
    remoteLocation: string,
    remoteName: string | undefined,
    workspaceSlug: string
  ): SyncRecord {
    return {
      localPath,
      contentHash,
      remoteLocation,
      remoteName,
      workspaceSlug,
      lastSyncedAt: Date.now()
    };
  }

  private validateConnectionOnly(): void {
    if (!this.store.settings.baseUrl.trim()) throw new Error("AnythingLLM URL is not configured.");
    if (!this.store.apiKey.trim()) throw new Error("AnythingLLM Developer API key is not configured.");
  }

  private validateSyncSettings(): void {
    this.validateConnectionOnly();
    if (!this.store.settings.workspaceSlug.trim()) throw new Error("AnythingLLM workspace is not selected.");
  }
}
