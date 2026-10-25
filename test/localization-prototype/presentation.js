// Isolated API feasibility probe, NOT a production NLS resolver. Resources,
// checkout precedence and XML are deliberately outside the presentation gate.
const samples = new Map([
    ['Workspace.title', 'Документы'],
    ['Prototype.short', 'Да'],
    ['Prototype.long', 'Очень длинный перевод для проверки переноса строки и положения следующего поля'],
    ['Prototype.special', 'Кавычки "текст", <tag>, & и \\'],
    ['Prototype.multiline', 'Первая строка\nВторая строка'],
    ['Prototype.unicode', 'Документы 📄 — Ελληνικά — 中文']
]);

function displayText(value) {
    // Decoration contentText is a single-line display. This is a candidate
    // representation, not a silently accepted change to the multiline contract.
    return JSON.stringify(value);
}

function localizationLiterals(text) {
    const result = [];
    // A lexical scan, not a raw global key regex: ignore comments/other literals.
    let i = 0;
    while (i < text.length) {
        if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
        if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
        if (text[i] !== '"' && text[i] !== "'") { i++; continue; }
        const quote = text[i], start = i++;
        let closed = false;
        while (i < text.length) {
            if (text[i] === '\\') { i += 2; continue; }
            if (text[i++] === quote) { closed = true; break; }
        }
        if (!closed) continue;
        const end = i, literal = text.slice(start, end);
        const match = quote === '"' && /^"\$([A-Za-z_][\w.-]*)\$"$/.exec(literal);
        if (!match) continue;
        result.push({ start, end, key: match[1], source: literal });
    }
    return result;
}

function presentation(text, selections, translations = samples) {
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
function missingTranslations(text, translations = samples) {
    return localizationLiterals(text).filter(literal => !translations.has(literal.key));
}
module.exports = { presentation, samples, displayText, localizationLiterals, missingTranslations };
