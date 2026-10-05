const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const {
    BlIndex,
    getBlRootFromFilePath,
    getModuleRootFromBlFile,
    sanitizeText,
    stripInlineAttributes
} = require('./blIndex');
const { DocumentAnalysis, TYPE_PATTERN, METHOD_DEF_RE, STATEMENT_TYPES } = require('./documentAnalysis');

const index = new BlIndex();
let debugOutput = null;
let documentIndex = new WeakMap();
let lexicalDocuments = new WeakMap();
const FIELD_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\])*)\s+(\w+)\s*[=;]/;
const MODIFIER_RE = /\b(public|private|protected|static|final|virtual|abstract|auto)\b/;
const MODIFIERS_RE = /\b(public|private|protected|static|final|virtual|abstract|auto)\b/g;
const javaFiles = new Map();
const attributeDefinitions = new Map();
const CACHE_LIMIT = 128;
let disposed = false;
let indexBuild = Promise.resolve();
let buildGeneration = 0;
let workspaceFiles = new Set();
let discoveryTimer = null;
let javaLensTimer = null;
const pendingReads = new Map();
const dirtyDocuments = new Set();
const diagnosticTimers = new Map();
let diagnosticsCollection = null;

function configuration(document) {
    return vscode.workspace.getConfiguration('bl', document && document.uri);
}

function boundedCache(cache, key, create) {
    if (cache.has(key)) {
        const value = cache.get(key);
        cache.delete(key);
        cache.set(key, value);
        return value;
    }
    let value = create();
    if (value && typeof value.then === 'function') value = value.catch(error => {
        if (cache.get(key) === value) cache.delete(key);
        throw error;
    });
    cache.set(key, value);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return value;
}

function invalidateJava() {
    javaFiles.clear();
    attributeDefinitions.clear();
}

function yieldToHost() {
    return new Promise(resolve => setImmediate(resolve));
}

function getAnalysis(document) {
    const cached = lexicalDocuments.get(document);
    if (cached && typeof document.version === 'number' && cached.version === document.version) return cached.analysis;
    const text = document.getText();
    if (cached && cached.analysis.text === text) {
        cached.version = document.version;
        return cached.analysis;
    }
    const analysis = new DocumentAnalysis(text);
    lexicalDocuments.set(document, { version: document.version, analysis });
    return analysis;
}

async function buildIndex() {
    const generation = ++buildGeneration;
    const excludes = configuration().get('index.exclude', ['**/node_modules/**', '**/.git/**', '**/build/**']);
    const exclude = excludes.length > 1 ? `{${excludes.join(',')}}` : excludes[0] || null;
    const blFiles = await vscode.workspace.findFiles('**/*.bl', exclude);
    if (disposed || generation !== buildGeneration) return;
    const included = new Set(blFiles.map(uri => uri.fsPath));
    workspaceFiles = included;
    for (const file of index.wordFilters.keys()) if (!included.has(file)) {
        pendingReads.delete(file);
        index.removeFile(file);
    }
    for (const uri of blFiles) {
        if (disposed || generation !== buildGeneration) return;
        if (!index.wordFilters.has(uri.fsPath)) await refreshFile(uri);
    }
    for (const doc of vscode.workspace.textDocuments) if (doc.languageId === 'bl') updateIndexFromDocument(doc);
}

function rebuildIndex() {
    indexBuild = buildIndex().catch(error => {
        if (disposed) return;
        if (debugOutput) debugOutput.appendLine(`Index error: ${error.message}`);
        vscode.window.showWarningMessage(`Не удалось обновить индекс BL: ${error.message}`);
    });
    return indexBuild;
}

function refreshFile(uri) {
    const findOpen = () => vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.languageId === 'bl' && doc.uri.fsPath === uri.fsPath);
    const open = findOpen();
    if (open) { updateIndexFromDocument(open); return Promise.resolve(); }
    const request = {};
    pendingReads.set(uri.fsPath, request);
    request.promise = (async () => {
        try {
            const text = await fs.promises.readFile(uri.fsPath, 'utf8');
            if (disposed || pendingReads.get(uri.fsPath) !== request || !workspaceFiles.has(uri.fsPath)) return;
            const currentOpen = findOpen();
            if (currentOpen) updateIndexFromDocument(currentOpen);
            else index.updateFromText(uri.fsPath, text);
            if (diagnosticsCollection) for (const doc of vscode.workspace.textDocuments) scheduleDiagnostics(doc, diagnosticsCollection);
        } catch (error) {
            if (disposed || pendingReads.get(uri.fsPath) !== request) return;
            if (error.code === 'ENOENT') index.removeFile(uri.fsPath);
            else {
                if (debugOutput) debugOutput.appendLine(`Read error: ${uri.fsPath}: ${error.message}`);
                vscode.window.showWarningMessage(`Не удалось прочитать BL-файл: ${uri.fsPath}. Подробности в BL Debug.`);
            }
        } finally {
            if (pendingReads.get(uri.fsPath) === request) pendingReads.delete(uri.fsPath);
        }
    })();
    return request.promise;
}

function scheduleDiscovery() {
    clearTimeout(discoveryTimer);
    discoveryTimer = setTimeout(() => { discoveryTimer = null; rebuildIndex(); }, 100);
}

async function ensureIndexReady(token) {
    while (!disposed && !(token && token.isCancellationRequested)) {
        if (discoveryTimer) {
            clearTimeout(discoveryTimer);
            discoveryTimer = null;
            rebuildIndex();
        }
        const build = indexBuild;
        await build;
        await Promise.all(Array.from(pendingReads.values(), request => request.promise));
        if (build === indexBuild && !pendingReads.size && !discoveryTimer) {
            // Keep navigation current even when diagnostics are delayed/off.
            // Edits only enqueue documents; parsing is deferred until needed.
            for (const document of dirtyDocuments) {
                if (!document.isClosed && document.languageId === 'bl') updateIndexFromDocument(document);
                else dirtyDocuments.delete(document);
            }
            return;
        }
    }
}

function updateIndexFromDocument(document) {
    const analysis = getAnalysis(document);
    const cached = documentIndex.get(document);
    dirtyDocuments.delete(document);
    if (cached && cached.analysis === analysis && index.getClassByFile(document.uri.fsPath) === cached.info) return cached.info;
    const info = index.updateFromText(document.uri.fsPath, analysis.text, analysis);
    documentIndex.set(document, { analysis, info });
    return info;
}

function getCodeLines(document) {
    return getAnalysis(document).lines;
}

function parseInlineClassType(line) {
    if (!/=\s*class\b/.test(line)) return null;
    const normalized = line.replace(MODIFIERS_RE, ' ').replace(/\s+/g, ' ').trim();
    const match = normalized.match(new RegExp(String.raw`^(${TYPE_PATTERN})\s+\w+\s*=\s*class\b`));
    return match ? match[1].trim() : null;
}

function resolveInlineContextType(contextClass, typeName) {
    if (!contextClass || !typeName) return null;
    const candidates = index.resolveTypeName(contextClass, typeName);
    return candidates.length > 0 ? candidates[0] : null;
}

function findExplicitImport(contextClass, name) {
    if (!contextClass || !name || !contextClass.imports) return null;
    for (const imp of contextClass.imports) {
        if (imp === name || imp.endsWith(`.${name}`)) return imp;
    }
    return null;
}

function getInlineContextMap(document, baseContext) {
    if (!document || !baseContext) return null;
    const analysis = getAnalysis(document);
    const cached = analysis.inlineContext;
    if (cached && cached.baseContext === baseContext && cached.revision === index.revision) return cached.map;
    const lines = analysis.cleanLines;
    const map = new Array(lines.length).fill(null);
    const inlineStack = [];
    let braceDepth = 0;
    let pendingInlineType = null;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const cleanLine = rawLine;
        const inlineType = parseInlineClassType(cleanLine);
        if (inlineType) {
            if (cleanLine.includes('{')) {
                const info = resolveInlineContextType(baseContext, inlineType);
                if (info) inlineStack.push({ depth: braceDepth + 1, info, locals: { methods: new Map(), members: new Map() } });
                pendingInlineType = null;
            } else {
                pendingInlineType = inlineType;
            }
        } else if (pendingInlineType && cleanLine.trim().startsWith('{')) {
            const info = resolveInlineContextType(baseContext, pendingInlineType);
            if (info) inlineStack.push({ depth: braceDepth + 1, info, locals: { methods: new Map(), members: new Map() } });
            pendingInlineType = null;
        }

        const currentInline = inlineStack.length > 0 ? inlineStack[inlineStack.length - 1] : null;
        if (currentInline && braceDepth === currentInline.depth) {
            const methodMatch = cleanLine.match(METHOD_DEF_RE);
            if (methodMatch) {
                const returnType = methodMatch[1];
                const name = methodMatch[2];
                currentInline.locals.methods.set(name, {
                    name,
                    returnType,
                    line: i,
                    column: rawLine.indexOf(name)
                });
            } else {
                const memberMatch = cleanLine.match(FIELD_DEF_RE);
                if (memberMatch) {
                    const typeName = memberMatch[1];
                    const name = memberMatch[2];
                    currentInline.locals.members.set(name, {
                        name,
                        typeName,
                        line: i,
                        column: rawLine.indexOf(name)
                    });
                }
            }
        }

        const openCount = (cleanLine.match(/\{/g) || []).length;
        const closeCount = (cleanLine.match(/\}/g) || []).length;
        braceDepth += openCount - closeCount;
        while (inlineStack.length > 0 && braceDepth < inlineStack[inlineStack.length - 1].depth) {
            inlineStack.pop();
        }

        map[i] = inlineStack.length > 0 ? inlineStack[inlineStack.length - 1] : null;
    }

    analysis.inlineContext = { map, baseContext, revision: index.revision };
    return map;
}

