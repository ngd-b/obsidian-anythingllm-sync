import type { App, TFile } from "obsidian";
import type { DeleteResult, SyncOrigin, SyncRecord, SyncResult } from "../types";
import { hashContent } from "../utils/hash";
import { isPathInsideFolder } from "../utils/path";
import { AnythingLLMClient } from "./anythingllm-client";
import { PluginStore } from "../store/plugin-store";

export class SyncService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly app: App,
    private readonly client: AnythingLLMClient,
    private readonly store: PluginStore
  ) {}

  syncFile(file: TFile, origin: SyncOrigin, previousPath?: string): Promise<SyncResult> {
    const queueKey = previousPath ?? file.path;
    return this.enqueue(queueKey, () => this.syncFileUnlocked(file, origin, previousPath));
  }

  deleteByPath(localPath: string): Promise<DeleteResult> {
    return this.enqueue(localPath, () => this.deleteByPathUnlocked(localPath));
  }

  handleRename(file: TFile, oldPath: string): Promise<SyncResult | DeleteResult> {
    return this.enqueue(oldPath, () => this.handleRenameUnlocked(file, oldPath));
  }

  async syncWatchedFolder(): Promise<{ synced: number; skipped: number; failed: number }> {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => isPathInsideFolder(file.path, this.store.settings.watchFolder));

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

  private async syncFileUnlocked(file: TFile, origin: SyncOrigin, previousPath?: string): Promise<SyncResult> {
    if (file.extension.toLowerCase() !== "md") {
      return { status: "ignored", reason: "unsupported-file" };
    }
    if (origin === "auto" && !isPathInsideFolder(file.path, this.store.settings.watchFolder)) {
      return { status: "ignored", reason: "outside-watch-folder" };
    }

    this.validateSyncSettings();

    const content = await this.app.vault.read(file);
    if (!content.trim()) return { status: "skipped", reason: "empty" };

    const contentHash = hashContent(content);
    const oldPath = previousPath ?? file.path;
    const existing = this.store.getSyncRecord(oldPath) ?? this.store.getSyncRecord(file.path);
    const targetWorkspace = this.store.settings.workspaceSlug;

    if (
      existing &&
      existing.contentHash === contentHash &&
      existing.workspaceSlug === targetWorkspace &&
      oldPath === file.path
    ) {
      return { status: "skipped", reason: "unchanged" };
    }

    const uploaded = await this.client.uploadMarkdown({ filename: file.name, content });

    if (!existing) {
      await this.client.updateWorkspaceEmbeddings({
        workspaceSlug: targetWorkspace,
        adds: [uploaded.location]
      });
      const record = this.createRecord(file.path, contentHash, uploaded.location, uploaded.name, targetWorkspace);
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

    const record = this.createRecord(file.path, contentHash, uploaded.location, uploaded.name, targetWorkspace);
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

  private async handleRenameUnlocked(file: TFile, oldPath: string): Promise<SyncResult | DeleteResult> {
    const oldInside = isPathInsideFolder(oldPath, this.store.settings.watchFolder);
    const newInside = isPathInsideFolder(file.path, this.store.settings.watchFolder);
    if (!oldInside && !newInside) {
      return { status: "ignored", reason: "outside-watch-folder" };
    }
    if (oldInside && !newInside) {
      return this.deleteByPathUnlocked(oldPath);
    }
    if (!oldInside && newInside) {
      return this.syncFileUnlocked(file, "rename");
    }
    return this.syncFileUnlocked(file, "rename", oldPath);
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(key, next);
    const cleanup = () => {
      if (this.queues.get(key) === next) this.queues.delete(key);
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
