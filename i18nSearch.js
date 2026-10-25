const path = require('path');
const { normalizeLocale } = require('./localizationModel');
const { localizationLiterals } = require('./localizationPresentation');
const { fingerprint } = require('./localizationEdits');

const LIMIT = 200;
const keyPattern = /^[A-Za-z_][\w.-]*$/;
// QuickPick supports codicons, not just plain text. Resource text is never an icon instruction.
const caption = text => String(text).replace(/[\s\x00-\x1f\x7f]+/g, ' ').replace(/\$\(/g, '\\$(').slice(0, 240);
const normalize = text => String(text).normalize('NFC').toLowerCase();

function searchRecords(state, locale) {
    const groups = new Map(), values = new Map();
    for (const resource of state.resources) {
        if (resource.issues.length) continue;
        const hash = fingerprint(resource.text);
        for (const entry of resource.entries) {
            const identity = JSON.stringify([entry.key, entry.locale, entry.value]);
            const languageKey = JSON.stringify([entry.key, entry.locale]);
            if (!values.has(languageKey)) values.set(languageKey, new Set());
            values.get(languageKey).add(entry.value);
            if (!groups.has(identity)) groups.set(identity, { key: entry.key, locale: entry.locale, value: entry.value, sources: [] });
            groups.get(identity).sources.push({ ...entry, hash });
        }
    }
    return [...groups.values()].map(record => ({ ...record,
        conflict: values.get(JSON.stringify([record.key, record.locale])).size > 1,
        incomplete: state.resources.some(r => r.issues.length && (!r.locale || r.locale === record.locale)),
        search: normalize([record.key, record.value, record.locale, ...record.sources.map(s => path.relative(state.root, s.filePath))].join('\n'))
    })).sort((a, b) => a.key.localeCompare(b.key) || Number(b.locale === locale) - Number(a.locale === locale)
        || a.locale.localeCompare(b.locale) || a.value.localeCompare(b.value));
}
function searchMatches(records, query, limit = LIMIT) {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    const matches = records.filter(record => terms.every(term => record.search.includes(term)));
    return { total: matches.length, records: matches.slice(0, limit) };
}

function lexicalSpans(text) {
    const result = []; let i = 0;
    while (i < text.length) {
        const start = i;
        if (text.startsWith('//', i)) {
            const end = text.indexOf('\n', i); i = end < 0 ? text.length : end;
            result.push({ start, end: i, kind: 'comment', openEnd: true });
        } else if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2;
            result.push({ start, end: i, kind: 'comment', openEnd: end < 0 });
        } else if (text[i] === '"' || text[i] === "'") {
            const quote = text[i++]; let closed = false;
            while (i < text.length) {
                if (text[i] === '\\') { i = Math.min(text.length, i + 2); continue; }
                if (text[i++] === quote) { closed = true; break; }
            }
            result.push({ start, end: i, kind: 'string', quote, closed });
        } else i++;
    }
    return result;
}
function insertionTarget(editor) {
    if (!editor || editor.document.languageId !== 'bl' || editor.document.uri.scheme !== 'file' || editor.document.isClosed
        || editor.selections && editor.selections.length !== 1) return null;
    const doc = editor.document, text = doc.getText(), selection = editor.selection;
    const start = doc.offsetAt(selection.start), end = doc.offsetAt(selection.end);
    if (/\r|\n/.test(text.slice(start, end))) return null;
    let from = start, to = end;
    const spans = lexicalSpans(text), overlap = spans.filter(span => start === end
        ? start > span.start && start < span.end || start === span.end && (span.openEnd || span.kind === 'string' && !span.closed)
        : start < span.end && end > span.start);
    if (overlap.length) {
        const span = overlap[0], literal = localizationLiterals(text).find(item => item.start === span.start && item.end === span.end);
        const within = start >= span.start && end <= span.end;
        const whole = start === span.start && end === span.end;
        const empty = start === end && text.slice(span.start, span.end) === '""';
        if (overlap.length !== 1 || span.kind !== 'string' || span.quote !== '"' || !span.closed
            || !within || !(literal || whole || empty)) return null;
        from = span.start; to = span.end;
    }
    return { editor, document: doc, uri: doc.uri, version: doc.version, hash: fingerprint(text),
        start, end, from, to, range: { start: doc.positionAt(from), end: doc.positionAt(to) } };
}
function targetCurrent(vscode, target) {
    if (!target || target.document.isClosed || target.editor !== vscode.window.activeTextEditor
        || target.editor.document !== target.document || target.document.version !== target.version
        || fingerprint(target.document.getText()) !== target.hash || target.editor.selections && target.editor.selections.length !== 1) return false;
    const selection = target.editor.selection;
    return target.document.offsetAt(selection.start) === target.start && target.document.offsetAt(selection.end) === target.end;
}

