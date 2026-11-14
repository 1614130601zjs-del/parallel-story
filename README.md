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


## 1.1.0

- 分支索引按角色和独立聊天记录归类。
- 新分支记录来源角色 ID、角色名称、聊天记录标识和来源楼层。
- 管理器标记当前打开的聊天记录。
- 不同角色或同一角色的不同聊天记录不会混在同一组。
- 旧版本索引仍保留并显示在“旧版分支（来源待识别）”分组中；旧记录缺少的角色信息无法自动补回。
