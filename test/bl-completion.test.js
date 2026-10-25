const assert = require('node:assert/strict');
const { test } = require('node:test');
const { document, extension } = require('./helpers');

const root = '/workspace/clm';
const source = `${root}/app/src/main/bl/app/Owner.bl`;
const itemFile = `${root}/base/src/main/bl/library/Item.bl`;
const baseFile = `${root}/base/src/main/bl/base/Base.bl`;
const otherFile = `${root}/base/src/main/bl/library/Other.bl`;
const fixtures = {
    [itemFile]: `public class Item {
    public Item child;
    public string name;
    private string secret;
    protected string protectedName;
    public static string staticName;
    public void finish() {}
    public static void staticFinish() {}
    public Item make() { return this; }
    public Item[] all() { return null; }
    public Item[string] entries() { return null; }
}`,
    [otherFile]: `public class Other {
    public string otherName;
    public void otherMethod() {}
}`,
    [baseFile]: `import library.Item;
public class Base {
    protected Item inheritedItem;
    private Item baseSecret;
    public static Item staticItem;
    public Item shared;
    public void inherited() {}
    public void calculate(int count) {}
    public void calculate(string text) {}
    public Item[] all() { return null; }
}`
};
const owner = body => `import library.Item;
import library.Other;
import base.Base;
public class Owner extends Base {
    private Item privateItem;
    protected Item protectedItem;
    public Item item;
    public Item[] items;
    public Item[string] entries;
    public Item[][] grid;
    public Item shared;
    public void own() {}
    public void calculate(int count) {}
    public void run(Item parameter) {
${body}
    }
}`;
const rows = list => Array.from(list.items || list);
const labels = list => rows(list).map(item => item.label);
const apply = (doc, item) => doc.getText().slice(0, doc.offsetAt(item.range.start)) + item.insertText
    + doc.getText().slice(doc.offsetAt(item.range.end));

async function setup(t, marked = owner('        item.|'), extra = {}, options = {}) {
    const offset = marked.indexOf('|');
    assert.ok(offset >= 0, 'fixture needs a caret marker');
    const doc = document(source, marked.replace('|', ''));
    const env = await extension({ ...fixtures, [source]: doc.getText(), ...extra }, [doc, ...(options.documents || [])],
        { workspaceFolders: [root], checkoutRoots: [root], configuration: { 'diagnostics.enabled': false }, ...options });
    t.after(() => env.dispose());
    return { env, doc, offset };
}
async function query(state, marked, token = {}) {
    let offset = state.offset;
    if (marked !== undefined) {
        offset = marked.indexOf('|');
        assert.ok(offset >= 0, 'query needs a caret marker');
        Object.assign(state.doc, document(source, marked.replace('|', '')));
        state.doc.isDirty = true;
        await state.env.change(state.doc);
    }
    return state.env.providers.completion.provideCompletionItems(state.doc, state.doc.positionAt(offset), token);
}
function includes(list, expected) {
    const found = labels(list);
    for (const value of expected) assert.ok(found.includes(value), `missing ${value}: ${found.join(', ')}`);
}
function excludes(list, expected) {
    const found = labels(list);
    for (const value of expected) assert.ok(!found.includes(value), `unexpected ${value}: ${found.join(', ')}`);
}

test('member completion exposes confirmed fields/methods with source details and plain replacement only', async t => {
    const state = await setup(t);
    const list = await query(state);
    includes(list, ['child', 'name', 'finish', 'make', 'all', 'entries']);
    excludes(list, ['secret', 'protectedName', 'own', 'inherited']);
    assert.equal(list.isIncomplete, false);
    for (const item of rows(list)) {
        assert.equal(typeof item.insertText, 'string');
        assert.equal(item.insertText, item.label);
        assert.equal(item.command, undefined);
        assert.equal(item.additionalTextEdits, undefined);
        assert.equal(item.commitCharacters, undefined);
        assert.equal(item.documentation.isTrusted, false);
        assert.match(item.detail, /library\.Item.*base\/src\/main\/bl\/library\/Item\.bl:\d+/);
        assert.equal(item.range.start.line, state.doc.positionAt(state.offset).line);
        assert.equal(item.range.start.character, item.range.end.character);
    }
    assert.equal(rows(list).find(item => item.label === 'finish').kind, state.env.vscode.CompletionItemKind.Method);
    assert.equal(rows(list).find(item => item.label === 'name').kind, state.env.vscode.CompletionItemKind.Field);
    assert.equal(state.env.appliedEdits.length, 0);
    assert.equal(state.env.commandCalls.length, 0);
});

