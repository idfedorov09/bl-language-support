const assert = require('node:assert/strict');
const { test } = require('node:test');
const { document, positionOf, extension } = require('./helpers');

const root = '/workspace/clm';
const source = `${root}/app/src/main/bl/app/Owner.bl`;
const base = `${root}/base/src/main/bl/base/Owner.bl`;
const item = `${root}/base/src/main/bl/base/Item.bl`;
const other = `${root}/base/src/main/bl/base/Other.bl`;
const fixtures = {
    [base]: `public class Owner {
    public Item item;
    public Item[] items;
    public Item make() { return item; }
    public Item[] all() { return items; }
    public void finish() {}
}`,
    [item]: `public class Item {
    public Item child;
    public string name;
    public Item make() { return this; }
    public void finish() {}
}`,
    [other]: `public class Other {
    public static Item make() { return null; }
    public static void finish() {}
}`,
    [source]: `import base.Item;
import base.Other;
public class Owner extends base.Owner {
    [name "item"] public Item item;
    public void finish() {}
    public void run(Item parameter) {
        Item local = new Item;
        super.finish();
        Other.finish();
        item.child.finish();
        item.child.name;
        make().finish();
        items[0].finish();
        all()[0].finish();
        parameter.finish();
        local.finish();
        base.Other.finish();
        item.make(Other.make()).finish();
        new Other.finish();
        return make();
        item.
            child.
            finish();
        item
            .child
            .finish();
        // Other.finish();
        string text = "Other.finish()";
    }
}`
};

async function definition(text, word, occurrence = 0) {
    const env = await extension(fixtures);
    const doc = document(source, fixtures[source]);
    const result = await env.providers.definition.provideDefinition(doc, positionOf(doc, text, word, occurrence), {});
    return Array.isArray(result) ? result : result ? [result] : [];
}

function target(file, name) {
    const doc = document(file, fixtures[file]);
    const line = fixtures[file].split('\n').findIndex(line => line.includes(` ${name};`) || line.includes(` ${name}(`) || line.includes(`class ${name}`));
    return { file, line };
}

for (const [label, text, word, expected, occurrence] of [
    ['imported class', 'import base.Item;', 'Item', target(item, 'Item')],
    ['base class sharing the declaration name', 'class Owner extends base.Owner', 'Owner', target(base, 'Owner'), 1],
    ['super method', 'super.finish()', 'finish', target(base, 'finish')],
    ['static void method', 'Other.finish()', 'finish', target(other, 'finish')],
    ['middle field', 'item.child.finish()', 'child', target(item, 'child')],
    ['nested void method', 'item.child.finish()', 'finish', target(item, 'finish')],
    ['last field', 'item.child.name', 'name', target(item, 'name')],
    ['first receiver field', 'item.child.finish()', 'item', { file: source, line: 3 }],
    ['method result', 'make().finish()', 'finish', target(item, 'finish')],
    ['indexed array', 'items[0].finish()', 'finish', target(item, 'finish')],
    ['indexed method result', 'all()[0].finish()', 'finish', target(item, 'finish')],
    ['parameter receiver', 'parameter.finish()', 'finish', target(item, 'finish')],
    ['local receiver', 'local.finish()', 'finish', target(item, 'finish')],
    ['qualified receiver', 'base.Other.finish()', 'finish', target(other, 'finish')],
    ['nested call argument', 'item.make(Other.make()).finish()', 'make', target(other, 'make'), 1],
    ['new receiver', 'new Other.finish()', 'finish', target(other, 'finish')],
    ['returned method call', 'return make()', 'make', target(base, 'make')]
]) {
    test(`definition: ${label}`, async () => {
        const locations = await definition(text, word, occurrence || 0);
        assert.equal(locations.length, 1, label);
        assert.equal(locations[0].uri.fsPath, expected.file, label);
        assert.equal(locations[0].range.start.line, expected.line, label);
    });
}

test('declaration does not return all same-named calls as definitions', async () => {
    const locations = await definition('public void finish()', 'finish');
    assert.equal(locations.length, 1);
    assert.equal(locations[0].uri.fsPath, source);
    assert.equal(locations[0].range.start.line, 4);
});

test('attributes retain cursor columns', async () => {
    const locations = await definition('[name "item"] public Item item;', 'item', 1);
    const expected = fixtures[source].split('\n')[3].lastIndexOf('item');
    assert.equal(locations.length, 1);
    assert.equal(locations[0].range.start.character, expected);
});

for (const [text, word] of [['// Other.finish()', 'finish'], ['"Other.finish()"', 'finish']]) {
    test(`ignore comment/string: ${text}`, async () => assert.deepEqual(await definition(text, word), []));
}

test('multiline chains with trailing dots', async () => {
    const env = await extension(fixtures);
    const doc = document(source, fixtures[source]);
    const pos = positionOf(doc, '            finish();', 'finish');
    const result = await env.providers.definition.provideDefinition(doc, pos, {});
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    assert.equal(locations.length, 1);
    assert.equal(locations[0].uri.fsPath, item);
});

test('multiline chains with leading dots', async () => {
    const locations = await definition('            .finish();', 'finish');
    assert.equal(locations.length, 1);
    assert.equal(locations[0].uri.fsPath, item);
});

