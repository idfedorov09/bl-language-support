const assert = require('node:assert/strict');
const { test } = require('node:test');
const { document, positionOf, extension } = require('./helpers');

const root = '/workspace/clm';
const roles = `${root}/app/src/main/bl/access/Roles.bl`;
const objects = `${root}/app/src/main/bl/access/SecuredObjectAccess.bl`;
const access = `${root}/app/src/main/bl/access/RoleAccess.bl`;
const child = `${root}/app/src/main/bl/access/ChildRoles.bl`;
const consumer = `${root}/app/src/main/bl/app/Consumer.bl`;
const guid = '6D79CDE1-FA42-40A7-86C2-091EF32AA058';
const objectGuid = '3AB51274-196D-4605-AC83-1B7F3F7ACE88';
const accessGuid = 'A147CE3C-2B45-4DAD-AC79-03CFF15D5808';
const unknownGuid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const fixtures = {
    [roles]: `public class Roles {
    records {
        [name "$Roles.Expert$"] Expert = '${guid}';
    }
}`,
    [objects]: `public class SecuredObjectAccess {
    records {
        [name "$Access.edit$"] DzwfModify = '${objectGuid}';
    }
}`,
    [access]: `public class RoleAccess {
    records {
        [name "$Access.edit$"]
        [roleId Roles.Expert]
        [soaId SecuredObjectAccess.DzwfModify]
        [value true]
        ExpertDzwfModify = '${accessGuid}';
        Dynamic = guid.create();
    }
}`,
    [child]: `public class ChildRoles extends Roles {}`,
    [consumer]: `import access.Roles;
import access.ChildRoles;
import access.RoleAccess;
public class Consumer {
    public void run() {
        guid role = Roles.Expert;
        guid inherited = ChildRoles.Expert;
        guid literal = '${guid.toLowerCase()}';
        string message = "${guid}";
        // historical ID ${guid}
        guid dynamic = RoleAccess.Dynamic;
    }
}`
};

async function setup(t, extraFiles = {}, openDocuments = [], options = {}) {
    const env = await extension({ ...fixtures, ...extraFiles }, openDocuments, { workspaceFolders: [root], ...options });
    t.after(() => env.dispose());
    return env;
}

function command(env, name, ...args) {
    const callback = env.commands.get(name);
    assert.equal(typeof callback, 'function', `${name} must be registered`);
    return callback(...args);
}

function activate(env, doc, position, end = position) {
    env.vscode.window.activeTextEditor = { document: doc, selection: new env.vscode.Selection(position, end) };
}

function locations(result) { return Array.isArray(result) ? result : result ? [result] : []; }

async function lookup(env, value = guid, sourceFile = consumer) {
    return command(env, 'bl.lookupGuid', { guid: value, sourceUri: env.vscode.Uri.file(sourceFile) });
}

test('GUID lookup is case-insensitive, returns a source-backed record and opens a card without changing files', async t => {
    const env = await setup(t);
    const initialFiles = new Map(env.contents);
    const model = await lookup(env, guid.toLowerCase());
    assert.equal(model.name, 'Expert');
    assert.equal(model.guid, guid.toLowerCase());
    assert.equal(model.owner, 'access.Roles');
    assert.equal(model.filePath, roles);
    assert.equal(model.line, 2);
    assert.ok(model.attributes.some(attr => attr.name === 'name' && attr.value === '"$Roles.Expert$"'));
    assert.equal(env.panels.length, 1);
    assert.ok(env.panels[0].webview.html.includes('Expert'));
    assert.ok(env.panels[0].webview.html.includes(guid.toLowerCase()));
    assert.equal(env.quickPicks.length, 0);
    assert.equal(env.prompts.length, 0);
    assert.deepEqual(env.contents, initialFiles);
    assert.ok(!env.requiredModules.some(name => /^(?:node:)?(?:https?|net|tls|child_process)$/.test(name)));
});