test('prefix filtering replaces the entire current identifier without appending calls, edits or snippets', async t => {
    const state = await setup(t, owner('        item.fi|nish(); // untouched'));
    const list = await query(state);
    assert.deepEqual(labels(list), ['finish']);
    const item = rows(list)[0];
    assert.equal(state.doc.getText(item.range), 'finish');
    assert.equal(apply(state.doc, item), state.doc.getText());
    const mixed = await query(state, owner('        item.FI|'));
    assert.deepEqual(labels(mixed), ['finish']);
    assert.ok(apply(state.doc, rows(mixed)[0]).includes('item.finish\n'));
});

test('current and inherited members respect visibility and nearer field/method signature shadowing', async t => {
    const state = await setup(t, owner('        this.|'));
    const list = await query(state);
    includes(list, ['own', 'inherited', 'privateItem', 'protectedItem', 'inheritedItem', 'item', 'shared']);
    excludes(list, ['baseSecret']);
    const calculate = rows(list).filter(item => item.label === 'calculate');
    assert.equal(calculate.length, 1, 'one insertion row for the method, with both visible signatures');
    assert.match(calculate[0].detail, /int count.*\(\+1 перегрузок\).*app\.Owner/);
    const signatures = calculate[0].documentation.value.replace(/\\/g, '');
    assert.match(signatures, /int count/);
    assert.match(signatures, /string text/);
    assert.match(signatures, /base\/src\/main\/bl\/base\/Base\.bl/);
    assert.equal(rows(list).filter(item => item.label === 'shared').length, 1);
    assert.match(rows(list).find(item => item.label === 'shared').detail, /app\.Owner/);
    const parent = await query(state, owner('        super.|'));
    includes(parent, ['inherited', 'inheritedItem', 'calculate', 'all']);
    excludes(parent, ['own', 'privateItem', 'baseSecret']);
});

test('class receivers offer static members only while new Class receivers retain instance members', async t => {
    const state = await setup(t, owner('        Item.|'));
    const list = await query(state);
    assert.deepEqual(labels(list).sort(), ['staticFinish', 'staticName']);
    const qualified = await query(state, owner('        library.Item.|'));
    assert.deepEqual(labels(qualified).sort(), ['staticFinish', 'staticName']);
    const created = await query(state, owner('        new Item.|'));
    includes(created, ['child', 'name', 'finish']);
    excludes(created, ['secret', 'protectedName']);
});

test('static lexical method contexts exclude non-static implicit members and this/super/container', async t => {
    const staticOwner = body => `import library.Item;
public class Owner {
    public Item instance;
    public static Item shared;
    public void instanceMethod() {}
    public static void staticMethod() {}
    public static void run(Item parameter) {
${body}
    }
}`;
    const state = await setup(t, staticOwner('        |'));
    const list = await query(state);
    includes(list, ['parameter', 'shared', 'staticMethod']);
    excludes(list, ['instance', 'instanceMethod']);
    for (const receiver of ['this', 'super', 'container'])
        assert.equal(rows(await query(state, staticOwner(`        ${receiver}.|`))).length, 0, receiver);
    includes(await query(state, staticOwner('        parameter.|')), ['name', 'finish']);
});

test('enum and records values are static constants with distinct completion kinds', async t => {
    const enumFile = `${root}/base/src/main/bl/library/State.bl`;
    const records = `${root}/base/src/main/bl/library/Roles.bl`;
    const state = await setup(t, owner('        library.State.|'), {
        [enumFile]: 'public enum State {\n    Draft, Active\n}',
        [records]: `public class Roles {
    static final guid Fixed = '00629445-F77A-407C-9F4D-3E3B63D7DA2D';
    records {
        public Editor = '00629445-F77A-407C-9F4D-3E3B63D7DA2D';
    }
}`
    });
    let list = await query(state);
    assert.deepEqual(labels(list).sort(), ['Active', 'Draft']);
    assert.ok(rows(list).every(item => item.kind === state.env.vscode.CompletionItemKind.EnumMember));
    list = await query(state, owner('        library.Roles.|'));
    includes(list, ['Fixed', 'Editor']);
    assert.ok(rows(list).every(item => item.kind === state.env.vscode.CompletionItemKind.Constant));
});

