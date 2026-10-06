const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsRequests, RequestRoutes } = require('../requestModel');
const { BlIndex } = require('../blIndex');
const { document, positionOf, extension } = require('./helpers');
const root = '/workspace/clm';
const base = `${root}/z8/src/bl/org/zenframework/z8/lang/Object.bl`;
const action = `${root}/z8/src/bl/org/zenframework/z8/base/form/action/Action.bl`;
const request = `${root}/app/src/main/bl/app/Request.bl`;
const operation = `${root}/app/src/main/bl/app/Copy.bl`;
const constants = `${root}/app/src/main/bl/app/Operation.bl`;
const client = `${root}/app/src/main/js/Client.js`;
const files = {
    [base]: `public class Object {\n    virtual protected JsonArray getData(string[string] parameters);\n    virtual protected binary processContentRequest(string[string] parameters, file[] files);\n}`,
    [action]: `public class Action {\n    virtual protected void execute(guid recordId);\n}`,
    [constants]: `public class Operation {\n    static public final string Copy = "copyFromWorkspace";\n}`,
    [operation]: `public class Copy {\n    static private final string WorkspaceId = "workspaceId";\n    virtual public binary execute(string[string] parameters, file[] data) {\n        guid id = guid.parse(parameters[WorkspaceId]);\n        return null;\n    }\n}`,
    [request]: `import org.zenframework.z8.base.form.action.Action;
[request true] public class Request extends Object {
    private final string Remove = "removeThread";
    virtual protected JsonArray getData(string[string] parameters) {
        string method = parameters["method"];
        if(method == Remove)
            return removeThreadAndMessages(parameters);
        return null;
    }
    private JsonArray removeThreadAndMessages(string[string] parameters) {
        string id = parameters["threadId"];
        return null;
    }
    virtual protected binary processContentRequest(string[string] parameters, file[] files) {
        return getOperation(parameters["method"]).setParameters(parameters).execute();
    }
    public Copy getOperation(string method) {
        if(method == Operation.Copy)
            return new Copy;
        return null;
    }
    public Action save = class {
        virtual protected void execute(guid recordId) { }
    };
    public void notAnEndpoint() { }
}`,
    [client]: `Z8.define('app.Client', {
    shortClassName: 'Client',
    statics: { request: 'app.Request' },
    run: function() {
        HttpRequest.send({ request: Client.request, action: 'read', method: 'removeThread', threadId: selected });
        HttpRequest.send({ request: 'app.Request', action: 'content', method: 'copyFromWorkspace', workspaceId: selected });
        HttpRequest.send({ request: 'app.Request', action: 'action', name: 'save' });
        const unrelated = 'removeThread';
    }
});`
};
async function setup(t, extra = {}, open = [], options = {}) {
    const env = await extension({ ...files, ...extra }, open, { workspaceFolders: [root], checkoutRoots: [root], configuration: { 'diagnostics.enabled': false }, ...options });
    t.after(() => env.dispose()); return env;
}
async function serverChoices(env, doc, position, keepOpen = false, uri) {
    const original = env.vscode.window.createQuickPick;
    env.vscode.window.createQuickPick = () => { const picker = original(); picker.show = () => {}; return picker; };
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: position } };
    try {
        const before = env.guidPickers.length;
        const result = await env.commands.get('bl.showServerSources')(uri);
        if (!keepOpen && env.guidPickers.length > before) env.guidPickers.at(-1).hide();
        return result;
    } finally { env.vscode.window.createQuickPick = original; }
}
// Route evidence assertions use the real command, then inspect the requested
// category. The UI always offers all categories regardless of the clicked value.
async function routeSources(env, doc, line, word) {
    const choices = await serverChoices(env, doc, positionOf(doc, line, word));
    const classSelected = ['Client.request', 'app.Request'].includes(word);
    return choices.filter(item => classSelected ? item.kind === 'class' : ['branch', 'handler'].includes(item.kind)).map(item => item.location);
}
function normalized(value) { return JSON.parse(JSON.stringify(value)); }

