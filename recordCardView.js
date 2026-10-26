// The card is an offline, read-only projection of source metadata. Coordinates
// in the model are zero-based; only validated link IDs cross the webview boundary.

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function sourceLabel(source) {
    if (!source || typeof source.filePath !== 'string' || !source.filePath) return 'Источник не указан';
    const line = Number.isSafeInteger(source.line) && source.line >= 0 ? source.line + 1 : null;
    const column = Number.isSafeInteger(source.column) && source.column >= 0 ? source.column + 1 : null;
    return `${source.filePath}${line === null ? '' : `:${line}${column === null ? '' : `:${column}`}`}`;
}

function sameSource(left, right) {
    return !!left && !!right && left.filePath === right.filePath
        && left.line === right.line && left.column === right.column;
}

function validLinks(model) {
    const links = Array.isArray(model.links) ? model.links : [];
    return new Map(links.flatMap((link, index) => {
        if (!link || !Number.isSafeInteger(link.id) || link.id !== index
            || typeof link.filePath !== 'string' || !link.filePath
            || !Number.isSafeInteger(link.line) || link.line < 0
            || !Number.isSafeInteger(link.column) || link.column < 0) return [];
        return [[link.id, link]];
    }));
}

function sourceButton(source, link, label, visibleIds) {
    const caption = escapeHtml(label || sourceLabel(source));
    if (link && visibleIds) visibleIds.add(link.id);
    return link
        ? `<button type="button" class="source-link" data-action="openSource" data-link="${link.id}">${caption}</button>`
        : `<span class="source-label">${caption}</span>`;
}

function renderUsageGroup(title, explanation, entries, links, emptyLabel, visibleIds) {
    const items = Array.isArray(entries) ? entries : [];
    const rendered = items.map(entry => {
        const source = entry || {};
        const candidate = links.get(source.id);
        const link = candidate && sameSource(candidate, source) ? candidate : null;
        const caption = source.label || sourceLabel(source);
        return `<li>${sourceButton(source, link, caption, visibleIds)}${source.label
            ? `<div class="file-context">${escapeHtml(sourceLabel(source))}</div>` : ''}</li>`;
    }).join('');
    return `<section class="usage-group">
        <h3>${escapeHtml(title)} <span class="count">${items.length}</span></h3>
        <p class="hint">${escapeHtml(explanation)}</p>
        ${items.length ? `<ul class="source-list">${rendered}</ul>` : `<p class="empty">${escapeHtml(emptyLabel)}</p>`}
    </section>`;
}

function renderDeclarationList(entries, links, visibleIds, includeGuid) {
    return `<ul class="source-list">${entries.map(entry => {
        entry = entry || {};
        const link = links.get(entry.sourceId);
        const label = entry.label || (link && link.label);
        return `<li>${sourceButton(link, link, label, visibleIds)}${entry.ambiguous ? '<p class="hint">Кандидат неоднозначной связи</p>' : ''}${includeGuid && entry.guid
            ? `<div class="related-guid"><code>${escapeHtml(entry.guid)}</code></div>` : ''}${link
            ? `<div class="file-context">${escapeHtml(sourceLabel(link))}</div>` : ''}</li>`;
    }).join('')}</ul>`;
}

