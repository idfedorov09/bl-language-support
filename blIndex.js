const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Buffer } = require('buffer');

const METHOD_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\]\s*)*)\s+(\w+)\s*\(/;
const MEMBER_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\]\s*)*)\s+(\w+)\s*(?:=|;|$)/;
const DECLARATION_MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'virtual', 'final', 'auto', 'abstract']);
const WORD_FILTER_BITS = 8192;
const GUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GUID_RE = new RegExp(`^${GUID_PATTERN}$`, 'i');
const GUID_LITERAL_RE = new RegExp(`^'(${GUID_PATTERN})'$`, 'i');

function normalizeGuid(value) {
    return typeof value === 'string' && value.length === 36 && GUID_RE.test(value) ? value.toLowerCase() : null;
}

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

// Records are declarations, not arbitrary assignments or UUIDs in expressions.
// Use the position-preserving lexical mask for structure and a comments-only
// mask for values, so strings/braces/comments cannot create fake declarations.
function parseRecords(content, code, classLine, classColumn, className) {
    const records = new Map(), recordDeclarations = [], guidConstants = [];
    const values = sanitizeText(content, false);
    const offsets = [0];
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') offsets.push(i + 1);
    const positionAt = at => {
        let low = 0, high = offsets.length;
        while (low + 1 < high) {
            const mid = (low + high) >>> 1;
            if (offsets[mid] <= at) low = mid;
            else high = mid;
        }
        return { line: low, column: at - offsets[low] };
    };
    const copy = value => Buffer.from(value, 'utf8').toString('utf8');
    const skipSpace = (at, end) => { while (at < end && /\s/.test(code[at])) at++; return at; };
    const closingBracket = (at, end, open, close) => {
        let depth = 0;
        for (let i = at; i < end; i++) {
            if (code[i] === open) depth++;
            else if (code[i] === close && --depth === 0) return i;
        }
        return -1;
    };
    const valueRange = (start, end) => {
        while (start < end && /\s/.test(values[start])) start++;
        while (end > start && /\s/.test(values[end - 1])) end--;
        const first = positionAt(start), last = positionAt(end);
        return { value: copy(values.slice(start, end)), valueOffset: start, valueEndOffset: end,
            valueLine: first.line, valueColumn: first.column, valueEndLine: last.line, valueEndColumn: last.column };
    };
    const statementEnd = (start, end) => {
        const stack = [];
        const closes = { '(': ')', '[': ']', '{': '}' };
        for (let i = start; i < end; i++) {
            const ch = code[i];
            if (closes[ch]) stack.push(closes[ch]);
            else if (stack.length && ch === stack[stack.length - 1]) stack.pop();
            else if (ch === ';' && !stack.length) return i;
        }
        return end;
    };
    const parseBody = (start, end, kind = 'record') => {
        let cursor = start;
        while ((cursor = skipSpace(cursor, end)) < end) {
            if (code[cursor] === ';') { cursor++; continue; }
            const declarationOffset = cursor;
            const attributes = [], modifiers = [];
            while (cursor < end) {
                if (code[cursor] === '[') {
                    const close = closingBracket(cursor, end, '[', ']');
                    if (close < 0) return;
                    const nameOffset = skipSpace(cursor + 1, close);
                    const nameMatch = /^[A-Za-z_]\w*/.exec(code.slice(nameOffset, close));
                    if (nameMatch) {
                        const pos = positionAt(cursor), namePos = positionAt(nameOffset);
                        attributes.push({ name: copy(nameMatch[0]), line: pos.line, column: pos.column,
                            offset: cursor, endOffset: close + 1, nameOffset, nameLine: namePos.line, nameColumn: namePos.column,
                            ...valueRange(nameOffset + nameMatch[0].length, close) });
                    }
                    cursor = skipSpace(close + 1, end);
                    continue;
                }
                const modifier = /^[A-Za-z_]\w*/.exec(code.slice(cursor, end));
                if (!modifier || !DECLARATION_MODIFIERS.has(modifier[0])) break;
                modifiers.push(modifier[0]);
                cursor = skipSpace(cursor + modifier[0].length, end);
            }
            if (kind === 'constant') {
                if (!modifiers.includes('static') || !modifiers.includes('final') || !/^guid\b/.test(code.slice(cursor, end))) return;
                cursor = skipSpace(cursor + 4, end);
            }
            const nameMatch = /^[A-Za-z_]\w*/.exec(code.slice(cursor, end));
            const afterName = nameMatch && skipSpace(cursor + nameMatch[0].length, end);
            if (!nameMatch || code[afterName] !== '=' || code[afterName + 1] === '=') {
                cursor = statementEnd(cursor, end) + 1;
                continue;
            }
            const name = copy(nameMatch[0]);
            const endStatement = statementEnd(afterName + 1, end);
            const value = valueRange(afterName + 1, endStatement);
            // Z8BL UUID constants use single quotes. A string or any computed
            // expression containing a UUID is deliberately not a static ID.
            const literal = GUID_LITERAL_RE.exec(value.value);
            const guid = literal ? normalizeGuid(literal[1]) : null;
            const guidOffset = literal ? value.valueOffset + 1 : null;
            const guidPos = literal ? positionAt(guidOffset) : null;
            const pos = positionAt(cursor);
            const record = { name, kind, guid, guidLiteral: literal ? copy(literal[1]) : null,
                line: pos.line, column: pos.column, offset: cursor, endOffset: cursor + name.length,
                declarationOffset, declarationEndOffset: Math.min(endStatement + 1, end),
                guidOffset, guidEndOffset: literal ? guidOffset + literal[1].length : null,
                guidLine: guidPos ? guidPos.line : null, guidColumn: guidPos ? guidPos.column : null,
                attributes, modifiers, ...value };
            if (kind === 'constant') { if (guid) guidConstants.push(record); }
            else { recordDeclarations.push(record); records.set(name, record); }
            cursor = endStatement + 1;
        }
    };
    const classStart = offsets[classLine] + classColumn + className.length;
    const bodyStart = code.indexOf('{', classStart);
    if (bodyStart < 0) return { records, recordDeclarations, guidConstants };
    const constantEnd = start => {
        let cursor = start;
        while (cursor < code.length) {
            cursor = skipSpace(cursor, code.length);
            if (code[cursor] === '[') {
                const close = closingBracket(cursor, code.length, '[', ']');
                if (close < 0) return null;
                cursor = close + 1;
                continue;
            }
            const modifier = /^[A-Za-z_]\w*/.exec(code.slice(cursor));
            if (!modifier || !DECLARATION_MODIFIERS.has(modifier[0])) break;
            cursor += modifier[0].length;
        }
        // The structural scan only calls this at outer-class depth, never for
        // a method local, an inline class, a records RHS or arbitrary text.
        if (!/^guid\s+[A-Za-z_]\w*\s*=(?!=)/.test(code.slice(cursor))) return null;
        const end = statementEnd(cursor, code.length);
        return end < code.length ? end : null;
    };
    let braceDepth = 1, squareDepth = 0, parenDepth = 0;
    for (let i = bodyStart + 1; i < code.length && braceDepth > 0; i++) {
        const ch = code[i];
        if (braceDepth === 1 && !squareDepth && !parenDepth && (ch === '[' || /[A-Za-z_]/.test(ch))) {
            const end = constantEnd(i);
            if (end !== null) {
                parseBody(i, end + 1, 'constant');
                i = end;
                continue;
            }
        }
        if (braceDepth === 1 && !squareDepth && !parenDepth && /[A-Za-z_]/.test(ch)) {
            const word = /^[A-Za-z_]\w*/.exec(code.slice(i))[0];
            const next = skipSpace(i + word.length, code.length);
            if (word === 'records' && code[next] === '{') {
                const close = closingBracket(next, code.length, '{', '}');
                parseBody(next + 1, close < 0 ? code.length : close);
                if (close < 0) break;
                i = close;
                continue;
            }
            i += word.length - 1;
        } else if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        else if (braceDepth === 1 && ch === '[') squareDepth++;
        else if (braceDepth === 1 && ch === ']') squareDepth = Math.max(0, squareDepth - 1);
        else if (braceDepth === 1 && ch === '(') parenDepth++;
        else if (braceDepth === 1 && ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
    return { records, recordDeclarations, guidConstants };
}

// Source-only signature metadata for explicit virtual declarations. Unknown or
// incomplete parameters stay null: they cannot prove an override relationship.
function parseMethodSignature(lines, line) {
    const header = stripInlineAttributes(lines[line]);
    const match = METHOD_DEF_RE.exec(header);
    if (!match) return { modifiers: [], parameterTypes: null };
    const modifiers = (header.slice(0, match[0].lastIndexOf(match[2])).match(/\b(?:public|private|protected|static|virtual|final|auto|abstract)\b/g) || []);
    let parameters = header.slice(match[0].length);
    for (let next = line + 1; !/[);{}]/.test(parameters) && next < lines.length; next++) parameters += '\n' + lines[next];
    const close = parameters.indexOf(')');
    if (close < 0 || /[({};]/.test(parameters.slice(0, close))) return { modifiers, parameterTypes: null };
    parameters = parameters.slice(0, close).trim();
    if (!parameters) return { modifiers, parameterTypes: [] };
    const types = [];
    for (const parameter of parameters.split(',')) {
        const declaration = /^\s*([A-Za-z_][\w.]*(?:\s*\[[^\[\]]*\])*)\s+[A-Za-z_]\w*\s*$/.exec(parameter);
        if (!declaration) return { modifiers, parameterTypes: null };
        types.push(declaration[1].replace(/\s/g, ''));
    }
    return { modifiers, parameterTypes: types };
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
        if (inMemberScope) {
            const methodMatch = candidateLine.match(METHOD_DEF_RE);
            if (methodMatch) {
                const returnType = methodMatch[1].trim();
                const name = methodMatch[2];
                const declaration = {
                    name,
                    returnType,
                    line: i,
                    column: candidateLine.indexOf(name, methodMatch.index + methodMatch[0].lastIndexOf(name)),
                    ...parseMethodSignature(codeLines, i)
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
    const { records, recordDeclarations, guidConstants } = codeLines.some(line => /\b(?:records|guid)\b/.test(line))
        ? parseRecords(content, sanitizeText(content), classLine, classColumn, className)
        : { records: new Map(), recordDeclarations: [], guidConstants: [] };
    for (const record of [...guidConstants, ...recordDeclarations]) {
        members.set(record.name, { name: record.name, typeName: 'guid', line: record.line, column: record.column });
    }

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
        methods,
        records,
        recordDeclarations,
        guidConstants
    };
}

class BlIndex {
    constructor() {
        this.classesByFullName = new Map();
        this.classesByShortName = new Map();
        this.fileToClass = new Map();
        this.wordFilters = new Map();
        this.guidTextFilters = new Map();
        this.fileContentHashes = new Map();
        this.recordsByGuid = new Map();
        this.constantsByGuid = new Map();
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
        const guidRegex = new RegExp(GUID_PATTERN, 'ig');
        let match, guidFilter = null;
        while ((match = guidRegex.exec(content))) {
            if (!guidFilter) guidFilter = new Uint32Array(WORD_FILTER_BITS / 32);
            const [first, second] = wordHashes(match[0].toLowerCase());
            addWord(guidFilter, first, second);
        }
        if (guidFilter) this.guidTextFilters.set(filePath, guidFilter);
        // Stable source identity, unlike revision which also changes on a
        // same-text reparse when VS Code opens an indexed file.
        this.fileContentHashes.set(filePath, crypto.createHash('sha256').update(content).digest('hex'));
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
        const hadWords = this.wordFilters.delete(filePath);
        const hadGuids = this.guidTextFilters.delete(filePath);
        this.fileContentHashes.delete(filePath);
        const existing = this.fileToClass.get(filePath);
        if (existing || hadWords || hadGuids) this.revision++;
        if (!existing) return;
        this.fileToClass.delete(filePath);
        for (const record of [...(existing.recordDeclarations || (existing.records ? existing.records.values() : [])), ...(existing.guidConstants || [])]) {
            const guid = normalizeGuid(record.guid);
            const bucket = record.kind === 'constant' ? this.constantsByGuid : this.recordsByGuid;
            const candidates = guid && bucket.get(guid);
            if (!candidates) continue;
            for (const candidate of candidates) if (candidate.owner.filePath === filePath) candidates.delete(candidate);
            if (!candidates.size) bucket.delete(guid);
        }
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
        if (this.fileToClass.has(info.filePath)) this.removeFile(info.filePath);
        this.fileToClass.set(info.filePath, info);
        if (!this.classesByFullName.has(info.fullName)) {
            this.classesByFullName.set(info.fullName, new Map());
        }
        this.classesByFullName.get(info.fullName).set(info.filePath, info);
        if (!this.classesByShortName.has(info.className)) {
            this.classesByShortName.set(info.className, new Set());
        }
        this.classesByShortName.get(info.className).add(info.fullName);
        for (const record of [...(info.recordDeclarations || (info.records ? info.records.values() : [])), ...(info.guidConstants || [])]) {
            const guid = normalizeGuid(record.guid);
            if (!guid) continue;
            const bucket = record.kind === 'constant' ? this.constantsByGuid : this.recordsByGuid;
            if (!bucket.has(guid)) bucket.set(guid, new Set());
            bucket.get(guid).add({ owner: info, record });
        }
        this.revision++;
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

    getRecordsByGuid(value) {
        const guid = normalizeGuid(value);
        return guid ? Array.from(this.recordsByGuid.get(guid) || []) : [];
    }

    getGuidDeclarations(value) {
        if (value === undefined) return [...this.recordsByGuid.values(), ...this.constantsByGuid.values()].flatMap(candidates => [...candidates]);
        const guid = normalizeGuid(value);
        return guid ? [...(this.recordsByGuid.get(guid) || []), ...(this.constantsByGuid.get(guid) || [])] : [];
    }

    getGuidReferenceCandidates(value) {
        const guid = normalizeGuid(value), files = new Set();
        if (!guid) return files;
        const [first, second] = wordHashes(guid);
        for (const [file, filter] of this.guidTextFilters) if (mayContainWord(filter, first, second)) files.add(file);
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

    findOverriddenMethod(info, declaration, inline = false, signatureOwner = info) {
        if (!declaration || !declaration.modifiers || !declaration.modifiers.includes('virtual')
            || declaration.modifiers.includes('static') || !declaration.parameterTypes) return null;
        // An inline context already identifies its declared base; an ordinary
        // class must start at its parent, not at its own override.
        let current = inline ? info : this.resolveBaseClass(info);
        const seen = new Set(inline ? [] : [info.filePath]);
        const canonicalType = (owner, type) => {
            let unresolved = false;
            const result = type.replace(/\s/g, '').replace(/[A-Za-z_][\w.]*/g, name => {
                if (['void', 'bool', 'int', 'decimal', 'string', 'guid', 'date', 'datespan', 'binary', 'primary', 'any'].includes(name)) return name;
                const types = this.resolveClassName(owner, name);
                if (types.length !== 1) { unresolved = true; return name; }
                return types[0].fullName;
            });
            return unresolved ? null : result;
        };
        const parameters = declaration.parameterTypes.map(type => canonicalType(signatureOwner, type));
        if (parameters.some(type => type === null)) return null;
        while (current && !seen.has(current.filePath)) {
            seen.add(current.filePath);
            const method = current.methods.get(declaration.name);
            const matches = method ? (method.overloads || [method]).filter(candidate =>
                candidate.modifiers && candidate.modifiers.includes('virtual')
                && !candidate.modifiers.some(modifier => ['static', 'private', 'final'].includes(modifier))
                && candidate.parameterTypes && candidate.parameterTypes.length === parameters.length
                && candidate.parameterTypes.every((type, position) => canonicalType(current, type) === parameters[position])) : [];
            if (matches.length) return { owner: current, method: { ...matches[0], overloads: matches } };
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
    normalizeGuid,
    sanitizeText,
    stripInlineAttributes,
    parseMethodSignature,
    parseBlContent
};
