const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');

const METHOD_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\]\s*)*)\s+(\w+)\s*\(/;
const MEMBER_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\]\s*)*)\s+(\w+)\s*(?:=|;|$)/;
const RECORD_ENTRY_RE = /^\s*(\w+)\s*=/;
const DECLARATION_MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'virtual', 'final', 'auto', 'abstract']);
const WORD_FILTER_BITS = 8192;

function wordHashes(word, hashes = [0, 0]) {
    let first = 2166136261, second = 5381;
    for (let i = 0; i < word.length; i++) {
        const code = word.charCodeAt(i);
        first = Math.imul(first ^ code, 16777619);
        second = Math.imul(second, 33) ^ code;
    }
    hashes[0] = first >>> 0;
    hashes[1] = (second | 1) >>> 0;
    return hashes;
}

// A fixed-size Bloom filter keeps reference candidates without retaining every
// word/occurrence. False positives are resolved normally; false negatives are
// not possible for a word added to the filter.
function addWord(filter, first, second) {
    for (let i = 0; i < 4; i++) {
        const bit = (first + Math.imul(i, second)) & (WORD_FILTER_BITS - 1);
        filter[bit >>> 5] |= 1 << (bit & 31);
    }
}

function mayContainWord(filter, first, second) {
    for (let i = 0; i < 4; i++) {
        const bit = (first + Math.imul(i, second)) & (WORD_FILTER_BITS - 1);
        if (!(filter[bit >>> 5] & (1 << (bit & 31)))) return false;
    }
    return true;
}

function stripInlineAttributes(line) {
    if (!line.includes('[')) return line;
    let result = '';
    let copied = 0;
    let i = 0;
    while (i < line.length) {
        if (/\s/.test(line[i])) {
            i++;
            continue;
        }
        if (line[i] === '[') {
            let depth = 1;
            let quote = null;
            const start = i++;
            for (; i < line.length && depth > 0; i++) {
                const ch = line[i];
                if (quote) {
                    if (ch === '\\') i++;
                    else if (ch === quote) quote = null;
                } else if (ch === '"' || ch === "'") quote = ch;
                else if (ch === '[') depth++;
                else if (ch === ']') depth--;
            }
            result += line.slice(copied, start) + ' '.repeat(i - start);
            copied = i;
            continue;
        }
        const word = line.slice(i).match(/^\w+/);
        if (!word || !DECLARATION_MODIFIERS.has(word[0])) break;
        i += word[0].length;
    }
    return copied ? result + line.slice(copied) : line;
}

function sanitizeText(text, maskStrings = true) {
    let out = '';
    let inLine = false;
    let inBlock = false;
    let quote = null;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (inLine) {
            if (ch === '\n') inLine = false;
            out += ch === '\n' || ch === '\r' ? ch : ' ';
        } else if (inBlock) {
            if (ch === '*' && next === '/') {
                inBlock = false;
                out += '  ';
                i++;
            } else {
                out += ch === '\n' || ch === '\r' ? ch : ' ';
            }
        } else if (quote) {
            out += !maskStrings || ch === '\n' || ch === '\r' ? ch : ' ';
            if (escape) escape = false;
            else if (ch === '\\') escape = true;
            else if (ch === quote) quote = null;
        } else if (ch === '/' && (next === '/' || next === '*')) {
            inLine = next === '/';
            inBlock = next === '*';
            out += '  ';
            i++;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            out += maskStrings ? ' ' : ch;
        } else {
            out += ch;
        }
    }
    return out;
}

function getBlRootFromFilePath(filePath) {
    const parts = filePath.split(path.sep);
    for (let i = 0; i < parts.length - 2; i++) {
        if (parts[i] === 'src' && parts[i + 1] === 'bl') {
            return parts.slice(0, i + 2).join(path.sep);
        }
        if (parts[i] === 'src' && parts[i + 1] === 'main' && parts[i + 2] === 'bl') {
            return parts.slice(0, i + 3).join(path.sep);
        }
    }
    return null;
}

