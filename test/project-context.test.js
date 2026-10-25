const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseSettings } = require('../projectContext');
const { document, positionOf, extension } = require('./helpers');

const root = '/workspace/saas', app = `${root}/app`;
const source = `${app}/src/main/bl/app/User.bl`;
const application = `${root}/z8/lang/src/bl/api/Application.bl`;
const query = `${root}/z8/lang/src/bl/api/Query.bl`;
const table = `${root}/z8/lang/src/bl/api/Table.bl`;
const share = `${app}/src/main/bl/app/Shares.bl`;
const code = `import api.Application;
public class User {
    public void run() {
        string hash = Application.getRequestParameter("hash");
        Shares share;
        share.readFirst();
    }
}`;
const fixtures = {
    [`${app}/.git`]: 'gitdir: ../.git/modules/app',
    [`${root}/settings.gradle`]: "include 'app'\nincludeBuild 'z8'",
    [`${root}/z8/settings.gradle`]: "include 'lang'",
    [application]: `[native "native.Application"]
public class Application {
    static public string getRequestParameter(string key);
}`,
    [query]: 'public class Query {\n    public bool readFirst();\n}',
    [table]: 'import api.Query;\npublic class Table extends Query {}',
    [share]: 'import api.Table;\npublic class Shares extends Table {}',
    [source]: code
};
async function setup(t, extra = {}, options = {}, text = code) {
    const doc = document(source, text);
    const env = await extension({ ...fixtures, ...extra, [source]: text }, [doc], {
        workspaceFolders: [app], checkoutRoots: [root], strictWorkspaceDiscovery: true, ...options
    });
    t.after(() => env.dispose());
    await env.open(doc);
    return { env, doc };
}
const diagnostics = state => Array.from(state.env.vscode.languages.getDiagnostics(state.doc.uri));
async function definition(state, word, line = word) {
    const result = await state.env.providers.definition.provideDefinition(state.doc, positionOf(state.doc, line, word), {});
    return result ? Array.from(Array.isArray(result) ? result : [result]) : [];
}
async function completions(state, prefix) {
    const text = code.replace('Application.getRequestParameter("hash")', prefix);
    Object.assign(state.doc, document(source, text));
    await state.env.change(state.doc);
    const result = await state.env.providers.completion.provideCompletionItems(state.doc,
        state.doc.positionAt(text.indexOf(prefix) + prefix.length), {});
    return Array.from(result.items || result).map(item => item.label);
}

test('settings parser accepts literal Groovy/Kotlin includes and remaps, not comments or code', () => {
    assert.deepEqual(parseSettings(`// include 'wrong'
include(":app", ":nested:lib")
includeBuild("z8")
project(":app").projectDir = file("modules/app")
def text = "include 'wrong'"
/* include 'alsoWrong' */`), { modules: ['modules/app', 'nested/lib'], builds: ['z8'], issues: [] });
    const unknown = parseSettings('if (true) {\n include("hidden")\n}\ninclude(System.getenv("MODULE"))');
    assert.deepEqual(unknown.modules, []);
    assert.equal(unknown.issues.length, 2);
    assert.deepEqual(parseSettings("include 'app'\nproject(':app').projectDir = dynamicPath").modules, []);
    assert.deepEqual(parseSettings("include 'app', 'lib'\nproject(':app').projectDir = file('ok')\nproject(':lib').projectDir = dynamicPath").modules, []);
});

test('opening only a submodule discovers the declared composite and resolves both screenshot calls', async t => {
    const state = await setup(t);
    assert.deepEqual(diagnostics(state), []);
    assert.equal((await definition(state, 'getRequestParameter'))[0].uri.fsPath, application);
    assert.equal((await definition(state, 'readFirst'))[0].uri.fsPath, query);
    assert.ok(state.env.outputs.some(line => line.includes(`BL project: ${app} -> ${root}`)));
    assert.ok((await completions(state, 'Application.getReq')).includes('getRequestParameter'));
    assert.equal(state.env.appliedEdits.length, 0);
});

test('missing platform produces one explicit incomplete-context warning, not false unknown methods', async t => {
    const state = await setup(t, {}, { configuration: { 'index.autoProjectContext': false } });
    const ds = diagnostics(state);
    assert.equal(ds.length, 1);
    assert.equal(ds[0].code, 'incomplete-context');
    assert.equal(ds[0].severity, 1);
    assert.match(ds[0].message, /api.Application/);
    assert.match(ds[0].message, /Table/);
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
    assert.ok(!(await completions(state, 'Application.getReq')).includes('getRequestParameter'));
});

test('complete context still diagnoses a genuinely nonexistent method', async t => {
    const state = await setup(t, {}, {}, code.replace('getRequestParameter', 'notARealMethod'));
    assert.ok(diagnostics(state).some(d => d.code === 'chain' && /notARealMethod/.test(d.message)));
    assert.ok(!diagnostics(state).some(d => d.code === 'incomplete-context'));
});

test('unqualified inherited calls are unknown only when the base chain is complete', async t => {
    const text = 'import api.Query;\npublic class User extends Query {\n    public void run() {\n        noSuchMethod();\n    }\n}';
    const complete = await setup(t, {}, {}, text);
    assert.ok(diagnostics(complete).some(d => d.code === 'call'));
    const missing = await setup(t, {}, { configuration: { 'index.autoProjectContext': false } }, text);
    assert.deepEqual(diagnostics(missing).map(d => d.code), ['incomplete-context']);
});

