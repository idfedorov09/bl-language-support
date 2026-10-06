const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { document, positionOf, extension } = require('./helpers');
const { BlIndex } = require('../blIndex');
const { DocumentAnalysis } = require('../documentAnalysis');
const { createGuidNavigation } = require('../guidNavigation');
const root = '/workspace/clm';
const workspace = `${root}/core/src/main/bl/example/Workspace.bl`;
const consumer = `${root}/core/src/main/bl/example/Consumer.bl`;
const guid = '00629445-F77A-407C-9F4D-3E3B63D7DA2D';
const otherGuid = '3AB51274-196D-4605-AC83-1B7F3F7ACE88';
const source = `public class Workspace { static public final guid General = '${guid}'; records { Entry = '${otherGuid}'; } }`;
const use = `public class Consumer { public void run() { guid id = Workspace.General; guid literal = '${guid}'; } }`;
async function setup(t, options = {}, files = {}) {
    const env = await extension({ [workspace]: source, [consumer]: use, ...files }, [], { workspaceFolders: [root], ...options });
    t.after(() => env.dispose()); return env;
}

test('lookup, card and usages open a new tab in the active group, never request a split', async t => {
    const env = await setup(t);
    const doc = document(workspace, source);
    for (const column of [null, env.vscode.ViewColumn.One, env.vscode.ViewColumn.Two]) {
        env.vscode.window.activeTextEditor = column === null ? null : {
            document: doc, viewColumn: column,
            selection: new env.vscode.Selection(new env.vscode.Position(0, 0), new env.vscode.Position(0, 0))
        };
        for (const [name, value] of [['General', guid], ['Entry', otherGuid]]) {
            for (const command of ['bl.lookupGuid', 'bl.showRecordCard', 'bl.showGuidUsages']) {
                const before = env.panels.length;
                const argument = command === 'bl.lookupGuid'
                    ? { guid: value, sourceUri: doc.uri } : { filePath: workspace, name };
                const model = await env.commands.get(command)(argument);
                assert.equal(model.name, name);
                assert.equal(env.panels.length, before + 1, 'each invocation opens a separate tab');
                const panel = env.panels.at(-1);
                assert.equal(panel.column, env.vscode.ViewColumn.Active, `${command} must target the current editor group`);
                assert.notEqual(panel.column, env.vscode.ViewColumn.Beside);
                assert.ok(model.usages || command !== 'bl.showGuidUsages');
                panel.dispose();
            }
        }
    }
});

test('Workspace.General is found by GUID, symbol navigation, hover and separated usages', async t => {
    const env = await setup(t);
    const model = await env.commands.get('bl.lookupGuid')({ guid, sourceUri: env.vscode.Uri.file(workspace) });
    assert.equal(model.kind, 'constant'); assert.equal(model.name, 'General');
    assert.ok(env.panels[0].webview.html.includes('не является декларацией records'));
    const doc = document(consumer, use);
    for (const word of ['General', guid]) {
        const result = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'class Consumer', word), {});
        const locations = Array.isArray(result) ? result : [result];
        assert.ok(locations.some(l => l.uri.fsPath === workspace && l.range.start.character === source.indexOf('General')));
    }
    const hover = await env.providers.hover.provideHover(doc, positionOf(doc, 'class Consumer', 'General'), {});
    assert.ok(hover.contents[0].value.includes('GUID-константа'));
    const usages = await env.commands.get('bl.showGuidUsages')({ filePath: workspace, name: 'General' });
    assert.ok(usages.usages.symbol.some(u => u.filePath === consumer));
    assert.ok(usages.usages.literal.some(u => u.filePath === consumer));
    assert.ok(env.panels.at(-1).webview.html.includes('BL-ссылки: 1'));
});

test('QuickPick filters partial UUID/name/owner and labels kind, GUID and relative source', async t => {
    const env = await setup(t, { guidPickerResponses: [picker => {
        assert.equal(picker.matchOnDescription, true); assert.equal(picker.matchOnDetail, true);
        assert.equal(picker.validationMessage, undefined);
        for (const query of ['0062', 'General', 'example.Workspace']) {
            picker.value = query;
            assert.ok(picker.visibleItems.some(i => i.label === 'General'));
        }
        picker.value = '0062';
        const item = picker.visibleItems[0];
        assert.equal(item.description, guid.toLowerCase());
        assert.ok(item.detail.includes('GUID-константа') && item.detail.includes('core/src/main/bl/example/Workspace.bl:1'));
        picker.accept();
    }] });
    const model = await env.commands.get('bl.lookupGuid')({ sourceUri: env.vscode.Uri.file(workspace) });
    assert.equal(model.name, 'General'); assert.equal(env.prompts.length, 0);
    assert.equal(env.guidPickers[0].disposed, true);
});

