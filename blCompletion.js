const path = require('path');
const { BlIndex, getBlFileContext } = require('./blIndex');
const { completionContext: localizationContext } = require('./localizationCompletion');

const MAX_ITEMS = 200;
const PRIMARY_TYPES = new Set(['void', 'bool', 'int', 'decimal', 'string', 'guid', 'date', 'datespan', 'binary', 'primary', 'any']);
function methodKey(lookup, owner, declaration) {
    if (!declaration.parameterTypes) return `${declaration.name}:unknown:${owner.filePath}:${declaration.line}`;
    return `${declaration.name}:${declaration.parameterTypes.map(type => type.replace(/[A-Za-z_][\w.]*/g, name => {
        if (PRIMARY_TYPES.has(name)) return name;
        const types = lookup.resolveClassName(owner, name);
        return types.length === 1 ? types[0].fullName : `${owner.filePath}:${name}`;
    })).join(',')}`;
}

// A view of the existing declarations, not a second parser or file discovery.
// Unlike legacy navigation, unknown or tied dependencies stay unknown here.
class CompletionIndex extends BlIndex {
    getClassByFullName(name, context) {
        const copies = this.classesByFullName.get(name);
        const nearby = copies ? this.preferNearbyClasses(context, [...copies.values()]) : [];
        return nearby.length === 1 ? nearby[0] : null;
    }
    resolveClassName(context, name) {
        if (!name) return [];
        const exact = fullName => {
            const info = this.getClassByFullName(fullName, context);
            return info ? [info] : [];
        };
        if (name.includes('.')) return exact(name);
        if (context) {
            const imported = context.imports.find(imp => imp === name || imp.endsWith('.' + name));
            if (imported) return exact(imported);
            const local = context.packageName ? context.packageName + '.' + name : name;
            // An ambiguous same-package declaration still shadows unrelated
            // short names. Do not drop its copies before selecting proximity.
            if (this.classesByFullName.has(local)) return exact(local);
        }
        const names = this.classesByShortName.get(name);
        const copies = names ? [...names].flatMap(fullName => [...this.classesByFullName.get(fullName).values()]) : [];
        return this.preferNearbyClasses(context, copies);
    }
    resolveTypeName(context, name) {
        const candidates = super.resolveTypeName(context, name);
        return candidates.length === 1 ? candidates : [];
    }
    resolveBaseClass(info) { return info?.isInline ? info.baseInfo : info?.className ? super.resolveBaseClass(info, true) : null; }
    methodDeclarations(info, name) {
        const result = [], seen = new Set(), signatures = new Set();
        for (let owner = info; owner && !seen.has(owner.filePath); owner = this.resolveBaseClass(owner)) {
            seen.add(owner.filePath);
            const method = owner.methods.get(name);
            for (const declaration of method ? method.overloads || [method] : []) {
                const key = methodKey(this, owner, declaration);
                if (!signatures.has(key)) { signatures.add(key); result.push({ owner, declaration }); }
            }
        }
        return result;
    }
}

