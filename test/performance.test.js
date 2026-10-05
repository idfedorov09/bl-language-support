const assert = require('node:assert/strict');
const { test } = require('node:test');
const { document, positionOf, extension } = require('./helpers');
const { BlIndex } = require('../blIndex');

const root = '/workspace/clm';
const owner = `${root}/app/src/main/bl/app/Owner.bl`;
const item = `${root}/base/src/main/bl/base/Item.bl`;
const other = `${root}/base/src/main/bl/base/Other.bl`;
const attributeJava = `${root}/z8/src/main/java/org/zenframework/z8/compiler/core/IAttribute.java`;
const fixtures = {
    [item]: 'public class Item {\n    public string name;\n    public void finish() {}\n}',
    [other]: 'public class Other {\n    public void wrong() {}\n}',
    [owner]: 'import base.Item;\npublic class Owner {\n    public Item item;\n    public void run() {\n        item.finish();\n    }\n}'
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function mutable(file, text) {
    let current = document(file, text);
    const doc = new Proxy({}, { get: (_, key) => current[key] });
    return { doc, set(text) { current = document(file, text); } };
}

test('rapid edits are coalesced and save flushes diagnostics immediately', async t => {
    const edit = mutable(owner, fixtures[owner]);
    const env = await extension(fixtures, [edit.doc], { configuration: { 'diagnostics.delay': 20 } });
    t.after(() => env.dispose());
    env.open(edit.doc);
    const before = env.diagnosticWrites.get(owner);
    edit.set(fixtures[owner].replace('item.finish()', 'item.missing()'));
    for (let i = 0; i < 10; i++) {
        edit.set(fixtures[owner].replace('item.finish()', 'item.missing()') + `\n// edit ${i}`);
        env.change(edit.doc);
    }
    assert.equal(env.vscode.languages.getDiagnostics(edit.doc.uri).length, 0);
    assert.equal(env.diagnosticWrites.get(owner), before);
    await wait(50);
    assert.equal(env.vscode.languages.getDiagnostics(edit.doc.uri).length, 1);
    assert.equal(env.diagnosticWrites.get(owner), before + 1);
    edit.set(fixtures[owner]);
    env.change(edit.doc);
    env.save(edit.doc);
    assert.equal(env.vscode.languages.getDiagnostics(edit.doc.uri).length, 0);
    await wait(30);
    assert.equal(env.vscode.languages.getDiagnostics(edit.doc.uri).length, 0);
    assert.equal(env.diagnosticWrites.get(owner), before + 2);
});

test('onSave and disabled diagnostics do not disable navigation', async t => {
    const edit = mutable(owner, fixtures[owner]);
    const env = await extension(fixtures, [edit.doc], { configuration: { 'diagnostics.mode': 'onSave', 'diagnostics.delay': 0 } });
    t.after(() => env.dispose());
    env.open(edit.doc);
    edit.set(fixtures[owner].replace('item.finish()', 'item.missing()'));
    env.change(edit.doc);
    await wait(15);
    assert.equal(env.vscode.languages.getDiagnostics(edit.doc.uri).length, 0);
    env.save(edit.doc);
    assert.equal(env.vscode.languages.getDiagnostics(edit.doc.uri).length, 1);
    env.configure({ 'diagnostics.enabled': false });
    assert.equal(env.vscode.languages.getDiagnostics(edit.doc.uri).length, 0);
    edit.set(fixtures[owner]);
    const definition = await env.providers.definition.provideDefinition(edit.doc, positionOf(edit.doc, 'item.finish()', 'finish'), {});
    assert.equal(definition[0].uri.fsPath, item);
});

test('closing or disposing cancels pending diagnostics', async t => {
    const doc = document(owner, fixtures[owner].replace('item.finish()', 'item.missing()'));
    const env = await extension(fixtures, [doc], { configuration: { 'diagnostics.delay': 15 } });
    t.after(() => env.dispose());
    env.change(doc);
    env.close(doc);
    await wait(40);
    assert.equal(env.vscode.languages.getDiagnostics(doc.uri).length, 0);
    const next = document(owner, doc.getText());
    env.change(next);
    env.dispose();
    await wait(30);
    assert.equal(env.vscode.languages.getDiagnostics(next.uri).length, 0);
});

test('native Java lookup is shared across documents but proximity is resolved per caller', async t => {
    const native = '[native "native.Owner"]\npublic class Owner {}';
    const cloud = owner.replace('/clm/', '/cloud/');
    const clmJava = `${root}/base/src/main/java/native/Owner.java`;
    const cloudJava = clmJava.replace('/clm/', '/cloud/');
    const env = await extension({ [owner]: native, [cloud]: native, [clmJava]: 'class Owner {}', [cloudJava]: 'class Owner {}' });
    t.after(() => env.dispose());
    for (const [file, expected] of [[owner, clmJava], [cloud, cloudJava], [owner, clmJava]]) {
        const doc = document(file, native);
        const result = await env.providers.definition.provideDefinition(doc, positionOf(doc, '[native', 'Owner'), {});
        assert.equal(result.uri.fsPath, expected);
    }
    assert.equal(env.searchCounts.get('**/src/main/java/native/Owner.java'), 1);
    assert.equal(env.searchCounts.get('**/src/java/native/Owner.java'), 1);
});

test('attribute source is read once and Java changes invalidate it', async t => {
    const text = '[name "one"]\npublic class Owner {\n    [name "two"] public string value;\n}';
    const env = await extension({ [owner]: text, [attributeJava]: 'public interface IAttribute {\n    String NAME = "name";\n}' });
    t.after(() => env.dispose());
    const doc = document(owner, text);
    const positions = [positionOf(doc, '[name "one"]', 'name'), positionOf(doc, '[name "two"]', 'name')];
    for (const pos of positions) assert.equal((await env.providers.definition.provideDefinition(doc, pos, {})).range.start.line, 1);
    assert.equal(env.readCounts.get(attributeJava), 1);
    env.contents.set(attributeJava, 'public interface IAttribute {\n\n    String NAME = "name";\n}');
    await env.fileEvent('change', attributeJava);
    assert.equal((await env.providers.definition.provideDefinition(doc, positions[0], {})).range.start.line, 2);
    assert.equal(env.readCounts.get(attributeJava), 2);
    assert.equal(env.searchCounts.get('**/src/main/java/org/zenframework/z8/compiler/core/IAttribute.java'), 1);
});

test('document version changes invalidate lexical, type and scope caches before diagnostics', async t => {
    const edit = mutable(owner, fixtures[owner]);
    const env = await extension(fixtures, [edit.doc]);
    t.after(() => env.dispose());
    const first = await env.providers.definition.provideDefinition(edit.doc, positionOf(edit.doc, 'item.finish()', 'finish'), {});
    assert.equal(first[0].uri.fsPath, item);
    edit.set(fixtures[owner].replace('public Item item', 'public base.Other item').replace('item.finish()', 'item.wrong()'));
    env.change(edit.doc);
    const next = await env.providers.definition.provideDefinition(edit.doc, positionOf(edit.doc, 'item.wrong()', 'wrong'), {});
    assert.equal(next[0].uri.fsPath, other);
});

test('navigation observes unsaved dependencies with onSave or disabled diagnostics', async t => {
    for (const configuration of [{ 'diagnostics.mode': 'onSave' }, { 'diagnostics.enabled': false }]) {
        const dependency = mutable(item, fixtures[item]);
        const env = await extension(fixtures, [dependency.doc], { configuration });
        t.after(() => env.dispose());
        const text = fixtures[owner].replace('item.finish()', 'item.changed()');
        const doc = document(owner, text);
        const pos = positionOf(doc, 'item.changed()', 'changed');
        assert.equal(await env.providers.definition.provideDefinition(doc, pos, {}), null);
        dependency.set(fixtures[item].replace('finish', 'changed'));
        env.change(dependency.doc);
        const found = await env.providers.definition.provideDefinition(doc, pos, {});
        assert.ok(found);
        assert.equal(found[0].uri.fsPath, item);
        assert.equal(env.diagnosticWrites.has(item), false);
    }
});

test('a previously missing native Java file can be found after creation', async t => {
    const text = '[name "one"]\npublic class Owner {}';
    const env = await extension({ [owner]: text });
    t.after(() => env.dispose());
    const doc = document(owner, text), pos = positionOf(doc, '[name', 'name');
    assert.equal(await env.providers.definition.provideDefinition(doc, pos, {}), null);
    env.contents.set(attributeJava, 'interface IAttribute { String NAME = "name"; }');
    await env.fileEvent('create', attributeJava);
    assert.equal((await env.providers.definition.provideDefinition(doc, pos, {})).uri.fsPath, attributeJava);
});

test('cached inline contexts follow changes in dependencies', async t => {
    const text = 'import base.Item;\npublic class Owner {\n    public Item item = class {\n        public void run() {\n            finish();\n        }\n    };\n}';
    const env = await extension({ ...fixtures, [owner]: text });
    t.after(() => env.dispose());
    const doc = document(owner, text), pos = positionOf(doc, 'finish();', 'finish');
    assert.ok(await env.providers.definition.provideDefinition(doc, pos, {}));
    env.contents.set(item, fixtures[item].replace('finish', 'changed'));
    await env.fileEvent('change', item);
    assert.equal(await env.providers.definition.provideDefinition(doc, pos, {}), null);
});

test('references only read candidate BL files and observe newly created files', async t => {
    const unrelated = `${root}/base/src/main/bl/base/Unrelated.bl`;
    const env = await extension({ ...fixtures, [unrelated]: 'public class Unrelated {}' });
    t.after(() => env.dispose());
    const doc = document(item, fixtures[item]), pos = positionOf(doc, 'void finish()', 'finish');
    const before = env.readCounts.get(unrelated);
    const refs = await env.providers.references.provideReferences(doc, pos, { includeDeclaration: false }, {});
    assert.equal(refs.length, 1);
    assert.equal(env.readCounts.get(unrelated), before);
    assert.equal(env.searchCounts.get('**/*.bl'), 1);
    const created = `${root}/app/src/main/bl/app/Created.bl`;
    env.contents.set(created, 'import base.Item;\npublic class Created {\n    public Item item;\n    public void run() { item.finish(); }\n}');
    await env.fileEvent('create', created);
    const next = await env.providers.references.provideReferences(doc, pos, { includeDeclaration: false }, {});
    assert.ok(next.some(ref => ref.uri.fsPath === created));
    assert.equal(env.readCounts.get(unrelated), before);
    env.contents.delete(created);
    await env.fileEvent('delete', created);
    assert.ok(!(await env.providers.references.provideReferences(doc, pos, { includeDeclaration: false }, {})).some(ref => ref.uri.fsPath === created));
});

test('index exclusions apply to initial indexing, creation and configuration changes', async t => {
    const excluded = `${root}/excluded/src/main/bl/base/Excluded.bl`;
    const created = excluded.replace('Excluded.bl', 'Created.bl');
    const env = await extension({ ...fixtures, [excluded]: 'public class Excluded {}' }, [], { configuration: { 'index.exclude': ['**/excluded/**'] } });
    t.after(() => env.dispose());
    assert.equal(env.readCounts.has(excluded), false);
    env.contents.set(created, 'public class Created {}');
    await env.fileEvent('create', created);
    const doc = document(owner, fixtures[owner]);
    await env.providers.definition.provideDefinition(doc, positionOf(doc, 'item.finish()', 'finish'), {});
    assert.equal(env.readCounts.has(created), false);
    env.configure({ 'index.exclude': [] });
    await env.providers.definition.provideDefinition(doc, positionOf(doc, 'item.finish()', 'finish'), {});
    assert.ok(env.readCounts.has(excluded));
    assert.ok(env.readCounts.has(created));
});

test('candidate filters update after edits and mask strings/comments', () => {
    const index = new BlIndex();
    index.updateFromText(owner, 'public class Owner {\n    Item item; // Ignored\n    string s = "Hidden";\n}');
    assert.ok(index.getReferenceCandidates('Item').has(owner));
    assert.equal(index.getReferenceCandidates('Ignored').size, 0);
    assert.equal(index.getReferenceCandidates('Hidden').size, 0);
    index.updateFromText(owner, 'public class Owner {}');
    assert.equal(index.getReferenceCandidates('Item').size, 0);
    index.removeFile(owner);
    assert.equal(index.wordFilters.size, 0);
});

test('compact candidate filters never discard indexed identifiers', () => {
    const index = new BlIndex();
    const words = Array.from({ length: 5000 }, (_, i) => `_VariableName${i}`);
    index.updateFromText(owner, 'public class Owner {\n' + words.map(word => `    public string ${word};`).join('\n') + '\n}');
    assert.equal(index.wordFilters.get(owner).byteLength, 1024);
    assert.ok(index.wordHashCache.size <= 1024);
    for (const word of words) assert.ok(index.getReferenceCandidates(word).has(owner), word);
});

test('references yield to the event loop and return no partial results on cancellation', async t => {
    const text = 'import base.Item;\npublic class Owner {\n    public Item item;\n    public void run() {\n' + '        item.finish();\n'.repeat(4000) + '    }\n}';
    const env = await extension({ ...fixtures, [owner]: text });
    t.after(() => env.dispose());
    const doc = document(item, fixtures[item]), pos = positionOf(doc, 'void finish()', 'finish');
    const token = { isCancellationRequested: false };
    const timer = new Promise(resolve => setImmediate(() => { token.isCancellationRequested = true; resolve(); }));
    const refs = await env.providers.references.provideReferences(doc, pos, { includeDeclaration: true }, token);
    await timer;
    assert.equal(token.isCancellationRequested, true);
    assert.equal(refs.length, 0);
});

test('code lens setting can be changed without disabling definition provider', async t => {
    const env = await extension(fixtures, [], { configuration: { 'codeLens.enabled': false } });
    t.after(() => env.dispose());
    const doc = document(owner, fixtures[owner]);
    assert.equal((await env.providers.codeLens.provideCodeLenses(doc, {})).length, 0);
    let refreshed = 0;
    env.providers.codeLens.onDidChangeCodeLenses(() => refreshed++);
    env.configure({ 'codeLens.enabled': true });
    assert.equal(refreshed, 1);
    assert.ok(await env.providers.definition.provideDefinition(doc, positionOf(doc, 'item.finish()', 'finish'), {}));
});

test('method calls do not resolve shadowing variables and inherit Object implicitly', async t => {
    const object = `${root}/z8/src/bl/org/zenframework/z8/lang/Object.bl`;
    const user = `${root}/z8/src/bl/org/zenframework/z8/base/security/User.bl`;
    const text = 'public class Owner {\n    public guid user;\n    public void run() {\n        string user = user().getLogin();\n        user().getId();\n        user().missing();\n    }\n}';
    const env = await extension({ [owner]: text,
        [object]: 'import org.zenframework.z8.base.security.User;\n[native "platform.Object"]\npublic class Object {\n    static public User user();\n}',
        [user]: 'public class User {\n    public string getLogin();\n    public guid getId();\n}' });
    t.after(() => env.dispose());
    const doc = document(owner, text);
    env.open(doc);
    const diagnostics = env.vscode.languages.getDiagnostics(doc.uri);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /missing/);
    const definition = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'user().getId()', 'getId'), {});
    assert.equal(definition[0].uri.fsPath, user);
    const methodDefinition = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'user().getId()', 'user'), {});
    assert.ok(Array.isArray(methodDefinition));
    assert.equal(methodDefinition[0].uri.fsPath, object);
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: positionOf(doc, 'user().getId()', 'getId') } };
    env.commands.get('bl.analyzeLine')();
    assert.ok(env.outputs.some(line => line.includes('getId() found=true')));
});