test('general completion contains only visible locals and preserves nearest lexical shadowing', async t => {
    const state = await setup(t, owner(`        Other item;
        {
            Item parameter;
            |;
            Other future;
        }`));
    let list = await query(state);
    includes(list, ['item', 'parameter', 'own', 'inherited']);
    excludes(list, ['future']);
    assert.equal(rows(list).filter(item => item.label === 'item').length, 1);
    assert.equal(rows(list).find(item => item.label === 'item').kind, state.env.vscode.CompletionItemKind.Variable);
    assert.match(rows(list).find(item => item.label === 'item').detail, /Other item/);
    includes(await query(state, owner('        Other item;\n        item.|')), ['otherName', 'otherMethod']);
    list = await query(state, owner('        {\n            Other item;\n        }\n        item.|'));
    includes(list, ['name', 'finish']);
    excludes(list, ['otherName']);
});

test('for/catch locals disappear after their lifetimes and declarations from other methods do not leak', async t => {
    const state = await setup(t, owner('        for (Item entry : items) {\n            en|;\n        }'));
    includes(await query(state), ['entry', 'entries']);
    excludes(await query(state, owner('        for (Item entry : items) { }\n        en|;')), ['entry']);
    includes(await query(state, owner('        try { } catch (Other failure) {\n            fai|;\n        }')), ['failure']);
    excludes(await query(state, owner('        try { } catch (Other failure) { }\n        fai|;')), ['failure']);
    const marked = `import library.Item;
public class Owner {
    public void before(Item previous) { Item previousLocal; }
    public void current(Item current) {
        |
    }
}`;
    const list = await query(state, marked);
    includes(list, ['current']);
    excludes(list, ['previous', 'previousLocal']);
});

for (const receiver of ['parameter', 'item.child', 'item.make()', 'items[0]', 'entries["key"]',
    'grid[0][1]', 'all()[0]', 'item.all()[0]', 'item.entries()["key"]']) {
    test(`collection/type chain resolves confirmed element receiver: ${receiver}`, async t => {
        const state = await setup(t, owner(`        ${receiver}.|`));
        const list = await query(state);
        includes(list, ['name', 'child', 'finish']);
        excludes(list, ['secret', 'protectedName']);
    });
}

test('unindexed/partly indexed collections and over-indexed scalars do not invent element members', async t => {
    const state = await setup(t);
    for (const receiver of ['items', 'entries', 'grid[0]', 'item[0]', 'items[0][1]', 'all()'])
        assert.equal(rows(await query(state, owner(`        ${receiver}.|`))).length, 0, receiver);
});

test('unknown receiver/declared types and incomplete expressions never fall back to current class members', async t => {
    const state = await setup(t);
    for (const body of ['missing.|', 'Missing unknown;\n        unknown.|', 'item.missing().|', 'items[0.|',
        'item.make(.|', 'container.|'])
        assert.equal(rows(await query(state, owner(`        ${body}`))).length, 0, body);
});

test('overload return ambiguity stays unknown instead of selecting one unrelated return type', async t => {
    const state = await setup(t, `import library.Item;
import library.Other;
public class Owner {
    public Item ambiguous(int value) { return null; }
    public Other ambiguous(string value) { return null; }
    public void run() {
        ambiguous().|
    }
}`);
    assert.equal(rows(await query(state)).length, 0);
});

test('overload return uncertainty does not confirm one type while another possible declaration stays unknown', async t => {
    const state = await setup(t, `import library.Item;
public class Owner {
    public Item uncertain(int value) { return null; }
    public Missing uncertain(string value) { return null; }
    public void run() {
        uncertain().|
    }
}`);
    assert.equal(rows(await query(state)).length, 0, 'a lost unresolved overload cannot prove Item receiver');
});

