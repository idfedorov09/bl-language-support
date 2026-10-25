const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { withinRoot } = require('./guidNavigation');
const { resourceFamily } = require('./localizationModel');
const { localizationLiterals } = require('./localizationPresentation');
const { createDraft, updateRow, serializeDraft, restoreDraft, MAX_DRAFT } = require('./i18nDraft');
const { fingerprint, translationEdits } = require('./localizationEdits');
const { renderI18nView } = require('./i18nView');
const ai = require('./i18nAi');
const resources = require('./i18nResources');
const rename = require('./i18nRename');
const STORE = 'z8bl.i18n.drafts.v1';
function createI18nToolkit(vscode, localization, context) {
    ai.registerCredentials(vscode, context);
    const panels = new Map(), renameReservations = new Set();
    let disposed = false, storageQueue = Promise.resolve();
    const storage = context.workspaceState;
    const stored = Object.assign(Object.create(null), storage.get(STORE, {}));
    function persist(id, draft) {
        const saved = serializeDraft(draft);
        const operation = async () => {
            const next = { ...stored };
            if (saved.rows.length) next[id] = saved; else delete next[id];
            if (Object.keys(next).length > 50 || JSON.stringify(next).length > 4194304) throw Error('Лимит локальных черновиков. Отмените ненужные изменения в других ключах.');
            await storage.update(STORE, next);
            for (const key of Object.keys(stored)) delete stored[key]; Object.assign(stored, next);
        };
        const result = storageQueue.then(operation); storageQueue = result.catch(() => {}); return result;
    }
    async function openTranslation(argument) {
        if (disposed) return;
        let doc, key;
        if (argument && typeof argument.sourceUri === 'string' && typeof argument.key === 'string') {
            const uri = vscode.Uri.file(argument.sourceUri);
            if (!vscode.workspace.getWorkspaceFolder(uri) || !uri.fsPath.endsWith('.bl')) return;
            doc = await vscode.workspace.openTextDocument(uri); key = argument.key;
            if (!localizationLiterals(doc.getText()).some(item => item.key === key)) return;
        } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'bl') return;
            doc = editor.document;
            const at = doc.offsetAt(editor.selection.active);
            key = localizationLiterals(doc.getText()).find(item => at >= item.start && at < item.end)?.key;
        }
        if (!key) { await vscode.window.showInformationMessage('Поставьте курсор на локализационный литерал "$Key$".'); return; }
        const state = await localization.freshSnapshot(doc.uri);
        if (!state || disposed) { if (!disposed) await vscode.window.showWarningMessage('Откройте папку проекта с NLS-ресурсами.'); return; }
        return openDraft(doc.uri, key, state);
    }
    // Host-only search entry point. Palette/hover arguments still require a BL literal.
    async function openSearchTranslation(uri, key, expectedRoot, token) {
        if (disposed || token && token.isCancellationRequested || !uri || uri.scheme !== 'file' || typeof key !== 'string' || !vscode.workspace.getWorkspaceFolder(uri)) return;
        const state = await localization.freshSnapshot(uri);
        if (token && token.isCancellationRequested || !state || state.root !== expectedRoot || !localization.isSnapshotCurrent(state) || !state.resources.some(r => !r.issues.length && r.entries.some(entry => entry.key === key))) return;
        return openDraft(uri, key, state);
    }
    async function openDraft(uri, key, state) {
        if (disposed || !localization.isSnapshotCurrent(state)) return;
        let id = fingerprint(state.root + '\0' + key);
        if (panels.has(id)) { panels.get(id).panel.reveal(vscode.ViewColumn.Active, false); return panels.get(id).panel; }
        if (renameReservations.has(id)) { await vscode.window.showInformationMessage('Этот ключ сейчас переименовывается. Дождитесь завершения.'); return; }
        const config = vscode.workspace.getConfiguration('bl', uri);
        const locale = String(config.get('i18n.locale', 'ru')).replace(/_/g, '-').toLowerCase();
        const required = config.get('i18n.requiredLocales', []);
        const saved = stored[id], extraLocales = saved && Array.isArray(saved.rows) ? saved.rows.map(r => r.locale).filter(l => typeof l === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,3})?$/.test(l)) : [];
        let draft = createDraft(state, key, locale, [...required, ...extraLocales]);
        const restored = restoreDraft(draft, saved);
        const panel = vscode.window.createWebviewPanel('z8bl.i18n', `Переводы: ${key}`, vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
        let alive = true, ready = false, busy = false, saving = false, durable = true, generation = 0, lastSequence = 0, preview = null;
        let error = '', errorRecovery = '', notice = restored ? 'Восстановлен локальный черновик. Проверьте ресурсы перед применением.' : 'Нет изменений.';
        const session = crypto.randomBytes(16).toString('hex');
        let queue = Promise.resolve();
        let aiEpoch = 0, candidate = null, run = null, aiOpen = false, aiError = '', aiRecovery = null, proposals = new Map(), acceptanceUndo = null;
        panels.set(id, { panel });
        panel.webview.html = renderI18nView(crypto.randomBytes(16).toString('hex'));
        const send = () => alive && ready && panel.webview.postMessage({ type: 'state', session, sequence: lastSequence,
            generation, key, root: draft.root, locale: draft.locale, resourceSets: draft.resourceSets, canRename: draft.resourceSets.length > 0 && vscode.workspace.isTrusted !== false, renameBlocked: renameBlocked(), canAddLanguage: draft.resourceSets.length > 0 && vscode.workspace.isTrusted !== false, rows: draft.rows, busy, saving, error, errorRecovery, notice,
            ai: { open: aiOpen, running: !!run, error: aiError, recovery: aiError ? aiRecovery : null,
                review: candidate && { token: candidate.token, data: candidate.request.data, url: candidate.request.profile.url, model: candidate.request.profile.model, body: candidate.request.body },
                undo: !!acceptanceUndo,
                proposals: [...proposals].map(([id, item]) => {
                    const row = draft.rows.find(r => r.id === id);
                    const reason = row.stale ? 'Источник изменился. Обновите ресурсы.' : row.status === 'unavailable'
                        ? 'Ресурс недоступен.' : row.revision !== item.revision
                            ? 'Поле изменилось. Запросите перевод заново.' : '';
                    return { row: id, value: item.value, token: item.token, revision: item.revision, reason };
                }) },
            previewKind: preview && preview.kind || 'translations', renameTo: preview && preview.to,
            preview: preview && preview.changes.map(change => ({ locale: change.locale, kind: change.kind, count: change.count, lines: change.lines,
                path: path.relative(draft.root, change.filePath), before: change.before, after: change.after })) });
        function reportAi(failure) {
            aiError = ai.safeError(failure);
            aiRecovery = failure instanceof ai.AiError ? failure.setting ? {type:'settings', setting:failure.setting}
                : failure.code === 'key' ? {type:'key'} : failure.code === 'stale' ? {type:'reload'} : null : null;
        }
        function resourceError(message) { const failure = Error(message); failure.recovery = 'reload'; return failure; }
        function cancelAi() { aiRecovery = null; aiEpoch++; candidate = null; if (run) { run.token.cancel(); run = null; } }
        async function storeDraft() {
            saving = true; send();
            try { await persist(id, draft); durable = true; notice = 'Черновик сохранён локально · Правки ещё не применены.'; }
            catch (_) { durable = false; error = 'Не удалось сохранить локальный черновик. Скопируйте поля перед закрытием или повторите ввод.'; notice = 'Черновик НЕ сохранён.'; }
            finally { saving = false; }
        }
        async function settleAi(active, translations, failure) {
            if (!alive || disposed || run !== active || active.token.cancelled) return;
            if (failure) { run = null; reportAi(failure); send(); return; }
            try {
                if (vscode.workspace.isTrusted === false || ai.signature(ai.profile(vscode)) !== active.profileSignature || generation !== active.generation) throw new ai.AiError('cancel');
                let fresh;
                try { fresh = await checkAiTargets(active.targetLocales); } catch (_) { throw new ai.AiError('stale'); }
                if (!alive || run !== active || active.token.cancelled) return;
                if (vscode.workspace.isTrusted === false || ai.signature(ai.profile(vscode)) !== active.profileSignature) throw new ai.AiError('cancel');
                // Stage all field updates before mutating the draft, respecting the total draft bound.
                const next = { ...draft, rows: draft.rows.map(row => ({ ...row })) }, suggestions = new Map();
                for (const [locale, value] of Object.entries(translations)) {
                    const row = next.rows.find(r => r.locale === locale), captured = active.rows.get(row.id);
                    if (row.options.some(option => !fresh.resources.some(r => r.filePath === option.filePath && !r.issues.length && fingerprint(r.text) === option.hash))) row.stale = true;
                    if (!row.stale && row.revision === captured.revision && !row.edited && row.value === '') {
                        try { updateRow(next, row.id, value, row.target); } catch (_) { throw new ai.AiError('size'); }
                        row.ai = true;
                    } else suggestions.set(row.id, { value, revision: row.revision, token: crypto.randomBytes(16).toString('hex') });
                }
                run = null; draft = next; proposals = suggestions; acceptanceUndo = null; preview = null; aiOpen = false;
                notice = 'ИИ предложил переводы. Проверьте поля перед сохранением.';
                return storeDraft().then(send);
            } catch (failure) { if (run === active) { run = null; reportAi(failure); send(); } }
        }
        function startAi(prepared, credential) {
            acceptanceUndo = null;
            const active = { token: ai.cancellation(), generation, profileSignature: ai.signature(prepared.profile),
                targetLocales: prepared.data.targetLocales.slice(),
                rows: new Map(draft.rows.map(r => [r.id, { revision: r.revision }])) };
            run = active; candidate = null; aiError = ''; send();
            // Do not block the message queue: edits and Cancel remain responsive.
            ai.requestChat(prepared, credential, active.token).then(
                translations => { queue = queue.then(() => settleAi(active, translations)); },
                failure => { queue = queue.then(() => settleAi(active, null, failure)); });
        }
        const configChange = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('bl.i18n.ai')) { cancelAi(); aiError = 'Настройки ИИ изменились. Подготовьте запрос заново.'; send(); }
        });
        async function loadFresh() {
            const fresh = await localization.freshSnapshot(uri);
            if (!fresh || !localization.isSnapshotCurrent(fresh) || fresh.root !== draft.root || !alive || disposed) throw Error('Checkout или workspace изменился. Откройте редактор заново.');
            return fresh;
        }
        function familyRows(fresh) {
            return createDraft(fresh, key, locale, draft.rows.map(row => row.locale)).rows;
        }
        function hasFamilyOptions(row, rows) {
            const current = rows.find(r => r.locale === row.locale);
            return current && current.status !== 'unavailable' && row.options.length > 0
                && row.options.every(option => current.options.some(o => o.filePath === option.filePath));
        }
        async function checkAiTargets(targetLocales) {
            if (!Array.isArray(targetLocales)) throw new ai.AiError('input');
            const fresh = await loadFresh(), rows = familyRows(fresh);
            if (targetLocales.some(language => {
                const row = draft.rows.find(r => r.locale === language);
                return !row || row.stale || !hasFamilyOptions(row, rows);
            })) throw new ai.AiError('stale');
            return fresh;
        }
        async function checkProposalSources(rows) {
            const fresh = await loadFresh(), current = familyRows(fresh);
            for (const row of rows) {
                if (row.stale || row.status === 'unavailable' || !hasFamilyOptions(row, current) || row.options.some(option =>
                    !fresh.resources.some(r => r.filePath === option.filePath && !r.issues.length && fingerprint(r.text) === option.hash))) {
                    row.stale = true;
                    throw resourceError('Источник перевода изменился. Ничего не изменено. Обновите ресурсы.');
                }
            }
            return fresh;
        }
        async function acceptProposals(items) {
            if (run || aiOpen || preview) throw Error('Вернитесь к предложениям перед принятием.');
            if (!Array.isArray(items) || !items.length || items.length > draft.rows.length || new Set(items.map(item => item && item.row)).size !== items.length)
                throw Error('Некорректный выбор предложений.');
            const selected = items.map(item => {
                const proposal = item && proposals.get(item.row), row = item && draft.rows.find(r => r.id === item.row);
                if (!row || !proposal || proposal.token !== item.token || proposal.revision !== item.revision || row.revision !== item.revision)
                    throw Error('Предложение или поле изменилось. Ничего не принято. Запросите перевод заново.');
                return { row, proposal };
            });
            const fresh = await checkProposalSources(selected.map(item => item.row));
            if (!alive || disposed) return;
            if (!localization.isSnapshotCurrent(fresh)) throw resourceError('Ресурсы изменились. Ничего не принято. Повторите проверку.');
            const next = { ...draft, rows: draft.rows.map(row => ({ ...row })) }, undo = [];
            for (const { row, proposal } of selected) {
                updateRow(next, row.id, proposal.value, row.target);
                const accepted = next.rows.find(r => r.id === row.id); accepted.ai = true;
                undo.push({ row: row.id, value: row.value, target: row.target, ai: !!row.ai, revision: accepted.revision, proposal });
            }
            // No mutations/proposal deletion until every selected value fits the bounded draft.
            if (JSON.stringify(serializeDraft(next)).length > MAX_DRAFT) throw Error('Черновик слишком большой для локального хранения.');
            draft = next; acceptanceUndo = undo; preview = null;
            for (const item of selected) proposals.delete(item.row.id);
            await storeDraft();
            if (durable) notice = `Принято переводов: ${selected.length}. Черновик сохранён локально.`;
        }
        async function undoAcceptance() {
            if (!acceptanceUndo || run || aiOpen || preview) return;
            const previous = acceptanceUndo;
            const rows = previous.map(item => draft.rows.find(row => row.id === item.row));
            if (rows.some((row, index) => !row || row.revision !== previous[index].revision)) {
                acceptanceUndo = null; throw Error('После принятия поля изменились. Отмена недоступна; новый ввод сохранён.');
            }
            const fresh = await checkProposalSources(rows);
            if (!alive || disposed) return;
            if (!localization.isSnapshotCurrent(fresh)) throw resourceError('Ресурсы изменились. Отмена не выполнена. Повторите проверку.');
            const next = { ...draft, rows: draft.rows.map(row => ({ ...row })) };
            for (const item of previous) {
                updateRow(next, item.row, item.value, item.target);
                next.rows.find(row => row.id === item.row).ai = item.ai;
            }
            if (JSON.stringify(serializeDraft(next)).length > MAX_DRAFT) throw Error('Черновик слишком большой для локального хранения.');
            draft = next; acceptanceUndo = null; preview = null;
            for (const item of previous) proposals.set(item.row, { ...item.proposal,
                revision: draft.rows.find(row => row.id === item.row).revision, token: crypto.randomBytes(16).toString('hex') });
            await storeDraft();
            if (durable) notice = `Принятие отменено (${previous.length}). Предыдущие значения восстановлены.`;
        }
        async function prepare() {
            if (vscode.workspace.isTrusted === false) throw Error('Для изменения NLS требуется доверенный workspace.');
            const fresh = await loadFresh(), current = familyRows(fresh), changes = [], documents = new Map();
            for (const row of draft.rows.filter(r => r.edited)) {
                const option = row.options.find(o => o.id === row.target);
                if (row.stale || row.status === 'unavailable' || !hasFamilyOptions(row, current)) throw resourceError(`Ресурс ${row.locale} изменился или недоступен. Скопируйте текст и обновите ресурсы.`);
                if (!option) throw Error(`Для ${row.locale} выберите актуальный ресурс.`);
                const resource = fresh.resources.find(r => r.filePath === option.filePath);
                if (!resource || resource.issues.length || fingerprint(resource.text) !== option.hash) {
                    row.stale = true; throw resourceError(`Ресурс ${row.locale} изменился. Скопируйте нужный текст и обновите из ресурсов; черновик сохранён.`);
                }
                if (option.value === row.value) continue;
                const planned = translationEdits(resource, key, row.value, option.entryStart);
                const opened = await vscode.workspace.openTextDocument(vscode.Uri.file(option.filePath));
                if (!alive || disposed || fingerprint(opened.getText()) !== option.hash) throw resourceError('NLS изменился во время подготовки. Обновите ресурсы.');
                if (!documents.has(option.filePath)) documents.set(option.filePath, { document: opened, version: opened.version, hash: option.hash });
                changes.push({ row: row.id, locale: row.locale, filePath: option.filePath, before: option.value, after: row.value, ...planned });
            }
            if (!changes.length) throw Error('Нет изменений для применения.');
            const verified = await loadFresh(), verifiedRows = familyRows(verified);
            if (draft.rows.filter(r => r.edited).some(row => !hasFamilyOptions(row, verifiedRows)))
                throw resourceError('Набор NLS изменился во время подготовки. Обновите из ресурсов.');
            for (const [file, item] of documents) if (!verified.resources.some(r => r.filePath === file && !r.issues.length && fingerprint(r.text) === item.hash))
                throw resourceError('Ресурс или его scope изменился во время подготовки. Обновите из ресурсов.');
            return { changes, documents, revision: draft.revision };
        }
        function renameBlocked(to) {
            if (draft.resourceSets.length > 1 || draft.rows.some(row => row.options.filter(option => option.value !== null).length > 1))
                return 'Неоднозначный ключ: несколько NLS-наборов или повторные записи языка. Сначала разберите источники.';
            if (draft.rows.some(row => row.edited || row.stale) || proposals.size || acceptanceUndo)
                return 'Сначала примените или отмените черновик и предложения ИИ. Переименование их не переносит.';
            if (to) {
                const targetId = fingerprint(draft.root + '\0' + to);
                if (panels.has(targetId) || stored[targetId] && stored[targetId].rows && stored[targetId].rows.length)
                    return 'Для нового ключа уже открыт редактор или сохранён черновик. Сначала разберите его.';
            }
            return '';
        }
        async function renameSnapshot() {
            const fresh = await localization.renameSnapshot(uri);
            if (!fresh || !alive || disposed || fresh.root !== draft.root || localization.rootFor(uri) !== draft.root
                || !localization.isRenameSnapshotCurrent(fresh)) throw resourceError('Исходники или workspace изменились. Повторите переименование.');
            return fresh;
        }
        function renameDocumentsCurrent(planned) {
            return [...planned.documents.values()].every(item => !item.document.isClosed && item.document.version === item.version
                && fingerprint(item.document.getText()) === item.hash && localization.rootFor(item.document.uri) === draft.root);
        }
        async function renamePaths(planned) {
            let realRoot, paths;
            try {
                realRoot = await fs.promises.realpath(draft.root);
                paths = await Promise.all(planned.changes.map(change => fs.promises.realpath(change.filePath)));
            } catch (_) { throw resourceError('Файл rename недоступен или удалён. Повторите проверку.'); }
            if (new Set(paths).size !== paths.length) throw Error('Источник rename доступен через несколько путей. Ничего не переименовано; разберите ссылки/дубли.');
            if (paths.some(file => !withinRoot(file, realRoot))) throw Error('Источник rename через ссылку находится вне checkout. Ничего не переименовано.');
            return JSON.stringify([realRoot, paths]);
        }
        async function prepareRename() {
            if (run || aiOpen || preview || saving) return;
            if (vscode.workspace.isTrusted === false) throw Error('Для переименования требуется доверенный workspace.');
            const blocked = renameBlocked(); if (blocked) throw Error(blocked);
            busy = true; notice = 'Подготовка переименования…'; send();
            const to = await vscode.window.showInputBox({ title: 'Переименовать ключ локализации', value: key,
                prompt: 'Новое имя ключа. Далее — предпросмотр изменений в BL и NLS.', validateInput: value => rename.keyError(key, value) || undefined });
            if (to === undefined || !alive || disposed) { notice = 'Переименование отменено. Файлы не изменены.'; return; }
            const inputError = rename.keyError(key, to); if (inputError) throw Error(inputError);
            const targetBlocked = renameBlocked(to); if (targetBlocked) throw Error(targetBlocked);
            const initial = await renameSnapshot(), planned = rename.renamePlan(initial, key, to), documents = new Map();
            for (const change of planned.changes) {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(change.filePath));
                if (!alive || disposed) return;
                if (fingerprint(document.getText()) !== change.hash) throw resourceError('Исходник изменился во время подготовки. Повторите rename.');
                documents.set(change.filePath, { document, version: document.version, hash: change.hash });
            }
            const realPaths = await renamePaths(planned);
            const verified = await renameSnapshot();
            const next = { ...planned, documents, realPaths, revision: draft.revision };
            if (rename.snapshotSignature(verified) !== planned.signature || !renameDocumentsCurrent(next))
                throw resourceError('Исходники изменились во время подготовки. Повторите rename.');
            if (vscode.workspace.isTrusted === false) throw Error('Для переименования требуется доверенный workspace.');
            if (renameBlocked(to)) throw Error(renameBlocked(to));
            preview = next; notice = 'Проверьте новое имя, файлы и ограничения поиска.';
        }
        async function applyRename() {
            const planned = preview;
            if (!planned || planned.kind !== 'rename' || planned.revision !== draft.revision) throw Error('Сначала откройте актуальный предпросмотр переименования.');
            const blocked = renameBlocked(planned.to); if (blocked) { preview = null; throw Error(blocked); }
            if (vscode.workspace.isTrusted === false) { preview = null; throw Error('Для переименования требуется доверенный workspace.'); }
            busy = true; notice = 'Проверяем переименование…'; send();
            try {
                const realPaths = await renamePaths(planned);
                const fresh = await renameSnapshot();
                if (realPaths !== planned.realPaths || rename.snapshotSignature(fresh) !== planned.signature || !renameDocumentsCurrent(planned))
                    throw resourceError('BL/NLS или набор исходников изменились после preview. Ничего не переименовано; повторите проверку.');
                // Rebuild for collisions/ambiguity; never apply a truncated or
                // independently forged webview edit-plan.
                rename.renamePlan(fresh, key, planned.to);
                if (await renamePaths(planned) !== planned.realPaths || !renameDocumentsCurrent(planned))
                    throw resourceError('Пути или буферы изменились во время проверки. Повторите rename.');
                if (renameBlocked(planned.to)) throw Error(renameBlocked(planned.to));
                if (!alive || disposed || vscode.workspace.isTrusted === false || !localization.isRenameSnapshotCurrent(fresh))
                    throw resourceError('Контекст изменился. Ничего не переименовано.');
            } catch (failure) { preview = null; throw failure; }
            const edit = new vscode.WorkspaceEdit();
            for (const change of planned.changes) {
                const doc = planned.documents.get(change.filePath).document;
                for (const part of change.edits) edit.replace(doc.uri, new vscode.Range(doc.positionAt(part.start), doc.positionAt(part.end)), part.text);
            }
            const reserved = fingerprint(draft.root + '\0' + planned.to); renameReservations.add(reserved);
            try {
                if (!await vscode.workspace.applyEdit(edit)) { preview = null; throw Error('VS Code не применил rename. Проверьте файлы и повторите предпросмотр.'); }
            } catch (failure) { renameReservations.delete(reserved); preview = null; throw failure; }
            // Commit already happened. No rollback if the panel closed or a
            // subsequent storage/index refresh fails.
            const oldId = id, oldDraft = draft;
            preview = null; cancelAi(); proposals.clear(); acceptanceUndo = null;
            key = planned.to; id = fingerprint(draft.root + '\0' + key);
            panels.delete(oldId);
            if (alive && !disposed) { panels.set(id, {panel}); panel.title = 'Переводы: ' + key; }
            renameReservations.delete(reserved);
            let storageError = false;
            try { await persist(oldId, oldDraft); } catch (_) { storageError = true; }
            notice = 'Ключ переименован в файлах редактора. Сохраните через Save / Save All; Undo — в VS Code.';
            if (alive && !disposed) {
                try { draft = createDraft(await loadFresh(), key, locale, required); generation++; }
                catch (_) {
                    // Keep the panel truthful and non-editable rather than
                    // rebasing an old source identity onto the new key.
                    draft.key = key; for (const row of draft.rows) row.stale = true;
                    error = 'Rename уже применён, но источники не обновились. Проверьте файлы и откройте редактор нового ключа заново.';
                }
                if (storageError) error = 'Rename уже применён, но локальное хранилище не обновилось. Проверьте файлы; старые черновики не удалялись автоматически.';
            }
        }
        async function addLanguage() {
            if (run || aiOpen || preview || saving) return;
            if (vscode.workspace.isTrusted === false) throw Error('Для создания NLS требуется доверенный workspace.');
            busy = true; send();
            const captured = await loadFresh(), families = resources.familiesFor(captured, key);
            if (!families.length) throw Error('Набор ресурсов ключа не определён. Создание недоступно.');
            let family = families[0];
            if (families.length > 1) {
                const choices = families.map(family => ({ label: path.basename(family), description: path.relative(draft.root, family), family }));
                const selected = await vscode.window.showQuickPick(choices, { title: 'Добавить язык · Набор ресурсов', placeHolder: 'В какой набор добавить язык?' });
                if (!selected || !choices.includes(selected)) return;
                family = selected.family;
            }
            if (!alive || disposed) return;
            const existing = new Set(captured.resources.filter(r => resourceFamily(r.filePath) === family).map(r => r.locale));
            const choices = [...new Set([...required, ...resources.COMMON_LOCALES].map(resources.languageCode).filter(Boolean))]
                .filter(locale => !existing.has(locale)).map(locale => ({ label: locale.toUpperCase(), locale }));
            const other = { label: 'Другой язык…' }; choices.push(other);
            const selected = await vscode.window.showQuickPick(choices, { title: 'Добавить язык', placeHolder: 'Язык нового NLS-файла' });
            if (!selected || !choices.includes(selected) || !alive || disposed) return;
            let language = selected.locale;
            if (selected === other) {
                language = await vscode.window.showInputBox({ title: 'Добавить язык', prompt: 'Код языка, например uz, en или pt-BR',
                    validateInput: value => resources.languageCode(value) ? undefined : 'Введите код языка, например uz или pt-BR.' });
                if (language === undefined || !alive || disposed) return;
            }
            const plan = resources.creationPlan(captured, key, family, language), target = vscode.Uri.file(plan.filePath);
            async function verify() {
                if (!alive || disposed || vscode.workspace.isTrusted === false) throw Error('Создание отменено: окно закрыто или workspace больше не доверенный.');
                if (!localization.canCreateResource(target, plan.root)) throw Error('Путь NLS исключён из индекса или checkout изменился. Файл не создан.');
                const fresh = await loadFresh();
                if (!resources.familiesFor(fresh, key).includes(plan.family) || resources.familySignature(fresh, plan.family) !== plan.signature)
                    throw resourceError('Источники изменились. Файл не создан; повторите добавление языка.');
                await resources.checkDestination(plan, vscode.workspace.textDocuments);
                if (!alive || disposed || vscode.workspace.isTrusted === false || !localization.isSnapshotCurrent(fresh)
                    || !localization.canCreateResource(target, plan.root)) throw resourceError('Контекст изменился. Файл не создан; повторите добавление языка.');
            }
            await verify();
            const consent = await vscode.window.showWarningMessage('Создать NLS-файл для ' + plan.locale.toUpperCase() + '?',
                { modal: true, detail: plan.filePath + '\n\nБудет создан новый файл. Пустая XML-структура попадёт в его буфер; сохраните её через Save / Save All. Ключи и переводы не копируются. Текущие правки останутся в черновике.' }, 'Создать файл');
            if (consent !== 'Создать файл' || !alive || disposed) return;
            await verify();
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(target, { overwrite: false, ignoreIfExists: false });
            edit.insert(target, new vscode.Position(0, 0), resources.EMPTY_RESOURCE);
            let created = false;
            try {
                if (!await vscode.workspace.applyEdit(edit)) throw Error('VS Code не завершил создание.');
                created = true;
                localization.resourceCreated(target);
                if (!alive || disposed) return;
                // Ensure the new native text model is visible to the shared
                // buffer overlay; opening a document does not show/split a tab.
                await vscode.workspace.openTextDocument(target);
                if (!alive || disposed) return;
                const updated = await loadFresh();
                const next = createDraft(updated, key, locale, [...draft.rows.map(row => row.locale), plan.locale]);
                resources.attachCreatedResource(draft, next, plan);
                preview = null; candidate = null;
                await storeDraft();
                notice = durable ? 'Добавлен язык ' + plan.locale.toUpperCase() + '. Сохраните новый NLS через Save / Save All; затем введите перевод или используйте ИИ.'
                    : 'Файл для ' + plan.locale.toUpperCase() + ' создан, но черновик НЕ сохранён локально. Скопируйте правки; новый XML-буфер сохраните через Save.';
            } catch (_) {
                // Resource edits are not text-only atomic edits: do not silently
                // delete a file after partial completion or claim nothing changed.
                error = created ? 'Файл создан: ' + plan.filePath + '. Не удалось обновить редактор переводов. Проверьте новый буфер и сохраните XML через Save; черновик не удалён.'
                    : 'Создание не завершено: ' + plan.filePath + '. Файл мог появиться частично или уже существовать. Проверьте его в Explorer; ничего не удалялось и не перезаписывалось.';
                notice = 'Проверьте новый ресурс.';
            }
        }
        async function handle(message) {
            if (!alive || disposed || !message || typeof message !== 'object') return;
            if (message.type === 'ready') { ready = true; send(); return; }
            if (message.session !== session || !Number.isSafeInteger(message.sequence) || message.sequence <= lastSequence) return;
            if (JSON.stringify(message).length > 270000) return;
            lastSequence = message.sequence; error = ''; errorRecovery = '';
            try {
                if (message.type === 'rename') {
                    await prepareRename();
                } else if (message.type === 'addLanguage') {
                    await addLanguage();
                } else if (message.type === 'aiRecover') {
                    if (!aiError || !aiRecovery || run) return;
                    if (aiRecovery.type === 'settings' && ['baseUrl', 'model', 'translationPrompt', 'timeoutMs'].includes(aiRecovery.setting))
                        await vscode.commands.executeCommand('workbench.action.openSettings', '@id:bl.i18n.ai.' + aiRecovery.setting);
                    else if (aiRecovery.type === 'key') await vscode.commands.executeCommand('bl.setTranslationApiKey');
                } else if (message.type === 'aiOpen') {
                    if (!preview && !run) { aiOpen = true; candidate = null; aiError = ''; }
                } else if (message.type === 'aiClose' || message.type === 'aiCancel') {
                    cancelAi(); aiOpen = message.type === 'aiCancel'; aiError = message.type === 'aiCancel' ? ai.safeError(new ai.AiError('cancel')) : '';
                } else if (message.type === 'aiInvalidate') {
                    candidate = null; aiError = '';
                } else if (message.type === 'aiPrepare') {
                    if (!aiOpen || run || preview) return;
                    try {
                        candidate = null; aiError = '';
                        const epoch = aiEpoch;
                        await checkAiTargets(message.targets || []);
                        if (!alive || disposed || epoch !== aiEpoch || !aiOpen) return;
                        const request = ai.prepareRequest(ai.profile(vscode), { text: message.text, sourceLocale: message.sourceLocale, targets: message.targets }, draft);
                        candidate = { token: crypto.randomBytes(16).toString('hex'), request };
                    } catch (failure) { reportAi(failure); }
                } else if (message.type === 'aiSend') {
                    if (!aiOpen || run || !candidate || message.token !== candidate.token) return;
                    const prepared = candidate.request, epoch = aiEpoch; candidate = null;
                    try {
                        if (vscode.workspace.isTrusted === false) throw new ai.AiError('cancel');
                        if (ai.signature(ai.profile(vscode)) !== ai.signature(prepared.profile)) throw new ai.AiError('config');
                        await checkAiTargets(prepared.data.targetLocales);
                        if (prepared.profile.url.startsWith('http:')) {
                            const consent = await vscode.window.showWarningMessage('HTTP передаст текст и API-ключ без шифрования: ' + prepared.profile.url,
                                { modal: true }, 'Разрешить HTTP');
                            if (consent !== 'Разрешить HTTP') { aiError = 'Отправка отменена.'; return; }
                        }
                        if (!alive || disposed || epoch !== aiEpoch) return;
                        const credential = context.secrets && await context.secrets.get(ai.secretId(prepared.profile.url));
                        if (!credential) throw new ai.AiError('key');
                        // Recheck after async consent/secret access, immediately before transport.
                        if (!alive || disposed || epoch !== aiEpoch || vscode.workspace.isTrusted === false) return;
                        if (ai.signature(ai.profile(vscode)) !== ai.signature(prepared.profile)) throw new ai.AiError('config');
                        await checkAiTargets(prepared.data.targetLocales);
                        if (!alive || disposed || epoch !== aiEpoch || vscode.workspace.isTrusted === false) return;
                        if (ai.signature(ai.profile(vscode)) !== ai.signature(prepared.profile)) throw new ai.AiError('config');
                        startAi(prepared, credential);
                    } catch (failure) { reportAi(failure); }
                } else if (message.type === 'aiAcceptSelected') {
                    await acceptProposals(message.items);
                } else if (message.type === 'aiUndoAccept') {
                    await undoAcceptance();
                } else if (message.type === 'edit') {
                    updateRow(draft, message.row, message.value, message.target); preview = null; saving = true;
                    if (acceptanceUndo && acceptanceUndo.some(item => item.row === message.row)) acceptanceUndo = null;
                    notice = 'Сохраняем локальный черновик…'; send();
                    try { await persist(id, draft); durable = true; notice = draft.rows.some(r => r.edited) ? 'Черновик сохранён локально · Правки ещё не применены.' : 'Нет изменений.'; }
                    catch (_) { durable = false; error = 'Не удалось сохранить локальный черновик. Текст остаётся в этом окне: скопируйте его перед закрытием или повторите ввод.'; notice = 'Черновик НЕ сохранён.'; }
                } else if (message.type === 'preview') {
                    if (run || aiOpen) return;
                    busy = true; notice = 'Проверяем ресурсы…'; send(); preview = await prepare(); notice = 'Готово к применению.';
                } else if (message.type === 'back') { preview = null; notice = durable ? 'Черновик сохранён локально · Правки ещё не применены.' : 'Черновик НЕ сохранён локально: скопируйте нужные поля перед закрытием.';
                } else if (message.type === 'apply') {
                    if (run || aiOpen) return;
                    if (preview && preview.kind === 'rename') { await applyRename(); return; }
                    if (!preview || preview.revision !== draft.revision) throw Error('Сначала откройте актуальный предпросмотр.');
                    busy = true; notice = 'Проверяем и применяем…'; send();
                    const fresh = await loadFresh(), current = familyRows(fresh);
                    if (preview.changes.some(change => !hasFamilyOptions(draft.rows.find(row => row.id === change.row), current))) {
                        preview = null; throw resourceError('Набор NLS изменился после предпросмотра. Ничего не применено. Обновите из ресурсов.');
                    }
                    for (const [file, item] of preview.documents) {
                        const resource = fresh.resources.find(r => r.filePath === file);
                        if (!resource || resource.issues.length || item.document.isClosed || item.document.version !== item.version
                            || fingerprint(item.document.getText()) !== item.hash || fingerprint(resource.text) !== item.hash) {
                            preview = null; throw resourceError('NLS изменился после предпросмотра. Ничего не применено. Обновите из ресурсов.');
                        }
                    }
                    if (!alive || disposed) return;
                    if (vscode.workspace.isTrusted === false) throw Error('Для изменения NLS требуется доверенный workspace.');
                    if (!localization.isSnapshotCurrent(fresh)) throw resourceError('Ресурсы изменились во время проверки. Повторите предпросмотр.');
                    const edit = new vscode.WorkspaceEdit();
                    for (const change of preview.changes) {
                        const currentDoc = preview.documents.get(change.filePath).document;
                        for (const part of change.edits) edit.replace(currentDoc.uri,
                            new vscode.Range(currentDoc.positionAt(part.start), currentDoc.positionAt(part.end)), part.text);
                    }
                    const applied = await vscode.workspace.applyEdit(edit);
                    if (!applied) throw Error('VS Code не применил изменения. Ресурсы могли измениться; обновите их.');
                    // Apply is explicit. Closing during its atomic execution does
                    // not revert committed buffers; still clean the saved draft.
                    cancelAi(); proposals.clear(); acceptanceUndo = null;
                    for (const row of draft.rows) row.edited = false;
                    try { await persist(id, draft); } catch (_) { error = 'Переводы применены, но старый локальный черновик не удалось удалить. При повторном открытии сверьте ресурсы.'; }
                    preview = null;
                    notice = 'Изменения внесены в редактор. Сохраните файлы через Save / Save All; Undo доступен в VS Code.';
                    if (alive) {
                        try { const updated = await loadFresh(); draft = createDraft(updated, key, locale, required); generation++; }
                        catch (_) { error = 'Переводы уже применены, но контекст изменился. Откройте редактор заново для актуальных источников.'; }
                    }
                } else if (message.type === 'discard' || message.type === 'reload') {
                    cancelAi(); aiOpen = false; aiError = '';
                    if (draft.rows.some(row => row.edited)) {
                        const selected = await vscode.window.showWarningMessage('Отменить изменения этого черновика? NLS-файлы не будут изменены.', { modal: true }, 'Отменить изменения');
                        if (selected !== 'Отменить изменения' || !alive) { send(); return; }
                    }
                    const fresh = await loadFresh(), replacement = createDraft(fresh, key, locale, required);
                    await persist(id, replacement); draft = replacement; proposals.clear(); acceptanceUndo = null; generation++; preview = null;
                    notice = 'Загружены актуальные ресурсы. Черновик очищен.';
                } else if (message.type === 'close') { panel.dispose(); return;
                } else if (message.type === 'openSource') {
                    const row = draft.rows.find(r => r.id === message.row), option = row && row.options.find(o => o.id === message.option);
                    if (!option) return;
                    const fresh = await loadFresh(), resource = fresh.resources.find(r => r.filePath === option.filePath);
                    if (!resource || fingerprint(resource.text) !== option.hash) throw resourceError('Источник изменился; обновите из ресурсов.');
                    const resourceDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(option.filePath));
                    if (!alive || fingerprint(resourceDoc.getText()) !== option.hash) return;
                    await vscode.window.showTextDocument(resourceDoc, { viewColumn: vscode.ViewColumn.Active, preview: false,
                        selection: new vscode.Range(resourceDoc.positionAt(option.start || 0), resourceDoc.positionAt(option.end || 0)) });
                }
            } catch (failure) { error = failure.message || 'Не удалось выполнить действие. Черновик сохранён в текущем окне.'; errorRecovery = failure.recovery || ''; notice = 'Действие не завершено.'; }
            finally { busy = false; saving = false; send(); }
        }
        const receive = panel.webview.onDidReceiveMessage(message => {
            if (message && message.session === session && Number.isSafeInteger(message.sequence) && message.sequence > lastSequence
                && ['aiCancel', 'aiClose', 'close'].includes(message.type) && JSON.stringify(message).length <= 270000) cancelAi();
            // Consume/ack a duplicate click queued while its native dialogs are
            // open, without starting another creation flow after they close.
            const duplicateCreate = busy && message && ['addLanguage', 'rename'].includes(message.type);
            queue = queue.then(() => handle(duplicateCreate ? { ...message, type: 'ignored' } : message)).catch(() => { error = 'Ошибка обработки действия. Черновик не применён.'; send(); }); return queue; });
        const dispose = panel.onDidDispose(() => { alive = false; cancelAi(); preview = null; panels.delete(id); receive.dispose(); configChange.dispose(); dispose.dispose(); });
        return panel;
    }
    context.subscriptions.push(vscode.commands.registerCommand('bl.editTranslation', openTranslation),
        { dispose() { disposed = true; for (const { panel } of [...panels.values()]) panel.dispose(); panels.clear(); } });
    return { openTranslation, openSearchTranslation };
}
module.exports = { createI18nToolkit };
