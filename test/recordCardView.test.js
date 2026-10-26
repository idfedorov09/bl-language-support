const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { renderRecordCardHtml, renderRecordHover } = require('../recordCardView');

const nonce = 'fixture_Nonce123';
const guid = '10db2022-e31e-4c5a-a338-96d0fe38dbb4';
const source = { filePath: '/workspace/clm/src/main/bl/example/Roles.bl', line: 20, column: 4 };

function model(overrides = {}) {
    return {
        name: 'Admin', owner: 'example.Roles', guid, value: `'${guid}'`, source,
        sourceId: 0, ownerSourceId: 2,
        scopeLabel: '/workspace/clm', label: 'Администратор',
        attributes: [{ name: 'name', value: '"$Roles.admin$"', line: 21, column: 8, sourceId: 3 },
            { name: 'role', value: 'Roles.Admin', line: 22, column: 8, sourceId: 4 }],
        links: [{ id: 0, label: 'Объявление Admin', ...source, kind: 'declaration' },
            { id: 1, label: 'Roles.Admin', filePath: '/workspace/clm/src/main/bl/example/Access.bl', line: 9, column: 12, kind: 'related' },
            { id: 2, label: 'Класс-владелец', ...source, line: 0, column: 13 },
            { id: 3, label: 'Атрибут name', ...source, line: 21, column: 8 },
            { id: 4, label: 'Атрибут role', ...source, line: 22, column: 8 }],
        related: [{ label: 'role: Roles.Admin', guid, sourceId: 1 }],
        otherDeclarations: [], warnings: [], warningSourceIds: [], ...overrides
    };
}

function scriptOf(html) {
    const match = html.match(/<script nonce="[^\"]+">([\s\S]*?)<\/script>/);
    assert.ok(match, 'the webview must have one nonce-bound script');
    return match[1];
}

// Minimal DOM behavior for the actual emitted script (no browser/UI launch).
function runScript(html) {
    const messages = [], elements = new Map(), handlers = {}, windowHandlers = {};
    const element = id => {
        if (!elements.has(id)) elements.set(id, { id, hidden: false, disabled: false, attrs: {}, focuses: 0, scrolls: 0,
            setAttribute(key, value) { this.attrs[key] = value; }, focus() { this.focuses++; }, scrollIntoView() { this.scrolls++; } });
        return elements.get(id);
    };
    vm.runInNewContext(scriptOf(html), {
        acquireVsCodeApi: () => ({ postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) }),
        window: { addEventListener: (name, listener) => { windowHandlers[name] = listener; } },
        document: { addEventListener: (name, listener) => { handlers[name] = listener; }, getElementById: element }
    });
    return { messages, element, handlers, windowHandlers, press(dataset) {
        handlers.click({ target: { closest: selector => {
            assert.equal(selector, 'button[data-action]'); return { dataset };
        } } });
    } };
}

test('record card presents static metadata, source context and read-only attributes', () => {
    const html = renderRecordCardHtml(model(), nonce);
    for (const value of ['Admin', 'example.Roles', guid, 'Администратор', '$Roles.admin$', 'Roles.Admin', 'Контекст поиска: /workspace/clm']) {
        assert.ok(html.includes(value), `missing card value: ${value}`);
    }
    assert.ok(html.includes(`${source.filePath}:21:5`), 'source coordinates are displayed one-based');
    assert.ok(html.includes('Строка 22'), 'attribute coordinates are displayed one-based');
    assert.ok(html.includes('Связанные записи'));
    assert.ok(html.includes('не фактические права текущего пользователя'));
    assert.ok(html.includes('не выполняет запросы к серверу'));
    assert.ok(html.includes('Использования ещё не запрошены'));
    assert.ok(!/<(?:input|textarea|form)\b|contenteditable/i.test(html));
    assert.ok(!/clipboard|execCommand|fetch\(|XMLHttpRequest|command:/i.test(scriptOf(html)));
    assert.ok(html.includes('user-select: text'), 'GUID is copied by ordinary text selection');
});

test('card uses VS Code theme variables and a strict nonce CSP without external resources', () => {
    const html = renderRecordCardHtml(model(), nonce);
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes(`style-src 'nonce-${nonce}'`));
    assert.ok(html.includes(`script-src 'nonce-${nonce}'`));
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(html.includes("base-uri 'none'"));
    assert.ok(html.includes("form-action 'none'"));
    assert.ok(html.includes(`<style nonce="${nonce}">`));
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    for (const variable of ['editor-background', 'editor-foreground', 'editor-font-family', 'textLink-foreground', 'focusBorder', 'editorWarning-foreground']) {
        assert.ok(html.includes(`var(--vscode-${variable}`), `missing native theme variable ${variable}`);
    }
    assert.ok(html.includes('@media (max-width: 600px)'));
    assert.ok(!/unsafe-inline|unsafe-eval|https?:\/\/|<link\b|<img\b|<script[^>]*\bsrc=|\bonclick=/i.test(html));
});