test('loop variables expire after the loop and locals do not leak between methods', async t => {
    const text = 'import base.Item;\nimport base.Other;\npublic class Owner {\n    public Item item;\n    public void first(Other parameter) {\n        for (Other item : {}) {\n            item.wrong();\n        }\n        item.finish();\n    }\n    public void second(Item parameter) {\n        parameter.finish();\n    }\n}';
    const env = await extension({ ...fixtures, [owner]: text });
    t.after(() => env.dispose());
    const doc = document(owner, text);
    for (const [line, word, expected] of [['item.wrong()', 'wrong', other], ['item.finish()', 'finish', item], ['parameter.finish()', 'finish', item]]) {
        const definition = await env.providers.definition.provideDefinition(doc, positionOf(doc, line, word), {});
        assert.equal(definition[0].uri.fsPath, expected);
    }
});

test('super in an inline class resolves the declared base, not the inline override', async t => {
    const text = 'import base.Item;\npublic class Owner {\n    public Item item = class {\n        public void finish() {\n            super.finish();\n            this.finish();\n        }\n    };\n}';
    const env = await extension({ ...fixtures, [owner]: text });
    t.after(() => env.dispose());
    const doc = document(owner, text);
    env.open(doc);
    assert.equal(env.vscode.languages.getDiagnostics(doc.uri).length, 0);
    const inherited = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'super.finish()', 'finish'), {});
    const overridden = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'this.finish()', 'finish'), {});
    assert.equal(inherited[0].uri.fsPath, item);
    assert.equal(overridden[0].uri.fsPath, owner);
});

test('diagnostics consider array and scalar return types of overloaded methods', async t => {
    const text = 'import base.Item;\npublic class Owner {\n    public Item make(Item[] values);\n    public Item[] make(Item value);\n    public Item make(string value);\n    public void run() {\n        make(Item[] {}).first();\n    }\n}';
    const env = await extension({ ...fixtures, [owner]: text });
    t.after(() => env.dispose());
    const doc = document(owner, text);
    env.open(doc);
    assert.equal(env.vscode.languages.getDiagnostics(doc.uri).length, 0);
});
