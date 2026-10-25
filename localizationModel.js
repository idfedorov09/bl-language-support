const path = require('path');

// Constrained Java XML-properties reader. No XML library, DTD loader, entity
// expansion or network access. Unsupported/broken XML invalidates the file;
// never advertise an incomplete parse as a complete dictionary.
const LOCALE_SUFFIX = /_([a-z]{2,3}(?:[-_][A-Za-z]{2}|[-_]\d{3})?)\.nls$/i;
function localeFor(file) {
    const match = LOCALE_SUFFIX.exec(path.basename(file));
    return match ? normalizeLocale(match[1]) : null;
}
function resourceFamily(file) {
    const name = path.basename(file), match = LOCALE_SUFFIX.exec(name);
    return match ? path.join(path.dirname(file), name.slice(0, match.index)) : null;
}
function normalizeLocale(locale) { return String(locale).replace(/_/g, '-').toLowerCase(); }
function parseNls(text, filePath) {
    const entries = [], valueSpans = [];
    let rootSpan = null;
    const locale = localeFor(filePath);
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0, root = false, closed = false, doctype = false, declaration = false;
    const fail = message => { throw { message, start: i, end: Math.min(text.length, i + 1) }; };
    const xmlChar = cp => cp === 9 || cp === 10 || cp === 13 || cp >= 0x20 && cp <= 0xd7ff || cp >= 0xe000 && cp <= 0xfffd || cp >= 0x10000 && cp <= 0x10ffff;
    const decode = (value, attribute = false) => {
        if (value.includes('<')) fail('Неэкранированный < в XML.');
        const normalized = value.replace(/\r\n?/g, '\n');
        let result = '', at = 0;
        for (const match of normalized.matchAll(/&([^;]*);|&/g)) {
            const plain = normalized.slice(at, match.index);
            result += attribute ? plain.replace(/[\t\n]/g, ' ') : plain;
            const entity = match[1], named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
            if (Object.prototype.hasOwnProperty.call(named, entity)) result += named[entity];
            else if (entity && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) {
                const cp = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
                if (!xmlChar(cp)) fail('Недопустимый XML character reference.');
                result += String.fromCodePoint(cp);
            } else fail('Неизвестная XML entity; custom/external entities не поддерживаются.');
            at = match.index + match[0].length;
        }
        const tail = normalized.slice(at);
        return result + (attribute ? tail.replace(/[\t\n]/g, ' ') : tail);
    };
    const comment = () => {
        const end = text.indexOf('-->', i + 4);
        if (end < 0 || text.slice(i + 4, end).includes('--') || text[end - 1] === '-') fail('Некорректный XML comment.');
        i = end + 3;
    };
    const content = name => {
        let value = '';
        while (i < text.length) {
            if (text.startsWith(`</${name}`, i)) {
                const end = new RegExp(`^</${name}\\s*>`).exec(text.slice(i));
                if (!end) fail('Некорректный закрывающий XML tag.');
                i += end[0].length; return value;
            }
            if (text.startsWith('<!--', i)) { comment(); continue; }
            if (text.startsWith('<![CDATA[', i)) {
                const end = text.indexOf(']]>', i + 9);
                if (end < 0) fail('Незакрытая CDATA.');
                valueSpans.push({ start: i + 9, end, cdata: true });
                value += text.slice(i + 9, end).replace(/\r\n?/g, '\n'); i = end + 3; continue;
            }
            if (text[i] === '<') fail('Вложенные XML tags в значении не поддерживаются; используйте CDATA.');
            const end = text.indexOf('<', i), chunk = text.slice(i, end < 0 ? text.length : end);
            if (chunk.includes(']]>')) fail(']]> допустим только как окончание CDATA.');
            valueSpans.push({ start: i, end: i + chunk.length, cdata: false });
            value += decode(chunk); i += chunk.length;
        }
        fail(`Незакрытый ${name}.`);
    };
    try {
        if (!locale) fail('Язык .nls должен быть задан суффиксом _ru, _en или _en-US.');
        for (const ch of text) if (!xmlChar(ch.codePointAt(0))) fail('Недопустимый XML character.');
        while (i < text.length) {
            const space = /^\s+/.exec(text.slice(i));
            if (space) { i += space[0].length; continue; }
            if (text.startsWith('<!--', i)) { comment(); continue; }
            if (text.startsWith('<?xml', i)) {
                if (root || declaration || doctype || i !== (text.charCodeAt(0) === 0xfeff ? 1 : 0)) fail('XML declaration должна быть первой.');
                const header = /^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/i.exec(text.slice(i));
                if (!header) fail('Поддерживается XML 1.0 UTF-8 declaration.');
                declaration = true; i += header[0].length; continue;
            }
            if (text.startsWith('<!DOCTYPE', i)) {
                if (root || doctype) fail('Некорректное положение DOCTYPE.');
                // Permit only Java's conventional inert declaration, never fetch it.
                const inert = /^<!DOCTYPE\s+properties\s+SYSTEM\s+(["'])http:\/\/java\.sun\.com\/dtd\/properties\.dtd\1\s*>/.exec(text.slice(i));
                if (!inert) fail('Custom/internal/external DTD запрещены; стандартный properties.dtd не загружается.');
                doctype = true; i += inert[0].length; continue;
            }
            if (!root) {
                const start = /^<properties\s*(\/?)>/.exec(text.slice(i));
                if (!start) fail('Ожидается XML properties root.');
                rootSpan = { start: i, end: i + start[0].length, selfClosing: !!start[1], closeStart: null };
                root = true; closed = !!start[1]; i += start[0].length; continue;
            }
            if (closed) fail('Содержимое после properties root.');
            const end = /^<\/properties\s*>/.exec(text.slice(i));
            if (end) { rootSpan.closeStart = i; closed = true; i += end[0].length; continue; }
            const note = /^<comment\s*(\/?)>/.exec(text.slice(i));
            if (note) { i += note[0].length; if (!note[1]) content('comment'); continue; }
            const entry = /^<entry\s+key\s*=\s*(["'])((?:(?!\1)[^])*)\1\s*(\/?)>/.exec(text.slice(i));
            if (!entry) fail('Ожидается entry с единственным атрибутом key.');
            const entryStart = i;
            valueSpans.length = 0;
            const start = i + entry[0].indexOf(entry[1]) + 1, key = decode(entry[2], true);
            i += entry[0].length;
            const valueStart = i;
            const value = entry[3] ? '' : content('entry');
            entries.push({ key, value, locale, filePath, start, end: start + entry[2].length,
                entryStart, entryEnd: i, valueStart, selfClosing: !!entry[3], valueSpans: valueSpans.map(span => ({ ...span })) });
        }
        if (!root || !closed) fail('Незакрытый properties root.');
        return { locale, entries, rootSpan, issues: [] };
    } catch (issue) {
        return { locale, entries: [], issues: [{ message: issue.message || String(issue), start: issue.start ?? i, end: issue.end ?? i }] };
    }
}
function resolveTranslation(resources, key, locale) {
    locale = normalizeLocale(locale);
    const sources = resources.flatMap(resource => resource.entries).filter(entry => entry.locale === locale && entry.key === key)
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.start - b.start);
    const problems = resources.filter(resource => resource.issues.length && (!resource.locale || resource.locale === locale));
    // A broken resource can hide another conflicting value: never guess a value
    // or produce a definitive missing diagnostic while this locale is incomplete.
    if (problems.length) return { status: 'unavailable', sources, problems };
    if (!sources.length) return { status: 'missing', sources, problems };
    if (new Set(sources.map(entry => entry.value)).size > 1) return { status: 'conflict', sources, problems };
    return { status: 'found', value: sources[0].value, sources, problems };
}
module.exports = { parseNls, localeFor, normalizeLocale, resolveTranslation, resourceFamily };
