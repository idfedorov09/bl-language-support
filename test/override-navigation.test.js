const assert = require('node:assert/strict');
const { test } = require('node:test');
const { document, positionOf, extension } = require('./helpers');
const { BlIndex, parseBlContent } = require('../blIndex');
const root = '/workspace/clm';
const child = `${root}/gpt/src/main/bl/app/MessageAction.bl`;
const parent = `${root}/z8/src/bl/org/zenframework/z8/lang/Object.bl`;
const parentText = `public class Object {
    virtual protected JsonArray getData(string[string] parameters);
}`;
const childText = `public class MessageAction extends Object {
    virtual protected JsonArray getData(string[string] parameters) { return null; }
}`;
const list = value => Array.isArray(value) ? value : value ? [value] : [];
async function setup(t, extra = {}, open = []) {
    const env = await extension({ [parent]: parentText, [child]: childText, ...extra }, open, { workspaceFolders: [root], configuration: { 'diagnostics.enabled': false } });
    t.after(() => env.dispose()); return env;
}
async function definition(env, doc, line, word = 'getData') {
    return list(await env.providers.definition.provideDefinition(doc, positionOf(doc, line, word), {}));
}

test('getData virtual override goes to Object declaration, not itself or generated Java', async t => {
    const env = await setup(t); const doc = document(child, childText);
    const result = await definition(env, doc, 'virtual protected');
    assert.equal(result.length, 1); assert.equal(result[0].uri.fsPath, parent);
    assert.equal(result[0].range.start.line, 1);
    assert.equal(document(parent, parentText).getText(result[0].range), 'getData');
    const refs = await env.providers.references.provideReferences(doc, positionOf(doc, 'virtual protected', 'getData'), { includeDeclaration: false }, {});
    assert.equal(refs.length, 0, 'the parent contract is not a usage of the child');
    const included = await env.providers.references.provideReferences(doc, positionOf(doc, 'virtual protected', 'getData'), { includeDeclaration: true }, {});
    assert.equal(included.length, 1); assert.equal(included[0].uri.fsPath, child);
});

test('direct calls still resolve to the override and references keep child/base identities separate', async t => {
    const user = `${root}/gpt/src/main/bl/app/Consumer.bl`;
    const use = `public class Consumer {
    public void run(MessageAction child, Object parent) {
        child.getData(null);
        parent.getData(null);
    }
}`;
    const env = await setup(t, { [user]: use }); const doc = document(user, use);
    assert.equal((await definition(env, doc, 'child.getData'))[0].uri.fsPath, child);
    assert.equal((await definition(env, doc, 'parent.getData'))[0].uri.fsPath, parent);
    for (const [file, text, expected] of [[child, childText, 2], [parent, parentText, 3]]) {
        const declaration = document(file, text);
        const refs = await env.providers.references.provideReferences(declaration, positionOf(declaration, 'virtual protected', 'getData'), { includeDeclaration: false }, {});
        assert.equal(refs.length, 1); assert.equal(refs[0].uri.fsPath, user); assert.equal(refs[0].range.start.line, expected);
    }
});

test('override parameters select the matching base declaration, ignoring names and whitespace', async t => {
    const baseText = `public class Object {
    virtual protected JsonArray getData(string payload);
    virtual protected JsonArray getData(\n        string [ string ] renamed\n    );
}`;
    const env = await setup(t, { [parent]: baseText });
    const result = await definition(env, document(child, childText), 'virtual protected');
    assert.equal(result.length, 1); assert.equal(result[0].range.start.line, 2);
    assert.equal(document(parent, baseText).getText(result[0].range), 'getData');
});

test('unmatched signatures, non-virtual/static helpers and non-inheritable parents stay at their own declaration', async t => {
    for (const [baseModifiers, childModifiers, parameters] of [
        ['virtual protected', 'virtual protected', 'int value'],
        ['virtual protected', 'private', 'string[string] parameters'],
        ['virtual protected', 'static public', 'string[string] parameters'],
        ['private virtual', 'virtual protected', 'string[string] parameters'],
        ['final virtual protected', 'virtual protected', 'string[string] parameters'],
        ['protected', 'virtual protected', 'string[string] parameters']
    ]) {
        const text = `public class MessageAction extends Object {\n    ${childModifiers} JsonArray getData(${parameters}) { return null; }\n}`;
        const env = await setup(t, { [parent]: parentText.replace('virtual protected', baseModifiers), [child]: text });
        assert.equal((await definition(env, document(child, text), 'JsonArray getData'))[0].uri.fsPath, child);
    }
});