test('ambiguous short class/dependency copies do not fabricate members or choose an arbitrary module', async t => {
    const one = `${root}/one/src/main/bl/one/Tie.bl`, two = `${root}/two/src/main/bl/two/Tie.bl`;
    const tied = `public class Owner {
    Tie candidate;
    public void run() {
        candidate.|
    }
}`;
    const state = await setup(t, tied, {
        [one]: 'public class Tie {\n    public string one;\n}',
        [two]: 'public class Tie {\n    public string two;\n}'
    });
    assert.equal(rows(await query(state)).length, 0);
    includes(await query(state, tied.replace('public class', 'import one.Tie;\npublic class')), ['one']);
    excludes(await query(state, tied.replace('public class', 'import one.Tie;\npublic class')), ['two']);
    const duplicate = `${root}/duplicate/src/main/bl/one/Tie.bl`;
    state.env.contents.set(duplicate, 'public class Tie {\n    public string duplicate;\n}');
    await state.env.fileEvent('create', duplicate);
    assert.equal(rows(await query(state, tied.replace('public class', 'import one.Tie;\npublic class'))).length, 0,
        'full-name dependency tie must not choose the first module');
});

test('checkout scope includes nested submodules but never borrows missing imports or base members from neighbours', async t => {
    const foreign = '/workspace/cloud', missing = `${foreign}/base/src/main/bl/foreign/Missing.bl`;
    const child = `${root}/nested/src/main/bl/library/Submodule.bl`;
    const marked = `import foreign.Missing;
public class Owner extends Missing {
    Missing missing;
    public void run() {
        missing.|
    }
}`;
    const state = await setup(t, marked, {
        [missing]: 'public class Missing {\n    public string foreignOnly;\n}',
        [child]: 'public class Submodule {\n    public static string localOnly;\n}'
    }, { workspaceFolders: ['/workspace'], checkoutRoots: [root, foreign, `${root}/nested`] });
    assert.equal(rows(await query(state)).length, 0);
    excludes(await query(state, marked.replace('missing.|', '|')), ['foreignOnly', 'foreign.Missing']);
    includes(await query(state, marked.replace('missing.|', 'library.Submodule.|')), ['localOnly']);
    const outside = document('/outside/app/src/main/bl/app/Owner.bl', owner('        item.'));
    assert.equal(rows(await state.env.providers.completion.provideCompletionItems(outside,
        outside.positionAt(outside.getText().indexOf('item.') + 5), {})).length, 0);
});

test('explicit imports take priority and an unresolved explicit import does not widen to matching short names', async t => {
    const conflicting = `${root}/other/src/main/bl/other/Item.bl`;
    const state = await setup(t, owner('        item.|'), { [conflicting]: 'public class Item {\n    public string wrong;\n}' });
    includes(await query(state), ['name']);
    excludes(await query(state), ['wrong']);
    assert.equal(rows(await query(state, owner('        item.|').replace('import library.Item;', 'import missing.Item;'))).length, 0);
});

test('unsaved dependency overlays and changed/closed buffers are reflected without disk writes', async t => {
    const dependency = document(itemFile, fixtures[itemFile].replace('    public string name;', '    public string unsaved;'));
    dependency.isDirty = true;
    const state = await setup(t, undefined, {}, { documents: [dependency] });
    includes(await query(state), ['unsaved']);
    excludes(await query(state), ['name']);
    Object.assign(dependency, document(itemFile, fixtures[itemFile].replace('    public string name;', '    public string newest;')));
    dependency.isDirty = true;
    await state.env.change(dependency);
    includes(await query(state), ['newest']);
    excludes(await query(state), ['name', 'unsaved']);
    state.env.close(dependency);
    includes(await query(state), ['name']);
    excludes(await query(state), ['newest']);
    assert.equal(state.env.contents.get(itemFile), fixtures[itemFile]);
    assert.equal(state.env.appliedEdits.length, 0);
});

test('excluded dependency buffers do not bypass configured BL discovery exclusions', async t => {
    const dependency = document(itemFile, fixtures[itemFile]);
    const state = await setup(t, undefined, {}, { documents: [dependency],
        configuration: { 'diagnostics.enabled': false, 'index.exclude': ['**/library/Item.bl'] } });
    assert.equal(rows(await query(state)).length, 0);
    Object.assign(dependency, document(itemFile, fixtures[itemFile].replace('public string name;', 'public string forbidden;')));
    await state.env.change(dependency);
    assert.equal(rows(await query(state)).length, 0);
});