test('untrusted workspaces do not expand outside the opened folder', async t => {
    const state = await setup(t, {}, { isTrusted: false });
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
    assert.equal(state.env.readCounts.get(application) || 0, 0);
});

test('a parent settings file must actually declare the opened module', async t => {
    const state = await setup(t, { [`${root}/settings.gradle`]: "include 'unrelated'\nincludeBuild 'z8'" });
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
});

test('repository and worktree boundaries prevent accidental parent adoption', async t => {
    const state = await setup(t, { [`${app}/.git`]: 'gitdir: /elsewhere/worktrees/app' });
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
});

test('outside paths, symlinked modules and symlinked source files are not connected', async t => {
    const escaped = await setup(t, { [`${root}/settings.gradle`]: "include 'app'\nincludeBuild '../other'" });
    assert.equal((await definition(escaped, 'getRequestParameter')).length, 0);
    const symlink = await setup(t, {}, { realPaths: { [`${root}/z8`]: '/workspace/other/z8' } });
    assert.equal((await definition(symlink, 'getRequestParameter')).length, 0);
    const fileLink = await setup(t, {}, { realPaths: { [application]: '/workspace/other/Application.bl' } });
    assert.equal((await definition(fileLink, 'getRequestParameter')).length, 0);
});

test('external dependency exclusions apply to diagnostics, navigation and completion', async t => {
    const state = await setup(t, {}, { configuration: { 'index.exclude': ['**/z8/**'] } });
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
    assert.ok(diagnostics(state).some(d => d.code === 'incomplete-context'));
    assert.ok(!(await completions(state, 'Application.getReq')).includes('getRequestParameter'));
});

test('a second open checkout cannot supply missing dependencies', async t => {
    const other = '/workspace/other';
    const foreign = `${other}/lang/src/bl/api/Application.bl`;
    const state = await setup(t, {
        [`${root}/settings.gradle`]: "include 'app'",
        [foreign]: fixtures[application]
    }, { workspaceFolders: [app, other], checkoutRoots: [root, other] });
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
    assert.ok(!(await completions(state, 'Application.getReq')).includes('getRequestParameter'));
});

test('ambiguous duplicate classes in the same build are unknown, not arbitrary definitions', async t => {
    const state = await setup(t, {
        [`${root}/z8/settings.gradle`]: "include 'lang', 'duplicate'",
        [`${root}/z8/duplicate/src/bl/api/Application.bl`]: fixtures[application]
    });
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
    assert.ok(diagnostics(state).some(d => d.code === 'incomplete-context'));
});

test('external dependency edits and dirty buffers update navigation/completion', async t => {
    const state = await setup(t);
    state.env.contents.set(application, fixtures[application].replace('getRequestParameter', 'getRequestArgument'));
    await state.env.fileEvent('change', application);
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
    const labels = await completions(state, 'Application.getReq');
    assert.ok(labels.includes('getRequestArgument'));
    assert.ok(!labels.includes('getRequestParameter'));
    const dirty = document(application, fixtures[application]);
    state.env.vscode.workspace.textDocuments.push(dirty);
    await state.env.open(dirty);
    assert.ok((await completions(state, 'Application.getReq')).includes('getRequestParameter'));
});

test('navigation waits for an external dependency refresh including its real-path validation', async t => {
    const realPaths = {};
    const state = await setup(t, {}, { realPaths });
    let release;
    realPaths[application] = new Promise(resolve => { release = resolve; });
    state.env.contents.set(application, fixtures[application].replace('getRequestParameter', 'renamed'));
    const event = state.env.fileEvent('change', application);
    let settled = false;
    const result = definition(state, 'getRequestParameter').then(value => { settled = true; return value; });
    await new Promise(setImmediate);
    assert.equal(settled, false, 'must not navigate against a stale index while validation is pending');
    release(application);
    await event;
    assert.equal((await result).length, 0);
});

test('external dependency deletion and recreation invalidate the index', async t => {
    const state = await setup(t);
    state.env.contents.delete(application);
    await state.env.fileEvent('delete', application);
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
    state.env.contents.set(application, fixtures[application]);
    await state.env.fileEvent('create', application);
    assert.equal((await definition(state, 'getRequestParameter'))[0].uri.fsPath, application);
});

test('a dependency moved through an external symlink cannot survive a refresh', async t => {
    const realPaths = {};
    const state = await setup(t, {}, { realPaths });
    realPaths[application] = '/elsewhere/Application.bl';
    await state.env.fileEvent('change', application);
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
});

test('settings changes rebuild scope and disabling auto context removes cached dependencies', async t => {
    const state = await setup(t);
    state.env.contents.set(`${root}/settings.gradle`, "include 'app'");
    await state.env.fileEvent('change', `${root}/settings.gradle`);
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
    state.env.contents.set(`${root}/settings.gradle`, fixtures[`${root}/settings.gradle`]);
    await state.env.fileEvent('change', `${root}/settings.gradle`);
    assert.equal((await definition(state, 'getRequestParameter'))[0].uri.fsPath, application);
    await state.env.configure({ 'index.autoProjectContext': false });
    assert.equal((await definition(state, 'getRequestParameter')).length, 0);
});