test('strict JS recognizer keeps ranges, constants, scopes, comments and wrappers distinct', () => {
    const text = `// HttpRequest.send({ request: 'fake' })\r\nconst fake = "HttpRequest.send({ request: 'fake' })";
const REQUEST = 'app.Request';
HttpRequest.send(Z8.apply({request: REQUEST, action: 'read'}, {method: 'go', text: "a, ) {}"}));
function shadow(HttpRequest) { HttpRequest.send({request: 'fake'}); }
function shadowConstant(REQUEST) { HttpRequest.send({request: REQUEST}); }
HttpRequest.send({ request: \`dynamic.\${suffix}\`, method: arbitrary() });`;
    const parsed = parseJsRequests(text);
    assert.equal(parsed.error, null); assert.equal(parsed.calls.length, 3);
    const first = parsed.calls[0];
    assert.equal(first.fields.get('request').value, 'app.Request');
    assert.equal(text.slice(first.fields.get('method').start, first.fields.get('method').end), "'go'");
    assert.equal(first.fields.get('text').value, 'a, ) {}');
    assert.equal(parsed.calls[1].fields.get('request').known, false);
    assert.equal(parsed.calls[2].fields.get('request').known, false);
    assert.equal(parsed.calls[2].fields.get('method').known, false);
});

test('Z8 static names only resolve unique unshadowed, unmodified properties', () => {
    for (const [extra, expected] of [['', true], ["Client.request = 'other.Request';", false], ["Client = other;", false]]) {
        const parsed = parseJsRequests(files[client] + extra);
        assert.equal(parsed.calls[0].fields.get('request').known, expected);
    }
    const scoped = parseJsRequests(files[client].replace('run: function()', 'run: function(Client)'));
    assert.equal(scoped.calls[0].fields.get('request').known, false);
    assert.equal(parseJsRequests("const p = {request:'app.Request'}; p.request = dynamic; HttpRequest.send(p);").calls.length, 0);
    assert.equal(parseJsRequests("const p = {request:'app.Request'}; mutate(p); HttpRequest.send(p);").calls.length, 0);
    assert.equal(parseJsRequests("const p = {request:'app.Request'}; HttpRequest.send(p);").calls[0].fields.get('request').value, 'app.Request');
    const spread = parseJsRequests("HttpRequest.send({request:'app.Request', ...unknown, action:'read'});").calls[0];
    assert.equal(spread.fields.has('request'), false);
});

test('BL route descriptors prove aliases, helpers, final constants and action fields; public methods are not endpoints', async () => {
    const index = new BlIndex(); for (const [file, text] of Object.entries(files)) if (file.endsWith('.bl')) index.updateFromText(file, text);
    const routes = new RequestRoutes(index, async file => files[file]);
    const model = await routes.build(index.getClassByFile(request));
    assert.deepEqual(model.routes.map(r => [r.action, r.selector, r.value]), [['read', 'method', 'removeThread'], ['content', 'method', 'copyFromWorkspace'], ['action', 'name', 'save']]);
    assert.ok(model.routes[0].targets.some(t => files[t.filePath].slice(t.start, t.end) === 'removeThreadAndMessages'));
    assert.ok(model.routes[1].targets.some(t => t.filePath === operation));
    assert.ok(model.routes[1].parameters.some(p => p.name === 'workspaceId' && p.required === null && p.type === null));
    assert.ok(model.routes[0].parameters.some(p => p.name === 'threadId'));
    assert.ok(!model.routes.some(r => r.value === 'notAnEndpoint'));
});

test('server command resolves FQN class and actual branch/handler, not a matching short name', async t => {
    const env = await setup(t), doc = document(client, files[client]);
    const cls = await routeSources(env, doc, "action: 'read'", 'Client.request');
    assert.equal(cls.length, 1); assert.equal(cls[0].uri.fsPath, request);
    const read = await routeSources(env, doc, "action: 'read'", 'removeThread');
    assert.equal(read.length, 2); assert.ok(read.some(loc => document(request, files[request]).getText(loc.range) === 'removeThreadAndMessages'));
    const content = await routeSources(env, doc, "action: 'content'", 'copyFromWorkspace');
    assert.ok(content.some(loc => loc.uri.fsPath === operation));
    const named = await routeSources(env, doc, "action: 'action'", 'save');
    assert.equal(named.length, 2); assert.ok(named.some(loc => document(request, files[request]).getText(loc.range) === 'execute'));
    const unknown = document(client, "HttpRequest.send({request:'Request', action:'read', method:'removeThread'});");
    assert.equal((await routeSources(env, unknown, 'HttpRequest', 'removeThread')).length, 0);
});