test('GUID lookup accepts a bare UUID string and QuickPick is prefilled from a selection or literal cursor', async t => {
    const env = await setup(t);
    const doc = document(consumer, fixtures[consumer]);
    const cursor = positionOf(doc, 'guid literal', guid.toLowerCase());
    activate(env, doc, cursor);
    let model = await command(env, 'bl.lookupGuid', guid);
    assert.equal(model.filePath, roles);
    env.guidPickerResponses.push(0);
    model = await command(env, 'bl.lookupGuid');
    assert.equal(model.name, 'Expert');
    assert.equal(env.guidPickers.at(-1).initialValue.toLowerCase().replace(/^'|'$/g, ''), guid.toLowerCase());
    const start = doc.getText().indexOf(guid.toLowerCase());
    activate(env, doc, doc.positionAt(start), doc.positionAt(start + guid.length));
    env.guidPickerResponses.push(0);
    await command(env, 'bl.lookupGuid');
    assert.equal(env.guidPickers.at(-1).initialValue.toLowerCase(), guid.toLowerCase());
});

test('unknown or invalid GUIDs do not open fabricated cards or claim runtime presence', async t => {
    const env = await setup(t);
    for (const value of [unknownGuid, 'not-a-guid', "guid.create()", guid.slice(1)]) {
        const before = env.panels.length;
        const model = await lookup(env, value);
        assert.ok(!model);
        assert.equal(env.panels.length, before);
    }
    assert.ok(env.messages.length > 0);
    assert.ok(env.messages.every(message => message.type !== 'error'));
});

test('GUID definition links single-quoted literals but not strings, comments or invalid literals', async t => {
    const env = await setup(t);
    const doc = document(consumer, fixtures[consumer]);
    const found = locations(await env.providers.definition.provideDefinition(doc, positionOf(doc, 'guid literal', guid.toLowerCase()), {}));
    assert.equal(found.length, 1);
    assert.equal(found[0].uri.fsPath, roles);
    assert.equal(found[0].range.start.line, 2);
    for (const [line, value] of [['string message', guid], ['// historical ID', guid]]) {
        const result = await env.providers.definition.provideDefinition(doc, positionOf(doc, line, value), {});
        assert.equal(locations(result).length, 0);
    }
    const invalidText = fixtures[consumer].replace(guid.toLowerCase(), 'not-a-guid');
    const invalid = document(consumer, invalidText);
    const result = await env.providers.definition.provideDefinition(invalid, positionOf(invalid, 'guid literal', 'not-a-guid'), {});
    assert.equal(locations(result).length, 0);
});

test('GUID definition preserves all current-context candidates without a silent picker', async t => {
    const migration = `${root}/app/src/main/bl/migrations/PreviousRoles.bl`;
    const env = await setup(t, { [migration]: `public class PreviousRoles { records { OldExpert = '${guid}'; } }` });
    const doc = document(consumer, fixtures[consumer]);
    const found = locations(await env.providers.definition.provideDefinition(doc, positionOf(doc, 'guid literal', guid.toLowerCase()), {}));
    assert.deepEqual(new Set(found.map(location => location.uri.fsPath)), new Set([roles, migration]));
    assert.equal(env.quickPicks.length, 0);
});

test('record hover and card use ordinary resolved inherited symbol navigation', async t => {
    const env = await setup(t);
    const doc = document(consumer, fixtures[consumer]);
    const position = positionOf(doc, 'guid inherited', 'Expert');
    const target = locations(await env.providers.definition.provideDefinition(doc, position, {}));
    assert.equal(target[0].uri.fsPath, roles);
    const hover = await env.providers.hover.provideHover(doc, position, {});
    assert.ok(hover);
    const hoverText = hover.contents.map(content => typeof content === 'string' ? content : content.value).join('\n');
    assert.ok(hoverText.includes('Expert'));
    assert.ok(hoverText.includes(guid.toLowerCase()));
    activate(env, doc, position);
    const model = await command(env, 'bl.showRecordCard');
    assert.equal(model.owner, 'access.Roles');
    assert.equal(model.filePath, roles);
    assert.equal(model.name, 'Expert');
});

