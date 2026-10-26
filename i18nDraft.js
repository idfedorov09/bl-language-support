const path = require('path');
const { resolveTranslation, resourceFamily } = require('./localizationModel');
const { fingerprint } = require('./localizationEdits');
const MAX_VALUE = 65536, MAX_DRAFT = 262144;
function createDraft(state, key, locale, required = []) {
    const families = new Set(state.resources.filter(r => !r.issues.length && r.entries.some(e => e.key === key))
        .map(r => resourceFamily(r.filePath)).filter(Boolean));
    const resources = state.resources.filter(r => families.has(resourceFamily(r.filePath)));
    const locales = [...new Set([locale, ...required, ...resources.map(r => r.locale).filter(Boolean)])];
    const resourceSets = [...families].sort().map(family => ({
        label: path.basename(family), path: path.relative(state.root, family),
        files: resources.filter(r => resourceFamily(r.filePath) === family).map(r => path.relative(state.root, r.filePath)).sort(),
        locales: [...new Set(resources.filter(r => resourceFamily(r.filePath) === family).map(r => r.locale).filter(Boolean))].sort()
    }));
    return { root: state.root, key, locale, resourceSets, revision: 0, rows: locales.map((language, id) => {
        const resolved = resolveTranslation(resources, key, language);
        const options = resources.filter(r => r.locale === language && !r.issues.length)
            .sort((a, b) => a.filePath.localeCompare(b.filePath)).flatMap(r => {
                const entries = r.entries.filter(e => e.key === key);
                return entries.length ? entries.map(e => ({ filePath: r.filePath, hash: fingerprint(r.text),
                    entryStart: e.entryStart, start: e.start, end: e.end, value: e.value,
                    label: `${path.relative(state.root, r.filePath)} · запись ${e.start}` }))
                    : [{ filePath: r.filePath, hash: fingerprint(r.text), entryStart: null, value: null,
                        label: path.relative(state.root, r.filePath) + ' · добавить ключ' }];
            }).map((option, id) => ({ ...option, id }));
        const only = resolved.status !== 'unavailable' && resolved.sources.length === 1
            ? options.find(o => o.filePath === resolved.sources[0].filePath && o.entryStart === resolved.sources[0].entryStart)
            : resolved.status === 'missing' && options.length === 1 ? options[0] : null;
        const value = resolved.status === 'found' ? resolved.value : '';
        return { id, locale: language, status: resolved.status, original: value, value,
            target: only ? only.id : null, options, edited: false, stale: false, revision: 0,
            resourceHelp: !families.size ? 'Не удалось определить набор NLS: ключ не найден в доступных ресурсах.'
                : !options.length && resolved.status === 'missing' ? 'Нет NLS-файла этого языка в наборе ключа. ИИ-перевод недоступен.' : '' };
    }) };
}
function updateRow(draft, id, value, target) {
    const row = draft.rows.find(r => r.id === id);
    if (!row || typeof value !== 'string' || value.length > MAX_VALUE ||
        target !== null && (!Number.isSafeInteger(target) || !row.options.some(o => o.id === target))) throw Error('Некорректное поле перевода.');
    const previous = { ...row }, oldRevision = draft.revision;
    row.ai = !!row.ai && row.value === value;
    row.value = value; row.target = target;
    const selected = row.options.find(o => o.id === target);
    row.edited = selected ? value !== selected.value : value !== row.original;
    row.revision++; draft.revision++;
    if (JSON.stringify(serializeDraft(draft)).length > MAX_DRAFT) { Object.assign(row, previous); draft.revision = oldRevision; throw Error('Черновик слишком большой для локального хранения.'); }
}
function serializeDraft(draft) {
    return { root: draft.root, key: draft.key, rows: draft.rows.filter(r => r.edited).map(row => {
        const option = row.options.find(o => o.id === row.target);
        return { locale: row.locale, value: row.value, original: row.original, ai: !!row.ai, stale: !!row.stale,
            target: option ? { filePath: option.filePath, entryStart: option.entryStart, hash: option.hash } : null };
    }) };
}
function restoreDraft(draft, saved) {
    if (!saved || saved.root !== draft.root || saved.key !== draft.key || !Array.isArray(saved.rows) || JSON.stringify(saved).length > MAX_DRAFT) return false;
    let restored = false;
    for (const stored of saved.rows) {
        const row = draft.rows.find(r => r.locale === stored.locale);
        if (!row || typeof stored.value !== 'string' || stored.value.length > MAX_VALUE || typeof stored.original !== 'string') continue;
        const option = stored.target && row.options.find(o => o.filePath === stored.target.filePath && o.entryStart === stored.target.entryStart);
        row.ai = stored.ai === true; row.value = stored.value; row.original = stored.original; row.edited = true; row.target = option ? option.id : null;
        row.stale = stored.stale === true || !row.options.length || !!stored.target && (!option || stored.target.hash !== option.hash);
        if (row.stale && option) option.hash = stored.target.hash;
        restored = true;
    }
    return restored;
}
module.exports = { createDraft, updateRow, serializeDraft, restoreDraft, MAX_VALUE, MAX_DRAFT };
