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

Folder renames and moves recursively apply the same rules to Markdown descendants. Moving a folder within the watch folder updates child mappings; moving it out removes child embeddings; moving it in syncs its Markdown notes.

AnythingLLM's documented public API exposes workspace embedding management, but not a documented endpoint for permanently deleting each superseded source object from global document storage. Therefore this plugin guarantees Workspace retrieval synchronization; stale source objects can remain in AnythingLLM's global document storage after updates.

## Security

The Developer API key is stored with Obsidian `SecretStorage` and only the secret identifier is persisted in plugin `data.json`.
