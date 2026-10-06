const assert = require('node:assert/strict');
const { test } = require('node:test');
const { document, positionOf, extension } = require('./helpers');
const { BlIndex } = require('../blIndex');
const { DocumentAnalysis } = require('../documentAnalysis');
const { createGuidNavigation, findGuidOccurrences } = require('../guidNavigation');

const root = '/workspace/clm';
const roles = `${root}/app/src/main/bl/access/Roles.bl`;
const guid = '6D79CDE1-FA42-40A7-86C2-091EF32AA058';
const otherGuid = '3AB51274-196D-4605-AC83-1B7F3F7ACE88';
const source = `public class Roles { records { [name "$Roles.Expert$"] Expert = '${guid}'; } }`;

test('explicit record file context wins over an unrelated active editor', async t => {
    const foreign = roles.replace('/clm/', '/cloud/');
    const env = await extension({ [roles]: source, [foreign]: source }, [], { workspaceFolders: [root, '/workspace/cloud'] });
    t.after(() => env.dispose());
    const doc = document(foreign, source);
    const at = positionOf(doc, 'Expert', 'Expert');
    env.vscode.window.activeTextEditor = { document: doc, selection: new env.vscode.Selection(at, at) };
    const model = await env.commands.get('bl.showRecordCard')({ filePath: roles, name: 'Expert' });
    assert.equal(model.filePath, roles);
    assert.equal(model.scopeRoot, root);
    assert.equal(env.quickPicks.length, 0);
    assert.equal(await env.commands.get('bl.showRecordCard')('not-a-guid'), null, 'an invalid explicit ID must not select the active symbol instead');
});

test('outer checkout includes submodules, but excludes a neighbouring checkout', async t => {
    const dependency = `${root}/core/src/main/bl/access/LegacyRoles.bl`;
    const foreign = roles.replace('/clm/', '/cloud/');
    const env = await extension({ [roles]: source, [dependency]: source.replace('class Roles', 'class LegacyRoles'), [foreign]: source }, [], {
        workspaceFolders: ['/workspace'], checkoutRoots: [root, `${root}/app`, `${root}/core`, '/workspace/cloud']
    });
    t.after(() => env.dispose());
    const doc = document(roles, source);
    const found = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'Expert', guid), {});
    assert.deepEqual(new Set(found.map(location => location.uri.fsPath)), new Set([roles, dependency]));
});

test('a broad workspace without checkout markers preserves all labelled candidates', async t => {
    const foreign = roles.replace('/clm/', '/cloud/');
    const env = await extension({ [roles]: source, [foreign]: source }, [], { workspaceFolders: ['/workspace'] });
    t.after(() => env.dispose());
    assert.equal(await env.commands.get('bl.lookupGuid')({ guid, sourceUri: env.vscode.Uri.file(roles) }), null);
    const items = env.quickPicks.at(-1).items;
    assert.equal(items.length, 2);
    assert.ok(items.some(item => item.detail.includes(roles)));
    assert.ok(items.some(item => item.detail.includes(foreign)));
    assert.equal(env.panels.length, 0, 'no nearest-copy guess when context cannot distinguish candidates');
});

test('an open source outside the workspace is not silently replaced by the single workspace folder', async t => {
    const foreign = roles.replace('/clm/', '/cloud/');
    const dirty = document(foreign, source);
    const env = await extension({ [roles]: source }, [dirty], { workspaceFolders: [root] });
    t.after(() => env.dispose());
    assert.equal(await env.commands.get('bl.lookupGuid')({ guid, sourceUri: dirty.uri }), null);
    assert.equal(env.quickPicks.length, 1);
    assert.equal(env.quickPicks[0].items.length, 2);
    env.quickPickResponses.push(1);
    const model = await env.commands.get('bl.lookupGuid')({ guid, sourceUri: dirty.uri });
    assert.equal(model.filePath, foreign);
    assert.equal(model.scopeRoot, null);
});

test('a repeated GUID in a derived class is an informational declaration, not an automatic conflict', async t => {
    const child = `${root}/app/src/main/bl/access/ChildRoles.bl`;
    const childSource = `public class ChildRoles extends Roles { records { Expert = '${guid}'; } }`;
    const env = await extension({ [roles]: source, [child]: childSource }, [], { workspaceFolders: [root], quickPickResponses: [1] });
    t.after(() => env.dispose());
    const model = await env.commands.get('bl.lookupGuid')({ guid, sourceUri: env.vscode.Uri.file(child) });
    assert.equal(model.filePath, child);
    assert.equal(model.warnings.length, 0);
    assert.equal(model.otherDeclarations.length, 1);
    assert.ok(!env.vscode.languages.getDiagnostics(env.vscode.Uri.file(child)).some(diagnostic => diagnostic.code === 'duplicate-guid'));
});