test('all source-controlled card content is escaped and never enters the script', () => {
    const malicious = '</script><img src=x onerror="alert(1)"> & \'"';
    const poisonedSource = { filePath: malicious, line: 0, column: 0 };
    const html = renderRecordCardHtml(model({
        name: malicious, owner: malicious, guid: malicious, value: malicious, source: poisonedSource,
        label: malicious, localizationKey: malicious, scopeLabel: malicious,
        attributes: [{ name: malicious, value: malicious, line: 0, column: 0, sourceId: 0 }],
        links: [{ id: 0, label: malicious, ...poisonedSource }], warnings: [malicious],
        related: [{ label: malicious, guid: malicious, sourceId: 0 }],
        otherDeclarations: [{ label: malicious, sourceId: 0 }], warningSourceIds: [0],
        usages: { symbol: [{ id: 0, label: malicious, ...poisonedSource }], literal: [], text: [], partial: malicious }
    }), nonce);
    assert.ok(!html.includes(malicious));
    assert.ok(html.includes('&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;&quot;'));
    assert.equal((html.match(/<script\b/g) || []).length, 1);
    assert.equal((html.match(/<\/script>/g) || []).length, 1);
    assert.ok(!html.includes('<img'));
    const script = scriptOf(html);
    assert.ok(!script.includes(malicious));
    assert.ok(!script.includes(source.filePath));
    assert.ok(script.includes('new Set([0])'));
});

test('malformed nonce cannot inject CSP, attributes or executable HTML', () => {
    for (const unsafe of ['', null, undefined, 'two words', '" onload="bad', "x';script-src *", '<script>', 'x&y', 123]) {
        assert.throws(() => renderRecordCardHtml(model(), unsafe), TypeError);
    }
    assert.doesNotThrow(() => renderRecordCardHtml(model(), 'abcDEF012+/=_-'));
});

test('only in-range integer link IDs with source coordinates become navigation buttons', () => {
    const html = renderRecordCardHtml(model({
        links: [
            { id: 0, label: 'Good', ...source },
            { id: '1', label: 'String ID', ...source },
            { id: 200, label: 'Wrong index', ...source },
            { id: 3, label: 'Wrong coordinate', ...source, line: -1 },
            { id: 4, label: 'Wrong path', ...source, filePath: 42 },
            { id: '5" onclick="evil', label: 'Injection', ...source }
        ]
    }), nonce);
    assert.deepEqual([...html.matchAll(/data-link="([^\"]+)"/g)].map(match => match[1]), ['0']);
    assert.ok(!html.includes('String ID'));
    assert.ok(!html.includes('onclick='));
    assert.ok(scriptOf(html).includes('new Set([0])'));
});