test('dynamic selectors have class navigation but no guessed handler; hover explains limits and has no trusted commands', async t => {
    const text = "HttpRequest.send({request:'app.Request', action:'read', method: compute()});", doc = document(client, text);
    const env = await setup(t, { [client]: text });
    assert.equal((await routeSources(env, doc, 'HttpRequest', 'compute')).length, 0);
    assert.equal((await routeSources(env, doc, 'HttpRequest', 'app.Request')).length, 1);
    const hover = await env.providers.jsHover.provideHover(doc, positionOf(doc, 'HttpRequest', 'compute'), {});
    assert.match(hover.contents[0].value, /статически не подтверждён/);
    assert.notEqual(hover.contents[0].isTrusted, true);
    const broken = document(client, "HttpRequest.send({request:'app.Request', method:");
    assert.equal((await serverChoices(env, broken, broken.positionAt(35))).length, 0);
});

test('reverse clients are separate from BL references and ignore unrelated literals and routes', async t => {
    const env = await setup(t), doc = document(request, files[request]);
    const handler = positionOf(doc, 'private JsonArray removeThreadAndMessages', 'removeThreadAndMessages');
    const calls = await env.commands.get('bl.showClientCalls');
    assert.equal(typeof calls, 'function');
    // Use command as the UI entry point with the active BL editor.
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: handler } };
    env.vscode.window.createQuickPick = (() => { const create = env.vscode.window.createQuickPick; return () => { const picker = create(); picker.show = () => {}; return picker; }; })();
    const results = await env.commands.get('bl.showClientCalls')();
    assert.equal(results.length, 1); assert.equal(results[0].value, 'removeThread');
    const picker = env.guidPickers.at(-1);
    assert.match(picker.title, /\(1\)/); assert.equal(picker.busy, false);
    picker.accept(picker.items[0]); await new Promise(r => setImmediate(r));
    assert.equal(env.sourceOpens.at(-1).document.uri.fsPath, client);
    assert.equal(env.sourceOpens.at(-1).config.viewColumn, env.vscode.ViewColumn.Active);
    const refs = await env.providers.references.provideReferences(doc, handler, { includeDeclaration: false }, {});
    assert.ok(refs.every(ref => ref.uri.fsPath.endsWith('.bl')));
});

test('JS completions suggest confirmed routes and parameter keys with source, not required assumptions', async t => {
    const text = "HttpRequest.send({request:'app.Request', action:'content', method:'', workspaceId: id});", doc = document(client, text);
    const env = await setup(t, { [client]: text });
    const method = doc.positionAt(text.indexOf("method:''") + 8);
    const routes = await env.providers.jsCompletion.provideCompletionItems(doc, method, {});
    assert.deepEqual(normalized(routes.map(item => item.label)), ['copyFromWorkspace']);
    assert.equal(routes[0].insertText, 'copyFromWorkspace');
    const parameterText = "HttpRequest.send({request:'app.Request', action:'content', method:'copyFromWorkspace', });";
    const incomplete = document(client, parameterText);
    const params = await env.providers.jsCompletion.provideCompletionItems(incomplete, incomplete.positionAt(parameterText.indexOf(', }') + 2), {});
    assert.ok(params.some(item => item.label === 'workspaceId'));
    assert.match(params.find(item => item.label === 'workspaceId').documentation.value, /не установлены/);
});

test('unsaved JS and BL buffers invalidate forward and reverse routes immediately', async t => {
    const server = document(request, files[request]), browser = document(client, files[client]);
    const env = await setup(t, {}, [server, browser]);
    const before = await routeSources(env, browser, "action: 'read'", 'removeThread'); assert.equal(before.length, 2);
    Object.assign(server, document(request, files[request].replace('"removeThread"', '"renamed"'))); env.change(server);
    assert.equal((await routeSources(env, browser, "action: 'read'", 'removeThread')).length, 0);
    Object.assign(browser, document(client, files[client].replace("method: 'removeThread'", "method: 'renamed'"))); env.change(browser);
    assert.equal((await routeSources(env, browser, "action: 'read'", 'renamed')).length, 2);
    Object.assign(server, document(request, '\r\n' + files[request].replace('"removeThread"', '"renamed"'))); env.change(server);
    const shifted = await routeSources(env, browser, "action: 'read'", 'renamed');
    assert.ok(shifted.some(loc => loc.range.start.line === before[0].range.start.line + 1));
});

