# Changelog

## 1.2.0

- Select all current folders, then uncheck individual folders or subfolders to exclude them from automatic and watched-folder sync.
- See how many folders are selected and which branches are partially selected. The Confirm button stays visible while scrolling through long folder lists.
- Apply new exclusions to notes still waiting for upload during a watched-folder sync.
- Identify clickable settings by their arrow and see when a maintenance action is running.

## 1.1.0

- Add file-explorer status badges and a note status dialog with remote verification and resync actions.
- Check tracked notes or folders against remote workspace documents, persist missing-document markers, and restore missing notes on the next sync even if their content is unchanged.
- Add right-click actions to sync a Markdown file or recursively sync a folder, including folders outside the automatic watch scope.
- Select multiple watch folders in a modal folder tree with checkboxes and explicit confirmation; migrate existing single-folder settings automatically.
- Deduplicate overlapping folder selections and preserve sync mappings when moving notes between watched folders.
- Serialize renames with edits, manual syncs and deletes across both old and new paths to prevent duplicate Workspace documents.
- Handle folder renames and moves recursively, updating or removing synchronized Markdown descendants as they cross the watch-folder boundary.

## 1.0.0

- Automatically sync new Markdown notes from a configurable folder.
- Debounce Web Clipper and editor write events.
- Automatically update AnythingLLM Workspace embeddings after note edits.
- Remove Workspace embeddings when synchronized notes are deleted.
- Re-sync renamed notes so the remote title follows the new filename.
- Support moving synchronized notes between selected AnythingLLM workspaces.
- Add one-click bulk sync for existing notes.
- Add manual sync command for the current note.
- Store AnythingLLM API keys with Obsidian SecretStorage.
- Persist local path, content hash, remote location and workspace mapping.
- Add GitHub build and release workflows.
