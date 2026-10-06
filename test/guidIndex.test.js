const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BlIndex, parseBlContent, normalizeGuid } = require('../blIndex');

const file = '/workspace/clm/app/src/main/bl/access/RoleAccess.bl';
const guid = '6D79CDE1-FA42-40A7-86C2-091EF32AA058';
const otherGuid = '3AB51274-196D-4605-AC83-1B7F3F7ACE88';

test('GUID normalization accepts only complete bare hexadecimal UUIDs', () => {
    assert.equal(normalizeGuid(guid), guid.toLowerCase());
    assert.equal(normalizeGuid(guid.toLowerCase()), guid.toLowerCase());
    for (const value of [null, undefined, 1, '', ` '${guid}' `, `"${guid}"`, `{${guid}}`, ` ${guid}`, `${guid} `,
        `${guid}x`, `${guid}\n`, `${guid}\r\n`, `${guid}\u2028`, guid.slice(1), guid.replace('6', 'g'), guid.replaceAll('-', '')]) {
        assert.equal(normalizeGuid(value), null, String(value));
    }
});

test('records preserve real-shaped access attributes, literal case and ordinary guid members', () => {
    const text = `import app.Roles;
public class RoleAccess extends BaseAccess {
    records {
        [name "$Access.edit$"]
        [roleId Roles.Expert][soaId SecuredObjectAccess.DzwfModify][value true]
        ExpertDzwfModify = '${guid}';
    }
}`;
    const info = parseBlContent(file, text);
    const record = info.records.get('ExpertDzwfModify');
    assert.equal(record.guid, guid.toLowerCase());
    assert.equal(record.guidLiteral, guid);
    assert.deepEqual(record.attributes.map(({ name, value }) => [name, value]), [
        ['name', '"$Access.edit$"'], ['roleId', 'Roles.Expert'], ['soaId', 'SecuredObjectAccess.DzwfModify'], ['value', 'true']
    ]);
    assert.equal(record.line, 5);
    assert.equal(record.column, 8);
    assert.equal(record.guidLine, 5);
    assert.equal(record.guidColumn, text.split('\n')[5].indexOf(guid));
    assert.equal(text.slice(record.guidOffset, record.guidEndOffset), guid);
    assert.equal(text.slice(record.offset, record.endOffset), record.name);
    for (const attr of record.attributes) {
        assert.equal(text.slice(attr.valueOffset, attr.valueEndOffset), attr.value);
        assert.equal(text[attr.offset], '[');
        assert.equal(text[attr.endOffset - 1], ']');
    }
    assert.deepEqual(info.members.get(record.name), { name: record.name, typeName: 'guid', line: record.line, column: record.column });
    assert.equal(info.recordDeclarations[0], record);
    assert.equal(Object.hasOwn(record, 'owner'), false, 'record metadata cannot retain a cyclic class graph');
});

test('multiline attributes and GUID RHS keep exact CRLF coordinates while masking comments', () => {
    const lines = [
        'public class RoleAccess {',
        '    records',
        '    {',
        '        [name',
        '            "literal [ ] { } ; // /* escaped \\" quote"',
        '        ]',
        '        [roleId /* ignore */ Roles.',
        '            Expert]',
        '        [options Example[string] { "a": "b]" }]',
        '        public [value true] Expert =',
        '            /* before */',
        `            '${guid}' /* after */;`,
        `        [name "second"] Next = '${otherGuid}';`,
        '    }',
        '}'
    ];
    const text = lines.join('\r\n');
    const info = parseBlContent(file, text);
    const record = info.records.get('Expert');
    assert.ok(record);
    assert.equal(record.guid, guid.toLowerCase());
    assert.equal(record.line, 9);
    assert.equal(record.column, lines[9].indexOf('Expert'));
    assert.equal(record.guidLine, 11);
    assert.equal(record.guidColumn, lines[11].indexOf(guid));
    assert.equal(text.slice(record.guidOffset, record.guidEndOffset), guid);
    assert.deepEqual(record.modifiers, ['public']);
    assert.equal(record.attributes[1].value.replace(/\s/g, ''), 'Roles.Expert');
    assert.equal(record.attributes[1].value.includes('ignore'), false);
    assert.equal(record.attributes[2].value, 'Example[string] { "a": "b]" }');
    assert.deepEqual(info.records.get('Next').attributes.map(attr => attr.name), ['name']);
});

