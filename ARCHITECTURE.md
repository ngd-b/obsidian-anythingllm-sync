# Architecture

```text
Obsidian Vault events
  create / modify / rename / delete
            │
            ▼
       VaultListener
  folder filter + debounce
            │
            ▼
        SyncService
  hash / create / replace / remove
            │
            ▼
   AnythingLLMClient
  upload + update-embeddings
            │
            ▼
       PluginStore
 local path ↔ remote location
```

## Update semantics

AnythingLLM identifies an uploaded source document by its returned `location`.

- New note: upload source → add its location to Workspace embeddings.
- Edited note: upload the new source → add new location and delete old location from Workspace embeddings → replace local sync record.
- Deleted note: delete old location from Workspace embeddings → delete local sync record.
- Renamed note: upload with the new filename and replace the old Workspace embedding.
- Workspace changed: add new source to the new Workspace first, then remove the old embedding from the former Workspace. A best-effort rollback removes the new embedding if the old Workspace removal fails.

Rename tasks reserve both the old and new paths as soon as the Vault event arrives. Edits, manual syncs, deletes and subsequent renames on either path wait for that task. Each task captures its path and filename before waiting, because Obsidian can mutate the same file object during an upload. Create and modify events remain debounced; a rename cancels the pending timer for that file and enters the queue immediately.

Before reading or uploading a renamed note, its local mapping is moved to the new path with a persisted `pendingRename` marker. The marker prevents unchanged-content checks from skipping an incomplete rename and is cleared when synchronization succeeds. This keeps the previous remote document reachable for a later edit or delete even if reading or uploading fails.

Folder renames and moves recursively apply the same rules to Markdown descendants. Moving between watched folders updates child mappings; moving out of all watched folders removes child embeddings; moving into a watched folder syncs its Markdown notes.

The watched scope is the union of `settings.watchFolders`. Parent selections include descendants, and overlapping selections are normalized to their parent roots. Bulk sync enumerates those roots and deduplicates notes by path. Legacy `watchFolder` settings migrate to this array on load; an explicit empty array disables automatic folder sync. Removing a configured root keeps its existing remote documents and local records.

The folder picker edits a draft selection in a modal and saves only on confirmation. Descendant checkboxes covered by a selected parent are checked and disabled. Saving failures stay in the modal and restore the prior in-memory settings; the settings page updates only its folder summary, preserving the page position.

File explorer context menus use Obsidian's registered `file-menu` event. Markdown file actions reuse manual sync; folder actions recursively collect Markdown notes and reuse the bulk sync loop. These actions operate on the clicked file or folder independently of the active note and automatic watch scope, without changing settings. Folder operations show an in-progress notice and final synced/skipped/failed counts.

## Status and remote verification

SyncService exposes status subscriptions and caches local content hashes by file object, modification time and size. Vault events invalidate those hashes even when automatic sync is disabled. Store changes and in-flight operations refresh the explorer badges. The explorer adapter is isolated in `src/ui/file-status-decorations.ts`, since Obsidian does not expose a public decoration API; it observes file-explorer DOM changes, ignores its own badge mutations and removes observers and badges on unload. Revision checks discard stale asynchronous status reads. Status details and per-file check/resync feedback stay in a modal.

Explicit remote checks use `GET /api/v1/workspace/:slug` and match each record's `remoteLocation` against the returned document `docpath`. The API client rejects missing workspaces, malformed document lists and non-200 responses rather than interpreting them as an empty workspace. Checks use each record's original workspace, fetch each workspace once per batch, and run record updates in the same path queue as uploads and renames. Snapshot identity and connection checks prevent an old response from marking a newer upload missing.

`remoteMissing` and `lastCheckedAt` are optional persisted record fields. Only successful checks update them. The unchanged-content shortcut is disabled for a missing document; successful sync replaces the record and clears the missing marker. Network failures leave presence metadata unchanged and surface an error status. A synced badge describes local content against the last upload, while remote membership is only known as of the last explicit check. No polling or individual-vector integrity check is performed.

AnythingLLM's documented public API exposes workspace embedding management, but not a documented endpoint for permanently deleting each superseded source object from global document storage. Therefore this plugin guarantees Workspace retrieval synchronization; stale source objects can remain in AnythingLLM's global document storage after updates.

## Security

The Developer API key is stored with Obsidian `SecretStorage` and only the secret identifier is persisted in plugin `data.json`.
