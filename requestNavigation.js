const path = require('path');
const fs = require('fs');
const { parseJsRequests, RequestRoutes, offsetFor } = require('./requestModel');
const { withinRoot } = require('./guidNavigation');
const { BlIndex } = require('./blIndex');
const JS_GENERATED_EXCLUDE = '**/target/**';

function createRequestNavigation(vscode, services) {
    const { index, ensureIndexReady, updateIndexFromDocument, readFile } = services;
    let disposed = false, generation = 0, discovery = null;
    const sources = new Map(), parsedJs = new Map(), routeCache = new Map(), scopedRoutes = new Map(), pickers = new Set();
    const developerJs = uri => {
        if (!uri) return false;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const directory = folder ? path.relative(folder.uri.fsPath, path.dirname(uri.fsPath)) : path.dirname(uri.fsPath);
        return !directory.split(path.sep).includes('target');
    };
    const cancelled = token => disposed || token && token.isCancellationRequested;
    const isJs = doc => doc && doc.uri.scheme === 'file' && doc.languageId === 'javascript' && developerJs(doc.uri);
    const openDocument = file => vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.fsPath === file);
    const boundedSet = (map, key, value) => { map.delete(key); map.set(key, value); if (map.size > 128) map.delete(map.keys().next().value); return value; };
    async function source(file) {
        const doc = openDocument(file);
        if (doc) return doc.getText();
        if (sources.has(file)) return sources.get(file);
        const epoch = generation;
        const text = await readFile(file);
        if (epoch === generation && !disposed) boundedSet(sources, file, text);
        return openDocument(file)?.getText() ?? text;
    }
    function routeIndex(root) {
        const version = `${generation}:${index.revision}`;
        const cached = scopedRoutes.get(root);
        if (cached && cached.version === version) return cached.routes;
        // Route evidence must never borrow a missing base/import from another
        // checkout. Unlike ordinary BL navigation, ambiguous ties are unknown.
        class ScopedIndex extends BlIndex {
            getClassByFullName(name, context) {
                const copies = this.classesByFullName.get(name);
                const candidates = copies ? this.preferNearbyClasses(context, [...copies.values()]) : [];
                return candidates.length === 1 ? candidates[0] : null;
            }
        }
        const scoped = new ScopedIndex();
        for (const owner of index.fileToClass.values()) if (withinRoot(owner.filePath, root)) scoped.addClass(owner);
        const routes = new RequestRoutes(scoped, source);
        boundedSet(scopedRoutes, root, { version, routes });
        return routes;
    }
    function invalidate(uri, rediscover = false) {
        generation++; routeCache.clear(); scopedRoutes.clear();
        if (uri) { sources.delete(uri.fsPath); parsedJs.delete(uri.fsPath); }
        else { sources.clear(); parsedJs.clear(); }
        if (rediscover) discovery = null;
    }
    function rootFor(uri) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return null;
        const root = folder.uri.fsPath;
        let checkout = null;
        for (let current = path.dirname(uri.fsPath); withinRoot(current, root); current = path.dirname(current)) {
            if (fs.existsSync(path.join(current, '.git'))) checkout = current;
            if (current === root || current === path.dirname(current)) break;
        }
        return checkout || root;
    }
    function ownersFor(name, root) {
        if (!root || typeof name !== 'string' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(name)) return [];
        const copies = index.classesByFullName.get(name);
        return copies ? [...copies.values()].filter(owner => withinRoot(owner.filePath, root)) : [];
    }
    async function model(owner, root = rootFor(vscode.Uri.file(owner.filePath))) {
        const key = `${root}:${owner.filePath}`, version = `${generation}:${index.revision}`;
        const cached = routeCache.get(key);
        if (cached && cached.version === version) return cached.promise;
        const promise = routeIndex(root).build(owner);
        boundedSet(routeCache, key, { version, promise });
        try { return await promise; } catch (error) { routeCache.delete(key); throw error; }
    }
    function js(text, file, tolerant = false) {
        const cached = parsedJs.get(file);
        if (cached && cached.text === text && cached.tolerant === tolerant) return cached.value;
        const value = parseJsRequests(text, tolerant);
        boundedSet(parsedJs, file, { text, tolerant, value });
        return value;
    }
    function callAt(document, position, tolerant = false) {
        const text = document.getText(), offset = document.offsetAt(position);
        const parsed = js(text, document.uri.fsPath, tolerant);
        const call = parsed.calls.filter(call => call.argumentStart <= offset && offset <= call.argumentEnd).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
        return call ? { call, offset, text } : { error: parsed.error };
    }
    const value = (call, key) => { const field = call.fields.get(key); return field && field.known ? field.value : undefined; };
    async function descriptor(call, root) {
        const request = value(call, 'request'), action = value(call, 'action');
        const owners = ownersFor(request, root), models = await Promise.all(owners.map(owner => model(owner, root)));
        const selector = action === 'action' ? 'name' : 'method', selected = value(call, selector);
        const matches = models.flatMap(model => model.routes.filter(route => route.action === action && route.selector === selector && route.value === selected));
        return { checkout: root, request, action, selector, selectorValue: selected, httpMethod: null,
            handlerFamily: action === 'read' ? 'getData' : action === 'content' ? 'processContentRequest' : action === 'action' ? 'Action' : null,
            confidence: matches.length ? 'confirmed' : owners.length ? 'partial' : 'unresolved', owners, models, matches, fields: call.fields };
    }
    async function sourceLocation(evidence) {
        const text = await source(evidence.filePath);
        const point = offset => {
            const lines = text.slice(0, offset).split(/\r?\n/);
            return new vscode.Position(lines.length - 1, lines.at(-1).length);
        };
        return new vscode.Location(vscode.Uri.file(evidence.filePath), new vscode.Range(point(evidence.start), point(evidence.end)));
    }
    async function classLocation(owner) {
        const text = await source(owner.filePath), start = offsetFor(text, owner.classLine, owner.classColumn);
        return sourceLocation({ filePath: owner.filePath, start, end: start + owner.className.length });
    }
    const uniqEvidence = items => [...new Map(items.map(item => [`${item.filePath}:${item.start}:${item.end}`, item])).values()];
    // Cross-language navigation is an explicit command, never a JS definition
    // provider: the native JavaScript service owns Cmd+Click / F12.
    async function showServerSources(uri) {
        const editor = vscode.window.activeTextEditor;
        if (disposed) return [];
        if (!editor || !isJs(editor.document) || uri && (uri.scheme !== editor.document.uri.scheme || uri.fsPath !== editor.document.uri.fsPath)) {
            await vscode.window.showInformationMessage('Поставьте курсор внутри HttpRequest.send(...) в исходном JavaScript-файле (не target/).');
            return [];
        }
        const document = editor.document, position = editor.selection.active, text = document.getText();
        const context = callAt(document, position);
        if (!context.call) {
            await vscode.window.showInformationMessage(context.error
                ? 'Не удалось разобрать JavaScript. Исправьте синтаксис и повторите поиск серверных исходников.'
                : 'Поставьте курсор внутри объекта запроса HttpRequest.send(...). Поддерживаются статически распознаваемые вызовы.');
            return [];
        }
        const picker = vscode.window.createQuickPick(); pickers.add(picker);
        let done = false, snapshot;
        const token = { get isCancellationRequested() { return done || disposed; } };
        const fresh = () => snapshot && snapshot.generation === generation && snapshot.revision === index.revision && document.getText() === text;
        picker.title = 'Z8BL: серверные BL-исходники'; picker.placeholder = 'Идёт поиск класса и подтверждённого маршрута…';
        picker.busy = true; picker.matchOnDescription = true; picker.matchOnDetail = true;
        const subscriptions = [];
        const finish = () => { if (done) return; done = true; subscriptions.forEach(s => s.dispose()); picker.dispose(); pickers.delete(picker); };
        subscriptions.push(picker.onDidHide(finish));
        subscriptions.push(picker.onDidAccept(async () => {
            const selected = picker.selectedItems[0];
            if (!selected || !selected.location || cancelled(token)) return;
            if (!fresh()) { await vscode.window.showWarningMessage('Исходники изменились. Повторите поиск серверных исходников.'); picker.hide(); return; }
            try {
                const doc = await vscode.workspace.openTextDocument(selected.location.uri);
                if (cancelled(token)) return;
                if (!fresh()) { await vscode.window.showWarningMessage('Исходники изменились. Повторите поиск серверных исходников.'); picker.hide(); return; }
                await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false, selection: selected.location.range });
                picker.hide();
            } catch (error) {
                picker.hide();
                await vscode.window.showWarningMessage(`Не удалось открыть серверный исходник: ${error.message}`);
            }
        }));
        picker.show();
        try {
            await ensureIndexReady(token);
            if (cancelled(token)) return [];
            snapshot = { generation, revision: index.revision };
            const info = await descriptor(context.call, rootFor(document.uri));
            const choices = [], seen = new Set();
            const add = (kind, label, location) => {
                const key = `${kind}:${location.uri.fsPath}:${location.range.start.line}:${location.range.start.character}`;
                if (seen.has(key)) return;
                seen.add(key);
                choices.push({ kind, location, label,
                    description: `${path.basename(location.uri.fsPath)}:${location.range.start.line + 1}`,
                    detail: `${info.request || '?'} — ${info.action || '?'} / ${info.selectorValue ?? '?'} — ${info.confidence === 'confirmed' ? 'маршрут подтверждён' : 'класс найден; прикладной маршрут статически не подтверждён'} — ${location.uri.fsPath}` });
            };
            for (const owner of info.owners) add('class', `Класс запроса: ${owner.fullName}`, await classLocation(owner));
            const dispatchers = info.models.flatMap(model => model.entries.filter(entry => entry.action === info.action).map(entry => entry.source));
            dispatchers.push(...info.matches.map(route => route.dispatcher));
            for (const evidence of uniqEvidence(dispatchers)) {
                const name = (await source(evidence.filePath)).slice(evidence.start, evidence.end);
                add('dispatcher', `Диспетчер: ${name}`, await sourceLocation(evidence));
            }
            for (const route of info.matches) {
                for (const evidence of uniqEvidence(route.targets)) {
                    const branch = evidence.filePath === route.branch.filePath && evidence.start === route.branch.start && evidence.end === route.branch.end;
                    const name = (await source(evidence.filePath)).slice(evidence.start, evidence.end);
                    add(branch ? 'branch' : 'handler', `${branch ? 'Ветка маршрута' : 'Обработчик'}: ${name}`, await sourceLocation(evidence));
                }
            }
            if (cancelled(token)) return [];
            picker.busy = false;
            if (!fresh()) { picker.items = []; picker.placeholder = 'Исходники изменились. Повторите поиск.'; return []; }
            picker.items = choices;
            picker.title = `Z8BL: серверные BL-исходники (${choices.length})`;
            picker.placeholder = !choices.length ? 'Класс запроса не разрешён в текущем checkout; динамические значения не вычисляются'
                : info.confidence === 'confirmed' ? 'Выберите класс, диспетчер, ветку или обработчик — открыть в текущей группе'
                    : 'Класс найден; прикладной маршрут статически не подтверждён. Выберите доступный исходник';
            return choices;
        } catch (error) {
            picker.hide();
            await vscode.window.showWarningMessage(`Не удалось найти серверные исходники: ${error.message}`);
            return [];
        }
    }
    const hoverProvider = {
        async provideHover(document, position, token) {
            if (!isJs(document) || cancelled(token)) return null;
            await ensureIndexReady(token);
            const epoch = generation, context = callAt(document, position);
            if (!context.call) return null;
            const field = [...context.call.fields.values()].find(field => field.start <= context.offset && context.offset <= field.end);
            if (!field || !['request', 'action', 'method', 'name'].includes(field.key)) return null;
            const info = await descriptor(context.call, rootFor(document.uri));
            const markdown = new vscode.MarkdownString();
            markdown.appendText(`Z8 request: ${info.request || 'динамический / не разрешён'}\n`);
            markdown.appendText(`action: ${info.action || 'не разрешён'}; ${info.selector}: ${info.selectorValue ?? 'не разрешён'}\n`);
            markdown.appendText(info.confidence === 'confirmed' ? 'Маршрут подтверждён исходниками. ПКМ → Z8BL → Найти серверные BL-исходники.'
                : info.owners.length ? 'Класс найден; прикладной маршрут статически не подтверждён. Динамические значения не вычисляются.'
                    : 'Класс не разрешён в текущем checkout. Короткие имена и динамические выражения не угадываются.');
            if (context.call.fields.has('method')) markdown.appendText('\nmethod — параметр прикладного маршрута, не HTTP-метод.');
            return cancelled(token) || epoch !== generation ? null : new vscode.Hover(markdown);
        }
    };
    const completionProvider = {
        async provideCompletionItems(document, position, token) {
            if (!isJs(document) || cancelled(token)) return [];
            await ensureIndexReady(token);
            const epoch = generation, context = callAt(document, position, true);
            if (!context.call) return [];
            const { call, offset, text } = context;
            const field = [...call.fields.values()].find(field => field.start <= offset && offset <= field.end);
            const info = await descriptor(call, rootFor(document.uri));
            const items = new Map();
            const add = (label, evidence, insertText, range) => {
                if (items.has(label)) return;
                const item = new vscode.CompletionItem(label, field ? vscode.CompletionItemKind.Value : vscode.CompletionItemKind.Property);
                item.insertText = insertText || label; if (range) item.range = range;
                item.detail = evidence ? `BL: ${path.basename(evidence.filePath)}` : 'BL request-класс текущего checkout';
                const documentation = new vscode.MarkdownString();
                documentation.appendText(evidence ? `${evidence.filePath}\nСтатически найдено в исходнике. Обязательность и тип параметра не установлены.` : 'Полное имя индексированного BL-класса. Не утверждает наличие конкретного HTTP-маршрута.');
                item.documentation = documentation; items.set(label, item);
            };
            let replaceRange;
            if (field) {
                const literal = text[field.start] === "'" || text[field.start] === '"';
                const start = field.start + (literal ? 1 : 0);
                const hasClosing = literal && text[field.end - 1] === text[field.start];
                const end = field.end - (hasClosing ? 1 : 0);
                const begin = document.positionAt(start), finish = document.positionAt(Math.max(start, end));
                if (begin.line !== position.line || finish.line !== position.line) return [];
                replaceRange = new vscode.Range(begin, finish);
                const insert = label => literal ? label.replace(/\\/g, '\\\\').replace(new RegExp(text[field.start], 'g'), '\\' + text[field.start]) : JSON.stringify(label);
                if (field.key === 'request') {
                    for (const owner of index.fileToClass.values()) if (withinRoot(owner.filePath, rootFor(document.uri)) && rootFor(document.uri)) {
                        if (cancelled(token) || epoch !== generation) return [];
                        const sourceText = await source(owner.filePath);
                        // Completion candidates need an explicit request attribute or a concrete dispatcher.
                        if (!/\[request\s+true\]/.test(sourceText) && !owner.methods.has('getData') && !owner.methods.has('processContentRequest')) continue;
                        add(owner.fullName, null, insert(owner.fullName), replaceRange);
                    }
                } else if (field.key === 'action') {
                    for (const model of info.models) {
                        for (const entry of model.entries) add(entry.action, entry.source, insert(entry.action), replaceRange);
                        for (const route of model.routes) add(route.action, route.dispatcher, insert(route.action), replaceRange);
                    }
                } else if (field.key === info.selector) for (const model of info.models) {
                    for (const route of model.routes) if (route.action === info.action && route.selector === field.key) add(route.value, route.branch, insert(route.value), replaceRange);
                }
            } else {
                // Only direct property positions, not callback arguments or nested value objects.
                const insideValue = [...call.fields.values()].some(f => f.start <= offset && offset <= f.end);
                if (insideValue) return [];
                const prefix = text.slice(call.argumentStart, offset);
                if (!/[{,]\s*[A-Za-z_]*$/.test(prefix)) return [];
                const prefixMatch = /[A-Za-z_]*$/.exec(prefix)[0];
                const range = new vscode.Range(document.positionAt(offset - prefixMatch.length), position);
                const addKey = (name, evidence) => { if (!call.fields.has(name) || name === prefixMatch) add(name, evidence, `${name}: `, range); };
                addKey('request'); addKey('action'); addKey(info.selector);
                const candidates = info.matches.length ? info.matches : info.models.flatMap(model => model.routes.filter(route => route.action === info.action));
                for (const route of candidates) for (const param of route.parameters) addKey(param.name, param.source);
                for (const entry of (info.matches.length ? [] : info.models.flatMap(model => model.entries).filter(entry => entry.action === info.action))) for (const param of entry.parameters) addKey(param.name, param.source);
            }
            return cancelled(token) || epoch !== generation ? [] : [...items.values()];
        }
    };
    async function clientCalls(document, position, token) {
        if (!document || document.languageId !== 'bl' || cancelled(token)) return [];
        await ensureIndexReady(token); updateIndexFromDocument(document);
        const root = rootFor(document.uri), owner = index.getClassByFile(document.uri.fsPath);
        if (!root || !owner) return [];
        const epoch = generation, revision = index.revision, offset = document.offsetAt(position);
        const ownModel = await model(owner), word = document.getWordRangeAtPosition(position);
        const classSelected = word && word.start.line === owner.classLine && word.start.character === owner.classColumn;
        const selectedEvidence = evidence => evidence && evidence.filePath === owner.filePath && evidence.start <= offset && offset < evidence.end;
        const ownRoutes = ownModel.routes.filter(route => route.targets.some(selectedEvidence) || selectedEvidence(route.dispatcher));
        // All supported helper routes stay in a request's inheritance chain,
        // or construct an explicitly referenced operation class. Use the BL
        // lexical index only as a negative prefilter before proving JS routes.
        const relatedFiles = index.getReferenceCandidates(owner.className);
        relatedFiles.add(owner.filePath);
        const potentialRequests = new Set(), scopedIndex = routeIndex(root).index;
        for (const candidate of scopedIndex.fileToClass.values()) {
            let current = candidate; const seen = new Set();
            while (current && !seen.has(current.filePath)) {
                seen.add(current.filePath);
                if (relatedFiles.has(current.filePath)) { potentialRequests.add(candidate.filePath); break; }
                current = scopedIndex.resolveBaseClass(current);
            }
        }
        const relevant = [];
        if (!discovery) {
            const excludes = [...new Set([JS_GENERATED_EXCLUDE, ...vscode.workspace.getConfiguration('bl').get('index.exclude', ['**/node_modules/**', '**/.git/**', '**/build/**'])])];
            const exclude = excludes.length > 1 ? `{${excludes.join(',')}}` : excludes[0] || null;
            discovery = vscode.workspace.findFiles('**/*.js', exclude);
        }
        const files = new Set((await discovery).map(uri => uri.fsPath));
        for (const doc of vscode.workspace.textDocuments) if (isJs(doc) && !doc.isClosed) files.add(doc.uri.fsPath);
        let count = 0;
        for (const file of files) {
            if (cancelled(token) || epoch !== generation || revision !== index.revision) return [];
            if (!withinRoot(file, root) || !developerJs(vscode.Uri.file(file))) continue;
            const text = await source(file);
            // This is only a negative prefilter, never evidence of a usage.
            // Confirm every remaining site with the strict AST and BL routes.
            if (!text.includes('HttpRequest')) continue;
            for (const call of js(text, file).calls) {
                const request = value(call, 'request');
                if (!ownersFor(request, root).some(candidate => potentialRequests.has(candidate.filePath))) continue;
                const info = await descriptor(call, root);
                let match = classSelected && info.owners.some(candidate => candidate.filePath === owner.filePath);
                if (!match) match = info.models.some(model => model.entries.some(entry => entry.action === info.action && selectedEvidence(entry.source)));
                if (!match) match = info.matches.some(route => route.targets.some(selectedEvidence) || selectedEvidence(route.dispatcher)
                    || ownRoutes.some(own => route.request === own.request && route.action === own.action && route.selector === own.selector && route.value === own.value));
                if (match) {
                    const field = call.fields.get(info.selector) || call.fields.get('request');
                    const atCall = field.start >= call.start && field.end <= call.end;
                    relevant.push({ filePath: file, start: atCall ? field.start : call.start, end: atCall ? field.end : call.start + 'HttpRequest.send'.length, request, action: info.action,
                        selector: info.selector, value: info.selectorValue, confidence: info.confidence, generation: epoch });
                }
            }
            if (++count % 12 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        return cancelled(token) || epoch !== generation || revision !== index.revision ? [] : relevant;
    }
    async function showClientCalls() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'bl') return vscode.window.showWarningMessage('Поставьте курсор на BL request-класс, маршрут или обработчик.');
        const picker = vscode.window.createQuickPick(); pickers.add(picker);
        let done = false;
        const token = { get isCancellationRequested() { return done || disposed; } };
        picker.title = 'Z8BL: клиентские JS-вызовы'; picker.placeholder = 'Идёт поиск подтверждённых request-вызовов…';
        picker.busy = true; picker.matchOnDescription = true; picker.matchOnDetail = true;
        const subscriptions = [];
        const finish = () => { if (done) return; done = true; subscriptions.forEach(s => s.dispose()); picker.dispose(); pickers.delete(picker); };
        subscriptions.push(picker.onDidHide(finish));
        subscriptions.push(picker.onDidAccept(async () => {
            const selected = picker.selectedItems[0];
            if (!selected || !selected.call) return;
            if (selected.call.generation !== generation) { await vscode.window.showWarningMessage('Исходники изменились. Повторите поиск клиентских вызовов.'); picker.hide(); return; }
            const target = await sourceLocation(selected.call);
            if (selected.call.generation !== generation || cancelled(token)) return;
            const doc = await vscode.workspace.openTextDocument(target.uri);
            if (selected.call.generation !== generation || cancelled(token)) return;
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false, selection: target.range });
            picker.hide();
        }));
        picker.show();
        try {
            const epoch = generation;
            const calls = await clientCalls(editor.document, editor.selection.active, token);
            if (cancelled(token)) return [];
            if (epoch !== generation) { picker.busy = false; picker.placeholder = 'Исходники изменились. Повторите поиск.'; return []; }
            picker.items = await Promise.all(calls.map(async call => {
                const source = await sourceLocation(call);
                return { label: `${path.basename(call.filePath)}:${source.range.start.line + 1}`, description: `${call.action || '?'} / ${call.value || call.request}`,
                    detail: `${call.request} — ${call.confidence === 'confirmed' ? 'маршрут подтверждён' : 'класс найден, маршрут не разрешён'} — ${call.filePath}`, call };
            }));
            if (cancelled(token)) return [];
            if (epoch !== generation) { picker.items = []; picker.busy = false; picker.placeholder = 'Исходники изменились. Повторите поиск.'; return []; }
            picker.busy = false;
            picker.title = `Z8BL: клиентские JS-вызовы (${calls.length})`;
            picker.placeholder = calls.length ? 'Выберите вызов для перехода в JS' : 'Подтверждённых JS-вызовов не найдено; динамические вызовы не учитываются';
            return calls;
        } catch (error) {
            picker.hide();
            await vscode.window.showWarningMessage(`Не удалось найти клиентские вызовы: ${error.message}`);
            return [];
        }
    }
    function register(context) {
        const selector = { language: 'javascript', scheme: 'file' };
        context.subscriptions.push(vscode.languages.registerHoverProvider(selector, hoverProvider),
            vscode.languages.registerCompletionItemProvider(selector, completionProvider, "'", '"', ':', ',', '.'),
            vscode.commands.registerCommand('bl.showClientCalls', showClientCalls),
            vscode.commands.registerCommand('bl.showServerSources', showServerSources));
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.js');
        watcher.onDidCreate(uri => { if (developerJs(uri)) invalidate(uri, true); });
        watcher.onDidChange(uri => { if (developerJs(uri)) invalidate(uri); });
        watcher.onDidDelete(uri => { if (developerJs(uri)) invalidate(uri, true); });
        const blWatcher = vscode.workspace.createFileSystemWatcher('**/*.bl');
        blWatcher.onDidCreate(uri => invalidate(uri)); blWatcher.onDidChange(uri => invalidate(uri)); blWatcher.onDidDelete(uri => invalidate(uri));
        context.subscriptions.push(watcher, blWatcher);
        const relevant = doc => isJs(doc) || doc.languageId === 'bl';
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => { if (relevant(doc) && sources.get(doc.uri.fsPath) !== doc.getText()) invalidate(doc.uri); }),
            vscode.workspace.onDidChangeTextDocument(event => { if (relevant(event.document)) invalidate(event.document.uri); }),
            vscode.workspace.onDidSaveTextDocument(doc => { if (relevant(doc)) invalidate(doc.uri); }),
            vscode.workspace.onDidCloseTextDocument(doc => { if (relevant(doc)) invalidate(doc.uri); }));
        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => invalidate(null, true)),
            vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('bl.index.exclude')) invalidate(null, true); }),
            { dispose() { disposed = true; generation++; for (const picker of pickers) picker.hide(); sources.clear(); parsedJs.clear(); routeCache.clear(); scopedRoutes.clear(); } });
    }
    return { register, invalidate, hoverProvider, completionProvider, clientCalls, descriptor };
}
module.exports = { createRequestNavigation };