test('same-line records and separate blocks preserve every declaration including duplicate names', () => {
    const text = `public class RoleAccess { records { [name "first"] Same = '${guid}'; [name "again"] Same = '${otherGuid}'; } records { Final = '${guid}'; } }`;
    const info = parseBlContent(file, text);
    assert.equal(info.records.size, 2);
    assert.equal(info.recordDeclarations.length, 3);
    assert.equal(info.records.get('Same').guid, otherGuid.toLowerCase());
    assert.equal(info.recordDeclarations[0].attributes[0].value, '"first"');
    assert.equal(info.recordDeclarations[1].attributes[0].value, '"again"');
    assert.equal(info.members.get('Same').column, text.lastIndexOf('Same'));
    const index = new BlIndex();
    index.addClass(info);
    assert.equal(index.getRecordsByGuid(guid).length, 2);
    assert.equal(index.getRecordsByGuid(otherGuid).length, 1);
    index.removeFile(file);
    assert.equal(index.recordsByGuid.size, 0);
});

test('UUIDs in ordinary strings, comments, method/inline scopes or attributes never create records', () => {
    const text = `// class Fake { records { Wrong = '${guid}'; } }
public class RoleAccess {
    public string comment = "records { Wrong = '${guid}'; }";
    [default Example[] { class { records { NestedAttr = '${guid}'; } } }]
    public Example[] examples;
    public Example child = class { records { NestedInline = '${guid}'; } };
    public void run() { records { NestedMethod = '${guid}'; } }
    /* records { WrongBlock = '${guid}'; } */
    public void records() {}
    records {
        /* Hidden = '${guid}'; */
        [name "Never = '${guid}'; ]"] Actual = '${otherGuid}';
    }
}`;
    const info = parseBlContent(file, text);
    assert.deepEqual(Array.from(info.records.keys()), ['Actual']);
    assert.equal(info.records.get('Actual').guid, otherGuid.toLowerCase());
    assert.ok(info.methods.has('records'));
});

test('computed, parenthesized, double-quoted and malformed record values do not acquire static IDs', () => {
    const text = `public class RoleAccess { records {
        [name "generated"] Dynamic = guid.create();
        [name "wrapped"] Wrapped = ('${guid}');
        [name "string"] StringValue = "${guid}";
        Nested = guid.create('${guid}', new Other { nested = '${otherGuid}'; });
        Invalid = 'not-a-guid';
        Empty = ;
        Static = /* prefix */ '${guid}' /* suffix */;
    } }`;
    const info = parseBlContent(file, text);
    assert.equal(info.records.size, 7);
    for (const name of ['Dynamic', 'Wrapped', 'StringValue', 'Nested', 'Invalid', 'Empty']) {
        const record = info.records.get(name);
        assert.equal(record.guid, null, name);
        assert.equal(record.guidLiteral, null, name);
        assert.equal(record.guidLine, null, name);
        assert.equal(record.guidOffset, null, name);
        assert.equal(info.members.get(name).typeName, 'guid', name);
    }
    assert.equal(info.records.get('Dynamic').attributes[0].value, '"generated"');
    assert.equal(info.records.get('Static').guid, guid.toLowerCase());
    const index = new BlIndex();
    index.addClass(info);
    assert.deepEqual(index.getRecordsByGuid(guid).map(candidate => candidate.record.name), ['Static']);
    assert.equal(index.getRecordsByGuid(otherGuid).length, 0);
});

test('record metadata supports unsaved incomplete bodies without indexing fake UUID expressions', () => {
    const info = parseBlContent(file, `public class RoleAccess { records {
        [name "unsaved"] First = '${guid}';
        Second = guid.create('${otherGuid}'`);
    assert.equal(info.records.get('First').guid, guid.toLowerCase());
    assert.equal(info.records.get('Second').guid, null);
});