test('record hover augmentation preserves existing import hover and ignores ordinary local variables', async t => {
    const env = await setup(t);
    const doc = document(consumer, fixtures[consumer]);
    const imported = await env.providers.hover.provideHover(doc, positionOf(doc, 'import access.Roles;', 'Roles'), {});
    assert.ok(imported, 'baseline import hover must still be available');
    const text = imported.contents.map(content => typeof content === 'string' ? content : content.value).join('\n');
    assert.ok(text.includes('access.Roles'));
    const position = positionOf(doc, 'guid role =', 'role');
    assert.ok(!await env.providers.hover.provideHover(doc, position, {}));
    activate(env, doc, position);
    assert.ok(!await command(env, 'bl.showRecordCard'), 'same type guid is not enough to invent a record card');
});

test('computed records retain cards by name without an invented static GUID', async t => {
    const env = await setup(t);
    const model = await command(env, 'bl.showRecordCard', { filePath: access, name: 'Dynamic' });
    assert.equal(model.name, 'Dynamic');
    assert.equal(model.guid, null);
    const unknown = await lookup(env, unknownGuid);
    assert.ok(!unknown);
});

test('duplicate GUID lookup requires an explicit candidate and cancellation opens nothing', async t => {
    const migration = `${root}/app/src/main/bl/migrations/PreviousRoles.bl`;
    const env = await setup(t, { [migration]: `public class PreviousRoles { records { OldExpert = '${guid}'; } }` });
    let model = await lookup(env);
    assert.ok(!model);
    assert.equal(env.panels.length, 0);
    assert.equal(env.quickPicks.length, 1);
    assert.equal(env.quickPicks[0].items.length, 2);
    const itemsText = env.quickPicks[0].items.map(item => [item.label, item.description, item.detail].join(' ')).join('\n');
    assert.ok(itemsText.includes('Expert'));
    assert.ok(itemsText.includes('OldExpert'));
    env.quickPickResponses.push(1);
    model = await lookup(env);
    assert.ok([roles, migration].includes(model.filePath));
    assert.equal(model.otherDeclarations.length, 1);
    assert.ok(model.otherDeclarations.every(declaration => model.links.some(link => link.id === declaration.sourceId)));
    assert.equal(model.warnings.length, 0, 'historical declarations are not automatically conflicts');
    assert.ok(env.vscode.languages.getDiagnostics(env.vscode.Uri.file(roles)).every(diagnostic => diagnostic.code !== 'duplicate-guid'));
});

test('same-owner GUID aliases are potential conflicts with source evidence, not automatic errors', async t => {
    const text = fixtures[roles].replace('    }', `        AnotherExpert = '${guid}';\n    }`);
    const env = await setup(t, { [roles]: text }, [], { quickPickResponses: [0] });
    const model = await lookup(env);
    assert.ok(model.warnings.length > 0);
    assert.ok(model.warningSourceIds.length > 0);
    assert.ok(model.warningSourceIds.every(id => model.links.some(link => link.id === id && link.filePath === roles)));
    assert.equal(model.otherDeclarations.length, 1);
    assert.ok(!env.vscode.languages.getDiagnostics(env.vscode.Uri.file(roles)).some(diagnostic => diagnostic.code === 'duplicate-guid'));
    assert.equal(env.contents.get(roles), text);
});

test('explicit source workspace context isolates another checkout even when it is the only static candidate', async t => {
    const foreign = roles.replace('/clm/', '/cloud/');
    const env = await setup(t, { [foreign]: fixtures[roles] }, [], { workspaceFolders: [root, '/workspace/cloud'] });
    let model = await lookup(env);
    assert.equal(model.filePath, roles);
    assert.equal(env.quickPicks.length, 0);
    env.contents.set(roles, 'public class Roles {}');
    await env.fileEvent('change', roles);
    const before = env.panels.length;
    model = await lookup(env);
    assert.ok(!model, 'must not fall back to a matching record from another checkout');
    assert.equal(env.panels.length, before);
    model = await lookup(env, guid, foreign);
    assert.equal(model.filePath, foreign);
});