test('symbol, literal and text uses remain separate, including partial search provenance', () => {
    const usageSource = kind => ({ filePath: `/workspace/clm/${kind}.bl`, line: 2, column: 3 });
    const usages = {
        symbol: [{ id: 5, label: 'Semantic use', ...usageSource('symbol') }],
        literal: [{ id: 6, label: 'Literal use', ...usageSource('literal') }],
        text: [{ id: 7, label: 'Comment use', ...usageSource('text') }],
        partial: 'Исключён каталог generated'
    };
    const base = model();
    const html = renderRecordCardHtml({ ...base, usages, links: [...base.links,
        ...['symbol', 'literal', 'text'].flatMap(kind => usages[kind].map(entry => ({ ...entry, kind })))] }, nonce);
    assert.ok(html.includes('Поиск ограничен: Исключён каталог generated'));
    const groups = [...html.matchAll(/<section class="usage-group">([\s\S]*?)<\/section>/g)].map(match => match[1]);
    assert.equal(groups.length, 3);
    assert.ok(groups[0].includes('BL-символы') && groups[0].includes('Semantic use'));
    assert.ok(!groups[0].includes('Literal use') && !groups[0].includes('Comment use'));
    assert.ok(groups[1].includes('GUID-литералы') && groups[1].includes('Literal use'));
    assert.ok(groups[1].includes('не доказывает связь с этой записью'));
    assert.ok(groups[2].includes('Текстовые совпадения') && groups[2].includes('Comment use'));
    assert.ok(groups[2].includes('не семантические ссылки'));
    const related = html.match(/<section class="section" id="related">([\s\S]*?)<\/section>/)[1];
    assert.ok(related.includes('Roles.Admin'));
    assert.ok(!related.includes('Semantic use') && !related.includes('Literal use') && !related.includes('Comment use'));
});

test('usage source mismatching its link ID is displayed without a navigation button', () => {
    const html = renderRecordCardHtml(model({ usages: {
        symbol: [{ id: 1, label: 'Mismatch', filePath: '/other/bl/File.bl', line: 0, column: 0 }], literal: [], text: []
    } }), nonce);
    const group = html.match(/<section class="usage-group">([\s\S]*?)<\/section>/)[1];
    assert.ok(group.includes('Mismatch'));
    assert.ok(!group.includes('data-action="openSource"'));
});

test('owner and attribute navigation use their explicit source IDs, not the related-record list', () => {
    const html = renderRecordCardHtml(model(), nonce);
    const sourceSection = html.match(/<section class="section" id="source">([\s\S]*?)<\/section>/)[1];
    const attributeSection = html.match(/<section class="section" id="attributes">([\s\S]*?)<\/section>/)[1];
    const relatedSection = html.match(/<section class="section" id="related">([\s\S]*?)<\/section>/)[1];
    assert.ok(sourceSection.includes('Класс-владелец:'));
    assert.deepEqual([...sourceSection.matchAll(/data-link="(\d+)"/g)].map(match => Number(match[1])), [0, 2]);
    assert.deepEqual([...attributeSection.matchAll(/data-link="(\d+)"/g)].map(match => Number(match[1])), [3, 4]);
    assert.deepEqual([...relatedSection.matchAll(/data-link="(\d+)"/g)].map(match => Number(match[1])), [1]);
    assert.ok(relatedSection.includes('role: Roles.Admin'));
    assert.ok(relatedSection.includes(guid));
    assert.ok(!relatedSection.includes('Класс-владелец') && !relatedSection.includes('Атрибут name'));
});

test('orphan links never become related declarations or allowed UI navigation IDs', () => {
    const base = model();
    const orphan = { id: 5, label: 'Orphan declaration', filePath: '/orphan/src/bl/Unrelated.bl', line: 0, column: 0 };
    const html = renderRecordCardHtml({ ...base, related: [], links: [...base.links, orphan] }, nonce);
    const relatedSection = html.match(/<section class="section" id="related">([\s\S]*?)<\/section>/)[1];
    assert.ok(relatedSection.includes('Подтверждённых связей в локальных исходниках нет'));
    assert.ok(!relatedSection.includes('Roles.Admin'));
    assert.ok(!html.includes(orphan.label) && !html.includes(orphan.filePath));
    assert.ok(scriptOf(html).includes('new Set([0,2,3,4])'));
    assert.ok(!html.includes('data-link="1"') && !html.includes('data-link="5"'));
});

