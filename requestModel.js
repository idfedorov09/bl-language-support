const acorn = require('acorn');
const loose = require('acorn-loose');

// Parsing never executes the source. Loose ASTs are used ONLY for suggestions;
// definitions and reverse usages always require a successfully parsed program.
function walk(node, visit, parent = null) {
    if (!node || typeof node.type !== 'string') return;
    visit(node, parent);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
        else if (value && typeof value.type === 'string') walk(value, visit, node);
    }
}
function memberName(node) {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name === '✖' ? null : node.name;
    if (node.type !== 'MemberExpression' || node.optional) return null;
    const object = memberName(node.object);
    const key = node.computed ? node.property.type === 'Literal' && node.property.value : node.property.name;
    return object && typeof key === 'string' ? `${object}.${key}` : null;
}
function keyName(property) {
    if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.computed) return null;
    return property.key.name || (typeof property.key.value === 'string' ? property.key.value : null);
}
function parseJsRequests(text, tolerant = false) {
    let ast;
    try { ast = (tolerant ? loose : acorn).parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
    catch (error) { return { calls: [], error: error.message, constants: [] }; }
    const parents = new WeakMap(), scopes = new WeakMap(), bindings = new WeakMap(), nodes = [];
    const isFunction = node => /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type);
    const isScope = node => node.type === 'Program' || node.type === 'BlockStatement' || isFunction(node) || node.type === 'CatchClause';
    walk(ast, (node, parent) => {
        parents.set(node, parent); nodes.push(node);
        scopes.set(node, isScope(node) ? node : scopes.get(parent));
        if (isScope(node)) bindings.set(node, new Map());
    });
    const bindPattern = (pattern, scope, binding) => {
        if (!pattern || !scope) return;
        if (pattern.type === 'Identifier') {
            const entries = bindings.get(scope);
            if (entries.has(pattern.name)) entries.set(pattern.name, { kind: 'ambiguous' });
            else entries.set(pattern.name, binding);
        } else for (const value of Object.values(pattern)) {
            if (Array.isArray(value)) value.forEach(p => p && bindPattern(p.type === 'Property' ? p.value : p, scope, { kind: 'dynamic' }));
            else if (value && value.type) bindPattern(value, scope, { kind: 'dynamic' });
        }
    };
    for (const node of nodes) {
        if (node.type === 'VariableDeclaration') for (const declaration of node.declarations) {
            let scope = scopes.get(node);
            if (node.kind === 'var') while (scope && !isFunction(scope) && scope.type !== 'Program') scope = scopes.get(parents.get(scope));
            bindPattern(declaration.id, scope, { kind: node.kind, init: declaration.init, declaration });
        }
        if (isFunction(node)) {
            for (const param of node.params) bindPattern(param, node, { kind: 'parameter' });
            if (node.id) bindPattern(node.id, node.type === 'FunctionDeclaration' ? scopes.get(parents.get(node)) : node, { kind: 'function' });
        }
        if (node.type === 'CatchClause') bindPattern(node.param, node, { kind: 'parameter' });
        if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) bindPattern(specifier.local, scopes.get(node), { kind: 'import' });
        if (node.type === 'ClassDeclaration' && node.id) bindPattern(node.id, scopes.get(node), { kind: 'class' });
    }
    const lookup = (node, name) => {
        let scope = scopes.get(node);
        while (scope) {
            if (bindings.get(scope).has(name)) return bindings.get(scope).get(name);
            scope = scopes.get(parents.get(scope));
        }
        return null;
    };
    const writes = nodes.filter(node => node.type === 'AssignmentExpression' || node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete')
        .map(node => node.left || node.argument);
    const unshadowed = (node, name) => !lookup(node, name.split('.')[0]);
    const staticCandidates = new Map();
    for (const node of nodes) {
        if (node.type !== 'CallExpression' || memberName(node.callee) !== 'Z8.define' || !unshadowed(node, 'Z8')) continue;
        const [name, object] = node.arguments;
        if (!name || name.type !== 'Literal' || typeof name.value !== 'string' || !object || object.type !== 'ObjectExpression') continue;
        if (object.properties.some(p => !keyName(p)) || object.properties.filter(p => keyName(p) === 'statics').length !== 1
            || object.properties.filter(p => keyName(p) === 'shortClassName').length > 1) continue;
        const aliasProperty = object.properties.find(p => keyName(p) === 'shortClassName');
        const aliases = new Set([name.value]);
        if (aliasProperty && aliasProperty.value.type === 'Literal' && typeof aliasProperty.value.value === 'string') aliases.add(aliasProperty.value.value);
        const single = object.properties.find(p => keyName(p) === 'single');
        if (single && !(single.value.type === 'Literal' && single.value.value === false)) continue;
        const statics = object.properties.find(p => keyName(p) === 'statics');
        if (!statics || statics.value.type !== 'ObjectExpression') continue;
        // A spread/computed property can replace known names at runtime.
        if (statics.value.properties.some(p => !keyName(p))) continue;
        for (const property of statics.value.properties) for (const alias of aliases) {
            const key = `${alias}.${keyName(property)}`;
            if (!staticCandidates.has(key)) staticCandidates.set(key, []);
            staticCandidates.get(key).push(property.value);
        }
    }
    function evaluate(node, seen = new Set()) {
        if (!node || seen.has(node)) return { known: false };
        seen = new Set(seen).add(node);
        if (node.type === 'Literal' && !node.regex && (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value))) return { known: true, value: node.value };
        if (node.type === 'TemplateLiteral' && !node.expressions.length) return { known: true, value: node.quasis[0].value.cooked };
        if (node.type === 'Identifier') {
            const binding = lookup(node, node.name);
            if (binding && binding.kind === 'const' && binding.declaration.end <= node.start
                && !writes.some(w => w.type === 'Identifier' && lookup(w, w.name) === binding)) return evaluate(binding.init, seen);
        }
        if (node.type === 'MemberExpression') {
            const key = memberName(node), values = staticCandidates.get(key);
            if (key && values && values.length === 1 && unshadowed(node, key)
                && !writes.some(w => { const name = memberName(w); return name && (name === key || key.startsWith(name + '.')); })) return evaluate(values[0], seen);
        }
        return { known: false };
    }
    function objectFields(node, seen = new Set()) {
        if (!node || seen.has(node)) return null;
        seen = new Set(seen).add(node);
        if (node.type === 'Identifier') {
            const binding = lookup(node, node.name);
            if (!binding || binding.kind !== 'const' || binding.declaration.end > node.start) return null;
            if (writes.some(w => { let base = w; while (base && base.type === 'MemberExpression') base = base.object; return base && base.type === 'Identifier' && lookup(base, base.name) === binding; })) return null;
            // Passing an object elsewhere may mutate it. Restrict alias support to
            // one use in this send argument, not general JS data-flow evaluation.
            const uses = nodes.filter(n => n.type === 'Identifier' && n.name === node.name && lookup(n, n.name) === binding
                && n !== binding.declaration.id && !(parents.get(n)?.type === 'Property' && parents.get(n).key === n && !parents.get(n).shorthand));
            if (uses.length !== 1) return null;
            return objectFields(binding.init, seen);
        }
        if (node.type === 'CallExpression' && memberName(node.callee) === 'Z8.apply' && unshadowed(node, 'Z8') && node.arguments.length === 2) {
            const first = objectFields(node.arguments[0], seen), second = objectFields(node.arguments[1], seen);
            if (!first || !second) return null;
            return new Map([...first, ...second]);
        }
        if (node.type !== 'ObjectExpression') return null;
        const fields = new Map();
        for (const property of node.properties) {
            const key = keyName(property);
            if (!key) { fields.clear(); continue; }
            const result = evaluate(property.value);
            fields.set(key, { key, ...result, start: property.value.start, end: property.value.end,
                keyStart: property.key.start, keyEnd: property.key.end, node: property.value, property });
        }
        return fields;
    }
    const calls = [];
    for (const node of nodes) {
        if (node.type !== 'CallExpression' || memberName(node.callee) !== 'HttpRequest.send' || !unshadowed(node, 'HttpRequest') || node.optional) continue;
        const argument = node.arguments[0], fields = objectFields(argument);
        if (!argument || !fields) continue;
        calls.push({ start: node.start, end: node.end, argumentStart: argument.start, argumentEnd: argument.end, fields, tolerant });
    }
    return { calls, error: null, constants: [...staticCandidates.keys()] };
}

