const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BlIndex, parseBlContent, parseMethodSignature, sanitizeText } = require('../blIndex');
const { DocumentAnalysis } = require('../documentAnalysis');

const root = '/workspace/clm';
const file = `${root}/app/src/main/bl/app/Example.bl`;
const guid = '00629445-F77A-407C-9F4D-3E3B63D7DA2D';

function cursor(text, marker, offset = 0) {
    const at = text.indexOf(marker);
    assert.ok(at >= 0, marker);
    const lines = text.slice(0, at + offset).split(/\r?\n/);
    return { line: lines.length - 1, character: lines.at(-1).length };
}

function visible(analysis, marker) {
    return new Map(analysis.visibleLocals(cursor(analysis.text, marker)).map(local => [local.name, local]));
}

test('completion model preserves field access/static/kind and collection types through attributes', () => {
    const text = `import library.Item;
public class Example {
    private [name "Items"] final Item [] items;
    [name "Entries"] static public Item [string] entries;
    protected Item child;
    Item plain;
    static final guid General = '${guid}';
    records {
        protected Known = '${guid}';
        Public = guid.create('${guid}');
    }
}`;
    const info = parseBlContent(file, text);
    const items = info.members.get('items');
    assert.equal(items.kind, 'field');
    assert.deepEqual(items.modifiers, ['private', 'final']);
    assert.equal(items.isStatic, false);
    assert.equal(items.typeName.replace(/\s/g, ''), 'Item[]');
    assert.equal(items.column, text.split('\n')[2].lastIndexOf('items'));
    const entries = info.members.get('entries');
    assert.deepEqual(entries.modifiers, ['static', 'public']);
    assert.equal(entries.isStatic, true);
    assert.equal(entries.typeName.replace(/\s/g, ''), 'Item[string]');
    assert.deepEqual(info.members.get('plain').modifiers, []);
    assert.deepEqual(info.members.get('child').modifiers, ['protected']);
    for (const [name, kind, modifiers] of [['General', 'constant', ['static', 'final']],
        ['Known', 'record', ['protected']], ['Public', 'record', []]]) {
        const member = info.members.get(name);
        assert.equal(member.kind, kind);
        assert.equal(member.typeName, 'guid');
        assert.equal(member.isStatic, true);
        assert.deepEqual(member.modifiers, modifiers);
    }
});

test('enum completion members are static enum values with exact source positions', () => {
    const text = `public enum Example {
    First, Second,
    Third
}`;
    const info = parseBlContent(file, text);
    assert.equal(info.isEnum, true);
    for (const name of ['First', 'Second', 'Third']) {
        const member = info.members.get(name);
        assert.equal(member.kind, 'enum');
        assert.equal(member.typeName, 'Example');
        assert.equal(member.isStatic, true);
        assert.deepEqual(member.modifiers, []);
        assert.equal(text.split('\n')[member.line].slice(member.column, member.column + name.length), name);
    }
});

test('overloaded method metadata keeps declared parameters and unknown signatures remain unknown', () => {
    const text = `public class Example {
    virtual protected Item [] make(
        Item [string] entries,
        string text
    ) { return null; }
    public Item make() { return null; }
    public Item pending(Item
}`;
    const info = parseBlContent(file, text);
    const overloads = info.methods.get('make').overloads;
    assert.equal(overloads.length, 2);
    assert.deepEqual(overloads[0].modifiers, ['virtual', 'protected']);
    assert.deepEqual(overloads[0].parameterTypes, ['Item[string]', 'string']);
    assert.deepEqual(overloads[0].parameters, [{ typeName: 'Item[string]', name: 'entries' },
        { typeName: 'string', name: 'text' }]);
    assert.deepEqual(overloads[1].parameters, []);
    assert.deepEqual(overloads[1].parameterTypes, []);
    assert.equal(info.methods.get('pending').parameterTypes, null);
    assert.equal(info.methods.get('pending').parameters, null);
    const malformed = parseMethodSignature(sanitizeText('public Item broken(Item good, Unknown)').split('\n'), 0);
    assert.equal(malformed.parameterTypes, null);
    assert.equal(malformed.parameters, null, 'no fabricated parameter name or partial signature');
});

