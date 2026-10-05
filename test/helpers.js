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

let nextVersion = 1;
function document(filePath, text) {
    const lines = text.split(/\r?\n/);
    return {
        uri: { fsPath: filePath, scheme: 'file' }, fileName: filePath, languageId: 'bl', version: nextVersion++, isClosed: false,
        lineCount: lines.length,
        lineAt: line => ({ text: lines[line] }),
        getText: range => !range ? text : lines[range.start.line].slice(range.start.character, range.end.character),
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
        existsSync: file => contents.has(file)
    };
    const providers = {}, commands = new Map(), outputs = [], events = new Map(), watchers = new Map();
    const diagnostics = new Map();
    const diagnosticWrites = new Map();
    const disposable = () => ({ dispose() {} });
    const output = { clear() { outputs.length = 0; }, appendLine(line) { outputs.push(line); }, show() {}, dispose() {} };
    const vscode = {
        Position, Range, Location,
        CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
        EventEmitter: class {
            constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
            fire(value) { for (const listener of this.listeners) listener(value); }
            dispose() { this.listeners.clear(); }
        },
        Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
        DiagnosticSeverity: { Error: 0 },
        workspace: {
            textDocuments: openDocuments,
            getConfiguration: () => ({ get: (key, fallback) => settings[key] === undefined ? fallback : settings[key] }),
            findFiles: async (glob, exclude) => {
                searchCounts.set(glob, (searchCounts.get(glob) || 0) + 1);
                const includeRegex = globRegex(glob), excludeRegex = exclude ? globRegex(exclude) : null;
                return Array.from(contents.keys()).filter(file => includeRegex.test(file) && !(excludeRegex && excludeRegex.test(file)))
                    .map(fsPath => ({ fsPath, scheme: 'file' }));
            },
            createFileSystemWatcher: glob => ({
                onDidCreate: callback => { watchers.set(`${glob}:create`, callback); return disposable(); },
                onDidChange: callback => { watchers.set(`${glob}:change`, callback); return disposable(); },
                onDidDelete: callback => { watchers.set(`${glob}:delete`, callback); return disposable(); }, dispose() {}
            }),
            onDidOpenTextDocument: callback => { events.set('open', callback); return disposable(); },
            onDidChangeTextDocument: callback => { events.set('change', callback); return disposable(); },
            onDidCloseTextDocument: callback => { events.set('close', callback); return disposable(); },
            onDidSaveTextDocument: callback => { events.set('save', callback); return disposable(); },
            onDidChangeConfiguration: callback => { events.set('configuration', callback); return disposable(); },
            onDidChangeWorkspaceFolders: callback => { events.set('folders', callback); return disposable(); }
        },
        languages: {
            createDiagnosticCollection: () => ({ set(uri, entries) {
                diagnostics.set(uri.fsPath, entries);
                diagnosticWrites.set(uri.fsPath, (diagnosticWrites.get(uri.fsPath) || 0) + 1);
            }, delete(uri) { diagnostics.delete(uri.fsPath); }, dispose() {} }),
            getDiagnostics: uri => diagnostics.get(uri.fsPath) || [],
            registerDefinitionProvider: (selector, provider) => { providers.definition = provider; return disposable(); },
            registerReferenceProvider: (selector, provider) => { providers.references = provider; return disposable(); },
            registerCodeLensProvider: (selector, provider) => { providers.codeLens = provider; return disposable(); }, registerHoverProvider: disposable
        },
        window: { activeTextEditor: null, createOutputChannel: () => output, showWarningMessage: message => outputs.push(message) },
        commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); } }
    };
    const root = path.resolve(__dirname, '..');
    function load(file, dependencies) {
        const context = { module: { exports: {} }, require: name => dependencies[name] || require(name), console: { log() {} }, setTimeout, clearTimeout, setImmediate };
        vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
        return context.module.exports;
    }
    const indexModule = load('blIndex.js', { fs: mockFs });
    const analysisModule = load('documentAnalysis.js', { './blIndex': indexModule });
    const api = load('extension.js', { fs: mockFs, vscode, './blIndex': indexModule, './documentAnalysis': analysisModule });
    const context = { subscriptions: [] };
    await api.activate(context);
    return { providers, commands, outputs, vscode, contents, readCounts, searchCounts, diagnosticWrites,
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
        fileEvent(event, file) { return watchers.get(`${file.endsWith('.java') ? '**/*.java' : '**/*.bl'}:${event}`)({ fsPath: file, scheme: 'file' }); },
        foldersChanged() { events.get('folders')(); },
        dispose() { for (const subscription of context.subscriptions.slice().reverse()) subscription.dispose(); }
    };
}

module.exports = { document, positionOf, extension };
