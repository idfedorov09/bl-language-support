const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { normalizeGuid } = require('./blIndex');
const { renderRecordCardHtml, renderRecordHover } = require('./recordCardView');

const GUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const declarationsFor = owner => [...(owner.recordDeclarations || []), ...(owner.guidConstants || [])];
const kindLabel = record => record.kind === 'constant' ? 'GUID-константа' : 'records';

// Value matches are not symbol references. Keep their lexical provenance even
// when the same UUID occurs inside an arbitrary string or a comment.
function findGuidOccurrences(text) {
    const regex = new RegExp(GUID_PATTERN, 'ig');
    const result = [];
    let cursor = 0, line = 0, lineStart = 0, quote = null, quoteStart = -1;
    let lineComment = false, blockComment = false, escaped = false;
    const advance = end => {
        while (cursor < end) {
            const ch = text[cursor], next = text[cursor + 1];
            if (ch === '\n') { line++; lineStart = cursor + 1; }
            if (lineComment) {
                if (ch === '\r' || ch === '\n') lineComment = false;
            } else if (blockComment) {
                if (ch === '*' && next === '/') { blockComment = false; cursor++; }
            } else if (quote) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === quote) quote = null;
            } else if (ch === '/' && next === '/') { lineComment = true; cursor++; }
            else if (ch === '/' && next === '*') { blockComment = true; cursor++; }
            else if (ch === '"' || ch === "'") { quote = ch; quoteStart = cursor; }
            cursor++;
        }
    };
    let match;
    while ((match = regex.exec(text))) {
        const start = match.index, end = start + match[0].length;
        if (/[\w-]/.test(text[start - 1] || '') || /[\w-]/.test(text[end] || '')) continue;
        advance(start);
        const kind = lineComment || blockComment ? 'comment'
            : quote === "'" && quoteStart === start - 1 && text[end] === "'" ? 'literal'
                : quote ? 'string' : 'code';
        result.push({ guid: normalizeGuid(match[0]), kind, offset: start, endOffset: end,
            line, column: start - lineStart });
    }
    return result;
}

