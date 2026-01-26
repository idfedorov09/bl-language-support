const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const {
    BlIndex,
    getBlRootFromFilePath,
    getModuleRootFromBlFile
} = require('./blIndex');

const index = new BlIndex();
let debugOutput = null;

const TYPE_PATTERN = String.raw`[A-Za-z_][\w.]*\s*(?:\[[^\]]*\])*`;
const METHOD_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\])*)\s+(\w+)\s*\(/;
const FIELD_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\])*)\s+(\w+)\s*[=;]/;
const MODIFIER_RE = /\b(public|private|protected|static|final|virtual|abstract|auto)\b/;
const MODIFIERS_RE = /\b(public|private|protected|static|final|virtual|abstract|auto)\b/g;

async function buildIndex() {
    const blFiles = await vscode.workspace.findFiles('**/*.bl', '**/node_modules/**');
    index.indexFiles(blFiles.map(f => f.fsPath));
}

function updateIndexFromDocument(document) {
    return index.updateFromText(document.uri.fsPath, document.getText());
}

function sanitizeText(text) {
    let out = '';
    let inLine = false;
    let inBlock = false;
    let inString = null;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = i + 1 < text.length ? text[i + 1] : '';

        if (inLine) {
            if (ch === '\n') {
                inLine = false;
                out += '\n';
            } else {
                out += ' ';
            }
            continue;
        }

        if (inBlock) {
            if (ch === '*' && next === '/') {
                inBlock = false;
                out += '  ';
                i++;
            } else if (ch === '\n') {
                out += '\n';
            } else {
                out += ' ';
            }
            continue;
        }

        if (inString) {
            if (escape) {
                escape = false;
                out += ' ';
                continue;
            }
            if (ch === '\\') {
                escape = true;
                out += ' ';
                continue;
            }
            if (ch === '\n') {
                out += '\n';
                continue;
            }
            if (ch === inString) {
                inString = null;
            }
            out += ' ';
            continue;
        }

        if (ch === '/' && next === '/') {
            inLine = true;
            out += '  ';
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlock = true;
            out += '  ';
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = ch;
            out += ' ';
            continue;
        }

        out += ch;
    }

    return out;
}

function stripInlineAttributes(line) {
    let out = '';
    let i = 0;

    while (i < line.length) {
        const ch = line[i];
        const prev = i > 0 ? line[i - 1] : '';

        if (ch === '[' && (i === 0 || /\s/.test(prev))) {
            const end = line.indexOf(']', i + 1);
            if (end !== -1) {
                i = end + 1;
                while (i < line.length && /\s/.test(line[i])) i++;
                continue;
            }
        }

        out += ch;
        i += 1;
    }

    return out;
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
    const text = sanitizeText(document.getText());
    const lines = text.split(/\r?\n/);
    const map = new Array(lines.length).fill(null);
    const inlineStack = [];
    let braceDepth = 0;
    let pendingInlineType = null;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const cleanLine = stripInlineAttributes(rawLine);
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

    return map;
}

function isIdentifierStart(ch) {
    return /[A-Za-z_]/.test(ch);
}

