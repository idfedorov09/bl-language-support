const vscode = require('vscode');
const { presentation, missingTranslations } = require('./presentation');

async function activate(context) {
    const output = vscode.window.createOutputChannel('Z8BL Localization Prototype');
    output.appendLine(`Activated in this window; mode=${context.extensionMode}; style=inlay`);
    const renderCounts = new WeakMap();
    const diagnostics = vscode.languages.createDiagnosticCollection('z8bl-localization-prototype');
    function updateDiagnostics(document) {
        if (!document) return;
        if (document.languageId !== 'bl' || document.isClosed) { diagnostics.delete(document.uri); return; }
        // The dictionary is a fixture, not a real NLS index. Do not claim
        // unrelated CLM keys are missing just because this probe knows no NLS.
        const missing = missingTranslations(document.getText()).filter(item => item.key.startsWith('Prototype.'));
        diagnostics.set(document.uri, missing.map(item => {
            const range = new vscode.Range(document.positionAt(item.start), document.positionAt(item.end));
            const diagnostic = new vscode.Diagnostic(range, `Нет перевода «${item.key}» для ru в тестовом словаре прототипа.`, vscode.DiagnosticSeverity.Warning);
            diagnostic.source = 'Z8BL Localization Prototype';
            diagnostic.code = 'localization-missing-ru';
            return diagnostic;
        }));
    }
    let enabled = true;
    const decoration = vscode.window.createTextEditorDecorationType({
        color: 'transparent',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    function render(editor) {
        if (!editor || editor.document.languageId !== 'bl') return;
        const document = editor.document;
        const selections = editor.selections.map(s => ({ start: document.offsetAt(s.start), end: document.offsetAt(s.end) }));
        const items = enabled ? presentation(document.getText(), selections) : [];
        if (renderCounts.get(editor) !== items.length) {
            renderCounts.set(editor, items.length);
            output.appendLine(`Visible BL editor: ${items.length} replacement candidates`);
        }
        editor.setDecorations(decoration, items.map(item => {
            const hover = new vscode.MarkdownString();
            hover.appendText(`DEV PROTOTYPE: ${item.key}\nru: ${item.translation}\nИсточник: фиксированный fixture, не NLS-индекс.\nКурсор/выделение раскрывают исходный ключ.`);
            return {
                range: new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
                hoverMessage: hover,
                renderOptions: {
                    after: {
                        contentText: item.display,
                        // Native inlay theme colors: subtle on light/dark,
                        // readable in high contrast, and user-theme overridable.
                        // This styles the replacement, not a hint beside the key.
                        color: new vscode.ThemeColor('editorInlayHint.foreground'),
                        backgroundColor: new vscode.ThemeColor('editorInlayHint.background'),
                        fontStyle: 'normal',
                        fontWeight: 'normal',
                        // Public decoration property, no injected CSS/DOM.
                        // Negative margin compensates the invisible literal's
                        // monospace width. Proportional fonts/ligatures/zoom/wrap
                        // MUST pass editor gate before this can ship.
                        margin: `0 0 0 -${item.source.length}ch`
                    }
                }
            };
        }));
    }
    const refresh = () => vscode.window.visibleTextEditors.forEach(render);
    const analyzeOpenDocuments = () => {
        for (const document of vscode.workspace.textDocuments) updateDiagnostics(document);
    };
    async function openExample() {
        try {
            const uri = vscode.Uri.joinPath(context.extensionUri, 'Examples.bl');
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Active, preview: false,
                selection: new vscode.Range(0, 0, 0, 0)
            });
            output.appendLine(`Opened Examples.bl in this window; language=${document.languageId}`);
            updateDiagnostics(document);
            render(editor);
            if (document.languageId !== 'bl') {
                await vscode.window.showWarningMessage('Прототип открыл Examples.bl, но язык не BL. Проверьте запуск основной Z8BL dev-extension в этом окне.');
            }
        } catch (error) {
            output.appendLine(`Cannot open fixture: ${error.message}`);
            await vscode.window.showWarningMessage(`Не удалось открыть Examples.bl в dev-окне: ${error.message}`);
        }
    }
    context.subscriptions.push(output, decoration, diagnostics,
        vscode.commands.registerCommand('z8blPrototype.openExample', openExample),
        vscode.commands.registerCommand('z8blPrototype.toggle', () => { enabled = !enabled; refresh(); }),
        vscode.window.onDidChangeVisibleTextEditors(refresh),
        vscode.window.onDidChangeTextEditorSelection(event => render(event.textEditor)),
        vscode.workspace.onDidChangeTextDocument(event => { updateDiagnostics(event.document); refresh(); }),
        vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
        vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)),
        vscode.window.onDidChangeActiveColorTheme(refresh));
    analyzeOpenDocuments();
    refresh();
    // Only the isolated development host opens a fixture automatically.
    // Installing the prototype does not hijack the user's active editor.
    if (context.extensionMode === vscode.ExtensionMode.Development) await openExample();
}
module.exports = { activate };
