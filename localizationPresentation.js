// Source-only presentation; the document model is never rewritten.
const LOCALIZATION_KEY = /^[A-Za-z_][\w.-]*$/;
function displayText(value) {
    // Decoration contentText is a single-line display. This is a candidate
    // representation, not a silently accepted change to the multiline contract.
    return JSON.stringify(value);
}

function* stringLiterals(text) {
    // One lexical scan shared by display/navigation and incomplete-string completion.
    let i = 0;
    while (i < text.length) {
        if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
        if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
        if (text[i] !== '"' && text[i] !== "'") { i++; continue; }
        const quote = text[i], start = i++;
        let closed = false;
        while (i < text.length) {
            if (text[i] === '\\') { i = Math.min(text.length, i + 2); continue; }
            if (text[i++] === quote) { closed = true; break; }
        }
        yield { start, end: i, quote, closed, contentEnd: closed ? i - 1 : i };
    }
}
function localizationLiterals(text) {
    const result = [];
    for (const item of stringLiterals(text)) {
        if (!item.closed || item.quote !== '"') continue;
        const literal = text.slice(item.start, item.end);
        const key = literal.startsWith('"$') && literal.endsWith('$"') ? literal.slice(2, -2) : '';
        if (LOCALIZATION_KEY.test(key)) result.push({ start: item.start, end: item.end, key, source: literal });
    }
    return result;
}

function presentation(text, selections, translations) {
    const result = [];
    for (const literal of localizationLiterals(text)) {
        const { start, end, key } = literal;
        if (!translations.has(key)) continue;
        // Reveal the real source for all cursors/selections touching the literal,
        // including a cursor at either boundary and multiline selections.
        if (selections.some(s => s.start <= end && s.end >= start)) continue;
        result.push({ ...literal, display: displayText(translations.get(key)), translation: translations.get(key) });
    }
    return result;
}
function missingTranslations(text, translations) {
    return localizationLiterals(text).filter(literal => !translations.has(literal.key));
}
module.exports = { presentation, displayText, localizationLiterals, stringLiterals, LOCALIZATION_KEY, missingTranslations };
