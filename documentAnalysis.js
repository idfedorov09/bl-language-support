const { sanitizeText, stripInlineAttributes } = require('./blIndex');

const TYPE_PATTERN = String.raw`[A-Za-z_][\w.]*\s*(?:\[[^\]]*\])*`;
const METHOD_DEF_RE = /^\s*(?:(?:static|virtual|final|auto|abstract)\s+)*(?:public|private|protected)?\s*(?:(?:static|virtual|final|auto|abstract)\s+)*([A-Za-z_][\w.]*\s*(?:\[[^\]]*\])*)\s+(\w+)\s*\(/;
const STATEMENT_TYPES = new Set(['return', 'if', 'else', 'while', 'for', 'throw', 'try', 'catch', 'new', 'auto']);
const LOCAL_DEF_RE = new RegExp(String.raw`^\s*(${TYPE_PATTERN})\s+(\w+)\s*[=;]`);
const LOOP_DEF_RE = new RegExp(String.raw`\b(?:for|catch)\s*\(\s*(${TYPE_PATTERN})\s+(\w+)\b`);

function closingParen(text, start) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) return i;
    }
    return -1;
}

class DocumentAnalysis {
    constructor(text) {
        this.text = text;
        this.lines = sanitizeText(text).split(/\r?\n/);
    }

    get cleanLines() {
        if (!this._cleanLines) this._cleanLines = this.lines.map(stripInlineAttributes);
        return this._cleanLines;
    }

    buildScopes() {
        if (this.scopes) return;
        const lines = this.cleanLines;
        const text = lines.join('\n');
        const offsets = [];
        let offset = 0;
        for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
        this.offsets = offsets;
        const definitionAt = (typeName, name, at) => {
            let low = 0, high = offsets.length;
            while (low + 1 < high) {
                const mid = (low + high) >> 1;
                if (offsets[mid] <= at) low = mid; else high = mid;
            }
            return { typeName: typeName.trim(), name, offset: at, line: low, column: at - offsets[low] };
        };
        const nextNonSpace = at => { while (at < text.length && /\s/.test(text[at])) at++; return at; };
        const methodOpenings = new Map();
        this.parameters = new Map();
        for (let line = 0; line < lines.length; line++) {
            const match = METHOD_DEF_RE.exec(lines[line]);
            if (!match || STATEMENT_TYPES.has(match[1].trim())) continue;
            const start = offsets[line] + lines[line].indexOf('(');
            const end = closingParen(text, start);
            if (end < 0) continue;
            const parameters = [];
            const paramRegex = new RegExp(String.raw`(${TYPE_PATTERN})\s+(\w+)`, 'g');
            const parameterText = text.slice(start + 1, end);
            let parameter;
            while ((parameter = paramRegex.exec(parameterText))) {
                const at = start + 1 + parameter.index + parameter[0].lastIndexOf(parameter[2]);
                const definition = definitionAt(parameter[1], parameter[2], at);
                parameters.push(definition);
                if (!this.parameters.has(definition.name)) this.parameters.set(definition.name, []);
                this.parameters.get(definition.name).push(definition);
            }
            const body = nextNonSpace(end + 1);
            if (text[body] === '{') methodOpenings.set(body, parameters);
        }
        const classOpenings = new Set();
        const classRegex = /\b(?:class|enum)\b[^;{}]*\{/g;
        let classMatch;
        while ((classMatch = classRegex.exec(text))) classOpenings.add(classMatch.index + classMatch[0].length - 1);
        const root = { parent: null, method: null, end: text.length, declarations: new Map() };
        this.openings = new Map();
        this.lineScopes = [];
        let scope = root;
        for (let line = 0; line < lines.length; line++) {
            this.lineScopes[line] = scope;
            for (let column = 0; column < lines[line].length; column++) {
                const at = offsets[line] + column;
                const ch = lines[line][column];
                if (ch === '{') {
                    const child = { parent: scope, method: classOpenings.has(at) ? null : scope.method,
                        end: text.length, declarations: new Map() };
                    if (methodOpenings.has(at)) {
                        child.method = child;
                        for (const parameter of methodOpenings.get(at)) child.declarations.set(parameter.name, [parameter]);
                    }
                    this.openings.set(at, child);
                    scope = child;
                } else if (ch === '}' && scope.parent) {
                    scope.end = at;
                    scope = scope.parent;
                }
            }
        }
        this.scopes = root;
        for (let line = 0; line < lines.length; line++) {
            const local = LOCAL_DEF_RE.exec(lines[line]);
            const loop = LOOP_DEF_RE.exec(lines[line]);
            const match = local || loop;
            if (!match || STATEMENT_TYPES.has(match[1].trim())) continue;
            const column = match.index + match[0].lastIndexOf(match[2]);
            const definition = definitionAt(match[1], match[2], offsets[line] + column);
            const owner = this.scopeAt({ line, character: column });
            if (!owner.method) continue;
            if (loop) {
                const end = closingParen(text, offsets[line] + lines[line].indexOf('(', loop.index));
                if (end < 0) continue;
                const body = nextNonSpace(end + 1);
                const bodyScope = this.openings.get(body);
                const statementEnd = text.indexOf(';', body);
                definition.end = bodyScope ? bodyScope.end : statementEnd >= 0 ? statementEnd + 1 : text.length;
            }
            if (!owner.declarations.has(definition.name)) owner.declarations.set(definition.name, []);
            owner.declarations.get(definition.name).push(definition);
        }
    }

    scopeAt(position) {
        let scope = this.lineScopes[position.line];
        const line = this.cleanLines[position.line];
        for (let column = 0; column < position.character; column++) {
            if (line[column] === '{') scope = this.openings.get(this.offsets[position.line] + column);
            else if (line[column] === '}' && scope.parent) scope = scope.parent;
        }
        return scope;
    }

    findLocal(position, name) {
        this.buildScopes();
        const offset = this.offsets[position.line] + position.character;
        // Parameter declarations are before the method body's opening brace.
        for (const parameter of this.parameters.get(name) || []) {
            if (parameter.name === name && parameter.offset <= offset && offset <= parameter.offset + name.length) return parameter;
        }
        let scope = this.scopeAt(position);
        const method = scope.method;
        while (scope && method && scope.method === method) {
            const declarations = scope.declarations.get(name) || [];
            for (let i = declarations.length - 1; i >= 0; i--) {
                const declaration = declarations[i];
                if (declaration.offset <= offset && (declaration.end === undefined || offset < declaration.end)) return declaration;
            }
            scope = scope.parent;
        }
        return null;
    }
}

module.exports = { DocumentAnalysis, TYPE_PATTERN, METHOD_DEF_RE, STATEMENT_TYPES };
