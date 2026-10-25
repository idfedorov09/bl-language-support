const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseNls, resolveTranslation, localeFor } = require('../localizationModel');
const { presentation, localizationLiterals } = require('../localizationPresentation');
const { document, extension } = require('./helpers');
const file = '/work/app/WEB-INF/resources/app_ru.nls';
const sourceFile = '/work/app/src/main/bl/Example.bl';
const source = 'class Example { string title = "$Workspace.title$"; }';
const xml = (value = 'Документы', key = 'Workspace.title') => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">\n<properties><entry key="${key}">${value}</entry></properties>`;
const wait = () => new Promise(resolve => setTimeout(resolve, 130));
async function setup(t, files = {}, configuration = {}) {
    const doc = document(sourceFile, source);
    const env = await extension({ [sourceFile]: source, [file]: xml(), ...files }, [doc], {
        workspaceFolders: ['/work'], checkoutRoots: ['/work/app'], configuration });
    t.after(() => env.dispose());
    return { env, doc };
}

test('XML properties decode entities/CDATA/multiline, keep key offsets and inert Java DTD', () => {
    const text = '\ufeff' + xml('A &amp; &lt;x&gt; &#x1f4c4;\r\n<![CDATA[B <tag> &not-an-entity;]]><!-- ignored -->', 'A&amp;B');
    const result = parseNls(text, file);
    assert.equal(result.issues.length, 0);
    assert.equal(result.locale, 'ru');
    assert.equal(result.entries[0].key, 'A&B');
    assert.equal(result.entries[0].value, 'A & <x> 📄\nB <tag> &not-an-entity;');
    assert.equal(text.slice(result.entries[0].start, result.entries[0].end), 'A&amp;B');
    assert.equal(localeFor('app_email_en_US.nls'), 'en-us');
    const extras = parseNls('<properties><comment>note</comment><entry key="empty"/><entry key=\'second\'></entry></properties>', file);
    assert.deepEqual(extras.entries.map(e => e.value), ['', '']);
});

test('unsafe or malformed XML never yields a partial dictionary', () => {
    for (const text of [
        '<!DOCTYPE properties [<!ENTITY p SYSTEM "file:///etc/passwd">]><properties><entry key="K">&p;</entry></properties>',
        '<!DOCTYPE properties SYSTEM "https://example.invalid/evil"><properties/>',
        xml('&custom;'), xml('&#0;'), xml('&#xD800;'), xml('&#99999999999999999999;'), xml('raw & text'),
        '<properties><entry key="good">a</entry><entry key="bad">b</properties>',
        '<properties><entry key="a" extra="b">x</entry></properties>',
        '<properties><entry key="a"b">x</entry></properties>',
        '<properties><entry key="K"><nested>x</nested></entry></properties>',
        '<properties><entry key="K">x]]>y</entry></properties>',
        '<properties><!-- broken -- comment --></properties>',
        '<properties/><properties/>', '<properties/> trailing', xml('\u0001')
    ]) {
        const result = parseNls(text, file);
        assert.ok(result.issues.length, text);
        assert.equal(result.entries.length, 0, text);
    }
    assert.equal(parseNls('<properties/>', '/work/no-locale.nls').issues.length, 1);
});

test('resolver distinguishes identical duplicates, conflicts, empty, missing and unavailable per language', () => {
    const a = parseNls(xml(), file), b = parseNls(xml(), '/work/other_ru.nls');
    let r = resolveTranslation([a, b], 'Workspace.title', 'RU');
    assert.equal(r.status, 'found'); assert.equal(r.sources.length, 2);
    assert.equal(resolveTranslation([a, parseNls(xml('Договоры'), file)], 'Workspace.title', 'ru').status, 'conflict');
    assert.equal(resolveTranslation([parseNls(xml(''), file)], 'Workspace.title', 'ru').value, '');
    assert.equal(resolveTranslation([a], 'Workspace.title', 'en').status, 'missing');
    const broken = parseNls('<properties>', file);
    assert.equal(resolveTranslation([a, broken], 'Workspace.title', 'ru').status, 'unavailable');
    assert.equal(resolveTranslation([a, broken], 'Workspace.title', 'en').status, 'missing');
});

test('production scanner/presentation preserve source and reveal every touching selection', () => {
    const text = source + '\r\n// "$Workspace.title$"\n/* "$Workspace.title$" */\n\'$Workspace.title$\'; "prefix $Workspace.title$";';
    assert.equal(localizationLiterals(text).length, 1);
    const item = presentation(text, [], new Map([['Workspace.title', 'Документы\n📄']]))[0];
    assert.equal(item.display, '"Документы\\n📄"');
    for (let i = item.start; i <= item.end; i++) assert.equal(presentation(text, [{ start: i, end: i }], new Map([['Workspace.title', 'X']])).length, 0);
    assert.equal(text.slice(item.start, item.end), '"$Workspace.title$"');
});