test('new/import class completion supports full paths and uses qualified insertions for unavailable short names', async t => {
    const state = await setup(t, owner('        new I|'));
    let list = await query(state);
    includes(list, ['Item']);
    assert.equal(rows(list).find(item => item.label === 'Item').insertText, 'Item');
    list = await query(state, owner('        new library.I|'));
    assert.deepEqual(labels(list), ['library.Item']);
    assert.ok(apply(state.doc, rows(list)[0]).includes('new library.Item\n'));
    list = await query(state, 'import library.I|tem;\npublic class Owner {}');
    assert.deepEqual(labels(list), ['library.Item']);
    assert.equal(state.doc.getText(rows(list)[0].range), 'library.Item');
    assert.equal(apply(state.doc, rows(list)[0]), state.doc.getText());
    const foreign = `${root}/other/src/main/bl/other/Item.bl`;
    state.env.contents.set(foreign, 'public class Item {}');
    await state.env.fileEvent('create', foreign);
    list = await query(state, owner('        new I|'));
    includes(list, ['Item', 'other.Item']);
    assert.equal(rows(list).find(item => item.label === 'other.Item').insertText, 'other.Item');
    assert.equal(rows(list).find(item => item.label === 'other.Item').additionalTextEdits, undefined);
});

test('import completion works in a new unsaved BL source before declaring its class', async t => {
    const state = await setup(t, 'import library.I|');
    assert.deepEqual(labels(await query(state)), ['library.Item']);
});

test('same short-name class as a local does not change new class-first resolution', async t => {
    const state = await setup(t, owner('        Other Item;\n        new Item.|'));
    includes(await query(state), ['name', 'finish']);
    excludes(await query(state), ['otherName']);
    includes(await query(state, owner('        Other Item;\n        Item.|')), ['otherName']);
});

test('inline this/super/container preserve inline declarations, base imports and containing private access', async t => {
    const marked = `import library.Item;
import base.Base;
public class Owner {
    private Item outerPrivate;
    public void outerMethod() {}
    Base child = class {
        private Item local;
        public void inlineMethod() {}
        public void run() {
            this.|
        }
    };
}`;
    const state = await setup(t, marked);
    includes(await query(state), ['local', 'inlineMethod', 'inherited', 'inheritedItem']);
    excludes(await query(state), ['outerPrivate', 'outerMethod', 'baseSecret']);
    let list = await query(state, marked.replace('this.|', 'super.|'));
    includes(list, ['inherited', 'inheritedItem']);
    excludes(list, ['local', 'inlineMethod']);
    list = await query(state, marked.replace('this.|', 'container.|'));
    includes(list, ['outerPrivate', 'outerMethod', 'child']);
    excludes(list, ['inherited', 'inlineMethod']);
    includes(await query(state, marked.replace('this.|', 'this.local.|')), ['name', 'finish']);
});

test('nested container hops resolve each lexical parent and do not borrow outer locals', async t => {
    const marked = `import library.Item;
import base.Base;
public class Owner {
    private Item outer;
    Base first = class {
        private Item middle;
        Base second = class {
            public void run(Item innerParameter) {
                container.|
            }
        };
    };
}`;
    const state = await setup(t, marked);
    includes(await query(state), ['middle', 'second', 'inherited']);
    excludes(await query(state), ['outer', 'innerParameter']);
    const outerList = await query(state, marked.replace('container.|', 'container.container.|'));
    includes(outerList, ['outer', 'first']);
    excludes(outerList, ['middle', 'second']);
    assert.equal(rows(await query(state, marked.replace('container.|', 'container.container.container.|'))).length, 0);
});

for (const [label, body] of [['single trailing dot', '        item.\n            |'],
    ['single leading dot', '        item\n            .|'],
    ['nested trailing dots', '        item.\n            child.\n            |'],
    ['nested leading dots', '        item\n            .child\n            .|']]) {
    test(`member completion preserves multiline continuation: ${label}`, async t => {
        const state = await setup(t, owner(body));
        const list = await query(state);
        includes(list, ['name', 'finish']);
        excludes(list, ['own', 'inherited']);
    });
}