test('lookup without source context requires choosing a workspace before selecting a declaration', async t => {
    const foreign = roles.replace('/clm/', '/cloud/');
    const env = await setup(t, { [foreign]: fixtures[roles] }, [], { workspaceFolders: [root, '/workspace/cloud'] });
    let model = await command(env, 'bl.lookupGuid', guid);
    assert.ok(!model);
    assert.equal(env.panels.length, 0);
    assert.equal(env.quickPicks.length, 1);
    assert.equal(env.quickPicks[0].items.length, 2);
    const sourceDetails = env.quickPicks[0].items.map(item => [item.description, item.detail].join(' ')).join('\n');
    assert.ok(sourceDetails.includes('/workspace/clm'));
    assert.ok(sourceDetails.includes('/workspace/cloud'));
    env.quickPickResponses.push(0);
    model = await command(env, 'bl.lookupGuid', guid);
    assert.equal(model.filePath, roles);
    assert.equal(model.otherDeclarations.length, 0);
});

test('a containing multi-checkout workspace honors available Git checkout metadata', async t => {
    const foreign = roles.replace('/clm/', '/cloud/');
    const env = await setup(t, { [foreign]: fixtures[roles] }, [], {
        workspaceFolders: ['/workspace'], checkoutRoots: [root, '/workspace/cloud']
    });
    const model = await lookup(env);
    assert.equal(model.filePath, roles);
    assert.equal(env.quickPicks.length, 0);
    env.contents.set(roles, 'public class Roles {}');
    await env.fileEvent('change', roles);
    assert.ok(!await lookup(env), 'known checkout boundary must not widen when a record is absent locally');
});

test('when no checkout boundary is known GUID definitions expose ambiguity instead of choosing a nearest copy', async t => {
    const foreign = roles.replace('/clm/', '/cloud/');
    const env = await setup(t, { [foreign]: fixtures[roles] }, [], { workspaceFolders: [] });
    const doc = document(consumer, fixtures[consumer]);
    const found = locations(await env.providers.definition.provideDefinition(doc, positionOf(doc, 'guid literal', guid.toLowerCase()), {}));
    assert.deepEqual(new Set(found.map(location => location.uri.fsPath)), new Set([roles, foreign]));
    const model = await lookup(env);
    assert.ok(!model);
    assert.equal(env.quickPicks.at(-1).items.length, 2);
    assert.equal(env.panels.length, 0);
});

for (const configuration of [{ 'diagnostics.mode': 'onSave' }, { 'diagnostics.enabled': false }]) {
    test(`GUID lookup observes unsaved dependencies independently of ${Object.keys(configuration)[0]}`, async t => {
        const dirty = document(roles, fixtures[roles]);
        const env = await setup(t, {}, [dirty], { configuration });
        const initial = await lookup(env);
        assert.equal(initial.name, 'Expert');
        Object.assign(dirty, document(roles, fixtures[roles].replace(guid, unknownGuid).replace('Expert =', 'Renamed =')));
        dirty.isDirty = true;
        env.change(dirty);
        const previous = await lookup(env);
        assert.ok(!previous);
        const model = await lookup(env, unknownGuid);
        assert.equal(model.name, 'Renamed');
        assert.equal(model.filePath, roles);
        assert.equal(env.contents.get(roles), fixtures[roles], 'dirty source is indexed, not written to disk');
    });
}

test('GUID index tracks file watcher change, rename/create and deletion', async t => {
    const env = await setup(t);
    env.contents.set(roles, fixtures[roles].replace(guid, unknownGuid));
    await env.fileEvent('change', roles);
    assert.ok(!await lookup(env));
    assert.equal((await lookup(env, unknownGuid)).filePath, roles);
    const moved = `${root}/app/src/main/bl/access/MovedRoles.bl`;
    env.contents.set(moved, env.contents.get(roles).replace('class Roles', 'class MovedRoles'));
    env.contents.delete(roles);
    await env.fileEvent('delete', roles);
    await env.fileEvent('create', moved);
    const model = await lookup(env, unknownGuid);
    assert.equal(model.filePath, moved);
    assert.equal(model.owner, 'access.MovedRoles');
    env.contents.delete(moved);
    await env.fileEvent('delete', moved);
    assert.ok(!await lookup(env, unknownGuid));
});