test('defaults, warning independence, required locales, no fallback, and theme-aware rendering', async t => {
    const { env, doc } = await setup(t, {}, { 'diagnostics.enabled': false });
    assert.equal(env.localizationDiagnostics.get(sourceFile).length, 0);
    const editor = await env.showEditor(doc);
    assert.equal(editor.applied.length, 1);
    assert.equal(editor.applied[0].renderOptions.after.contentText, '"Документы"');
    assert.equal(editor.applied[0].renderOptions.after.color.id, 'editorInlayHint.foreground');
    assert.equal(editor.applied[0].renderOptions.after.backgroundColor.id, 'editorInlayHint.background');
    assert.equal(editor.applied[0].renderOptions.after.border, undefined);
    await env.configure({ 'i18n.requiredLocales': ['en', 'ru', 'EN'] });
    assert.equal(editor.applied.length, 1);
    let warnings = env.localizationDiagnostics.get(sourceFile);
    assert.equal(warnings.length, 1); assert.match(warnings[0].message, /для en/);
    assert.equal(warnings[0].severity, env.vscode.DiagnosticSeverity.Warning);
    assert.equal(warnings[0].source, 'Z8BL i18n');
    await env.configure({ 'i18n.locale': 'en' });
    assert.equal(editor.applied.length, 0); // Not Russian fallback.
    await env.configure({ 'i18n.locale': 'ru', 'i18n.displayMode': 'keys' });
    assert.equal(editor.applied.length, 0); assert.equal(env.localizationDiagnostics.get(sourceFile).length, 1);
    await env.commands.get('bl.toggleTranslations')();
    assert.equal(editor.applied.length, 1);
    await env.themeChanged(); assert.equal(editor.applied.length, 1);
    const at = doc.positionAt(localizationLiterals(source)[0].start + 3);
    editor.selection = new env.vscode.Selection(at, at); editor.selections = [editor.selection];
    await env.selectionChanged(editor); assert.equal(editor.applied.length, 0);
    await env.commands.get('bl.copyTranslation')(); assert.equal(env.clipboard[0], 'Документы');
    assert.equal(doc.getText(), source); assert.equal(env.contents.get(sourceFile), source);
});

test('hover and F12 show all source ranges, escaped source text and dirty resource values', async t => {
    const other = '/work/app/other_ru.nls';
    const { env, doc } = await setup(t, { [other]: xml('Документы') });
    const pos = doc.positionAt(source.indexOf('Workspace.title'));
    let definitions = await env.providers.definition.provideDefinition(doc, pos);
    assert.equal(definitions.length, 2);
    for (const definition of definitions) {
        const resource = document(definition.uri.fsPath, env.contents.get(definition.uri.fsPath));
        assert.equal(resource.getText(definition.range), 'Workspace.title');
    }
    let hover = await env.providers.hover.provideHover(doc, pos);
    assert.match(hover.contents[0].value, /Workspace/); assert.ok(!hover.contents[0].isTrusted);
    const nls = document(file, xml('[run](command:evil)')); nls.languageId = 'xml'; nls.isDirty = true;
    env.vscode.workspace.textDocuments.push(nls); await env.open(nls); await wait();
    hover = await env.providers.hover.provideHover(doc, pos);
    assert.match(hover.contents[0].value, /Конфликт/); assert.match(hover.contents[0].value, /\\\[run\\\]/);
    assert.equal(env.localizationDiagnostics.get(sourceFile)[0].code, 'localization-conflict');
    assert.equal(env.contents.get(file), xml());
    env.close(nls); await wait();
    assert.equal(env.localizationDiagnostics.get(sourceFile).length, 0);
    env.contents.delete(other); await env.fileEvent('delete', other); await wait();
    definitions = await env.providers.definition.provideDefinition(doc, pos); assert.equal(definitions.length, 1);
});

test('dirty NLS and BL update displays; damaged resource yields unavailable Warning instead of false missing', async t => {
    const { env, doc } = await setup(t);
    const editor = await env.showEditor(doc);
    const nls = document(file, xml('Из буфера')); nls.languageId = 'xml'; nls.isDirty = true;
    env.vscode.workspace.textDocuments.push(nls); await env.open(nls); await wait();
    assert.equal(editor.applied[0].renderOptions.after.contentText, '"Из буфера"');
    Object.assign(nls, document(file, '<properties><entry')); nls.languageId = 'xml';
    await env.change(nls); await wait();
    assert.equal(editor.applied.length, 0);
    assert.equal(env.localizationDiagnostics.get(sourceFile)[0].code, 'localization-unavailable');
    assert.equal(env.localizationDiagnostics.get(file)[0].severity, 1);
    Object.assign(nls, document(file, xml('Новый', 'New.key'))); nls.languageId = 'xml';
    await env.change(nls); await wait();
    assert.equal(env.localizationDiagnostics.get(sourceFile)[0].code, 'localization-missing');
    Object.assign(doc, document(sourceFile, source.replace('Workspace.title', 'New.key')));
    await env.change(doc);
    assert.equal(editor.applied[0].renderOptions.after.contentText, '"Новый"');
    assert.equal(env.localizationDiagnostics.get(sourceFile).length, 0);
    env.close(doc); assert.equal(env.localizationDiagnostics.has(sourceFile), false);
});