function createI18nSearch(vscode, localization, toolkit, context) {
    let disposed = false;
    const operations = new Set(), pickers = new Set();
    async function searchTranslation(_argument, externalToken) {
        if (disposed || externalToken && externalToken.isCancellationRequested) return null;
        const changes = new vscode.EventEmitter(); let stopped = false;
        const token = { get isCancellationRequested() { return stopped || disposed || !!(externalToken && externalToken.isCancellationRequested); },
            onCancellationRequested: changes.event };
        const cancel = () => { stopped = true; changes.fire(); };
        operations.add(cancel);
        const external = externalToken && typeof externalToken.onCancellationRequested === 'function' && externalToken.onCancellationRequested(cancel);
        const editor = vscode.window.activeTextEditor, target = insertionTarget(editor);
        try {
            let scope;
            if (editor) {
                const root = localization.rootFor(editor.document.uri);
                if (!root) { await vscode.window.showInformationMessage('Откройте файл внутри workspace для поиска переводов.'); return null; }
                scope = { root, uri: editor.document.uri };
            } else {
                const available = await localization.searchScopes();
                if (token.isCancellationRequested) return null;
                if (!localization.isSnapshotCurrent(available)) throw Error('Workspace изменился. Повторите поиск переводов.');
                if (!available.scopes.length) { await vscode.window.showInformationMessage('Откройте папку проекта с NLS-ресурсами.'); return null; }
                if (available.scopes.length === 1) scope = available.scopes[0];
                else {
                    const choices = available.scopes.map(s => ({ label: caption(path.basename(s.root)), description: caption(s.root), scope: s }));
                    const chosen = await vscode.window.showQuickPick(choices,
                        { title: 'Z8BL: поиск переводов', placeHolder: 'Выберите checkout для поиска', ignoreFocusOut: true }, token);
                    if (!chosen || !choices.includes(chosen)) return null;
                    scope = chosen.scope;
                }
                if (!scope || token.isCancellationRequested) return null;
            }
            const initial = target && localizationLiterals(target.document.getText()).find(item => target.start >= item.start && target.end <= item.end);
            const selected = await chooseResult(scope, initial ? initial.key : '', token);
            if (!selected || token.isCancellationRequested) return null;
            await validate(selected, scope);
            if (token.isCancellationRequested) return null;
            const actions = [{ label: 'Редактировать переводы', description: 'Все языки выбранного ключа', action: 'edit' }];
            if (target && keyPattern.test(selected.record.key)) actions.push({ label: 'Вставить ключ в BL',
                description: '"$' + caption(selected.record.key) + '$" · ' + caption(path.basename(target.uri.fsPath)), action: 'insert' });
            actions.push({ label: 'Открыть NLS-источник', description: 'Выбранный перевод в ресурсе', action: 'source' });
            const action = await vscode.window.showQuickPick(actions, { title: caption(selected.record.key) + ' · ' + selected.record.locale,
                placeHolder: 'Выберите действие', ignoreFocusOut: true }, token);
            if (!action || !actions.includes(action) || token.isCancellationRequested) return null;
            await validate(selected, scope);
            if (token.isCancellationRequested) return null;
            if (action.action === 'edit') return await toolkit.openSearchTranslation(scope.uri, selected.record.key, scope.root, token);
            if (action.action === 'insert') {
                if (vscode.workspace.isTrusted === false) throw Error('Для вставки ключа требуется доверенный workspace.');
                if (!targetCurrent(vscode, target)) throw Error('BL-документ, выделение или активный редактор изменились. Ключ не вставлен; повторите поиск.');
                let planned = false;
                const applied = await target.editor.edit(builder => {
                    if (!token.isCancellationRequested && targetCurrent(vscode, target) && localization.isSnapshotCurrent(selected.fresh)) {
                        builder.replace(new vscode.Range(target.range.start, target.range.end), '"$' + selected.record.key + '$"'); planned = true;
                    }
                }, { undoStopBefore: true, undoStopAfter: true });
                if (!planned || !applied) throw Error('VS Code не вставил ключ. Документ мог измениться; повторите поиск.');
                return { action: 'insert', key: selected.record.key };
            }
            let source = selected.record.sources[0];
            if (selected.record.sources.length > 1) {
                const choices = selected.record.sources.map(s => ({ label: caption(path.relative(scope.root, s.filePath)),
                    description: 'Позиция ' + (s.start + 1), source: s }));
                const chosen = await vscode.window.showQuickPick(choices, { placeHolder: 'Перевод найден в нескольких местах — выберите источник', ignoreFocusOut: true }, token);
                if (!chosen || !choices.includes(chosen) || token.isCancellationRequested) return null;
                source = chosen.source;
            }
            await validate(selected, scope);
            if (token.isCancellationRequested) return null;
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(source.filePath));
            // Opening the resource intentionally invalidates the shared index; verify fresh content,
            // not the old epoch, after this own navigation event.
            const fresh = await localization.freshSnapshot(scope.uri);
            if (token.isCancellationRequested) return null;
            if (!fresh || fresh.root !== scope.root || !localization.isSnapshotCurrent(fresh)
                || doc.isClosed || fingerprint(doc.getText()) !== source.hash
                || !fresh.resources.some(r => r.filePath === source.filePath && !r.issues.length && fingerprint(r.text) === source.hash))
                throw Error('NLS-источник изменился. Повторите поиск переводов.');
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false,
                selection: new vscode.Range(doc.positionAt(source.start), doc.positionAt(source.end)) });
            return { action: 'source', key: selected.record.key };
        } catch (failure) {
            if (!token.isCancellationRequested) await vscode.window.showWarningMessage(failure.message || 'Не удалось выполнить поиск переводов.');
            return null;
        } finally { if (external) external.dispose(); operations.delete(cancel); changes.dispose(); }
    }
    async function validate(selected, scope) {
        if (!localization.isSnapshotCurrent(selected.state)) throw Error('NLS-ресурсы или настройки изменились. Повторите поиск переводов.');
        const fresh = await localization.freshSnapshot(scope.uri);
        if (!fresh || !localization.isSnapshotCurrent(fresh) || fresh.root !== scope.root || selected.record.sources.some(source =>
            !fresh.resources.some(r => r.filePath === source.filePath && !r.issues.length && fingerprint(r.text) === source.hash
                && r.entries.some(e => e.key === selected.record.key && e.value === selected.record.value && e.start === source.start))))
            throw Error('NLS-ресурсы изменились. Повторите поиск переводов.');
        selected.fresh = fresh;
    }
    function chooseResult(scope, initialValue, token) {
        const picker = vscode.window.createQuickPick(); pickers.add(picker);
        picker.title = 'Z8BL: поиск переводов'; picker.placeholder = 'Загружаем NLS…'; picker.busy = true;
        picker.ignoreFocusOut = true; picker.value = initialValue;
        return new Promise((resolve, reject) => {
            let done = false, state = null, records = [];
            const subscriptions = [];
            const finish = (selected, failure) => {
                if (done) return; done = true;
                subscriptions.forEach(s => s.dispose()); pickers.delete(picker); picker.hide(); picker.dispose();
                if (failure) reject(failure); else resolve(selected);
            };
            const update = () => {
                if (done || !state) return;
                const matches = searchMatches(records, picker.value);
                const problems = state.resources.filter(r => r.issues.length).length;
                picker.title = `Z8BL: переводы · ${caption(path.basename(scope.root))} · ${matches.records.length} из ${matches.total}${problems ? ' · недоступных ресурсов: ' + problems : ''}`;
                picker.items = matches.records.map(record => ({ label: caption(record.key),
                    description: `${record.locale}${record.conflict ? ' · конфликт' : ''}${record.incomplete ? ' · индекс неполон' : ''} · ${record.value === '' ? '(пустой перевод)' : caption(record.value)}`,
                    detail: record.sources.map(s => caption(path.relative(scope.root, s.filePath))).join(' · '), record, alwaysShow: true }));
                if (!matches.total) picker.items = [{ label: records.length ? 'Переводы не найдены' : 'Нет доступных переводов',
                    detail: records.length ? 'Измените запрос: ключ или текст перевода' : 'Проверьте NLS-ресурсы и исключения индекса', alwaysShow: true }];
                picker.placeholder = matches.total > LIMIT ? 'Уточните запрос — показаны первые 200 результатов' : 'Ключ или текст перевода · Enter — выбрать действие';
            };
            subscriptions.push(picker.onDidHide(() => finish(null)), picker.onDidChangeValue(update), picker.onDidAccept(() => {
                const item = picker.selectedItems[0];
                if (item && picker.items.includes(item) && item.record && state) finish({ record: item.record, state });
            }), token.onCancellationRequested(() => finish(null)));
            if (token.isCancellationRequested) { finish(null); return; }
            picker.show();
            localization.freshSnapshot(scope.uri).then(loaded => {
                if (done || token.isCancellationRequested) return;
                if (!loaded || loaded.root !== scope.root || !localization.isSnapshotCurrent(loaded)) {
                    finish(null, Error('NLS-ресурсы или workspace изменились при загрузке. Повторите поиск переводов.')); return;
                }
                state = loaded;
                const locale = normalizeLocale(vscode.workspace.getConfiguration('bl', scope.uri).get('i18n.locale', 'ru'));
                records = searchRecords(state, locale); picker.busy = false; update();
            }).catch(() => {
                if (done) return;
                picker.busy = false; picker.items = [{ label: 'Не удалось загрузить переводы', detail: 'Повторите поиск и проверьте NLS-ресурсы', alwaysShow: true }];
            });
        });
    }
    context.subscriptions.push(vscode.commands.registerCommand('bl.searchTranslations', searchTranslation),
        { dispose() { disposed = true; for (const cancel of operations) cancel(); for (const picker of [...pickers]) { picker.hide(); picker.dispose(); } } });
    return { searchTranslation };
}
module.exports = { createI18nSearch, searchRecords, searchMatches, insertionTarget, targetCurrent };
