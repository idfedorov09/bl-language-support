const { resourceFamily } = require('./localizationModel');
const { localizationLiterals, LOCALIZATION_KEY } = require('./localizationPresentation');
const { fingerprint, applyTextEdits, renameKeyEdits } = require('./localizationEdits');
const MAX_FILES = 10000, MAX_TEXT = 64 * 1024 * 1024, MAX_EDITS = 20000;
function keyError(from, to) {
    if (typeof to !== 'string' || !to.length || to.length > 256 || !LOCALIZATION_KEY.test(to))
        return 'Введите ключ без пробелов: буквы, цифры, _, точки и дефисы; первый символ — буква или _ (до 256 символов).';
    return from === to ? 'Новое имя должно отличаться от текущего.' : null;
}
function snapshotSignature(state) {
    return fingerprint(JSON.stringify([state.root,
        [...state.resources.map(source => ['NLS', source.filePath, fingerprint(source.text)]),
            ...state.blSources.map(source => ['BL', source.filePath, fingerprint(source.text)])]
            .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))]));
}
function renamePlan(state, from, to) {
    const error = keyError(from, to);
    if (error) throw Error(error);
    if (!LOCALIZATION_KEY.test(from)) throw Error('Текущий ключ не поддерживает переименование.');
    const sources = [...state.resources, ...state.blSources];
    if (new Set(sources.map(source => source.filePath)).size !== sources.length)
        throw Error('Неоднозначный список исходников: файл найден несколько раз. Проверьте workspace-папки.');
    if (sources.length > MAX_FILES || sources.reduce((size, file) => size + file.text.length, 0) > MAX_TEXT)
        throw Error('Checkout слишком большой для безопасного rename. План не был сокращён.');
    const broken = state.resources.find(resource => resource.issues.length);
    if (broken) throw Error('Нельзя проверить коллизии: NLS недоступен или повреждён: ' + broken.filePath);
    const entries = state.resources.flatMap(resource => resource.entries);
    const old = entries.filter(entry => entry.key === from);
    const families = new Set(old.map(entry => resourceFamily(entry.filePath)));
    if (!old.length || families.has(null)) throw Error('Ключ не найден в доступных NLS. Переименование недоступно.');
    if (families.size !== 1 || new Set(old.map(entry => entry.locale)).size !== old.length)
        throw Error('Неоднозначный ключ: несколько NLS-наборов или повторные записи языка. Переименование не выполнено.');
    if (entries.some(entry => entry.key === to)) throw Error('Новый ключ уже существует в NLS: ' + to);
    const changes = [];
    for (const resource of state.resources) {
        if (!resource.entries.some(entry => entry.key === from)) continue;
        const planned = renameKeyEdits(resource, from, to);
        changes.push({ filePath: resource.filePath, kind: 'NLS', locale: resource.locale, before: from, after: to, ...planned });
    }
    for (const source of state.blSources) {
        const literals = localizationLiterals(source.text);
        if (literals.some(literal => literal.key === to)) throw Error('Новый ключ уже используется в BL: ' + to);
        const edits = literals.filter(literal => literal.key === from).map(literal => ({ start: literal.start + 2, end: literal.end - 2, text: to }));
        if (edits.length) changes.push({ filePath: source.filePath, kind: 'BL', before: from, after: to,
            edits, updated: applyTextEdits(source.text, edits) });
    }
    if (changes.reduce((size, change) => size + change.edits.length, 0) > MAX_EDITS) throw Error('Слишком много замен для безопасного rename. План не был сокращён.');
    const byPath = new Map(sources.map(source => [source.filePath, source]));
    for (const change of changes) {
        const text = byPath.get(change.filePath).text;
        change.hash = fingerprint(text);
        change.count = change.edits.length;
        let cursor = 0, line = 1;
        change.lines = change.edits.map(edit => {
            while (cursor < edit.start) if (text[cursor++] === '\n') line++;
            return line;
        });
    }
    changes.sort((a, b) => a.filePath.localeCompare(b.filePath));
    return { kind: 'rename', from, to, changes, signature: snapshotSignature(state) };
}
module.exports = { keyError, snapshotSignature, renamePlan };