function isIdentifierStart(ch) {
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    return code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122;
}

function isIdentifierChar(ch) {
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    return code === 95 || code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122;
}

function skipSpaces(text, index) {
    let i = index;
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
}

function isNewKeywordBefore(text, index) {
    const prefix = text.slice(0, index);
    return /\bnew\s*$/.test(prefix);
}

function scanBalanced(text, startIndex, openChar, closeChar) {
    if (text[startIndex] !== openChar) return null;
    let depth = 0;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (ch === openChar) depth++;
        if (ch === closeChar) depth--;
        if (depth === 0) return i + 1;
    }
    return null;
}

function parseChainAt(text, startIndex, allowSingle = false) {
    let i = startIndex;
    const segments = [];
    const length = text.length;

    while (i < length) {
        if (!isIdentifierStart(text[i])) break;
        const nameStart = i;
        i++;
        while (i < length && isIdentifierChar(text[i])) i++;
        const name = text.slice(nameStart, i);
        let isCall = false;
        let hasIndex = false;

        i = skipSpaces(text, i);
        if (text[i] === '(') {
            const end = scanBalanced(text, i, '(', ')');
            i = end !== null ? end : length;
            isCall = true;
        }

        i = skipSpaces(text, i);
        while (text[i] === '[') {
            const end = scanBalanced(text, i, '[', ']');
            i = end !== null ? end : length;
            i = skipSpaces(text, i);
            hasIndex = true;
        }

        segments.push({ name, isCall, hasIndex, offset: nameStart - startIndex });

        i = skipSpaces(text, i);
        if (text[i] !== '.') break;
        i = skipSpaces(text, i + 1);
        if (!isIdentifierStart(text[i])) break;
    }

    if (segments.length < 2 && !allowSingle) return null;
    return { start: startIndex, end: i, segments };
}

function findChainsInLine(text, allowSingle = false) {
    const chains = [];
    const identifiers = /[A-Za-z_]\w*/g;
    let match;
    while ((match = identifiers.exec(text))) {
        const i = match.index;
        const prev = i > 0 ? text[i - 1] : '';
        if (isIdentifierChar(prev) || prev === '.') continue;
        const chain = parseChainAt(text, i, allowSingle);
        if (chain) chains.push(chain);
    }
    return chains;
}

function isArrayOrMapTypeName(typeName) {
    return /\[[^\]]*\]/.test(typeName || '');
}

function getElementTypeName(typeName) {
    if (!typeName) return null;
    const match = typeName.match(/^(.*)\[[^\]]*\]\s*$/);
    if (!match) return null;
    const base = match[1].trim();
    return base || null;
}

function resolveTypeNameWithMeta(context, typeName, importContext) {
    const lookupContext = importContext || context;
    const infos = index.resolveTypeName(lookupContext, typeName);
    const isArrayLike = isArrayOrMapTypeName(typeName);
    const elementTypeName = getElementTypeName(typeName);
    return infos.map(info => ({
        info,
        isArrayLike,
        isNative: Boolean(info.nativeClassName),
        elementTypeName
    }));
}

function resolveIdentifierTypeCandidatesWithMeta(context, document, position, name, inlineContext, importContext, isCall = false) {
    if (!context || !name) return [];

    if (name === 'this') {
        return [{
            info: context,
            isArrayLike: false,
            isNative: Boolean(context.nativeClassName)
        }];
    }

    if (name === 'super') {
        const base = inlineContext ? inlineContext.info : index.resolveBaseClass(context);
        return base ? [{
            info: base,
            isArrayLike: false,
            isNative: Boolean(base.nativeClassName)
        }] : [];
    }

    if (isCall) {
        const inlineMethod = inlineContext && inlineContext.locals.methods.get(name);
        if (inlineMethod) return resolveTypeNameWithMeta(context, inlineMethod.returnType, importContext);
        const method = index.findMethodInClassChain(context, name);
        return method ? (method.method.overloads || [method.method]).flatMap(overload => resolveTypeNameWithMeta(method.owner, overload.returnType)) : [];
    }

    const local = findLocalVariableDefinition(document, position, name);
    if (local) return resolveTypeNameWithMeta(context, local.typeName, importContext);

    if (inlineContext && inlineContext.locals) {
        if (inlineContext.locals.members.has(name)) {
            const localMember = inlineContext.locals.members.get(name);
            return resolveTypeNameWithMeta(context, localMember.typeName, importContext);
        }
    }

    const member = index.findMemberInClassChain(context, name);
    if (member) return resolveTypeNameWithMeta(member.owner, member.member.typeName);

    return index.resolveClassName(importContext || context, name).map(info => ({
        info,
        isArrayLike: false,
        isNative: Boolean(info.nativeClassName),
        elementTypeName: null
    }));
}

function resolveIdentifierTypeName(context, document, position, name) {
    const local = findLocalVariableDefinition(document, position, name);
    if (local) return local.typeName;
    const member = index.findMemberInClassChain(context, name);
    if (member) return member.member.typeName;
    return null;
}

