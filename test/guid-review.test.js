const assert = require('node:assert/strict');
const { test } = require('node:test');
const { document, extension } = require('./helpers');
const { BlIndex } = require('../blIndex');
const { DocumentAnalysis } = require('../documentAnalysis');
const { createGuidNavigation } = require('../guidNavigation');

const root = '/workspace/clm';
const roles = `${root}/app/src/main/bl/access/Roles.bl`;
const access = `${root}/app/src/main/bl/access/RoleAccess.bl`;
const guid = '6D79CDE1-FA42-40A7-86C2-091EF32AA058';
const nextGuid = '3AB51274-196D-4605-AC83-1B7F3F7ACE88';
const roleSource = value => `public class Roles {
    records { [name "role"] Expert = '${value}'; }
}`;

test('GUID lookup revalidates source edits made while the QuickPick is open', async t => {
    const dirty = document(roles, roleSource(guid));
    const env = await extension({ [roles]: roleSource(guid) }, [dirty], {
        workspaceFolders: [root], configuration: { 'diagnostics.enabled': false }
    });
    t.after(() => env.dispose());
    env.guidPickerResponses.push(async picker => {
        Object.assign(dirty, document(roles, roleSource(nextGuid)));
        dirty.isDirty = true;
        env.change(dirty);
        picker.accept();
    });
    const model = await env.commands.get('bl.lookupGuid')({ sourceUri: env.vscode.Uri.file(roles) });
    assert.equal(model, null, 'the old UUID no longer exists after editing during the prompt');
    assert.equal(env.panels.length, 0, 'do not open an obsolete record card');
});

test('candidate selection cannot open metadata captured before a file watcher change', async t => {
    const migration = `${root}/app/src/main/bl/access/Migration.bl`;
    const env = await extension({
        [roles]: roleSource(guid),
        [migration]: `public class Migration { records { Legacy = '${guid}'; } }`
    }, [], { workspaceFolders: [root] });
    t.after(() => env.dispose());
    env.vscode.window.showQuickPick = async items => {
        const chosen = items.find(item => item.match.owner.filePath === roles);
        env.contents.set(roles, roleSource(nextGuid));
        await env.fileEvent('change', roles);
        return chosen;
    };
    const model = await env.commands.get('bl.lookupGuid')({ guid, sourceUri: env.vscode.Uri.file(roles) });
    assert.ok(!model || model.guid === nextGuid.toLowerCase(), 'selection must be discarded or rebuilt from current source');
    assert.ok(!model || !env.panels.at(-1).webview.html.includes(guid.toLowerCase()));
});

test('record attribute links never silently widen the selected checkout', async t => {
    const foreignRoles = roles.replace('/clm/', '/cloud/');
    const env = await extension({
        [foreignRoles]: roleSource(guid),
        [access]: `import access.Roles;
public class RoleAccess {
    records { [roleId Roles.Expert] Permission = '${nextGuid}'; }
}`
    }, [], { workspaceFolders: [root, '/workspace/cloud'] });
    t.after(() => env.dispose());
    const model = await env.commands.get('bl.showRecordCard')({ filePath: access, name: 'Permission' });
    assert.ok(model);
    assert.equal(model.related.length, 0, 'the local Roles source is absent, so a foreign checkout is not a confirmed relation');
    assert.ok(model.links.every(link => !link.filePath.startsWith('/workspace/cloud/')));
});

test('an ambiguous attribute symbol retains both record declarations rather than the last Map entry', async t => {
    const env = await extension({
        [roles]: `public class Roles { records { Expert = '${guid}'; Expert = '${nextGuid}'; } }`,
        [access]: `import access.Roles;
public class RoleAccess {
    records { [roleId Roles.Expert] Permission = '${guid}'; }
}`
    }, [], { workspaceFolders: [root] });
    t.after(() => env.dispose());
    const model = await env.commands.get('bl.showRecordCard')({ filePath: access, name: 'Permission' });
    assert.ok(model);
    assert.equal(model.related.length, 2, 'related source candidates must not silently choose the last duplicate');
    assert.ok(model.related.every(entry => entry.ambiguous));
    assert.ok(model.warnings.some(warning => warning.includes('Связь неоднозначна')));
    assert.equal(model.warningSourceIds.length, 2);
    assert.deepEqual(new Set(model.related.map(entry => entry.guid)), new Set([guid.toLowerCase(), nextGuid.toLowerCase()]));
});

test('unchanged same-name same-GUID declarations retain the explicitly chosen record on card refresh', async t => {
    const env = await extension({
        [roles]: `public class Roles { records { [name "first"] Expert = '${guid}'; [name "second"] Expert = '${guid}'; } }`
    }, [], { workspaceFolders: [root], quickPickResponses: [0] });
    t.after(() => env.dispose());
    const model = await env.commands.get('bl.showRecordCard')({ filePath: roles, name: 'Expert' });
    assert.ok(model);
    const panel = env.panels.at(-1);
    await panel.receiveMessage({ type: 'openSource', id: model.sourceId });
    assert.equal(env.sourceOpens.length, 1, 'same-text document opening may reparse, but must retain the explicit selection');
    await panel.receiveMessage({ type: 'refresh' });
    assert.ok(!env.messages.some(entry => /удалена или неоднозначно изменена/.test(entry.message)), 'source has not changed, so the explicit choice is still identifiable');
    await panel.receiveMessage({ type: 'findUsages' });
    assert.ok(panel.webview.html.includes('GUID-литералы'), 'literal uses remain available even while symbols are ambiguous');
});

test('GUID usage search detects a closed source changed during its asynchronous reference phase', async t => {
    const env = await extension({ [roles]: roleSource(guid) }, [], { workspaceFolders: [root] });
    t.after(() => env.dispose());
    const index = new BlIndex();
    index.updateFromText(roles, roleSource(guid));
    const consumer = `${root}/app/src/main/bl/Consumer.bl`;
    const consumerText = `public class Consumer { guid role = '${guid}'; }`;
    index.updateFromText(consumer, consumerText);
    const nav = createGuidNavigation(env.vscode, {
        index,
        ensureIndexReady: async () => {},
        updateIndexFromDocument: doc => index.updateFromText(doc.uri.fsPath, doc.getText()),
        getAnalysis: doc => new DocumentAnalysis(doc.getText()),
        readFile: async file => file === roles ? roleSource(guid) : consumerText,
        definitionProvider: { provideDefinition: async () => [] },
        referenceProvider: { provideReferences: async () => {
            // A watcher can complete while a reference search awaits/yields.
            await new Promise(resolve => setImmediate(resolve));
            index.updateFromText(roles, roleSource(nextGuid));
            return [];
        } }
    });
    t.after(() => nav.dispose());
    const model = await nav.showGuidUsages({ filePath: roles, name: 'Expert' });
    assert.equal(model, null, 'a closed synthetic source has no version counter, so current declaration identity must also be checked');
    assert.equal(env.panels.length, 1, 'the panel opens before the asynchronous search');
    assert.ok(env.panels[0].webview.html.includes('Исходники изменились во время поиска'));
    assert.ok(!env.panels[0].webview.html.includes('class="usage-group"'), 'no stale result rows');
});