test('comment/ordinary string/attribute contexts are empty while closed lexical spans restore completion', async t => {
    const state = await setup(t);
    for (const body of ['        // item.|', '        /* item.| */', '        /* unfinished item.|',
        '        string normal = "item.|";', '        string normal = "|";', '        guid id = \'|\';',
        '        string normal = "item.|', '        // |', '        /*|']) {
        assert.equal(rows(await query(state, owner(body))).length, 0, body);
    }
    for (const marked of ['[na|me "title"] public class Owner {}', '[name "item.|" ] public class Owner {}'])
        assert.equal(rows(await query(state, marked)).length, 0, marked);
    for (const body of ['        /* closed */ item.|', '        string value = ""; item.|'])
        includes(await query(state, owner(body)), ['name', 'finish']);
});

test('native classes offer only source-declared members, never Java/compiler-only inventions', async t => {
    const native = `${root}/base/src/main/bl/library/Native.bl`;
    const state = await setup(t, owner('        library.Native.|'), { [native]: `[native "library.JavaNative"]
public class Native {
    public static void declared() {}
}`, [`${root}/base/src/main/java/library/JavaNative.java`]: 'class JavaNative { public static void invented() {} }' });
    assert.deepEqual(labels(await query(state)), ['declared']);
    assert.equal(state.env.readCounts.get(`${root}/base/src/main/java/library/JavaNative.java`), undefined);
});

test('completion source Markdown is untrusted, escaped and bounded even with unusual checkout/module paths', async t => {
    const untrusted = `${root}/[run](command:evil)/src/main/bl/library/Untrusted.bl`;
    const state = await setup(t, owner('        library.Untrusted.|'), { [untrusted]: `public class Untrusted {
    public static void method() {}
}` });
    const list = await query(state), row = rows(list)[0];
    assert.ok(row);
    assert.equal(row.documentation.isTrusted, false);
    assert.ok(row.documentation.value.includes('\\[run\\]'));
    assert.ok(row.documentation.value.length <= 4600);
    assert.ok(row.detail.length <= 900);
    assert.equal(row.command, undefined);
    assert.equal(row.additionalTextEdits, undefined);
});

test('CRLF/member replacement respects original source offsets and never consumes neighbouring text', async t => {
    const marked = owner('        item.na|me; // unchanged').replace(/\n/g, '\r\n');
    const state = await setup(t, marked);
    const list = await query(state), row = rows(list).find(item => item.label === 'name');
    assert.ok(row);
    assert.equal(state.doc.getText(row.range), 'name');
    assert.equal(apply(state.doc, row), state.doc.getText());
});

test('pre-cancelled, non-BL, non-file and closed documents publish no BL completions', async t => {
    const state = await setup(t);
    assert.equal(rows(await query(state, undefined, { isCancellationRequested: true })).length, 0);
    for (const changed of [{ languageId: 'javascript' }, { uri: { scheme: 'untitled', fsPath: source } }, { isClosed: true }]) {
        const doc = Object.assign(document(source, state.doc.getText()), changed);
        assert.equal(rows(await state.env.providers.completion.provideCompletionItems(doc, doc.positionAt(state.offset), {})).length, 0);
    }
});

test('cancel/dependency/document/config/folder/file/disposal changes during async work discard old results', async t => {
    for (const event of ['cancel', 'document', 'dependency', 'close', 'config', 'folders', 'file', 'dispose']) {
        const dependency = document(itemFile, fixtures[itemFile]);
        const state = await setup(t, undefined, {}, { documents: [dependency] });
        const token = { isCancellationRequested: false };
        const pending = query(state, undefined, token);
        let changed;
        if (event === 'cancel') token.isCancellationRequested = true;
        if (event === 'document') { Object.assign(state.doc, document(source, owner('        this.'))); changed = state.env.change(state.doc); }
        if (event === 'dependency') { Object.assign(dependency, document(itemFile, fixtures[itemFile] + '\n')); changed = state.env.change(dependency); }
        if (event === 'close') state.env.close(state.doc);
        if (event === 'config') changed = state.env.configure({ 'index.exclude': ['**/library/**'] });
        if (event === 'folders') state.env.foldersChanged();
        if (event === 'file') changed = state.env.fileEvent('delete', itemFile);
        if (event === 'dispose') state.env.dispose();
        assert.equal(rows(await pending).length, 0, event);
        if (changed) await changed;
    }
});