test('access cards retain attribute source evidence and resolve related record declarations', async t => {
    const env = await setup(t);
    const model = await command(env, 'bl.showRecordCard', { filePath: access, name: 'ExpertDzwfModify' });
    assert.equal(model.filePath, access);
    assert.deepEqual(Array.from(model.attributes, attr => attr.name), ['name', 'roleId', 'soaId', 'value']);
    assert.ok(model.attributes.every(attr => Number.isInteger(attr.sourceId) && model.links.some(link => link.id === attr.sourceId)));
    assert.deepEqual(new Set(model.related.map(record => record.label.split('.').at(-1))), new Set(['Expert', 'DzwfModify']));
    assert.ok(model.related.every(record => Number.isInteger(record.sourceId) && model.links.some(link => link.id === record.sourceId)));
    assert.ok(model.notice, 'source declarations must not be presented as effective runtime permissions');
});

test('card source navigation accepts only model-owned numeric link IDs and ignores injected paths/commands', async t => {
    const env = await setup(t);
    const model = await command(env, 'bl.showRecordCard', { filePath: access, name: 'ExpertDzwfModify' });
    const panel = env.panels.at(-1);
    const link = model.links.find(link => link.filePath === roles);
    assert.ok(link);
    await panel.receiveMessage({ type: 'openSource', id: link.id });
    assert.equal(env.sourceOpens.length, 1);
    assert.equal(env.sourceOpens[0].document.uri.fsPath, roles);
    const range = env.sourceOpens[0].config && env.sourceOpens[0].config.selection;
    const selection = range || env.sourceOpens[0].editor.selection;
    assert.equal(selection.start.line, link.line);
    assert.equal(selection.start.character, link.column);
    const before = env.sourceOpens.length;
    for (const message of [
        { type: 'openSource', id: -1 }, { type: 'openSource', id: 999999 },
        { type: 'openSource', id: String(link.id) }, { type: 'openSource', id: {} },
        { type: 'openSource', filePath: '/etc/passwd' },
        { type: 'executeCommand', command: 'workbench.action.closeAllEditors' }
    ]) await panel.receiveMessage(message);
    assert.equal(env.sourceOpens.length, before);
    assert.ok(!env.commandCalls.some(call => call.name === 'workbench.action.closeAllEditors'));
    panel.dispose();
    await panel.receiveMessage({ type: 'openSource', id: link.id });
    assert.equal(env.sourceOpens.length, before);
});

test('explicit card refresh reflects a changed unsaved declaration instead of stale panel metadata', async t => {
    const dirty = document(roles, fixtures[roles]);
    const env = await setup(t, {}, [dirty], { configuration: { 'diagnostics.enabled': false } });
    await command(env, 'bl.showRecordCard', { filePath: roles, name: 'Expert' });
    const panel = env.panels.at(-1);
    Object.assign(dirty, document(roles, fixtures[roles].replace(guid, unknownGuid).replace('$Roles.Expert$', '$Roles.changed$')));
    env.change(dirty);
    await panel.receiveMessage({ type: 'refresh' });
    assert.ok(panel.webview.html.includes(unknownGuid.toLowerCase()));
    assert.ok(panel.webview.html.includes('$Roles.changed$'));
    assert.ok(!panel.webview.html.includes(guid.toLowerCase()));
});

