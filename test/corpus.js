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
    const env = await extension(files);
    let checked = 0;
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
            await check(doc, { line: member.line, character: member.column }, info.filePath, member.line);
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
        const before = performance.now();
        const refs = await env.providers.references.provideReferences(doc, positionOf(doc, 'Dadata.initialize()', 'initialize'), { includeDeclaration: false }, {});
        assert.ok(refs.length > 0);
        assert.ok(refs.every(ref => ref.uri.fsPath.startsWith(clm + path.sep)), 'References must stay in the selected checkout');
        console.log(`CLM initialize references: ${refs.length}, ${Math.round(performance.now() - before)} ms`);
    }
    console.log(`Corpus: ${Object.keys(files).length} BL files, ${infos.length} indexed classes, ${checked} definition checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