test('checkout isolation includes submodules, excludes generated resources/buffers even with empty exclude', async t => {
    const generated = '/work/app/target/app_ru.nls', sibling = '/work/other/app_ru.nls', sub = '/work/app/sub/module_ru.nls';
    const { env, doc } = await setup(t, { [generated]: xml('Generated'), [sibling]: xml('Other'), [sub]: xml() }, { 'index.exclude': [] });
    const generatedDoc = document(generated, xml('Dirty generated')); generatedDoc.languageId = 'xml';
    env.vscode.workspace.textDocuments.push(generatedDoc); await env.open(generatedDoc);
    assert.equal(env.localizationDiagnostics.get(sourceFile).length, 0);
    const editor = await env.showEditor(doc);
    assert.equal(editor.applied[0].renderOptions.after.contentText, '"Документы"');
    assert.equal(env.readCounts.has(generated), false); assert.equal(env.readCounts.has(sibling), false);
    const searches = env.searchCounts.get('**/*.nls');
    await env.fileEvent('change', generated); await env.change(generatedDoc); await wait();
    assert.equal(env.searchCounts.get('**/*.nls'), searches);
    const cancelled = { isCancellationRequested: true };
    assert.equal(await env.providers.definition.provideDefinition(doc, doc.positionAt(source.indexOf('$')), cancelled), null);
});

test('manifest registers localization commands/settings without increasing VS Code engine', () => {
    const manifest = require('../package.json'), p = manifest.contributes.configuration.properties;
    assert.equal(p['bl.i18n.locale'].default, 'ru'); assert.equal(p['bl.i18n.displayMode'].default, 'translations');
    assert.deepEqual(p['bl.i18n.requiredLocales'].default, []);
    assert.equal(manifest.engines.vscode, '^1.60.0');
    for (const cmd of ['bl.copyTranslation', 'bl.toggleTranslations']) assert.ok(manifest.activationEvents.includes('onCommand:' + cmd));
});

test('two workspace roots never borrow translations and custom discovery exclusions apply to dirty buffers', async t => {
    const rootA = '/work/first', rootB = '/work/second';
    const docA = document(rootA + '/Example.bl', source), docB = document(rootB + '/Example.bl', source);
    const nlsA = rootA + '/app_ru.nls', nlsB = rootB + '/excluded/app_ru.nls';
    const dirty = document(nlsB, xml('Unsaved second')); dirty.languageId = 'xml'; dirty.isDirty = true;
    const env = await extension({ [docA.uri.fsPath]: source, [docB.uri.fsPath]: source, [nlsA]: xml('First'), [nlsB]: xml('Second') }, [docA, docB, dirty], {
        workspaceFolders: [rootA, rootB], checkoutRoots: [rootA, rootB], configuration: { 'index.exclude': ['**/excluded/**'] } });
    t.after(() => env.dispose());
    const a = await env.showEditor(docA), b = await env.showEditor(docB);
    assert.equal(a.applied[0].renderOptions.after.contentText, '"First"'); assert.equal(b.applied.length, 0);
    assert.equal(env.localizationDiagnostics.get(docB.uri.fsPath)[0].code, 'localization-missing');
    assert.equal(env.readCounts.has(nlsB), false);
    await env.configure({ 'index.exclude': [] }); await wait();
    assert.equal(b.applied[0].renderOptions.after.contentText, '"Unsaved second"');
    assert.equal(a.applied[0].renderOptions.after.contentText, '"First"');
});

test('a delayed snapshot is never returned for an edited document or cancelled request', async t => {
    const { createLocalization } = require('../localization');
    const { env, doc } = await setup(t);
    let release; const delayed = new Promise(resolve => { release = resolve; });
    const service = createLocalization(env.vscode, { readFile: async () => { await delayed; return xml(); } });
    const pos = doc.positionAt(source.indexOf('Workspace.title'));
    const pending = service.definitionProvider.provideDefinition(doc, pos);
    Object.assign(doc, document(sourceFile, source.replace('Workspace.title', 'Changed.key')));
    release(); assert.deepEqual(await pending, []);
    const cancelled = { isCancellationRequested: true };
    assert.equal(await service.hoverProvider.provideHover(doc, pos, cancelled), null);
});