test('partial selection prefill and unknown full UUID action never fabricate a declaration', async t => {
    const env = await setup(t, { guidPickerResponses: [0, '11111111-1111-1111-1111-111111111111'] });
    const doc = document(consumer, use); const start = use.indexOf(guid);
    env.vscode.window.activeTextEditor = { document: doc, selection: new env.vscode.Selection(doc.positionAt(start), doc.positionAt(start + 4)) };
    assert.equal((await env.commands.get('bl.lookupGuid')()).name, 'General');
    assert.equal(env.guidPickers[0].initialValue, '0062');
    assert.equal(await env.commands.get('bl.lookupGuid')(), null);
    assert.equal(env.panels.length, 1);
    assert.ok(env.guidPickers[1].items[0].alwaysShow);
    assert.ok(env.messages.at(-1).message.includes('статическая декларация'));
    assert.equal(env.messages.at(-1).type, 'information');
});

test('QuickPick scope choice, dirty watcher edits and removal do not choose another checkout', async t => {
    const foreign = workspace.replace('/clm/', '/cloud/');
    const env = await setup(t, { workspaceFolders: [root, '/workspace/cloud'], quickPickResponses: [0], guidPickerResponses: [async picker => {
        assert.ok(picker.items.every(i => i.match.owner.filePath.startsWith(root + '/')));
        const chosen = picker.items.find(i => i.label === 'General');
        env.contents.set(workspace, source.replace(guid, otherGuid));
        await env.fileEvent('change', workspace);
        picker.accept(chosen);
    }] }, { [foreign]: source });
    assert.equal(await env.commands.get('bl.lookupGuid')(), null);
    assert.equal(env.quickPicks.length, 1); assert.equal(env.panels.length, 0);
    assert.ok(env.messages.some(m => m.message.includes('изменилась во время выбора')));
});

test('QuickPick cancellation and extension disposal hide and dispose it without opening a panel', async t => {
    for (const disposal of [false, true]) {
        let listener;
        const token = { isCancellationRequested: false, onCancellationRequested(callback) { listener = callback; return { dispose() { listener = null; } }; } };
        const env = await setup(t, { guidPickerResponses: [picker => {
            if (disposal) env.dispose();
            else { token.isCancellationRequested = true; listener(); }
            assert.equal(picker.hidden, true); assert.equal(picker.disposed, true);
        }] });
        assert.equal(await env.commands.get('bl.lookupGuid')({ sourceUri: env.vscode.Uri.file(workspace) }, token), null);
        assert.equal(env.panels.length, 0);
    }
});

function actionArguments(hover, command) {
    const metadata = hover.contents.filter(m => m.isTrusted !== true);
    const actions = hover.contents.filter(m => m.isTrusted === true);
    assert.equal(actions.length, 1);
    assert.ok(metadata.every(m => m.isTrusted === false));
    assert.deepEqual([...actions[0].value.matchAll(/command:([^?]+)\?/g)].map(m => m[1]), ['bl.showRecordCard', 'bl.showGuidUsages']);
    const args = actions[0].value.match(new RegExp(`command:${command}\\?([^)]*)`))[1];
    return JSON.parse(decodeURIComponent(args));
}

test('hover actions stay bound to their declaration after moving the editor cursor', async t => {
    const env = await setup(t); const doc = document(consumer, use);
    const hover = await env.providers.hover.provideHover(doc, positionOf(doc, 'class Consumer', 'General'), {});
    env.vscode.window.activeTextEditor = { document: document(workspace, source), selection: new env.vscode.Selection(new env.vscode.Position(0, 0), new env.vscode.Position(0, 0)) };
    for (const command of ['bl.showRecordCard', 'bl.showGuidUsages']) {
        const model = await env.vscode.commands.executeCommand(command, ...actionArguments(hover, command));
        assert.equal(model.name, 'General'); assert.equal(model.filePath, workspace);
        if (command === 'bl.showGuidUsages') assert.ok(model.usages);
    }
});

