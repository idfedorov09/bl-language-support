// Shared, read-only completion model. Coordinates refer to original BL text.
const { stringLiterals, LOCALIZATION_KEY: KEY } = require('./localizationPresentation');
const { resolveTranslation } = require('./localizationModel');
const MAX_ITEMS = 200;
function completionContext(text, offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return null;
    const nextLine = text.indexOf('\n', offset);
    let lineEnd = nextLine < 0 ? text.length : nextLine;
    if (text[lineEnd - 1] === '\r') lineEnd--;
    // Scan only through this line so an unfinished quote cannot consume later code.
    for (const literal of stringLiterals(text.slice(0, lineEnd))) {
        if (literal.quote !== '"' || offset <= literal.start || offset > literal.contentEnd) continue;
        const content = text.slice(literal.start + 1, literal.contentEnd);
        if (!content.startsWith('$') || /[\r\n]/.test(content)) return null;
        const start = literal.start + 2;
        const keyEnd = literal.contentEnd - (content.endsWith('$') && content.length > 1 ? 1 : 0);
        if (offset < start || offset > keyEnd) return null;
        const key = text.slice(start, keyEnd);
        if (key && !KEY.test(key)) return null;
        return { start, end: literal.contentEnd, prefix: text.slice(start, offset), closeQuote: !literal.closed };
    }
    return null;
}
function completionCandidates(state, prefix, locale) {
    const keys = new Map(), problems = [];
    for (const resource of state.resources) {
        if (resource.issues.length) { problems.push(resource); continue; }
        for (const entry of resource.entries) {
            if (!KEY.test(entry.key)) continue;
            if (!keys.has(entry.key)) keys.set(entry.key, []);
            keys.get(entry.key).push(entry);
        }
    }
    const matches = [...keys.keys()].filter(key => key.toLowerCase().startsWith(prefix.toLowerCase())).sort();
    return { isIncomplete: matches.length > MAX_ITEMS, items: matches.slice(0, MAX_ITEMS).map(key => {
        const sources = keys.get(key);
        const result = resolveTranslation([{ entries: sources, issues: [] }, ...problems], key, locale);
        return { key, result, sources };
    }) };
}
module.exports = { completionContext, completionCandidates, MAX_ITEMS };