test('checkout isolation returns all ambiguous copies in the caller checkout, never another checkout', async t => {
    const other = '/workspace/other', copy = request.replace(root, other), otherBase = base.replace(root, other);
    const env = await setup(t, { [copy]: files[request], [otherBase]: files[base] }, [], { workspaceFolders: [root, other], checkoutRoots: [root, other] });
    const doc = document(client, files[client]);
    assert.ok((await routeSources(env, doc, "action: 'read'", 'removeThread')).every(loc => loc.uri.fsPath.startsWith(root + '/')));
    const outside = document('/elsewhere/Client.js', files[client]);
    assert.equal((await routeSources(env, outside, "action: 'read'", 'Client.request')).length, 0);
});

test('file changes/deletion, cancellation, exclusions and provider disposal do not leak stale targets', async t => {
    const env = await setup(t), doc = document(client, files[client]);
    assert.equal(env.providers.jsDefinition, undefined, 'native JS definitions are not overridden');
    env.contents.set(request, files[request].replace('"removeThread"', '"changed"')); await env.fileEvent('change', request);
    assert.equal((await routeSources(env, doc, "action: 'read'", 'removeThread')).length, 0);
    env.contents.delete(request); await env.fileEvent('delete', request);
    assert.equal((await routeSources(env, doc, "action: 'read'", 'Client.request')).length, 0);
    env.dispose();
    assert.equal((await routeSources(env, doc, "action: 'read'", 'removeThread')).length, 0);
});

test('ambiguous request classes stay selectable; unresolved or foreign imports cannot prove a route', async t => {
    const duplicate = `${root}/other/src/main/bl/app/Request.bl`;
    const duplicateText = files[request].replace('"removeThread"', '"another"');
    const env = await setup(t, { [duplicate]: duplicateText });
    const doc = document(client, files[client]);
    const classes = await routeSources(env, doc, "action: 'read'", 'Client.request');
    assert.equal(classes.length, 2);
    const remove = await routeSources(env, doc, "action: 'read'", 'removeThread');
    assert.ok(remove.every(loc => loc.uri.fsPath === request));
    const other = '/workspace/other';
    const foreignConstant = constants.replace(root, other);
    const env2 = await setup(t, { [constants]: 'public class Operation {}', [foreignConstant]: files[constants] }, [], { workspaceFolders: [root, other], checkoutRoots: [root, other] });
    assert.equal((await routeSources(env2, doc, "action: 'content'", 'copyFromWorkspace')).length, 0);
});

test('request completion inserts FQN only in the caller checkout, and action/name keep independent semantics', async t => {
    const env = await setup(t);
    for (const [field, expected] of [['request', 'app.Request'], ['action', 'read'], ['name', 'save']]) {
        const text = `HttpRequest.send({request:'app.Request', action:'action', ${field}:''});`, doc = document(client, text);
        const at = doc.positionAt(text.lastIndexOf(`${field}:''`) + field.length + 2);
        const results = await env.providers.jsCompletion.provideCompletionItems(doc, at, {});
        assert.ok(results.some(item => item.label === expected), field);
    }
    const incorrect = document(client, "HttpRequest.send({request:'app.Request', action:'read', name:'save'});");
    assert.equal((await routeSources(env, incorrect, 'HttpRequest', 'save')).length, 0);
    const noWorkbench = [...env.commands.keys()].filter(key => /openRequest|Workbench/i.test(key));
    assert.equal(noWorkbench.length, 0);
    assert.ok(!env.requiredModules.some(name => /^(?:node:)?(?:https?|net|tls|child_process)$/.test(name)));
});

test('nonvirtual getData, mutable selectors and nonfinal BL constants do not create endpoints', async t => {
    for (const transform of [
        text => text.replace('virtual protected JsonArray getData', 'public JsonArray getData'),
        text => text.replace('private final string Remove', 'private string Remove'),
        text => text.replace('if(method == Remove)', 'method = dynamic();\n        if(method == Remove)')
    ]) {
        const env = await setup(t, { [request]: transform(files[request]) });
        assert.equal((await routeSources(env, document(client, files[client]), "action: 'read'", 'removeThread')).length, 0);
    }
});

