const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { presentation, missingTranslations } = require('./localization-prototype/presentation');
const { document } = require('./helpers');
class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
class Range { constructor(start, end) { Object.assign(this, { start, end }); } }
class Selection extends Range {}
class MarkdownString { appendText(text) { this.value = (this.value || '') + text; } }
const source = 'string title = "$Workspace.title$";';

test('localization prototype only presents exact supported literals, not comments, other strings or unknown keys', () => {
    const text = source + '\n// "$Workspace.title$"\n/* "$Workspace.title$" */\n' +
        '"prefix $Workspace.title$"; \'$Workspace.title$\'; "$Prototype.missing$";';
    const result = presentation(text, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, '"$Workspace.title$"');
    assert.equal(result[0].display, '"Документы"');
    assert.equal(text.slice(result[0].start, result[0].end), result[0].source);
    assert.equal(presentation('"escaped \\" $Workspace.title$"', []).length, 0);
});

test('all cursors and selections touching the literal reveal source without rewriting it', () => {
    const item = presentation(source, [])[0];
    for (let at = item.start; at <= item.end; at++) {
        assert.equal(presentation(source, [{ start: at, end: at }]).length, 0);
    }
    assert.equal(presentation(source, [{ start: 0, end: source.length }]).length, 0);
    assert.equal(presentation(source, [{ start: 0, end: 0 }, { start: item.start + 2, end: item.start + 2 }]).length, 0);
    assert.equal(presentation(source, [{ start: 0, end: 0 }]).length, 1);
    assert.equal(source.slice(item.start, item.end), '"$Workspace.title$"');
});

test('CRLF coordinates and long, special, multiline and Unicode display candidates stay source-independent', () => {
    const text = '\r\n' + ['short', 'long', 'special', 'multiline', 'unicode'].map(key => `"$Prototype.${key}$"`).join('\r\n');
    const result = presentation(text, []);
    assert.equal(result.length, 5);
    assert.equal(result[0].start, 2);
    assert.ok(result.every(item => text.slice(item.start, item.end) === item.source));
    assert.equal(result[3].display, '"Первая строка\\nВторая строка"');
    assert.ok(result.every(item => !item.display.includes('\n')));
});