function isIdentifierChar(ch) {
    return /[A-Za-z0-9_]/.test(ch);
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

function parseChainAt(text, startIndex) {
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

    if (segments.length < 2) return null;
    return { start: startIndex, end: i, segments };
}

function findChainsInLine(text) {
    const chains = [];
    for (let i = 0; i < text.length; i++) {
        if (!isIdentifierStart(text[i])) continue;
        const prev = i > 0 ? text[i - 1] : '';
        if (isIdentifierChar(prev) || prev === '.') continue;
        const chain = parseChainAt(text, i);
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

function resolveIdentifierTypeCandidatesWithMeta(context, document, position, name, inlineContext, importContext) {
    if (!context || !name) return [];

    if (name === 'this') {
        return [{
            info: context,
            isArrayLike: false,
            isNative: Boolean(context.nativeClassName)
        }];
    }

    if (name === 'super') {
        const base = index.resolveBaseClass(context);
        return base ? [{
            info: base,
            isArrayLike: false,
            isNative: Boolean(base.nativeClassName)
        }] : [];
    }

    const local = findLocalVariableDefinition(document, position, name);
    if (local) return resolveTypeNameWithMeta(context, local.typeName, importContext);

    const member = index.findMemberInClassChain(context, name);
    if (member) return resolveTypeNameWithMeta(member.owner, member.member.typeName);

    if (inlineContext && inlineContext.locals) {
        if (inlineContext.locals.members.has(name)) {
            const localMember = inlineContext.locals.members.get(name);
            return resolveTypeNameWithMeta(context, localMember.typeName, importContext);
        }
    }

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
    const text = sanitizeText(document.getText());
    const lines = text.split(/\r?\n/);
    const diagnostics = [];
    const stack = [];
    const inlineContextMap = getInlineContextMap(document, contextClass);

    for (let line = 0; line < lines.length; line++) {
        const lineText = lines[line];
        const cleanLine = stripInlineAttributes(lineText);
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
                if (debugOutput && cleanLine.includes('documents[i].getDocumentId')) {
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
                        : resolveIdentifierTypeCandidatesWithMeta(effectiveContext, document, pos, first.name, inlineContext, contextClass);
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
                                    if (inlineContext && inlineContext.locals && info === effectiveContext) {
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
                                        next.push(...resolveTypeNameWithMeta(method.owner, method.method.returnType));
                                    }
                                } else {
                                    if (inlineContext && inlineContext.locals && info === effectiveContext) {
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
                            if (debugOutput && segment.name === 'getDocumentId' && cleanLine.includes('documents[i].getDocumentId')) {
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
                if (debugOutput && cleanLine.includes('documents[i].getDocumentId')) {
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
                    if (debugOutput && name === 'access' && cleanLine.includes('addHaving(access())')) {
                        debugOutput.appendLine('Diagnostic: Unknown method access');
                        debugOutput.appendLine(`Line: ${line + 1}`);
                        debugOutput.appendLine(`BaseContext: ${contextClass ? contextClass.fullName : '(none)'}`);
                        debugOutput.appendLine(`EffectiveContext: ${effectiveContext ? effectiveContext.fullName : '(none)'}`);
                    }
                    if (debugOutput && name === 'getDocumentId' && cleanLine.includes('documents[i].getDocumentId')) {
                        debugOutput.appendLine('Diagnostic: Unknown method getDocumentId (call pass)');
                        debugOutput.appendLine(`Line: ${line + 1}`);
                        debugOutput.appendLine(`LineText: ${cleanLine.trim()}`);
                        debugOutput.appendLine(`NameIndex: ${nameIndex}`);
                    }
                }
            }

            if (debugOutput && cleanLine.includes('documents[i].getDocumentId')) {
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
    const context = updateIndexFromDocument(document);
    collection.set(document.uri, collectDiagnostics(document, context));
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

function getNativeAttribute(text) {
    const match = text.match(/\[(?:native|primary)\s+"([^"]+)"\]/);
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

async function findJavaFileByClassName(className) {
    const rel = className.replace(/\./g, '/') + '.java';
    const files = await vscode.workspace.findFiles(`**/src/main/java/${rel}`, '**/node_modules/**', 1);
    if (files.length > 0) return files[0].fsPath;

    const alt = await vscode.workspace.findFiles(`**/src/java/${rel}`, '**/node_modules/**', 1);
    if (alt.length > 0) return alt[0].fsPath;

    return null;
}

async function findMethodReferences(methodName, token) {
    const results = [];
    const blFiles = await vscode.workspace.findFiles('**/*.bl', '**/node_modules/**');
    const callRegex = new RegExp(`\\b${methodName}\\s*\\(`);

    for (const fileUri of blFiles) {
        if (token && token.isCancellationRequested) break;
        try {
            const content = fs.readFileSync(fileUri.fsPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!callRegex.test(line)) continue;

                const idx = line.indexOf(methodName);
                if (idx !== -1) {
                    results.push(new vscode.Location(fileUri, new vscode.Position(i, idx)));
                }
            }
        } catch (err) {
            // ignore
        }
    }

    return results;
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findAttributeDefinitionLocation(attributeName) {
    const javaFile = await findJavaFileByClassName('org.zenframework.z8.compiler.core.IAttribute');
    if (!javaFile) return null;

    try {
        const content = fs.readFileSync(javaFile, 'utf8');
        const lines = content.split(/\r?\n/);
        const attrRegex = new RegExp(`\\bString\\s+(\\w+)\\s*=\\s*\"${escapeRegex(attributeName)}\"`);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(attrRegex);
            if (match) {
                const name = match[1];
                const column = line.indexOf(name);
                const pos = new vscode.Position(i, Math.max(0, column));
                return new vscode.Location(vscode.Uri.file(javaFile), pos);
            }
        }

        return new vscode.Location(vscode.Uri.file(javaFile), new vscode.Position(0, 0));
    } catch (err) {
        return null;
    }
}

async function findIdentifierReferences(identifier, token) {
    const results = [];
    const blFiles = await vscode.workspace.findFiles('**/*.bl', '**/node_modules/**');
    const safe = escapeRegex(identifier);
    const idRegex = new RegExp(`\\b${safe}\\b`, 'g');

    for (const fileUri of blFiles) {
        if (token && token.isCancellationRequested) break;
        try {
            const content = fs.readFileSync(fileUri.fsPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                let match;
                while ((match = idRegex.exec(line)) !== null) {
                    results.push(new vscode.Location(fileUri, new vscode.Position(i, match.index)));
                }
            }
        } catch (err) {
            // ignore
        }
    }

    return results;
}

function parseAccessChain(line, wordStart) {
    const before = line.slice(0, wordStart);
    const trimmedLength = before.replace(/\s+$/, '').length;
    if (trimmedLength === 0) return null;
    const chains = findChainsInLine(before);
    if (chains.length === 0) return null;
    const match = [...chains].reverse().find(chain => chain.end >= trimmedLength);
    return match ? match.segments : null;
}

function buildContinuationText(lines, lineIndex, wordStart) {
    let i = lineIndex - 1;
    const prefixParts = [];

    while (i >= 0) {
        const line = stripInlineAttributes(lines[i]);
        const trimmed = line.trim();
        if (!trimmed) break;
        if (!trimmed.endsWith('.')) break;
        prefixParts.unshift(trimmed);
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

function getContinuationChain(document, lineIndex, wordStart) {
    const text = sanitizeText(document.getText());
    const lines = text.split(/\r?\n/);
    const continuation = buildContinuationText(lines, lineIndex, wordStart);
    if (!continuation) return null;
    return parseAccessChain(continuation.combined, continuation.wordStart);
}

function getMethodSignatureText(lines, startLine) {
    let text = lines[startLine];
    let i = startLine;
    while (i + 1 < lines.length && text.indexOf(')') === -1) {
        i += 1;
        text += lines[i];
    }
    return text;
}

function findLocalVariableDefinition(document, position, varName) {
    const lines = document.getText().split(/\r?\n/);
    const keywordTypes = new Set(['return', 'if', 'else', 'while', 'for', 'throw', 'try', 'catch', 'auto']);

    for (let i = position.line; i >= 0; i--) {
        const line = lines[i];

        const methodMatch = line.match(METHOD_DEF_RE);
        if (methodMatch) {
            const signature = getMethodSignatureText(lines, i);
            const paramsMatch = signature.match(/\((.*)\)/);
            if (paramsMatch) {
                const params = paramsMatch[1];
                const paramRe = new RegExp(String.raw`(${TYPE_PATTERN})\s+(\w+)`, 'g');
                let match;
                while ((match = paramRe.exec(params)) !== null) {
                    const typeName = match[1];
                    const name = match[2];
                    if (name === varName) {
                        return { line: i, column: line.indexOf(name), typeName };
                    }
                }
            }
            break;
        }

        const varMatch = line.match(new RegExp(String.raw`^\s*(${TYPE_PATTERN})\s+${varName}\s*[=;]`));
        if (varMatch) {
            const typeName = varMatch[1].trim();
            if (!keywordTypes.has(typeName)) {
                return { line: i, column: line.indexOf(varName), typeName };
            }
        }

        const forMatch = line.match(new RegExp(String.raw`\bfor\s*\(\s*(${TYPE_PATTERN})\s+${varName}\b`));
        if (forMatch) {
            return { line: i, column: line.indexOf(varName), typeName: forMatch[1].trim() };
        }
    }

    return null;
}

function resolveIdentifierTypeCandidates(context, document, position, name, inlineContext, importContext) {
    if (!context || !name) return [];

    if (name === 'this') return [context];
    if (name === 'super') {
        const base = index.resolveBaseClass(context);
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
    let candidates = [];
    const first = segments[0];

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
                candidates = index.resolveTypeName(found.owner, found.method.returnType);
            }
        }
    } else {
        if (forceFirstClass) {
            candidates = index.resolveClassName(importContext || context, first.name);
        } else {
            candidates = resolveIdentifierTypeCandidates(context, document, position, first.name, inlineContext, importContext);
        }
    }

    for (const segment of segments.slice(1)) {
        const next = [];
        for (const candidate of candidates) {
            if (segment.isCall) {
                if (inlineContext && inlineContext.locals && candidate === context) {
                    const localMethod = inlineContext.locals.methods.get(segment.name);
                    if (localMethod) {
                        next.push(...index.resolveTypeName(context, localMethod.returnType));
                        continue;
                    }
                }
                const method = index.findMethodInClassChain(candidate, segment.name);
                if (method) {
                    next.push(...index.resolveTypeName(method.owner, method.method.returnType));
                }
            } else {
                if (inlineContext && inlineContext.locals && candidate === context) {
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
            if (!seen.has(info.fullName)) {
                seen.add(info.fullName);
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
        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return null;

        const line = document.lineAt(position.line).text;
        const isCall = isMethodCallAt(document, wordInfo.range);
        const cleanLine = stripInlineAttributes(line);
        const wordStart = wordInfo.range.start.character;

        const context = updateIndexFromDocument(document);
        const baseContextClass = context || index.getClassByFile(document.uri.fsPath);
        const inlineContext = getInlineContext(document, position, baseContextClass);
        const contextClass = inlineContext ? inlineContext.info : baseContextClass;

        if (!contextClass) return null;

        const attrName = getAttributeNameAt(line, wordInfo.range);
        if (attrName) {
            const attrLocation = await findAttributeDefinitionLocation(attrName);
            if (attrLocation) return attrLocation;
            return null;
        }

        const importMatch = line.match(/^\s*import\s+([\w.]+)\s*;/);
        if (importMatch) {
            const info = index.getClassByFullName(importMatch[1]);
            if (info) return locationForClass(info);
        }

        const nativeMatch = line.match(/\[(?:native|primary)\s+"([^"]+)"\]/);
        if (nativeMatch && line.includes(wordInfo.word)) {
            const javaFile = await findJavaFileByClassName(nativeMatch[1]);
            if (javaFile) {
                return new vscode.Location(vscode.Uri.file(javaFile), new vscode.Position(0, 0));
            }
        }

        const classMatch = line.match(/\b(class|enum)\s+(\w+)/);
        if (classMatch && classMatch[2] === wordInfo.word) {
            return new vscode.Location(document.uri, new vscode.Position(position.line, line.indexOf(wordInfo.word)));
        }

        if (isNewKeywordBefore(line, wordStart)) {
            const forced = index.resolveClassName(contextClass, wordInfo.word);
            if (forced.length > 0) return locationForClass(forced[0]);
        }

        const methodDefMatch = cleanLine.match(METHOD_DEF_RE);
        if (methodDefMatch && methodDefMatch[2] === wordInfo.word) {
            const references = await findMethodReferences(wordInfo.word, token);
            const defLocation = new vscode.Location(
                document.uri,
                new vscode.Position(position.line, line.indexOf(wordInfo.word))
            );
            return uniqueLocations([defLocation, ...references]);
        }

        const fieldDefMatch = cleanLine.match(FIELD_DEF_RE);
        if (fieldDefMatch && fieldDefMatch[2] === wordInfo.word) {
            const references = await findIdentifierReferences(wordInfo.word, token);
            const defLocation = new vscode.Location(
                document.uri,
                new vscode.Position(position.line, line.indexOf(wordInfo.word))
            );
            return uniqueLocations([defLocation, ...references]);
        }

        const extendsMatch = line.match(/\bextends\s+([\w.]+)/);
        if (extendsMatch && extendsMatch[1].includes(wordInfo.word)) {
            const candidates = index.resolveClassName(contextClass, extendsMatch[1]);
            if (candidates.length > 0) return locationForClass(candidates[0]);
        }

        const chains = findChainsInLine(cleanLine);
        const chainAtWord = chains.find(chain => wordStart >= chain.start && wordStart <= chain.end);
        if (chainAtWord) {
            const forceFirstClass = isNewKeywordBefore(cleanLine, chainAtWord.start);
            const owners = resolveChainTypeCandidates(
                contextClass,
                document,
                position,
                chainAtWord.segments,
                inlineContext,
                baseContextClass,
                forceFirstClass
            );
            const results = [];

            for (const owner of owners) {
                if (isCall) {
                    if (inlineContext && inlineContext.locals && owner === contextClass) {
                        const localMethod = inlineContext.locals.methods.get(wordInfo.word);
                        if (localMethod) {
                            results.push(new vscode.Location(document.uri, new vscode.Position(localMethod.line, localMethod.column)));
                            continue;
                        }
                    }
                    const found = index.findMethodInClassChain(owner, wordInfo.word);
                    if (found) results.push(locationForMember(found.owner, found.method));
                } else {
                    if (inlineContext && inlineContext.locals && owner === contextClass) {
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

            if (results.length > 0) return uniqueLocations(results);
        }
        const chain = parseAccessChain(line, wordStart);
        if (chain) {
            const forceFirstClass = isNewKeywordBefore(line, wordStart);
            const owners = resolveChainTypeCandidates(contextClass, document, position, chain, inlineContext, baseContextClass, forceFirstClass);
            const results = [];

            for (const owner of owners) {
                if (isCall) {
                    if (inlineContext && inlineContext.locals && owner === contextClass) {
                        const localMethod = inlineContext.locals.methods.get(wordInfo.word);
                        if (localMethod) {
                            results.push(new vscode.Location(document.uri, new vscode.Position(localMethod.line, localMethod.column)));
                            continue;
                        }
                    }
                    const found = index.findMethodInClassChain(owner, wordInfo.word);
                    if (found) results.push(locationForMember(found.owner, found.method));
                } else {
                    if (inlineContext && inlineContext.locals && owner === contextClass) {
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

            if (results.length > 0) return uniqueLocations(results);
        }

        const continuationChain = getContinuationChain(document, position.line, wordStart);
        if (continuationChain) {
            const owners = resolveChainTypeCandidates(contextClass, document, position, continuationChain, inlineContext, baseContextClass);
            const results = [];

            for (const owner of owners) {
                if (isCall) {
                    const found = index.findMethodInClassChain(owner, wordInfo.word);
                    if (found) results.push(locationForMember(found.owner, found.method));
                } else {
                    const found = index.findMemberInClassChain(owner, wordInfo.word);
                    if (found) results.push(locationForMember(found.owner, found.member));
                }
            }

            if (results.length > 0) return uniqueLocations(results);
        }

        const local = findLocalVariableDefinition(document, position, wordInfo.word);
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
            if (found) return locationForMember(found.owner, found.method);
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
            const info = index.getClassByFullName(explicitImport);
            if (info) return locationForClass(info);
            const javaFile = await findJavaFileByClassName(explicitImport);
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
        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return [];

        const results = [];
        const blFiles = await vscode.workspace.findFiles('**/*.bl', '**/node_modules/**');

        for (const fileUri of blFiles) {
            if (token && token.isCancellationRequested) break;
            try {
                const content = fs.readFileSync(fileUri.fsPath, 'utf8');
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const regex = new RegExp(`\\b${wordInfo.word}\\b`, 'g');
                    let match;
                    while ((match = regex.exec(line)) !== null) {
                        results.push(new vscode.Location(fileUri, new vscode.Position(i, match.index)));
                    }
                }
            } catch (err) {
                // ignore
            }
        }

        return results;
    }
}

class BlCodeLensProvider {
    async provideCodeLenses(document, token) {
        const codeLenses = [];
        const text = document.getText();

        const nativeClass = getNativeAttribute(text);
        if (nativeClass) {
            const javaFile = await findJavaFileByClassName(nativeClass);
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

        return codeLenses;
    }
}

class BlHoverProvider {
    provideHover(document, position, token) {
        const line = document.lineAt(position.line).text;
        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return null;

        const importMatch = line.match(/^\s*import\s+([\w.]+)\s*;/);
        if (importMatch && line.includes(wordInfo.word)) {
            const info = index.getClassByFullName(importMatch[1]);
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

    const javaFile = await findJavaFileByClassName(nativeClass);
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
                    baseContext
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
    await buildIndex();
    const diagnostics = vscode.languages.createDiagnosticCollection('bl');
    debugOutput = vscode.window.createOutputChannel('BL Debug');
    debugOutput.appendLine('BL Language Support activated');

    const selector = { language: 'bl', scheme: 'file' };

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector, new BlDefinitionProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider(selector, new BlReferenceProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(selector, new BlCodeLensProvider())
    );
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
    watcher.onDidCreate(uri => index.updateFile(uri.fsPath));
    watcher.onDidChange(uri => index.updateFile(uri.fsPath));
    watcher.onDidDelete(uri => index.removeFile(uri.fsPath));
    context.subscriptions.push(watcher);
    context.subscriptions.push(diagnostics);
    context.subscriptions.push(debugOutput);

    vscode.workspace.onDidOpenTextDocument(doc => updateDiagnostics(doc, diagnostics));
    vscode.workspace.onDidChangeTextDocument(event => updateDiagnostics(event.document, diagnostics));
    vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri));

    if (vscode.window.activeTextEditor) {
        updateDiagnostics(vscode.window.activeTextEditor.document, diagnostics);
    }

    console.log('BL Language Support extension activated');
}

function deactivate() { }

module.exports = { activate, deactivate };
