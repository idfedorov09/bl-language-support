const fs = require('fs');
const path = require('path');

const TYPE_NAME_RE = /[A-Za-z_][\w.]*(?:\[[^\]]*\])*/;
const METHOD_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*(?:\[[^\]]*\])*)\s+(\w+)\s*\(/;
const MEMBER_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*(?:\[[^\]]*\])*)\s+(\w+)\s*(?:=|;|$)/;
const ATTR_PREFIX_RE = /^\s*(?:\[[^\]]+\]\s*)+/;
const RECORD_ENTRY_RE = /^\s*(\w+)\s*=/;

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

    return out.replace(ATTR_PREFIX_RE, '');
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

function stripComments(line, state) {
    let i = 0;
    let out = '';
    while (i < line.length) {
        if (state.inBlock) {
            const end = line.indexOf('*/', i);
            if (end === -1) {
                return { text: '', inBlock: true };
            }
            i = end + 2;
            state.inBlock = false;
            continue;
        }
        const blockStart = line.indexOf('/*', i);
        const lineStart = line.indexOf('//', i);
        if (lineStart !== -1 && (blockStart === -1 || lineStart < blockStart)) {
            out += line.slice(i, lineStart);
            return { text: out, inBlock: state.inBlock };
        }
        if (blockStart !== -1) {
            out += line.slice(i, blockStart);
            i = blockStart + 2;
            state.inBlock = true;
            continue;
        }
        out += line.slice(i);
        return { text: out, inBlock: state.inBlock };
    }
    return { text: out, inBlock: state.inBlock };
}

function parseBlContent(filePath, content) {
    const blRoot = getBlRootFromFilePath(filePath);
    if (!blRoot) return null;

    const relativePath = path.relative(blRoot, filePath);
    const packagePath = path.dirname(relativePath);
    const packageName = packagePath === '.' ? '' : packagePath.split(path.sep).join('.');

    const lines = content.split(/\r?\n/);
    const imports = [];
    const members = new Map();
    const methods = new Map();

    let className = null;
    let classLine = null;
    let classColumn = null;
    let extendsName = null;
    let nativeClassName = null;
    let isEnum = false;

    let state = { inBlock: false };
    let braceDepth = 0;
    let recordsDepth = null;
    let pendingRecords = false;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const stripped = stripComments(rawLine, state);
        state = { inBlock: stripped.inBlock };
        const line = stripped.text;
        const candidateLine = stripInlineAttributes(line);

        if (!line.trim()) continue;

        const nativeMatch = line.match(/\[(?:native|primary)\s+"([^"]+)"\]/);
        if (nativeMatch) {
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
                classColumn = rawLine.indexOf(className);
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
                    column: rawLine.indexOf(name)
                });
            }
        } else if (inMemberScope) {
            const methodMatch = candidateLine.match(METHOD_DEF_RE);
            if (methodMatch) {
                const returnType = methodMatch[1];
                const name = methodMatch[2];
                methods.set(name, {
                    name,
                    returnType,
                    line: i,
                    column: rawLine.indexOf(name)
                });
            } else {
                const memberMatch = candidateLine.match(MEMBER_DEF_RE);
                if (memberMatch) {
                    const typeName = memberMatch[1];
                    const name = memberMatch[2];
                    members.set(name, {
                        name,
                        typeName,
                        line: i,
                        column: rawLine.indexOf(name)
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
                                column: rawLine.indexOf(name)
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
        nativeClassName,
        imports,
        members,
        methods
    };
}

function parseBlFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return parseBlContent(filePath, content);
    } catch (err) {
        return null;
    }
}

class BlIndex {
    constructor() {
        this.classesByFullName = new Map();
        this.classesByShortName = new Map();
        this.fileToClass = new Map();
    }

    indexFiles(filePaths) {
        for (const filePath of filePaths) {
            this.updateFile(filePath);
        }
    }

    updateFromText(filePath, content) {
        this.removeFile(filePath);
        const info = parseBlContent(filePath, content);
        if (info) this.addClass(info);
        return info;
    }

    updateFile(filePath) {
        this.removeFile(filePath);
        const info = parseBlFile(filePath);
        if (info) this.addClass(info);
        return info;
    }

    removeFile(filePath) {
        const existing = this.fileToClass.get(filePath);
        if (!existing) return;
        this.fileToClass.delete(filePath);
        this.classesByFullName.delete(existing.fullName);

        const set = this.classesByShortName.get(existing.className);
        if (set) {
            set.delete(existing.fullName);
            if (set.size === 0) this.classesByShortName.delete(existing.className);
        }
    }

    addClass(info) {
        this.fileToClass.set(info.filePath, info);
        this.classesByFullName.set(info.fullName, info);
        if (!this.classesByShortName.has(info.className)) {
            this.classesByShortName.set(info.className, new Set());
        }
        this.classesByShortName.get(info.className).add(info.fullName);
    }

    getClassByFile(filePath) {
        return this.fileToClass.get(filePath) || null;
    }

    getClassByFullName(fullName) {
        return this.classesByFullName.get(fullName) || null;
    }

    resolveClassName(context, name) {
        if (!name) return [];
        if (name.includes('.')) {
            const info = this.getClassByFullName(name);
            return info ? [info] : [];
        }

        if (context) {
            let explicitImport = null;
            for (const imp of context.imports) {
                if (imp === name || imp.endsWith(`.${name}`)) {
                    explicitImport = imp;
                    const info = this.getClassByFullName(imp);
                    if (info) return [info];
                }
            }

            if (explicitImport) {
                return [];
            }

            if (context.packageName) {
                const samePackage = `${context.packageName}.${name}`;
                const info = this.getClassByFullName(samePackage);
                if (info) return [info];
            }
        }

        const candidates = this.classesByShortName.get(name);
        if (!candidates) return [];
        return Array.from(candidates).map(full => this.getClassByFullName(full)).filter(Boolean);
    }

    resolveTypeName(context, typeName) {
        const normalized = normalizeTypeName(typeName);
        if (!normalized) return [];
        return this.resolveClassName(context, normalized);
    }

    resolveBaseClass(info) {
        if (!info || !info.extendsName) return null;
        const resolved = this.resolveClassName(info, info.extendsName);
        return resolved.length > 0 ? resolved[0] : null;
    }

    findMemberInClassChain(info, name) {
        let current = info;
        while (current) {
            const member = current.members.get(name);
            if (member) return { owner: current, member };
            current = this.resolveBaseClass(current);
        }
        return null;
    }

    findMethodInClassChain(info, name) {
        let current = info;
        while (current) {
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
    parseBlContent
};