function completionSite(analysis, position, services) {
    if (!analysis.isCodePosition(position)) return null;
    const raw = (analysis.rawLines || (analysis.rawLines = analysis.text.split(/\r?\n/)))[position.line];
    const line = analysis.cleanLines[position.line];
    let start = position.character, end = position.character;
    while (start > 0 && /\w/.test(raw[start - 1])) start--;
    while (end < raw.length && /\w/.test(raw[end])) end++;
    // cleanLines additionally masks declaration attributes; do not complete their names.
    const previous = raw.slice(0, position.character).search(/\S\s*$/);
    if (raw.slice(start, position.character) !== line.slice(start, position.character)
        || previous >= 0 && raw[previous] !== line[previous]) return null;
    const prefix = raw.slice(start, position.character);
    if (prefix && !/^[A-Za-z_]\w*$/.test(prefix)) return null;
    const before = line.slice(0, position.character);
    const imp = /^\s*import\s+([\w.]*)$/.exec(before);
    if (imp) {
        const pathStart = position.character - imp[1].length;
        while (end < raw.length && /[\w.]/.test(raw[end])) end++;
        return { mode: 'import', prefix: imp[1], start: pathStart, end };
    }
    const fresh = /\bnew\s+([\w.]*)$/.exec(before);
    let classEnd = end;
    if (fresh) while (classEnd < raw.length && /[\w.]/.test(raw[classEnd])) classEnd++;
    const classSite = fresh ? { mode: 'new', prefix: fresh[1], start: position.character - fresh[1].length, end: classEnd } : null;
    let chainLine = line, chainStart = start;
    const continuation = services.buildContinuationText(analysis.cleanLines, position.line, start);
    if (continuation) { chainLine = continuation.combined; chainStart = continuation.wordStart; }
    if (/\.\s*$/.test(chainLine.slice(0, chainStart))) {
        const receiver = chainLine.slice(0, chainStart);
        const trimmedLength = receiver.trimEnd().length;
        const chain = services.findChainsInLine(receiver, true)
            .filter(item => item.end >= trimmedLength && item.segments.every(segment => segment.complete !== false))
            .sort((a, b) => a.start - b.start)[0];
        if (chain) return { mode: 'member', prefix, start, end, segments: chain.segments,
            forceClass: services.isNewKeywordBefore(receiver, chain.start), classSite };
        return classSite;
    }
    return classSite || { mode: 'general', prefix, start, end };
}

