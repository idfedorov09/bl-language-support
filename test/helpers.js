const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Position {
    constructor(line, character) { Object.assign(this, { line, character }); }
}

class Range {
    constructor(a, b, c, d) {
        this.start = typeof a === 'number' ? new Position(a, b) : a;
        this.end = typeof a === 'number' ? new Position(c, d) : b;
    }
}

class Location {
    constructor(uri, range) {
        this.uri = uri;
        this.range = range instanceof Range ? range : new Range(range, range);
    }
}

class Selection extends Range {
    constructor(anchor, active) {
        const forward = anchor.line < active.line || (anchor.line === active.line && anchor.character <= active.character);
        super(forward ? anchor : active, forward ? active : anchor);
        this.anchor = anchor;
        this.active = active;
        this.isEmpty = anchor.line === active.line && anchor.character === active.character;
    }
}

class MarkdownString {
    constructor(value = '', supportThemeIcons = false) {
        this.value = value;
        this.supportThemeIcons = supportThemeIcons;
    }
    appendMarkdown(value) { this.value += value; return this; }
    appendText(value) { this.value += value.replace(/[\\`*_{}\[\]()#+\-.!>]/g, '\\$&'); return this; }
    appendCodeblock(value, language = '') { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\`\n`; return this; }
}

let nextVersion = 1;
function document(filePath, text) {
    const lines = text.split(/\r?\n/);
    const offsets = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
    const offsetAt = position => (offsets[position.line] || 0) + position.character;
    return {
        uri: { fsPath: filePath, scheme: 'file' }, fileName: filePath, languageId: filePath.endsWith('.js') ? 'javascript' : filePath.endsWith('.nls') ? 'xml' : 'bl', version: nextVersion++, isClosed: false, isDirty: false,
        lineCount: lines.length,
        lineAt: line => ({ text: lines[line], range: new Range(line, 0, line, lines[line].length) }),
        getText: range => !range ? text : text.slice(offsetAt(range.start), offsetAt(range.end)),
        offsetAt,
        getWordRangeAtPosition(position, regex = /\w+/) {
            const re = new RegExp(regex.source, 'g');
            let match;
            while ((match = re.exec(lines[position.line]))) {
                if (match.index <= position.character && position.character < match.index + match[0].length) {
                    return new Range(position.line, match.index, position.line, match.index + match[0].length);
                }
            }
            return null;
        },
        positionAt(offset) {
            const prefix = text.slice(0, offset).split(/\r?\n/);
            return new Position(prefix.length - 1, prefix.at(-1).length);
        }
    };
}

function positionOf(doc, text, word, occurrence = 0) {
    const lines = doc.getText().split(/\r?\n/);
    const line = lines.findIndex(line => line.includes(text));
    if (line < 0) throw new Error(`Missing test line: ${text}`);
    let column = -1;
    for (let i = 0; i <= occurrence; i++) column = lines[line].indexOf(word, column + 1);
    if (column < 0) throw new Error(`Missing test word: ${word}`);
    return new Position(line, column + Math.min(1, word.length - 1));
}

function globRegex(glob) {
    let source = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*' && glob[i + 1] === '*') {
            i++;
            if (glob[i + 1] === '/') { i++; source += '(?:.*/)?'; }
            else source += '.*';
        } else if (ch === '*') source += '[^/]*';
        else if (ch === '?') source += '[^/]';
        else if (ch === '{') source += '(?:';
        else if (ch === '}') source += ')';
        else if (ch === ',') source += '|';
        else source += ch.replace(/[\\^$+?.()|[\]]/g, '\\$&');
    }
    return new RegExp(`^${source}$`);
}

