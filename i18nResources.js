const path = require('path');
const fs = require('fs');
const { resourceFamily, localeFor, normalizeLocale } = require('./localizationModel');
const { fingerprint } = require('./localizationEdits');

const EMPTY_RESOURCE = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">\n<properties>\n</properties>\n';
const COMMON_LOCALES = ['ru', 'en', 'uz', 'kk', 'ky', 'tg', 'az', 'hy', 'ka', 'uk', 'be', 'de', 'fr', 'es', 'pt', 'tr', 'zh', 'ja', 'ko', 'ar'];
function languageCode(value) {
    if (typeof value !== 'string' || value.length > 12) return null;
    const locale = normalizeLocale(value.trim());
    return /^[a-z]{2,3}(?:-(?:[a-z]{2}|\d{3}))?$/.test(locale) && localeFor('resource_' + locale + '.nls') === locale ? locale : null;
}
function familiesFor(state, key) {
    return [...new Set(state.resources.filter(r => !r.issues.length && r.entries.some(entry => entry.key === key))
        .map(r => resourceFamily(r.filePath)).filter(Boolean))].sort();
}
function familySignature(state, family) {
    return JSON.stringify(state.resources.filter(r => resourceFamily(r.filePath) === family)
        .map(r => [r.filePath, fingerprint(r.text)]).sort((a, b) => a[0].localeCompare(b[0])));
}
function creationPlan(state, key, family, input) {
    const locale = languageCode(input);
    if (!locale) throw Error('Введите код языка, например uz, en или pt-BR.');
    if (!familiesFor(state, key).includes(family)) throw Error('Набор ресурсов изменился. Откройте редактор заново.');
    const filePath = family + '_' + locale + '.nls';
    if (resourceFamily(filePath) !== family || localeFor(filePath) !== locale) throw Error('Неподдерживаемое имя ресурса.');
    return { family, locale, filePath, root: state.root, signature: familySignature(state, family) };
}
function collision(file, plan) {
    return path.dirname(file) === path.dirname(plan.filePath) && (
        path.basename(file).toLowerCase() === path.basename(plan.filePath).toLowerCase()
        || localeFor(file) === plan.locale && (resourceFamily(file) || '').toLowerCase() === plan.family.toLowerCase());
}
async function checkDestination(plan, documents) {
    const parent = path.dirname(plan.filePath);
    let realRoot, realParent, names;
    try {
        [realRoot, realParent, names] = await Promise.all([
            fs.promises.realpath(plan.root), fs.promises.realpath(parent), fs.promises.readdir(parent)
        ]);
    } catch (_) { throw Error('Каталог NLS недоступен или удалён. Проверьте путь и права доступа; файл не создан.'); }
    const relative = path.relative(plan.root, parent);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
        || realParent !== path.resolve(realRoot, relative)) throw Error('Создание в каталоге-ссылке или вне checkout недоступно. Выберите обычный каталог ресурсов.');
    if (names.some(name => collision(path.join(parent, name), plan)) || documents.some(doc => !doc.isClosed && doc.uri.scheme === 'file' && collision(doc.uri.fsPath, plan)))
        throw Error(`NLS-файл для ${plan.locale} уже существует. Ничего не перезаписано; обновите ресурсы.`);
}
// Preserve identities, revisions, manual values and AI history. Only the chosen
// locale receives fresh options. Recovered stale/null edits never auto-rebase.
function attachCreatedResource(draft, freshDraft, plan) {
    const current = freshDraft.rows.find(row => row.locale === plan.locale);
    if (!current || !current.options.some(option => option.filePath === plan.filePath)) throw Error('Новый ресурс не обнаружен индексом. Проверьте исключения и XML; черновик сохранён.');
    const old = draft.rows.find(row => row.locale === plan.locale);
    if (old) {
        const selected = old.options.find(option => option.id === old.target);
        const target = selected ? current.options.find(option => option.filePath === selected.filePath && option.entryStart === selected.entryStart)
            : !old.edited && !old.stale && !old.options.length ? current.options.find(option => option.filePath === plan.filePath) : null;
        const options = current.options.map(option => {
            const previous = old.options.find(item => item.filePath === option.filePath && item.entryStart === option.entryStart);
            return previous ? { ...previous, id: option.id } : option;
        });
        const changed = old.options.some(option => !current.options.some(item => item.filePath === option.filePath
            && item.entryStart === option.entryStart && item.hash === option.hash));
        Object.assign(old, { options, target: target ? target.id : null, stale: old.stale || changed,
            status: current.status, resourceHelp: current.resourceHelp });
    } else draft.rows.push({ ...current, id: Math.max(-1, ...draft.rows.map(row => row.id)) + 1 });
    draft.resourceSets = freshDraft.resourceSets;
    draft.revision++;
}
module.exports = { EMPTY_RESOURCE, COMMON_LOCALES, languageCode, familiesFor, familySignature, creationPlan, checkDestination, attachCreatedResource };