function withinRoot(file, root) {
    if (!root) return true;
    const relative = path.relative(root, file);
    return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function createGuidNavigation(vscode, services) {
    const { index, ensureIndexReady, updateIndexFromDocument, getAnalysis, definitionProvider, referenceProvider } = services;
    const panels = new Set();
    const pickers = new Set();
    let disposed = false;
    const cancelled = token => disposed || token && token.isCancellationRequested;
    const sourceUri = value => {
        if (typeof value === 'string') return vscode.Uri.file(value);
        return value && value.scheme === 'file' && typeof value.fsPath === 'string' ? value : null;
    };
    const occurrences = document => {
        const analysis = getAnalysis(document);
        if (!analysis.guidOccurrences) analysis.guidOccurrences = findGuidOccurrences(analysis.text);
        return analysis.guidOccurrences;
    };
    const guidAt = (document, position) => occurrences(document).find(item => item.line === position.line
        && position.character >= item.column && position.character < item.column + 36);

    function scopeFor(uri) {
        const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return null;
        const workspaceRoot = folder.uri.fsPath;
        let checkout = null;
        // The outermost Git marker inside the containing workspace keeps
        // submodules with their parent checkout, without guessing a classpath.
        for (let directory = path.dirname(uri.fsPath); withinRoot(directory, workspaceRoot); directory = path.dirname(directory)) {
            if (fs.existsSync(path.join(directory, '.git'))) checkout = directory;
            if (directory === workspaceRoot || directory === path.dirname(directory)) break;
        }
        return checkout || workspaceRoot;
    }

    async function chooseScope(uri, token) {
        if (cancelled(token)) return null;
        const root = scopeFor(uri);
        if (root) return { root, sourceUri: uri };
        // An explicit source outside the workspace has no known boundary;
        // do not silently replace its context with the only open folder.
        if (uri) return { root: null, sourceUri: uri };
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 1) return { root: folders[0].uri.fsPath, sourceUri: uri };
        if (folders.length > 1) {
            const selected = await vscode.window.showQuickPick(folders.map(folder => ({
                label: folder.name, description: folder.uri.fsPath, folder
            })), { placeHolder: 'Выберите исходный checkout / папку для поиска GUID', ignoreFocusOut: true }, token);
            return selected ? { root: selected.folder.uri.fsPath, sourceUri: uri } : null;
        }
        // With no known workspace boundary return all labelled candidates, not
        // an invented checkout based on an arbitrary nearest file.
        return { root: null, sourceUri: uri };
    }

    function candidates(guid, scope) {
        return index.getGuidDeclarations(guid).filter(item => withinRoot(item.owner.filePath, scope.root))
            .map(item => sourceMatch(item.owner, item.record));
    }

    const sourceMatch = (owner, record) => ({ owner, record, sourceHash: index.fileContentHashes.get(owner.filePath) });

    function matchForLocation(location) {
        const owner = index.getClassByFile(location.uri.fsPath);
        if (!owner) return null;
        const at = location.range.start;
        const record = declarationsFor(owner).find(record => record.line === at.line && record.column === at.character);
        return record ? sourceMatch(owner, record) : null;
    }

    async function recordsAt(document, position, token) {
        if (cancelled(token)) return [];
        await ensureIndexReady(token);
        if (cancelled(token)) return [];
        updateIndexFromDocument(document);
        const uuid = guidAt(document, position);
        if (uuid) return candidates(uuid.guid, { root: scopeFor(document.uri) });
        const owner = index.getClassByFile(document.uri.fsPath);
        const declared = owner && declarationsFor(owner).find(record => record.line === position.line
            && position.character >= record.column && position.character < record.column + record.name.length);
        if (declared) return [sourceMatch(owner, declared)];
        const definition = await definitionProvider.provideDefinition(document, position, token);
        if (cancelled(token)) return [];
        return (Array.isArray(definition) ? definition : definition ? [definition] : []).map(matchForLocation).filter(Boolean);
    }

    async function chooseRecord(matches, token) {
        if (cancelled(token)) return null;
        if (matches.length === 1) return matches[0];
        if (!matches.length) return null;
        const selected = await vscode.window.showQuickPick(matches.map(match => ({
            label: `${match.owner.fullName}.${match.record.name}`,
            description: `${kindLabel(match.record)} · ${match.record.guid || 'ID не вычислен статически'}`,
            detail: `${match.owner.filePath}:${match.record.line + 1}:${match.record.column + 1}`, match
        })), { placeHolder: 'Несколько записей — выберите декларацию (повтор не обязательно ошибка)', ignoreFocusOut: true }, token);
        return selected ? selected.match : null;
    }

    function chooseGuidDeclaration(scope, initialValue, token) {
        if (cancelled(token)) return Promise.resolve(null);
        const picker = vscode.window.createQuickPick();
        pickers.add(picker);
        picker.title = 'Z8BL: поиск GUID — records и константы';
        picker.placeholder = 'Имя, класс или часть GUID; Enter — открыть карточку';
        picker.matchOnDescription = true;
        picker.matchOnDetail = true;
        const entries = candidates(undefined, scope).map(match => ({
            label: match.record.name,
            description: match.record.guid,
            detail: `${kindLabel(match.record)} · ${match.owner.fullName} · ${scope.root ? path.relative(scope.root, match.owner.filePath) : match.owner.filePath}:${match.record.line + 1}`,
            match
        })).sort((left, right) => left.label.localeCompare(right.label) || left.detail.localeCompare(right.detail));
        const setItems = value => {
            const guid = normalizeGuid(value);
            const known = guid && entries.some(entry => entry.match.record.guid === guid);
            picker.items = guid && !known ? [{ label: `Искать GUID ${guid}`, description: guid,
                detail: 'Проверить текущие статические records и GUID-константы в выбранном контексте', guid, alwaysShow: true }] : entries;
        };
        setItems(initialValue);
        picker.value = initialValue;
        return new Promise(resolve => {
            const subscriptions = [];
            let finished = false;
            const finish = value => {
                if (finished) return;
                finished = true;
                subscriptions.forEach(subscription => subscription.dispose());
                pickers.delete(picker);
                picker.hide();
                picker.dispose();
                resolve(cancelled(token) ? null : value);
            };
            subscriptions.push(picker.onDidChangeValue(setItems), picker.onDidHide(() => finish(null)), picker.onDidAccept(() => {
                const selected = picker.selectedItems[0];
                if (selected) finish(selected.match ? { match: selected.match } : { guid: selected.guid });
            }));
            if (token && token.onCancellationRequested) subscriptions.push(token.onCancellationRequested(() => finish(null)));
            if (cancelled(token)) finish(null);
            else picker.show();
        });
    }

    function relatedTargets(owner, attribute) {
        const value = attribute.value.trim();
        const guid = /^'([^']+)'$/.exec(value);
        if (guid && normalizeGuid(guid[1])) return candidates(guid[1], { root: scopeFor(vscode.Uri.file(owner.filePath)) });
        const symbol = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/.exec(value);
        if (!symbol) return [];
        const parts = symbol[1].split('.'), name = parts.pop();
        const owners = parts.length ? index.resolveClassName(owner, parts.join('.')) : [owner];
        const result = [];
        for (const context of owners) {
            const member = index.findMemberInClassChain(context, name);
            if (!member || !withinRoot(member.owner.filePath, scopeFor(vscode.Uri.file(owner.filePath)))) continue;
            for (const record of declarationsFor(member.owner)) if (record.name === name) result.push({ owner: member.owner, record });
        }
        return result;
    }

    async function recordModel(match, scope) {
        const { owner, record } = match;
        const links = [];
        const addSource = (label, filePath, line, column) => {
            const id = links.length;
            links.push({ id, label, filePath, line, column });
            return id;
        };
        const sourceId = addSource('Декларация GUID', owner.filePath, record.line, record.column);
        const ownerSourceId = addSource('Класс-владелец', owner.filePath, owner.classLine, owner.classColumn);
        const attributes = record.attributes.map(attribute => ({ name: attribute.name, value: attribute.value, line: attribute.line, column: attribute.column,
            sourceId: addSource(`Атрибут ${attribute.name}`, owner.filePath, attribute.line, attribute.column) }));
        const related = [];
        for (const attribute of record.attributes) {
            const targets = relatedTargets(owner, attribute);
            for (const target of targets) related.push({ label: `${attribute.name}: ${target.owner.fullName}.${target.record.name}`, name: target.record.name,
                owner: target.owner.fullName, guid: target.record.guid, ambiguous: targets.length > 1,
                sourceId: addSource(`${target.owner.fullName}.${target.record.name}`, target.owner.filePath, target.record.line, target.record.column) });
        }
        const warnings = [];
        const declarations = declarationsFor(owner);
        const conflicting = declarations.filter(other => other !== record && (other.name === record.name || record.guid && other.guid === record.guid));
        const warningSourceIds = conflicting.map(other => addSource(`${owner.fullName}.${other.name}`, owner.filePath, other.line, other.column));
        if (conflicting.length) warnings.push('В одном классе повторяется имя декларации или её GUID. Это потенциальный конфликт/алиас, не доказанная ошибка; проверьте указанные декларации.');
        if (related.some(target => target.ambiguous)) {
            warnings.push('Для атрибута найдено несколько записей-кандидатов. Связь неоднозначна: показаны все источники, ни один не выбран автоматически.');
            warningSourceIds.push(...related.filter(target => target.ambiguous).map(target => target.sourceId));
        }
        const duplicates = record.guid ? candidates(record.guid, scope) : [];
        const otherDeclarations = duplicates.filter(other => other.owner.filePath !== owner.filePath || other.record.offset !== record.offset)
            .map(other => ({ label: `${other.owner.fullName}.${other.record.name}`,
                sourceId: addSource(`${other.owner.fullName}.${other.record.name}`, other.owner.filePath, other.record.line, other.record.column) }));
        const labelAttribute = record.attributes.find(attribute => attribute.name === 'name' || attribute.name === 'displayName');
        let label = labelAttribute && /^"([\s\S]*)"$/.exec(labelAttribute.value);
        label = label ? label[1] : null;
        let localizedLabel = null;
        if (label && /^\$[^$]+\$$/.test(label) && services.resolveLocalizedLabel) {
            localizedLabel = await services.resolveLocalizedLabel(label.slice(1, -1), owner);
        }
        return { name: record.name, kind: record.kind || 'record', owner: owner.fullName, guid: record.guid, label: localizedLabel || label, localizationKey: localizedLabel ? label : null,
            value: record.value, source: { filePath: owner.filePath, line: record.line, column: record.column },
            filePath: owner.filePath, line: record.line, column: record.column,
            scopeRoot: scope.root, scopeLabel: scope.root || 'Граница checkout не определена; источники показаны явно',
            sourceLabel: `${scope.root ? path.relative(scope.root, owner.filePath) : owner.filePath}:${record.line + 1}`,
            sourceId, ownerSourceId, links, attributes, related, otherDeclarations, warnings, warningSourceIds,
            usages: null, notice: 'Статические декларации исходников, не данные runtime-БД и не фактические права пользователя.',
            unknownValue: record.guid ? null : record.value };
    }

    async function readDocument(filePath) {
        const open = vscode.workspace.textDocuments.find(document => !document.isClosed && document.languageId === 'bl' && document.uri.fsPath === filePath);
        if (open) return open;
        const text = await services.readFile(filePath);
        const lines = text.split(/\r?\n/);
        return { uri: vscode.Uri.file(filePath), languageId: 'bl', lineCount: lines.length,
            getText: range => !range ? text : lines[range.start.line].slice(range.start.character, range.end.character),
            lineAt: line => ({ text: lines[line] }),
            getWordRangeAtPosition(position, expression = /\w+/) {
                const regex = new RegExp(expression.source, 'g');
                let found;
                while ((found = regex.exec(lines[position.line]))) if (position.character >= found.index && position.character < found.index + found[0].length) {
                    return new vscode.Range(position.line, found.index, position.line, found.index + found[0].length);
                }
                return null;
            } };
    }

    async function collectUsages(match, scope, model, token) {
        const entries = { symbol: [], literal: [], text: [] };
        if (cancelled(token)) return null;
        const fingerprints = new Map(index.fileContentHashes);
        const source = await readDocument(match.owner.filePath);
        const sourceVersion = source.version;
        const versions = new Map(vscode.workspace.textDocuments.filter(doc => doc.languageId === 'bl').map(doc => [doc, doc.version]));
        const stale = () => cancelled(token) || source.version !== sourceVersion || Array.from(versions).some(([doc, version]) => doc.version !== version)
            || fingerprints.size !== index.fileContentHashes.size
            || Array.from(fingerprints).some(([file, hash]) => index.fileContentHashes.get(file) !== hash);
        const add = (group, filePath, line, column, kind) => {
            const id = model.links.length;
            const label = `${path.basename(filePath)}:${line + 1}:${column + 1}`;
            model.links.push({ id, label, filePath, line, column });
            entries[group].push({ id, label, filePath, line, column, kind });
        };
        const names = declarationsFor(match.owner).filter(record => record.name === match.record.name);
        const symbols = names.length > 1 ? [] : await referenceProvider.provideReferences(source, new vscode.Position(match.record.line, match.record.column), { includeDeclaration: false }, token);
        if (names.length > 1) model.warnings.push('Имя декларации объявлено несколько раз в одном классе. BL-ссылки неоднозначны и не приписаны отдельной декларации.');
        if (stale()) return null;
        for (const reference of symbols) if (withinRoot(reference.uri.fsPath, scope.root)) {
            add('symbol', reference.uri.fsPath, reference.range.start.line, reference.range.start.character, 'symbol');
        }
        const files = match.record.guid ? index.getGuidReferenceCandidates(match.record.guid) : new Set();
        let failures = 0;
        for (const filePath of files) {
            if (stale()) return null;
            if (!withinRoot(filePath, scope.root)) continue;
            let document;
            try { document = await readDocument(filePath); }
            catch (error) {
                if (error.code === 'ENOENT') index.removeFile(filePath);
                else failures++;
                continue;
            }
            for (const occurrence of occurrences(document)) if (occurrence.guid === match.record.guid) {
                const group = occurrence.kind === 'literal' || occurrence.kind === 'code' ? 'literal' : 'text';
                add(group, filePath, occurrence.line, occurrence.column, occurrence.kind);
            }
            await new Promise(resolve => setImmediate(resolve));
        }
        if (stale()) return null;
        if (failures) { entries.partial = `не удалось прочитать ${failures} файлов`; model.warnings.push(`Поиск GUID неполный: не удалось прочитать ${failures} файлов.`); }
        model.usages = entries;
        return model;
    }

    async function currentMatch(match) {
        await ensureIndexReady();
        const owner = index.getClassByFile(match.owner.filePath);
        if (!owner) return null;
        if (owner === match.owner) return match;
        const records = declarationsFor(owner).filter(record => record.name === match.record.name && record.kind === match.record.kind);
        if (match.sourceHash && match.sourceHash === index.fileContentHashes.get(owner.filePath)) {
            const unchanged = records.find(record => record.offset === match.record.offset && record.guid === match.record.guid);
            return unchanged ? sourceMatch(owner, unchanged) : null;
        }
        const exact = records.filter(record => record.guid === match.record.guid);
        const record = exact.length === 1 ? exact[0] : records.length === 1 ? records[0] : null;
        return record ? sourceMatch(owner, record) : null;
    }

    async function openCard(match, scope, withUsages = false, token) {
        if (cancelled(token)) return null;
        const next = await currentMatch(match);
        if (cancelled(token)) return null;
        if (!next || next.record.guid !== match.record.guid) {
            vscode.window.showWarningMessage('Декларация изменилась во время выбора. Выполните поиск записи заново.');
            return null;
        }
        match = next;
        let model = await recordModel(match, scope);
        if (cancelled(token)) return null;
        const panel = vscode.window.createWebviewPanel('bl.recordCard', `${match.record.kind === 'constant' ? 'GUID' : 'Запись'}: ${match.record.name}`, vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [] });
        const state = { panel, match, scope, model, revision: index.revision, busy: false, closed: false,
            view: withUsages ? 'usages' : 'details', searchState: 'idle', searchMessage: '' };
        const captureSources = () => new Map(state.model.links.map(link => [link.filePath, index.fileContentHashes.get(link.filePath)]));
        state.sources = captureSources();
        panels.add(state);
        const paint = (focusUsages = false) => {
            if (!state.closed) panel.webview.html = renderRecordCardHtml(state.model, crypto.randomBytes(16).toString('hex'), {
                view: state.view, searchState: state.searchState, searchMessage: state.searchMessage, focusUsages
            });
        };
        const commit = (next, nextModel) => {
            state.match = next;
            state.model = nextModel;
            state.revision = index.revision;
            state.sources = captureSources();
        };
        const clearUsages = () => {
            if (!state.model.usages) return;
            const ids = ['symbol', 'literal', 'text'].flatMap(group => state.model.usages[group].map(use => use.id));
            // Usage links are appended after all metadata/evidence links.
            if (ids.length) state.model.links = state.model.links.slice(0, Math.min(...ids));
            delete state.model.usages;
            state.sources = captureSources();
        };
        // Publish the panel before searching. Never commit links from an
        // interrupted search; they belong only to its fresh temporary model.
        const search = async searchToken => {
            state.busy = true;
            clearUsages();
            state.view = 'usages';
            state.searchState = 'loading';
            state.searchMessage = '';
            paint(true);
            try {
                const next = await currentMatch(state.match);
                if (state.closed) return null;
                const fresh = next && await recordModel(next, scope);
                const result = fresh && await collectUsages(next, scope, fresh, searchToken);
                if (state.closed) return null;
                if (!result || cancelled(searchToken)) {
                    // Remove old usage IDs/results, even when retrying a search.
                    clearUsages();
                    state.searchState = cancelled(searchToken) ? 'cancelled' : 'stale';
                    return null;
                }
                commit(next, result);
                state.searchState = result.usages.partial ? 'partial' : 'ready';
                return result;
            } catch (error) {
                if (!state.closed) {
                    clearUsages();
                    state.searchState = 'error';
                    state.searchMessage = error.message;
                }
                return null;
            } finally {
                state.busy = false;
                paint(state.view === 'usages');
            }
        };
        paint();
        const subscription = panel.webview.onDidReceiveMessage(async message => {
            if (state.closed || !message) return;
            if (message.type === 'setView') {
                if (['details', 'usages'].includes(message.view)) state.view = message.view;
                return;
            }
            if (state.busy || !['openSource', 'refresh', 'findUsages'].includes(message.type)) return;
            if (message.type === 'openSource' && (!Number.isSafeInteger(message.id) || message.id < 0 || message.id >= state.model.links.length)) return;
            if (message.type === 'findUsages') { await search({ get isCancellationRequested() { return state.closed || disposed; } }); return; }
            state.busy = true;
            try {
                await ensureIndexReady();
                if (state.closed) return;
                if (message.type === 'openSource' && state.revision === index.revision) {
                    const target = state.model.links[message.id];
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.filePath));
                    await ensureIndexReady();
                    if (state.closed) return;
                    if (Array.from(state.sources).every(([file, hash]) => index.fileContentHashes.get(file) === hash)) {
                        const position = new vscode.Position(target.line, target.column);
                        await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
                        return;
                    }
                }
                const next = await currentMatch(state.match);
                if (state.closed) return;
                if (!next) {
                    clearUsages();
                    state.searchState = 'stale';
                    paint();
                    vscode.window.showWarningMessage('Декларация удалена или неоднозначно изменена. Откройте карточку заново.');
                    return;
                }
                const nextModel = await recordModel(next, scope);
                if (state.closed) return;
                commit(next, nextModel);
                state.searchState = 'idle';
                paint();
                if (message.type === 'openSource') vscode.window.showWarningMessage('Исходники изменились: карточка обновлена. Выберите источник ещё раз.');
            } catch (error) {
                if (!state.closed) vscode.window.showWarningMessage(`Не удалось обновить карточку: ${error.message}`);
            } finally { state.busy = false; }
        });
        panel.onDidDispose(() => { state.closed = true; subscription.dispose(); panels.delete(state); });
        if (withUsages) return search(token);

        return model;
    }

    async function selectedRecord(argument, token) {
        await ensureIndexReady(token);
        if (cancelled(token)) return null;
        const editor = vscode.window.activeTextEditor;
        const uri = sourceUri(argument && argument.sourceUri) || sourceUri(argument && argument.filePath) || editor && editor.document.uri;
        const scope = await chooseScope(uri, token);
        if (!scope || cancelled(token)) return null;
        await ensureIndexReady(token);
        if (cancelled(token)) return null;
        if (argument && argument.filePath && argument.name) {
            const owner = index.getClassByFile(argument.filePath);
            if (!owner || !withinRoot(owner.filePath, scope.root)) return null;
            const records = declarationsFor(owner).filter(record => record.name === argument.name
                && (argument.offset === undefined || record.offset === argument.offset));
            const match = await chooseRecord(records.map(record => sourceMatch(owner, record)), token);
            return match && !cancelled(token) ? { match, scope } : null;
        }
        const guid = normalizeGuid(typeof argument === 'string' ? argument : argument && argument.guid);
        if (!guid && (typeof argument === 'string' || argument && argument.guid !== undefined)) {
            vscode.window.showWarningMessage('Некорректный GUID: нужен полный UUID без кавычек и пробелов.');
            return null;
        }
        const matches = (guid ? candidates(guid, scope) : editor ? await recordsAt(editor.document, editor.selection.active, token) : [])
            .filter(match => withinRoot(match.owner.filePath, scope.root));
        const match = await chooseRecord(matches, token);
        return match && !cancelled(token) ? { match, scope } : null;
    }

    async function lookupGuid(argument, token) {
        await ensureIndexReady(token);
        if (cancelled(token)) return null;
        const editor = vscode.window.activeTextEditor;
        const uri = sourceUri(argument && argument.sourceUri) || editor && editor.document.uri;
        const scope = await chooseScope(uri, token);
        if (!scope || cancelled(token)) return null;
        let value = typeof argument === 'string' ? argument : argument && argument.guid;
        if (value === undefined) {
            const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim().slice(0, 256) : null;
            const at = editor && guidAt(editor.document, editor.selection.active);
            const result = await chooseGuidDeclaration(scope, selected || (at ? at.guid : ''), token);
            if (!result || cancelled(token)) return null;
            if (result.match) return openCard(result.match, scope, false, token);
            value = result.guid;
        }
        const guid = normalizeGuid(value);
        if (!guid) { vscode.window.showWarningMessage('Некорректный GUID: нужен полный UUID без кавычек и пробелов.'); return null; }
        await ensureIndexReady(token);
        if (cancelled(token)) return null;
        const matches = candidates(guid, scope);
        if (!matches.length) { vscode.window.showInformationMessage(`GUID ${guid}: статическая декларация records или GUID-константы не найдена. UUID в произвольном выражении/тексте и runtime-БД этим lookup не проверяются.`); return null; }
        const match = await chooseRecord(matches, token);
        return match && !cancelled(token) ? openCard(match, scope, false, token) : null;
    }

    async function showRecordCard(argument, token) {
        const selected = await selectedRecord(argument, token);
        if (!selected) { if (!cancelled(token)) vscode.window.showInformationMessage('Выберите GUID, имя записи records или статической GUID-константы.'); return null; }
        return openCard(selected.match, selected.scope, false, token);
    }

    async function showGuidUsages(argument, token) {
        const selected = await selectedRecord(argument, token);
        return selected ? openCard(selected.match, selected.scope, true, token) : null;
    }

    const api = {
        lookupGuid, showRecordCard, showGuidUsages,
        definitionProvider: { async provideDefinition(document, position, token) {
            if (cancelled(token)) return null;
            const at = guidAt(document, position);
            if (!at || at.kind !== 'literal') return definitionProvider.provideDefinition(document, position, token);
            await ensureIndexReady(token);
            if (cancelled(token)) return null;
            updateIndexFromDocument(document);
            return candidates(at.guid, { root: scopeFor(document.uri) }).map(match => new vscode.Location(vscode.Uri.file(match.owner.filePath),
                new vscode.Range(match.record.line, match.record.column, match.record.line, match.record.column + match.record.name.length)));
        } },
        hoverProvider: { async provideHover(document, position, token) {
            const at = guidAt(document, position);
            if (at && at.kind !== 'literal') return null;
            const matches = await recordsAt(document, position, token);
            if (!matches.length || cancelled(token)) return null;
            const models = await Promise.all(matches.map(match => recordModel(match, { root: scopeFor(document.uri) })));
            if (cancelled(token)) return null;
            const contents = models.flatMap((model, index) => {
                const markdown = new vscode.MarkdownString(renderRecordHover(model));
                markdown.isTrusted = false;
                // VS Code 1.60 has boolean trust only. Isolate the generated
                // action block: no source-controlled text is trusted, and URI
                // arguments cannot terminate a Markdown link.
                const args = encodeURIComponent(JSON.stringify([{ filePath: model.filePath, name: model.name,
                    offset: matches[index].record.offset, sourceUri: document.uri.fsPath }]))
                    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
                const actions = new vscode.MarkdownString(`[Открыть карточку](command:bl.showRecordCard?${args}) · [Использования](command:bl.showGuidUsages?${args})`);
                actions.isTrusted = true;
                return [markdown, actions];
            });
            const range = at ? new vscode.Range(position.line, at.column, position.line, at.column + 36) : document.getWordRangeAtPosition(position);
            return new vscode.Hover(contents, range);
        } },
        register(context) {
            for (const [name, command] of [['bl.lookupGuid', lookupGuid], ['bl.showRecordCard', showRecordCard], ['bl.showGuidUsages', showGuidUsages]]) {
                context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
                    try { return await command(...args); }
                    catch (error) { vscode.window.showWarningMessage(`Не удалось выполнить поиск записи BL: ${error.message}`); return null; }
                }));
            }
            context.subscriptions.push({ dispose: api.dispose });
        },
        dispose() { disposed = true; for (const picker of Array.from(pickers)) picker.hide(); pickers.clear(); for (const state of Array.from(panels)) state.panel.dispose(); panels.clear(); }
    };
    return api;
}

module.exports = { createGuidNavigation, findGuidOccurrences, withinRoot };
