(() => {
    'use strict';

    const EXTENSION_KEY = 'parallel_story';
    const MENU_ID = 'parallel-story-menu-entry';
    const ROOT_ID = 'parallel-story-root';

    const getContext = () => window.SillyTavern?.getContext?.() ?? null;

    function getStore() {
        window.extension_settings ??= {};
        window.extension_settings[EXTENSION_KEY] ??= { branches: [] };
        const store = window.extension_settings[EXTENSION_KEY];
        if (!Array.isArray(store.branches)) store.branches = [];
        return store;
    }

    function saveStore() {
        window.saveSettingsDebounced?.();
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[char]);
    }

    function makeId() {
        return window.crypto?.randomUUID?.()
            ?? `ps-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }

    async function loadNativeApis() {
        const [bookmarks, script] = await Promise.all([
            import('/scripts/bookmarks.js'),
            import('/script.js'),
        ]);
        if (typeof bookmarks.createBranch !== 'function') {
            throw new Error('当前酒馆版本没有提供可用的原生 createBranch API');
        }
        return {
            createBranch: bookmarks.createBranch,
            openCharacterChat: script.openCharacterChat,
            selectCharacterById: script.selectCharacterById,
            deleteCharacterChatByName: script.deleteCharacterChatByName,
            renameChat: script.renameChat,
            importCharacterChat: script.importCharacterChat,
            getRequestHeaders: script.getRequestHeaders,
        };
    }

    function getCurrentChatFile(context) {
        return context?.chatId ?? context?.getCurrentChatId?.() ?? '';
    }

    function getCharacter(context, characterId) {
        return context?.characters?.[Number(characterId)] ?? null;
    }

    function getCurrentScope(context = getContext()) {
        const characterId = context?.characterId;
        const character = getCharacter(context, characterId);
        return {
            characterId: characterId == null ? '' : String(characterId),
            characterName: String(character?.name ?? context?.name2 ?? '未知角色'),
            characterAvatar: String(character?.avatar ?? ''),
            chatFile: String(getCurrentChatFile(context) || ''),
        };
    }

    function getBranchCharacter(branch, context = getContext()) {
        if (branch.sourceCharacterAvatar) {
            const index = context?.characters?.findIndex((item) => item?.avatar === branch.sourceCharacterAvatar);
            if (index >= 0) return { id: String(index), character: context.characters[index] };
        }
        const id = branch.sourceCharacterId;
        const character = getCharacter(context, id);
        return character ? { id: String(id), character } : null;
    }

    function getCurrentBranchId() {
        const scope = getCurrentScope();
        return getStore().branches.find((item) =>
            item.chatFile === scope.chatFile
            && (item.sourceCharacterAvatar
                ? item.sourceCharacterAvatar === scope.characterAvatar
                : String(item.sourceCharacterId ?? '') === scope.characterId)
        )?.id ?? null;
    }

    function normalizeChatFile(fileName) {
        return String(fileName ?? '').replace(/\.jsonl$/i, '');
    }

    function getBranchForChat(character, fileName) {
        const normalized = normalizeChatFile(fileName);
        return getStore().branches.find((branch) =>
            normalizeChatFile(branch.chatFile) === normalized
            && (branch.sourceCharacterAvatar
                ? branch.sourceCharacterAvatar === character.avatar
                : false)
        ) ?? null;
    }

    async function fetchCharacterChats(context, character, characterId, getRequestHeaders) {
        if (!character?.avatar) return [];
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar }),
        });
        if (!response.ok) throw new Error(`读取「${character.name}」聊天记录失败（${response.status}）`);
        const data = await response.json();
        if (data?.error === true) throw new Error(`酒馆无法读取「${character.name}」的聊天记录`);
        return Object.values(data).filter((item) => item?.file_name).map((item) => ({
            characterId: String(characterId),
            characterName: String(character.name ?? '未命名角色'),
            characterAvatar: String(character.avatar),
            fileName: normalizeChatFile(item.file_name),
            lastMessage: item.last_mes ?? '',
        }));
    }

    async function collectChatEntries() {
        const context = getContext();
        if (!context?.characters) {
            throw new Error('当前酒馆没有提供角色列表，无法读取聊天记录');
        }
        const { getRequestHeaders } = await loadNativeApis();
        if (typeof getRequestHeaders !== 'function') {
            throw new Error('当前酒馆没有提供请求验证接口，无法安全读取聊天记录');
        }

        const all = await Promise.all(context.characters.map(async (character, index) => {
            if (!character?.avatar) return [];
            try {
                return await fetchCharacterChats(context, character, index, getRequestHeaders);
            } catch (error) {
                console.warn('[平行叙事] 读取角色聊天记录失败：', character?.name, error);
                return [{ error: error.message, characterId: String(index), characterName: character?.name ?? '未知角色' }];
            }
        }));

        const entries = all.flat();
        const seen = new Set(entries.filter((item) => item.fileName).map((item) =>
            JSON.stringify([item.characterAvatar, item.fileName])
        ));

        // Keep indexed branch records visible even if the native chat list did not return them.
        for (const branch of getStore().branches) {
            const owner = getBranchCharacter(branch, context);
            if (!owner?.character?.avatar) continue;
            const fileName = normalizeChatFile(branch.chatFile);
            const key = JSON.stringify([owner.character.avatar, fileName]);
            if (seen.has(key)) continue;
            entries.push({
                characterId: owner.id,
                characterName: owner.character.name ?? branch.sourceCharacterName ?? '未知角色',
                characterAvatar: owner.character.avatar,
                fileName,
                missingFromNativeList: true,
            });
            seen.add(key);
        }
        return entries;
    }

    async function exportNativeChat(characterAvatar, fileName) {
        const { getRequestHeaders } = await loadNativeApis();
        const base = normalizeChatFile(fileName);
        const response = await fetch('/api/chats/export', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ file: base + '.jsonl', avatar_url: characterAvatar, is_group: false, format: 'jsonl', exportfilename: base + '.jsonl' }),
        });
        if (!response.ok) throw new Error('导出聊天记录失败（' + response.status + '）');
        const payload = await response.json();
        if (typeof payload?.result !== 'string') throw new Error(payload?.message || '酒馆没有返回有效的 JSONL 数据');
        const url = URL.createObjectURL(new Blob([payload.result], { type: 'application/x-ndjson;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = base + '.jsonl';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    async function renameNativeChat(characterId, characterAvatar, oldFileName) {
        const oldBase = normalizeChatFile(oldFileName);
        const requested = window.prompt('修改原生聊天记录名称：', oldBase)?.trim();
        if (!requested) return false;
        const newBase = normalizeChatFile(requested).trim();
        if (!newBase || newBase === oldBase) return false;
        if (/[\\/]/.test(newBase)) { showNotice('名称不能包含斜杠。', 'warning'); return false; }
        const context = getContext();
        const scope = getCurrentScope(context);
        let finalBase = newBase;
        if (scope.characterAvatar === characterAvatar && scope.chatFile === oldBase) {
            if (typeof context?.renameChat !== 'function') throw new Error('当前酒馆没有提供原生聊天重命名方法');
            await context.renameChat(oldBase, newBase);
        } else {
            const { getRequestHeaders } = await loadNativeApis();
            const response = await fetch('/api/chats/rename', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({ original_file: oldBase + '.jsonl', renamed_file: newBase + '.jsonl', avatar_url: characterAvatar, is_group: false }),
            });
            if (!response.ok) throw new Error('酒馆重命名失败（' + response.status + '）');
            const payload = await response.json().catch(() => ({}));
            finalBase = normalizeChatFile(payload?.sanitizedFileName || newBase);
        }
        for (const branch of getStore().branches) {
            const belongs = branch.sourceCharacterAvatar ? branch.sourceCharacterAvatar === characterAvatar : String(branch.sourceCharacterId ?? '') === String(characterId);
            if (!belongs) continue;
            if (normalizeChatFile(branch.chatFile) === oldBase) { branch.chatFile = finalBase; branch.name = finalBase; }
            if (normalizeChatFile(branch.sourceChatFile) === oldBase) branch.sourceChatFile = finalBase;
            if (normalizeChatFile(branch.sourceChat) === oldBase) branch.sourceChat = finalBase;
        }
        saveStore();
        return true;
    }

    async function importNativeChat(file, characterId) {
        if (!file) return;
        const context = getContext();
        const character = getCharacter(context, characterId);
        if (!character?.avatar) { showNotice('无法确定导入目标角色。', 'error'); return; }
        const extension = String(file.name.split('.').pop() || '').toLowerCase();
        if (!['jsonl', 'json'].includes(extension)) { showNotice('酒馆原生聊天导入仅支持 JSONL 或 JSON 文件。', 'warning'); return; }
        try {
            const { importCharacterChat } = await loadNativeApis();
            if (typeof importCharacterChat !== 'function') throw new Error('当前酒馆没有提供原生聊天导入方法');
            const formData = new FormData();
            formData.set('file_type', extension);
            formData.set('avatar', file);
            formData.set('avatar_url', character.avatar);
            formData.set('user_name', context?.name1 || 'User');
            formData.set('character_name', character.name || 'Character');
            const imported = await importCharacterChat(formData, { refresh: false });
            if (!Array.isArray(imported) || imported.length === 0) throw new Error('酒馆未能导入该文件，请确认文件格式正确');
            showNotice('已导入 ' + imported.length + ' 份原生聊天记录。', 'success');
            await renderManager();
        } catch (error) {
            console.error('[平行叙事] 原生聊天导入失败：', error);
            showNotice(error?.message || '导入失败。', 'error');
        }
    }

    function showNotice(message, type = 'info') {
        if (typeof window.toastr?.[type] === 'function') {
            window.toastr[type](message, '平行叙事');
        } else {
            window.alert(message);
        }
    }

    function closeManager() {
        document.getElementById(ROOT_ID)?.remove();
    }

    async function renderManager() {
        closeManager();

        const store = getStore();
        const context = getContext();
        const currentScope = getCurrentScope(context);
        const currentKey = JSON.stringify([currentScope.characterAvatar, currentScope.chatFile]);
        const root = document.createElement('div');
        root.id = ROOT_ID;
        root.className = 'parallel-story-backdrop';
        root.innerHTML = `
            <section class="parallel-story-panel" role="dialog" aria-modal="true" aria-label="平行叙事">
                <header class="parallel-story-header">
                    <div>
                        <div class="parallel-story-title">平行叙事</div>
                        <div class="parallel-story-subtitle">角色与聊天记录</div>
                    </div>
                    <button class="parallel-story-icon-button" data-action="close" aria-label="关闭">×</button>
                </header>
                <div class="parallel-story-toolbar">
                    <button class="parallel-story-primary" data-action="create">＋ 从当前聊天创建剧情分支</button>
                    <span class="parallel-story-count">正在读取聊天记录…</span>
                </div>
                <div class="parallel-story-list"><div class="parallel-story-empty">正在整理角色聊天记录</div></div>
                <footer class="parallel-story-footer">原有聊天记录只作为入口读取，不会复制或另存正文。删除分支会同时删除酒馆原生聊天文件。</footer>
            </section>`;
        root.addEventListener('click', handleManagerClick);
        root.addEventListener('click', (event) => {
            if (event.target === root) closeManager();
        });
        document.body.append(root);

        try {
            const entries = await collectChatEntries();
            if (!root.isConnected) return;

            const grouped = new Map();
            for (const entry of entries) {
                const key = entry.error
                    ? `error:${entry.characterId}`
                    : String(entry.characterAvatar);
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key).push(entry);
            }

            const groupsMarkup = [...grouped.values()].map((items) => {
                const first = items[0];
                const isErrorGroup = Boolean(first.error);
                const characterName = first.characterName || '未知角色';
                const groupCurrent = items.some((item) =>
                    !item.error && JSON.stringify([item.characterAvatar, item.fileName]) === currentKey
                );
                const rows = isErrorGroup
                    ? `<div class="parallel-story-chat-error">${escapeHtml(first.error)}</div>`
                    : items.sort((a, b) => b.fileName.localeCompare(a.fileName)).map((entry) => {
                        const branch = getBranchForChat({ avatar: entry.characterAvatar }, entry.fileName);
                        const legacyBranch = !branch ? store.branches.find((item) =>
                            normalizeChatFile(item.chatFile) === entry.fileName
                            && !item.sourceCharacterAvatar
                            && String(item.sourceCharacterId ?? '') === entry.characterId
                        ) : null;
                        const isBranch = Boolean(branch || legacyBranch);
                        const active = JSON.stringify([entry.characterAvatar, entry.fileName]) === currentKey;
                        const title = branch?.name ?? legacyBranch?.name ?? entry.fileName;
                        const branchMeta = branch || legacyBranch;
                        const detail = isBranch
                            ? `剧情分支 · 来源第 ${Number(branchMeta.sourceMessageId) + 1} 楼`
                            : '普通聊天';
                        const branchId = branchMeta?.id ?? '';
                        return `
                            <article class="parallel-story-item${active ? ' is-active' : ''}">
                                <button class="parallel-story-open" data-action="open-chat" data-character-id="${escapeHtml(entry.characterId)}" data-file="${escapeHtml(entry.fileName)}">
                                    <span class="parallel-story-item-name">${escapeHtml(title)}</span>
                                    <span class="parallel-story-item-meta">${escapeHtml(detail)}${active ? ' · 当前聊天' : ''}</span>
                                </button>
                                <div class="parallel-story-actions">
                                    <button data-action="rename-chat" data-character-id="${escapeHtml(entry.characterId)}" data-avatar="${escapeHtml(entry.characterAvatar)}" data-file="${escapeHtml(entry.fileName)}" title="重命名原生聊天记录">改名</button>
                                    <button data-action="export-chat" data-avatar="${escapeHtml(entry.characterAvatar)}" data-file="${escapeHtml(entry.fileName)}" title="导出原生 JSONL">导出</button>
                                    ${isBranch && branchId ? `
                                        <button data-action="delete-branch" data-id="${escapeHtml(branchId)}" title="删除分支及原生聊天">删除</button>
                                    ` : ''}
                                </div>
                            </article>`;
                    }).join('');

                return `
                    <section class="parallel-story-group${groupCurrent ? ' is-current' : ''}">
                        <header class="parallel-story-group-header">
                            <div class="parallel-story-group-title">${escapeHtml(characterName)}</div>
                            <div class="parallel-story-group-meta">
                                ${items.length} 份聊天记录
                                ${groupCurrent ? '<span class="parallel-story-current-tag">当前角色</span>' : ''}
                                <button class="parallel-story-import" data-action="import-chat" data-character-id="${escapeHtml(first.characterId)}">导入聊天</button>
                            </div>
                        </header>
                        ${rows || '<div class="parallel-story-empty">暂无聊天记录</div>'}
                    </section>`;
            }).join('');

            const list = root.querySelector('.parallel-story-list');
            const count = root.querySelector('.parallel-story-count');
            count.textContent = `${entries.filter((item) => item.fileName).length} 份聊天记录`;
            list.innerHTML = groupsMarkup || '<div class="parallel-story-empty">还没有可显示的聊天记录</div>';
        } catch (error) {
            console.error('[平行叙事] 读取聊天记录失败：', error);
            const list = root.querySelector('.parallel-story-list');
            if (list) list.innerHTML = `<div class="parallel-story-empty">${escapeHtml(error.message || '读取聊天记录失败')}</div>`;
            const count = root.querySelector('.parallel-story-count');
            if (count) count.textContent = '读取失败';
        }
    }

    async function createCurrentBranch() {
        const context = getContext();
        if (!context?.chat?.length) {
            showNotice('当前聊天没有可供分支的楼层。', 'warning');
            return;
        }

        const sourceMessageId = context.chat.length - 1;
        const suggested = `第 ${sourceMessageId + 1} 楼分支`;
        const name = window.prompt('给这条平行剧情命名：', suggested)?.trim();
        if (!name) return;

        try {
            const { createBranch, openCharacterChat } = await loadNativeApis();
            const chatFile = await createBranch(sourceMessageId);
            if (!chatFile || typeof chatFile !== 'string') {
                throw new Error('酒馆没有返回新分支的聊天文件名，暂未写入索引。');
            }

            const store = getStore();
            const sourceScope = getCurrentScope(context);
            store.branches.push({
                id: makeId(),
                name,
                chatFile,
                parentId: getCurrentBranchId(),
                sourceCharacterId: sourceScope.characterId,
                sourceCharacterName: sourceScope.characterName,
                sourceCharacterAvatar: sourceScope.characterAvatar,
                sourceChatFile: sourceScope.chatFile,
                // Keep the old field for compatibility with existing local indexes.
                sourceChat: sourceScope.chatFile,
                sourceMessageId,
                createdAt: Date.now(),
            });
            saveStore();
            await openCharacterChat(chatFile);
            renderManager();
            showNotice('平行剧情已创建。', 'success');
        } catch (error) {
            console.error('[平行叙事] 创建分支失败：', error);
            showNotice(error?.message ?? '创建分支失败，请检查控制台。', 'error');
        }
    }

    async function handleManagerClick(event) {
        const button = event.target.closest('button[data-action]');
        if (!button) return;

        const action = button.dataset.action;
        const id = button.dataset.id;
        const store = getStore();
        const branch = store.branches.find((item) => item.id === id);

        if (action === 'close') return closeManager();
        if (action === 'create') return createCurrentBranch();

        if (action === 'import-chat') {
            const characterId = button.dataset.characterId;
            const picker = document.createElement('input');
            picker.type = 'file';
            picker.accept = '.jsonl,.json,application/json,application/x-ndjson';
            picker.hidden = true;
            picker.addEventListener('change', () => {
                const selected = picker.files?.[0];
                picker.remove();
                if (selected) importNativeChat(selected, characterId);
            }, { once: true });
            document.body.append(picker);
            picker.click();
            return;
        }

        if (action === 'export-chat') {
            try { await exportNativeChat(button.dataset.avatar, button.dataset.file); showNotice('原生聊天记录已导出。', 'success'); }
            catch (error) { console.error('[平行叙事] 导出聊天记录失败：', error); showNotice(error?.message || '导出失败。', 'error'); }
            return;
        }

        if (action === 'rename-chat') {
            try {
                const renamed = await renameNativeChat(button.dataset.characterId, button.dataset.avatar, button.dataset.file);
                if (renamed) { await renderManager(); showNotice('原生聊天记录名称已更新。', 'success'); }
            } catch (error) { console.error('[平行叙事] 重命名聊天记录失败：', error); showNotice(error?.message || '重命名失败。', 'error'); }
            return;
        }

        if (action === 'open-chat') {
            try {
                const context = getContext();
                const { selectCharacterById, openCharacterChat } = await loadNativeApis();
                const characterId = button.dataset.characterId;
                const fileName = button.dataset.file;
                await selectCharacterById(Number(characterId), { switchMenu: false });
                await openCharacterChat(fileName);
                closeManager();
            } catch (error) {
                console.error('[平行叙事] 打开聊天记录失败：', error);
                showNotice(error?.message ?? '无法打开这份聊天记录。', 'error');
            }
            return;
        }

        if (!branch) return;

        if (action === 'delete-branch') {
            const context = getContext();
            const owner = getBranchCharacter(branch, context);
            if (!owner?.character?.avatar) {
                showNotice('无法确定这条分支所属的角色，已停止删除以保护聊天记录。', 'error');
                return;
            }

            const scope = getCurrentScope(context);
            const branchFile = normalizeChatFile(branch.chatFile);
            if (scope.characterAvatar === owner.character.avatar && scope.chatFile === branchFile) {
                showNotice('这条分支当前正处于打开状态。请先切换到其他聊天，再删除它。', 'warning');
                return;
            }

            const confirmed = window.confirm(
                `确定删除分支「${branch.name}」吗？\n\n这会永久删除对应的酒馆原生聊天记录，不能通过平行叙事恢复。`
            );
            if (!confirmed) return;

            try {
                const { getRequestHeaders } = await loadNativeApis();
                const response = await fetch('/api/chats/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        chatfile: `${branchFile}.jsonl`,
                        avatar_url: owner.character.avatar,
                    }),
                });
                if (!response.ok) {
                    throw new Error(`酒馆删除聊天文件失败（${response.status}）`);
                }

                if (context.eventSource && context.eventTypes?.CHAT_DELETED) {
                    await context.eventSource.emit(context.eventTypes.CHAT_DELETED, branchFile);
                }
                store.branches = store.branches.filter((item) => item.id !== id);
                // Children remain available, but are no longer shown as descendants of a deleted parent.
                for (const child of store.branches) {
                    if (child.parentId === id) child.parentId = null;
                }
                saveStore();
                await renderManager();
                showNotice('分支及对应的原生聊天记录已删除。', 'success');
            } catch (error) {
                console.error('[平行叙事] 删除分支失败：', error);
                showNotice(error?.message ?? '删除失败，索引未移除。', 'error');
            }
        }
    }

    function installMenuEntry() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById(MENU_ID)) return false;

        const entry = document.createElement('div');
        entry.id = MENU_ID;
        entry.className = 'list-group-item flex-container flexGap5';
        entry.innerHTML = '<i class="fa-solid fa-code-branch"></i><span>聊天记录管理器</span>';
        entry.addEventListener('click', renderManager);
        menu.append(entry);
        return true;
    }

    function init() {
        if (installMenuEntry()) return;
        const observer = new MutationObserver(() => {
            if (installMenuEntry()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();