test('matching source coordinates do not restore missing explicit source IDs', () => {
    const base = model();
    const html = renderRecordCardHtml({ ...base, sourceId: undefined, ownerSourceId: undefined, related: [],
        attributes: base.attributes.map(({ sourceId, ...attribute }) => attribute)
    }, nonce);
    assert.ok(html.includes(`${source.filePath}:21:5`));
    assert.ok(html.includes('Строка 22'));
    assert.ok(!html.includes('data-action="openSource"'));
    assert.ok(scriptOf(html).includes('new Set([])'));
});

test('warnings have explicitly linked source evidence, with duplicate and invalid IDs ignored', () => {
    const base = model();
    const evidence = { id: 5, label: 'example.Roles.LegacyAdmin', ...source, line: 30, column: 4 };
    const html = renderRecordCardHtml({ ...base,
        warnings: ['В одном классе повторяется имя или GUID; потенциальный конфликт/алиас, не доказанная ошибка.'],
        warningSourceIds: [5, 5, -1, '5', 99, '5" onclick="evil'], links: [...base.links, evidence]
    }, nonce);
    const warnings = html.match(/<section class="warnings"[^>]*>([\s\S]*?)<\/section>/)[1];
    assert.ok(warnings.includes('потенциальный конфликт/алиас, не доказанная ошибка'));
    assert.ok(warnings.includes('Декларации для проверки:'));
    assert.ok(warnings.includes(evidence.label));
    assert.ok(warnings.includes(`${source.filePath}:31:5`));
    assert.deepEqual([...warnings.matchAll(/data-link="(\d+)"/g)].map(match => Number(match[1])), [5]);
    assert.ok(!html.includes('onclick='));
    const related = html.match(/<section class="section" id="related">([\s\S]*?)<\/section>/)[1];
    assert.ok(!related.includes(evidence.label));
});

test('same-GUID migrations remain informational candidates, not proved conflicts or related records', () => {
    const base = model();
    const migration = { id: 5, label: 'history.Migration.Admin', filePath: '/workspace/clm/src/bl/history/Migration.bl', line: 5, column: 4 };
    const html = renderRecordCardHtml({ ...base, related: [], links: [...base.links, migration],
        otherDeclarations: [{ label: migration.label, sourceId: 5 }]
    }, nonce);
    const duplicates = html.match(/<section class="section" id="other-declarations">([\s\S]*?)<\/section>/)[1];
    assert.ok(duplicates.includes('Другие декларации того же GUID'));
    assert.ok(duplicates.includes('Повтор GUID сам по себе не доказывает конфликт'));
    assert.ok(duplicates.includes('миграция, наследник или другая копия проекта'));
    assert.ok(duplicates.includes(migration.label));
    assert.ok(duplicates.includes('data-link="5"'));
    assert.ok(!html.includes('<section class="warnings"'));
    const related = html.match(/<section class="section" id="related">([\s\S]*?)<\/section>/)[1];
    assert.ok(!related.includes(migration.label));
});

test('localized labels retain the original localization key in both card and hover', () => {
    const translated = model({ label: 'Администратор системы', localizationKey: '$Roles.admin$' });
    const html = renderRecordCardHtml(translated, nonce);
    const hover = renderRecordHover(translated);
    assert.ok(html.includes('Администратор системы'));
    assert.ok(html.includes('Ключ локализации: <code>$Roles.admin$</code>'));
    assert.ok(hover.includes('**Название:** Администратор системы'));
    assert.ok(hover.includes('**Ключ локализации:** ` $Roles.admin$ `'));
    assert.ok(!renderRecordCardHtml(model({ label: null, localizationKey: '$Roles.admin$' }), nonce).includes('Ключ локализации:'));
    assert.ok(!renderRecordHover(model({ label: null, localizationKey: '$Roles.admin$' })).includes('Ключ локализации:'));
});

