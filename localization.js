const path = require('path');
const fs = require('fs');
const { withinRoot } = require('./guidNavigation');
const { parseNls, normalizeLocale, resolveTranslation } = require('./localizationModel');
const { completionContext, completionCandidates } = require('./localizationCompletion');
const { localizationLiterals, presentation } = require('./localizationPresentation');

function createLocalization(vscode, services) {
    let disposed = false, revision = 0, renameRevision = 0, discovery = null, timer = null;
    const snapshots = new Map(), parsed = new Map();
    const diagnostics = vscode.languages.createDiagnosticCollection('z8bl-localization');
    const decoration = vscode.window.createTextEditorDecorationType({ color: 'transparent',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
    const config = uri => vscode.workspace.getConfiguration('bl', uri);
    const settings = uri => ({ locale: normalizeLocale(config(uri).get('i18n.locale', 'ru')),
        mode: config(uri).get('i18n.displayMode', 'translations'),
        required: config(uri).get('i18n.requiredLocales', []).map(normalizeLocale) });
    const cancelled = token => disposed || token && token.isCancellationRequested;
    function rootFor(uri) {
        if (!uri || uri.scheme !== 'file') return null;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return null;
        const root = folder.uri.fsPath;
        let checkout = null;
        for (let directory = path.dirname(uri.fsPath); withinRoot(directory, root); directory = path.dirname(directory)) {
            if (fs.existsSync(path.join(directory, '.git'))) checkout = directory;
            if (directory === root || directory === path.dirname(directory)) break;
        }
        return checkout || root;
    }
    const eligibleSource = (uri, suffix) => {
        if (!uri || uri.scheme !== 'file' || !uri.fsPath.endsWith(suffix)) return false;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return false;
        return !path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep)
            .some(part => ['target', 'build', 'node_modules', '.git'].includes(part));
    };
    const resource = uri => eligibleSource(uri, '.nls');
    const blResource = uri => eligibleSource(uri, '.bl');
    const renameChanged = uri => { if (blResource(uri)) renameRevision++; };
    const excludes = () => [...new Set(['**/target/**', '**/build/**', '**/node_modules/**', '**/.git/**',
        ...config().get('index.exclude', [])])];
    function discover() {
        if (!discovery) { const patterns = excludes(); discovery = vscode.workspace.findFiles('**/*.nls', `{${patterns.join(',')}}`); }
        return discovery;
    }
    function parse(text, file) {
        const old = parsed.get(file);
        if (old && old.text === text) return old.result;
        const result = { ...parseNls(text, file), filePath: file, text };
        parsed.set(file, { text, result });
        return result;
    }
    async function snapshot(uri) {
        const root = rootFor(uri), epoch = revision;
        if (!root) return null;
        if (snapshots.has(root)) return snapshots.get(root);
        const promise = (async () => {
            try {
                const files = (await discover()).filter(file => resource(file) && withinRoot(file.fsPath, root) && rootFor(file) === root);
                // findFiles honours all user exclusions. Open buffers overlay only
                // discovered paths; a new file joins on create/save discovery.
                const resources = await Promise.all(files.map(async file => {
                    const doc = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.fsPath === file.fsPath);
                    try { return parse(doc ? doc.getText() : await services.readFile(file.fsPath), file.fsPath); }
                    catch (_) { return { filePath: file.fsPath, locale: null, entries: [], text: '', issues: [{ start: 0, end: 0, message: 'Не удалось прочитать .nls-ресурс.' }] }; }
                }));
                return { root, epoch, resources };
            } catch (_) {
                return { root, epoch, resources: [{ filePath: root, locale: null, entries: [], text: '', issues: [{ start: 0, end: 0, message: 'Не удалось обнаружить .nls-ресурсы.' }] }] };
            }
        })();
        snapshots.set(root, promise);
        return promise;
    }
    const current = (state, document, version, token) => state && state.epoch === revision && !document.isClosed
        && document.version === version && !cancelled(token);
    const rangeFor = (doc, item) => new vscode.Range(doc.positionAt(item.start), doc.positionAt(item.end));
    const literalAt = (doc, pos) => localizationLiterals(doc.getText()).find(item => {
        const at = doc.offsetAt(pos); return at >= item.start && at < item.end;
    });
    function hoverText(item, locale, result) {
        const md = new vscode.MarkdownString();
        md.appendText(`Ключ: ${item.key}\nЯзык: ${locale}\n`);
        if (result.status === 'found') md.appendText(`Перевод: ${result.value}\n`);
        else md.appendText(`${result.status === 'missing' ? 'Перевод отсутствует' : result.status === 'conflict' ? 'Конфликт переводов' : 'Индекс языка неполон'}\n`);
        for (const entry of result.sources) md.appendText(`Источник: ${entry.filePath}\n${entry.value}\n`);
        for (const problem of result.problems) md.appendText(`Ресурс: ${problem.filePath}\n${problem.issues.map(issue => issue.message).join('\n')}\n`);
        return md; // Never trust resource-controlled Markdown/command URIs.
    }
    const warning = (document, item, message, code) => {
        const diagnostic = new vscode.Diagnostic(rangeFor(document, item), message, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'Z8BL i18n'; diagnostic.code = code;
        return diagnostic;
    };
    async function analyze(document) {
        if (disposed || document.isClosed) return;
        if (resource(document.uri)) {
            const result = parse(document.getText(), document.uri.fsPath);
            diagnostics.set(document.uri, result.issues.map(issue => warning(document, issue, issue.message, 'localization-resource')));
            return;
        }
        if (document.languageId !== 'bl') return;
        const version = document.version, state = await snapshot(document.uri);
        if (!current(state, document, version)) { if (!state) diagnostics.delete(document.uri); return; }
        const { locale, required } = settings(document.uri), items = localizationLiterals(document.getText()), result = [];
        for (const item of items) for (const language of new Set([locale, ...required])) {
            const resolved = resolveTranslation(state.resources, item.key, language);
            if (resolved.status === 'found') continue;
            const reason = resolved.status === 'missing' ? 'Нет перевода' : resolved.status === 'conflict' ? 'Конфликт переводов' : 'Невозможно проверить перевод: повреждён или недоступен ресурс';
            const evidence = [...resolved.sources, ...resolved.problems].map(source => source.filePath);
            result.push(warning(document, item, `${reason} «${item.key}» для ${language}.${evidence.length ? '\n' + [...new Set(evidence)].join('\n') : ''}`, `localization-${resolved.status}`));
        }
        diagnostics.set(document.uri, result);
    }
    async function render(editor) {
        if (!editor || editor.document.languageId !== 'bl' || disposed) return;
        const document = editor.document, version = document.version;
        const state = await snapshot(document.uri);
        if (!current(state, document, version)) { if (!state && !disposed) editor.setDecorations(decoration, []); return; }
        const { locale, mode } = settings(document.uri), translations = new Map();
        for (const item of localizationLiterals(document.getText())) {
            const result = resolveTranslation(state.resources, item.key, locale);
            if (result.status === 'found') translations.set(item.key, result.value);
        }
        const selections = editor.selections.map(selection => ({ start: document.offsetAt(selection.start), end: document.offsetAt(selection.end) }));
        const items = mode === 'translations' ? presentation(document.getText(), selections, translations) : [];
        editor.setDecorations(decoration, items.map(item => ({ range: rangeFor(document, item),
            hoverMessage: hoverText(item, locale, resolveTranslation(state.resources, item.key, locale)),
            renderOptions: { after: { contentText: item.display,
                color: new vscode.ThemeColor('editorInlayHint.foreground'),
                backgroundColor: new vscode.ThemeColor('editorInlayHint.background'),
                fontStyle: 'normal', fontWeight: 'normal', margin: `0 0 0 -${item.source.length}ch` } } })));
    }
    async function refresh() {
        if (disposed) return;
        await Promise.all([...vscode.workspace.textDocuments.map(analyze), ...vscode.window.visibleTextEditors.map(render)]);
    }
    function invalidate(uri, rediscover = false) {
        if (uri && !resource(uri)) return;
        revision++; snapshots.clear();
        if (rediscover) { discovery = null; parsed.clear(); }
        // Remove old text immediately, then repaint only a fresh snapshot.
        for (const editor of vscode.window.visibleTextEditors) if (editor.document.languageId === 'bl') editor.setDecorations(decoration, []);
        clearTimeout(timer); timer = setTimeout(refresh, 80);
    }
    const hoverProvider = { async provideHover(document, position, token) {
        const item = literalAt(document, position);
        if (!item || cancelled(token)) return null;
        const version = document.version, state = await snapshot(document.uri);
        if (!current(state, document, version, token)) return null;
        const { locale } = settings(document.uri);
        const action = new vscode.MarkdownString();
        const args = encodeURIComponent(JSON.stringify([{ sourceUri: document.uri.fsPath, key: item.key }]));
        action.appendMarkdown(`[Редактировать переводы](command:bl.editTranslation?${args})`);
        action.isTrusted = true; // Separate fixed command block; source text is untrusted.
        return new vscode.Hover([hoverText(item, locale, resolveTranslation(state.resources, item.key, locale)), action], rangeFor(document, item));
    } };
    const definitionProvider = { async provideDefinition(document, position, token) {
        const item = literalAt(document, position);
        if (!item || cancelled(token)) return null;
        const version = document.version, state = await snapshot(document.uri);
        if (!current(state, document, version, token)) return [];
        const { locale } = settings(document.uri), result = resolveTranslation(state.resources, item.key, locale);
        return result.sources.map(entry => {
            const source = state.resources.find(resource => resource.filePath === entry.filePath);
            const positionAt = offset => { const lines = source.text.slice(0, offset).split('\n'); return new vscode.Position(lines.length - 1, lines[lines.length - 1].length); };
            return new vscode.Location(vscode.Uri.file(entry.filePath), new vscode.Range(positionAt(entry.start), positionAt(entry.end)));
        });
    } };
    const completionProvider = { async provideCompletionItems(document, position, token) {
        if (document.languageId !== 'bl' || document.uri.scheme !== 'file' || cancelled(token) || document.isClosed) return [];
        const version = document.version, text = document.getText();
        const context = completionContext(text, document.offsetAt(position));
        if (!context) return [];
        const state = await snapshot(document.uri);
        if (!current(state, document, version, token) || state.root !== rootFor(document.uri)) return [];
        const { locale } = settings(document.uri);
        const candidates = completionCandidates(state, context.prefix, locale);
        const preview = value => value.replace(/[\s\x00-\x1f\x7f]+/g, ' ').slice(0, 120);
        const items = candidates.items.map(candidate => {
            const { key, result, sources } = candidate;
            const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Value);
            item.range = rangeFor(document, context);
            item.insertText = key + '$' + (context.closeQuote ? '"' : '');
            item.filterText = key + '$'; item.sortText = key;
            const caption = result.status === 'found' ? result.value === '' ? '(пустой перевод)' : preview(result.value)
                : result.status === 'missing' ? 'Нет перевода' : result.status === 'conflict' ? 'Конфликт переводов' : 'Индекс языка неполон';
            const evidence = result.sources.length ? result.sources : sources;
            const paths = [...new Set(evidence.map(source => path.relative(state.root, source.filePath)))];
            item.detail = `${locale} · ${caption} · ${paths.length === 1 ? paths[0] : 'Источников: ' + paths.length}`;
            const documentation = new vscode.MarkdownString();
            documentation.appendText(`Ключ: ${key}\nЯзык: ${locale}\n${caption}\n`);
            for (const source of evidence.slice(0, 8)) documentation.appendText(`\nИсточник (${source.locale}): ${path.relative(state.root, source.filePath)}\n${source.value.slice(0, 1024)}\n`);
            if (evidence.length > 8) documentation.appendText(`\nЕщё источников: ${evidence.length - 8}\n`);
            for (const problem of result.problems.slice(0, 8)) documentation.appendText(`\nНедоступный ресурс: ${path.relative(state.root, problem.filePath)}\n`);
            documentation.isTrusted = false; item.documentation = documentation;
            return item;
        });
        return current(state, document, version, token) ? new vscode.CompletionList(items, candidates.isIncomplete) : [];
    } };
    async function copyTranslation() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'bl') return;
        const doc = editor.document, version = doc.version, item = literalAt(doc, editor.selection.active);
        if (!item) { await vscode.window.showInformationMessage('Поставьте курсор на локализационный ключ.'); return; }
        const state = await snapshot(doc.uri);
        if (!current(state, doc, version) || editor !== vscode.window.activeTextEditor || literalAt(doc, editor.selection.active)?.start !== item.start) return;
        const result = resolveTranslation(state.resources, item.key, settings(doc.uri).locale);
        if (result.status !== 'found') { await vscode.window.showWarningMessage('Нет однозначного перевода для выбранного языка.'); return; }
        await vscode.env.clipboard.writeText(result.value);
    }
    return { hoverProvider, definitionProvider, completionProvider, snapshot, refresh,
        rootFor,
        async renameSnapshot(uri) {
            const root = rootFor(uri), epoch = renameRevision;
            if (!root || disposed) return null;
            // Always rediscover: new references and collisions matter even in
            // untouched files; no open-buffer bypass for excluded paths.
            discovery = null; snapshots.delete(root);
            const state = await snapshot(uri);
            const files = (await vscode.workspace.findFiles('**/*.bl', `{${excludes().join(',')}}`))
                .filter(file => blResource(file) && withinRoot(file.fsPath, root) && rootFor(file) === root);
            const blSources = await Promise.all(files.map(async file => {
                const doc = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.fsPath === file.fsPath);
                try { return { filePath: file.fsPath, text: doc ? doc.getText() : await services.readFile(file.fsPath) }; }
                catch (_) { throw Error('Не удалось прочитать BL-исходник для rename: ' + file.fsPath); }
            }));
            return state && { ...state, blSources, renameEpoch: epoch };
        },
        isRenameSnapshotCurrent(state) { return state && state.epoch === revision && state.renameEpoch === renameRevision && !disposed; },
        canCreateResource(uri, expectedRoot) {
            if (disposed || !resource(uri) || rootFor(uri) !== expectedRoot) return false;
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            // Use the editor's glob matcher with exactly the discovery patterns.
            return !excludes().some(pattern => vscode.languages.match({ scheme: 'file',
                pattern: new vscode.RelativePattern(folder.uri.fsPath, pattern) }, { uri, languageId: 'xml' }) > 0);
        },
        resourceCreated(uri) { invalidate(uri, true); },
        async searchScopes() {
            const epoch = revision, scopes = new Map();
            for (const uri of await discover()) {
                if (!resource(uri)) continue;
                const root = rootFor(uri);
                if (root && !scopes.has(root)) scopes.set(root, { root, uri });
            }
            for (const folder of vscode.workspace.workspaceFolders || []) {
                if (![...scopes.values()].some(scope => withinRoot(scope.root, folder.uri.fsPath))) {
                    const uri = vscode.Uri.file(path.join(folder.uri.fsPath, '__z8bl_i18n_search__.bl'));
                    const root = rootFor(uri); if (root) scopes.set(root, { root, uri });
                }
            }
            return { epoch, scopes: [...scopes.values()].sort((a, b) => a.root.localeCompare(b.root)) };
        },
        isSnapshotCurrent(state) { return state && state.epoch === revision && !disposed; },
        async freshSnapshot(uri) { snapshots.delete(rootFor(uri)); return snapshot(uri); },
        register(context, routedCompletion = completionProvider) {
            const watcher = vscode.workspace.createFileSystemWatcher('**/*.nls');
            const blWatcher = vscode.workspace.createFileSystemWatcher('**/*.bl');
            const subscriptions = [decoration, diagnostics, watcher, blWatcher,
                blWatcher.onDidCreate(renameChanged), blWatcher.onDidChange(renameChanged), blWatcher.onDidDelete(renameChanged),
                vscode.languages.registerCompletionItemProvider({ language: 'bl', scheme: 'file' }, routedCompletion, '$', '.'),
                watcher.onDidCreate(uri => invalidate(uri, true)), watcher.onDidChange(uri => invalidate(uri)), watcher.onDidDelete(uri => invalidate(uri, true)),
                vscode.commands.registerCommand('bl.copyTranslation', copyTranslation),
                vscode.commands.registerCommand('bl.toggleTranslations', async () => {
                    const doc = vscode.window.activeTextEditor?.document;
                    if (!doc || doc.languageId !== 'bl') return;
                    if (!vscode.workspace.getWorkspaceFolder(doc.uri)) {
                        await vscode.window.showInformationMessage('Откройте папку проекта, чтобы переключать локализацию для неё.');
                        return;
                    }
                    await config(doc.uri).update('i18n.displayMode', settings(doc.uri).mode === 'translations' ? 'keys' : 'translations', vscode.ConfigurationTarget.WorkspaceFolder);
                }),
                vscode.workspace.onDidOpenTextDocument(doc => { renameChanged(doc.uri); if (resource(doc.uri)) invalidate(doc.uri, true); return analyze(doc); }),
                vscode.workspace.onDidChangeTextDocument(event => { renameChanged(event.document.uri); if (resource(event.document.uri)) invalidate(event.document.uri); return Promise.all([analyze(event.document), renderDocument(event.document)]); }),
                vscode.workspace.onDidSaveTextDocument(doc => { renameChanged(doc.uri); if (resource(doc.uri)) invalidate(doc.uri, true); }),
                vscode.workspace.onDidCloseTextDocument(doc => { renameChanged(doc.uri); diagnostics.delete(doc.uri); if (resource(doc.uri)) invalidate(doc.uri); }),
                vscode.window.onDidChangeVisibleTextEditors(() => Promise.all(vscode.window.visibleTextEditors.map(render))),
                vscode.window.onDidChangeTextEditorSelection(event => render(event.textEditor)),
                vscode.window.onDidChangeActiveColorTheme(() => Promise.all(vscode.window.visibleTextEditors.map(render))),
                vscode.workspace.onDidChangeConfiguration(event => {
                    if (event.affectsConfiguration('bl.index.exclude')) invalidate(null, true);
                    else if (event.affectsConfiguration('bl.i18n')) { revision++; snapshots.clear(); return refresh(); }
                }),
                vscode.workspace.onDidChangeWorkspaceFolders(() => invalidate(null, true)),
                { dispose() { disposed = true; revision++; clearTimeout(timer); snapshots.clear(); parsed.clear(); } }];
            context.subscriptions.push(...subscriptions);
            return refresh();
        }
    };
    async function renderDocument(document) { await Promise.all(vscode.window.visibleTextEditors.filter(editor => editor.document === document).map(render)); }
}
module.exports = { createLocalization };