function collectDiagnostics(document, contextClass) {
    const lines = getAnalysis(document).cleanLines;
    const diagnostics = [];
    const stack = [];
    const inlineContextMap = getInlineContextMap(document, contextClass);
    const trace = configuration(document).get('debug.trace', false);

    for (let line = 0; line < lines.length; line++) {
        const lineText = lines[line];
        const cleanLine = lineText;
        const inlineContext = inlineContextMap && inlineContextMap[line] ? inlineContextMap[line] : null;
        const effectiveContext = inlineContext ? inlineContext.info : contextClass;

        const returnMatch = cleanLine.match(/\breturn\b(.*)/);
        if (returnMatch) {
            const tail = returnMatch[1];
            const modifierMatch = tail.match(MODIFIER_RE);
                if (modifierMatch) {
                    const start = cleanLine.indexOf(modifierMatch[0], returnMatch.index);
                    const range = new vscode.Range(line, start, line, start + modifierMatch[0].length);
                const diag = new vscode.Diagnostic(range, 'Неожиданный модификатор после return', vscode.DiagnosticSeverity.Error);
                diag.source = 'BL';
                diag.code = 'return-modifier';
                diagnostics.push(diag);
                }
            }

        for (let col = 0; col < lineText.length; col++) {
            const ch = lineText[col];
            if (ch === '(' || ch === '[' || ch === '{') {
                stack.push({ ch, line, col });
            } else if (ch === ')' || ch === ']' || ch === '}') {
                const expected = ch === ')' ? '(' : ch === ']' ? '[' : '{';
                const last = stack.pop();
                if (!last || last.ch !== expected) {
                    const range = new vscode.Range(line, col, line, col + 1);
                    const diag = new vscode.Diagnostic(range, 'Лишняя закрывающая скобка', vscode.DiagnosticSeverity.Error);
                    diag.source = 'BL';
                    diag.code = 'brace';
                    diagnostics.push(diag);
                }
            }
        }

        if (effectiveContext) {
            const trimmed = cleanLine.trim();
            let chains = [];
            if (!trimmed.startsWith('import ')) {
                chains = findChainsInLine(cleanLine);
                if (trace && debugOutput && cleanLine.includes('documents[i].getDocumentId')) {
                    debugOutput.appendLine('Line Trace: documents[i].getDocumentId');
                    debugOutput.appendLine(`Line: ${line + 1}`);
                    debugOutput.appendLine(`CleanLine: ${cleanLine.trim()}`);
                    debugOutput.appendLine(`Chains: ${chains.map(chain => cleanLine.slice(chain.start, chain.end).trim()).join(' | ') || '(none)'}`);
                }
                for (const chain of chains) {
                    const segments = chain.segments;
                    const first = segments[0];
                    const pos = new vscode.Position(line, chain.start + first.offset);
                    const forceClass = isNewKeywordBefore(cleanLine, chain.start);
                    let candidates = forceClass
                        ? resolveTypeNameWithMeta(effectiveContext, first.name, contextClass)
                        : resolveIdentifierTypeCandidatesWithMeta(effectiveContext, document, pos, first.name, inlineContext, contextClass, first.isCall);
                    if (candidates.length === 0 && inlineContext && inlineContext.locals) {
                        if (first.isCall) {
                            const localMethod = inlineContext.locals.methods.get(first.name);
                            if (localMethod) {
                                candidates = resolveTypeNameWithMeta(effectiveContext, localMethod.returnType, contextClass);
                            }
                        } else {
                            const localMember = inlineContext.locals.members.get(first.name);
                            if (localMember) {
                                candidates = resolveTypeNameWithMeta(effectiveContext, localMember.typeName, contextClass);
                            }
                        }
                    }
                    if (candidates.length === 0) continue;

                    for (let i = 1; i < segments.length; i++) {
                        const segment = segments[i];
                        const receiver = segments[i - 1];
                        const next = [];
                        let foundAny = false;
                        let hadNonNative = false;
                        let hasArrayLike = false;
                        let skippedDueToIndex = false;

                        for (const candidate of candidates) {
                            let lookupCandidates = [candidate];
                            if (receiver && receiver.hasIndex) {
                                if (candidate.elementTypeName) {
                                    lookupCandidates = resolveTypeNameWithMeta(effectiveContext, candidate.elementTypeName, contextClass);
                                } else {
                                    skippedDueToIndex = true;
                                    continue;
                                }
                            }

                            for (const lookup of lookupCandidates) {
                                const info = lookup.info;
                                const isArrayLike = lookup.isArrayLike;
                                const isNonArrayLike = !isArrayLike;
                                if (isNonArrayLike) hadNonNative = true;
                                if (isArrayLike) hasArrayLike = true;

                                if (segment.isCall) {
                                    if (first.name !== 'super' && inlineContext && inlineContext.locals && info === effectiveContext) {
                                        const localMethod = inlineContext.locals.methods.get(segment.name);
                                        if (localMethod) {
                                            foundAny = true;
                                            next.push(...resolveTypeNameWithMeta(effectiveContext, localMethod.returnType, contextClass));
                                            continue;
                                        }
                                    }
                                    const method = index.findMethodInClassChain(info, segment.name);
                                    if (method) {
                                        foundAny = true;
                                        for (const overload of method.method.overloads || [method.method]) next.push(...resolveTypeNameWithMeta(method.owner, overload.returnType));
                                    }
                                } else {
                                    if (first.name !== 'super' && inlineContext && inlineContext.locals && info === effectiveContext) {
                                        const localMember = inlineContext.locals.members.get(segment.name);
                                        if (localMember) {
                                            foundAny = true;
                                            next.push(...resolveTypeNameWithMeta(effectiveContext, localMember.typeName, contextClass));
                                            continue;
                                        }
                                    }
                                    const member = index.findMemberInClassChain(info, segment.name);
                                    if (member) {
                                        foundAny = true;
                                        next.push(...resolveTypeNameWithMeta(member.owner, member.member.typeName));
                                    }
                                }
                            }
                        }

                        if (!foundAny && receiver && receiver.hasIndex) {
                            const receiverType = resolveIdentifierTypeName(effectiveContext, document, pos, receiver.name);
                            const elementTypeName = getElementTypeName(receiverType);
                            if (elementTypeName) {
                                const elementInfos = index.resolveTypeName(contextClass, elementTypeName);
                                const exists = elementInfos.some(info => index.findMethodInClassChain(info, segment.name));
                                if (exists) {
                                    foundAny = true;
                                }
                            }
                        }

                        if (!foundAny && skippedDueToIndex) {
                            break;
                        }

                        if (!foundAny && hadNonNative && !hasArrayLike) {
                            const column = chain.start + segment.offset;
                            const range = new vscode.Range(line, column, line, column + segment.name.length);
                            const kind = segment.isCall ? 'метод' : 'поле';
                            const diag = new vscode.Diagnostic(range, `Неизвестный ${kind} '${segment.name}'`, vscode.DiagnosticSeverity.Error);
                            diag.source = 'BL';
                            diag.code = 'chain';
                            diagnostics.push(diag);
                            if (trace && debugOutput && segment.name === 'getDocumentId' && cleanLine.includes('documents[i].getDocumentId')) {
                                debugOutput.appendLine('Diagnostic: Unknown method getDocumentId');
                                debugOutput.appendLine(`Line: ${line + 1}`);
                                debugOutput.appendLine(`LineText: ${cleanLine.trim()}`);
                                debugOutput.appendLine(`BaseContext: ${contextClass ? contextClass.fullName : '(none)'}`);
                                debugOutput.appendLine(`EffectiveContext: ${effectiveContext ? effectiveContext.fullName : '(none)'}`);
                                debugOutput.appendLine(`Chain: ${segments.map(seg => seg.name + (seg.isCall ? '()' : '')).join('.')}`);
                                debugOutput.appendLine(`Candidates: ${candidates.map(c => `${c.info.fullName} (array=${c.isArrayLike})`).join(', ') || '(none)'}`);
                            }
                            break;
                        }

                        if (next.length === 0) break;
                        const unique = new Map();
                        for (const item of next) {
                            const key = `${item.info.fullName}:${item.isArrayLike}:${item.isNative}`;
                            unique.set(key, item);
                        }
                        candidates = Array.from(unique.values());
                    }
                }
            }

            if (METHOD_DEF_RE.test(cleanLine)) continue;

            const callRegex = /(^|[^\w.])([A-Za-z_]\w*)\s*\(/g;
            let callMatch;
            while ((callMatch = callRegex.exec(cleanLine)) !== null) {
                const name = callMatch[2];
                const nameIndex = callMatch.index + callMatch[1].length;
                if (['if', 'for', 'while', 'switch', 'catch', 'return', 'new'].includes(name)) continue;
                if (cleanLine[nameIndex - 1] === '.') continue;
                const inChain = chains.some(chain => nameIndex >= chain.start && nameIndex <= chain.end);
                if (trace && debugOutput && cleanLine.includes('documents[i].getDocumentId')) {
                    debugOutput.appendLine(`CallScan: ${name} at ${nameIndex} inChain=${inChain}`);
                }
                if (inChain) continue;

                const continuation = buildContinuationText(lines, line, nameIndex);
                if (continuation) {
                    const chain = parseAccessChain(continuation.combined, continuation.wordStart);
                    if (chain) {
                        const pos = new vscode.Position(line, nameIndex);
                        const owners = resolveChainTypeCandidates(effectiveContext, document, pos, chain, inlineContext, contextClass);
                        let found = false;
                        for (const owner of owners) {
                            if (index.findMethodInClassChain(owner, name)) {
                                found = true;
                                break;
                            }
                        }
                        if (found) continue;
                    }
                }

                const localMethod = inlineContext && inlineContext.locals ? inlineContext.locals.methods.get(name) : null;
                const method = index.findMethodInClassChain(effectiveContext, name);
                if (!method && !localMethod) {
                    const range = new vscode.Range(line, nameIndex, line, nameIndex + name.length);
                    const diag = new vscode.Diagnostic(range, `Неизвестный метод '${name}'`, vscode.DiagnosticSeverity.Error);
                    diag.source = 'BL';
                    diag.code = 'call';
                    diagnostics.push(diag);
                    if (trace && debugOutput && name === 'access' && cleanLine.includes('addHaving(access())')) {
                        debugOutput.appendLine('Diagnostic: Unknown method access');
                        debugOutput.appendLine(`Line: ${line + 1}`);
                        debugOutput.appendLine(`BaseContext: ${contextClass ? contextClass.fullName : '(none)'}`);
                        debugOutput.appendLine(`EffectiveContext: ${effectiveContext ? effectiveContext.fullName : '(none)'}`);
                    }
                    if (trace && debugOutput && name === 'getDocumentId' && cleanLine.includes('documents[i].getDocumentId')) {
                        debugOutput.appendLine('Diagnostic: Unknown method getDocumentId (call pass)');
                        debugOutput.appendLine(`Line: ${line + 1}`);
                        debugOutput.appendLine(`LineText: ${cleanLine.trim()}`);
                        debugOutput.appendLine(`NameIndex: ${nameIndex}`);
                    }
                }
            }

            if (trace && debugOutput && cleanLine.includes('documents[i].getDocumentId')) {
                const lineDiagnostics = diagnostics.filter(diag => diag.range.start.line === line);
                debugOutput.appendLine(`Line Diagnostics (${line + 1}): ${lineDiagnostics.map(d => d.message).join(' | ') || '(none)'}`);
            }
        }

    }

    for (const item of stack) {
        const range = new vscode.Range(item.line, item.col, item.line, item.col + 1);
        const diag = new vscode.Diagnostic(range, 'Незакрытая скобка', vscode.DiagnosticSeverity.Error);
        diag.source = 'BL';
        diag.code = 'brace';
        diagnostics.push(diag);
    }

    return diagnostics;
}

function updateDiagnostics(document, collection) {
    if (!document || document.languageId !== 'bl') return;
    cancelDiagnostics(document);
    if (disposed || document.isClosed || !configuration(document).get('diagnostics.enabled', true)) {
        collection.delete(document.uri);
        return;
    }
    const context = updateIndexFromDocument(document);
    collection.set(document.uri, collectDiagnostics(document, context));
}

function cancelDiagnostics(document) {
    const pending = diagnosticTimers.get(document.uri.fsPath);
    if (pending) clearTimeout(pending.timer);
    diagnosticTimers.delete(document.uri.fsPath);
}

function scheduleDiagnostics(document, collection) {
    if (!document || document.languageId !== 'bl') return;
    cancelDiagnostics(document);
    const config = configuration(document);
    if (!config.get('diagnostics.enabled', true)) { collection.delete(document.uri); return; }
    if (disposed || document.isClosed || config.get('diagnostics.mode', 'onType') !== 'onType') return;
    const version = document.version;
    const timer = setTimeout(() => {
        diagnosticTimers.delete(document.uri.fsPath);
        if (!disposed && !document.isClosed && document.version === version) updateDiagnostics(document, collection);
    }, config.get('diagnostics.delay', 300));
    diagnosticTimers.set(document.uri.fsPath, { timer, document });
}

function getWordAtPosition(document, position) {
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) return null;
    return { word: document.getText(range), range };
}

