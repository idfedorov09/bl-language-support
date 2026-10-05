const fs = require('fs');
const path = require('path');

const METHOD_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\]\s*)*)\s+(\w+)\s*\(/;
const MEMBER_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\]\s*)*)\s+(\w+)\s*(?:=|;|$)/;
const RECORD_ENTRY_RE = /^\s*(\w+)\s*=/;

function stripInlineAttributes(line) {
    return line.replace(/^\s*(?:\[[^\]]+\]\s*)+/, prefix => ' '.repeat(prefix.length));
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

function parseBlContent(filePath, content) {
    const blRoot = getBlRootFromFilePath(filePath);
    if (!blRoot) return null;

    const relativePath = path.relative(blRoot, filePath);
    const packagePath = path.dirname(relativePath);
    const packageName = packagePath === '.' ? '' : packagePath.split(path.sep).join('.');

    const lines = content.split(/\r?\n/);
    const codeLines = sanitizeText(content).split(/\r?\n/);
    const attributeLines = sanitizeText(content, false).split(/\r?\n/);
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

    for (let i = 0; i < lines.length; i++) {
        const line = codeLines[i];
        const candidateLine = stripInlineAttributes(line);

        if (!line.trim()) continue;

        const nativeMatch = attributeLines[i].match(/(?:^\s*|\]\s*)\[(?:native|primary)\s+"([^"]+)"\]/);
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
        if (!info || !info.extendsName) return null;
        const resolved = this.resolveClassName(info, info.extendsName);
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
