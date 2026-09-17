# Changelog

## 0.2.0

- Refactored the plugin into listener, service, API client, store, settings, types, and utility layers.
- Added persistent local ↔ AnythingLLM document sync records.
- Added content hashing and duplicate protection.
- Added migration support for the original flat v0.1 settings format.
- Added workspace cache reset when AnythingLLM URL/API key changes.
- Added serialized persistence writes for concurrent sync events.
- Kept v0.2 automatic behavior intentionally limited to newly created Markdown files.
- Refuse changed-file reuploads until proper update synchronization exists, preventing accidental duplicate remote documents.