function getAttributeNameAt(line, wordRange) {
    const start = wordRange.start.character;
    const before = line.slice(0, start);
    const lastOpen = before.lastIndexOf('[');
    const lastClose = before.lastIndexOf(']');
    if (lastOpen === -1 || lastOpen < lastClose) return null;

    const afterOpen = line.slice(lastOpen + 1);
    const match = afterOpen.match(/^\s*(\w+)/);
    if (!match) return null;

    const attrName = match[1];
    const attrIndex = lastOpen + 1 + afterOpen.indexOf(attrName);
    if (attrIndex !== start) return null;

    const closeIndex = line.indexOf(']', start);
    if (closeIndex === -1) return null;

    return attrName;
}

function isMethodCallAt(document, wordRange) {
    const line = document.lineAt(wordRange.start.line).text;
    const after = line.slice(wordRange.end.character);
    return /^\s*\(/.test(after);
}

function isInRecordsBlock(document, targetLine) {
    const analysis = getAnalysis(document);
    if (analysis.records) return analysis.records[targetLine];
    const lines = analysis.cleanLines;
    const records = [];
    let braceDepth = 0;
    let recordsDepth = null;
    let pendingRecords = false;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const line = rawLine;

        if (braceDepth === 1 && /\brecords\b/.test(line)) {
            if (line.includes('{')) {
                recordsDepth = braceDepth + 1;
            } else {
                pendingRecords = true;
            }
        }

        const openCount = (line.match(/\{/g) || []).length;
        const closeCount = (line.match(/\}/g) || []).length;
        braceDepth += openCount - closeCount;

        if (pendingRecords && openCount > 0) {
            recordsDepth = braceDepth;
            pendingRecords = false;
        }

        if (recordsDepth !== null && braceDepth < recordsDepth) {
            recordsDepth = null;
        }
        records.push(recordsDepth !== null);
    }

    analysis.records = records;
    return records[targetLine];
}

function getNativeAttribute(text) {
    const declaration = sanitizeText(text).search(/\b(?:class|enum)\s+\w+/);
    const prefix = declaration < 0 ? text : text.slice(0, declaration);
    const match = sanitizeText(prefix, false).match(/\[(?:native|primary)\s+"([^"]+)"\]/);
    return match ? match[1] : null;
}

function findCompiledJavaFile(blFilePath) {
    const moduleRoot = getModuleRootFromBlFile(blFilePath);
    const blRoot = getBlRootFromFilePath(blFilePath);
    if (!moduleRoot || !blRoot) return null;

    const relative = path.relative(blRoot, blFilePath).replace(/\.bl$/, '.java');
    const compiledPath = path.join(moduleRoot, '.java', relative);
    return fs.existsSync(compiledPath) ? compiledPath : null;
}

async function findJavaFileByClassName(className, blFilePath) {
    const rel = className.replace(/\./g, '/') + '.java';
    const files = await boundedCache(javaFiles, className, async () => {
        const [main, alt] = await Promise.all([
            vscode.workspace.findFiles(`**/src/main/java/${rel}`, '**/node_modules/**'),
            vscode.workspace.findFiles(`**/src/java/${rel}`, '**/node_modules/**')
        ]);
        return [...main, ...alt];
    });
    const context = blFilePath ? { moduleRoot: getModuleRootFromBlFile(blFilePath) || path.dirname(blFilePath) } : null;
    const nearby = index.preferNearbyClasses(context, files.map(file => ({ filePath: file.fsPath, moduleRoot: path.dirname(file.fsPath) })));
    return nearby.length ? nearby[0].filePath : null;
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findAttributeDefinitionLocation(attributeName, blFilePath) {
    const javaFile = await findJavaFileByClassName('org.zenframework.z8.compiler.core.IAttribute', blFilePath);
    if (!javaFile) return null;

    try {
        const definitions = await boundedCache(attributeDefinitions, javaFile, async () => {
            const lines = (await fs.promises.readFile(javaFile, 'utf8')).split(/\r?\n/);
            const definitions = new Map();
            for (let line = 0; line < lines.length; line++) {
                const regex = /\bString\s+(\w+)\s*=\s*"([^"]+)"/g;
                let match;
                while ((match = regex.exec(lines[line]))) {
                    if (!definitions.has(match[2])) definitions.set(match[2], new vscode.Location(
                        vscode.Uri.file(javaFile), new vscode.Position(line, lines[line].indexOf(match[1], match.index))));
                }
            }
            return definitions;
        });
        return definitions.get(attributeName) || new vscode.Location(vscode.Uri.file(javaFile), new vscode.Position(0, 0));
    } catch (err) {
        return null;
    }
}

function parseAccessChain(line, wordStart) {
    const before = line.slice(0, wordStart);
    const trimmedLength = before.replace(/\s+$/, '').length;
    if (trimmedLength === 0) return null;
    const chains = findChainsInLine(before, true);
    if (chains.length === 0) return null;
    const match = [...chains].reverse().find(chain => chain.end >= trimmedLength);
    return match ? match.segments : null;
}

function buildContinuationText(lines, lineIndex, wordStart) {
    let i = lineIndex - 1;
    const prefixParts = [];
    let leadingDot = lines[lineIndex].trimStart().startsWith('.');

    while (i >= 0) {
        const line = stripInlineAttributes(lines[i]);
        const trimmed = line.trim();
        if (!trimmed) break;
        if (!trimmed.endsWith('.') && !leadingDot) break;
        if (/[;{}]$/.test(trimmed)) break;
        prefixParts.unshift(trimmed);
        leadingDot = trimmed.startsWith('.');
        i -= 1;
    }

    if (prefixParts.length === 0) return null;

    const currentLine = stripInlineAttributes(lines[lineIndex]);
    const leading = currentLine.length - currentLine.trimStart().length;
    const trimmedCurrent = currentLine.trimStart();
    const prefix = prefixParts.join(' ');
    const combined = `${prefix} ${trimmedCurrent}`;
    const combinedWordStart = prefix.length + 1 + Math.max(0, wordStart - leading);

    return { combined, wordStart: combinedWordStart };
}

function findLocalVariableDefinition(document, position, varName) {
    return getAnalysis(document).findLocal(position, varName);
}

function resolveIdentifierTypeCandidates(context, document, position, name, inlineContext, importContext) {
    if (!context || !name) return [];

    if (name === 'this') return [context];
    if (name === 'super') {
        const base = inlineContext ? inlineContext.info : index.resolveBaseClass(context);
        return base ? [base] : [];
    }

    const local = findLocalVariableDefinition(document, position, name);
    if (local) return index.resolveTypeName(importContext || context, local.typeName);

    if (inlineContext && inlineContext.locals) {
        const localMember = inlineContext.locals.members.get(name);
        if (localMember) return index.resolveTypeName(context, localMember.typeName);
    }

    const member = index.findMemberInClassChain(context, name);
    if (member) return index.resolveTypeName(member.owner, member.member.typeName);

    return index.resolveClassName(importContext || context, name);
}

