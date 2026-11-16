# AnythingLLM Sync for Obsidian

Automatically keep Markdown notes in selected Obsidian folders synchronized with an AnythingLLM workspace.

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

- Select multiple watch folders from a folder-tree dialog with checkboxes.
- Include subfolders automatically and avoid duplicate syncs for overlapping selections.
- Choose an AnythingLLM workspace by name.
- Automatic sync on Markdown create and edit.
- Automatic removal from Workspace retrieval when a note is deleted.
- Re-sync on rename.
- Debounced writes for Web Clipper and active editing.
- Content hashing to skip unchanged notes.
- Bulk sync existing Markdown files.
- Manual sync command for the active note.
- Right-click a Markdown file to sync it, or a folder to recursively sync its Markdown notes.
- Show file-explorer sync badges, inspect a note's status in a dialog, and check whether remote workspace documents have been removed.
- Secure Developer API key storage using Obsidian SecretStorage.
- Per-vault settings and sync state.

## Requirements

- Obsidian 1.13.0 or newer.
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
styles.css
```

Then enable **AnythingLLM Sync** in Obsidian → Settings → Community plugins.

## Configure

1. Open AnythingLLM → Settings → Developer API and create an API key.
2. Open Obsidian → Settings → AnythingLLM Sync.
3. Set the AnythingLLM URL, for example `http://localhost:3001`.
4. Create/select the API key through Obsidian SecretStorage.
5. Test the connection.
6. Refresh workspaces and select the target workspace.
7. Click **Choose folders**, check folders such as `00-Inbox` and `Knowledge`, then click **Confirm**. Selecting a parent includes its subfolders. Canceling leaves your settings unchanged.
8. Enable automatic sync.

Use **Sync watched folders now** to upload existing notes. With no folders selected, automatic folder sync is disabled. Removing a folder from the selection keeps its existing AnythingLLM documents and stops automatically tracking changes in that folder. Existing single-folder settings are migrated automatically.

## Commands

- **AnythingLLM Sync: Sync current note to AnythingLLM**
- **AnythingLLM Sync: Sync watched folders to AnythingLLM**
- **AnythingLLM Sync: Check tracked notes in AnythingLLM**

In the file explorer, right-click a Markdown file and choose **Sync file to AnythingLLM**, or right-click a folder and choose **Sync folder to AnythingLLM**. Folder sync includes subfolders, skips unsupported files, and reports synced, skipped and failed counts. These are one-time actions that also work outside watched folders and with automatic sync disabled; they do not change your watch-folder selection.

## Sync status and remote checks

Markdown files show a status badge in the file explorer: **Not synced**, **Synced**, **Needs sync**, **Syncing**, **Checking**, **Remote missing**, or **Error**. Click the badge or right-click → **Check sync status** to open a dialog with details, **Check remote**, and **Sync now**. Errors and retries stay in that dialog.

**Synced** means the local content matches the last upload. Remote presence reflects the last explicit check, not continuous polling; the tooltip and dialog show when it was checked. To check a folder recursively, use its **Check remote sync status** context-menu action. The settings maintenance action and command check all tracked notes still present in the vault, including notes manually synced outside watched folders. Each check fetches each involved workspace's document list once.

When a check finds a document missing from its workspace, its badge changes to **Remote missing**. Syncing the file or folder again restores missing nonempty notes even when their content has not changed. A network, authentication or response-format failure reports **Error** and does not mark notes as remotely missing. Checks verify workspace document membership; they do not audit individual vectors or the integrity of global source storage.

## Sync behavior

| Obsidian action | AnythingLLM behavior |
| --- | --- |
| Create Markdown | Upload + embed |
| Edit Markdown | Replace Workspace embedding with latest content |
| Rename Markdown | Re-upload under new filename + replace old embedding |
| Move between watched folders | Update the path mapping and replace the old embedding |
| Move out of all watched folders | Remove the old embedding from the Workspace |
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
- `styles.css`

The included GitHub Actions workflow builds and publishes those assets when a semantic-version tag is pushed.

## Privacy

- Notes are sent only to the AnythingLLM URL you configure.
- The API key is stored in Obsidian SecretStorage rather than plugin `data.json`.
- The plugin contains no analytics or telemetry.

## License

MIT
