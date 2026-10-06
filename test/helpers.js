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
        uri: { fsPath: filePath, scheme: 'file' }, fileName: filePath, languageId: filePath.endsWith('.js') ? 'javascript' : 'bl', version: nextVersion++, isClosed: false, isDirty: false,
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
        promises: { readFile: async file => read(file) },
        existsSync: file => contents.has(file) || (options.checkoutRoots || []).some(root => file === path.join(root, '.git'))
    };
    const providers = {}, commands = new Map(), outputs = [], events = new Map(), watchers = new Map();
    function subscribe(map, key, callback) {
        if (!map.has(key)) { const callbacks = new Set(); const fire = (...args) => Promise.all([...callbacks].map(fn => fn(...args))); fire.callbacks = callbacks; map.set(key, fire); }
        map.get(key).callbacks.add(callback);
        return { dispose: () => map.get(key).callbacks.delete(callback) };
    }
    const providerKey = selector => (Array.isArray(selector) ? selector[0] : selector).language === 'javascript' ? 'js' : '';
    const addProvider = (kind, selector, provider) => { providers[providerKey(selector) ? 'js' + kind[0].toUpperCase() + kind.slice(1) : kind] = provider; return disposable(); };
    const guidPickers = [], guidPickerResponses = [...(options.guidPickerResponses || [])];
    const prompts = [], quickPicks = [], messages = [], panels = [], sourceOpens = [], documentOpens = [], commandCalls = [];
    const requiredModules = [];
    const inputResponses = [...(options.inputResponses || [])], quickPickResponses = [...(options.quickPickResponses || [])];
    const diagnostics = new Map();
    const diagnosticWrites = new Map();
    const disposable = () => ({ dispose() {} });
    const output = { clear() { outputs.length = 0; }, appendLine(line) { outputs.push(line); }, show() {}, dispose() {} };
    const workspaceFolders = (options.workspaceFolders || []).map((folder, index) => typeof folder === 'string'
        ? { uri: { fsPath: folder, scheme: 'file' }, name: path.basename(folder), index }
        : folder);
    const isWithin = (file, folder) => file === folder || file.startsWith(folder.replace(/[\\/]$/, '') + path.sep);
    const vscode = {
        Position, Range, Location, Selection, MarkdownString,
        CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
        CompletionItemKind: { Value: 12, Property: 9 },
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
            getConfiguration: () => ({ get: (key, fallback) => settings[key] === undefined ? fallback : settings[key] }),
            findFiles: async (glob, exclude) => {
                searchCounts.set(glob, (searchCounts.get(glob) || 0) + 1);
                const includeRegex = globRegex(glob), excludeRegex = exclude ? globRegex(exclude) : null;
                return Array.from(contents.keys()).filter(file => includeRegex.test(file) && !(excludeRegex && excludeRegex.test(file)))
                    .map(fsPath => ({ fsPath, scheme: 'file' }));
            },
            createFileSystemWatcher: glob => ({
                onDidCreate: callback => subscribe(watchers, `${glob}:create`, callback),
                onDidChange: callback => subscribe(watchers, `${glob}:change`, callback),
                onDidDelete: callback => subscribe(watchers, `${glob}:delete`, callback), dispose() {}
            }),
            onDidOpenTextDocument: callback => subscribe(events, 'open', callback),
            onDidChangeTextDocument: callback => subscribe(events, 'change', callback),
            onDidCloseTextDocument: callback => subscribe(events, 'close', callback),
            onDidSaveTextDocument: callback => subscribe(events, 'save', callback),
            onDidChangeConfiguration: callback => subscribe(events, 'configuration', callback),
            onDidChangeWorkspaceFolders: callback => subscribe(events, 'folders', callback)
        },
        languages: {
            createDiagnosticCollection: () => ({ set(uri, entries) {
                diagnostics.set(uri.fsPath, entries);
                diagnosticWrites.set(uri.fsPath, (diagnosticWrites.get(uri.fsPath) || 0) + 1);
            }, delete(uri) { diagnostics.delete(uri.fsPath); }, dispose() {} }),
            getDiagnostics: uri => diagnostics.get(uri.fsPath) || [],
            registerDefinitionProvider: (selector, provider) => addProvider('definition', selector, provider),
            registerReferenceProvider: (selector, provider) => addProvider('references', selector, provider),
            registerCodeLensProvider: (selector, provider) => addProvider('codeLens', selector, provider),
            registerHoverProvider: (selector, provider) => addProvider('hover', selector, provider),
            registerCompletionItemProvider: (selector, provider) => addProvider('completion', selector, provider)
        },
        window: {
            activeTextEditor: null,
            createOutputChannel: () => output,
            showWarningMessage: message => { outputs.push(message); messages.push({ type: 'warning', message }); return Promise.resolve(); },
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
                        postMessage(message) { this.sentMessages.push(message); return Promise.resolve(true); },
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
        }, console: { log() {} }, setTimeout, clearTimeout, setImmediate };
        vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
        return context.module.exports;
    }
    const indexModule = load('blIndex.js', { fs: mockFs });
    const analysisModule = load('documentAnalysis.js', { './blIndex': indexModule });
    const dependencies = { fs: mockFs, 'node:fs': mockFs, vscode, './blIndex': indexModule, './documentAnalysis': analysisModule };
    if (fs.existsSync(path.join(root, 'recordCardView.js'))) dependencies['./recordCardView'] = load('recordCardView.js', dependencies);
    if (fs.existsSync(path.join(root, 'guidNavigation.js'))) dependencies['./guidNavigation'] = load('guidNavigation.js', dependencies);
    if (fs.existsSync(path.join(root, 'requestModel.js'))) dependencies['./requestModel'] = load('requestModel.js', dependencies);
    if (fs.existsSync(path.join(root, 'requestNavigation.js'))) dependencies['./requestNavigation'] = load('requestNavigation.js', dependencies);
    const api = load('extension.js', dependencies);
    const context = { subscriptions: [] };
    await api.activate(context);
    return { providers, commands, outputs, vscode, contents, readCounts, searchCounts, diagnosticWrites,
        prompts, quickPicks, messages, panels, sourceOpens, documentOpens, commandCalls, requiredModules,
        inputResponses, quickPickResponses, guidPickers, guidPickerResponses,
        open(doc) { events.get('open')(doc); },
        change(doc) { events.get('change')({ document: doc, contentChanges: [{}] }); },
        save(doc) { events.get('save')(doc); },
        close(doc) {
            const at = openDocuments.indexOf(doc);
            if (at >= 0) openDocuments.splice(at, 1);
            doc.isClosed = true;
            events.get('close')(doc);
        },
        configure(changes) {
            Object.assign(settings, changes);
            events.get('configuration')({ affectsConfiguration: prefix => Object.keys(changes).some(key => `bl.${key}` === prefix || `bl.${key}`.startsWith(prefix + '.')) });
        },
        fileEvent(event, file) { return watchers.get(`${file.endsWith('.java') ? '**/*.java' : file.endsWith('.js') ? '**/*.js' : '**/*.bl'}:${event}`)({ fsPath: file, scheme: 'file' }); },
        foldersChanged() { events.get('folders')(); },
        dispose() { for (const subscription of context.subscriptions.slice().reverse()) subscription.dispose(); }
    };
}

module.exports = { document, positionOf, extension };