test('inherited completion metadata remains on original owners and explicit imports resolve element types', () => {
    const index = new BlIndex();
    const item = index.updateFromText(`${root}/base/src/main/bl/library/Item.bl`, 'public class Item {}');
    const base = index.updateFromText(`${root}/base/src/main/bl/base/Base.bl`, `import library.Item;
public class Base {
    protected Item[string] items;
    virtual protected Item[] make(Item value) { return null; }
}`);
    const child = index.updateFromText(file, 'import base.Base;\npublic class Example extends Base {}');
    const member = index.findMemberInClassChain(child, 'items');
    assert.equal(member.owner, base);
    assert.deepEqual(member.member.modifiers, ['protected']);
    assert.equal(index.resolveTypeName(member.owner, member.member.typeName)[0], item);
    const method = index.findMethodInClassChain(child, 'make');
    assert.equal(method.owner, base);
    assert.deepEqual(method.method.parameters, [{ typeName: 'Item', name: 'value' }]);
});

test('visibleLocals respects parameters, block shadowing, declarations after cursor and method boundaries', () => {
    const text = `public class Example {
    Item field;
    public void first(Item parameter, Item[] items) {
        Item outer;
        beforeBlock();
        {
            beforeInner();
            Other outer;
            afterInner();
        }
        afterBlock();
        Item future;
    }
    public void second(string text) {
        secondMethod();
    }
}`;
    const analysis = new DocumentAnalysis(text);
    assert.deepEqual([...visible(analysis, 'beforeBlock()').keys()].sort(), ['items', 'outer', 'parameter']);
    assert.equal(visible(analysis, 'beforeInner()').get('outer').typeName, 'Item');
    assert.equal(visible(analysis, 'afterInner()').get('outer').typeName, 'Other');
    assert.equal(visible(analysis, 'afterBlock()').get('outer').typeName, 'Item');
    assert.equal(visible(analysis, 'afterBlock()').has('future'), false);
    assert.deepEqual([...visible(analysis, 'secondMethod()').keys()], ['text']);
    assert.deepEqual(analysis.visibleLocals(cursor(text, 'Item field')), []);
    for (const position of [null, { line: -1, character: 0 }, { line: 999, character: 0 },
        { line: 0, character: -1 }, { line: 0, character: 999 }]) assert.deepEqual(analysis.visibleLocals(position), []);
});

test('visibleLocals applies for/catch variable lifetimes including single-statement loops', () => {
    const text = `public class Example {
    public void run(Item[] items) {
        for (Item entry : items) {
            inLoop();
        }
        afterLoop();
        for (Item single : items) useSingle();
        afterSingle();
        try {
            tryBody();
        } catch (Exception failure) {
            inCatch();
        }
        afterCatch();
    }
}`;
    const analysis = new DocumentAnalysis(text);
    assert.equal(visible(analysis, 'inLoop()').get('entry').typeName, 'Item');
    assert.equal(visible(analysis, 'afterLoop()').has('entry'), false);
    assert.equal(visible(analysis, 'useSingle()').get('single').typeName, 'Item');
    assert.equal(visible(analysis, 'afterSingle()').has('single'), false);
    assert.equal(visible(analysis, 'inCatch()').get('failure').typeName, 'Exception');
    assert.equal(visible(analysis, 'afterCatch()').has('failure'), false);
});

test('visibleLocals does not borrow containing method parameters through inline class boundaries', () => {
    const text = `public class Example {
    public void outer(Item outerParam) {
        Item outerLocal;
        Item child = class {
            Item member;
            public void inner(Item innerParam) {
                Item innerLocal;
                inInline();
            }
        };
        afterInline();
    }
}`;
    const analysis = new DocumentAnalysis(text);
    assert.deepEqual([...visible(analysis, 'inInline()').keys()].sort(), ['innerLocal', 'innerParam']);
    assert.deepEqual([...visible(analysis, 'afterInline()').keys()].sort(), ['child', 'outerLocal', 'outerParam']);
});