test('GUID lookup preserves all owners/copies and updates after dirty reparse and removal', () => {
    const index = new BlIndex();
    const body = name => `public class ${name} { records { Entry = '${guid}'; } }`;
    const cloud = file.replace('/clm/', '/cloud/');
    const migration = file.replace('RoleAccess.bl', 'Migration.bl');
    const owner = index.updateFromText(file, body('RoleAccess'));
    index.updateFromText(cloud, body('RoleAccess'));
    index.updateFromText(migration, body('Migration'));
    const candidates = index.getRecordsByGuid(guid.toLowerCase());
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0].owner, owner);
    assert.equal(candidates[0].record, owner.records.get('Entry'));
    assert.deepEqual(new Set(candidates.map(candidate => candidate.owner.filePath)), new Set([file, cloud, migration]));
    const revision = index.revision;
    index.updateFromText(file, body('RoleAccess').replace(guid, otherGuid));
    assert.ok(index.revision > revision);
    assert.equal(index.getRecordsByGuid(guid).length, 2);
    assert.equal(index.getRecordsByGuid(otherGuid)[0].owner.filePath, file);
    index.updateFromText(file, 'public class RoleAccess {}');
    assert.equal(index.getRecordsByGuid(otherGuid).length, 0);
    index.removeFile(cloud);
    assert.equal(index.getRecordsByGuid(guid).length, 1);
    index.removeFile(migration);
    assert.equal(index.getRecordsByGuid(guid).length, 0);
    assert.equal(index.recordsByGuid.size, 0);
    assert.equal(index.getRecordsByGuid('invalid').length, 0);
});

test('direct addClass fixtures normalize lookup keys, replace old entries and invalidate revisions', () => {
    const index = new BlIndex();
    const info = parseBlContent(file, `public class RoleAccess { records { First = '${guid}'; } }`);
    delete info.recordDeclarations;
    info.records.get('First').guid = guid;
    const start = index.revision;
    index.addClass(info);
    assert.ok(index.revision > start);
    assert.equal(index.getRecordsByGuid(guid.toLowerCase())[0].record.name, 'First');
    const next = parseBlContent(file, `public class RoleAccess { records { Next = '${otherGuid}'; } }`);
    const revision = index.revision;
    index.addClass(next);
    assert.ok(index.revision > revision);
    assert.equal(index.getRecordsByGuid(guid).length, 0);
    assert.equal(index.getRecordsByGuid(otherGuid).length, 1);
    index.removeFile(file);
    assert.equal(index.recordsByGuid.size, 0);
});

test('GUID text candidate filter includes comments/strings/code, is case-insensitive and resets on edits', () => {
    const index = new BlIndex();
    const comment = file.replace('RoleAccess', 'Comment');
    const string = file.replace('RoleAccess', 'String');
    const code = file.replace('RoleAccess', 'Code');
    index.updateFromText(comment, `// ${guid}\npublic class Comment {}`);
    index.updateFromText(string, `public class String { string value = "prefix${guid.toLowerCase()}suffix"; }`);
    index.updateFromText(code, `public class Code { records { Entry = '${guid}'; } }`);
    index.updateFromText(file, 'public class RoleAccess {}');
    assert.deepEqual(index.getGuidReferenceCandidates(guid), new Set([comment, string, code]));
    assert.equal(index.guidTextFilters.size, 3);
    assert.equal(index.guidTextFilters.get(comment).byteLength, 1024);
    assert.equal(index.getGuidReferenceCandidates('invalid').size, 0);
    index.updateFromText(comment, 'public class Comment {}');
    assert.equal(index.getGuidReferenceCandidates(guid).has(comment), false);
    index.removeFile(string);
    assert.deepEqual(index.getGuidReferenceCandidates(guid), new Set([code]));
    index.removeFile(code);
    assert.equal(index.guidTextFilters.size, 0);
});

test('source fingerprints distinguish edits but not identical reparses without retaining source', () => {
    const index = new BlIndex();
    const text = `public class Roles { records { Expert = '${guid}'; } }`;
    index.updateFromText(file, text);
    const before = index.fileContentHashes.get(file);
    assert.match(before, /^[a-f0-9]{64}$/);
    index.updateFromText(file, text);
    assert.equal(index.fileContentHashes.get(file), before);
    index.updateFromText(file, '\n' + text);
    assert.notEqual(index.fileContentHashes.get(file), before);
    index.removeFile(file);
    assert.equal(index.fileContentHashes.has(file), false);
});