test('record usages separate resolved symbols, GUID literals and comment/string text matches', async t => {
    const other = `${root}/app/src/main/bl/access/OtherRoles.bl`;
    const otherConsumer = `${root}/app/src/main/bl/app/OtherConsumer.bl`;
    const env = await setup(t, {
        [other]: `public class OtherRoles { records { Expert = '${objectGuid}'; } }`,
        [otherConsumer]: 'import access.OtherRoles;\npublic class OtherConsumer { public void run() { guid role = OtherRoles.Expert; } }'
    });
    const model = await command(env, 'bl.showGuidUsages', { filePath: roles, name: 'Expert' });
    assert.ok(model.usages);
    const symbols = model.usages.symbol;
    assert.ok(symbols.some(use => use.filePath === consumer && use.line === 5));
    assert.ok(symbols.some(use => use.filePath === consumer && use.line === 6), 'inherited symbols share the original declaration');
    assert.ok(!symbols.some(use => use.filePath === otherConsumer), 'same name must not be mistaken for the same record');
    assert.ok(model.usages.literal.some(use => use.filePath === consumer && use.line === 7));
    assert.ok(model.usages.text.some(use => use.filePath === consumer && use.line === 8));
    assert.ok(model.usages.text.some(use => use.filePath === consumer && use.line === 9));
    assert.ok(!model.usages.literal.some(use => use.filePath === consumer && (use.line === 8 || use.line === 9)));
    const doc = document(roles, fixtures[roles]);
    const references = await env.providers.references.provideReferences(doc, positionOf(doc, '[name', 'Expert', 1), { includeDeclaration: false }, {});
    assert.ok(references.some(use => use.uri.fsPath === consumer && use.range.start.line === 5));
    assert.ok(!references.some(use => use.uri.fsPath === consumer && use.range.start.line >= 7), 'standard references remain symbol-only');
});

test('GUID definition and hover honor cancellation without showing partial results', async t => {
    const env = await setup(t);
    const doc = document(consumer, fixtures[consumer]);
    const cursor = positionOf(doc, 'guid literal', guid.toLowerCase());
    const token = { isCancellationRequested: true };
    assert.equal(locations(await env.providers.definition.provideDefinition(doc, cursor, token)).length, 0);
    assert.ok(!await env.providers.hover.provideHover(doc, cursor, token));
    assert.equal(env.panels.length, 0);
});

test('GUID usage search yields and cancellation displays a cancelled panel, never partial results', async t => {
    const long = fixtures[consumer].replace('        guid role = Roles.Expert;', '        guid role = Roles.Expert;\n' + '        role = Roles.Expert;\n'.repeat(1000));
    const env = await setup(t, { [consumer]: long });
    const cancelled = { isCancellationRequested: true };
    assert.ok(!await command(env, 'bl.showGuidUsages', { filePath: roles, name: 'Expert' }, cancelled));
    assert.equal(env.panels.length, 0, 'already-cancelled command opens nothing');
    const token = { isCancellationRequested: false };
    const timer = new Promise(resolve => setImmediate(() => { token.isCancellationRequested = true; resolve(); }));
    const result = await command(env, 'bl.showGuidUsages', { filePath: roles, name: 'Expert' }, token);
    await timer;
    assert.ok(!result);
    assert.equal(env.panels.length, 1);
    assert.ok(env.panels[0].webview.html.includes('Поиск отменён'));
    assert.ok(!env.panels[0].webview.html.includes('class="usage-group"'));
});

test('GUID usage cards stay in the explicit checkout and find unsaved literal/text edits', async t => {
    const foreignRoles = roles.replace('/clm/', '/cloud/');
    const foreignConsumer = consumer.replace('/clm/', '/cloud/');
    const dirty = document(consumer, fixtures[consumer]);
    const env = await setup(t, { [foreignRoles]: fixtures[roles], [foreignConsumer]: fixtures[consumer] }, [dirty], {
        workspaceFolders: [root, '/workspace/cloud'], configuration: { 'diagnostics.enabled': false }
    });
    Object.assign(dirty, document(consumer, fixtures[consumer].replace('string message =', `guid extra = '${guid}';\n        string message =`)));
    dirty.isDirty = true;
    env.change(dirty);
    const model = await command(env, 'bl.showGuidUsages', { filePath: roles, name: 'Expert', sourceUri: env.vscode.Uri.file(consumer) });
    assert.equal(model.usages.literal.filter(use => use.filePath === consumer).length, 2);
    for (const group of ['symbol', 'literal', 'text']) {
        assert.ok(model.usages[group].every(use => !use.filePath.includes('/cloud/')));
    }
    assert.equal(env.contents.get(consumer), fixtures[consumer]);
});
