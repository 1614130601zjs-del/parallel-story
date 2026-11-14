(() => {
    'use strict';

    const EXTENSION_KEY = 'parallel_story';
    const MENU_ID = 'parallel-story-menu-entry';
    const ROOT_ID = 'parallel-story-root';
    let chatEntriesCache = null;
    let chatEntriesPromise = null;

    function invalidateChatEntriesCache() {
        chatEntriesCache = null;
        chatEntriesPromise = null;
    }

    async function getCachedChatEntries() {
        if (chatEntriesCache) return chatEntriesCache;
        if (!chatEntriesPromise) {
            chatEntriesPromise = collectChatEntries()
                .then((entries) => {
                    chatEntriesCache = entries;
                    return entries;
                })
                .catch((error) => {
                    chatEntriesPromise = null;
                    throw error;
                });
        }
        return chatEntriesPromise;
    }

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

    function extractFloorContent(value) {
        const raw = String(value ?? '');

        // Explicit content blocks take priority over other preset-specific wrappers.
        const contentMatch = raw.match(/<content\b[^>]*>([\s\S]*?)<\/content\s*>/i);
        if (contentMatch) return contentMatch[1].trim();

        // Some presets wrap internal reasoning in <draft> and use --> as
        // the boundary before the actual user-facing response.
        const draftStart = raw.search(/<draft\b[^>]*>/i);
        if (draftStart >= 0) {
            const separator = raw.indexOf('-->', draftStart);
            if (separator >= 0) {
                return raw.slice(separator + 3).replace(/<\/draft\s*>/gi, '').trim();
            }
            // Never expose an unfinished draft/COT block as the floor preview.
            return raw.slice(0, draftStart).trim();
        }

        return raw.trim();
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
        if (!Array.isArray(context?.characters) || context.characters.length === 0) {
            throw new Error('酒馆角色卡列表尚未加载完成，稍后会重新读取聊天记录');
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
        invalidateChatEntriesCache();
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
            invalidateChatEntriesCache();
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

    function renderFloorPage(root) {
        const list = root.querySelector('.parallel-story-list');
        if (!list) return;
        const all = root._floorData || [];
        const query = String(root._floorQuery || '').trim().toLowerCase();
        const filtered = all.filter((message, index) => {
            if (!query) return true;
            const text = [index + 1, message?.name, extractFloorContent(message?.mes), message?.is_user ? '用户 user' : '角色 assistant'].join(' ').toLowerCase();
            return text.includes(query);
        });
        const pageSize = 40;
        const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
        root._floorPage = Math.min(Math.max(0, root._floorPage || 0), pageCount - 1);
        const start = root._floorPage * pageSize;
        const page = filtered.slice(start, start + pageSize);
        const entry = root._floorEntry;
        const context = getContext();
        const character = getCharacter(context, entry.characterId);
        const heading = `
            <div class="parallel-story-floor-heading">
                <button class="parallel-story-back" data-action="back-floor-chat">‹ 返回聊天记录</button>
                <div class="parallel-story-selected-character">
                    <img src="/characters/${encodeURIComponent(entry.characterAvatar)}" alt="">
                    <span>${escapeHtml(character?.name || entry.characterName)} · 楼层目录</span>
                </div>
            </div>
            <input class="parallel-story-floor-search" type="search" placeholder="搜索楼层编号或消息内容…" value="${escapeHtml(root._floorQuery || '')}">
            <div class="parallel-story-floor-summary">共 ${all.length} 楼 · 显示 ${filtered.length} 条匹配记录</div>`;
        const rows = page.map((message) => {
            const index = all.indexOf(message);
            const who = message?.is_system ? '系统' : message?.is_user ? '用户' : (message?.name || entry.characterName || '角色');
            const content = extractFloorContent(message?.mes).replace(/\s+/g, ' ').trim();
            const preview = content ? (content.length > 180 ? content.slice(0, 180) + '…' : content) : (message?.is_system ? '系统消息' : '（此楼没有可预览的文字）');
            return `
                <button class="parallel-story-floor-row" data-action="jump-floor" data-index="${index}">
                    <span class="parallel-story-floor-number">${index + 1}</span>
                    <span class="parallel-story-floor-content">
                        <span class="parallel-story-floor-author">${escapeHtml(who)}</span>
                        <span class="parallel-story-floor-preview">${escapeHtml(preview)}</span>
                    </span>
                    <span class="parallel-story-floor-arrow">›</span>
                </button>`;
        }).join('');
        const pager = `
            <div class="parallel-story-floor-pager">
                <button data-action="floor-page" data-page="${root._floorPage - 1}" ${root._floorPage <= 0 ? 'disabled' : ''}>上一页</button>
                <span>第 ${root._floorPage + 1} / ${pageCount} 页</span>
                <button data-action="floor-page" data-page="${root._floorPage + 1}" ${root._floorPage >= pageCount - 1 ? 'disabled' : ''}>下一页</button>
            </div>`;
        list.innerHTML = heading + (rows || '<div class="parallel-story-empty">没有找到匹配的楼层</div>') + pager;
        const search = list.querySelector('.parallel-story-floor-search');
        search?.addEventListener('input', () => {
            root._floorQuery = search.value;
            root._floorPage = 0;
            const position = search.selectionStart;
            renderFloorPage(root);
            const next = list.querySelector('.parallel-story-floor-search');
            next?.focus();
            try { next?.setSelectionRange(position, position); } catch (_) {}
        });
    }

    async function showFloorPicker(root, entry) {
        const list = root.querySelector('.parallel-story-list');
        const count = root.querySelector('.parallel-story-count');
        if (list) list.innerHTML = '<div class="parallel-story-empty">正在读取这份聊天的楼层…</div>';
        if (count) count.textContent = '读取楼层中…';
        try {
            const { getRequestHeaders } = await loadNativeApis();
            const response = await fetch('/api/chats/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                cache: 'no-cache',
                body: JSON.stringify({
                    ch_name: entry.characterName,
                    file_name: normalizeChatFile(entry.fileName),
                    avatar_url: entry.characterAvatar,
                }),
            });
            if (!response.ok) throw new Error(`读取聊天楼层失败（${response.status}）`);
            const messages = await response.json();
            if (!Array.isArray(messages)) throw new Error('酒馆返回的聊天内容格式不正确');
            root._floorEntry = entry;
            root._floorData = messages;
            root._floorQuery = '';
            root._floorPage = Math.max(0, Math.ceil(messages.length / 40) - 1);
            if (count) count.textContent = `${messages.length} 楼`;
            renderFloorPage(root);
        } catch (error) {
            console.error('[平行叙事] 读取楼层目录失败：', error);
            if (list) list.innerHTML = `<div class="parallel-story-empty">${escapeHtml(error?.message || '读取楼层目录失败')}</div>`;
            if (count) count.textContent = '读取失败';
        }
    }

    async function jumpToNativeFloor(entry, messageIndex) {
        const targetIndex = Number(messageIndex);
        if (!Number.isInteger(targetIndex) || targetIndex < 0) {
            throw new Error('目标楼层编号无效。');
        }

        const targetChatFile = normalizeChatFile(entry.fileName);
        const { selectCharacterById, openCharacterChat } = await loadNativeApis();

        await selectCharacterById(Number(entry.characterId), { switchMenu: false });
        await openCharacterChat(targetChatFile);

        // openCharacterChat resolves after loading the chat data, but wait for
        // the active context to reflect the requested file before running chat-jump.
        const waitUntil = Date.now() + 10000;
        let activeContext = getContext();
        while (Date.now() < waitUntil) {
            activeContext = getContext();
            const activeFile = normalizeChatFile(getCurrentChatFile(activeContext));
            if (activeFile === targetChatFile && Array.isArray(activeContext?.chat)) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        activeContext = getContext();
        if (normalizeChatFile(getCurrentChatFile(activeContext)) !== targetChatFile) {
            throw new Error('目标聊天没有成功打开，请重试。');
        }
        if (!Array.isArray(activeContext?.chat) || targetIndex >= activeContext.chat.length) {
            throw new Error(`目标楼层不存在：当前聊天共 ${activeContext?.chat?.length ?? 0} 楼。`);
        }

        const slashCommands = await import('/scripts/slash-commands.js');
        if (typeof slashCommands.executeSlashCommandsWithOptions !== 'function') {
            throw new Error('当前酒馆没有提供原生楼层跳转命令接口（slash-commands.js）');
        }

        await slashCommands.executeSlashCommandsWithOptions(`/chat-jump ${targetIndex}`);

        // The native command can finish without throwing even when it cannot
        // find the message element. Verify the target is actually rendered.
        const renderDeadline = Date.now() + 5000;
        let targetElement = null;
        while (Date.now() < renderDeadline) {
            targetElement = document.querySelector(`#chat .mes[mesid="${targetIndex}"]`);
            if (targetElement) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const chatContainer = document.getElementById('chat');
        if (!targetElement || !chatContainer) {
            throw new Error('聊天已打开，但酒馆没有渲染目标楼层。请稍后重试。');
        }

        const elementRect = targetElement.getBoundingClientRect();
        const containerRect = chatContainer.getBoundingClientRect();
        chatContainer.scrollTo({
            top: elementRect.top - containerRect.top + chatContainer.scrollTop,
            behavior: 'smooth',
        });
    }

    function renderCharacterCards(root, entries) {
        const context = getContext();
        const characters = (context?.characters ?? []).map((character, index) => ({
            character,
            id: String(index),
            chats: entries.filter((entry) => entry.characterId === String(index) && entry.fileName),
            error: entries.find((entry) => entry.characterId === String(index) && entry.error)?.error,
        })).filter((item) => item.character?.avatar);

        // Keep characters with saved chats above empty ones, and pin the
        // character belonging to the currently active conversation.
        const currentScope = getCurrentScope(context);
        characters.sort((a, b) => {
            const aHasChats = a.chats.length > 0;
            const bHasChats = b.chats.length > 0;
            if (aHasChats !== bHasChats) return aHasChats ? -1 : 1;

            const aIsCurrent = a.id === currentScope.characterId;
            const bIsCurrent = b.id === currentScope.characterId;
            if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;

            return 0;
        });

        const list = root.querySelector('.parallel-story-list');
        const count = root.querySelector('.parallel-story-count');
        if (count) count.textContent = `${characters.length} 位角色`;
        if (!list) return;

        list.innerHTML = characters.length ? `
            <div class="parallel-story-character-grid">
                ${characters.map(({ character, id, chats }) => `
                    <button class="parallel-story-character-card" data-action="select-character" data-character-id="${escapeHtml(id)}">
                        <img class="parallel-story-character-avatar" src="/characters/${encodeURIComponent(character.avatar)}" alt="" loading="lazy">
                        <span class="parallel-story-character-info">
                            <span class="parallel-story-character-name">${escapeHtml(character.name || '未命名角色')}</span>
                            <span class="parallel-story-character-count">${chats.length} 份聊天记录</span>
                        </span>
                        <span class="parallel-story-character-arrow">›</span>
                    </button>
                `).join('')}
            </div>` : '<div class="parallel-story-empty">酒馆中还没有可管理的角色卡</div>';
    }

    function renderCharacterChats(root, entries, characterId) {
        const context = getContext();
        const character = getCharacter(context, characterId);
        if (!character) {
            renderCharacterCards(root, entries);
            return;
        }

        const currentScope = getCurrentScope(context);
        const currentKey = JSON.stringify([currentScope.characterAvatar, currentScope.chatFile]);
        const chats = entries.filter((entry) => entry.characterId === String(characterId));
        const list = root.querySelector('.parallel-story-list');
        const count = root.querySelector('.parallel-story-count');
        if (count) count.textContent = `${chats.filter((item) => item.fileName).length} 份聊天记录`;

        const rows = chats.map((entry) => {
            if (entry.error) return `<div class="parallel-story-chat-error">${escapeHtml(entry.error)}</div>`;
            if (!entry.fileName) return '';
            const branch = getBranchForChat({ avatar: entry.characterAvatar }, entry.fileName);
            const legacyBranch = !branch ? getStore().branches.find((item) =>
                normalizeChatFile(item.chatFile) === entry.fileName
                && !item.sourceCharacterAvatar
                && String(item.sourceCharacterId ?? '') === entry.characterId
            ) : null;
            const branchMeta = branch || legacyBranch;
            const isBranch = Boolean(branchMeta);
            const active = JSON.stringify([entry.characterAvatar, entry.fileName]) === currentKey;
            const title = branchMeta?.name ?? entry.fileName;
            const detail = isBranch
                ? `剧情分支 · 来源第 ${Number(branchMeta.sourceMessageId) + 1} 楼`
                : '普通聊天';
            return `
                <article class="parallel-story-item${active ? ' is-active' : ''}">
                    <button class="parallel-story-open" data-action="open-chat" data-character-id="${escapeHtml(entry.characterId)}" data-file="${escapeHtml(entry.fileName)}">
                        <span class="parallel-story-item-name">${escapeHtml(title)}</span>
                        <span class="parallel-story-item-meta">${escapeHtml(detail)}${active ? ' · 当前聊天' : ''}</span>
                    </button>
                    <div class="parallel-story-actions">
                        <button data-action="rename-chat" data-character-id="${escapeHtml(entry.characterId)}" data-avatar="${escapeHtml(entry.characterAvatar)}" data-file="${escapeHtml(entry.fileName)}" title="重命名原生聊天记录">改名</button>
                        <button data-action="export-chat" data-avatar="${escapeHtml(entry.characterAvatar)}" data-file="${escapeHtml(entry.fileName)}" title="导出原生 JSONL">导出</button>
                        ${!active && isBranch && branchMeta?.id
                            ? `<button data-action="delete-branch" data-id="${escapeHtml(branchMeta.id)}" title="删除分支及原生聊天">删除</button>`
                            : !active && !isBranch ? `<button data-action="delete-chat" data-character-id="${escapeHtml(entry.characterId)}" data-avatar="${escapeHtml(entry.characterAvatar)}" data-file="${escapeHtml(entry.fileName)}" title="删除原生聊天记录">删除</button>` : ''}
                    </div>
                </article>`;
        }).join('');

        if (list) list.innerHTML = `
            <div class="parallel-story-character-heading">
                <button class="parallel-story-back" data-action="back-characters">‹ 所有角色</button>
                <div class="parallel-story-selected-character">
                    <img src="/characters/${encodeURIComponent(character.avatar)}" alt="" loading="lazy">
                    <span>${escapeHtml(character.name || '未命名角色')}</span>
                </div>
                <button class="parallel-story-import" data-action="import-chat" data-character-id="${escapeHtml(characterId)}">导入聊天</button>
            </div>
            ${rows || '<div class="parallel-story-empty">这个角色还没有聊天记录</div>'}`;
    }

    async function renderManager() {
        closeManager();

        const root = document.createElement('div');
        root.id = ROOT_ID;
        root.className = 'parallel-story-backdrop';
        root.innerHTML = `
            <section class="parallel-story-panel" role="dialog" aria-modal="true" aria-label="平行叙事">
                <header class="parallel-story-header">
                    <div>
                        <div class="parallel-story-title">平行叙事</div>
                        <div class="parallel-story-subtitle">选择角色卡，管理对应聊天记录</div>
                    </div>
                    <button class="parallel-story-icon-button" data-action="close" aria-label="关闭">×</button>
                </header>
                <div class="parallel-story-toolbar">
                    <button class="parallel-story-primary" data-action="create">＋ 从当前聊天创建剧情分支</button>
                    <span class="parallel-story-count">正在读取…</span>
                </div>
                <div class="parallel-story-list"><div class="parallel-story-empty">正在读取酒馆角色卡</div></div>
                <footer class="parallel-story-footer">聊天正文仍由酒馆原生管理。普通聊天和剧情分支均可重命名、导出或删除；当前打开的聊天不能删除。</footer>
            </section>`;
        root.addEventListener('click', (event) => {
            if (event.target === root) return closeManager();
            const button = event.target.closest('button[data-action]');
            if (!button) return;
            if (button.dataset.action === 'select-character') {
                root.dataset.selectedCharacterId = button.dataset.characterId;
                renderCharacterChats(root, root._entries || [], button.dataset.characterId);
                return;
            }
            if (button.dataset.action === 'back-characters') {
                delete root.dataset.selectedCharacterId;
                renderCharacterCards(root, root._entries || []);
                return;
            }
            handleManagerClick(event);
        });
        document.body.append(root);

        try {
            root._entries = await getCachedChatEntries();
            if (!root.isConnected) return;
            renderCharacterCards(root, root._entries);
        } catch (error) {
            console.error('[平行叙事] 读取聊天记录失败：', error);
            const list = root.querySelector('.parallel-story-list');
            if (list) list.innerHTML = `<div class="parallel-story-empty">${escapeHtml(error.message || '读取聊天记录失败')}</div>`;
            const count = root.querySelector('.parallel-story-count');
            if (count) count.textContent = '读取失败';
        }
    }

    async function createBranchFromMessage(sourceMessageId) {
        const context = getContext();
        if (!context?.chat?.length) {
            showNotice('当前聊天没有可供分支的楼层。', 'warning');
            return;
        }

        sourceMessageId = Number(sourceMessageId);
        if (!Number.isInteger(sourceMessageId) || sourceMessageId < 0 || sourceMessageId >= context.chat.length) {
            showNotice('找不到对应楼层，无法创建分支。', 'warning');
            return;
        }
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
            invalidateChatEntriesCache();
            await openCharacterChat(chatFile);
            renderManager();
            showNotice('平行剧情已创建。', 'success');
        } catch (error) {
            console.error('[平行叙事] 创建分支失败：', error);
            showNotice(error?.message ?? '创建分支失败，请检查控制台。', 'error');
        }
    }

    async function createCurrentBranch() {
        const context = getContext();
        if (!context?.chat?.length) {
            showNotice('当前聊天没有可供分支的楼层。', 'warning');
            return;
        }
        return createBranchFromMessage(context.chat.length - 1);
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

        if (action === 'delete-chat') {
            const context = getContext();
            const characterId = button.dataset.characterId;
            const avatar = button.dataset.avatar;
            const fileName = normalizeChatFile(button.dataset.file);
            const scope = getCurrentScope(context);
            if (scope.characterAvatar === avatar && scope.chatFile === fileName) {
                showNotice('这份聊天记录当前正处于打开状态。请先切换到其他聊天，再删除它。', 'warning');
                return;
            }
            const confirmed = window.confirm(
                `确定永久删除普通聊天记录「${fileName}」吗？\\n\\n这会同步删除酒馆原生聊天文件，无法通过平行叙事恢复。`
            );
            if (!confirmed) return;
            try {
                const { getRequestHeaders } = await loadNativeApis();
                const response = await fetch('/api/chats/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ chatfile: `${fileName}.jsonl`, avatar_url: avatar }),
                });
                if (!response.ok) throw new Error(`酒馆删除聊天文件失败（${response.status}）`);
                const removedIds = store.branches.filter((item) =>
                    normalizeChatFile(item.chatFile) === fileName
                    && (item.sourceCharacterAvatar ? item.sourceCharacterAvatar === avatar : String(item.sourceCharacterId ?? '') === String(characterId))
                ).map((item) => item.id);
                store.branches = store.branches.filter((item) => !removedIds.includes(item.id));
                for (const child of store.branches) {
                    if (removedIds.includes(child.parentId)) child.parentId = null;
                }
                saveStore();
                invalidateChatEntriesCache();
                await renderManager();
                showNotice('原生聊天记录已删除。', 'success');
            } catch (error) {
                console.error('[平行叙事] 删除原生聊天失败：', error);
                showNotice(error?.message || '删除失败。', 'error');
            }
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
            const root = document.getElementById(ROOT_ID);
            const entry = (root?._entries || []).find((item) =>
                item.characterId === button.dataset.characterId
                && item.fileName === normalizeChatFile(button.dataset.file)
            );
            if (root && entry) await showFloorPicker(root, entry);
            return;
        }

        if (action === 'back-floor-chat') {
            const root = document.getElementById(ROOT_ID);
            if (root) renderCharacterChats(root, root._entries || [], root._floorEntry.characterId);
            return;
        }

        if (action === 'floor-page') {
            const root = document.getElementById(ROOT_ID);
            if (root) {
                root._floorPage = Number(button.dataset.page);
                renderFloorPage(root);
            }
            return;
        }

        if (action === 'jump-floor') {
            const root = document.getElementById(ROOT_ID);
            const entry = root?._floorEntry;
            const messageIndex = Number(button.dataset.index);
            if (!entry || !Number.isInteger(messageIndex) || messageIndex < 0) return;
            try {
                await jumpToNativeFloor(entry, messageIndex);
                closeManager();
            } catch (error) {
                console.error('[平行叙事] 跳转楼层失败：', error);
                showNotice(error?.message || '无法跳转到指定楼层。', 'error');
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

                store.branches = store.branches.filter((item) => item.id !== id);
                // Children remain available, but are no longer shown as descendants of a deleted parent.
                for (const child of store.branches) {
                    if (child.parentId === id) child.parentId = null;
                }
                saveStore();
                invalidateChatEntriesCache();
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

    function installMessageBranchButtons() {
        const chatRoot = document.getElementById('chat');
        if (!chatRoot) return false;
        const messages = chatRoot.querySelectorAll('.mes[mesid]:not([is_system="true"])');
        for (const message of messages) {
            const toolbar = message.querySelector('.mes_buttons');
            if (!toolbar || toolbar.querySelector('.parallel-story-floor-branch')) continue;
            const button = document.createElement('div');
            button.className = 'mes_button parallel-story-floor-branch fa-solid fa-code-branch';
            button.title = '从这一楼创建剧情分支';
            button.setAttribute('role', 'button');
            button.setAttribute('tabindex', '0');
            button.setAttribute('aria-label', '从这一楼创建剧情分支');
            const activate = (event) => {
                event.preventDefault();
                event.stopPropagation();
                createBranchFromMessage(Number(message.getAttribute('mesid')));
            };
            button.addEventListener('click', activate);
            button.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') activate(event);
            });
            toolbar.append(button);
        }
        return true;
    }

    async function installNativeChatSync() {
        const { eventSource, event_types } = await import('/scripts/events.js');
        const chatListEvents = [
            event_types.CHAT_CREATED,
            event_types.CHAT_DELETED,
            event_types.CHAT_RENAMED,
        ].filter(Boolean);

        const syncChatEntries = async () => {
            // Native chat management can change files outside this extension.
            // Invalidate only when SillyTavern announces a real list mutation.
            invalidateChatEntriesCache();
            try {
                const entries = await getCachedChatEntries();
                const root = document.getElementById(ROOT_ID);
                if (!root || root._floorEntry) return;
                root._entries = entries;
                const selectedCharacterId = root.dataset.selectedCharacterId;
                if (selectedCharacterId !== undefined) {
                    renderCharacterChats(root, entries, selectedCharacterId);
                } else {
                    renderCharacterCards(root, entries);
                }
            } catch (error) {
                console.warn('[平行叙事] 同步原生聊天记录失败：', error);
            }
        };

        for (const eventName of chatListEvents) {
            eventSource.on(eventName, syncChatEntries);
        }

        // The native welcome-screen delete flow may not emit CHAT_DELETED
        // for ordinary character chats. Observe successful delete requests too.
        const originalFetch = window.fetch;
        if (typeof originalFetch === 'function' && !originalFetch.__parallelStoryChatSync) {
            const syncedFetch = async function (...args) {
                const request = args[0];
                const requestUrl = String(
                    typeof request === 'string' ? request : (request?.url ?? request ?? '')
                );
                const response = await originalFetch.apply(this, args);
                if (response.ok && requestUrl.includes('/api/chats/delete')) {
                    Promise.resolve(eventSource.emit(event_types.CHAT_DELETED, null))
                        .catch((error) => console.warn('[平行叙事] 删除后同步聊天缓存失败：', error));
                }
                return response;
            };
            syncedFetch.__parallelStoryChatSync = true;
            window.fetch = syncedFetch;
        }

        window.addEventListener('pagehide', () => {
            for (const eventName of chatListEvents) {
                eventSource.removeListener?.(eventName, syncChatEntries);
            }
        }, { once: true });
    }

    function init() {
        installMenuEntry();
        installMessageBranchButtons();
        installNativeChatSync().catch((error) => {
            console.warn('[平行叙事] 无法监听酒馆原生聊天记录变化：', error);
        });
        // Wait for SillyTavern to finish loading character cards before caching chats.
        // An early empty character list must never become a permanent empty cache.
        const preloadChatsWhenReady = async () => {
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                const characters = getContext()?.characters;
                if (Array.isArray(characters) && characters.length > 0) {
                    try {
                        await getCachedChatEntries();
                    } catch (error) {
                        console.warn('[平行叙事] 启动时预加载聊天记录失败，打开管理器时将重试：', error);
                    }
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            console.warn('[平行叙事] 等待酒馆角色卡列表超时；打开管理器时会重新读取聊天记录。');
        };
        preloadChatsWhenReady();
        const observer = new MutationObserver(() => {
            installMenuEntry();
            installMessageBranchButtons();
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