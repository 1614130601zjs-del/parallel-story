# 平行叙事（Parallel Story）

SillyTavern extension: a native chat-record manager with optional parallel-story branch creation.

## 1.2.0

- Reads existing single-character chat records from SillyTavern and displays them as openable entries; message bodies are not copied or stored by this extension.
- Groups records by character, then lists that character's native chat files.
- Marks records created as parallel-story branches and stores only branch metadata in extension settings.
- Allows opening ordinary chats and branches; branches can be renamed.
- Deleting a branch also deletes its corresponding native SillyTavern chat file after confirmation. Ordinary chat entries do not expose a delete action.
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