function createBlCompletion(vscode, services, localization) {
    const { index, ensureIndexReady, updateIndexFromDocument, getAnalysis, getRevision } = services;
    let disposed = false;
    const views = new Map();
    const rootFor = uri => services.analysisRootFor ? services.analysisRootFor(uri) : localization.rootFor(uri);
    function excluded(uri) {
        if (services.analysisExcluded) return services.analysisExcluded(uri);
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return true;
        const patterns = vscode.workspace.getConfiguration('bl').get('index.exclude', ['**/node_modules/**', '**/.git/**', '**/build/**']);
        return patterns.some(pattern => vscode.languages.match({ scheme: 'file', pattern: new vscode.RelativePattern(folder.uri.fsPath, pattern) },
            { uri, languageId: 'bl' }) > 0);
    }
    function scopedIndex(root) {
        const cached = views.get(root);
        if (cached && cached.revision === index.revision) return cached.lookup;
        const lookup = new CompletionIndex();
        for (const info of index.fileToClass.values()) {
            const uri = vscode.Uri.file(info.filePath);
            if (rootFor(uri) === root && !excluded(uri)) lookup.addClass(info);
        }
        views.delete(root); views.set(root, { revision: index.revision, lookup });
        if (views.size > 16) views.delete(views.keys().next().value);
        return lookup;
    }
    function inlineOwner(frame, outer, document) {
        if (!frame) return outer;
        const containerInfo = inlineOwner(frame.parent, outer, document);
        return { ...outer, filePath: `${document.uri.fsPath}#inline:${frame.line}`,
            sourceFilePath: document.uri.fsPath, fullName: `${outer.fullName}.<inline:${frame.line + 1}>`,
            members: frame.locals.members, methods: frame.locals.methods, nativeClassName: null,
            isEnum: false, baseInfo: frame.info, containerInfo, isInline: true };
    }
    function derives(lookup, child, owner) {
        const seen = new Set();
        while (child && !seen.has(child.filePath)) {
            if (child.filePath === owner.filePath) return true;
            seen.add(child.filePath); child = lookup.resolveBaseClass(child);
        }
        return false;
    }
    function accessible(lookup, context, owner, declaration, receiver) {
        const modifiers = declaration.modifiers || [];
        if (receiver.classReceiver && !(declaration.isStatic || modifiers.includes('static'))) return false;
        if (!modifiers.includes('private') && !modifiers.includes('protected')) return true;
        for (let lexical = context; lexical; lexical = lexical.containerInfo) {
            if (lexical.filePath === owner.filePath || modifiers.includes('protected') && derives(lookup, lexical, owner)) return true;
        }
        return false;
    }
    function members(lookup, receiver, context) {
        const fields = new Set(), signatures = new Set(), result = [], seen = new Set();
        let owner = receiver.info;
        while (owner && !seen.has(owner.filePath)) {
            seen.add(owner.filePath);
            for (const declaration of owner.members.values()) {
                if (fields.has(declaration.name)) continue;
                fields.add(declaration.name);
                if (accessible(lookup, context, owner, declaration, receiver)) result.push({ owner, declaration, kind: 'field' });
            }
            for (const method of owner.methods.values()) for (const declaration of method.overloads || [method]) {
                // Keep inherited overloads rather than deduplicating by method name.
                const signature = methodKey(lookup, owner, declaration);
                if (signatures.has(signature)) continue;
                signatures.add(signature);
                if (accessible(lookup, context, owner, declaration, receiver)) result.push({ owner, declaration, kind: 'method' });
            }
            owner = lookup.resolveBaseClass(owner);
        }
        // A single name inserts the same text for all overloads. Keep the
        // signatures/evidence in details rather than crowding the native list.
        const grouped = new Map();
        for (const row of result) {
            const key = `${row.kind}:${row.declaration.name}`;
            if (!grouped.has(key)) grouped.set(key, { ...row, overloads: [] });
            if (row.kind === 'method') grouped.get(key).overloads.push(row);
        }
        return [...grouped.values()];
    }
    function classItems(lookup, outer, site) {
        const qualified = site.mode === 'import' || site.prefix.includes('.');
        return [...lookup.fileToClass.values()].flatMap(owner => {
            const matches = lookup.resolveClassName(outer, owner.className);
            const short = matches.length === 1 && matches[0] === owner;
            const label = qualified || !short ? owner.fullName : owner.className;
            if (!(qualified ? owner.fullName : owner.className).toLowerCase().startsWith(site.prefix.toLowerCase())) return [];
            return [{ kind: 'class', owner, label, insertText: label, filterText: qualified ? owner.fullName : owner.className }];
        });
    }
    function itemFor(row, range, root) {
        const { owner, declaration } = row;
        const name = row.label || declaration.name;
        const kinds = vscode.CompletionItemKind;
        const kind = row.kind === 'class' ? owner.isEnum ? kinds.Enum : kinds.Class
            : row.kind === 'local' ? kinds.Variable : row.kind === 'method' ? kinds.Method
                : declaration.kind === 'enum' ? kinds.EnumMember : declaration.kind === 'record' || declaration.kind === 'constant' ? kinds.Constant : kinds.Field;
        const item = new vscode.CompletionItem(name, kind);
        const source = owner.sourceFilePath || owner.filePath;
        const location = `${path.relative(root, source)}:${(declaration ? declaration.line : owner.classLine) + 1}`;
        const parameters = declaration && declaration.parameters;
        const signature = row.kind === 'class' ? owner.fullName
            : row.kind === 'method' ? `${declaration.returnType} ${name}(${parameters ? parameters.map(p => p.typeName + ' ' + p.name).join(', ') : '?'})`
                : `${declaration.typeName} ${name}`;
        item.range = range; item.insertText = row.insertText || name;
        item.filterText = row.filterText || name;
        item.sortText = `${row.kind === 'local' ? '0' : row.kind === 'class' ? '2' : '1'}:${name}:${location}`;
        item.detail = `${signature.slice(0, 360)} · ${owner.fullName} · ${location}`.slice(0, 900);
        const documentation = new vscode.MarkdownString();
        documentation.appendText(`${signature.slice(0, 1024)}\nИсточник: ${location}\n${owner.fullName}`.slice(0, 2048));
        if (row.overloads?.length > 1) {
            item.detail = `${signature.slice(0, 300)} (+${row.overloads.length - 1} перегрузок) · ${owner.fullName} · ${location}`.slice(0, 900);
            for (const overload of row.overloads.slice(1, 6)) {
                const method = overload.declaration;
                const parameters = method.parameters ? method.parameters.map(p => p.typeName + ' ' + p.name).join(', ') : '?';
                documentation.appendText(`\n${method.returnType} ${method.name}(${parameters})\n${path.relative(root,
                    overload.owner.sourceFilePath || overload.owner.filePath)}:${method.line + 1}`.slice(0, 420));
            }
            if (row.overloads.length > 6) documentation.appendText(`\nЕщё перегрузок: ${row.overloads.length - 6}`);
        }
        documentation.isTrusted = false; item.documentation = documentation;
        return item;
    }
    const provider = { async provideCompletionItems(document, position, token, completion) {
        if (disposed || token?.isCancellationRequested || document.isClosed
            || document.languageId !== 'bl' || document.uri.scheme !== 'file') return [];
        const version = document.version, text = document.getText();
        if (localizationContext(text, document.offsetAt(position))) {
            return localization.completionProvider.provideCompletionItems(document, position, token, completion);
        }
        const analysis = getAnalysis(document), site = completionSite(analysis, position, services);
        const root = rootFor(document.uri);
        if (!site || !root || excluded(document.uri)) return [];
        const epoch = getRevision();
        const versions = vscode.workspace.textDocuments.filter(doc => !doc.isClosed && doc.languageId === 'bl')
            .map(doc => [doc, doc.version]);
        const stale = () => disposed || token?.isCancellationRequested || epoch !== getRevision()
            || document.isClosed || version !== document.version || text !== document.getText()
            || root !== rootFor(document.uri) || versions.some(([doc, value]) => doc.isClosed || doc.version !== value);
        await ensureIndexReady(token);
        if (stale()) return [];
        const declaration = updateIndexFromDocument(document);
        const file = declaration || getBlFileContext(document.uri.fsPath, analysis.lines);
        if (!file) return [];
        const outer = declaration || { ...file, fullName: file.packageName, members: new Map(), methods: new Map() };
        const revision = index.revision, lookup = scopedIndex(root);
        const frame = declaration ? services.getInlineContext(document, position, outer, lookup) : null;
        const context = inlineOwner(frame, outer, document);
        analysis.buildScopes();
        const scope = analysis.scopeAt(position);
        const staticContext = scope.method?.modifiers?.includes('static');
        const access = (owner, declaration, receiver) => accessible(lookup, context, owner, declaration,
            { ...receiver, classReceiver: receiver.classReceiver || receiver.implicit && staticContext });
        let rows = [];
        if (site.mode === 'member') {
            if (staticContext && ['this', 'super', 'container'].includes(site.segments[0].name)) return [];
            const candidates = services.resolveChainTypeCandidatesWithMeta(context, document, position, site.segments,
                outer, lookup, site.forceClass, access);
            if (candidates.length === 1 && !candidates[0].isArrayLike) rows = members(lookup, candidates[0], context);
            else if (!candidates.length && site.classSite) rows = classItems(lookup, outer, site.classSite);
        } else if (site.mode === 'new' || site.mode === 'import') rows = classItems(lookup, outer, site);
        else {
            const locals = analysis.visibleLocals(position);
            const shadowed = new Set(locals.map(local => local.name));
            rows = locals.map(declaration => ({ owner: outer, declaration, kind: 'local' }));
            rows.push(...members(lookup, { info: context, classReceiver: staticContext }, context)
                .filter(row => !shadowed.has(row.declaration.name)));
            for (const row of classItems(lookup, outer, site)) if (!shadowed.has(row.label)) rows.push(row);
        }
        rows = rows.filter(row => (row.label || row.declaration.name).toLowerCase().startsWith(site.prefix.toLowerCase())
            || row.kind === 'class' && row.owner.className.toLowerCase().startsWith(site.prefix.toLowerCase()));
        const priority = row => row.kind === 'local' ? 0 : row.kind === 'class' ? 2 : 1;
        rows.sort((a, b) => priority(a) - priority(b) || (a.label || a.declaration.name).localeCompare(b.label || b.declaration.name)
            || a.owner.filePath.localeCompare(b.owner.filePath));
        const replacement = site.mode === 'member' && rows[0]?.kind === 'class' ? site.classSite : site;
        const range = new vscode.Range(position.line, replacement.start, position.line, replacement.end);
        const items = rows.slice(0, MAX_ITEMS).map(row => itemFor(row, range, root));
        // Yield once before publication: dependency edits/cancel/disposal must
        // not publish a list derived from the old snapshot.
        await new Promise(resolve => setImmediate(resolve));
        return stale() || revision !== index.revision ? [] : new vscode.CompletionList(items, rows.length > MAX_ITEMS);
    } };
    return { provider, dispose() { disposed = true; views.clear(); } };
}

module.exports = { createBlCompletion, completionSite, MAX_ITEMS };