function resolveChainTypeCandidates(context, document, position, segments, inlineContext, importContext, forceFirstClass = false) {
    if (!segments.length) return [];
    let candidates = [];
    const first = segments[0];
    let start = 1;

    if (first.isCall) {
        if (inlineContext && inlineContext.locals) {
            const localMethod = inlineContext.locals.methods.get(first.name);
            if (localMethod) {
                candidates = index.resolveTypeName(importContext || context, localMethod.returnType);
            }
        }
        if (candidates.length === 0) {
            const found = index.findMethodInClassChain(context, first.name);
            if (found) {
                candidates = (found.method.overloads || [found.method]).flatMap(method => index.resolveTypeName(found.owner, method.returnType));
            }
        }
    } else {
        if (forceFirstClass) {
            candidates = index.resolveClassName(importContext || context, first.name);
        } else {
            candidates = resolveIdentifierTypeCandidates(context, document, position, first.name, inlineContext, importContext);
        }
        if (candidates.length === 0) {
            for (let length = segments.length; length > 1; length--) {
                const prefix = segments.slice(0, length);
                if (prefix.some(segment => segment.isCall || segment.hasIndex)) continue;
                candidates = index.resolveClassName(importContext || context, prefix.map(segment => segment.name).join('.'));
                if (candidates.length) {
                    start = length;
                    break;
                }
            }
        }
    }

    for (const segment of segments.slice(start)) {
        const next = [];
        for (const candidate of candidates) {
            if (segment.isCall) {
                if (first.name !== 'super' && inlineContext && inlineContext.locals && candidate === context) {
                    const localMethod = inlineContext.locals.methods.get(segment.name);
                    if (localMethod) {
                        next.push(...index.resolveTypeName(context, localMethod.returnType));
                        continue;
                    }
                }
                const method = index.findMethodInClassChain(candidate, segment.name);
                if (method) {
                    for (const overload of method.method.overloads || [method.method]) {
                        next.push(...index.resolveTypeName(method.owner, overload.returnType));
                    }
                }
            } else {
                if (first.name !== 'super' && inlineContext && inlineContext.locals && candidate === context) {
                    const localMember = inlineContext.locals.members.get(segment.name);
                    if (localMember) {
                        next.push(...index.resolveTypeName(context, localMember.typeName));
                        continue;
                    }
                }
                const member = index.findMemberInClassChain(candidate, segment.name);
                if (member) {
                    next.push(...index.resolveTypeName(member.owner, member.member.typeName));
                }
            }
        }
        const seen = new Set();
        const unique = [];
        for (const info of next) {
            if (!seen.has(info.filePath)) {
                seen.add(info.filePath);
                unique.push(info);
            }
        }
        candidates = unique;
        if (candidates.length === 0) break;
    }
    return candidates;
}

function getInlineContext(document, position, defaultContext) {
    if (!defaultContext) return null;
    const map = getInlineContextMap(document, defaultContext);
    return map && map[position.line] ? map[position.line] : null;
}

function getEffectiveContext(document, position, defaultContext) {
    if (!defaultContext) return null;
    const map = getInlineContextMap(document, defaultContext);
    if (map && map[position.line]) return map[position.line].info;
    return defaultContext;
}

function locationForClass(info) {
    const pos = new vscode.Position(info.classLine || 0, info.classColumn || 0);
    return new vscode.Location(vscode.Uri.file(info.filePath), pos);
}

function locationForMember(info, member) {
    const pos = new vscode.Position(member.line, member.column);
    return new vscode.Location(vscode.Uri.file(info.filePath), pos);
}

function locationsForMethod(info, method) {
    return (method.overloads || [method]).map(overload => locationForMember(info, overload));
}

