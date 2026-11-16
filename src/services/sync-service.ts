import { TFile, TFolder, type App } from "obsidian";
import type { DeleteResult, SyncOrigin, SyncRecord, SyncResult } from "../types";
import { hashContent } from "../utils/hash";
import { cleanVaultFolder, isPathInsideFolder } from "../utils/path";
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

  constructor(
    private readonly app: App,
    private readonly client: AnythingLLMClient,
    private readonly store: PluginStore
  ) {}

  syncFile(file: TFile, origin: SyncOrigin, previousPath?: string): Promise<SyncResult> {
    const path = file.path;
    const filename = file.name;
    const extension = file.extension;
    return this.enqueue([previousPath ?? path, path], () =>
      this.syncFileUnlocked(file, origin, path, filename, extension, previousPath)
    );
  }

  deleteByPath(localPath: string): Promise<DeleteResult> {
    return this.enqueue([localPath], () => this.deleteByPathUnlocked(localPath));
  }

  handleRename(file: TFile, oldPath: string): Promise<SyncResult | DeleteResult> {
    const path = file.path;
    const filename = file.name;
    const extension = file.extension;
    // Reserve both paths immediately, so edits and subsequent renames wait for this move.
    return this.enqueue([oldPath, path], () =>
      this.handleRenameUnlocked(file, oldPath, path, filename, extension)
    );
  }

  async syncWatchedFolder(): Promise<{ synced: number; skipped: number; failed: number }> {
    const watchFolder = cleanVaultFolder(this.store.settings.watchFolder);
    if (!watchFolder) return { synced: 0, skipped: 0, failed: 0 };

    const folder = this.app.vault.getFolderByPath(watchFolder);
    if (!folder) return { synced: 0, skipped: 0, failed: 0 };

    const files = collectMarkdownFiles(folder);

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
    if (origin === "auto" && !isPathInsideFolder(path, this.store.settings.watchFolder)) {
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
    const oldInside = isPathInsideFolder(oldPath, this.store.settings.watchFolder);
    const newInside = isPathInsideFolder(path, this.store.settings.watchFolder);
    if (isMarkdown && !oldInside && !newInside) {
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
