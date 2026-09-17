import type { App, TFile } from "obsidian";
import { AnythingLLMClient } from "./anythingllm-client";
import { PluginStore } from "../store/plugin-store";
import type { SyncOrigin, SyncRecord, SyncResult } from "../types";
import { hashContent } from "../utils/hash";
import { isPathInsideFolder } from "../utils/path";

export class SyncService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly client: AnythingLLMClient,
    private readonly store: PluginStore,
  ) {}

  async syncFile(file: TFile, origin: SyncOrigin): Promise<SyncResult> {
    if (file.extension.toLowerCase() !== "md") {
      return { status: "ignored", reason: "unsupported-file" };
    }

    if (origin === "auto" && !isPathInsideFolder(file.path, this.store.settings.watchFolder)) {
      return { status: "ignored", reason: "outside-watch-folder" };
    }

    if (this.inFlight.has(file.path)) {
      return { status: "skipped", reason: "unchanged" };
    }

    this.validateSyncSettings();
    this.inFlight.add(file.path);

    try {
      const content = await this.app.vault.read(file);
      if (!content.trim()) return { status: "skipped", reason: "empty" };

      const contentHash = hashContent(content);
      const existing = this.store.getSyncRecord(file.path);
      if (existing) {
        if (
          existing.contentHash === contentHash &&
          existing.workspaceSlug === this.store.settings.workspaceSlug
        ) {
          return { status: "skipped", reason: "unchanged" };
        }

        throw new Error(
          "This note was already synced. Updating an existing AnythingLLM document is intentionally disabled until update synchronization is implemented, to avoid creating duplicate remote documents.",
        );
      }

      const remote = await this.client.uploadMarkdown({
        filename: file.name,
        content,
        workspaceSlug: this.store.settings.workspaceSlug,
      });

      const record: SyncRecord = {
        localPath: file.path,
        contentHash,
        remoteLocation: remote.location,
        remoteName: remote.name,
        workspaceSlug: this.store.settings.workspaceSlug,
        lastSyncedAt: Date.now(),
      };

      await this.store.setSyncRecord(record);
      return { status: "synced", record };
    } finally {
      this.inFlight.delete(file.path);
    }
  }

  private validateSyncSettings(): void {
    const { baseUrl, apiKey, workspaceSlug } = this.store.settings;
    if (!baseUrl.trim()) throw new Error("AnythingLLM URL is not configured.");
    if (!apiKey.trim()) throw new Error("AnythingLLM Developer API key is not configured.");
    if (!workspaceSlug.trim()) throw new Error("AnythingLLM workspace is not selected.");
  }
}