function uniqueLocations(locations) {
    const seen = new Set();
    const result = [];
    for (const loc of locations) {
        const key = `${loc.uri.fsPath}:${loc.range.start.line}:${loc.range.start.character}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(loc);
        }
    }
    return result;
}

class BlDefinitionProvider {
    async provideDefinition(document, position, token) {
        if (token && token.isCancellationRequested) return null;
        await ensureIndexReady(token);
        if (token && token.isCancellationRequested) return null;
        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return null;

        const line = document.lineAt(position.line).text;
        const isCall = isMethodCallAt(document, wordInfo.range);
        const wordStart = wordInfo.range.start.character;
        const codeLines = getCodeLines(document);
        const cleanLine = stripInlineAttributes(codeLines[position.line]);
        const nativeLine = /\[(?:native|primary)\b/.test(line) ? sanitizeText(document.getText(), false).split(/\r?\n/)[position.line] : '';
        const nativeMatch = nativeLine.match(/\[(?:native|primary)\s+"([^"]+)"\]/);
        if (nativeMatch && line.includes(wordInfo.word)) {
            const javaFile = await findJavaFileByClassName(nativeMatch[1], document.uri.fsPath);
            if (javaFile) return new vscode.Location(vscode.Uri.file(javaFile), new vscode.Position(0, 0));
        }
        if (codeLines[position.line].slice(wordStart, wordInfo.range.end.character).trim() === '') return null;

        const context = updateIndexFromDocument(document);
        const baseContextClass = context || index.getClassByFile(document.uri.fsPath);
        const inlineContext = getInlineContext(document, position, baseContextClass);
        const contextClass = inlineContext ? inlineContext.info : baseContextClass;

        if (!contextClass) return null;

        const attrName = getAttributeNameAt(line, wordInfo.range);
        if (attrName) {
            if (isInRecordsBlock(document, position.line)) {
                const member = index.findMemberInClassChain(contextClass, attrName);
                if (member) return locationForMember(member.owner, member.member);
            }
            const attrLocation = await findAttributeDefinitionLocation(attrName, document.uri.fsPath);
            if (attrLocation) return attrLocation;
            return null;
        }

        const importMatch = cleanLine.match(/^\s*import\s+([\w.]+)\s*;/);
        if (importMatch) {
            const info = index.getClassByFullName(importMatch[1], baseContextClass);
            if (info) return locationForClass(info);
        }

        const classMatch = cleanLine.match(/\b(class|enum)\s+(\w+)/);
        if (classMatch && classMatch[2] === wordInfo.word &&
            wordStart === cleanLine.indexOf(classMatch[2], classMatch.index + classMatch[1].length)) {
            return new vscode.Location(document.uri, wordInfo.range.start);
        }

        if (isNewKeywordBefore(line, wordStart)) {
            const forced = index.resolveClassName(contextClass, wordInfo.word);
            if (forced.length > 0) return locationForClass(forced[0]);
        }

        const methodDefMatch = cleanLine.match(METHOD_DEF_RE);
        if (methodDefMatch && !STATEMENT_TYPES.has(methodDefMatch[1].trim()) && methodDefMatch[2] === wordInfo.word &&
            wordStart === cleanLine.lastIndexOf(wordInfo.word, cleanLine.indexOf('('))) {
            return new vscode.Location(document.uri, wordInfo.range.start);
        }

        const fieldDefMatch = cleanLine.match(FIELD_DEF_RE);
        if (fieldDefMatch && !STATEMENT_TYPES.has(fieldDefMatch[1].trim()) && fieldDefMatch[2] === wordInfo.word &&
            wordStart === fieldDefMatch[0].lastIndexOf(wordInfo.word)) {
            return new vscode.Location(document.uri, wordInfo.range.start);
        }

        const extendsMatch = cleanLine.match(/\bextends\s+([\w.]+)/);
        if (extendsMatch && wordStart >= extendsMatch.index + extendsMatch[0].indexOf(extendsMatch[1]) &&
            wordStart < extendsMatch.index + extendsMatch[0].length) {
            const candidates = index.resolveClassName(contextClass, extendsMatch[1]);
            if (candidates.length > 0) return locationForClass(candidates[0]);
        }

        const continuation = buildContinuationText(codeLines, position.line, wordStart);
        const chainLine = continuation ? continuation.combined : cleanLine;
        const chainWordStart = continuation ? continuation.wordStart : wordStart;
        const chains = findChainsInLine(chainLine);
        const chainAtWord = chains.find(chain => chain.segments.some(segment => chain.start + segment.offset === chainWordStart));
        const targetIndex = chainAtWord ? chainAtWord.segments.findIndex(segment => chainAtWord.start + segment.offset === chainWordStart) : -1;
        if (chainAtWord && targetIndex > 0) {
            const typePrefix = chainAtWord.segments.slice(0, targetIndex + 1);
            if (typePrefix.every(segment => !segment.isCall && !segment.hasIndex)) {
                const types = index.resolveClassName(baseContextClass, typePrefix.map(segment => segment.name).join('.'));
                if (types.length) return types.map(locationForClass);
            }
            const forceFirstClass = isNewKeywordBefore(chainLine, chainAtWord.start);
            const owners = resolveChainTypeCandidates(
                contextClass,
                document,
                position,
                chainAtWord.segments.slice(0, targetIndex),
                inlineContext,
                baseContextClass,
                forceFirstClass
            );
            const results = [];

            for (const owner of owners) {
                if (isCall) {
                    if (chainAtWord.segments[0].name !== 'super' && inlineContext && inlineContext.locals && owner === contextClass) {
                        const localMethod = inlineContext.locals.methods.get(wordInfo.word);
                        if (localMethod) {
                            results.push(new vscode.Location(document.uri, new vscode.Position(localMethod.line, localMethod.column)));
                            continue;
                        }
                    }
                    const found = index.findMethodInClassChain(owner, wordInfo.word);
                    if (found) results.push(...locationsForMethod(found.owner, found.method));
                } else {
                    if (chainAtWord.segments[0].name !== 'super' && inlineContext && inlineContext.locals && owner === contextClass) {
                        const localMember = inlineContext.locals.members.get(wordInfo.word);
                        if (localMember) {
                            results.push(new vscode.Location(document.uri, new vscode.Position(localMember.line, localMember.column)));
                            continue;
                        }
                    }
                    const found = index.findMemberInClassChain(owner, wordInfo.word);
                    if (found) results.push(locationForMember(found.owner, found.member));
                }
            }

            return results.length > 0 ? uniqueLocations(results) : null;
        }
        const local = !isCall && findLocalVariableDefinition(document, position, wordInfo.word);
        if (local) {
            return new vscode.Location(document.uri, new vscode.Position(local.line, local.column));
        }

        if (isCall) {
            if (inlineContext && inlineContext.locals) {
                const localMethod = inlineContext.locals.methods.get(wordInfo.word);
                if (localMethod) {
                    return new vscode.Location(document.uri, new vscode.Position(localMethod.line, localMethod.column));
                }
            }
            const found = index.findMethodInClassChain(contextClass, wordInfo.word);
            if (found) return locationsForMethod(found.owner, found.method);
        } else {
            if (inlineContext && inlineContext.locals) {
                const localMember = inlineContext.locals.members.get(wordInfo.word);
                if (localMember) {
                    return new vscode.Location(document.uri, new vscode.Position(localMember.line, localMember.column));
                }
            }
            const found = index.findMemberInClassChain(contextClass, wordInfo.word);
            if (found) return locationForMember(found.owner, found.member);
        }

        const explicitImport = findExplicitImport(baseContextClass, wordInfo.word);
        if (explicitImport) {
            const info = index.getClassByFullName(explicitImport, baseContextClass);
            if (info) return locationForClass(info);
            const javaFile = await findJavaFileByClassName(explicitImport, document.uri.fsPath);
            if (javaFile) {
                return new vscode.Location(vscode.Uri.file(javaFile), new vscode.Position(0, 0));
            }
            return null;
        }

        const typeMatches = index.resolveClassName(contextClass, wordInfo.word);
        if (typeMatches.length > 0) {
            const locations = typeMatches.map(locationForClass);
            return uniqueLocations(locations);
        }

        return null;
    }
}

class BlReferenceProvider {
    async provideReferences(document, position, context, token) {
        const cancelled = () => disposed || token && token.isCancellationRequested;
        if (cancelled()) return [];
        await ensureIndexReady(token);
        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo || cancelled()) return [];
        const requestVersion = document.version;
        const openDocuments = new Map(vscode.workspace.textDocuments.filter(doc => doc.languageId === 'bl').map(doc => [doc.uri.fsPath, doc]));
        openDocuments.set(document.uri.fsPath, document);
        for (const doc of openDocuments.values()) updateIndexFromDocument(doc);

        const definitions = new BlDefinitionProvider();
        const target = await definitions.provideDefinition(document, position, token);
        const targets = (Array.isArray(target) ? target : target ? [target] : []);
        if (!targets.length || cancelled()) return [];
        const locationKey = location => `${location.uri.fsPath}:${location.range.start.line}:${location.range.start.character}`;
        const targetKeys = new Set(targets.map(locationKey));
        const results = [];
        const files = new Set(index.getReferenceCandidates(wordInfo.word));
        const regex = new RegExp(`\\b${escapeRegex(wordInfo.word)}\\b`, 'g');
        let lastYield = Date.now();
        let failedFiles = 0;
        for (const file of files) {
            if (cancelled() || document.version !== requestVersion) return [];
            let candidateDocument = openDocuments.get(file);
            let analysis;
            const fileUri = candidateDocument ? candidateDocument.uri : vscode.Uri.file(file);
            if (!candidateDocument) {
                try {
                    const content = await fs.promises.readFile(file, 'utf8');
                    if (cancelled()) return [];
                    analysis = new DocumentAnalysis(content);
                    const rawLines = content.split(/\r?\n/);
                    candidateDocument = {
                        uri: fileUri, languageId: 'bl',
                        getText: range => !range ? content : rawLines[range.start.line].slice(range.start.character, range.end.character),
                        lineAt: line => ({ text: rawLines[line] }),
                        getWordRangeAtPosition(pos) {
                            const wordRegex = /\w+/g;
                            let match;
                            while ((match = wordRegex.exec(analysis.lines[pos.line]))) {
                                if (pos.character >= match.index && pos.character < match.index + match[0].length) {
                                    return new vscode.Range(pos.line, match.index, pos.line, match.index + match[0].length);
                                }
                            }
                            return null;
                        }
                    };
                    lexicalDocuments.set(candidateDocument, { analysis });
                } catch (error) {
                    if (error.code === 'ENOENT') index.removeFile(file);
                    else {
                        failedFiles++;
                        if (debugOutput) debugOutput.appendLine(`Reference read error: ${file}: ${error.message}`);
                    }
                    continue;
                }
            }
            analysis = analysis || getAnalysis(candidateDocument);
            updateIndexFromDocument(candidateDocument);
            const version = candidateDocument.version;
            for (let line = 0; line < analysis.lines.length; line++) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(analysis.lines[line]))) {
                    if (Date.now() - lastYield >= 8) {
                        await yieldToHost();
                        lastYield = Date.now();
                    }
                    if (cancelled() || candidateDocument.version !== version || document.version !== requestVersion) return [];
                    const location = new vscode.Location(fileUri, new vscode.Position(line, match.index));
                    if (!context.includeDeclaration && targetKeys.has(locationKey(location))) continue;
                    const resolved = await definitions.provideDefinition(candidateDocument, location.range.start, token);
                    if (cancelled() || candidateDocument.version !== version) return [];
                    const candidates = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
                    if (candidates.some(candidate => targetKeys.has(locationKey(candidate)))) results.push(location);
                }
            }
            if (Date.now() - lastYield >= 8) {
                await yieldToHost();
                lastYield = Date.now();
            }
        }
        if (cancelled() || document.version !== requestVersion) return [];
        if (failedFiles) vscode.window.showWarningMessage(`Поиск ссылок BL неполный: не удалось прочитать ${failedFiles} файлов. Подробности в BL Debug.`);
        return results;
    }
}

class BlCodeLensProvider {
    constructor() {
        this.changes = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this.changes.event;
    }

    async provideCodeLenses(document, token) {
        const codeLenses = [];
        if (!configuration(document).get('codeLens.enabled', true) || token && token.isCancellationRequested) return codeLenses;
        const text = document.getText();

        const nativeClass = getNativeAttribute(text);
        if (nativeClass) {
            const javaFile = await findJavaFileByClassName(nativeClass, document.uri.fsPath);
            if (javaFile) {
                const match = text.match(/\[(?:native|primary)\s+"([^"]+)"\]/);
                if (match) {
                    const startIndex = text.indexOf(match[0]);
                    const startPos = document.positionAt(startIndex);
                    const endPos = document.positionAt(startIndex + match[0].length);
                    codeLenses.push(new vscode.CodeLens(
                        new vscode.Range(startPos, endPos),
                        {
                            title: `→ Native Java: ${path.basename(javaFile)}`,
                            command: 'vscode.open',
                            arguments: [vscode.Uri.file(javaFile)]
                        }
                    ));
                }
            }
        }

        const compiledJava = findCompiledJavaFile(document.uri.fsPath);
        if (compiledJava) {
            const classMatch = text.match(/\bclass\s+(\w+)/);
            if (classMatch) {
                const startIndex = text.indexOf(classMatch[0]);
                const startPos = document.positionAt(startIndex);
                const endPos = document.positionAt(startIndex + classMatch[0].length);
                codeLenses.push(new vscode.CodeLens(
                    new vscode.Range(startPos, endPos),
                    {
                        title: `→ Compiled Java: ${path.basename(compiledJava)}`,
                        command: 'vscode.open',
                        arguments: [vscode.Uri.file(compiledJava)]
                    }
                ));
            }
        }

        return token && token.isCancellationRequested ? [] : codeLenses;
    }
}

class BlHoverProvider {
    provideHover(document, position, token) {
        const line = document.lineAt(position.line).text;
        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return null;

        const importMatch = line.match(/^\s*import\s+([\w.]+)\s*;/);
        if (importMatch && line.includes(wordInfo.word)) {
            const info = index.getClassByFullName(importMatch[1], updateIndexFromDocument(document));
            if (info) {
                return new vscode.Hover(
                    `**BL Class**: \`${importMatch[1]}\`\n\nCmd+Click для перехода к определению`,
                    wordInfo.range
                );
            }
        }

        return null;
    }
}

function getWordUnderCursor(document, position) {
    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) return null;
    return document.getText(range);
}

function findContainingMethodName(document, position) {
    const lines = document.getText().split(/\r?\n/);
    for (let i = position.line; i >= 0; i--) {
        const line = stripInlineAttributes(lines[i]);
        const match = line.match(METHOD_DEF_RE);
        if (match) return match[2];
    }
    return null;
}

function getCurrentContext(document, position) {
    const word = getWordUnderCursor(document, position);
    if (!word) return null;

    const methodName = findContainingMethodName(document, position);
    const isLocalVar = !!findLocalVariableDefinition(document, position, word);

    const currentLine = stripInlineAttributes(document.lineAt(position.line).text);
    const methodDefMatch = currentLine.match(METHOD_DEF_RE);
    const isMethodDef = methodDefMatch && methodDefMatch[2] === word;

    const fieldDefMatch = currentLine.match(FIELD_DEF_RE);
    const isFieldDef = fieldDefMatch && fieldDefMatch[2] === word;

    return {
        word,
        methodName,
        isLocalVar,
        isMethodDef,
        isFieldDef
    };
}