test('hover action arguments cannot inject Markdown/commands and carry exact duplicate offsets', async t => {
    const poisonFile = `${root}/core/src/main/bl/example/P')](command:evil).bl`;
    const text = `public class Poison { records { Same = '${guid}'; Same = '${otherGuid}'; } }`;
    const env = await setup(t, {}, { [poisonFile]: text });
    const doc = document(poisonFile, text);
    const hover = await env.providers.hover.provideHover(doc, doc.positionAt(text.indexOf('Same') + 1), {});
    const [argument] = actionArguments(hover, 'bl.showRecordCard');
    assert.equal(argument.offset, text.indexOf('Same')); assert.equal(argument.filePath, poisonFile);
    assert.ok(!hover.contents.at(-1).value.includes('command:evil'));
    const model = await env.commands.get('bl.showRecordCard')(argument);
    assert.equal(model.guid, guid.toLowerCase()); assert.equal(env.quickPicks.length, 0);
});

// Inject delayed/failing local services to check host/controller transactions.
async function harness(t, reference) {
    const env = await setup(t); const index = new BlIndex();
    index.updateFromText(workspace, source); index.updateFromText(consumer, use);
    const nav = createGuidNavigation(env.vscode, {
        index, ensureIndexReady: async () => {}, updateIndexFromDocument: doc => index.updateFromText(doc.uri.fsPath, doc.getText()),
        getAnalysis: doc => new DocumentAnalysis(doc.getText()), readFile: async file => file === workspace ? source : use,
        definitionProvider: { provideDefinition: async () => [] }, referenceProvider: { provideReferences: reference }
    });
    t.after(() => nav.dispose()); return { env, nav, index };
}

test('search opens visible loading panel, ignores repeated searches and preserves tab changes during search/refresh', async t => {
    let release, calls = 0;
    const { env, nav } = await harness(t, () => { calls++; return new Promise(resolve => { release = resolve; }); });
    const searching = nav.showGuidUsages({ filePath: workspace, name: 'General' });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const panel = env.panels[0];
    assert.ok(panel.webview.html.includes('Ищем использования'));
    assert.match(panel.webview.html, /id="find-usages"[^>]* disabled/);
    assert.match(panel.webview.html, /id="details-panel"[^>]* hidden/);
    assert.doesNotMatch(panel.webview.html, /id="usages-panel"[^>]* hidden/);
    await panel.receiveMessage({ type: 'findUsages' }); assert.equal(calls, 1);
    await panel.receiveMessage({ type: 'setView', view: 'details' });
    release([]); assert.ok((await searching).usages);
    assert.match(panel.webview.html, /id="usages-panel"[^>]* hidden/);
    await panel.receiveMessage({ type: 'setView', view: 'usages' });
    await panel.receiveMessage({ type: 'setView', view: 'evil' });
    await panel.receiveMessage({ type: 'refresh' });
    assert.doesNotMatch(panel.webview.html, /id="usages-panel"[^>]* hidden/);
    assert.ok(panel.webview.html.includes('Поиск ещё не запущен'));
    assert.ok(!panel.webview.html.includes('Поиск завершён'));
});

test('search failure is inline, escaped, retryable and never displays prior usages as current', async t => {
    let fail = false;
    const { env, nav } = await harness(t, async () => { if (fail) throw Error('<bad> & secret-free fixture'); return []; });
    await nav.showGuidUsages({ filePath: workspace, name: 'General' });
    const panel = env.panels[0]; fail = true;
    await panel.receiveMessage({ type: 'findUsages' });
    assert.ok(panel.webview.html.includes('Поиск не выполнен. &lt;bad&gt; &amp;'));
    assert.ok(!panel.webview.html.includes('class="usage-group"'));
    assert.doesNotMatch(panel.webview.html, /id="find-usages"[^>]* disabled/);
    fail = false; await panel.receiveMessage({ type: 'findUsages' });
    assert.ok(panel.webview.html.includes('Поиск завершён'));
});