test('unknown qualified receivers cannot resolve to a same-named current method', async () => {
    const content = fixtures[source].replace('        Other.finish();', '        missing.finish();');
    const env = await extension({ ...fixtures, [source]: content });
    const doc = document(source, content);
    assert.equal(await env.providers.definition.provideDefinition(doc, positionOf(doc, 'missing.finish()', 'finish'), {}), null);
});

test('method references distinguish same-named methods in different classes', async () => {
    const env = await extension(fixtures);
    const doc = document(other, fixtures[other]);
    const refs = await env.providers.references.provideReferences(doc, positionOf(doc, 'public static void finish()', 'finish'), { includeDeclaration: false }, {});
    const lines = refs.filter(ref => ref.uri.fsPath === source).map(ref => ref.range.start.line);
    const expected = fixtures[source].split('\n').flatMap((line, i) => /^\s*(?:new )?(?:base\.)?Other\.finish\(\);$/.test(line) ? [i] : []);
    assert.deepEqual(Array.from(lines), expected);
    assert.ok(!refs.some(ref => ref.uri.fsPath === item || ref.uri.fsPath === base));
});

test('an unsaved dependency is indexed when the extension activates', async () => {
    const unsaved = document(item, fixtures[item].replace('    public void finish() {}', '    public void finish() {}\n    public void pending() {}'));
    const content = fixtures[source].replace('        item.child.finish();', '        item.pending();');
    const env = await extension({ ...fixtures, [source]: content }, [unsaved]);
    const doc = document(source, content);
    const result = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'item.pending()', 'pending'), {});
    assert.equal(result[0].uri.fsPath, item);
    assert.equal(result[0].range.start.line, 5);
});

test('overloaded method navigation keeps all declarations', async () => {
    const content = fixtures[other].replace('    public static void finish() {}', '    public static void finish() {}\n    public static void finish(Item value) {}');
    const env = await extension({ ...fixtures, [other]: content });
    const doc = document(source, fixtures[source]);
    const locations = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'Other.finish()', 'finish'), {});
    assert.deepEqual(Array.from(locations, location => location.range.start.line), [2, 3]);
    assert.ok(locations.every(location => location.uri.fsPath === other));
});

test('closed block locals cannot shadow fields outside their scope', async () => {
    const content = fixtures[source].replace('        item.child.finish();', '        if (true) {\n            Other item = new Other;\n        }\n        item.child.finish();');
    const env = await extension({ ...fixtures, [source]: content });
    const doc = document(source, content);
    const locations = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'item.child.finish()', 'child'), {});
    assert.equal(locations[0].uri.fsPath, item);
});

test('multiline parameter definitions keep their actual line', async () => {
    const content = fixtures[source].replace('public void run(Item parameter) {', 'public void run(\n        Item parameter\n    ) {');
    const env = await extension({ ...fixtures, [source]: content });
    const doc = document(source, content);
    const location = await env.providers.definition.provideDefinition(doc, positionOf(doc, 'parameter.finish()', 'parameter'), {});
    assert.equal(location.uri.fsPath, source);
    assert.equal(location.range.start.line, 6);
    assert.equal(location.range.start.character, '        Item '.length);
});

test('native Java navigation picks the callers checkout', async () => {
    const javaFile = `${root}/base/src/main/java/native/Owner.java`;
    const content = '[native "native.Owner"]\npublic class Owner {}';
    const env = await extension({
        ...fixtures,
        [source]: content,
        [javaFile.replace('/clm/', '/cloud/')]: 'public class Owner {}',
        [javaFile]: 'public class Owner {}'
    });
    const doc = document(source, content);
    const location = await env.providers.definition.provideDefinition(doc, positionOf(doc, '[native "native.Owner"]', 'Owner'), {});
    assert.equal(location.uri.fsPath, javaFile);
});

test('debug analysis and diagnostics are callable', async () => {
    const env = await extension(fixtures);
    const doc = document(source, fixtures[source]);
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: positionOf(doc, 'Other.finish()', 'finish') } };
    env.commands.get('bl.analyzeLine')();
    assert.ok(env.outputs.some(line => line.includes('finish() found=true')));
    env.commands.get('bl.dumpDiagnostics')();
    assert.ok(env.outputs.includes('BL Diagnostics Dump'));
});

test('references ignore comments/strings and respect includeDeclaration', async () => {
    const env = await extension(fixtures);
    const doc = document(other, fixtures[other]);
    const refs = await env.providers.references.provideReferences(doc, positionOf(doc, 'class Other', 'Other'), { includeDeclaration: false }, {});
    const ignoredLines = fixtures[source].split('\n').map((line, i) => /\/\/|string text/.test(line) ? i : -1);
    assert.ok(refs.length > 0);
    assert.ok(!refs.some(ref => ref.uri.fsPath === other && ref.range.start.line === 0));
    assert.ok(!refs.some(ref => ref.uri.fsPath === source && ignoredLines.includes(ref.range.start.line)));
});

test('references read unsaved buffers', async () => {
    const unsaved = document(source, fixtures[source].replace('        Other.finish();', '        Item.make();'));
    const env = await extension(fixtures, [unsaved]);
    const doc = document(other, fixtures[other]);
    const refs = await env.providers.references.provideReferences(doc, positionOf(doc, 'class Other', 'Other'), { includeDeclaration: true }, {});
    assert.ok(!refs.some(ref => ref.uri.fsPath === source && ref.range.start.line === 8));
});
