const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { document, positionOf, extension } = require('./helpers');
const root = path.resolve(process.argv[2] || '../pro.doczilla.clm');
const files = {};
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['.git', '.gradle', '.java', 'node_modules', 'build', 'tmp'].includes(entry.name) || entry.name === 'data' && dir === root) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(bl|js)$/.test(file)) files[file] = fs.readFileSync(file, 'utf8');
    }
}
walk(root);
const gpt = path.join(root, 'pro.doczilla.cloud.gpt');
const js = tail => path.join(gpt, 'src/main/js/doczilla', tail);
const bl = tail => path.join(gpt, 'src/main/bl', tail);
(async () => {
    const env = await extension(files, [], { workspaceFolders: [root], checkoutRoots: [root], configuration: { 'diagnostics.enabled': false } });
    env.vscode.window.createQuickPick = (() => { const original = env.vscode.window.createQuickPick; return () => { const picker = original(); picker.show = () => {}; return picker; }; })();
    let checks = 0;
    try {
        for (const [client, line, word, target, targetWord] of [
            [js('scenario/variables/File.js'), "method: 'copyFromWorkspace'", 'copyFromWorkspace', bl('pro/doczilla/gpt/attachment/operation/CopyFromWorkspace.bl'), 'CopyFromWorkspace'],
            [js('analyzer/Analyzer.js'), "method: 'anonymize'", 'anonymize', bl('pro/doczilla/analyzer/Analyzer.bl'), 'processAnonymize'],
            [js('gpt/GPT.js'), "method: 'removeThread'", 'removeThread', bl('pro/doczilla/gpt/messages/action/MessageAction.bl'), 'removeThreadAndMessages'],
            [js('gpt/GPT.js'), "method: 'getCompactions'", 'getCompactions', bl('pro/doczilla/gpt/messages/action/MessageAction.bl'), 'getCompactions'],
            [js('gpt/chat/userAssistant/data/Model.js'), "name: 'saveOrDeleteAssistantAction'", 'saveOrDeleteAssistantAction', bl('pro/doczilla/gpt/assistants/table/UserAssistant.bl'), 'execute'],
            [js('gpt/GPT.js'), "method: 'getDefaultModel'", 'GPT.request', bl('pro/doczilla/gpt/Gpt.bl'), 'Gpt']
        ]) {
            assert.ok(files[client], client); assert.ok(files[target], target);
            const doc = document(client, files[client]);
            env.vscode.window.activeTextEditor = { document: doc, selection: { active: positionOf(doc, line, word) } };
            const choices = await env.commands.get('bl.showServerSources')(doc.uri);
            const result = choices.map(item => item.location);
            env.guidPickers.at(-1).hide();
            assert.ok(result.some(loc => loc.uri.fsPath === target && document(target, files[target]).getText(loc.range) === targetWord), `${path.basename(client)}:${word} -> ${targetWord}`);
            checks++;
        }
        const server = bl('pro/doczilla/gpt/messages/action/MessageAction.bl');
        const doc = document(server, files[server]);
        env.vscode.window.activeTextEditor = { document: doc, selection: { active: positionOf(doc, 'public void removeThreadAndMessages', 'removeThreadAndMessages') } };
        const start = performance.now();
        const calls = await env.commands.get('bl.showClientCalls')();
        assert.ok(calls.some(call => call.filePath === js('gpt/GPT.js') && call.value === 'removeThread'));
        assert.ok(calls.every(call => call.value === 'removeThread'));
        assert.equal(calls.length, 1, 'source-only search excludes generated copies');
        checks++;
        console.log(`CLM JS↔BL: ${checks} command checks; removeThreadAndMessages -> ${calls.length} confirmed JS calls (${Math.round(performance.now() - start)} ms); ${Object.keys(files).filter(f => f.endsWith('.js')).length} JS files in fixture, target/ excluded from discovery`);
    } finally { env.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