test('dev prototype decorations/toggle do not write source or auto-open files in production', async () => {
    const code = fs.readFileSync(path.join(__dirname, 'localization-prototype', 'extension.js'), 'utf8');
    const doc = document('/fixture/Example.bl', source);
    const decorations = [], commands = new Map(), events = {};
    const subscription = name => callback => { events[name] = callback; return { dispose() {} }; };
    const editor = { document: doc, selections: [new Selection(new Position(0, 0), new Position(0, 0))],
        setDecorations(type, options) { decorations.push({ type, options }); } };
    const warnings = new Map();
    const vscode = {
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
        DiagnosticSeverity: { Warning: 1 },
        languages: { createDiagnosticCollection() { return { set(uri, items) { warnings.set(uri.fsPath, items); }, delete(uri) { warnings.delete(uri.fsPath); }, dispose() { warnings.clear(); } }; } },
        ExtensionMode: { Production: 1, Development: 2 },
        Range, MarkdownString, ThemeColor: class { constructor(id) { this.id = id; } },
        DecorationRangeBehavior: { ClosedClosed: 1 },
        window: { visibleTextEditors: [editor],
            createOutputChannel() { return { appendLine() {}, dispose() {} }; },
            createTextEditorDecorationType(options) { return { options, dispose() {} }; },
            onDidChangeVisibleTextEditors: subscription('visible'),
            onDidChangeTextEditorSelection: subscription('selection'),
            onDidChangeActiveColorTheme: subscription('theme') },
        workspace: { textDocuments: [doc], onDidChangeTextDocument: subscription('text'), onDidOpenTextDocument: subscription('open'), onDidCloseTextDocument: subscription('close') },
        commands: { registerCommand(name, fn) { commands.set(name, fn); return { dispose() {} }; } }
    };
    const sandbox = { module: { exports: {} }, require: name => {
        if (name === 'vscode') return vscode;
        if (name === './presentation') return require('./localization-prototype/presentation');
        throw Error(`Unexpected dependency ${name}`);
    } };
    vm.runInNewContext(code, sandbox); await sandbox.module.exports.activate({ subscriptions: [], extensionMode: 1 });
    assert.equal(decorations.at(-1).options.length, 1);
    const item = decorations.at(-1).options[0];
    assert.equal(doc.getText(item.range), '"$Workspace.title$"');
    assert.equal(item.renderOptions.after.contentText, '"Документы"');
    assert.equal(item.renderOptions.after.margin, '0 0 0 -19ch');
    assert.equal(item.renderOptions.after.color.id, 'editorInlayHint.foreground');
    assert.equal(item.renderOptions.after.backgroundColor.id, 'editorInlayHint.background');
    assert.equal(item.renderOptions.after.border, undefined);
    assert.equal(item.renderOptions.after.borderColor, undefined);
    assert.equal(item.renderOptions.after.fontStyle, 'normal');
    assert.equal(item.renderOptions.after.fontWeight, 'normal');
    for (const kind of ['light', 'dark', 'highContrast']) {
        const before = decorations.length;
        events.theme({ kind });
        assert.equal(decorations.length, before + 1, 'theme change refreshes the visible replacement');
        assert.equal(decorations.at(-1).options[0].renderOptions.after.backgroundColor.id, 'editorInlayHint.background');
        assert.equal(doc.getText(), source);
    }
    assert.equal(item.hoverMessage.isTrusted, undefined);
    commands.get('z8blPrototype.toggle')(); assert.equal(decorations.at(-1).options.length, 0);
    commands.get('z8blPrototype.toggle')(); assert.equal(decorations.at(-1).options.length, 1);
    editor.selections = [new Selection(new Position(0, 20), new Position(0, 20))];
    events.selection({ textEditor: editor }); assert.equal(decorations.at(-1).options.length, 0);
    assert.equal(doc.getText(), source);
    const missing = document('/fixture/Missing.bl', '"$Prototype.missing$"; "$OtherProject.realKey$"; // "$Prototype.comment$"');
    events.open(missing);
    assert.equal(warnings.get(missing.uri.fsPath).length, 1, 'do not flag unrelated keys against a fake fixture dictionary');
    const warning = warnings.get(missing.uri.fsPath)[0];
    assert.equal(warning.severity, 1);
    assert.equal(warning.source, 'Z8BL Localization Prototype');
    assert.equal(warning.code, 'localization-missing-ru');
    assert.match(warning.message, /Prototype.missing.*ru.*тестовом словаре/);
    assert.equal(missing.getText(warning.range), '"$Prototype.missing$"');
    editor.document = missing;
    events.selection({ textEditor: editor });
    commands.get('z8blPrototype.toggle')();
    assert.equal(warnings.get(missing.uri.fsPath).length, 1, 'warnings do not depend on cursors or display toggle');
    Object.assign(missing, document('/fixture/Missing.bl', '"$Prototype.short$";'));
    events.text({ document: missing });
    assert.equal(warnings.get(missing.uri.fsPath).length, 0, 'unsaved edit removes the resolved warning');
    events.close(missing); assert.equal(warnings.has(missing.uri.fsPath), false);
    // There are no applyEdit/edit/save/clipboard operations in this API fixture.
});