function renderRecordCardHtml(model, nonce, ui = {}) {
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9+/_=-]+$/.test(nonce)) {
        throw new TypeError('Для карточки records требуется безопасный CSP nonce.');
    }
    model = model || {};
    const isConstant = model.kind === 'constant';
    const view = ui.view === 'usages' ? 'usages' : 'details';
    const searchState = ['loading', 'ready', 'partial', 'error', 'stale', 'cancelled'].includes(ui.searchState) ? ui.searchState : 'idle';
    const counts = ['symbol', 'literal', 'text'].map(group => model.usages && Array.isArray(model.usages[group]) ? model.usages[group].length : 0);
    const summary = `BL-ссылки: ${counts[0]} · GUID в коде: ${counts[1]} · Текст: ${counts[2]}`;
    const status = searchState === 'loading' ? 'Ищем использования в локальных исходниках…'
        : searchState === 'error' ? `Поиск не выполнен. ${ui.searchMessage || 'Попробуйте ещё раз.'}`
            : searchState === 'stale' ? 'Исходники изменились во время поиска. Запустите поиск ещё раз: старые результаты не показаны.'
                : searchState === 'cancelled' ? 'Поиск отменён. Можно запустить его снова.'
                    : model.usages ? `${model.usages.partial ? 'Поиск неполный. ' : 'Поиск завершён. '}${summary}` : 'Поиск ещё не запущен.';
    const links = validLinks(model);
    const visibleIds = new Set();
    const source = model.source || {};
    const declarationCandidate = links.get(model.sourceId);
    const declarationLink = sameSource(declarationCandidate, source) ? declarationCandidate : null;
    const ownerLink = links.get(model.ownerSourceId);
    const attributes = Array.isArray(model.attributes) ? model.attributes : [];
    const warnings = Array.isArray(model.warnings) ? model.warnings : [];
    const related = Array.isArray(model.related) ? model.related : [];
    const otherDeclarations = Array.isArray(model.otherDeclarations) ? model.otherDeclarations : [];
    const warningSources = Array.isArray(model.warningSourceIds)
        ? [...new Set(model.warningSourceIds)].filter(id => links.has(id)).map(sourceId => ({ sourceId })) : [];
    const hasGuid = typeof model.guid === 'string' && model.guid.length > 0;
    const attributesHtml = attributes.map(attribute => {
        attribute = attribute || {};
        const attributeSource = { filePath: source.filePath, line: attribute.line, column: attribute.column };
        const attributeCandidate = links.get(attribute.sourceId);
        const attributeLink = sameSource(attributeCandidate, attributeSource) ? attributeCandidate : null;
        const location = Number.isSafeInteger(attribute.line) && attribute.line >= 0
            ? sourceButton(attributeSource, attributeLink, `Строка ${attribute.line + 1}`, visibleIds) : '';
        return `<tr><th scope="row"><code>${escapeHtml(attribute.name)}</code></th>
            <td><code class="expression">${escapeHtml(attribute.value)}</code>${location ? `<div class="attribute-location">${location}</div>` : ''}</td></tr>`;
    }).join('');
    const usagesHtml = !model.usages
        ? '<p class="empty">Использования ещё не запрошены. Нажмите «Найти использования»: поиск выполняется по локальным исходникам.</p>'
        : `${model.usages.partial ? `<p class="partial">Поиск ограничен: ${escapeHtml(model.usages.partial)}</p>` : ''}
            ${renderUsageGroup('BL-символы', 'BL-ссылки, разрешённые к этой декларации.', model.usages.symbol, links, 'Подтверждённых ссылок не найдено.', visibleIds)}
            ${renderUsageGroup('GUID-литералы', 'GUID-литералы и самостоятельные UUID-совпадения в коде. Совпадение значения не доказывает связь с этой записью.', model.usages.literal, links, 'Совпадений не найдено.', visibleIds)}
            ${renderUsageGroup('Текстовые совпадения', 'Комментарии и произвольные строки. Это не семантические ссылки.', model.usages.text, links, 'Совпадений не найдено.', visibleIds)}`;

    return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; connect-src 'none'; img-src 'none'">
    <title>${isConstant ? 'GUID-константа' : 'records'} · ${escapeHtml(model.name)}</title>
    <style nonce="${nonce}">
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.55; }
        main { max-width: 1040px; margin: 0 auto; padding: 28px 32px 40px; }
        .eyebrow { margin: 0 0 8px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
        .header { display: flex; flex-wrap: wrap; gap: 16px; justify-content: space-between; align-items: flex-start; }
        h1 { margin: 0; font-size: 25px; line-height: 1.3; overflow-wrap: anywhere; }
        .owner { margin: 6px 0 0; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
        .record-label { margin: 8px 0 0; }
        .localization-key { margin: 4px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
        .toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
        button { font: inherit; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; }
        .toolbar button { padding: 5px 11px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
        .toolbar .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .toolbar .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        button:disabled { cursor: default; opacity: .65; }
        [hidden] { display: none !important; }
        .tabs { display: flex; gap: 6px; margin: 22px 0 0; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
        .tab { padding: 9px 14px; background: transparent; color: var(--vscode-descriptionForeground); border: 0; border-bottom: 2px solid transparent; border-radius: 0; }
        .tab[aria-selected="true"] { color: var(--vscode-editor-foreground); border-bottom-color: var(--vscode-focusBorder); }
        .search-status { margin: 14px 0; padding: 10px 14px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-focusBorder); }
        button:focus-visible, [tabindex]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }
        code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
        .identity { margin: 22px 0; padding: 16px 18px; border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 6px; background: var(--vscode-sideBar-background); }
        .field-label { margin: 0 0 5px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
        .guid { display: block; font-size: 17px; font-weight: 500; user-select: text; overflow-wrap: anywhere; }
        .unknown-guid { color: var(--vscode-descriptionForeground); }
        .expression-label { margin-top: 14px; }
        .expression { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
        .hint, .empty { color: var(--vscode-descriptionForeground); }
        .hint { margin: 5px 0 12px; font-size: 12px; }
        .empty { margin: 10px 0; }
        h2 { margin: 0 0 10px; font-size: 16px; }
        h3 { margin: 0; font-size: 13px; }
        .section { margin: 24px 0; }
        .source-link { padding: 0; background: transparent; color: var(--vscode-textLink-foreground); border: 0; text-align: left; line-height: inherit; overflow-wrap: anywhere; }
        .source-link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
        .source-label, .file-context { overflow-wrap: anywhere; }
        .file-context { margin-top: 2px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
        .owner-source { margin: 10px 0 0; }
        .related-guid { margin-top: 3px; overflow-wrap: anywhere; }
        .scope { margin: 8px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; overflow-wrap: anywhere; }
        .table-wrap { overflow-x: auto; border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 5px; }
        table { border-collapse: collapse; width: 100%; text-align: left; }
        th, td { padding: 10px 14px; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
        thead th { background: var(--vscode-sideBar-background); color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 500; }
        tbody th { width: 28%; font-weight: 400; overflow-wrap: anywhere; }
        tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
        .attribute-location { margin-top: 4px; font-size: 11px; }
        .warnings, .partial { border-left: 3px solid var(--vscode-editorWarning-foreground); padding: 9px 14px; background: var(--vscode-textBlockQuote-background); }
        .warnings h2 { font-size: 13px; margin-bottom: 5px; }
        .warnings ul { margin: 0; padding-left: 18px; overflow-wrap: anywhere; }
        .source-list { list-style: none; padding: 0; margin: 0; }
        .source-list li { padding: 9px 0; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
        .source-list li:last-child { border-bottom: 0; }
        .usage-group { margin-top: 18px; }
        .count { display: inline-block; margin-left: 5px; padding: 0 6px; border-radius: 10px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; }
        .disclaimer { margin-top: 26px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); color: var(--vscode-descriptionForeground); font-size: 12px; }
        @media (max-width: 600px) { main { padding: 20px 16px 30px; } h1 { font-size: 21px; } .guid { font-size: 14px; } th, td { padding: 9px 10px; } }
    </style>
</head>
<body>
<main>
    <p class="eyebrow">${isConstant ? 'GUID · статическая константа' : 'records · статическая запись'}</p>
    <header class="header">
        <div><h1>${escapeHtml(model.name)}</h1><p class="owner">${escapeHtml(model.owner)}</p>${model.label ? `<p class="record-label">${escapeHtml(model.label)}</p>${model.localizationKey
            ? `<p class="localization-key">Ключ локализации: <code>${escapeHtml(model.localizationKey)}</code></p>` : ''}` : ''}</div>
        <div class="toolbar"><button id="find-usages" type="button" data-action="findUsages"${searchState === 'loading' ? ' disabled' : ''}>${searchState === 'loading' ? 'Поиск…' : model.usages ? 'Повторить поиск' : 'Найти использования'}</button><button id="refresh-card" type="button" class="secondary" data-action="refresh"${searchState === 'loading' ? ' disabled' : ''}>Обновить</button></div>
    </header>
    <nav class="tabs" role="tablist" aria-label="Декларация GUID">
        <button class="tab" type="button" id="details-tab" role="tab" aria-controls="details-panel" aria-selected="${view === 'details'}" tabindex="${view === 'details' ? 0 : -1}" data-action="viewDetails">Карточка</button>
        <button class="tab" type="button" id="usages-tab" role="tab" aria-controls="usages-panel" aria-selected="${view === 'usages'}" tabindex="${view === 'usages' ? 0 : -1}" data-action="viewUsages">Использования${model.usages ? ` <span class="count">${counts.reduce((sum, count) => sum + count, 0)}</span>` : ''}</button>
    </nav>
    <div id="details-panel" role="tabpanel" aria-labelledby="details-tab"${view === 'usages' ? ' hidden' : ''}>
    <section class="identity" aria-label="Идентификатор записи">
        <p class="field-label">GUID</p>
        ${hasGuid ? `<code class="guid" tabindex="0">${escapeHtml(model.guid)}</code><p class="hint">Значение можно выделить и скопировать.</p>`
            : '<p class="unknown-guid">GUID не определён статически; ID может вычисляться выражением.</p>'}
        <p class="field-label expression-label">Объявленное выражение</p><code class="expression">${escapeHtml(model.value)}</code>
    </section>
    ${warnings.length ? `<section class="warnings" aria-label="Предупреждения"><h2>Обратите внимание</h2><ul>${warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>${warningSources.length
        ? `<p class="hint">Декларации для проверки:</p>${renderDeclarationList(warningSources, links, visibleIds, false)}` : ''}</section>` : ''}
    <section class="section" id="source"><h2>Источник</h2>${sourceButton(source, declarationLink, sourceLabel(source), visibleIds)}<p class="owner-source">Класс-владелец: ${sourceButton(ownerLink, ownerLink, model.owner, visibleIds)}</p>${ownerLink
        ? `<div class="file-context">${escapeHtml(sourceLabel(ownerLink))}</div>` : ''}<p class="scope">Контекст поиска: ${escapeHtml(model.scopeLabel || 'не указан')}</p></section>
    <section class="section" id="attributes"><h2>Объявленные атрибуты</h2>${attributes.length
        ? `<div class="table-wrap"><table><thead><tr><th scope="col">Атрибут</th><th scope="col">Выражение из исходника</th></tr></thead><tbody>${attributesHtml}</tbody></table></div>`
        : '<p class="empty">Атрибуты не объявлены.</p>'}</section>
    <section class="section" id="related"><h2>Связанные записи</h2>${related.length
        ? renderDeclarationList(related, links, visibleIds, true)
        : '<p class="empty">Подтверждённых связей в локальных исходниках нет.</p>'}</section>
    ${otherDeclarations.length ? `<section class="section" id="other-declarations"><h2>Другие декларации того же GUID</h2><p class="hint">Повтор GUID сам по себе не доказывает конфликт: это может быть миграция, наследник или другая копия проекта.</p>${renderDeclarationList(otherDeclarations, links, visibleIds, false)}</section>` : ''}
    </div>
    <section class="section" id="usages-panel" role="tabpanel" aria-labelledby="usages-tab" aria-busy="${searchState === 'loading'}"${view === 'details' ? ' hidden' : ''}>
        <h2 id="usages-heading" tabindex="-1">Использования</h2>
        <p id="search-status" class="search-status" role="status" aria-live="polite">${escapeHtml(status)}</p>
        <div id="usages-results"${searchState === 'loading' ? ' hidden' : ''}>${usagesHtml}</div>
    </section>
    <footer class="disclaimer">Данные получены из локальных исходников. ${isConstant ? 'GUID-константа не является декларацией records и не доказывает наличие записи в БД.' : 'Связи role/object — статические декларации, а не фактические права текущего пользователя.'} Карточка не отражает содержимое runtime-БД и не выполняет запросы к серверу.</footer>
</main>
<script nonce="${nonce}">
    (function () {
        const vscode = acquireVsCodeApi();
        const sourceIds = new Set([${[...visibleIds].sort((a, b) => a - b).join(',')}]);
        function setView(view, focus) {
            ['details', 'usages'].forEach(function (name) {
                const panel = document.getElementById(name + '-panel');
                const tab = document.getElementById(name + '-tab');
                panel.hidden = name !== view;
                tab.setAttribute('aria-selected', String(name === view));
                tab.tabIndex = name === view ? 0 : -1;
            });
            if (focus && view === 'usages') {
                const heading = document.getElementById('usages-heading');
                heading.focus();
                heading.scrollIntoView({ block: 'nearest' });
            }
        }
        function loading() {
            setView('usages', true);
            const button = document.getElementById('find-usages');
            button.disabled = true;
            button.textContent = 'Поиск…';
            document.getElementById('refresh-card').disabled = true;
            document.getElementById('usages-panel').setAttribute('aria-busy', 'true');
            document.getElementById('search-status').textContent = 'Ищем использования в локальных исходниках…';
            document.getElementById('usages-results').hidden = true;
        }
        document.addEventListener('click', function (event) {
            const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('button[data-action]') : null;
            if (!button) return;
            if (button.dataset.action === 'openSource') {
                const id = Number(button.dataset.link);
                if (/^\\d+$/.test(button.dataset.link) && Number.isSafeInteger(id) && sourceIds.has(id)) vscode.postMessage({ type: 'openSource', id: id });
            } else if (button.dataset.action === 'refresh') {
                if (document.getElementById('refresh-card').disabled) return;
                vscode.postMessage({ type: 'refresh' });
            } else if (button.dataset.action === 'findUsages') {
                if (document.getElementById('find-usages').disabled) return;
                loading();
                vscode.postMessage({ type: 'findUsages' });
            } else if (button.dataset.action === 'viewDetails' || button.dataset.action === 'viewUsages') {
                const view = button.dataset.action === 'viewUsages' ? 'usages' : 'details';
                setView(view, false);
                vscode.postMessage({ type: 'setView', view: view });
            }
        });
        document.addEventListener('keydown', function (event) {
            if (!event.target || !['details-tab', 'usages-tab'].includes(event.target.id) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const view = event.key === 'Home' ? 'details' : event.key === 'End' ? 'usages' : event.target.id === 'details-tab' ? 'usages' : 'details';
            setView(view, false);
            document.getElementById(view + '-tab').focus();
            vscode.postMessage({ type: 'setView', view: view });
        });
        ${ui.focusUsages && view === 'usages' ? "setView('usages', true);" : ''}
    })();
</script>
</body>
</html>`;
}

function escapeMarkdown(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').replace(/[\\`*_{}\[\]()<>#+.!|~]/g, '\\$&');
}

function inlineCode(value, maxLength) {
    let text = String(value == null ? '' : value).replace(/\s+/g, ' ');
    if (maxLength && text.length > maxLength) text = `${text.slice(0, maxLength)}…`;
    const runs = text.match(/`+/g) || [];
    const delimiter = '`'.repeat(Math.max(0, ...runs.map(run => run.length)) + 1);
    return `${delimiter} ${text} ${delimiter}`;
}

function renderRecordHover(model) {
    model = model || {};
    const attributes = Array.isArray(model.attributes) ? model.attributes : [];
    const warnings = Array.isArray(model.warnings) ? model.warnings : [];
    const lines = [
        `**${model.kind === 'constant' ? 'GUID-константа' : 'records'} · ${escapeMarkdown(model.name)}**`,
        '',
        inlineCode(model.owner),
        '',
        model.guid ? `**GUID:** ${inlineCode(model.guid)}` : `**ID:** ${inlineCode(model.value, 120)} — GUID не определён статически.`
    ];
    if (model.label) lines.push(`**Название:** ${escapeMarkdown(model.label)}`);
    if (model.label && model.localizationKey) lines.push(`**Ключ локализации:** ${inlineCode(model.localizationKey, 120)}`);
    if (attributes.length) {
        lines.push('', '**Объявленные атрибуты**');
        for (const attribute of attributes.slice(0, 4)) {
            if (attribute) lines.push(`- ${inlineCode(attribute.name)}: ${inlineCode(attribute.value, 120)}`);
        }
        if (attributes.length > 4) lines.push(`- Ещё ${attributes.length - 4}; полный список — в карточке.`);
    }
    lines.push('', `**Источник:** ${escapeMarkdown(model.sourceLabel || sourceLabel(model.source))}`);
    for (const warning of warnings.slice(0, 2)) lines.push('', `**Предупреждение:** ${escapeMarkdown(warning)}`);
    if (warnings.length > 2) lines.push(`Ещё предупреждений: ${warnings.length - 2}; см. карточку.`);
    lines.push('', model.kind === 'constant' ? 'Статическая GUID-константа, не records и не runtime-данные.' : 'Статическая декларация; не фактические runtime-права.');
    return lines.join('\n');
}

module.exports = { renderRecordCardHtml, renderRecordHover };
