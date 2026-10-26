const assert = require('node:assert/strict');
const { test } = require('node:test');
const { document, positionOf, extension } = require('./helpers');

const root = '/workspace/clm';
const file = `${root}/gpt/src/main/bl/pro/doczilla/gpt/messages/action/MessageAction.bl`;
const name = 'validateNativeCompaction';
const content = [
    'public class MessageAction {',
    '\tpublic void saveCompaction(string kind, string payload) {',
    ...Array(297).fill(''),
    `\t\t${name}(kind, payload);`, // one-based line 300
    '\t}',
    ...Array(24).fill(''),
    `\tprivate void ${name}(string kind, string payload) {`, // line 326
    '\t}',
    '}'
].join('\r\n');
const locations = result => Array.isArray(result) ? result : result ? [result] : [];
function assertSymbolRange(doc, location, symbol) {
    assert.equal(location.uri.fsPath, doc.uri.fsPath);
    assert.equal(location.range.start.line, location.range.end.line);
    assert.equal(doc.getText(location.range), symbol, 'location must span the entire identifier, not a zero-length point');
}

test('MessageAction declaration range contains every click position and references still resolve to the call', async t => {
    const doc = document(file, content);
    const env = await extension({ [file]: content }, [doc], { workspaceFolders: [root], configuration: { 'diagnostics.enabled': false } });
    t.after(() => env.dispose());
    const line = 325, column = doc.lineAt(line).text.indexOf(name);
    for (let offset = 0; offset < name.length; offset++) {
        const position = new env.vscode.Position(line, column + offset);
        const result = locations(await env.providers.definition.provideDefinition(doc, position, {}));
        assert.equal(result.length, 1);
        assertSymbolRange(doc, result[0], name);
        // VS Code detects "definition is here" by containment before invoking
        // its configured alternative command. Do not return usages as definitions.
        assert.ok(result[0].range.start.character <= position.character && position.character <= result[0].range.end.character);
        assert.equal(result[0].range.start.line, 325);
    }
    const position = new env.vscode.Position(line, column + 10);
    const references = await env.providers.references.provideReferences(doc, position, { includeDeclaration: false }, {});
    assert.deepEqual(Array.from(references, r => r.range.start.line), [299]);
    assertSymbolRange(doc, references[0], name);
    const included = await env.providers.references.provideReferences(doc, position, { includeDeclaration: true }, {});
    assert.deepEqual(Array.from(included, r => r.range.start.line), [299, 325]);
    included.forEach(ref => assertSymbolRange(doc, ref, name));
});

test('MessageAction call still leads to the declaration on line 326, not another usage', async t => {
    const doc = document(file, content);
    const env = await extension({ [file]: content }, [doc]); t.after(() => env.dispose());
    const position = positionOf(doc, `${name}(kind, payload);`, name);
    const result = locations(await env.providers.definition.provideDefinition(doc, position, {}));
    assert.equal(result.length, 1);
    assert.equal(result[0].range.start.line, 325);
    assertSymbolRange(doc, result[0], name);
});

test('class, attributed field, method, parameter and local definitions retain full source ranges', async t => {
    const text = [
        'public class MessageAction {',
        '\t[name "field"] public string field;',
        '\tpublic void run(string parameter) {',
        '\t\tstring local = parameter;',
        '\t\tfield = local;',
        '\t}',
        '}'
    ].join('\r\n');
    const doc = document(file, text);
    const env = await extension({ [file]: text }, [doc]); t.after(() => env.dispose());
    for (const [lineText, word] of [
        ['class MessageAction', 'MessageAction'], ['public string field', 'field'],
        ['public void run', 'run'], ['local = parameter', 'parameter'], ['field = local', 'local'], ['field = local', 'field']
    ]) {
        const result = locations(await env.providers.definition.provideDefinition(doc, positionOf(doc, lineText, word, lineText === 'public string field' ? 1 : 0), {}));
        assert.equal(result.length, 1, word); assertSymbolRange(doc, result[0], word);
    }
});

test('overloaded target methods keep distinct declarations with full ranges', async t => {
    const text = `public class MessageAction {
    public void run() { validateNativeCompaction(); }
    private void validateNativeCompaction() {}
    private void validateNativeCompaction(string payload) {}
}`;
    const doc = document(file, text);
    const env = await extension({ [file]: text }); t.after(() => env.dispose());
    const result = locations(await env.providers.definition.provideDefinition(doc, positionOf(doc, 'public void run()', name), {}));
    assert.deepEqual(Array.from(result, location => location.range.start.line), [2, 3]);
    result.forEach(location => assertSymbolRange(doc, location, name));
});

test('inline class method calls and declarations keep their own full identifier range', async t => {
    const base = `${root}/gpt/src/main/bl/pro/doczilla/gpt/messages/action/Base.bl`;
    const text = `public class MessageAction {
    public Base action = class {
        private void validateNativeCompaction() {}
        public void run() { validateNativeCompaction(); }
    };
}`;
    const doc = document(file, text);
    const env = await extension({ [file]: text, [base]: 'public class Base {}' }); t.after(() => env.dispose());
    for (const lineText of ['private void validateNativeCompaction()', 'public void run()']) {
        const result = locations(await env.providers.definition.provideDefinition(doc, positionOf(doc, lineText, name), {}));
        assert.equal(result[0].range.start.line, 2);
        assertSymbolRange(doc, result[0], name);
    }
});