test('an inline override navigates to its declared base, not the parent of that base', async t => {
    const text = `public class MessageAction {
    public Object action = class {
        virtual protected JsonArray getData(string[string] parameters) { return null; }
    };
}`;
    const env = await setup(t, { [child]: text });
    assert.equal((await definition(env, document(child, text), 'virtual protected'))[0].uri.fsPath, parent);
});

test('inline signature types resolve against the source imports, not the base imports', async t => {
    const library = `${root}/core/src/main/bl/library/Payload.bl`;
    const local = `${root}/gpt/src/main/bl/local/Payload.bl`;
    const baseText = `import library.Payload;\npublic class Object {\n    virtual protected void accept(Payload value);\n}`;
    for (const scope of ['local', 'library']) {
        const text = `import ${scope}.Payload;
public class MessageAction {
    public Object action = class {
        virtual protected void accept(Payload value) {}
    };
}`;
        const env = await setup(t, { [parent]: baseText, [child]: text, [library]: 'public class Payload {}', [local]: 'public class Payload {}' });
        const result = await definition(env, document(child, text), 'virtual protected', 'accept');
        assert.equal(result[0].uri.fsPath, scope === 'library' ? parent : child);
    }
});

test('base target updates from an unsaved buffer and disappears if its matching signature changes', async t => {
    const dirty = document(parent, parentText);
    const env = await setup(t, {}, [dirty]); const doc = document(child, childText);
    Object.assign(dirty, document(parent, '\n' + parentText)); dirty.isDirty = true; env.change(dirty);
    assert.equal((await definition(env, doc, 'virtual protected'))[0].range.start.line, 2);
    Object.assign(dirty, document(parent, parentText.replace('string[string]', 'int'))); env.change(dirty);
    assert.equal((await definition(env, doc, 'virtual protected'))[0].uri.fsPath, child);
});

test('nearest matching ancestor wins, implicit Object is supported, and cyclic bases terminate', () => {
    const index = new BlIndex(); index.updateFromText(parent, parentText);
    const middle = `${root}/gpt/src/main/bl/app/Middle.bl`;
    index.updateFromText(middle, 'public class Middle extends Object {\n    virtual protected JsonArray getData(int payload);\n}');
    const info = index.updateFromText(child, childText.replace('extends Object', 'extends Middle'));
    assert.equal(index.findOverriddenMethod(info, info.methods.get('getData')).owner.filePath, parent);
    const implicit = index.updateFromText(child, childText.replace(' extends Object', ''));
    assert.equal(index.findOverriddenMethod(implicit, implicit.methods.get('getData')).owner.filePath, parent);
    index.updateFromText(middle, 'public class Middle extends MessageAction {}');
    const cycle = index.updateFromText(child, childText.replace('extends Object', 'extends Middle'));
    assert.equal(index.findOverriddenMethod(cycle, cycle.methods.get('getData')), null);
});

test('method signature metadata keeps source positions and treats incomplete signatures as unknown', () => {
    const text = 'public class MessageAction {\r\n    [name "Data"] virtual [request true] protected JsonArray getData(\r\n        string [ string ] renamed\r\n    ) {}\r\n}';
    const info = parseBlContent(child, text); const method = info.methods.get('getData');
    assert.deepEqual(method.modifiers, ['virtual', 'protected']); assert.deepEqual(method.parameterTypes, ['string[string]']);
    assert.equal(method.column, text.split('\r\n')[1].indexOf('getData')); assert.equal(method.line, 1);
    const incomplete = parseBlContent(child, 'public class MessageAction {\n    virtual protected JsonArray getData(string');
    assert.equal(incomplete.methods.get('getData').parameterTypes, null);
});
