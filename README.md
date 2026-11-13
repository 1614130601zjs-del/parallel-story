# 平行叙事（Parallel Story）

SillyTavern extension for managing native chat branches with custom names.

## Current MVP

- Adds a **平行叙事** entry to the Extensions / Magic Wand menu.
- Creates a native SillyTavern branch from the latest message in the current single-character chat.
- Stores only a lightweight index in the extension settings: custom name, native chat filename, parent branch, source chat, source message and creation time.
- Opens the native chat file when a branch is selected.
- Supports renaming and removing an index entry. Removing an entry does **not** delete the native chat file.

## Storage principle

Chat messages remain in SillyTavern's native chat files. This extension does not copy or separately store message content.

## Install

In SillyTavern, open **Extensions → Install extension**, and use:

```
https://github.com/1614130601zjs-del/parallel-story
```

Or clone into:

```
SillyTavern/data/<user>/extensions/parallel-story
```

Restart or reload the SillyTavern page after installation.

## Current limitations

- MVP creates a branch from the latest message only. Per-message actions will be added after native API compatibility is verified.
- Single-character chats only; group chats are not supported.
- Native API module paths and exports can vary by SillyTavern version. If the manager reports that an API is unavailable, do not delete or rename native chat files; report the SillyTavern version and console error.
- The index is stored in the user's SillyTavern extension settings, not in a separate chat database.

## Version

1.0.0 — initial minimal manager.
