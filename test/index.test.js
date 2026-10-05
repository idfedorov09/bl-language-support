const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BlIndex, parseBlContent, sanitizeText, stripInlineAttributes } = require('../blIndex');

const file = '/workspace/clm/module/src/main/bl/example/Example.bl';

test('strings and comments cannot change class depth or hide declarations', () => {
    const info = parseBlContent(file, `public class Example {
    public string url = "http://example/{";
    public string json = "} /*";
    /* class Wrong { */
    public void finish() {}
    [name "value"] public string value;
}`);
    assert.ok(info.methods.has('finish'));
    assert.ok(info.members.has('value'));
    assert.equal(info.members.get('value').column, '    [name "value"] public string value;'.lastIndexOf('value'));
});

test('native attribute and spaced collection types survive lexical masking', () => {
    const info = parseBlContent(file, `[native "example.Native"]
public class Example {
    public Example [] items;
    public Example [string] entries;
    public Example [] all();
}`);
    assert.equal(info.nativeClassName, 'example.Native');
    assert.equal(info.members.get('items').typeName.replace(/\s/g, ''), 'Example[]');
    assert.equal(info.members.get('entries').typeName.replace(/\s/g, ''), 'Example[string]');
    assert.ok(info.methods.has('all'));
});

test('a native field attribute cannot replace the native class binding', () => {
    const info = parseBlContent(file, `[request true][native "example.Native"]
public class Example {
    [primary "example.Field"] public string field;
}`);
    assert.equal(info.nativeClassName, 'example.Native');
});

test('lexical masking preserves offsets and CRLF', () => {
    const text = '"escaped \\" quote" // comment\r\n/* block */ code\r\n';
    const masked = sanitizeText(text);
    assert.equal(masked.length, text.length);
    assert.equal(masked.indexOf('code'), text.indexOf('code'));
    assert.equal(masked.split('\r\n').length, text.split('\r\n').length);
    const attribute = '[name "hello"] public Example [] items;';
    assert.equal(stripInlineAttributes(attribute).indexOf('items'), attribute.indexOf('items'));
    assert.ok(stripInlineAttributes(attribute).includes('[]'));
});

test('duplicate classes are resolved in the callers checkout', () => {
    const index = new BlIndex();
    const clm = index.updateFromText(file, 'public class Example {}');
    const cloudFile = file.replace('/clm/', '/cloud/');
    const cloud = index.updateFromText(cloudFile, 'public class Example {}');
    assert.equal(index.getClassByFullName('example.Example', clm).filePath, file);
    assert.equal(index.getClassByFullName('example.Example', cloud).filePath, cloudFile);
    index.updateFromText(file, 'public class Example {}');
    assert.equal(index.getClassByFullName('example.Example', cloud).filePath, cloudFile);
    index.removeFile(file);
    assert.equal(index.getClassByFullName('example.Example').filePath, cloudFile);
    assert.equal(index.resolveClassName(cloud, 'Example')[0].filePath, cloudFile);
});

test('cycles in incomplete inheritance never hang navigation', () => {
    const index = new BlIndex();
    const info = index.updateFromText(file, 'public class Example extends Example {}');
    assert.equal(index.findMethodInClassChain(info, 'missing'), null);
    assert.equal(index.findMemberInClassChain(info, 'missing'), null);
});
