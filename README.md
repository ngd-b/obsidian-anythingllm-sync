# AnythingLLM Sync for Obsidian

Automatically sync new Markdown notes from a configurable Obsidian folder into a selected AnythingLLM workspace.

The main use case is a personal knowledge pipeline such as:

```text
Web Clipper
    ↓
Obsidian Vault / 00-Inbox
    ↓
AnythingLLM Sync
    ↓
AnythingLLM Workspace
    ↓
Embedding + AI retrieval
```

## Features

- Configure any AnythingLLM URL.
- Store a Developer API key per Obsidian vault.
- Load AnythingLLM workspaces and select one by name.
- Configure any vault-relative watch folder; nothing is hard-coded.
- Include Markdown files in nested subfolders.
- Automatically react to newly created Markdown notes.
- Delay the read so Web Clipper can finish writing the note.
- Upload the note and add it to the selected AnythingLLM workspace.
- Store local↔remote sync metadata for future update/delete support.
- Skip unchanged manual uploads and refuse changed-file reuploads until true update sync is implemented, avoiding accidental duplicate remote documents.
- Manually sync the active note through the command palette.

## Architecture

```text
src/
├── main.ts                         Plugin composition / lifecycle
├── listeners/
│   └── vault-listener.ts           Obsidian Vault events + debounce/delay
├── services/
│   ├── anythingllm-client.ts       AnythingLLM Developer API only
│   └── sync-service.ts             Sync rules, hashing, state updates
├── settings/
│   ├── defaults.ts                 Default plugin settings
│   └── settings-tab.ts             Obsidian settings UI
├── store/
│   └── plugin-store.ts             Persisted settings + sync records
├── types/
│   └── index.ts                    Shared domain/API types
└── utils/
    ├── hash.ts                     Content hashing
    └── path.ts                     Vault path normalization/filtering
```

The layers intentionally have separate responsibilities:

- `VaultListener` knows about Obsidian events, not AnythingLLM HTTP details.
- `AnythingLLMClient` knows about HTTP, not Obsidian event behavior.
- `SyncService` decides whether a note should upload and records the result.
- `PluginStore` owns persisted state and serializes writes to `data.json`.
- `main.ts` only wires the components together and registers commands/UI.

This keeps future `modify`, `delete`, and `rename` synchronization isolated from the current create-only MVP.

## Persisted sync state

After a successful upload, the plugin stores a record similar to:

```json
{
  "localPath": "00-Inbox/example.md",
  "contentHash": "2c8f...",
  "remoteLocation": "custom-documents/example.md-uuid.json",
  "remoteName": "example.md-uuid.json",
  "workspaceSlug": "personal-knowledge",
  "lastSyncedAt": 1789660800000
}
```

That remote `location` is the important handle needed later for update/delete synchronization.

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

The build creates `main.js` at the project root.

## Local installation

Create this folder inside the vault you want to use:

```text
<Vault>/.obsidian/plugins/anythingllm-sync/
```

Copy these files into it:

```text
main.js
manifest.json
```

Reload Obsidian, then open **Settings → Community plugins** and enable **AnythingLLM Sync**.

## Configuration

Open **Settings → AnythingLLM Sync** and configure:

1. **AnythingLLM URL** — for example `http://localhost:3001`
2. **Developer API key** — generated in AnythingLLM Settings → Developer API
3. **Refresh workspaces** → select the target workspace by name
4. **Watch folder** — for example `00-Inbox`
5. Enable **Automatic sync**

The Obsidian vault name does not need to be configured. Each plugin installation already runs inside one specific vault and keeps its own settings.

## v0.2 scope

Current automatic behavior is intentionally limited to newly created Markdown files. Existing synced notes are not re-uploaded when changed until true update synchronization is implemented.

Planned follow-ups:

- Update remote content after local note modification.
- Delete remote document after local deletion.
- Preserve mapping after local rename.
- Retry queue and visible sync status.
- Multiple folder → workspace mappings.
- Optional frontmatter filters, e.g. only sync `source_type: web-clipper`.

## AnythingLLM API behavior

The plugin uploads Markdown through the Developer API endpoint:

```text
POST /api/v1/document/upload
```

It sends `addToWorkspaces` with the selected workspace slug. The upload response contains a generated document `location`, which is persisted locally for future synchronization operations.

## Security

The AnythingLLM Developer API key is stored in the current vault's plugin data:

```text
.obsidian/plugins/anythingllm-sync/data.json
```

Do not commit that file to Git or share it publicly.

## License

MIT
