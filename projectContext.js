const fs = require('fs');
const path = require('path');
const { sanitizeText } = require('./blIndex');

const within = (file, root) => {
    const relative = path.relative(root, file);
    return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
};

// Deliberately not a Gradle interpreter. Only unconditional, top-level literal
// includes are evidence. Never execute a build script to discover its sources.
function parseSettings(text) {
    const clean = sanitizeText(text, false);
    const masked = sanitizeText(text);
    const modules = [], builds = [], issues = [], remaps = new Map();
    let depth = 0, remapCount = 0;
    const lines = clean.split(/\r?\n/), code = masked.split(/\r?\n/);
    for (let line = 0; line < lines.length; line++) {
        const value = lines[line].trim();
        if (/\bprojectDir\b/.test(code[line])) remapCount++;
        if (depth === 0 && /^(?:include\b|includeBuild\b|project\s*\()/.test(code[line].trim())) {
            const remap = /^project\(\s*(['"])(:[\w:.-]+)\1\s*\)\.projectDir\s*=\s*file\(\s*(['"])([^'"$\\]+)\3\s*\)\s*;?$/.exec(value);
            if (remap) remaps.set(remap[2].replace(/^:/, ''), remap[4]);
            else {
                const statement = /^(includeBuild|include)\s*(?:\((.*)\)|(\s+.*?))\s*;?$/.exec(value);
                const args = statement && (statement[2] ?? statement[3]).trim().replace(/;$/, '').trim();
                if (args && /^(['"])[\w:./-]+\1(?:\s*,\s*(['"])[\w:./-]+\2)*$/.test(args)) {
                    const values = [...args.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
                    if (statement[1] === 'includeBuild' && values.length === 1) builds.push(values[0]);
                    else if (statement[1] === 'include') modules.push(...values.map(name => name.replace(/^:/, '')));
                    else issues.push(`Строка ${line + 1}: неподдерживаемый includeBuild`);
                } else issues.push(`Строка ${line + 1}: динамическая/неподдерживаемая конфигурация Gradle`);
            }
        } else if (/\b(?:include|includeBuild|projectDir)\b/.test(code[line]) && depth > 0) {
            issues.push(`Строка ${line + 1}: условная/вложенная конфигурация Gradle не вычисляется`);
        }
        for (const ch of code[line]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    }
    // An unparsed remap must not silently resolve to the default directory.
    if (remapCount > remaps.size) {
        issues.push('Не удалось разрешить projectDir; автоматическое расширение отключено для этой сборки');
        return { modules: [], builds: [], issues };
    }
    return { modules: [...new Set(modules)].map(name => remaps.get(name) || name.replace(/:/g, path.sep)), builds, issues };
}

function createProjectContext(vscode) {
    let contexts = [], watchers = [];
    const read = async file => {
        const open = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.fsPath === file);
        if (open) return open.getText();
        try { return await fs.promises.readFile(file, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
    };
    async function discover() {
        const result = [], metadata = new Set();
        for (const folder of vscode.workspace.workspaceFolders || []) {
            const workspace = folder.uri.fsPath;
            const base = { workspace, root: workspace, modules: [], edges: [], issues: [] };
            result.push(base);
            if (vscode.workspace.isTrusted === false || !vscode.workspace.getConfiguration('bl').get('index.autoProjectContext', true)) continue;
            // A directory .git is a repository boundary. A submodule's .git
            // pointer may be crossed, but an unrelated worktree may not.
            for (let current = workspace, level = 0; level < 8; level++, current = path.dirname(current)) {
                const graph = { workspace, root: current, modules: [], edges: [], issues: [] };
                const visited = new Set();
                const canonicalRoot = await fs.promises.realpath(current).catch(() => null);
                async function visit(directory, parent = null) {
                    if (!within(directory, current) || visited.has(directory)) return;
                    if (visited.size >= 256) { graph.issues.push('Превышен лимит 256 модулей Gradle'); return; }
                    const canonical = await fs.promises.realpath(directory).catch(() => null);
                    if (!canonicalRoot || !canonical || !within(canonical, canonicalRoot)) {
                        graph.issues.push(`Недоступный или внешний путь: ${directory}`); return;
                    }
                    visited.add(directory);
                    graph.modules.push(directory);
                    if (parent) graph.edges.push({ from: parent, to: directory });
                    const names = ['settings.gradle', 'settings.gradle.kts'];
                    const settings = [];
                    for (const name of names) {
                        const file = path.join(directory, name);
                        metadata.add(file);
                        const text = await read(file);
                        if (text !== null) settings.push({ file, text });
                    }
                    if (settings.length > 1) { graph.issues.push(`Неоднозначные settings.gradle/settings.gradle.kts: ${directory}`); return; }
                    if (!settings.length) return;
                    const parsed = parseSettings(settings[0].text);
                    graph.issues.push(...parsed.issues.map(issue => `${settings[0].file}: ${issue}`));
                    for (const relative of [...parsed.modules, ...parsed.builds]) {
                        const child = path.resolve(directory, relative);
                        if (path.isAbsolute(relative) || !within(child, current)) { graph.issues.push(`Внешняя зависимость не подключена: ${relative}`); continue; }
                        await visit(child, directory);
                    }
                }
                await visit(current);
                // The opened directory must be an explicitly declared module,
                // not merely happen to live below a settings file.
                if (graph.modules.includes(workspace) && graph.edges.length) {
                    Object.assign(base, graph);
                    // Keep looking for an outer composite only across submodules.
                } else base.issues.push(...graph.issues);
                if (fs.existsSync(path.join(current, '.git'))) {
                    const pointer = await read(path.join(current, '.git')).catch(() => null);
                    if (!pointer || !/^gitdir:.*[\\/]modules[\\/]/m.test(pointer)) break;
                }
                if (current === path.dirname(current)) break;
            }
        }
        return { contexts: result, metadata: [...metadata] };
    }
    function contextFor(uri) {
        if (!uri || uri.scheme !== 'file') return null;
        return contexts.filter(context => context.modules.length && context.modules.some(module => within(uri.fsPath, path.join(module, 'src')))
            || within(uri.fsPath, context.workspace)).sort((a, b) => b.workspace.length - a.workspace.length)[0] || null;
    }
    function rootFor(uri) {
        const context = contextFor(uri);
        if (context?.edges.length) return context.root;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return null;
        const root = folder.uri.fsPath;
        let checkout = null;
        for (let directory = path.dirname(uri.fsPath); within(directory, root); directory = path.dirname(directory)) {
            if (fs.existsSync(path.join(directory, '.git'))) checkout = directory;
            if (directory === root || directory === path.dirname(directory)) break;
        }
        return checkout || root;
    }
    function excluded(uri) {
        const folder = vscode.workspace.getWorkspaceFolder(uri), context = contextFor(uri);
        const root = folder?.uri.fsPath || context?.root;
        if (!root) return true;
        return vscode.workspace.getConfiguration('bl').get('index.exclude', ['**/node_modules/**', '**/.git/**', '**/build/**'])
            .some(pattern => vscode.languages.match({ scheme: 'file', pattern: new vscode.RelativePattern(root, pattern) }, { uri, languageId: 'bl' }) > 0);
    }
    return {
        discover, contextFor, rootFor, excluded,
        async safeSource(uri) {
            if (vscode.workspace.getWorkspaceFolder(uri)) return true;
            const context = contextFor(uri);
            if (!context || excluded(uri)) return false;
            const [file, root] = await Promise.all([fs.promises.realpath(uri.fsPath), fs.promises.realpath(context.root)]).catch(() => []);
            return Boolean(file && root && within(file, root));
        },
        commit(snapshot, onBl, onSettings) {
            contexts = snapshot.contexts;
            for (const watcher of watchers) watcher.dispose();
            watchers = [];
            const external = new Set(contexts.flatMap(context => context.edges.length ? context.modules : [])
                .filter(module => !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path.join(module, 'src', 'probe.bl')))));
            for (const module of external) {
                const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(module, 'src/**/*.bl'));
                watcher.onDidCreate(uri => onBl('create', uri)); watcher.onDidChange(uri => onBl('change', uri)); watcher.onDidDelete(uri => onBl('delete', uri));
                watchers.push(watcher);
            }
            for (const file of snapshot.metadata) {
                const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file), path.basename(file)));
                watcher.onDidCreate(onSettings); watcher.onDidChange(onSettings); watcher.onDidDelete(onSettings); watchers.push(watcher);
            }
        },
        dispose() { for (const watcher of watchers) watcher.dispose(); watchers = []; contexts = []; }
    };
}

module.exports = { parseSettings, createProjectContext };
