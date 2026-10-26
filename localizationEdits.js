const crypto = require('crypto');
const { parseNls } = require('./localizationModel');
const fingerprint = text => crypto.createHash('sha256').update(text).digest('hex');
function encodeXml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\r/g, '&#13;');
}
function applyTextEdits(text, edits) {
    let boundary = text.length;
    for (const edit of edits.slice().sort((a, b) => b.start - a.start || b.end - a.end)) {
        if (edit.start < 0 || edit.end < edit.start || edit.end > boundary) throw Error('Пересекающиеся XML-изменения.');
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); boundary = edit.start;
    }
    return text;
}
function translationEdits(resource, key, value, entryStart = null) {
    const { text, filePath } = resource;
    const parsed = parseNls(text, filePath);
    if (parsed.issues.length) throw Error('Нельзя изменить повреждённый NLS.');
    let edits;
    const entries = parsed.entries.filter(entry => entry.key === key);
    if (entryStart !== null) {
        const entry = entries.find(entry => entry.entryStart === entryStart);
        if (!entry) throw Error('Исходная запись изменена; обновите ресурсы.');
        if (entry.selfClosing) {
            const opening = text.slice(entry.entryStart, entry.entryEnd).replace(/\/>$/, '>');
            edits = [{ start: entry.entryStart, end: entry.entryEnd, text: opening + encodeXml(value) + '</entry>' }];
        } else if (entry.valueSpans.length) {
            edits = entry.valueSpans.map((span, i) => ({ start: span.start, end: span.end,
                text: i ? '' : span.cdata ? value.replace(/\r/g, '\n').replace(/]]>/g, ']]]]><![CDATA[>') : encodeXml(value) }));
            // CDATA cannot represent CR distinct from LF. Use escaped text
            // inserted before its wrapper, leave the original wrapper empty.
            if (entry.valueSpans[0].cdata && value.includes('\r')) {
                edits[0].text = ''; edits.push({ start: entry.valueStart, end: entry.valueStart, text: encodeXml(value) });
            }
        } else edits = [{ start: entry.valueStart, end: entry.valueStart, text: encodeXml(value) }];
    } else {
        if (entries.length) throw Error('Ключ уже существует в целевом ресурсе.');
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const indentMatch = /^([ \t]+)<entry\b/m.exec(text), indent = indentMatch ? indentMatch[1] : '    ';
        const added = `${indent}<entry key="${encodeXml(key)}">${encodeXml(value)}</entry>${eol}`;
        const root = parsed.rootSpan;
        if (root.selfClosing) edits = [{ start: root.start, end: root.end,
            text: text.slice(root.start, root.end).replace(/\/>$/, '>') + eol + added + '</properties>' }];
        else {
            const lineStart = text.lastIndexOf('\n', root.closeStart - 1) + 1;
            const at = /^[ \t]*$/.test(text.slice(lineStart, root.closeStart)) ? lineStart : root.closeStart;
            edits = [{ start: at, end: at, text: (at === root.closeStart && at !== lineStart ? eol : '') + added }];
        }
    }
    const updated = applyTextEdits(text, edits), verified = parseNls(updated, filePath);
    if (verified.issues.length || !verified.entries.some(entry => entry.key === key && entry.value === value && (entryStart === null || entry.entryStart === entryStart))) {
        throw Error('Перевод содержит недопустимые XML-символы или не может быть безопасно применён.');
    }
    return { edits, updated };
}
function renameKeyEdits(resource, from, to) {
    const parsed = parseNls(resource.text, resource.filePath);
    if (parsed.issues.length) throw Error('Нельзя переименовать ключ в повреждённом NLS.');
    if (parsed.entries.some(entry => entry.key === to)) throw Error('Новый ключ уже существует в NLS.');
    const old = parsed.entries.filter(entry => entry.key === from);
    if (old.length !== 1) throw Error('Ключ отсутствует или имеет неоднозначные записи.');
    const entry = old[0], edits = [{ start: entry.start, end: entry.end, text: encodeXml(to) }];
    const updated = applyTextEdits(resource.text, edits), checked = parseNls(updated, resource.filePath);
    if (checked.issues.length || checked.entries.length !== parsed.entries.length
        || checked.entries.some((item, index) => item.key !== (parsed.entries[index] === entry ? to : parsed.entries[index].key)
            || item.value !== parsed.entries[index].value)) throw Error('Не удалось безопасно переименовать NLS-ключ.');
    return { edits, updated };
}
module.exports = { fingerprint, encodeXml, translationEdits, applyTextEdits, renameKeyEdits };