test('development startup opens fixture in the dev host, not the original editor, and reports activation', async () => {
    const code = fs.readFileSync(path.join(__dirname, 'localization-prototype', 'extension.js'), 'utf8');
    const doc = document('/fixture/Examples.bl', source);
    const decorationOptions = [], opens = [], logs = [], commands = new Map();
    const editor = { document: doc, selections: [new Selection(new Position(0, 0), new Position(0, 0))],
        setDecorations(type, items) { decorationOptions.push(items); } };
    const listen = () => ({ dispose() {} });
    let failure = false;
    const vscode = {
        Diagnostic: class {}, DiagnosticSeverity: { Warning: 1 },
        languages: { createDiagnosticCollection() { return { set() {}, delete() {}, dispose() {} }; } },
        Range: class extends Range { constructor(a, b, c, d) { super(typeof a === 'number' ? new Position(a, b) : a, typeof a === 'number' ? new Position(c, d) : b); } },
        MarkdownString, ThemeColor: class {},
        ExtensionMode: { Production: 1, Development: 2 }, ViewColumn: { Active: -1 },
        DecorationRangeBehavior: { ClosedClosed: 1 },
        Uri: { joinPath(uri, name) { return { ...uri, path: uri.path + '/' + name }; } },
        window: {
            visibleTextEditors: [],
            createOutputChannel() { return { appendLine(line) { logs.push(line); }, dispose() {} }; },
            createTextEditorDecorationType() { return { dispose() {} }; },
            onDidChangeVisibleTextEditors: listen, onDidChangeTextEditorSelection: listen, onDidChangeActiveColorTheme: listen,
            async showTextDocument(document, options) { opens.push({ document, options }); return editor; },
            async showWarningMessage(message) { logs.push(message); }
        },
        workspace: { textDocuments: [], onDidChangeTextDocument: listen, onDidOpenTextDocument: listen, onDidCloseTextDocument: listen,
            async openTextDocument(uri) { if (failure) throw Error('fixture unavailable'); assert.equal(uri.path, '/fixture/Examples.bl'); return doc; } },
        commands: { registerCommand(name, fn) { commands.set(name, fn); return { dispose() {} }; } }
    };
    const sandbox = { module: { exports: {} }, require: name => {
        if (name === 'vscode') return vscode;
        if (name === './presentation') return require('./localization-prototype/presentation');
        throw Error(`Unexpected dependency ${name}`);
    } };
    vm.runInNewContext(code, sandbox);
    await sandbox.module.exports.activate({ subscriptions: [], extensionMode: 2, extensionUri: { scheme: 'file', path: '/fixture' } });
    assert.equal(opens.length, 1);
    assert.equal(opens[0].options.viewColumn, -1);
    assert.equal(opens[0].options.preview, false);
    assert.equal(opens[0].options.selection.start.line, 0);
    assert.equal(opens[0].options.selection.start.character, 0);
    assert.equal(decorationOptions.at(-1).length, 1);
    assert.ok(logs.some(line => /Activated/.test(line)));
    assert.ok(logs.some(line => /Opened Examples.bl.*language=bl/.test(line)));
    failure = true;
    await commands.get('z8blPrototype.openExample')();
    assert.ok(logs.some(line => /Не удалось открыть/.test(line)));
    assert.equal(opens.length, 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'localization-prototype', 'package.json'), 'utf8'));
    assert.ok(manifest.activationEvents.includes('onStartupFinished'));
    assert.ok(manifest.activationEvents.includes('onCommand:z8blPrototype.openExample'));
});


test('missing translation model preserves source ranges, excludes comments, and accepts empty translations', () => {
    const text = '\r\n"$Prototype.missing$"; "$Prototype.short$"; // "$Prototype.comment$"\n/* "$Prototype.block$" */';
    const missing = missingTranslations(text);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].start, 2);
    assert.equal(text.slice(missing[0].start, missing[0].end), '"$Prototype.missing$"');
    assert.equal(missingTranslations('"$Empty.key$"', new Map([['Empty.key', '']])).length, 0);
    assert.equal(presentation('"$Empty.key$"', [], new Map([['Empty.key', '']]))[0].display, '""');
    assert.equal(missingTranslations('"prefix $Prototype.missing$"; \'$Prototype.missing$\';').length, 0);
});