test('webview script sends only allowlisted user actions and never sends on opening', () => {
    const { messages, press, handlers } = runScript(renderRecordCardHtml(model(), nonce));
    const click = handlers.click;
    assert.deepEqual(messages, []);
    press({ action: 'openSource', link: '1' });
    press({ action: 'refresh' });
    press({ action: 'findUsages' });
    assert.deepEqual(messages, [{ type: 'openSource', id: 1 }, { type: 'refresh' }, { type: 'findUsages' }]);
    for (const link of ['', '-1', '99', '0.1', '1e0', 'NaN', '1" onclick="evil']) press({ action: 'openSource', link });
    press({ action: 'executeCommand', link: '0' });
    click({ target: null });
    click({ target: { closest: () => null } });
    assert.equal(messages.length, 3);
});

test('computed and absent data remain explicitly static and render without inventing IDs', () => {
    const html = renderRecordCardHtml(model({ guid: null, value: 'guid.create()', attributes: [], links: [], usages: { symbol: [], literal: [], text: [] } }), nonce);
    assert.ok(html.includes('GUID не определён статически'));
    assert.ok(html.includes('guid.create()'));
    assert.ok(!html.includes('class="guid"'));
    assert.ok(!html.includes('data-action="openSource"'));
    assert.ok(html.includes('Атрибуты не объявлены'));
    assert.doesNotThrow(() => renderRecordCardHtml({}, nonce));
});

test('hover is compact, source-based and keeps source metadata separate from generated actions', () => {
    const hover = renderRecordHover(model({ warnings: ['Повтор GUID в исторической миграции'] }));
    assert.ok(hover.includes('**records · Admin**'));
    assert.ok(hover.includes(guid));
    assert.ok(hover.includes('**Название:** Администратор'));
    assert.ok(hover.includes('**Объявленные атрибуты**'));
    assert.ok(hover.includes('Roles.Admin'));
    assert.ok(hover.includes('Roles\\.bl:21:5'));
    assert.ok(hover.includes('**Предупреждение:**'));
    assert.ok(hover.includes('не фактические runtime-права'));
    assert.ok(!hover.includes('BL: Карточка записи records'), 'no fake clickable command hint');
    assert.ok(!/\]\(command:|<a\b/.test(hover));
});

test('hover escapes Markdown/HTML labels and safely delimits arbitrary attribute expressions', () => {
    const malicious = '[click](command:evil) <script>bad</script> **bad**';
    const expression = '` `` ``` [run](command:evil) <script>bad</script>';
    const hover = renderRecordHover(model({
        name: malicious, owner: malicious, label: malicious, scopeLabel: malicious,
        attributes: [{ name: expression, value: expression }], warnings: [malicious]
    }));
    assert.ok(hover.includes('` ' + malicious + ' `'), 'owner remains a literal code span, not a clickable source-controlled link');
    assert.ok(hover.includes('\\[click\\]\\(command:evil\\) \\<script\\>bad\\</script\\> \\*\\*bad\\*\\*'));
    assert.ok(hover.includes(`\`\`\`\` ${expression} \`\`\`\``), 'backtick runs cannot close the code span');
    assert.equal(hover.split(malicious).length - 1, 1, 'the only raw owner label is safely delimited as literal code');
});

test('hover limits attribute previews and warnings; computed IDs keep their source expression', () => {
    const hover = renderRecordHover(model({
        guid: null, value: 'guid.create()',
        attributes: Array.from({ length: 6 }, (_, i) => ({ name: `field${i}`, value: 'x'.repeat(150) })),
        warnings: ['One', 'Two', 'Three']
    }));
    assert.ok(hover.includes('guid.create()'));
    assert.ok(hover.includes('GUID не определён статически'));
    assert.ok(hover.includes('Ещё 2; полный список'));
    assert.ok(!hover.includes('field4') && !hover.includes('field5'));
    assert.ok(!hover.includes('x'.repeat(121)));
    assert.ok(hover.includes('…'));
    assert.ok(hover.includes('Ещё предупреждений: 1'));
    assert.ok(!hover.includes('Three'));
    assert.doesNotThrow(() => renderRecordHover({}));
});