test('manifest keeps command IDs and one BL submenu with Java/GUID/debug groups and engine 1.60', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(manifest.engines.vscode, '^1.60.0');
    const c = manifest.contributes;
    const entries = c.menus['editor/context'];
    assert.equal(entries.length, 1); assert.equal(entries[0].submenu, 'bl.tools'); assert.equal(entries[0].when, 'resourceLangId == bl || resourceLangId == javascript');
    assert.ok(c.submenus.some(s => s.id === 'bl.tools' && s.label === 'Z8BL'));
    const submenu = c.menus['bl.tools'];
    assert.deepEqual(new Set(submenu.map(i => i.command)), new Set(c.commands.map(i => i.command)));
    assert.deepEqual(new Set(submenu.map(i => i.group.split('@')[0])), new Set(['1_java', '1_navigation', '2_guid', '3_debug']));
    assert.ok(submenu.every(item => item.when === (item.command === 'bl.showServerSources' ? 'resourceLangId == javascript' : 'resourceLangId == bl')));
    assert.ok(c.commands.every(command => command.title.startsWith('BL: ') && command.shortTitle && !command.shortTitle.startsWith('BL: ')));
});

test('constant lookup tracks unsaved buffers and watcher deletion/creation without changing CLM source', async t => {
    const env = await setup(t);
    const dirty = document(workspace, source);
    env.vscode.workspace.textDocuments.push(dirty); env.open(dirty);
    Object.assign(dirty, document(workspace, source.replace(guid, otherGuid)));
    dirty.isDirty = true; env.change(dirty);
    assert.equal(await env.commands.get('bl.lookupGuid')({ guid, sourceUri: dirty.uri }), null);
    let model = await env.commands.get('bl.showRecordCard')({ filePath: workspace, name: 'General' });
    assert.equal(model.guid, otherGuid.toLowerCase()); assert.equal(model.kind, 'constant');
    assert.equal(env.contents.get(workspace), source);
    env.close(dirty);
    env.contents.delete(workspace); await env.fileEvent('delete', workspace);
    assert.equal(await env.commands.get('bl.lookupGuid')({ guid, sourceUri: dirty.uri }), null);
    const moved = workspace.replace('Workspace.bl', 'Moved.bl');
    env.contents.set(moved, source.replace('class Workspace', 'class Moved'));
    await env.fileEvent('create', moved);
    model = await env.commands.get('bl.lookupGuid')({ guid, sourceUri: env.vscode.Uri.file(moved) });
    assert.equal(model.filePath, moved); assert.equal(model.name, 'General');
});

test('unreadable GUID candidates produce an explicit partial search, not a fabricated full result', async t => {
    const env = await setup(t);
    const index = new BlIndex(); index.updateFromText(workspace, source); index.updateFromText(consumer, use);
    const nav = createGuidNavigation(env.vscode, {
        index, ensureIndexReady: async () => {}, updateIndexFromDocument: () => {},
        getAnalysis: doc => new DocumentAnalysis(doc.getText()),
        readFile: async file => { if (file === consumer) throw Object.assign(Error('fixture unavailable'), { code: 'EACCES' }); return source; },
        definitionProvider: { provideDefinition: async () => [] }, referenceProvider: { provideReferences: async () => [] }
    });
    t.after(() => nav.dispose());
    const model = await nav.showGuidUsages({ filePath: workspace, name: 'General' });
    assert.ok(model.usages.partial.includes('1 файлов'));
    assert.ok(env.panels[0].webview.html.includes('Поиск неполный'));
    assert.ok(env.panels[0].webview.html.includes('Поиск ограничен'));
});

test('a failed retry removes old usage IDs as well as hidden results', async t => {
    let fail = false;
    const { env, nav } = await harness(t, async () => { if (fail) throw Error('retry failure'); return []; });
    const model = await nav.showGuidUsages({ filePath: workspace, name: 'General' });
    const oldId = model.usages.literal[0].id;
    assert.ok(oldId >= 2);
    const panel = env.panels[0]; fail = true;
    await panel.receiveMessage({ type: 'findUsages' });
    await panel.receiveMessage({ type: 'openSource', id: oldId });
    assert.equal(env.sourceOpens.length, 0, 'stale IDs are no longer in the host allowlist');
    assert.ok(panel.webview.html.includes('Поиск не выполнен'));
});