test('reverse lookup updates unsaved JS and finds operation classes without merging same-name text', async t => {
    const browser = document(client, files[client]), env = await setup(t, {}, [browser]);
    const doc = document(operation, files[operation]);
    const position = positionOf(doc, 'public class Copy', 'Copy');
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: position } };
    const create = env.vscode.window.createQuickPick;
    env.vscode.window.createQuickPick = () => { const picker = create(); picker.show = () => {}; return picker; };
    let calls = await env.commands.get('bl.showClientCalls')();
    assert.equal(calls.length, 1); assert.equal(calls[0].value, 'copyFromWorkspace');
    Object.assign(browser, document(client, files[client].replace("method: 'copyFromWorkspace'", "method: 'unknown'"))); env.change(browser);
    calls = await env.commands.get('bl.showClientCalls')(); assert.equal(calls.length, 0);
    const empty = env.guidPickers.at(-1); assert.equal(empty.busy, false); assert.match(empty.placeholder, /не найдено/);
});

test('an outdated client picker refuses navigation, and user cancellation closes pending search', async t => {
    const env = await setup(t), doc = document(request, files[request]);
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: positionOf(doc, 'private JsonArray removeThreadAndMessages', 'removeThreadAndMessages') } };
    const create = env.vscode.window.createQuickPick;
    env.vscode.window.createQuickPick = () => { const picker = create(); picker.show = () => {}; return picker; };
    const results = await env.commands.get('bl.showClientCalls')(); assert.equal(results.length, 1);
    const stale = env.guidPickers.at(-1);
    env.contents.set(client, files[client].replace("method: 'removeThread'", "method: 'unknown'")); await env.fileEvent('change', client);
    stale.accept(stale.items[0]); await new Promise(r => setImmediate(r));
    assert.equal(env.sourceOpens.length, 0); assert.ok(env.messages.some(m => /Исходники изменились/.test(m.message)));
    const pending = env.commands.get('bl.showClientCalls')(); env.guidPickers.at(-1).hide();
    assert.equal((await pending).length, 0);
});

test('reverse search follows inherited dispatchers and keeps dynamic-selector calls at dispatcher level only', async t => {
    const child = `${root}/app/src/main/bl/app/Child.bl`;
    const script = `${root}/app/src/main/js/Child.js`;
    const env = await setup(t, { [child]: 'public class Child extends Request {}', [script]: "HttpRequest.send({request:'app.Child', action:'read', method:dynamic});" });
    const doc = document(request, files[request]);
    const create = env.vscode.window.createQuickPick;
    env.vscode.window.createQuickPick = () => { const picker = create(); picker.show = () => {}; return picker; };
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: positionOf(doc, 'virtual protected JsonArray getData', 'getData') } };
    const dispatcher = await env.commands.get('bl.showClientCalls')();
    assert.ok(dispatcher.some(call => call.filePath === script && call.confidence === 'partial'));
    env.vscode.window.activeTextEditor.selection.active = positionOf(doc, 'private JsonArray removeThreadAndMessages', 'removeThreadAndMessages');
    const specific = await env.commands.get('bl.showClientCalls')();
    assert.ok(!specific.some(call => call.filePath === script));
});

test('JS discovery honors exclusions, creates/deletes, and unsaved excluded buffers; submodules share the outer checkout', async t => {
    const extra = `${root}/app/generated/Caller.js`, open = document(extra, "HttpRequest.send({request:'app.Request', action:'read', method:'removeThread'});");
    const env = await setup(t, { [extra]: open.getText() }, [], { configuration: { 'diagnostics.enabled': false, 'index.exclude': ['**/generated/**'] }, workspaceFolders: ['/workspace'], checkoutRoots: [root, root + '/app'] });
    const doc = document(request, files[request]);
    const create = env.vscode.window.createQuickPick;
    env.vscode.window.createQuickPick = () => { const picker = create(); picker.show = () => {}; return picker; };
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: positionOf(doc, 'private JsonArray removeThreadAndMessages', 'removeThreadAndMessages') } };
    assert.equal((await env.commands.get('bl.showClientCalls')()).length, 1);
    env.vscode.workspace.textDocuments.push(open); env.open(open);
    assert.equal((await env.commands.get('bl.showClientCalls')()).length, 2);
    env.close(open);
    const added = `${root}/app/src/main/js/Added.js`;
    env.contents.set(added, open.getText()); await env.fileEvent('create', added);
    assert.equal((await env.commands.get('bl.showClientCalls')()).length, 2);
    env.contents.delete(added); await env.fileEvent('delete', added);
    assert.equal((await env.commands.get('bl.showClientCalls')()).length, 1);
    env.configure({ 'index.exclude': ['**/*.js'] });
    assert.equal((await env.commands.get('bl.showClientCalls')()).length, 0);
});

