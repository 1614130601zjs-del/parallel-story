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
        return String(fileName ?? '').replace(/\\.jsonl$/i, '');
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

    async function fetchCharacterChats(context, character, characterId) {
        if (!character?.avatar) return [];
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
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
        if (!context?.characters || typeof context.getRequestHeaders !== 'function') {
            throw new Error('当前酒馆没有提供读取角色聊天记录所需的接口');
        }

        const all = await Promise.all(context.characters.map(async (character, index) => {
            if (!character?.avatar) return [];
            try {
                return await fetchCharacterChats(context, character, index);
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

    function renderManager() {
        closeManager();

        const store = getStore();
        const currentScope = getCurrentScope();
        const currentKey = JSON.stringify([currentScope.characterId, currentScope.chatFile]);
        const branches = [...store.branches].sort((a, b) => b.createdAt - a.createdAt);
        const grouped = new Map();

        for (const branch of branches) {
            const key = getBranchGroupKey(branch);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(branch);
        }

        const groupMarkup = [...grouped.entries()].map(([key, items]) => {
            const first = items[0];
            const legacy = !first.sourceCharacterName && !first.sourceCharacterId;
            const characterName = legacy ? '旧版分支（来源待识别）' : (first.sourceCharacterName || '未知角色');
            const chatFile = first.sourceChatFile ?? first.sourceChat ?? '';
            const isCurrent = key === currentKey;
            return `
                <section class="parallel-story-group${isCurrent ? ' is-current' : ''}">
                    <header class="parallel-story-group-header">
                        <div class="parallel-story-group-title">${escapeHtml(characterName)}</div>
                        <div class="parallel-story-group-meta">
                            ${escapeHtml(chatFile ? `聊天记录：${chatFile}` : '聊天记录：未记录')}
                            ${isCurrent ? '<span class="parallel-story-current-tag">当前聊天</span>' : ''}
                        </div>
                    </header>
                    ${items.map((branch) => {
                        const parent = branch.parentId
                            ? store.branches.find((item) => item.id === branch.parentId)
                            : null;
                        return `
                            <article class="parallel-story-item" data-id="${escapeHtml(branch.id)}">
                                <button class="parallel-story-open" data-action="open" data-id="${escapeHtml(branch.id)}">
                                    <span class="parallel-story-item-name">${escapeHtml(branch.name)}</span>
                                    <span class="parallel-story-item-meta">${parent ? `来自「${escapeHtml(parent.name)}」` : '来自原始剧情'} · 第 ${Number(branch.sourceMessageId) + 1} 楼</span>
                                </button>
                                <div class="parallel-story-actions">
                                    <button data-action="rename" data-id="${escapeHtml(branch.id)}" title="重命名">改名</button>
                                    <button data-action="remove" data-id="${escapeHtml(branch.id)}" title="从管理器移除">移除</button>
                                </div>
                            </article>`;
                    }).join('')}
                </section>`;
        }).join('');

        const root = document.createElement('div');
        root.id = ROOT_ID;
        root.className = 'parallel-story-backdrop';
        root.innerHTML = `
            <section class="parallel-story-panel" role="dialog" aria-modal="true" aria-label="平行叙事">
                <header class="parallel-story-header">
                    <div>
                        <div class="parallel-story-title">平行叙事</div>
                        <div class="parallel-story-subtitle">按角色和独立聊天记录整理剧情分支</div>
                    </div>
                    <button class="parallel-story-icon-button" data-action="close" aria-label="关闭">×</button>
                </header>
                <div class="parallel-story-toolbar">
                    <button class="parallel-story-primary" data-action="create">＋ 创建当前楼层分支</button>
                    <span class="parallel-story-count">${branches.length} 条分支</span>
                </div>
                <div class="parallel-story-list">
                    ${branches.length ? groupMarkup : '<div class="parallel-story-empty">还没有平行剧情<br><span>从当前聊天创建第一条分支</span></div>'}
                </div>
                <footer class="parallel-story-footer">每条分支会记录来源角色、聊天记录和楼层；聊天正文仍由酒馆原生功能保存。</footer>
            </section>`;
        root.addEventListener('click', handleManagerClick);
        root.addEventListener('click', (event) => {
            if (event.target === root) closeManager();
        });
        document.body.append(root);
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
        if (!branch) return;

        if (action === 'open') {
            try {
                const { openCharacterChat } = await loadNativeApis();
                await openCharacterChat(branch.chatFile);
                closeManager();
            } catch (error) {
                console.error('[平行叙事] 打开分支失败：', error);
                showNotice(error?.message ?? '无法打开这条原生聊天记录。', 'error');
            }
        }

        if (action === 'rename') {
            const nextName = window.prompt('修改分支名称：', branch.name)?.trim();
            if (!nextName) return;
            branch.name = nextName;
            saveStore();
            renderManager();
        }

        if (action === 'remove') {
            const confirmed = window.confirm('只从平行叙事管理器中移除此条索引？原生聊天记录不会被删除。');
            if (!confirmed) return;
            store.branches = store.branches.filter((item) => item.id !== id);
            saveStore();
            renderManager();
        }
    }

    function installMenuEntry() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById(MENU_ID)) return false;

        const entry = document.createElement('div');
        entry.id = MENU_ID;
        entry.className = 'list-group-item flex-container flexGap5';
        entry.innerHTML = '<i class="fa-solid fa-code-branch"></i><span>平行叙事</span>';
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