test('compact GUID filter never drops any indexed raw UUID and does not retain source text', () => {
    const index = new BlIndex();
    const guids = Array.from({ length: 3000 }, (_, i) => `01234567-89ab-cdef-0123-${i.toString(16).padStart(12, '0')}`);
    index.updateFromText(file, 'public class RoleAccess {}\n// ' + guids.join(' '));
    const filter = index.guidTextFilters.get(file);
    assert.ok(filter instanceof Uint32Array);
    assert.equal(filter.byteLength, 1024);
    for (const value of guids) assert.ok(index.getGuidReferenceCandidates(value).has(file), value);
    const info = index.getClassByFile(file);
    assert.equal(Object.hasOwn(info, 'content'), false);
    assert.equal(info.records.size, 0);
});

test('static final GUID fields preserve kinds, modifiers, attributes and exact multiline CRLF positions', () => {
    const text = [ 'public class RoleAccess {', `    static public final guid General = '${guid}';`,
        '    [name "title"] final', '    [value true] public static guid Second =', `        /* before */ '${otherGuid}' /* after */;`,
        `    records { Entry = '${guid}'; }`, '}' ].join('\r\n');
    const info = parseBlContent(file, text);
    assert.deepEqual(info.guidConstants.map(r => r.name), ['General', 'Second']);
    const constant = info.guidConstants[1];
    assert.equal(constant.kind, 'constant');
    assert.deepEqual(constant.modifiers, ['final', 'public', 'static']);
    assert.deepEqual(constant.attributes.map(a => a.name), ['name', 'value']);
    assert.equal(constant.line, 3);
    assert.equal(constant.column, text.split('\r\n')[3].indexOf('Second'));
    assert.equal(constant.guidLine, 4);
    assert.equal(text.slice(constant.offset, constant.endOffset), 'Second');
    assert.equal(text.slice(constant.guidOffset, constant.guidEndOffset), otherGuid);
    assert.equal(info.members.get('General').typeName, 'guid');
    assert.equal(info.recordDeclarations[0].kind, 'record');
    assert.ok(!info.records.has('General'));
});

test('computed GUIDs, non-final fields, strings, comments, locals and inline/attribute scopes are not GUID constants', () => {
    const text = `public class RoleAccess {
        static guid Mutable = '${guid}';
        final guid Instance = '${guid}';
        static final string StringValue = "${guid}";
        static final guid Wrapped = ('${guid}');
        static final guid Dynamic = guid.create('${guid}', new Example { guid id = '${guid}'; });
        static final guid Quoted = "${guid}";
        /* static final guid Hidden = '${guid}'; */
        string value = "static final guid Hidden = '${guid}';";
        Example child = class { static final guid Inline = '${guid}'; };
        public void run() { static final guid Local = '${guid}'; }
        [default Example[] { class { static final guid Attr = '${guid}'; } }]
        public Example[] examples;
        static final guid Real = '${otherGuid}';
    }`;
    const info = parseBlContent(file, text);
    assert.deepEqual(info.guidConstants.map(r => r.name), ['Real']);
    assert.equal(info.recordDeclarations.length, 0);
});

test('GUID constants keep all duplicate declarations and update/remove independently of records-only lookup', () => {
    const index = new BlIndex();
    const text = `public class RoleAccess { static final guid Same = '${guid}'; static final guid Same = '${otherGuid}'; records { Entry = '${guid}'; } }`;
    index.updateFromText(file, text);
    assert.equal(index.getGuidDeclarations().length, 3);
    assert.deepEqual(index.getGuidDeclarations(guid).map(a => a.record.kind), ['record', 'constant']);
    assert.equal(index.getRecordsByGuid(guid).length, 1);
    assert.equal(index.getRecordsByGuid(otherGuid).length, 0);
    assert.equal(index.getGuidDeclarations('invalid').length, 0);
    index.updateFromText(file, `public class RoleAccess { static final guid Changed = '${otherGuid}'; }`);
    assert.equal(index.getGuidDeclarations(guid).length, 0);
    assert.equal(index.getGuidDeclarations(otherGuid)[0].record.name, 'Changed');
    index.removeFile(file);
    assert.equal(index.getGuidDeclarations().length, 0);
    assert.equal(index.constantsByGuid.size, 0);
    assert.equal(index.recordsByGuid.size, 0);
});