function getModuleRootFromBlFile(filePath) {
    const parts = filePath.split(path.sep);
    for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === 'src' && parts[i + 1] === 'bl') {
            return parts.slice(0, i).join(path.sep);
        }
        if (parts[i] === 'src' && parts[i + 1] === 'main' && parts[i + 2] === 'bl') {
            return parts.slice(0, i).join(path.sep);
        }
    }
    return null;
}

function normalizeTypeName(typeName) {
    if (!typeName) return null;
    let result = typeName.replace(/\s+/g, '');
    while (/\[[^\]]*\]$/.test(result)) {
        result = result.replace(/\[[^\]]*\]$/, '');
    }
    return result;
}

function parseBlContent(filePath, content, lexical) {
    const blRoot = getBlRootFromFilePath(filePath);
    if (!blRoot) return null;

    const relativePath = path.relative(blRoot, filePath);
    const packagePath = path.dirname(relativePath);
    const packageName = packagePath === '.' ? '' : packagePath.split(path.sep).join('.');

    const codeLines = lexical ? lexical.lines : sanitizeText(content).split(/\r?\n/);
    const hasNativeAttribute = /\[(?:native|primary)\b/.test(content);
    const attributeLines = hasNativeAttribute ? sanitizeText(content, false).split(/\r?\n/) : null;
    const imports = [];
    const members = new Map();
    const methods = new Map();

    let className = null;
    let classLine = null;
    let classColumn = null;
    let extendsName = null;
    let nativeClassName = null;
    let isEnum = false;

    let braceDepth = 0;
    let recordsDepth = null;
    let pendingRecords = false;

    for (let i = 0; i < codeLines.length; i++) {
        const line = codeLines[i];
        const candidateLine = stripInlineAttributes(line);

        if (!line.trim()) continue;

        const nativeMatch = attributeLines && braceDepth === 0 && attributeLines[i].match(/(?:^\s*|\]\s*)\[(?:native|primary)\s+"([^"]+)"\]/);
        if (nativeMatch && braceDepth === 0) {
            nativeClassName = nativeMatch[1];
        }

        const importMatch = line.match(/^\s*import\s+([\w.]+)\s*;/);
        if (importMatch) {
            imports.push(importMatch[1]);
            continue;
        }

        if (!className) {
            const classMatch = line.match(/\b(class|enum)\s+(\w+)(?:\s+extends\s+([\w.]+))?/);
            if (classMatch) {
                className = classMatch[2];
                extendsName = classMatch[3] || null;
                classLine = i;
                classColumn = line.indexOf(className, classMatch.index + classMatch[1].length);
                isEnum = classMatch[1] === 'enum';
            }
        }

        const inRecords = recordsDepth !== null && braceDepth >= recordsDepth;
        const inMemberScope = className && braceDepth === 1 && !inRecords;
        if (inRecords) {
            const recordMatch = candidateLine.match(RECORD_ENTRY_RE);
            if (recordMatch) {
                const name = recordMatch[1];
                members.set(name, {
                    name,
                    typeName: 'guid',
                    line: i,
                    column: candidateLine.indexOf(name)
                });
            }
        } else if (inMemberScope) {
            const methodMatch = candidateLine.match(METHOD_DEF_RE);
            if (methodMatch) {
                const returnType = methodMatch[1].trim();
                const name = methodMatch[2];
                const declaration = {
                    name,
                    returnType,
                    line: i,
                    column: candidateLine.indexOf(name, methodMatch.index + methodMatch[0].lastIndexOf(name))
                };
                const previous = methods.get(name);
                methods.set(name, { ...declaration, overloads: [...(previous ? previous.overloads : []), declaration] });
            } else {
                const memberMatch = candidateLine.match(MEMBER_DEF_RE);
                if (memberMatch) {
                    const typeName = memberMatch[1].trim();
                    const name = memberMatch[2];
                    members.set(name, {
                        name,
                        typeName,
                        line: i,
                        column: candidateLine.indexOf(name, memberMatch.index + memberMatch[0].lastIndexOf(name))
                    });
                } else if (isEnum) {
                    const enumLine = candidateLine.replace(/[{}]/g, '').trim();
                    if (enumLine && !enumLine.includes('(')) {
                        const parts = enumLine.split(',');
                        for (const part of parts) {
                            const nameMatch = part.match(/\b([A-Za-z_]\w*)\b/);
                            if (!nameMatch) continue;
                            const name = nameMatch[1];
                            if (members.has(name)) continue;
                            members.set(name, {
                                name,
                                typeName: className,
                                line: i,
                                column: candidateLine.indexOf(name)
                            });
                        }
                    }
                }
            }
        }

        if (className && braceDepth === 1 && /\brecords\b/.test(candidateLine)) {
            if (line.includes('{')) {
                pendingRecords = false;
            } else {
                pendingRecords = true;
            }
        }

        const openCount = (line.match(/\{/g) || []).length;
        const closeCount = (line.match(/\}/g) || []).length;
        braceDepth += openCount - closeCount;
        if (className && braceDepth > 1 && recordsDepth === null && /{/.test(line) && /\brecords\b/.test(candidateLine)) {
            recordsDepth = braceDepth;
            pendingRecords = false;
        } else if (pendingRecords && openCount > 0) {
            recordsDepth = braceDepth;
            pendingRecords = false;
        }
        if (recordsDepth !== null && braceDepth < recordsDepth) {
            recordsDepth = null;
        }
    }

    if (!className) return null;

    const fullName = packageName ? `${packageName}.${className}` : className;

    return {
        filePath,
        blRoot,
        moduleRoot: getModuleRootFromBlFile(filePath),
        relativePath,
        packageName,
        className,
        fullName,
        classLine,
        classColumn,
        extendsName,
        isEnum,
        nativeClassName,
        imports,
        members,
        methods
    };
}

class BlIndex {
    constructor() {
        this.classesByFullName = new Map();
        this.classesByShortName = new Map();
        this.fileToClass = new Map();
        this.wordFilters = new Map();
        this.wordHashCache = new Map();
        this.revision = 0;
    }

    indexFiles(filePaths) {
        for (const filePath of filePaths) {
            this.updateFile(filePath);
        }
    }

    updateFromText(filePath, content, lexical) {
        this.removeFile(filePath);
        lexical = lexical || { lines: sanitizeText(content).split(/\r?\n/) };
        const info = parseBlContent(filePath, content, lexical);
        if (info) this.addClass(info);
        const filter = new Uint32Array(WORD_FILTER_BITS / 32);
        const regex = /[A-Za-z_]\w*/g;
        const words = new Set();
        for (const line of lexical.lines) {
            let match;
            while ((match = regex.exec(line))) words.add(match[0]);
        }
        for (const word of words) {
            let hashes = this.wordHashCache.get(word);
            if (!hashes) {
                hashes = wordHashes(word);
                if (word.length <= 128) {
                    // Copy a short key so a V8 sliced string cannot retain an
                    // obsolete source buffer after its file was changed/closed.
                    this.wordHashCache.set(Buffer.from(word, 'utf8').toString('utf8'), hashes);
                    if (this.wordHashCache.size > 1024) this.wordHashCache.delete(this.wordHashCache.keys().next().value);
                }
            }
            addWord(filter, hashes[0], hashes[1]);
        }
        this.wordFilters.set(filePath, filter);
        this.revision++;
        return info;
    }

    updateFile(filePath) {
        try {
            return this.updateFromText(filePath, fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            this.removeFile(filePath);
            return null;
        }
    }

    removeFile(filePath) {
        if (this.wordFilters.delete(filePath)) this.revision++;
        const existing = this.fileToClass.get(filePath);
        if (!existing) return;
        this.fileToClass.delete(filePath);
        const copies = this.classesByFullName.get(existing.fullName);
        copies.delete(filePath);
        if (copies.size > 0) return;
        this.classesByFullName.delete(existing.fullName);

        const set = this.classesByShortName.get(existing.className);
        if (set) {
            set.delete(existing.fullName);
            if (set.size === 0) this.classesByShortName.delete(existing.className);
        }
    }

    addClass(info) {
        this.fileToClass.set(info.filePath, info);
        if (!this.classesByFullName.has(info.fullName)) {
            this.classesByFullName.set(info.fullName, new Map());
        }
        this.classesByFullName.get(info.fullName).set(info.filePath, info);
        if (!this.classesByShortName.has(info.className)) {
            this.classesByShortName.set(info.className, new Set());
        }
        this.classesByShortName.get(info.className).add(info.fullName);
    }

    getClassByFile(filePath) {
        return this.fileToClass.get(filePath) || null;
    }

    getReferenceCandidates(word) {
        const [first, second] = wordHashes(word);
        const files = new Set();
        for (const [file, filter] of this.wordFilters) if (mayContainWord(filter, first, second)) files.add(file);
        return files;
    }

    getClassByFullName(fullName, context) {
        const copies = this.classesByFullName.get(fullName);
        return copies ? this.preferNearbyClasses(context, Array.from(copies.values()))[0] : null;
    }

    preferNearbyClasses(context, classes) {
        if (!context || classes.length < 2) return classes;
        const contextParts = context.moduleRoot.split(path.sep);
        let best = -1;
        const nearby = [];
        for (const info of classes) {
            const parts = info.moduleRoot.split(path.sep);
            let shared = 0;
            while (shared < parts.length && shared < contextParts.length && parts[shared] === contextParts[shared]) shared++;
            if (shared > best) {
                best = shared;
                nearby.length = 0;
            }
            if (shared === best) nearby.push(info);
        }
        return nearby;
    }

    resolveClassName(context, name) {
        if (!name) return [];
        if (name.includes('.')) {
            const info = this.getClassByFullName(name, context);
            return info ? [info] : [];
        }

        if (context) {
            let explicitImport = null;
            for (const imp of context.imports) {
                if (imp === name || imp.endsWith(`.${name}`)) {
                    explicitImport = imp;
                    const info = this.getClassByFullName(imp, context);
                    if (info) return [info];
                }
            }

            if (explicitImport) {
                return [];
            }

            if (context.packageName) {
                const samePackage = `${context.packageName}.${name}`;
                const info = this.getClassByFullName(samePackage, context);
                if (info) return [info];
            }
        }

        const candidates = this.classesByShortName.get(name);
        if (!candidates) return [];
        return this.preferNearbyClasses(context, Array.from(candidates).map(full => this.getClassByFullName(full, context)).filter(Boolean));
    }

    resolveTypeName(context, typeName) {
        const normalized = normalizeTypeName(typeName);
        if (!normalized) return [];
        return this.resolveClassName(context, normalized);
    }

    resolveBaseClass(info) {
        if (!info) return null;
        const name = info.extendsName || (!info.nativeClassName && !info.isEnum && info.fullName !== 'org.zenframework.z8.lang.Object'
            ? 'org.zenframework.z8.lang.Object' : null);
        if (!name) return null;
        const resolved = this.resolveClassName(info, name);
        return resolved.length > 0 ? resolved[0] : null;
    }

    findMemberInClassChain(info, name) {
        let current = info;
        const seen = new Set();
        while (current && !seen.has(current.filePath)) {
            seen.add(current.filePath);
            const member = current.members.get(name);
            if (member) return { owner: current, member };
            current = this.resolveBaseClass(current);
        }
        return null;
    }

    findMethodInClassChain(info, name) {
        let current = info;
        const seen = new Set();
        while (current && !seen.has(current.filePath)) {
            seen.add(current.filePath);
            const method = current.methods.get(name);
            if (method) return { owner: current, method };
            current = this.resolveBaseClass(current);
        }
        return null;
    }
}

module.exports = {
    BlIndex,
    getBlRootFromFilePath,
    getModuleRootFromBlFile,
    normalizeTypeName,
    sanitizeText,
    stripInlineAttributes,
    parseBlContent
};
