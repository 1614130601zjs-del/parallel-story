# 平行叙事（Parallel Story）

SillyTavern extension: a native chat-record manager with optional parallel-story branch creation.

## 1.6.0

- Clicking a chat entry now opens a searchable floor directory instead of immediately opening the chat.
- The directory previews native message text, supports paging through long chats, and jumps to the selected floor using SillyTavern's native `/chat-jump` command.
- Message bodies are fetched from the native chat endpoint on demand and are not stored by the extension.

# 1.5.0

- Replaces the all-characters-expanded view with a character-card picker. Select one character to view only that character's native chats and branches.
- Adds confirmed deletion for ordinary native chat records. The active chat cannot be deleted; deletion uses SillyTavern's native chat-delete endpoint and refreshes the manager.
- Keeps branch deletion, native rename, JSONL export, per-character import, and per-message branch creation.

# 1.4.0

- Adds a small branch icon to each rendered chat message action row. Clicking it creates a native SillyTavern branch from that exact message, records the branch metadata, and opens the new branch chat.
- Keeps the manager's create-branch action as a shortcut for branching from the latest message.

## 1.3.0

- Adds native chat rename for ordinary chats and parallel branches. Renaming updates the original SillyTavern chat file and synchronizes branch source references.
- Adds native JSONL export for each chat record.
- Adds per-character import using SillyTavern's native character-chat import function; imported records are stored by SillyTavern, not by this extension.
- Existing chat messages remain in native SillyTavern storage; the extension does not copy or maintain a second chat archive.

## 1.2.0

- Reads existing single-character chat records from SillyTavern and displays them as openable entries; message bodies are not copied or stored by this extension.
- Groups records by character, then lists that character's native chat files.
- Marks records created as parallel-story branches and stores only branch metadata in extension settings.
- Allows opening ordinary chats and branches; branches can be renamed.
- Deleting a branch also deletes its corresponding native SillyTavern chat file after confirmation. Ordinary chat deletion was added in 1.5.0.
- Branch creation currently uses the latest message in the active chat. Creating from a pinned/arbitrary floor is a later step.

## Storage

SillyTavern remains the source of truth for all chat messages. The extension stores only branch metadata such as custom name, native chat filename, source character, source chat, source floor, parent branch and creation time. Existing ordinary chats are fetched from SillyTavern when the manager opens; they are not copied into extension storage.

## Install

In SillyTavern, open **Extensions → Install extension**, and use:

```
https://github.com/1614130601zjs-del/parallel-story
```

Or clone into:

```
SillyTavern/data/<user>/extensions/parallel-story
```

Reload the SillyTavern page after updating.

## Limitations and safety

- Single-character chats only; group chats are not included.
- The manager reads records for characters currently available in the character list.
- Deleting a branch permanently deletes its native chat file. It cannot be restored by this extension.
- A branch that is currently open cannot be deleted from the manager; switch to another chat first.
- Branch creation currently starts from the latest message only.
- SillyTavern native APIs can vary by version. If reading, opening, creating or deleting fails, report the SillyTavern version and console error before retrying destructive actions.