function findPositionInJava(javaFilePath, context) {
    try {
        const content = fs.readFileSync(javaFilePath, 'utf8');
        const lines = content.split(/\r?\n/);

        if (context.isLocalVar && context.methodName) {
            const javaMethodName = `z8_${context.methodName}`;
            let inMethod = false;
            let braceCount = 0;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!inMethod) {
                    const methodDefRegex = new RegExp(`(public|private|protected)\\s+.*\\b${javaMethodName}\\s*\\(`);
                    if (methodDefRegex.test(line)) {
                        inMethod = true;
                        braceCount = 0;
                    }
                }

                if (inMethod) {
                    braceCount += (line.match(/\{/g) || []).length;
                    braceCount -= (line.match(/\}/g) || []).length;

                    const varPattern = new RegExp(`\\b${context.word}\\s*=`);
                    if (varPattern.test(line)) {
                        const idx = line.indexOf(context.word);
                        return new vscode.Position(i, idx);
                    }

                    if (braceCount <= 0 && i > 0) break;
                }
            }
        }

        if (context.isMethodDef || (!context.isLocalVar && !context.isFieldDef)) {
            const javaMethodName = `z8_${context.word}`;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const methodDefRegex = new RegExp(`(public|private|protected)\\s+.*\\b${javaMethodName}\\s*\\(`);
                if (methodDefRegex.test(line)) {
                    return new vscode.Position(i, line.indexOf(javaMethodName));
                }
            }
        }

        if (context.isFieldDef) {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const fieldDefRegex = new RegExp(`(public|private|protected)\\s+[\\w<>\\[\\],\\s\\.\\?]+\\s+${context.word}\\s*[=;]`);
                if (fieldDefRegex.test(line)) {
                    return new vscode.Position(i, line.indexOf(context.word));
                }
            }
        }

        return new vscode.Position(0, 0);
    } catch (err) {
        return new vscode.Position(0, 0);
    }
}

function findPositionInNativeJava(javaFilePath, context) {
    try {
        const content = fs.readFileSync(javaFilePath, 'utf8');
        const lines = content.split(/\r?\n/);

        if (context.isLocalVar && context.methodName) {
            let inMethod = false;
            let braceCount = 0;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!inMethod) {
                    const methodDefRegex = new RegExp(`(public|private|protected)\\s+.*\\b${context.methodName}\\s*\\(`);
                    if (methodDefRegex.test(line)) {
                        inMethod = true;
                        braceCount = 0;
                    }
                }

                if (inMethod) {
                    braceCount += (line.match(/\{/g) || []).length;
                    braceCount -= (line.match(/\}/g) || []).length;

                    const varPattern = new RegExp(`\\b${context.word}\\s*[=;]`);
                    if (varPattern.test(line)) {
                        const idx = line.indexOf(context.word);
                        return new vscode.Position(i, idx);
                    }

                    if (braceCount <= 0 && i > 0) break;
                }
            }
        }

        if (context.isMethodDef || (!context.isLocalVar && !context.isFieldDef)) {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const methodDefRegex = new RegExp(`(public|private|protected)\\s+.*\\b${context.word}\\s*\\(`);
                if (methodDefRegex.test(line)) {
                    return new vscode.Position(i, line.indexOf(context.word));
                }
            }
        }

        if (context.isFieldDef) {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const fieldDefRegex = new RegExp(`(public|private|protected)\\s+[\\w<>\\[\\],\\s\\.\\?]+\\s+${context.word}\\s*[=;]`);
                if (fieldDefRegex.test(line)) {
                    return new vscode.Position(i, line.indexOf(context.word));
                }
            }
        }

        return new vscode.Position(0, 0);
    } catch (err) {
        return new vscode.Position(0, 0);
    }
}

function goToCompiledJava() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    if (!document.fileName.endsWith('.bl')) {
        vscode.window.showWarningMessage('Эта команда работает только для .bl файлов');
        return;
    }

    const compiledJava = findCompiledJavaFile(document.uri.fsPath);
    if (!compiledJava) {
        vscode.window.showWarningMessage('Скомпилированный Java файл не найден');
        return;
    }

    const context = getCurrentContext(document, editor.selection.active);
    vscode.workspace.openTextDocument(compiledJava).then(doc => {
        const position = context ? findPositionInJava(compiledJava, context) : new vscode.Position(0, 0);
        vscode.window.showTextDocument(doc).then(newEditor => {
            newEditor.selection = new vscode.Selection(position, position);
            newEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        });
    });
}

async function goToNativeJava() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    if (!document.fileName.endsWith('.bl')) {
        vscode.window.showWarningMessage('Эта команда работает только для .bl файлов');
        return;
    }

    const nativeClass = getNativeAttribute(document.getText());
    if (!nativeClass) {
        vscode.window.showWarningMessage('В этом файле нет атрибута [native]');
        return;
    }

    const javaFile = await findJavaFileByClassName(nativeClass, document.uri.fsPath);
    if (!javaFile) {
        vscode.window.showWarningMessage(`Java файл не найден: ${nativeClass}`);
        return;
    }

    const context = getCurrentContext(document, editor.selection.active);
    const doc = await vscode.workspace.openTextDocument(javaFile);
    const position = context ? findPositionInNativeJava(javaFile, context) : new vscode.Position(0, 0);
    const newEditor = await vscode.window.showTextDocument(doc);
    newEditor.selection = new vscode.Selection(position, position);
    newEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function showDebugContext(outputChannel) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Нет активного редактора');
        return;
    }

    const document = editor.document;
    const position = editor.selection.active;
    if (document.languageId !== 'bl') {
        vscode.window.showWarningMessage('Эта команда работает только для .bl файлов');
        return;
    }

    const baseContext = updateIndexFromDocument(document) || index.getClassByFile(document.uri.fsPath);
    const inlineContext = getInlineContext(document, position, baseContext);
    const effectiveContext = inlineContext ? inlineContext.info : baseContext;
    const wordInfo = getWordAtPosition(document, position);
    const lineText = document.lineAt(position.line).text;
    const isCall = wordInfo ? isMethodCallAt(document, wordInfo.range) : false;

    const chain = wordInfo ? parseAccessChain(lineText, wordInfo.range.start.character) : null;
    const owners = chain && effectiveContext ? resolveChainTypeCandidates(effectiveContext, document, position, chain, inlineContext, baseContext) : [];
    const methodFromContext = wordInfo && effectiveContext ? index.findMethodInClassChain(effectiveContext, wordInfo.word) : null;
    const memberFromContext = wordInfo && effectiveContext ? index.findMemberInClassChain(effectiveContext, wordInfo.word) : null;

    if (outputChannel) {
        outputChannel.clear();
        outputChannel.appendLine('BL Debug Context');
        outputChannel.appendLine(`File: ${document.uri.fsPath}`);
        outputChannel.appendLine(`Line: ${position.line + 1}, Column: ${position.character + 1}`);
        outputChannel.appendLine(`Word: ${wordInfo ? wordInfo.word : '(none)'}`);
        outputChannel.appendLine(`IsCall: ${isCall}`);
        outputChannel.appendLine(`BaseContext: ${baseContext ? baseContext.fullName : '(none)'}`);
        outputChannel.appendLine(`EffectiveContext: ${effectiveContext ? effectiveContext.fullName : '(none)'}`);
        outputChannel.appendLine(`Chain: ${chain ? chain.map(seg => seg.name + (seg.isCall ? '()' : '')).join('.') : '(none)'}`);
        outputChannel.appendLine(`ChainOwners: ${owners.map(o => o.fullName).join(', ') || '(none)'}`);
        outputChannel.appendLine(`MethodInContext: ${methodFromContext ? `${methodFromContext.owner.fullName}#${methodFromContext.method.name}` : '(none)'}`);
        outputChannel.appendLine(`MemberInContext: ${memberFromContext ? `${memberFromContext.owner.fullName}#${memberFromContext.member.name}` : '(none)'}`);
        outputChannel.show(true);
    }

    vscode.window.showInformationMessage(
        `BL контекст: ${effectiveContext ? effectiveContext.fullName : 'нет'} | слово=${wordInfo ? wordInfo.word : 'нет'}`
    );
}

function showLineAnalysis(outputChannel) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Нет активного редактора');
        return;
    }

    const document = editor.document;
    const position = editor.selection.active;
    if (document.languageId !== 'bl') {
        vscode.window.showWarningMessage('Эта команда работает только для .bl файлов');
        return;
    }

    const baseContext = updateIndexFromDocument(document) || index.getClassByFile(document.uri.fsPath);
    const inlineContext = getInlineContext(document, position, baseContext);
    const effectiveContext = inlineContext ? inlineContext.info : baseContext;
    const rawLine = document.lineAt(position.line).text;
    const cleanLine = stripInlineAttributes(rawLine);
    const chains = findChainsInLine(cleanLine);

    if (outputChannel) {
        outputChannel.clear();
        outputChannel.appendLine('BL Debug Line Analysis');
        outputChannel.appendLine(`File: ${document.uri.fsPath}`);
        outputChannel.appendLine(`Line: ${position.line + 1}`);
        outputChannel.appendLine(`BaseContext: ${baseContext ? baseContext.fullName : '(none)'}`);
        outputChannel.appendLine(`EffectiveContext: ${effectiveContext ? effectiveContext.fullName : '(none)'}`);
        outputChannel.appendLine(`InlineContext: ${inlineContext ? inlineContext.info.fullName : '(none)'}`);
        outputChannel.appendLine(`LineText: ${cleanLine.trim()}`);
        outputChannel.appendLine(`Chains: ${chains.length}`);

        chains.forEach((chain, chainIndex) => {
            const chainText = cleanLine.slice(chain.start, chain.end).trim();
            outputChannel.appendLine(`Chain[${chainIndex}]: ${chainText}`);
            outputChannel.appendLine(
                `Segments: ${chain.segments.map(seg => `${seg.name}${seg.isCall ? '()' : ''}${seg.hasIndex ? '[i]' : ''}`).join('.')}`
            );

            const first = chain.segments[0];
            const pos = new vscode.Position(position.line, chain.start + first.offset);
            const forceClass = isNewKeywordBefore(cleanLine, chain.start);
            let candidates = forceClass
                ? resolveTypeNameWithMeta(effectiveContext, first.name, baseContext)
                : resolveIdentifierTypeCandidatesWithMeta(
                    effectiveContext,
                    document,
                    pos,
                    first.name,
                    inlineContext,
                    baseContext,
                    first.isCall
                );
            outputChannel.appendLine(`ForceClass: ${forceClass}`);
            outputChannel.appendLine(
                `Candidates[0]: ${candidates.map(c => `${c.info.fullName}${c.elementTypeName ? ` -> ${c.elementTypeName}` : ''}`).join(', ') || '(none)'}`
            );

            for (let i = 1; i < chain.segments.length; i++) {
                const segment = chain.segments[i];
                const receiver = chain.segments[i - 1];
                const next = [];
                let foundAny = false;

                for (const candidate of candidates) {
                    let lookupCandidates = [candidate];
                    if (receiver.hasIndex) {
                        if (candidate.elementTypeName) {
                            lookupCandidates = resolveTypeNameWithMeta(effectiveContext, candidate.elementTypeName, baseContext);
                        } else {
                            continue;
                        }
                    }

                    for (const lookup of lookupCandidates) {
                        if (segment.isCall) {
                            const method = index.findMethodInClassChain(lookup.info, segment.name);
                            if (method) {
                                foundAny = true;
                                next.push(...resolveTypeNameWithMeta(method.owner, method.method.returnType));
                            }
                        } else {
                            const member = index.findMemberInClassChain(lookup.info, segment.name);
                            if (member) {
                                foundAny = true;
                                next.push(...resolveTypeNameWithMeta(member.owner, member.member.typeName));
                            }
                        }
                    }
                }

                outputChannel.appendLine(
                    `Segment[${i}]: ${segment.name}${segment.isCall ? '()' : ''} found=${foundAny}`
                );
                outputChannel.appendLine(
                    `Candidates[${i}]: ${next.map(c => `${c.info.fullName}${c.elementTypeName ? ` -> ${c.elementTypeName}` : ''}`).join(', ') || '(none)'}`
                );

                candidates = next;
            }
        });

        outputChannel.show(true);
    }
}