test('publication yield rejects results after completion computation when cancelled or edited', async t => {
    for (const event of ['cancel', 'document', 'dependency', 'folders', 'dispose']) {
        const dependency = document(itemFile, fixtures[itemFile]);
        const state = await setup(t, undefined, {}, { documents: [dependency] });
        const token = { isCancellationRequested: false };
        const pending = query(state, undefined, token);
        await new Promise(resolve => setImmediate(resolve));
        if (event === 'cancel') token.isCancellationRequested = true;
        if (event === 'document') Object.assign(state.doc, document(source, owner('        this.')));
        if (event === 'dependency') Object.assign(dependency, document(itemFile, fixtures[itemFile] + '\n'));
        if (event === 'folders') state.env.foldersChanged();
        if (event === 'dispose') state.env.dispose();
        assert.equal(rows(await pending).length, 0, event);
    }
});

test('large completion lists are bounded and narrow prefixes return complete lists', async t => {
    const many = `${root}/base/src/main/bl/library/Many.bl`;
    const state = await setup(t, owner('        library.Many.|'), { [many]: `public class Many {\n${Array.from({ length: 250 }, (_, i) =>
        '    public static string value' + String(i).padStart(3, '0') + ';').join('\n')}\n}` });
    let list = await query(state);
    assert.equal(rows(list).length, 200);
    assert.equal(list.isIncomplete, true);
    list = await query(state, owner('        library.Many.value24|'));
    assert.equal(rows(list).length, 10);
    assert.equal(list.isIncomplete, false);
    assert.ok(rows(list).every(item => item.label.startsWith('value24')));
});

test('one routed BL provider preserves localization key completion and independent JS request completion', async t => {
    const nls = `${root}/app/src/main/nls/app_ru.nls`;
    const request = `${root}/app/src/main/bl/app/Request.bl`;
    const clientFile = `${root}/app/src/main/js/client.js`;
    const generated = `${root}/app/target/client.js`;
    const state = await setup(t, owner('        string title = "$Workspace.t|$";'), {
        [nls]: '<properties><entry key="Workspace.title">Название</entry></properties>',
        [request]: '[request true]\npublic class Request {\n    public void processContentRequest() {}\n}',
        [clientFile]: "HttpRequest.send({request: 'app.Request', action: 'content'});",
        [generated]: "HttpRequest.send({request: 'app.Request', action: 'content'});"
    });
    const registrations = state.env.providerRegistrations.filter(reg => reg.selector.language === 'bl');
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].selector.scheme, 'file');
    let list = await query(state);
    assert.deepEqual(labels(list), ['Workspace.title']);
    assert.equal(rows(list)[0].insertText, 'Workspace.title$');
    list = await query(state, owner('        item.na|'));
    assert.deepEqual(labels(list), ['name']);
    const client = document(clientFile, "HttpRequest.send({request: 'app.R', action: 'content'});");
    const jsList = await state.env.providers.jsCompletion.provideCompletionItems(client,
        client.positionAt(client.getText().indexOf('app.R') + 5), {});
    includes(jsList, ['app.Request']);
    const generatedDoc = document(generated, client.getText());
    assert.equal(rows(await state.env.providers.jsCompletion.provideCompletionItems(generatedDoc,
        generatedDoc.positionAt(generatedDoc.getText().indexOf('app.R') + 5), {})).length, 0);
    assert.equal(state.env.providers.jsDefinition, undefined);
});

test('ambiguous bases remain unknown in this/super/general completion without hiding own members', async t => {
    const extra = {
        [`${root}/one/src/main/bl/one/Tie.bl`]: 'public class Tie {\n    public string fromOne;\n}',
        [`${root}/two/src/main/bl/two/Tie.bl`]: 'public class Tie {\n    public string fromTwo;\n}'
    };
    const marked = `public class Owner extends Tie {
    public string ownField;
    public void run() {
        this.|
    }
}`;
    const state = await setup(t, marked, extra);
    includes(await query(state), ['ownField', 'run']);
    excludes(await query(state), ['fromOne', 'fromTwo']);
    assert.equal(rows(await query(state, marked.replace('this.|', 'super.|'))).length, 0);
    excludes(await query(state, marked.replace('this.|', '|')), ['fromOne', 'fromTwo']);
});

