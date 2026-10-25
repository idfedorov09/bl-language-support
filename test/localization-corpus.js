const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createDraft } = require('../i18nDraft');
const { parseNls, resolveTranslation } = require('../localizationModel');
const { document, extension } = require('./helpers');
const root = path.resolve(process.argv[2] || '../pro.doczilla.clm');
const files = {}, resources = [];
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['.git', 'target', 'build', 'node_modules', 'tmp', 'data'].includes(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.nls')) {
            const text = fs.readFileSync(file, 'utf8'); files[file] = text;
            const parsed = parseNls(text, file);
            assert.equal(parsed.issues.length, 0, `${file}: ${parsed.issues.map(issue => issue.message)}`);
            resources.push({...parsed, filePath:file, text});
        }
    }
}
walk(root);
(async () => {
    assert.ok(resources.length, 'No source NLS resources');
    const coreResources = resources;
    const clear = createDraft({root, resources:coreResources}, 'Action.dictionary.clear.title', 'ru', ['uz']);
    for (const locale of ['ru', 'en']) {
        const row = clear.rows.find(r => r.locale === locale);
        assert.equal(row.target, 0); assert.equal(row.options.length, 1);
        assert.equal(path.basename(row.options[0].filePath), `pro.doczilla.base.core_${locale}.nls`);
    }
    const clearUz = clear.rows.find(r => r.locale === 'uz');
    assert.equal(clearUz.options.length, 0); assert.equal(clearUz.target, null);
    assert.deepEqual(createDraft({root, resources:coreResources}, 'Action.dictionary.clear.title', 'ru').rows.map(row => row.locale), ['ru', 'en']);
    assert.equal(resolveTranslation(resources, 'Workspace.title', 'ru').value, 'Документы');
    assert.equal(resolveTranslation(resources, 'Workspace.title', 'en').value, 'Documents');
    assert.equal(resolveTranslation(resources, 'Workspace.title', 'uz').status, 'missing');
    const sourceFile = path.join(root, 'pro.doczilla.base.core/src/main/bl/ru/doczilla/workspace/table/Workspace.bl');
    files[sourceFile] = fs.readFileSync(sourceFile, 'utf8');
    const clearFile = path.join(root, 'pro.doczilla.base.core/src/main/bl/pro/doczilla/dictionary/ClearAction.bl');
    files[clearFile] = fs.readFileSync(clearFile, 'utf8');
    const doc = document(sourceFile, files[sourceFile]);
    const env = await extension(files, [doc], { workspaceFolders: [root], checkoutRoots: [root], configuration: { 'diagnostics.enabled': false },
        pickerResponses: [async picker => {
            for (let i = 0; i < 60 && picker.busy; i++) await new Promise(setImmediate);
            assert.equal(picker.busy, false); picker.value = 'Документы';
            const result = picker.visibleItems.find(item => item.record && item.record.key === 'Workspace.title' && item.record.locale === 'ru');
            assert.ok(result, 'Search must find real CLM translation by value');
            assert.ok(result.record.sources.every(source => !source.filePath.split(path.sep).includes('target')));
            picker.accept(result);
        }], quickPickResponses: [items => items.find(item => item.action === 'edit')] });
    try {
        const editor = await env.showEditor(doc);
        assert.ok(editor.applied.some(item => item.renderOptions.after.contentText === '"Документы"'));
        const completionPos = doc.positionAt(doc.getText().indexOf('Workspace.title') + 'Workspace.t'.length);
        const complete = async () => {
            const list = await env.providers.completion.provideCompletionItems(doc, completionPos, {});
            const item = list.items.find(item => item.label === 'Workspace.title');
            assert.ok(item, 'Real CLM key completion must find Workspace.title');
            assert.equal(item.insertText, 'Workspace.title$'); assert.equal(item.documentation.isTrusted, false);
            const start = doc.offsetAt(item.range.start), end = doc.offsetAt(item.range.end);
            const text = doc.getText().slice(0, start) + item.insertText + doc.getText().slice(end);
            assert.equal(text, doc.getText(), 'Native completion contract must preserve existing complete key/BL text');
            assert.ok(item.documentation.value.replace(/\\/g, '').includes('pro.doczilla.base.core_'));
            return item;
        };
        assert.ok((await complete()).detail.includes('Документы'));
        const pos = doc.positionAt(doc.getText().indexOf('$Workspace.title$') + 1);
        const definitions = await env.providers.definition.provideDefinition(doc, pos);
        assert.ok(definitions.length);
        for (const definition of definitions) assert.equal(document(definition.uri.fsPath, files[definition.uri.fsPath]).getText(definition.range), 'Workspace.title');
        await env.configure({ 'i18n.locale': 'en' });
        assert.ok(editor.applied.some(item => item.renderOptions.after.contentText === '"Documents"'));
        assert.ok((await complete()).detail.includes('Documents'));
        await env.configure({ 'i18n.locale': 'uz' });
        assert.ok(env.localizationDiagnostics.get(sourceFile).some(diag => diag.code === 'localization-missing' && diag.message.includes('Workspace.title')));
        assert.ok((await complete()).detail.includes('Нет перевода'));
        const panel = await env.commands.get('bl.searchTranslations')();
        assert.ok(panel, 'Real CLM search must open Edit Translation');
        await panel.receiveMessage({ type: 'ready' });
        const toolkit = panel.webview.sentMessages.at(-1);
        assert.equal(toolkit.key, 'Workspace.title'); assert.equal(toolkit.root, root);
        assert.equal(toolkit.rows.find(row => row.locale === 'ru').value, 'Документы');
        assert.equal(toolkit.rows.find(row => row.locale === 'en').value, 'Documents');
        const clearPanel = await env.commands.get('bl.editTranslation')({sourceUri:clearFile, key:'Action.dictionary.clear.title'});
        assert.ok(clearPanel, 'Real ClearAction must open Toolkit'); await clearPanel.receiveMessage({type:'ready'});
        const clearState = clearPanel.webview.sentMessages.at(-1);
        // Active locale is uz above: it remains explained, but has no target/AI eligibility.
        const missing = clearState.rows.find(row => row.locale === 'uz');
        assert.equal(missing.options.length, 0); assert.match(missing.resourceHelp, /Нет NLS-файла/);
        for (const language of ['ru', 'en']) {
            const row = clearState.rows.find(row => row.locale === language);
            assert.equal(row.target, 0); assert.equal(row.options.length, 1);
            assert.equal(path.basename(row.options[0].filePath), `pro.doczilla.base.core_${language}.nls`);
        }
        assert.equal(env.appliedEdits.length, 0);
        // Resource creation is a Map/native-buffer fixture, never a write to CLM.
        const newFile = path.join(root, 'pro.doczilla.base.core/WEB-INF/resources/pro.doczilla.base.core_uz.nls');
        assert.ok(!fs.existsSync(newFile), 'Corpus expects no pre-existing core Uzbek resource');
        env.quickPickResponses.push(items => items.find(item => item.locale === 'uz'));
        env.vscode.window.showWarningMessage = async () => 'Создать файл';
        await clearPanel.receiveMessage({type:'addLanguage',session:clearState.session,sequence:clearState.sequence+1});
        const added = clearPanel.webview.sentMessages.at(-1);
        assert.equal(added.error, '');
        assert.equal(added.rows.find(row => row.locale === 'uz').options[0].filePath, newFile);
        assert.equal(added.rows.find(row => row.locale === 'uz').status, 'missing');
        assert.equal(env.appliedEdits.length, 1); assert.ok(env.contents.has(newFile));
        assert.ok(!fs.existsSync(newFile), 'Native fixture MUST NOT write a real file in CLM');
        const buffer = env.vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === newFile);
        assert.equal(parseNls(buffer.getText(), newFile).issues.length, 0);
        assert.equal(parseNls(buffer.getText(), newFile).entries.length, 0);
        assert.equal(buffer.isDirty, true);
        // Exact rename is also native-buffer-only in the fixture, not CLM.
        env.inputResponses.push('Workspace.heading');
        const originalBl = files[sourceFile];
        let current = panel.webview.sentMessages.at(-1);
        await panel.receiveMessage({type:'rename',session:current.session,sequence:current.sequence+1});
        current = panel.webview.sentMessages.at(-1);
        assert.equal(current.error, ''); assert.equal(current.previewKind, 'rename');
        assert.equal(current.preview.length, 3);
        assert.equal(current.preview.find(change => change.kind === 'BL').lines[0], 81);
        assert.ok(current.preview.filter(change => change.kind === 'NLS').every(change => change.lines[0] === 33));
        await panel.receiveMessage({type:'apply',session:current.session,sequence:current.sequence+1});
        current = panel.webview.sentMessages.at(-1);
        assert.equal(current.error, ''); assert.equal(current.key, 'Workspace.heading');
        assert.ok(doc.getText().includes('"$Workspace.heading$"'));
        assert.equal(fs.readFileSync(sourceFile, 'utf8'), originalBl, 'Rename MUST NOT write CLM source');
        for (const language of ['ru', 'en']) {
            const target = path.join(root, 'pro.doczilla.base.core/WEB-INF/resources/pro.doczilla.base.core_' + language + '.nls');
            const doc = env.vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === target);
            assert.equal(parseNls(doc.getText(), target).entries.find(entry => entry.key === 'Workspace.heading').value, language === 'ru' ? 'Документы' : 'Documents');
            assert.equal(fs.readFileSync(target, 'utf8'), files[target], 'Rename MUST NOT write CLM NLS');
        }
        console.log(`CLM NLS: ${resources.length} source resources, ${resources.reduce((n, r) => n + r.entries.length, 0)} entries; Workspace.title ru/en, missing uz + Action.dictionary.clear.title exact core ru/en targets (no uz), provider source ranges + value search/Edit Translation + native completion ru/en/missing uz contract + mocked native core_uz creation + exact 3-file Workspace.title rename passed (no CLM writes/GUI/runtime check).`);
    } finally { env.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