test('Z8 short namespaces require explicit shortClassName, and single classes are not global static bindings', () => {
    const noAlias = parseJsRequests(files[client].replace("shortClassName: 'Client',", ''));
    assert.equal(noAlias.calls[0].fields.get('request').known, false);
    const full = parseJsRequests(files[client].replace("shortClassName: 'Client',", '').replace('request: Client.request', 'request: app.Client.request'));
    assert.equal(full.calls[0].fields.get('request').value, 'app.Request');
    const singleton = parseJsRequests(files[client].replace("shortClassName: 'Client',", "shortClassName: 'Client', single: true,"));
    assert.equal(singleton.calls[0].fields.get('request').known, false);
    assert.equal(parseJsRequests(files[client] + 'delete Client.request;').calls[0].fields.get('request').known, false);
});

test('generated target JS is always excluded, including open buffers and user-cleared excludes', async t => {
    const bundle = `${root}/target/web/bundle.js`, nested = `${root}/app/target/web/bundle.js`;
    const opened = document(bundle, files[client]);
    const env = await setup(t, { [bundle]: files[client], [nested]: files[client] }, [opened], { configuration: { 'diagnostics.enabled': false, 'index.exclude': [] } });
    const doc = document(request, files[request]);
    const create = env.vscode.window.createQuickPick;
    env.vscode.window.createQuickPick = () => { const picker = create(); picker.show = () => {}; return picker; };
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: positionOf(doc, 'private JsonArray removeThreadAndMessages', 'removeThreadAndMessages') } };
    const calls = await env.commands.get('bl.showClientCalls')();
    assert.equal(calls.length, 1); assert.equal(calls[0].filePath, client);
    assert.equal(env.readCounts.get(nested) || 0, 0);
    assert.equal((await routeSources(env, opened, "action: 'read'", 'removeThread')).length, 0);
    assert.equal((await env.providers.jsCompletion.provideCompletionItems(opened, positionOf(opened, "action: 'read'", 'removeThread'), {})).length, 0);
    assert.equal(await env.providers.jsHover.provideHover(opened, positionOf(opened, "action: 'read'", 'removeThread'), {}), null);
    const picker = env.guidPickers.at(-1);
    await env.fileEvent('change', nested); env.change(opened);
    picker.accept(picker.items[0]); await new Promise(r => setImmediate(r));
    assert.equal(env.sourceOpens.at(-1).document.uri.fsPath, client, 'bundle rebuilds do not stale developer results');
});

test('target exclusion is a workspace-relative build directory, not an ancestor or filename substring', async t => {
    const relocated = '/temporary/target/projects/clm';
    const mapped = Object.fromEntries(Object.entries(files).map(([file, text]) => [file.replace(root, relocated), text]));
    const env = await extension(mapped, [], { workspaceFolders: [relocated], checkoutRoots: [relocated], configuration: { 'diagnostics.enabled': false } });
    t.after(() => env.dispose());
    const doc = document(client.replace(root, relocated), files[client]);
    assert.equal((await routeSources(env, doc, "action: 'read'", 'removeThread')).length, 2);
});


