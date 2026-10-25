const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { document, extension } = require('./helpers');

const root = path.resolve(process.argv[2] || '../pro.doczilla.clm');
const files = {};
function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['.git', '.java', 'node_modules', 'build', 'target', 'data', 'tmp'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.bl')) files[file] = fs.readFileSync(file, 'utf8');
    }
}
walk(root);

async function main() {
    const env = await extension(files, [], { workspaceFolders: [root], checkoutRoots: [root] });
    const gpt = 'pro.doczilla.cloud.gpt/src/main/bl/pro/doczilla/gpt/';
    let checks = 0;
    async function check(relative, needle, prefix, expected, absent = []) {
        const file = path.join(root, relative), text = files[file];
        assert.equal(typeof text, 'string', `Missing CLM source: ${relative}`);
        const start = text.indexOf(needle);
        assert.ok(start >= 0, `Missing corpus expression: ${needle}`);
        const caret = start + prefix.length;
        const doc = document(file, text), disk = files[file];
        const list = await env.providers.completion.provideCompletionItems(doc, doc.positionAt(caret), {});
        const items = list.items || list;
        for (const name of expected) assert.ok(items.some(item => item.label === name), `${relative}: ${prefix} -> ${name}`);
        for (const name of absent) assert.ok(!items.some(item => item.label === name), `${relative}: unexpected ${name}`);
        for (const item of items) {
            assert.equal(item.command, undefined); assert.equal(item.additionalTextEdits, undefined);
            assert.equal(item.documentation.isTrusted, false); assert.equal(typeof item.insertText, 'string');
        }
        assert.equal(files[file], disk); assert.equal(env.contents.get(file), disk);
        assert.equal(env.appliedEdits.length, 0);
        console.log(`${path.basename(relative)}:${doc.positionAt(caret).line + 1} ${prefix} -> ${expected.join(', ')}`);
        checks++;
    }
    try {
        await check(gpt + 'messages/action/MessageAction.bl', 'thread.readRecord', 'thread.',
            ['threadId', 'models', 'messageCount', 'readRecord', 'readFirst', 'next', 'recordId'], ['beforeDestroy']);
        await check('pro.doczilla.base.core/src/main/bl/ru/doczilla/workspace/file/XFile.bl',
            'documents[i].getDocumentId', 'documents[i].get', ['getDocumentId', 'getDotxDocumentId', 'getName', 'getUserId']);
        await check('pro.doczilla.base.workflow/src/main/bl/pro/doczilla/workflow/automation/AutomationParser.bl',
            'automation.parameters[name].getValue', 'automation.parameters[name].', ['getValue', 'getType', 'setValue', 'text']);
        await check(gpt + 'assistants/table/UserAssistant.bl', 'container.saveOrDeleteAssistant', 'container.',
            ['saveOrDeleteAssistant', 'assistant', 'assistantId', 'userId', 'readRecord']);
        await check(gpt + 'workspace/table/Workspace.bl', 'super.getOperation', 'super.get',
            ['getOperation', 'getFields']);
        await check(gpt + 'workspace/table/Workspace.bl', 'new CreateTemporary', 'new Cr', ['CreateTemporary']);
        await check(gpt + 'workspace/table/Workspace.bl', 'import pro.doczilla.gpt.workspace.operation.CreateTemporary',
            'import pro.doczilla.gpt.workspace.operation.',
            ['pro.doczilla.gpt.workspace.operation.CreateTemporary', 'pro.doczilla.gpt.workspace.operation.RiskCheck']);
        console.log(`Completion corpus: ${Object.keys(files).length} BL sources, ${checks} real CLM contexts passed (mock editor; no disk edits/UI/runtime)`);
    } finally { env.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