test('tied full-name copies are not erased to prove a different short type or inherited base', async t => {
    for (const namespace of ['one', 'app']) {
        const extra = {
            [`${root}/one/src/main/bl/${namespace}/Tie.bl`]: 'public class Tie {\n    public string one;\n}',
            [`${root}/copy/src/main/bl/${namespace}/Tie.bl`]: 'public class Tie {\n    public string copied;\n}',
            [`${root}/two/src/main/bl/two/Tie.bl`]: 'public class Tie {\n    public string wrongTwo;\n}'
        };
        const marked = `public class Owner extends Tie {
    public Tie candidate;
    public void run() {
        candidate.|
    }
}`;
        const state = await setup(t, marked, extra);
        assert.equal(rows(await query(state)).length, 0, namespace);
        assert.equal(rows(await query(state, marked.replace('candidate.|', 'super.|'))).length, 0, namespace);
        excludes(await query(state, marked.replace('candidate.|', 'this.|')), ['one', 'copied', 'wrongTwo']);
    }
});

test('inherited overloads with unknown or differing return types cannot prove a surviving result type', async t => {
    const base = `import library.Item;
public class Base {
    public Missing factory(string text) { return null; }
}`;
    const marked = `import library.Item;
import base.Base;
public class Owner extends Base {
    public Item factory(int count) { return null; }
    public void run() {
        factory().|
    }
}`;
    const state = await setup(t, marked, { [baseFile]: base });
    assert.equal(rows(await query(state)).length, 0);
    const list = await query(state, marked.replace('factory().|', 'this.fac|'));
    const row = rows(list).find(item => item.label === 'factory');
    assert.ok(row); assert.match(row.detail, /перегрузок/);
    assert.match(row.documentation.value, /Missing factory/);
});

test('unresolved inline base never turns this/super into the outer class', async t => {
    const marked = `public class Owner {
    public string outer;
    public Missing action = class {
        public string inner;
        public void run() {
            this.|
        }
    };
}`;
    const state = await setup(t, marked);
    includes(await query(state), ['inner', 'run']);
    excludes(await query(state), ['outer', 'action']);
    assert.equal(rows(await query(state, marked.replace('this.|', 'super.|'))).length, 0);
    includes(await query(state, marked.replace('this.|', 'container.|')), ['outer', 'action']);
});

test('qualified new/import insertion replaces the entire remaining path without duplicate suffix', async t => {
    for (const marked of ['import library.It|em.child;\npublic class Owner {}',
        owner('        new library.It|em.child;')]) {
        const state = await setup(t, marked);
        const row = rows(await query(state)).find(item => item.label === 'library.Item');
        assert.ok(row, marked); assert.equal(state.doc.getText(row.range), 'library.Item.child');
        assert.ok(apply(state.doc, row).includes('library.Item;'));
        assert.ok(!apply(state.doc, row).includes('Item.child'));
    }
});

test('scoped symbol excludes apply to the active buffer too without disabling existing BL navigation', async t => {
    const state = await setup(t, owner('        item.na|me;'), {},
        { configuration: { 'diagnostics.enabled': false, 'index.exclude': ['**/app/Owner.bl'] } });
    assert.equal(rows(await query(state)).length, 0);
    const definitions = await state.env.providers.definition.provideDefinition(state.doc, state.doc.positionAt(state.offset - 1), {});
    assert.ok(definitions.some(location => location.uri.fsPath === itemFile));
});

test('inline context follows caret columns before and after closing braces on the same line', async t => {
    const marked = `import library.Item;
public class Owner {
    private Item outer;
    Item inlineAction = class {
        public Item local;
        public void run() {
            this.| } }; this.;
}`;
    const state = await setup(t, marked);
    includes(await query(state), ['local', 'run', 'finish', 'name']);
    excludes(await query(state), ['outer', 'inlineAction']);
    const outside = marked.replace('this.| } }; this.;', 'this. } }; this.|;');
    const after = await query(state, outside);
    includes(after, ['outer', 'inlineAction']);
    excludes(after, ['local', 'name', 'finish']);
});
