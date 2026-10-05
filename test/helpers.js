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

function document(filePath, text) {
    const lines = text.split(/\r?\n/);
    return {
        uri: { fsPath: filePath, scheme: 'file' }, fileName: filePath, languageId: 'bl',
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

async function extension(files, openDocuments = []) {
    const contents = new Map(Object.entries(files));
    const mockFs = {
        readFileSync: file => {
            if (!contents.has(file)) throw new Error(`Missing fixture: ${file}`);
            return contents.get(file);
        },
        existsSync: file => contents.has(file)
    };
    const providers = {}, commands = new Map(), outputs = [];
    let diagnostics = [];
    const disposable = () => ({ dispose() {} });
    const output = { clear() { outputs.length = 0; }, appendLine(line) { outputs.push(line); }, show() {}, dispose() {} };
    const vscode = {
        Position, Range, Location,
        Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
        DiagnosticSeverity: { Error: 0 },
        workspace: {
            textDocuments: openDocuments,
            findFiles: async glob => Array.from(contents.keys())
                .filter(file => glob === '**/*.bl' ? file.endsWith('.bl') : file.endsWith(glob.replace(/^\*\*\//, '')))
                .map(fsPath => ({ fsPath, scheme: 'file' })),
            createFileSystemWatcher: () => ({ onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable, dispose() {} }),
            onDidOpenTextDocument: disposable, onDidChangeTextDocument: disposable, onDidCloseTextDocument: disposable
        },
        languages: {
            createDiagnosticCollection: () => ({ set(uri, entries) { diagnostics = entries; }, delete() {}, dispose() {} }),
            getDiagnostics: () => diagnostics,
            registerDefinitionProvider: (selector, provider) => { providers.definition = provider; return disposable(); },
            registerReferenceProvider: (selector, provider) => { providers.references = provider; return disposable(); },
            registerCodeLensProvider: disposable, registerHoverProvider: disposable
        },
        window: { activeTextEditor: null, createOutputChannel: () => output, showWarningMessage: message => outputs.push(message) },
        commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); } }
    };
    const root = path.resolve(__dirname, '..');
    function load(file, dependencies) {
        const context = { module: { exports: {} }, require: name => dependencies[name] || require(name), console: { log() {} } };
        vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
        return context.module.exports;
    }
    const indexModule = load('blIndex.js', { fs: mockFs });
    const api = load('extension.js', { fs: mockFs, vscode, './blIndex': indexModule });
    await api.activate({ subscriptions: [] });
    return { providers, commands, outputs, vscode, contents };
}

module.exports = { document, positionOf, extension };
