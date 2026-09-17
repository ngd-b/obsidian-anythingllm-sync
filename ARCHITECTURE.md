# Architecture

## Goal

Keep Obsidian-specific event handling, synchronization rules, persistence, and AnythingLLM HTTP calls independent so future sync directions do not turn `main.ts` into a monolith.

## Runtime flow

```text
Obsidian Vault
    │ create(.md)
    ▼
VaultListener
    │ folder filter + configurable delay
    ▼
SyncService
    │ read content
    │ hash / duplicate protection
    ▼
AnythingLLMClient
    │ POST /api/v1/document/upload
    │ addToWorkspaces=<slug>
    ▼
AnythingLLM
    │ returns remote document location
    ▼
PluginStore
    │ local path ↔ remote location
    │ hash / workspace / sync time
    ▼
data.json
```

## Modules

### `src/main.ts`
Composition root only.

Responsibilities:
- load persistent state;
- create services;
- register settings UI;
- register commands;
- wait for `workspace.onLayoutReady()` before registering Vault create listeners.

It should not contain AnythingLLM HTTP code or sync rules.

### `src/listeners/vault-listener.ts`
Owns Obsidian filesystem events.

Current v0.2 behavior:
- `create` only;
- Markdown only;
- configurable watched folder including subfolders;
- configurable delayed read for Web Clipper writes.

Future events belong here:
- `modify` → schedule update;
- `delete` → schedule remote delete;
- `rename` → update local mapping or remote metadata.

### `src/services/sync-service.ts`
Domain orchestration.

Responsibilities:
- validate sync configuration;
- read note content;
- hash content;
- protect against duplicate uploads;
- call AnythingLLM client;
- persist sync records.

It deliberately refuses to upload a changed file that was already synced until true update support exists. This avoids orphaning duplicate remote documents.

### `src/services/anythingllm-client.ts`
AnythingLLM Developer API adapter only.

Responsibilities:
- auth validation;
- workspace listing;
- document upload;
- multipart request construction;
- AnythingLLM error normalization.

Future AnythingLLM endpoints (update embedding / delete document / verification) should be added here.

### `src/store/plugin-store.ts`
Persistent plugin state.

Stores:
- per-vault settings;
- local/remote sync mappings.

Writes are serialized so concurrent sync events do not overwrite each other's `data.json` snapshots.

### `src/settings/*`
Settings defaults and Obsidian UI.

AnythingLLM workspace is selected by display name from a fetched list while the plugin persists its slug internally.

### `src/utils/*`
Pure helpers for paths and content hashing.

## Sync record

```ts
interface SyncRecord {
  localPath: string;
  contentHash: string;
  remoteLocation: string;
  remoteName?: string;
  workspaceSlug: string;
  lastSyncedAt: number;
}
```

`remoteLocation` is intentionally stored from AnythingLLM's upload response. It is the remote identifier required for future update/delete operations.

## Future update algorithm

```text
modify
  ↓
read file + hash
  ↓
unchanged? → stop
  ↓
lookup SyncRecord.remoteLocation
  ↓
replace/re-embed remote document
  ↓
update hash + timestamp
```

## Future delete algorithm

```text
delete local file
  ↓
lookup SyncRecord.remoteLocation
  ↓
remove from AnythingLLM workspace/document store
  ↓
delete local SyncRecord
```

## Future multi-mapping

The current setting is one Vault → one watched folder → one AnythingLLM workspace.

A later schema can evolve to:

```ts
interface SyncMapping {
  folder: string;
  workspaceSlug: string;
  enabled: boolean;
}
```

without changing the listener/client/store boundaries.