async function extension(files, openDocuments = [], options = {}) {
    const contents = new Map(Object.entries(files));
    const settings = { ...options.configuration };
    const readCounts = new Map(), searchCounts = new Map();
    const read = file => {
        readCounts.set(file, (readCounts.get(file) || 0) + 1);
        if (!contents.has(file)) throw Object.assign(new Error(`Missing fixture: ${file}`), { code: 'ENOENT' });
        return contents.get(file);
    };
    const mockFs = {
        readFileSync: read,
        promises: { readFile: async file => read(file),
            realpath: async file => options.realPaths && options.realPaths[file] || file,
            readdir: async directory => [...new Set([...contents.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file)))] },
        existsSync: file => contents.has(file) || (options.checkoutRoots || []).some(root => file === path.join(root, '.git'))
    };
    const providerRegistrations = [], providers = {}, commands = new Map(), outputs = [], events = new Map(), watchers = new Map();
    function subscribe(map, key, callback) {
        if (!map.has(key)) { const callbacks = new Set(); const fire = (...args) => Promise.all([...callbacks].map(fn => fn(...args))); fire.callbacks = callbacks; map.set(key, fire); }
        map.get(key).callbacks.add(callback);
        return { dispose: () => map.get(key).callbacks.delete(callback) };
    }
    const providerKey = selector => (Array.isArray(selector) ? selector[0] : selector).language === 'javascript' ? 'js' : '';
    const addProvider = (kind, selector, provider) => { providers[providerKey(selector) ? 'js' + kind[0].toUpperCase() + kind.slice(1) : kind] = provider; return disposable(); };
    const guidPickers = [], guidPickerResponses = [...(options.pickerResponses || options.guidPickerResponses || [])];
    const prompts = [], quickPicks = [], messages = [], panels = [], sourceOpens = [], documentOpens = [], commandCalls = [];
    const requiredModules = [];
    const inputResponses = [...(options.inputResponses || [])], quickPickResponses = [...(options.quickPickResponses || [])];
    const diagnostics = new Map();
    const localizationDiagnostics = new Map(), decorations = [], clipboard = [], appliedEdits = [], storageWrites = [];
    const storedDrafts = options.workspaceState || new Map();
    const storageControl = { fail: false };
    const diagnosticWrites = new Map();
    const disposable = () => ({ dispose() {} });
    const output = { clear() { outputs.length = 0; }, appendLine(line) { outputs.push(line); }, show() {}, dispose() {} };
    const workspaceFolders = (options.workspaceFolders || []).map((folder, index) => typeof folder === 'string'
        ? { uri: { fsPath: folder, scheme: 'file' }, name: path.basename(folder), index }
        : folder);
    const isWithin = (file, folder) => file === folder || file.startsWith(folder.replace(/[\\/]$/, '') + path.sep);
    const vscode = {
        Position, Range, Location, Selection, MarkdownString,
        RelativePattern: class { constructor(base, pattern) { this.base = typeof base === 'string' ? base : base.fsPath; this.pattern = pattern; } },
        WorkspaceEdit: class { constructor() { this.entries = []; this.creates = []; }
            createFile(uri, options) { this.creates.push({uri, options}); }
            insert(uri, position, text) { this.replace(uri, new vscode.Range(position, position), text); }
            replace(uri, range, text) { this.entries.push({ uri, range, text }); } },
        ThemeColor: class { constructor(id) { this.id = id; } },
        DecorationRangeBehavior: { ClosedClosed: 1 },
        ConfigurationTarget: { WorkspaceFolder: 3 },
        env: { clipboard: { writeText: async text => { clipboard.push(text); } } },
        CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
        CompletionItemKind: { Method: 1, Field: 4, Variable: 5, Class: 6, Enum: 12, Value: 11, Property: 9, EnumMember: 19, Constant: 20 },
        CompletionList: class { constructor(items = [], isIncomplete = false) { Object.assign(this, {items, isIncomplete}); } },
        Hover: class { constructor(contents, range) { this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range; } },
        ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
        TextEditorRevealType: { InCenter: 0 },
        CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
        EventEmitter: class {
            constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
            fire(value) { for (const listener of this.listeners) listener(value); }
            dispose() { this.listeners.clear(); }
        },
        Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        workspace: {
            textDocuments: openDocuments,
            isTrusted: options.isTrusted !== false,
            async applyEdit(edit) {
                if (edit.creates.length) {
                    if (options.beforeResourceCreate) await options.beforeResourceCreate(edit, contents, vscode);
                    if (edit.creates.some(item => contents.has(item.uri.fsPath))) return false;
                    for (const item of edit.creates) {
                        contents.set(item.uri.fsPath, '');
                        const doc = document(item.uri.fsPath, ''); openDocuments.push(doc);
                        if (events.has('open')) await events.get('open')(doc);
                    }
                }
                const groups = new Map();
                for (const entry of edit.entries) { if (!groups.has(entry.uri.fsPath)) groups.set(entry.uri.fsPath, []); groups.get(entry.uri.fsPath).push(entry); }
                const updates = [];
                for (const [file, edits] of groups) {
                    const doc = openDocuments.find(doc => !doc.isClosed && doc.uri.fsPath === file);
                    if (!doc) return false;
                    let text = doc.getText();
                    for (const entry of edits.map(e => ({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.text })).sort((a,b)=>b.start-a.start))
                        text = text.slice(0, entry.start) + entry.text + text.slice(entry.end);
                    updates.push([doc, text]);
                }
                appliedEdits.push(edit);
                for (const [doc,text] of updates) { Object.assign(doc, document(doc.uri.fsPath,text)); doc.isDirty = true; if (events.has('change')) await events.get('change')({document:doc,contentChanges:[{}]}); }
                return true;
            },
            workspaceFolders,
            getWorkspaceFolder: uri => workspaceFolders.filter(folder => isWithin(uri.fsPath, folder.uri.fsPath))
                .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0],
            async openTextDocument(uri) {
                const file = typeof uri === 'string' ? uri : uri.fsPath;
                documentOpens.push(file);
                const existing = openDocuments.find(doc => !doc.isClosed && doc.uri.fsPath === file);
                if (existing) return existing;
                const opened = document(file, read(file));
                openDocuments.push(opened);
                if (events.has('open')) events.get('open')(opened);
                return opened;
            },
            getConfiguration: () => ({ inspect: key => ({ globalValue: (options.userConfiguration || settings)[key],
                defaultValue: undefined, workspaceValue: (options.workspaceConfiguration || {})[key] }), get: (key, fallback) => settings[key] === undefined ? fallback : settings[key],
                update: async (key, value) => { settings[key] = value; if (events.has('configuration')) await events.get('configuration')({ affectsConfiguration: prefix => `bl.${key}`.startsWith(prefix) }); } }),
            findFiles: async (glob, exclude) => {
                const pattern = typeof glob === 'string' ? glob : glob.pattern;
                searchCounts.set(pattern, (searchCounts.get(pattern) || 0) + 1);
                const includeRegex = globRegex(pattern), excludeRegex = exclude ? globRegex(exclude) : null;
                return Array.from(contents.keys()).filter(file => (typeof glob === 'string'
                    ? (!options.strictWorkspaceDiscovery || workspaceFolders.some(folder => isWithin(file, folder.uri.fsPath))) && includeRegex.test(file)
                    : isWithin(file, glob.base) && includeRegex.test(path.relative(glob.base, file).replace(/\\/g, '/')))
                    && !(excludeRegex && excludeRegex.test(file)))
                    .map(fsPath => ({ fsPath, scheme: 'file' }));
            },
            createFileSystemWatcher: glob => {
                const name = typeof glob === 'string' ? glob : path.join(glob.base, glob.pattern).replace(/\\/g, '/');
                const subscriptions = [];
                const on = (event, callback) => { const subscription = subscribe(watchers, `${name}:${event}`, callback); subscriptions.push(subscription); return subscription; };
                return { onDidCreate: callback => on('create', callback), onDidChange: callback => on('change', callback),
                    onDidDelete: callback => on('delete', callback), dispose() { for (const subscription of subscriptions) subscription.dispose(); } };
            },
            onDidOpenTextDocument: callback => subscribe(events, 'open', callback),
            onDidChangeTextDocument: callback => subscribe(events, 'change', callback),
            onDidCloseTextDocument: callback => subscribe(events, 'close', callback),
            onDidSaveTextDocument: callback => subscribe(events, 'save', callback),
            onDidChangeConfiguration: callback => subscribe(events, 'configuration', callback),
            onDidChangeWorkspaceFolders: callback => subscribe(events, 'folders', callback)
        },
        languages: {
            match(selector, doc) { return selector.scheme === doc.uri.scheme && globRegex(selector.pattern.pattern).test(path.relative(selector.pattern.base, doc.uri.fsPath).replace(/\\/g, '/')) ? 10 : 0; },
            createDiagnosticCollection: name => ({ set(uri, entries) {
                (name === 'z8bl-localization' ? localizationDiagnostics : diagnostics).set(uri.fsPath, entries);
                diagnosticWrites.set(uri.fsPath, (diagnosticWrites.get(uri.fsPath) || 0) + 1);
            }, delete(uri) { (name === 'z8bl-localization' ? localizationDiagnostics : diagnostics).delete(uri.fsPath); }, dispose() {} }),
            getDiagnostics: uri => diagnostics.get(uri.fsPath) || [],
            registerDefinitionProvider: (selector, provider) => addProvider('definition', selector, provider),
            registerReferenceProvider: (selector, provider) => addProvider('references', selector, provider),
            registerCodeLensProvider: (selector, provider) => addProvider('codeLens', selector, provider),
            registerHoverProvider: (selector, provider) => addProvider('hover', selector, provider),
            registerCompletionItemProvider: (selector, provider, ...triggers) => { providerRegistrations.push({selector, provider, triggers}); return addProvider('completion', selector, provider); }
        },
        window: {
            activeTextEditor: null,
            visibleTextEditors: [],
            createTextEditorDecorationType: options => { const type = { options, dispose() {} }; decorations.push(type); return type; },
            onDidChangeVisibleTextEditors: callback => subscribe(events, 'visibleEditors', callback),
            onDidChangeTextEditorSelection: callback => subscribe(events, 'selection', callback),
            onDidChangeActiveColorTheme: callback => subscribe(events, 'theme', callback),
            createOutputChannel: () => output,
            showWarningMessage: (message, ...actions) => { outputs.push(message); messages.push({ type: 'warning', message, actions }); return Promise.resolve((options.warningResponses || []).shift()); },
            showInformationMessage: message => { messages.push({ type: 'information', message }); return Promise.resolve(); },
            showErrorMessage: message => { messages.push({ type: 'error', message }); return Promise.resolve(); },
            async showInputBox(config) { prompts.push(config); return inputResponses.shift(); },
            async showQuickPick(items, config, token) {
                const entries = await items;
                quickPicks.push({ items: entries, config, token });
                const response = quickPickResponses.shift();
                return typeof response === 'function' ? response(entries) : typeof response === 'number' ? entries[response] : response;
            },
            createQuickPick() {
                const listeners = { value: new Set(), accept: new Set(), hide: new Set() };
                let value = '';
                const picker = {
                    items: [], selectedItems: [], disposed: false, hidden: false,
                    get value() { return value; },
                    set value(next) { value = next; for (const listener of listeners.value) listener(next); },
                    onDidChangeValue: listener => subscribe('value', listener),
                    onDidAccept: listener => subscribe('accept', listener),
                    onDidHide: listener => subscribe('hide', listener),
                    get visibleItems() {
                        const query = value.toLowerCase();
                        return this.items.filter(item => item.alwaysShow || [item.label,
                            this.matchOnDescription && item.description, this.matchOnDetail && item.detail]
                            .some(text => text && text.toLowerCase().includes(query)));
                    },
                    accept(item = this.visibleItems[0]) { this.selectedItems = item ? [item] : []; for (const listener of listeners.accept) listener(); },
                    hide() { if (this.hidden) return; this.hidden = true; for (const listener of [...listeners.hide]) listener(); },
                    dispose() { this.disposed = true; Object.values(listeners).forEach(set => set.clear()); },
                    show() {
                        this.initialValue = value;
                        setImmediate(async () => {
                            const response = guidPickerResponses.shift();
                            if (typeof response === 'function') { await response(picker); return; }
                            if (typeof response === 'number') picker.accept(picker.visibleItems[response]);
                            else if (typeof response === 'string') { picker.value = response; picker.accept(); }
                            else picker.hide();
                        });
                    }
                };
                const subscribe = (event, listener) => { listeners[event].add(listener); return { dispose: () => listeners[event].delete(listener) }; };
                guidPickers.push(picker);
                return picker;
            },
            async showTextDocument(doc, config) {
                const position = new Position(0, 0);
                const editor = { document: doc, selection: new Selection(position, position), reveals: [],
                    revealRange(range, kind) { this.reveals.push({ range, kind }); } };
                sourceOpens.push({ document: doc, config, editor });
                vscode.window.activeTextEditor = editor;
                return editor;
            },
            createWebviewPanel(viewType, title, column, config) {
                const received = new Set(), disposal = new Set();
                const panel = {
                    viewType, title, column, config, disposed: false, reveals: [],
                    webview: {
                        html: '', cspSource: 'vscode-webview://fixture', sentMessages: [],
                        postMessage(message) { this.sentMessages.push(JSON.parse(JSON.stringify(message))); return Promise.resolve(true); },
                        onDidReceiveMessage(callback) { received.add(callback); return { dispose: () => received.delete(callback) }; }
                    },
                    onDidDispose(callback) { disposal.add(callback); return { dispose: () => disposal.delete(callback) }; },
                    reveal(...args) { this.reveals.push(args); },
                    async receiveMessage(message) { for (const callback of received) await callback(message); },
                    dispose() { this.disposed = true; for (const callback of disposal) callback(); received.clear(); disposal.clear(); }
                };
                panels.push(panel);
                return panel;
            }
        },
        commands: {
            registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); },
            async executeCommand(name, ...args) {
                commandCalls.push({ name, args });
                return commands.has(name) ? commands.get(name)(...args) : undefined;
            }
        }
    };
    const root = path.resolve(__dirname, '..');
    function load(file, dependencies) {
        const context = { module: { exports: {} }, require: name => {
            requiredModules.push(name);
            if (/^(?:node:)?(?:https?|net|tls|child_process)$/.test(name)) throw new Error(`Forbidden runtime I/O in fixture: ${name}`);
            return dependencies[name] || require(name);
        }, console: { log() {} }, Buffer, setTimeout, clearTimeout, setImmediate };
        vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
        return context.module.exports;
    }
    const indexModule = load('blIndex.js', { fs: mockFs });
    const analysisModule = load('documentAnalysis.js', { './blIndex': indexModule });
    const dependencies = { fs: mockFs, 'node:fs': mockFs, vscode, './blIndex': indexModule, './documentAnalysis': analysisModule };
    dependencies['./projectContext'] = load('projectContext.js', dependencies);
    if (fs.existsSync(path.join(root, 'recordCardView.js'))) dependencies['./recordCardView'] = load('recordCardView.js', dependencies);
    if (fs.existsSync(path.join(root, 'guidNavigation.js'))) dependencies['./guidNavigation'] = load('guidNavigation.js', dependencies);
    if (fs.existsSync(path.join(root, 'requestModel.js'))) dependencies['./requestModel'] = load('requestModel.js', dependencies);
    if (fs.existsSync(path.join(root, 'requestNavigation.js'))) dependencies['./requestNavigation'] = load('requestNavigation.js', dependencies);
    dependencies['./localizationModel'] = load('localizationModel.js', dependencies);
    dependencies['./localizationPresentation'] = load('localizationPresentation.js', dependencies);
    dependencies['./localizationCompletion'] = load('localizationCompletion.js', dependencies);
    dependencies['./blCompletion'] = load('blCompletion.js', dependencies);
    dependencies['./localization'] = load('localization.js', dependencies);
    const aiModule = load('i18nAi.js', dependencies);
    dependencies['./i18nAi'] = { ...aiModule, requestChat: (prepared, key, token) => aiModule.requestChat(prepared, key, token, options.aiRequest) };
    for (const name of ['localizationEdits', 'i18nDraft', 'i18nView', 'i18nResources', 'i18nRename', 'i18nToolkit', 'i18nSearch']) dependencies['./' + name] = load(name + '.js', dependencies);
    const api = load('extension.js', dependencies);
    const secrets = options.secrets || new Map(), secretWrites = [];
    const context = { subscriptions: [], secrets: { get: async key => secrets.get(key),
        store: async (key, value) => { secrets.set(key, value); secretWrites.push(key); }, delete: async key => { secrets.delete(key); } }, workspaceState: { get: (key, fallback) => storedDrafts.has(key) ? storedDrafts.get(key) : fallback,
        update: async (key, value) => { if (storageControl.fail) throw Error('storage unavailable'); storedDrafts.set(key, JSON.parse(JSON.stringify(value))); storageWrites.push({ key, value }); } } };
    await api.activate(context);
    return { providers, providerRegistrations, commands, outputs, vscode, contents, readCounts, searchCounts, diagnosticWrites,
        prompts, quickPicks, messages, panels, sourceOpens, documentOpens, commandCalls, requiredModules,
        localizationDiagnostics, decorations, clipboard, appliedEdits, storedDrafts, secrets, secretWrites, storageWrites, storageControl,
        async showEditor(doc, selection) {
            const at = doc.positionAt(0);
            const editor = { document: doc, selection: selection || new Selection(at, at), selections: [selection || new Selection(at, at)],
                applied: [], setDecorations(type, values) { this.applied = values; this.decorationType = type; },
                async edit(callback, editOptions) {
                    if (options.beforeEditorEdit) await options.beforeEditorEdit(editor);
                    const edit = new vscode.WorkspaceEdit(); callback({ replace: (range, text) => edit.replace(doc.uri, range, text) });
                    editor.lastEditOptions = editOptions;
                    if (options.editorEditResult === false || !edit.entries.length) return false;
                    return vscode.workspace.applyEdit(edit);
                } };
            vscode.window.activeTextEditor = editor; vscode.window.visibleTextEditors.push(editor);
            await events.get('visibleEditors')(); return editor;
        },
        selectionChanged(editor) { return events.get('selection')({ textEditor: editor }); },
        themeChanged() { return events.get('theme')(); },
        inputResponses, quickPickResponses, guidPickers, guidPickerResponses,
        open(doc) { return events.get('open')(doc); },
        change(doc) { return events.get('change')({ document: doc, contentChanges: [{}] }); },
        save(doc) { events.get('save')(doc); },
        close(doc) {
            const at = openDocuments.indexOf(doc);
            if (at >= 0) openDocuments.splice(at, 1);
            doc.isClosed = true;
            events.get('close')(doc);
        },
        configure(changes) {
            Object.assign(settings, changes);
            return events.get('configuration')({ affectsConfiguration: prefix => Object.keys(changes).some(key => `bl.${key}` === prefix || `bl.${key}`.startsWith(prefix + '.')) });
        },
        fileEvent(event, file) {
            return Promise.all([...watchers].filter(([key]) => key.endsWith(`:${event}`) && globRegex(key.slice(0, -event.length - 1)).test(file)
                && (path.isAbsolute(key.slice(0, -event.length - 1)) || !options.strictWorkspaceDiscovery || workspaceFolders.some(folder => isWithin(file, folder.uri.fsPath))))
                .map(([, fire]) => fire({ fsPath: file, scheme: 'file' })));
        },
        foldersChanged() { events.get('folders')(); },
        dispose() { for (const subscription of context.subscriptions.slice().reverse()) subscription.dispose(); }
    };
}

module.exports = { document, positionOf, extension };