test('server command works on keys and dynamic params, labels all source categories, and opens a tab without split', async t => {
    const env = await setup(t), doc = document(client, files[client]);
    assert.equal(env.providers.jsDefinition, undefined);
    for (const word of ['request', 'threadId', 'selected']) {
        const choices = await serverChoices(env, doc, positionOf(doc, "action: 'read'", word), true);
        assert.deepEqual(normalized(choices.map(item => item.kind)), ['class', 'dispatcher', 'branch', 'handler']);
        assert.ok(choices.every(item => item.detail.includes(request) && /маршрут подтверждён/.test(item.detail)));
        const picker = env.guidPickers.at(-1);
        assert.equal(picker.busy, false); assert.match(picker.title, /\(4\)/);
        assert.ok(choices.some(item => /Обработчик: removeThreadAndMessages/.test(item.label)));
        if (word !== 'selected') { picker.hide(); continue; }
        picker.accept(choices.find(item => item.kind === 'handler'));
        await new Promise(r => setImmediate(r));
        const opened = env.sourceOpens.at(-1);
        assert.equal(opened.document.uri.fsPath, request);
        assert.equal(opened.document.getText(opened.config.selection), 'removeThreadAndMessages');
        assert.equal(opened.config.viewColumn, env.vscode.ViewColumn.Active);
        assert.equal(opened.config.preview, false);
    }
    const content = await serverChoices(env, doc, positionOf(doc, "action: 'content'", 'workspaceId'));
    assert.ok(content.some(item => item.kind === 'dispatcher' && item.label === 'Диспетчер: processContentRequest'));
    assert.ok(content.some(item => item.kind === 'dispatcher' && item.label === 'Диспетчер: getOperation'));
    const hover = await env.providers.jsHover.provideHover(doc, positionOf(doc, "action: 'read'", 'removeThread'), {});
    assert.match(hover.contents[0].value, /ПКМ.*Найти серверные/);
    assert.doesNotMatch(hover.contents[0].value, /F12/);
});

test('server command explains invalid contexts, syntax errors, unresolved classes and partial routes', async t => {
    const env = await setup(t);
    const doc = document(client, files[client]);
    assert.equal((await serverChoices(env, doc, positionOf(doc, 'const unrelated', 'unrelated'))).length, 0);
    assert.match(env.messages.at(-1).message, /внутри объекта запроса/);
    const invalid = document(client, "HttpRequest.send({request:'app.Request', method:");
    assert.equal((await serverChoices(env, invalid, invalid.positionAt(40))).length, 0);
    assert.match(env.messages.at(-1).message, /синтаксис/);
    const dynamic = document(client, "HttpRequest.send({request:'app.Request', action:'read', method:dynamic});");
    const choices = await serverChoices(env, dynamic, positionOf(dynamic, 'HttpRequest', 'dynamic'), true);
    assert.deepEqual(normalized(choices.map(item => item.kind)), ['class', 'dispatcher']);
    assert.match(env.guidPickers.at(-1).placeholder, /статически не подтверждён/);
    env.guidPickers.at(-1).hide();
    const unknown = document(client, 'HttpRequest.send({request:dynamic});');
    assert.equal((await serverChoices(env, unknown, positionOf(unknown, 'HttpRequest', 'dynamic'), true)).length, 0);
    assert.match(env.guidPickers.at(-1).placeholder, /не разрешён.*динамические/);
    env.guidPickers.at(-1).hide();
    assert.equal((await serverChoices(env, doc, positionOf(doc, "action: 'read'", 'threadId'), false, env.vscode.Uri.file('/elsewhere/Other.js'))).length, 0);
    assert.match(env.messages.at(-1).message, /исходном JavaScript/);
});

test('server picker rejects stale choices and does not open a target after cancellation', async t => {
    const doc = document(client, files[client]), env = await setup(t, {}, [doc]);
    const choices = await serverChoices(env, doc, positionOf(doc, "action: 'read'", 'threadId'), true, doc.uri);
    const stale = env.guidPickers.at(-1);
    Object.assign(doc, document(client, files[client].replace("method: 'removeThread'", "method: 'unknown'"))); env.change(doc);
    stale.accept(choices.find(item => item.kind === 'handler')); await new Promise(r => setImmediate(r));
    assert.equal(env.sourceOpens.length, 0); assert.match(env.messages.at(-1).message, /Исходники изменились/);
    const create = env.vscode.window.createQuickPick;
    env.vscode.window.createQuickPick = () => { const picker = create(); picker.show = () => picker.hide(); return picker; };
    env.vscode.window.activeTextEditor = { document: doc, selection: { active: positionOf(doc, "action: 'read'", 'threadId') } };
    assert.equal((await env.commands.get('bl.showServerSources')()).length, 0);
    assert.equal(env.sourceOpens.length, 0);
});