test('usages button immediately reveals loading, focuses visible results and ignores repeat clicks', () => {
    const ui = runScript(renderRecordCardHtml(model(), nonce));
    ui.press({ action: 'findUsages' });
    assert.equal(ui.element('details-panel').hidden, true);
    assert.equal(ui.element('usages-panel').hidden, false);
    assert.equal(ui.element('usages-panel').attrs['aria-busy'], 'true');
    assert.equal(ui.element('usages-results').hidden, true);
    assert.equal(ui.element('find-usages').disabled, true);
    assert.equal(ui.element('find-usages').textContent, 'Поиск…');
    assert.ok(ui.element('search-status').textContent.includes('Ищем использования'));
    assert.equal(ui.element('usages-heading').focuses, 1);
    assert.equal(ui.element('usages-heading').scrolls, 1);
    ui.press({ action: 'findUsages' });
    assert.deepEqual(ui.messages, [{ type: 'findUsages' }]);
});

test('tabs support keyboard navigation, ARIA selection and no implicit usage search', () => {
    const ui = runScript(renderRecordCardHtml(model(), nonce, { view: 'usages', focusUsages: true }));
    assert.deepEqual(ui.messages, []);
    assert.equal(ui.element('usages-heading').focuses, 1);
    let prevented = 0;
    const key = (id, key) => ui.handlers.keydown({ target: { id }, key, preventDefault() { prevented++; } });
    key('usages-tab', 'Home');
    assert.equal(ui.element('details-panel').hidden, false);
    assert.equal(ui.element('details-tab').attrs['aria-selected'], 'true');
    assert.equal(ui.element('usages-tab').tabIndex, -1);
    key('details-tab', 'ArrowRight'); key('usages-tab', 'ArrowLeft'); key('details-tab', 'End');
    assert.equal(prevented, 4);
    assert.equal(ui.element('usages-tab').focuses, 2);
    ui.press({ action: 'viewDetails' }); ui.press({ action: 'viewUsages' });
    assert.ok(ui.messages.every(m => m.type === 'setView' && ['details', 'usages'].includes(m.view)));
    key('elsewhere', 'ArrowRight'); key('details-tab', 'Enter');
    assert.equal(prevented, 4);
});

test('renderer distinguishes empty, partial, cancelled, stale and escaped error states with native theme/ARIA', () => {
    const empty = { symbol: [], literal: [], text: [] };
    const ready = renderRecordCardHtml(model({ usages: empty }), nonce, { view: 'usages', searchState: 'ready' });
    assert.ok(ready.includes('Поиск завершён. BL-ссылки: 0 · GUID в коде: 0 · Текст: 0'));
    assert.ok(ready.includes('Подтверждённых ссылок не найдено'));
    assert.ok(ready.includes('role="status" aria-live="polite"'));
    assert.doesNotMatch(ready, /id="find-usages"[^>]* disabled/);
    const partial = renderRecordCardHtml(model({ usages: { ...empty, partial: '2 файла недоступны' } }), nonce, { searchState: 'partial' });
    assert.ok(partial.includes('Поиск неполный') && partial.includes('2 файла недоступны'));
    for (const [state, text] of [['cancelled', 'Поиск отменён'], ['stale', 'Исходники изменились во время поиска'], ['error', 'Поиск не выполнен']]) {
        const html = renderRecordCardHtml(model(), nonce, { searchState: state, searchMessage: '<img src=x> & error' });
        assert.ok(html.includes(text)); assert.ok(!html.includes('<img'));
        if (state === 'error') assert.ok(html.includes('&lt;img src=x&gt; &amp; error'));
    }
    const constant = renderRecordCardHtml(model({ kind: 'constant' }), nonce);
    assert.ok(constant.includes('GUID · статическая константа'));
    assert.ok(constant.includes('не является декларацией records'));
});