function showDiagnosticsDump(outputChannel) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Нет активного редактора');
        return;
    }

    const document = editor.document;
    if (document.languageId !== 'bl') {
        vscode.window.showWarningMessage('Эта команда работает только для .bl файлов');
        return;
    }

    const line = editor.selection.active.line;
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    const onLine = diagnostics.filter(diag => diag.range.start.line === line);

    if (outputChannel) {
        outputChannel.clear();
        outputChannel.appendLine('BL Diagnostics Dump');
        outputChannel.appendLine(`File: ${document.uri.fsPath}`);
        outputChannel.appendLine(`Line: ${line + 1}`);
        outputChannel.appendLine(`Total diagnostics: ${diagnostics.length}`);
        outputChannel.appendLine(`Line diagnostics: ${onLine.length}`);
        for (const diag of diagnostics) {
            const source = diag.source || 'unknown';
            const code = diag.code ? ` ${diag.code}` : '';
            const start = diag.range.start;
            const end = diag.range.end;
            outputChannel.appendLine(`[${source}${code}] L${start.line + 1}:${start.character + 1}-L${end.line + 1}:${end.character + 1} ${diag.message}`);
        }
        outputChannel.show(true);
    }
}

async function activate(context) {
    disposed = false;
    debugOutput = vscode.window.createOutputChannel('BL Debug');
    await rebuildIndex();
    const diagnostics = vscode.languages.createDiagnosticCollection('bl');
    diagnosticsCollection = diagnostics;
    debugOutput.appendLine('BL Language Support activated');

    const selector = { language: 'bl', scheme: 'file' };

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector, new BlDefinitionProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider(selector, new BlReferenceProvider())
    );
    const codeLensProvider = new BlCodeLensProvider();
    context.subscriptions.push(vscode.languages.registerCodeLensProvider(selector, codeLensProvider));
    context.subscriptions.push(codeLensProvider.changes);
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(selector, new BlHoverProvider())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('bl.goToCompiledJava', goToCompiledJava)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('bl.goToNativeJava', goToNativeJava)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('bl.showContext', () => showDebugContext(debugOutput))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('bl.analyzeLine', () => showLineAnalysis(debugOutput))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('bl.dumpDiagnostics', () => showDiagnosticsDump(debugOutput))
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.bl');
    watcher.onDidCreate(() => scheduleDiscovery());
    watcher.onDidChange(uri => workspaceFiles.has(uri.fsPath) ? refreshFile(uri) : undefined);
    watcher.onDidDelete(uri => {
        pendingReads.delete(uri.fsPath);
        workspaceFiles.delete(uri.fsPath);
        index.removeFile(uri.fsPath);
        for (const doc of vscode.workspace.textDocuments) scheduleDiagnostics(doc, diagnostics);
    });
    const javaWatcher = vscode.workspace.createFileSystemWatcher('**/*.java');
    const javaChanged = (uri, pathsChanged) => {
        attributeDefinitions.delete(uri.fsPath);
        if (pathsChanged) for (const className of javaFiles.keys()) {
            const suffix = '/' + className.replace(/\./g, '/') + '.java';
            if (uri.fsPath.split(path.sep).join('/').endsWith(suffix)) javaFiles.delete(className);
        }
        clearTimeout(javaLensTimer);
        javaLensTimer = setTimeout(() => codeLensProvider.changes.fire(), 100);
    };
    javaWatcher.onDidCreate(uri => javaChanged(uri, true));
    javaWatcher.onDidChange(uri => javaChanged(uri, false));
    javaWatcher.onDidDelete(uri => javaChanged(uri, true));
    context.subscriptions.push(watcher);
    context.subscriptions.push(javaWatcher);
    context.subscriptions.push(diagnostics);
    context.subscriptions.push(debugOutput);

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.languageId !== 'bl') return;
        dirtyDocuments.add(doc);
        updateDiagnostics(doc, diagnostics);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId !== 'bl') return;
        if (!event.contentChanges || event.contentChanges.length) {
            dirtyDocuments.add(event.document);
            scheduleDiagnostics(event.document, diagnostics);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId !== 'bl') return;
        updateIndexFromDocument(doc);
        updateDiagnostics(doc, diagnostics);
        for (const other of vscode.workspace.textDocuments) if (other !== doc) scheduleDiagnostics(other, diagnostics);
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
        dirtyDocuments.delete(doc);
        if (doc.languageId !== 'bl') return;
        cancelDiagnostics(doc);
        lexicalDocuments.delete(doc);
        documentIndex.delete(doc);
        diagnostics.delete(doc.uri);
        if (doc.languageId === 'bl' && workspaceFiles.has(doc.uri.fsPath)) refreshFile(doc.uri);
        else index.removeFile(doc.uri.fsPath);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('bl.index.exclude')) rebuildIndex();
        if (event.affectsConfiguration('bl.codeLens.enabled')) codeLensProvider.changes.fire();
        if (event.affectsConfiguration('bl.diagnostics')) {
            for (const doc of vscode.workspace.textDocuments) updateDiagnostics(doc, diagnostics);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { invalidateJava(); rebuildIndex(); }));
    context.subscriptions.push({ dispose: deactivate });

    if (vscode.window.activeTextEditor) {
        updateDiagnostics(vscode.window.activeTextEditor.document, diagnostics);
    }

    console.log('BL Language Support extension activated');
}

function deactivate() {
    disposed = true;
    buildGeneration++;
    clearTimeout(discoveryTimer);
    clearTimeout(javaLensTimer);
    discoveryTimer = null;
    for (const pending of diagnosticTimers.values()) clearTimeout(pending.timer);
    diagnosticTimers.clear();
    dirtyDocuments.clear();
    pendingReads.clear();
    invalidateJava();
    documentIndex = new WeakMap();
    lexicalDocuments = new WeakMap();
    diagnosticsCollection = null;
    workspaceFiles.clear();
    for (const file of Array.from(index.wordFilters.keys())) index.removeFile(file);
    index.wordHashCache.clear();
}

module.exports = { activate, deactivate };
