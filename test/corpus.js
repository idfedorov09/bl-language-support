const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BlIndex, parseBlContent } = require('../blIndex');
const { document, positionOf, extension } = require('./helpers');

const roots = process.argv.slice(2).map(root => path.resolve(root));
if (!roots.length) throw new Error('Usage: node test/corpus.js <checkout> [<checkout> ...]');
const files = {};
function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['.git', '.java', 'node_modules', 'build', 'data', 'tmp'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.bl')) files[file] = fs.readFileSync(file, 'utf8');
    }
}
for (const root of roots) walk(root);

async function main() {
    const index = new BlIndex();
    const infos = [];
    for (const [file, text] of Object.entries(files)) {
        const info = parseBlContent(file, text);
        if (info) {
            index.addClass(info);
            infos.push(info);
        }
    }
    const env = await extension(files, [], { workspaceFolders: roots, checkoutRoots: roots });
    let checked = 0;
    let guidCards = 0;
    let guidConstants = 0;
    async function check(doc, position, expectedFile, expectedLine) {
        const result = await env.providers.definition.provideDefinition(doc, position, {});
        const locations = Array.isArray(result) ? result : result ? [result] : [];
        assert.ok(locations.some(location => location.uri.fsPath === expectedFile && location.range.start.line === expectedLine),
            `${doc.uri.fsPath}:${position.line + 1}:${position.character + 1} -> ${expectedFile}:${expectedLine + 1}`);
        checked++;
    }
    for (const info of infos) {
        const doc = document(info.filePath, files[info.filePath]);
        await check(doc, { line: info.classLine, character: info.classColumn }, info.filePath, info.classLine);
        for (const member of [...info.methods.values(), ...info.members.values()].slice(0, 8)) {
            const overridden = index.findOverriddenMethod(info, member);
            await check(doc, { line: member.line, character: member.column },
                overridden ? overridden.owner.filePath : info.filePath,
                overridden ? overridden.method.line : member.line);
        }
        for (const record of [...info.recordDeclarations, ...info.guidConstants]) {
            if (!record.guid) continue;
            assert.equal(files[info.filePath].slice(record.guidOffset, record.guidEndOffset), record.guidLiteral);
            await check(doc, { line: record.guidLine, character: record.guidColumn }, info.filePath, record.line);
            // The corpus check uses the same command and source context as a
            // user lookup, but only a mock editor: no UI/runtime is launched.
            env.vscode.window.showQuickPick = async items => items.find(item => item.match
                && item.match.owner.filePath === info.filePath && item.match.record.offset === record.offset);
            const model = await env.commands.get('bl.lookupGuid')({ guid: record.guidLiteral, sourceUri: doc.uri });
            assert.ok(model, `GUID card is missing for ${info.fullName}.${record.name}`);
            assert.equal(model.name, record.name);
            assert.equal(model.kind, record.kind);
            assert.ok(index.getGuidDeclarations(record.guid).some(item => item.owner === info && item.record === record));
            assert.equal(model.owner, info.fullName);
            assert.equal(model.guid, record.guid);
            assert.equal(model.source.filePath, info.filePath);
            assert.equal(model.source.line, record.line);
            assert.equal(model.attributes.length, record.attributes.length);
            assert.ok(env.panels.at(-1).webview.html.includes(record.guid));
            const runtimeRequest = model.attributes.some(attribute => attribute.name === 'requestId' && /new AiAttachment\.getClassKey\(\)/.test(attribute.value));
            if (runtimeRequest) {
                assert.ok(model.related.some(related => related.label.startsWith('roleId:') && related.name === 'User'));
                assert.ok(!model.related.some(related => related.label.startsWith('requestId:')), 'runtime class key is not a static record GUID');
            }
            if (record.kind === 'constant') guidConstants++;
            else guidCards++;
            env.panels.at(-1).dispose();
        }
    }
    const clm = roots.find(root => path.basename(root) === 'pro.doczilla.clm');
    if (clm) {
        const file = path.join(clm, 'pro.doczilla.cloud.core/src/main/bl/pro/doczilla/SchemaGenerator.bl');
        const doc = document(file, files[file]);
        for (const [line, word, targetClass, targetMethod, occurrence] of [
            ['extends ru.doczilla.SchemaGenerator', 'SchemaGenerator', 'ru.doczilla.SchemaGenerator', null, 1],
            ['super.afterFinish()', 'afterFinish', 'ru.doczilla.SchemaGenerator', 'afterFinish'],
            ['Dadata.initialize()', 'initialize', 'pro.doczilla.dictionary.dadata.Dadata', 'initialize']
        ]) {
            const target = index.getClassByFullName(targetClass, index.getClassByFile(file));
            await check(doc, positionOf(doc, line, word, occurrence || 0), target.filePath, targetMethod ? target.methods.get(targetMethod).line : target.classLine);
        }
        const messageFile = path.join(clm, 'pro.doczilla.cloud.gpt/src/main/bl/pro/doczilla/gpt/messages/action/MessageAction.bl');
        const messageDoc = document(messageFile, files[messageFile]);
        const methodName = 'validateNativeCompaction';
        const messageClass = index.getClassByFile(messageFile);
        const method = messageClass.methods.get(methodName);
        assert.ok(method, 'MessageAction compaction validator is indexed');
        const declaration = new env.vscode.Position(method.line, method.column + 10);
        const self = await env.providers.definition.provideDefinition(messageDoc, declaration, {});
        const selfLocations = Array.isArray(self) ? self : [self];
        assert.equal(selfLocations.length, 1);
        assert.equal(messageDoc.getText(selfLocations[0].range), methodName, 'declaration must cover the entire clicked identifier');
        assert.ok(selfLocations[0].range.start.character <= declaration.character && declaration.character < selfLocations[0].range.end.character);
        const call = positionOf(messageDoc, 'validateNativeCompaction(kind, payload);', methodName);
        await check(messageDoc, call, messageFile, method.line);
        const methodRefs = await env.providers.references.provideReferences(messageDoc, declaration, { includeDeclaration: false }, {});
        assert.ok(methodRefs.some(ref => ref.uri.fsPath === messageFile && ref.range.start.line === call.line));
        assert.ok(!methodRefs.some(ref => ref.uri.fsPath === messageFile && ref.range.start.line === method.line));
        for (const ref of methodRefs) {
            const refDoc = document(ref.uri.fsPath, files[ref.uri.fsPath]);
            assert.equal(refDoc.getText(ref.range), methodName);
        }
        console.log(`CLM MessageAction.${methodName}: declaration ${method.line + 1}, call ${call.line + 1}, ${methodRefs.length} references passed`);
        const dataMethod = messageClass.methods.get('getData');
        const dataPosition = new env.vscode.Position(dataMethod.line, dataMethod.column + 2);
        const dataTargets = await env.providers.definition.provideDefinition(messageDoc, dataPosition, {});
        const dataLocations = Array.isArray(dataTargets) ? dataTargets : [dataTargets];
        const object = index.getClassByFullName('org.zenframework.z8.lang.Object', messageClass);
        assert.equal(dataLocations.length, 1);
        assert.equal(dataLocations[0].uri.fsPath, object.filePath);
        assert.equal(dataLocations[0].range.start.line, object.methods.get('getData').line);
        assert.equal(document(object.filePath, files[object.filePath]).getText(dataLocations[0].range), 'getData');
        const dataRefs = await env.providers.references.provideReferences(messageDoc, dataPosition, { includeDeclaration: false }, {});
        assert.equal(dataRefs.length, 0, 'runtime Java dispatch is not a direct BL reference to this override');
        const dataDeclarations = await env.providers.references.provideReferences(messageDoc, dataPosition, { includeDeclaration: true }, {});
        assert.equal(dataDeclarations.length, 1);
        assert.equal(dataDeclarations[0].uri.fsPath, messageFile);
        assert.equal(dataDeclarations[0].range.start.line, dataMethod.line);
        console.log(`CLM MessageAction.getData: declaration ${dataMethod.line + 1} -> Object.getData ${object.methods.get('getData').line + 1}, direct BL references ${dataRefs.length} passed`);

        const before = performance.now();
        const refs = await env.providers.references.provideReferences(doc, positionOf(doc, 'Dadata.initialize()', 'initialize'), { includeDeclaration: false }, {});
        assert.ok(refs.length > 0);
        assert.ok(refs.every(ref => ref.uri.fsPath.startsWith(clm + path.sep)), 'References must stay in the selected checkout');
        console.log(`CLM initialize references: ${refs.length}, ${Math.round(performance.now() - before)} ms`);
    }
    console.log(`Corpus: ${Object.keys(files).length} BL files, ${infos.length} indexed classes, ${checked} definition checks, ${guidCards} records GUID cards and ${guidConstants} GUID constant cards passed`);
    env.dispose();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