test('visible local candidates resolve exactly as existing findLocal on CRLF multiline parameters', () => {
    const text = ['public class Example {', '    public void run(', '        Item[] values,',
        '        Item[string] entries', '    ) {', '        Item local;', '        {', '            Other local;',
        '            point();', '        }', '    }', '}'].join('\r\n');
    const analysis = new DocumentAnalysis(text), position = cursor(text, 'point()');
    const candidates = analysis.visibleLocals(position);
    assert.equal(candidates.length, 3);
    for (const local of candidates) {
        assert.equal(analysis.findLocal(position, local.name), local);
        assert.equal(text.split(/\r?\n/)[local.line].slice(local.column, local.column + local.name.length), local.name);
    }
    assert.equal(candidates.find(local => local.name === 'values').typeName, 'Item[]');
    assert.equal(candidates.find(local => local.name === 'entries').typeName, 'Item[string]');
});

test('sanitizer optionally emits lexical spans without changing output or coordinates', () => {
    const text = 'code "\\\"quoted\\\"" /* block */ // line\r\nnext \'unclosed';
    const ranges = [];
    const masked = sanitizeText(text, true, ranges);
    assert.equal(masked, sanitizeText(text));
    assert.equal(masked.length, text.length);
    assert.deepEqual(ranges, [
        { start: text.indexOf('"'), end: text.indexOf(' /*'), closed: true },
        { start: text.indexOf('/*'), end: text.indexOf('*/') + 2, closed: true },
        { start: text.indexOf('//'), end: text.indexOf('\n'), closed: false },
        { start: text.indexOf("'"), end: text.length, closed: false }
    ]);
    const commentsOnly = [];
    assert.equal(sanitizeText(text, false, commentsOnly), sanitizeText(text, false));
    assert.deepEqual(commentsOnly, ranges, 'string spans remain lexical even when preserving string text');
});

test('isCodePosition rejects empty/closed/escaped/unclosed literal interiors but permits after a closing quote', () => {
    for (const text of ['"" next', "'' next", '"text \\\"escaped\\\" text" next', "'guid' next"]) {
        const analysis = new DocumentAnalysis(text), closing = text.indexOf(' next');
        assert.equal(analysis.isCodePosition({ line: 0, character: 0 }), true, 'caret before opener');
        for (let character = 1; character < closing; character++)
            assert.equal(analysis.isCodePosition({ line: 0, character }), false, `${text}: ${character}`);
        assert.equal(analysis.isCodePosition({ line: 0, character: closing }), true, 'just after closed quote');
    }
    for (const text of ['"', "'", '"unfinished', "'unfinished", '"escaped \\\"']) {
        const analysis = new DocumentAnalysis(text);
        assert.equal(analysis.isCodePosition({ line: 0, character: text.length }), false, `end of ${text}`);
    }
});

test('isCodePosition handles comments and CRLF including end-of-line and incomplete block boundaries', () => {
    const text = 'code // comment\r\nnext /* block\r\ncomment */ after\r\nlast';
    const analysis = new DocumentAnalysis(text);
    assert.equal(analysis.isCodePosition(cursor(text, '//')), true);
    assert.equal(analysis.isCodePosition({ line: 0, character: 'code // comment'.length }), false);
    assert.equal(analysis.isCodePosition({ line: 1, character: 0 }), true);
    assert.equal(analysis.isCodePosition(cursor(text, 'block')), false);
    assert.equal(analysis.isCodePosition(cursor(text, 'comment */')), false);
    assert.equal(analysis.isCodePosition(cursor(text, ' after')), true);
    assert.equal(analysis.isCodePosition(cursor(text, 'last')), true);
    for (const text of ['//', '// end', '/*', '/* unfinished']) {
        assert.equal(new DocumentAnalysis(text).isCodePosition({ line: 0, character: text.length }), false, text);
    }
    assert.equal(new DocumentAnalysis('/**/').isCodePosition({ line: 0, character: 4 }), true);
    for (const position of [null, { line: -1, character: 0 }, { line: 99, character: 0 },
        { line: 0, character: -1 }, { line: 0, character: 99 }]) assert.equal(analysis.isCodePosition(position), false);
});
