# AnythingLLM Sync for Obsidian

Automatically keep Markdown notes in an Obsidian folder synchronized with an AnythingLLM workspace.

A typical personal knowledge flow becomes:

```text
Web page
  ↓ Obsidian Web Clipper
Obsidian / Inbox
  ↓ AnythingLLM Sync
AnythingLLM Workspace
  ↓ Embedding + retrieval
AI answers from your notes
```

## Features

- Choose any vault-relative watch folder.
- Choose an AnythingLLM workspace by name.
- Automatic sync on Markdown create and edit.
- Automatic removal from Workspace retrieval when a note is deleted.
- Re-sync on rename.
- Debounced writes for Web Clipper and active editing.
- Content hashing to skip unchanged notes.
- Bulk sync existing Markdown files.
- Manual sync command for the active note.
- Secure Developer API key storage using Obsidian SecretStorage.
- Per-vault settings and sync state.

## Requirements

- Obsidian 1.11.4 or newer.
- An AnythingLLM instance reachable from the device running Obsidian.
- An AnythingLLM Developer API key.

## Install manually

Download the latest release assets and put them in:

```text
<Vault>/.obsidian/plugins/anythingllm-sync/
```

Required files:

```text
main.js
manifest.json
```

Then enable **AnythingLLM Sync** in Obsidian → Settings → Community plugins.

## Configure

1. Open AnythingLLM → Settings → Developer API and create an API key.
2. Open Obsidian → Settings → AnythingLLM Sync.
3. Set the AnythingLLM URL, for example `http://localhost:3001`.
4. Create/select the API key through Obsidian SecretStorage.
5. Test the connection.
6. Refresh workspaces and select the target workspace.
7. Set a vault-relative watch folder such as `00-Inbox`.
8. Enable automatic sync.

## Commands

- **AnythingLLM Sync: Sync current note to AnythingLLM**
- **AnythingLLM Sync: Sync watched folder to AnythingLLM**

## Sync behavior

| Obsidian action | AnythingLLM behavior |
| --- | --- |
| Create Markdown | Upload + embed |
| Edit Markdown | Replace Workspace embedding with latest content |
| Rename Markdown | Re-upload under new filename + replace old embedding |
| Delete Markdown | Remove old embedding from Workspace |
| Existing notes | Use bulk sync command |

### Important AnythingLLM behavior

AnythingLLM's public Developer API supports upload and Workspace embedding add/remove operations. The plugin keeps the selected Workspace retrieval state synchronized. AnythingLLM can retain superseded uploaded source objects in its global document storage after an update because there is currently no documented public per-document source-delete endpoint used by this plugin.

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

This generates `main.js` in the repository root.

## Release

Obsidian expects the GitHub release tag to exactly match `manifest.json` (for example `1.0.0`, not `v1.0.0`). Release assets are:

- `main.js`
- `manifest.json`
- `styles.css` only if a future version adds custom CSS

The included GitHub Actions workflow builds and publishes those assets when a semantic-version tag is pushed.

## Privacy

- Notes are sent only to the AnythingLLM URL you configure.
- The API key is stored in Obsidian SecretStorage rather than plugin `data.json`.
- The plugin contains no analytics or telemetry.

## License

MIT