// BL lexical evidence retains source offsets. It is not a compiler parser.
function blTokens(text) {
    const tokens = [];
    const regex = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|==|!=|&&|\|\||[^\s]/g;
    let match;
    while ((match = regex.exec(text))) {
        const raw = match[0];
        if (raw.startsWith('//') || raw.startsWith('/*')) continue;
        let value = raw;
        const string = raw[0] === '"' || raw[0] === "'";
        if (string) {
            try { value = raw[0] === '"' ? JSON.parse(raw) : raw.slice(1, -1).replace(/\\(['\\])/g, '$1'); }
            catch { value = null; }
        }
        tokens.push({ v: value, raw, string, start: match.index, end: regex.lastIndex });
    }
    return tokens;
}
function closing(tokens, start) {
    const pairs = { '(': ')', '[': ']', '{': '}' }, opener = tokens[start]?.raw;
    if (!pairs[opener]) return -1;
    const stack = [];
    for (let i = start; i < tokens.length; i++) {
        const value = tokens[i].raw;
        if (pairs[value]) stack.push(pairs[value]);
        else if ([')', ']', '}'].includes(value)) {
            if (stack.pop() !== value) return -1;
            if (!stack.length) return i;
        }
    }
    return -1;
}
function tokenName(tokens) {
    return tokens.length && tokens.every((t, i) => i % 2 ? t.raw === '.' : !t.string && /^[A-Za-z_]\w*$/.test(t.raw))
        ? tokens.map(t => t.raw).join('') : null;
}
function offsetFor(text, line, column) {
    let offset = 0;
    for (let i = 0; i < line; i++) { const next = text.indexOf('\n', offset); if (next < 0) return text.length; offset = next + 1; }
    return offset + column;
}
function location(filePath, token) { return token && { filePath, start: token.start, end: token.end }; }
class RequestRoutes {
    constructor(index, readSource) { this.index = index; this.readSource = readSource; this.sources = new Map(); }
    async source(info) {
        const text = await this.readSource(info.filePath);
        const cached = this.sources.get(info.filePath);
        if (cached && cached.text === text) return cached;
        const value = { text, tokens: blTokens(text) };
        this.sources.delete(info.filePath); this.sources.set(info.filePath, value);
        if (this.sources.size > 128) this.sources.delete(this.sources.keys().next().value);
        return value;
    }
    async constant(owner, expression, seen = new Set()) {
        if (expression.length === 1 && expression[0].string) return expression[0].v;
        const name = tokenName(expression);
        if (!name) return null;
        const at = name.lastIndexOf('.');
        const classes = at < 0 ? [owner] : this.index.resolveClassName(owner, name.slice(0, at));
        if (classes.length !== 1) return null;
        const found = this.index.findMemberInClassChain(classes[0], name.slice(at + 1));
        if (!found) return null;
        const key = `${found.owner.filePath}:${found.member.name}`;
        if (seen.has(key)) return null;
        seen = new Set(seen).add(key);
        const { text, tokens } = await this.source(found.owner);
        const offset = offsetFor(text, found.member.line, found.member.column);
        const i = tokens.findIndex(t => t.start === offset);
        if (i < 0 || tokens[i + 1]?.raw !== '=') return null;
        let start = i - 1;
        while (start >= 0 && ![';', '{', '}'].includes(tokens[start].raw)) start--;
        const prefix = tokens.slice(start + 1, i).map(t => t.raw);
        if (!prefix.includes('final') || !prefix.includes('string')) return null;
        let end = i + 2;
        while (end < tokens.length && tokens[end].raw !== ';') end++;
        return this.constant(found.owner, tokens.slice(i + 2, end), seen);
    }
    async method(owner, name) {
        const found = this.index.findMethodInClassChain(owner, name);
        if (!found || (found.method.overloads || []).length > 1) return null;
        const { text, tokens } = await this.source(found.owner);
        const offset = offsetFor(text, found.method.line, found.method.column);
        const i = tokens.findIndex(t => t.start === offset);
        if (i < 0 || tokens[i + 1]?.raw !== '(') return null;
        const paramsEnd = closing(tokens, i + 1);
        const bodyStart = paramsEnd + 1;
        const bodyEnd = tokens[bodyStart]?.raw === '{' ? closing(tokens, bodyStart) : bodyStart;
        if (paramsEnd < 0 || bodyEnd < 0) return null;
        const params = []; let begin = i + 2;
        for (let j = begin; j <= paramsEnd; j++) if (j === paramsEnd || tokens[j].raw === ',') {
            if (j > begin) params.push(tokens[j - 1].v);
            begin = j + 1;
        }
        return { ...found, params, tokens: tokens.slice(bodyStart + 1, bodyEnd), source: location(found.owner.filePath, tokens[i]) };
    }
    async parameterKey(owner, tokens, mapName) {
        if (tokens[0]?.raw !== mapName || tokens[1]?.raw !== '[' || closing(tokens, 1) !== tokens.length - 1) return null;
        return this.constant(owner, tokens.slice(2, -1));
    }
    async parameters(method, slice) {
        if (!method) return [];
        const result = new Map(), tokens = slice || method.tokens;
        const mapParams = method.params.filter((name, i) => method.method.parameterTypes?.[i] === 'string[string]');
        for (let i = 0; i < tokens.length; i++) if (mapParams.includes(tokens[i].v) && tokens[i + 1]?.raw === '[') {
            const end = closing(tokens, i + 1);
            if (end < 0) continue;
            const key = await this.constant(method.owner, tokens.slice(i + 2, end));
            if (typeof key === 'string') result.set(key, { name: key, required: null, type: null, source: location(method.owner.filePath, tokens[i + 2]) });
        }
        return [...result.values()];
    }
    async build(owner) {
        const routes = [], entries = [], visited = new Set();
        const makeRoute = (action, selector, value, branch, method, target, parameters) => {
            routes.push({ request: owner.fullName, action, selector, value, confidence: 'confirmed', handlerFamily: action,
                branch, dispatcher: method.source, targets: [branch, target].filter(Boolean), parameters });
        };
        const traverse = async (method, action, inheritedSelectors = new Map(), depth = 0) => {
            if (!method || depth > 4) return;
            const key = `${method.owner.filePath}:${method.method.name}:${action}:${[...inheritedSelectors]}`;
            if (visited.has(key)) return; visited.add(key);
            const selectors = new Map(inheritedSelectors), tokens = method.tokens;
            const firstIf = tokens.findIndex(t => t.raw === 'if');
            const readParams = await this.parameters(method, firstIf < 0 ? tokens : tokens.slice(0, firstIf));
            // Simple local aliases, with no later assignments to that variable.
            for (let i = 0; i < tokens.length; i++) if (tokens[i].raw === '=' && tokens[i - 1] && tokens[i - 2]?.raw === 'string') {
                let end = i + 1; while (end < tokens.length && tokens[end].raw !== ';') end++;
                const selector = await this.parameterKey(method.owner, tokens.slice(i + 1, end), method.params[0]);
                const name = tokens[i - 1].v;
                if (selector && !tokens.some((t, p) => p !== i - 1 && t.v === name && ['=', '+=', '-='].includes(tokens[p + 1]?.raw))) selectors.set(name, selector);
            }
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i].raw === 'if' && tokens[i + 1]?.raw === '(') {
                    const end = closing(tokens, i + 1); if (end < 0) continue;
                    const condition = tokens.slice(i + 2, end), equal = condition.findIndex(t => t.raw === '==');
                    if (equal < 0 || condition.some(t => ['&&', '||', '!='].includes(t.raw))) continue;
                    const left = condition.slice(0, equal), right = condition.slice(equal + 1);
                    const selectorOf = async side => side.length === 1 && selectors.get(side[0].v)
                        || await this.parameterKey(method.owner, side, method.params[0]);
                    let selector = await selectorOf(left), value = selector ? await this.constant(method.owner, right) : null;
                    if (!selector) { selector = await selectorOf(right); value = selector ? await this.constant(method.owner, left) : null; }
                    if (!['method', 'name'].includes(selector) || typeof value !== 'string') continue;
                    let start = end + 1, finish = start;
                    if (tokens[start]?.raw === '{') { finish = closing(tokens, start); start++; }
                    else { while (finish < tokens.length && tokens[finish].raw !== ';') finish++; }
                    if (finish < 0) continue;
                    const statement = tokens.slice(start, finish);
                    let p = statement[0]?.raw === 'return' ? 1 : 0;
                    let target = null, params = [...readParams, ...await this.parameters(method, statement)];
                    if (statement[p + 1]?.raw === '=') p += 2;
                    if (statement[p]?.raw === 'this' && statement[p + 1]?.raw === '.') p += 2;
                    if (statement[p]?.raw === 'new') {
                        let endName = p + 2;
                        while (statement[endName]?.raw === '.') endName += 2;
                        const name = tokenName(statement.slice(p + 1, endName));
                        const classes = this.index.resolveClassName(method.owner, name);
                        if (classes.length === 1) {
                            const source = await this.source(classes[0]);
                            const off = offsetFor(source.text, classes[0].classLine, classes[0].classColumn);
                            target = { filePath: classes[0].filePath, start: off, end: off + classes[0].className.length };
                            const execute = await this.method(classes[0], 'execute');
                            params.push(...await this.parameters(execute));
                        }
                    } else if (statement[p + 1]?.raw === '(' && /^[A-Za-z_]\w*$/.test(statement[p]?.raw || '')) {
                        const handler = await this.method(method.owner, statement[p].v);
                        if (handler) { target = handler.source; params.push(...await this.parameters(handler)); }
                    }
                    makeRoute(action, selector, value, location(method.owner.filePath, left.length === 1 && selectors.has(left[0].v) ? right[0] : condition[0]), method, target, params);
                    i = finish;
                } else if (tokens[i + 1]?.raw === '(' && tokens[i - 1]?.raw !== '.' && /^[A-Za-z_]\w*$/.test(tokens[i].raw)) {
                    const end = closing(tokens, i + 1); if (end < 0) continue;
                    const args = tokens.slice(i + 2, end);
                    const selector = await this.parameterKey(method.owner, args, method.params[0]);
                    if (selector) {
                        const helper = await this.method(method.owner, tokens[i].v);
                        if (helper && helper.params.length === 1) await traverse(helper, action, new Map([[helper.params[0], selector]]), depth + 1);
                    }
                }
            }
        };
        for (const [action, name] of [['read', 'getData'], ['content', 'processContentRequest']]) {
            const method = await this.method(owner, name);
            if (!method || !method.method.modifiers.includes('virtual') || method.method.parameterTypes?.[0] !== 'string[string]') continue;
            entries.push({ action, source: method.source, parameters: await this.parameters(method) });
            await traverse(method, action);
        }
        // Platform action=name dispatch is a declared Action field, not a same-name method.
        const seen = new Set(); let current = owner;
        const names = new Set();
        while (current && !seen.has(current.filePath)) {
            seen.add(current.filePath);
            for (const member of current.members.values()) {
                if (names.has(member.name)) continue; names.add(member.name);
                const types = this.index.resolveClassName(current, member.typeName);
                if (types.length !== 1 || types[0].fullName !== 'org.zenframework.z8.base.form.action.Action') continue;
                const { text, tokens } = await this.source(current);
                const offset = offsetFor(text, member.line, member.column), at = tokens.findIndex(t => t.start === offset);
                // Explicit id assignment can change the framework member identity.
                if (tokens.some((t, i) => t.v === member.name && tokens[i + 1]?.raw === '.' && ['id', 'setId'].includes(tokens[i + 2]?.v))) continue;
                const prefixStart = Math.max(0, tokens.slice(0, at).map(t => t.raw).lastIndexOf(';') + 1);
                if (tokens.slice(prefixStart, at).some((t, i, all) => t.raw === 'static' || t.raw === '[' && all[i + 1]?.v === 'id')) continue;
                if (tokens[at + 1]?.raw !== '=' || tokens[at + 2]?.v !== 'class' || tokens[at + 3]?.raw !== '{') continue;
                const end = closing(tokens, at + 3), body = tokens.slice(at + 4, end);
                const execute = body.find((t, i) => t.v === 'execute' && body[i + 1]?.raw === '(');
                const branch = location(current.filePath, tokens[at]);
                makeRoute('action', 'name', member.name, branch, { source: branch }, location(current.filePath, execute), []);
            }
            current = this.index.resolveBaseClass(current);
        }
        return { owner, entries, routes };
    }
}
module.exports = { parseJsRequests, RequestRoutes, blTokens, offsetFor };