test('same-name records require a choice, and ambiguous symbols do not become proven usages', async t => {
    const text = `public class Roles { records { Expert = '${guid}'; Expert = '${otherGuid}'; } }`;
    const env = await extension({ [roles]: text }, [], { workspaceFolders: [root], quickPickResponses: [0] });
    t.after(() => env.dispose());
    const model = await env.commands.get('bl.showGuidUsages')({ filePath: roles, name: 'Expert' });
    assert.equal(env.quickPicks.at(-1).items.length, 2);
    assert.equal(model.guid, guid.toLowerCase());
    assert.equal(model.usages.symbol.length, 0);
    assert.ok(model.usages.literal.length > 0);
    assert.ok(model.warnings.some(warning => warning.includes('BL-ссылки неоднозначны')));
    const doc = document(roles, text);
    const at = doc.positionAt(text.indexOf('Expert'));
    env.vscode.window.activeTextEditor = { document: doc, selection: new env.vscode.Selection(at, at) };
    const direct = await env.commands.get('bl.showRecordCard')();
    assert.equal(direct.guid, guid.toLowerCase(), 'card at a declaration must not choose the last duplicate Map entry');
});

test('a dirty source link refreshes before navigation, then uses the updated coordinates', async t => {
    const dirty = document(roles, source);
    const env = await extension({ [roles]: source }, [dirty], { workspaceFolders: [root], configuration: { 'diagnostics.enabled': false } });
    t.after(() => env.dispose());
    const model = await env.commands.get('bl.showRecordCard')({ filePath: roles, name: 'Expert' });
    const panel = env.panels.at(-1);
    Object.assign(dirty, document(roles, '\n' + source));
    dirty.isDirty = true;
    env.change(dirty);
    await panel.receiveMessage({ type: 'openSource', id: model.sourceId });
    assert.equal(env.sourceOpens.length, 0);
    assert.ok(env.messages.some(entry => /Выберите источник ещё раз/.test(entry.message)));
    await panel.receiveMessage({ type: 'openSource', id: model.sourceId });
    assert.equal(env.sourceOpens.at(-1).config.selection.start.line, 1);
    assert.equal(env.contents.get(roles), source);
});

test('opening a changed closed file does not jump using the old card coordinates', async t => {
    const env = await extension({ [roles]: source }, [], { workspaceFolders: [root] });
    t.after(() => env.dispose());
    const model = await env.commands.get('bl.showRecordCard')({ filePath: roles, name: 'Expert' });
    env.contents.set(roles, '\n' + source); // A disk edit before its watcher event arrives.
    const panel = env.panels.at(-1);
    await panel.receiveMessage({ type: 'openSource', id: model.sourceId });
    assert.equal(env.sourceOpens.length, 0);
    await panel.receiveMessage({ type: 'openSource', id: model.sourceId });
    assert.equal(env.sourceOpens.at(-1).config.selection.start.line, 1);
});

test('GUID match provenance preserves CRLF positions, escaping and token boundaries', () => {
    const text = [`guid value = '${guid}';`, `string label = "'${guid}'";`, `// '${guid}'`, `/* ${guid} */`, `string escaped = "\\\"${guid}";`,
        `guid unknown = x${guid};`, `guid unknown = '${guid}x';`].join('\r\n');
    const occurrences = findGuidOccurrences(text);
    assert.deepEqual(occurrences.map(item => item.kind), ['literal', 'string', 'comment', 'comment', 'string']);
    for (const item of occurrences) {
        assert.equal(text.slice(item.offset, item.endOffset), guid);
        assert.equal(item.column, text.split('\r\n')[item.line].indexOf(guid));
    }
});

test('optional localization hook enriches a card offline without hiding its original key', async t => {
    const env = await extension({ [roles]: source }, [], { workspaceFolders: [root] });
    t.after(() => env.dispose());
    const index = new BlIndex();
    index.updateFromText(roles, source);
    const calls = [];
    const nav = createGuidNavigation(env.vscode, {
        index, ensureIndexReady: async () => {}, updateIndexFromDocument: () => {}, getAnalysis: doc => new DocumentAnalysis(doc.getText()),
        readFile: async () => source,
        definitionProvider: { provideDefinition: async () => [] }, referenceProvider: { provideReferences: async () => [] },
        resolveLocalizedLabel: async (key, owner) => { calls.push([key, owner.filePath]); return 'Эксперт'; }
    });
    t.after(() => nav.dispose());
    const model = await nav.lookupGuid({ guid, sourceUri: env.vscode.Uri.file(roles) });
    assert.deepEqual(calls, [['Roles.Expert', roles]]);
    assert.equal(model.label, 'Эксперт');
    assert.equal(model.localizationKey, '$Roles.Expert$');
    assert.ok(env.panels.at(-1).webview.html.includes('$Roles.Expert$'));
});
