function client() {
    const vscode = acquireVsCodeApi();
    let session = '', sequence = 0, state = null, generation = -1;
    const $ = id => document.getElementById(id), fields = new Map();
    const send = (type, extra = {}) => { sequence++; vscode.postMessage({ type, session, sequence, ...extra }); };
    const element = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
    const statuses = { missing: 'Нет перевода', conflict: 'Разные переводы в ресурсах', unavailable: 'Ресурс недоступен' };
    const languages = { ru: 'Русский', en: 'English', uz: 'O‘zbek' };
    let previewSignature = '', aiGeneration = -1, aiActive = false, aiPhase = '';
    const targets = new Map();
    const fit = textarea => { textarea.style.height = 'auto'; textarea.style.height = Math.min(180, Math.max(34, textarea.scrollHeight)) + 'px'; };
    function updateComparison(field) {
        if (!field.proposalCurrent) return;
        const text = field.textarea.value;
        field.proposalCurrent.textContent = text === '' ? '(пустое значение)' : text;
        const value = field.proposalText.textContent;
        field.proposalComparison.className = 'proposal-comparison' + (text.length > 160 || value.length > 160 || /[\r\n]/.test(text + value) ? ' stacked' : '');
    }
    function focusFirstField() {
        const field = [...fields.values()].find(item => !item.textarea.hidden && !item.textarea.disabled);
        if (field) field.textarea.focus();
    }
    const source = (row, option, caption = option.label) => {
        const button = element('button', caption, 'source'); button.type = 'button'; button.title = option.label;
        button.addEventListener('click', () => send('openSource', { row: row.id, option: option.id })); return button;
    };
    function buildRows(rows, append = false) {
        if (!append) { fields.clear(); $('rows').replaceChildren(); }
        for (const row of rows) {
            if (append && fields.has(row.id)) continue;
            const section = element('section', undefined, 'translation-row');
            const language = element('div', undefined, 'language');
            const label = element('label', languages[row.locale] || row.locale); label.htmlFor = 'value-' + row.id; language.append(label);
            label.title = row.locale;
            if (row.locale === state.locale) {
                const current = element('span', ' ·', 'current-locale'); current.title = 'Язык просмотра';
                current.setAttribute('aria-label', 'Язык просмотра'); language.append(current);
            }
            const field = element('div', undefined, 'field');
            const aiBadge = element('span', 'ИИ · проверьте перевод', 'muted'); aiBadge.id = 'ai-badge-' + row.id;
            const proposal = element('div', undefined, 'proposal'); proposal.id = 'proposal-' + row.id;
            const badge = element('div', '', 'badge'); badge.id = 'warning-' + row.id;
            const textarea = element('textarea'); textarea.id = label.htmlFor; textarea.rows = 1; textarea.value = row.value;
            textarea.spellcheck = true; textarea.maxLength = 65536; textarea.setAttribute('aria-describedby', 'warning-' + row.id + ' help-' + row.id);
            const help = element('p', '', 'muted'); help.id = 'help-' + row.id;
            const emptyResource = element('p', '', 'muted'); emptyResource.id = 'no-resource-' + row.id;
            const directSource = element('div', undefined, 'sources'); directSource.id = 'direct-source-' + row.id;
            const recovery = element('button', 'Обновить ресурсы', 'source'); recovery.type = 'button'; recovery.id = 'recover-' + row.id;
            recovery.addEventListener('click', () => send('reload'));
            const details = element('details', undefined, 'source-details'); details.id = 'source-' + row.id;
            details.append(element('summary', 'Источник'));
            const select = element('select'); select.id = 'target-' + row.id; select.setAttribute('aria-label', 'Целевой ресурс для ' + row.locale);
            const empty = element('option', 'Выберите целевой ресурс'); empty.value = ''; select.append(empty);
            for (const option of row.options) { const item = element('option', option.label); item.value = String(option.id); select.append(item); }
            select.value = row.target === null ? '' : String(row.target);
            const links = element('div', undefined, 'sources');
            let touched = row.edited;
            const publish = () => {
                $('status').textContent = 'Сохраняем черновик…'; $('preview').disabled = true;
                send('edit', { row: row.id, value: textarea.value, target: select.value === '' ? null : Number(select.value) });
                drawProposalSelection();
            };
            textarea.addEventListener('input', () => { touched = true; fit(textarea); updateComparison(fields.get(row.id)); publish(); });
            select.addEventListener('change', () => {
                const option = row.options.find(o => String(o.id) === select.value);
                if (!touched && option && option.value !== null) textarea.value = option.value;
                fit(textarea); updateComparison(fields.get(row.id));
                publish();
            });
            details.append(select, links); field.append(textarea, emptyResource, aiBadge, badge, help, recovery, directSource, details, proposal); section.append(language, field); $('rows').append(section);
            fields.set(row.id, { textarea, select, help, links, badge, details, emptyResource, directSource, recovery, needsSource: undefined, linkTarget: undefined, aiBadge, proposal, proposalValue: undefined, row, touch: () => { touched = true; } });
        }
    }
    function draw(model) {
        const previousPreview = state && !!state.preview;
        state = model; session = model.session;
        $('view-caption').textContent = model.ai && (model.ai.open || model.ai.running) ? 'Перевод с ИИ' : 'Переводы';
        $('key').textContent = model.key; $('scope').textContent = model.root;
        const sets = model.resourceSets || [];
        const availableLocales = [...new Set(sets.flatMap(set => set.locales))].map(locale => locale.toUpperCase()).join(', ');
        $('resource-summary').textContent = sets.length === 1 ? `Ресурсы: ${sets[0].label} · ${availableLocales}`
            : sets.length ? `Наборов ресурсов: ${sets.length} · ${availableLocales}` : 'Набор ресурсов не определён';
        $('resource-paths').textContent = sets.map(set => `${set.path} · ${set.locales.map(locale => locale.toUpperCase()).join(', ')}\n${(set.files || []).join('\n')}`).join('\n');
        $('resource-paths').hidden = !sets.length;
        $('error-reload').hidden = !model.error || model.errorRecovery !== 'reload';
        $('error-reload').disabled = model.busy;
        $('status').textContent = model.notice; $('error').textContent = model.error || ''; $('error').hidden = !model.error;
        $('count').textContent = `${model.rows.length} языков · ${model.rows.filter(r => r.edited).length} изменено`;
        $('edit').hidden = !!model.preview; $('review').hidden = !model.preview;
        if (generation !== model.generation) { generation = model.generation; buildRows(model.rows); }
        else if (fields.size !== model.rows.length) buildRows(model.rows, true);
        for (const row of model.rows) {
            const field = fields.get(row.id);
            if ((document.activeElement !== field.textarea || row.ai) && field.textarea.value !== row.value) field.textarea.value = row.value;
            const optionsSignature = JSON.stringify(row.options.map(option => [option.id, option.label]));
            if (field.optionsSignature !== optionsSignature) {
                field.optionsSignature = optionsSignature;
                const empty = element('option', 'Выберите целевой ресурс'); empty.value = '';
                field.select.replaceChildren(empty);
                for (const option of row.options) { const item = element('option', option.label); item.value = String(option.id); field.select.append(item); }
                field.linkTarget = undefined;
            }
            field.select.value = row.target === null ? '' : String(row.target);
            field.textarea.disabled = model.busy || row.status === 'unavailable'; field.select.disabled = model.busy || !row.options.length || row.status === 'unavailable';
            field.textarea.readOnly = !row.options.length;
            const noFile = !row.options.length && row.status !== 'unavailable';
            const copyable = noFile && (row.edited || row.value !== '');
            field.textarea.hidden = noFile && !copyable;
            field.emptyResource.hidden = !noFile;
            field.emptyResource.textContent = row.resourceHelp || 'Нет файла этого языка в наборе ключа.';
            field.recovery.hidden = !row.stale && row.status !== 'unavailable'; field.recovery.disabled = model.busy;
            if (copyable) field.emptyResource.textContent += ' Черновик сохранён для копирования.';
            field.row = row; if (row.edited) field.touch();
            field.aiBadge.hidden = !row.ai;
            const suggestion = model.ai && model.ai.proposals.find(p => p.row === row.id);
            field.proposal.hidden = !suggestion;
            if (suggestion && !field.choice) {
                const choice = element('input'); choice.type = 'checkbox'; choice.id = 'proposal-choice-' + row.id;
                const label = element('label'); label.htmlFor = choice.id;
                label.append(choice, element('span', 'Принять перевод · ' + (languages[row.locale] || row.locale)));
                const reason = element('p', '', 'badge'); reason.id = 'proposal-reason-' + row.id;
                choice.setAttribute('aria-describedby', reason.id);
                const comparison = element('div', undefined, 'proposal-comparison');
                const current = element('pre'); current.id = 'proposal-current-' + row.id;
                const value = element('pre'); value.id = 'proposal-value-' + row.id;
                for (const [caption, content] of [['Сейчас', current], ['Предложение ИИ', value]]) {
                    const column = element('div'); column.append(element('p', caption, 'muted'), content); comparison.append(column);
                }
                choice.addEventListener('change', drawProposalSelection);
                field.proposalComparison = comparison; field.proposalCurrent = current; field.choice = choice; field.proposalText = value; field.proposalReason = reason;
                field.proposal.replaceChildren(label, comparison, reason);
            }
            if (suggestion) {
                if (field.proposalToken !== suggestion.token) { field.proposalToken = suggestion.token; field.choice.checked = true; }
                field.proposalText.textContent = suggestion.value;
                updateComparison(field);
                field.proposalReason.textContent = suggestion.reason || (row.stale ? 'Источник изменился. Обновите ресурсы.' : row.status === 'unavailable' ? 'Ресурс недоступен.' : '');
                field.proposalReason.hidden = !field.proposalReason.textContent;
            }
            fit(field.textarea);
            field.textarea.placeholder = row.status === 'missing' ? 'Введите перевод' : row.value === '' ? 'Пустой перевод' : '';
            field.badge.textContent = row.stale ? 'Источник изменился' : statuses[row.status] || '';
            field.badge.hidden = !field.badge.textContent || noFile && !row.stale;
            field.help.textContent = row.stale ? 'Скопируйте текст и обновите ресурсы в «Подробностях».' : row.status === 'unavailable'
                ? 'Исправьте недоступный NLS и обновите ресурсы.' : !row.options.length
                ? row.resourceHelp || 'Нет NLS-файла этого языка в наборе ключа. ИИ-перевод недоступен.' : row.target === null
                    ? 'Выберите ресурс для изменения.' : row.status === 'missing' ? 'Ключ будет добавлен в существующий файл при применении.' : '';
            field.help.hidden = !field.help.textContent || noFile;
            field.details.hidden = !row.options.length || row.options.length === 1 && row.target !== null;
            field.select.hidden = field.details.hidden;
            field.directSource.hidden = !row.options.length || !field.details.hidden;
            const needsSource = row.target === null && row.options.length > 0;
            if (needsSource && !field.needsSource) field.details.open = true;
            field.needsSource = needsSource;
            if (field.linkTarget !== row.target) {
                field.linkTarget = row.target;
                field.links.replaceChildren(); field.directSource.replaceChildren();
                const selected = row.options.find(option => option.id === row.target);
                if (selected) field.directSource.append(source(row, selected, 'Открыть файл'));
                for (const option of row.options.filter(o => o.value !== null || o.id === row.target)) field.links.append(source(row, option));
            }
        }
        drawAi(model);
        drawProposalSelection();
        $('preview').hidden = !!model.preview || aiActive; $('apply').hidden = !model.preview; $('back').hidden = !model.preview;
        $('preview').disabled = aiActive || model.busy || model.saving || !!model.error || !model.rows.some(r => r.edited) || model.rows.some(r => r.edited && (r.target === null || r.stale || r.status === 'unavailable'));
        $('apply').disabled = model.busy; $('back').disabled = model.busy; $('reload').disabled = model.busy; $('discard').disabled = model.busy;
        $('add-language').hidden = !model.canAddLanguage || !!model.preview || aiActive;
        $('add-language').disabled = model.busy || model.saving;
        $('rename-key').hidden = !model.canRename || !!model.preview || aiActive;
        $('rename-key').disabled = model.busy || model.saving || !!model.renameBlocked;
        $('rename-key').title = model.renameBlocked || 'Переименовать точные использования ключа в BL и NLS';
        $('apply').textContent = model.busy ? 'Применяем…' : model.previewKind === 'rename' ? 'Переименовать в файлах' : 'Применить в файлы';
        const isRename = model.previewKind === 'rename';
        $('review-title').textContent = isRename ? 'Переименовать ключ?' : 'Применить переводы?';
        $('rename-scope').hidden = !isRename || !model.preview;
        const signature = JSON.stringify([model.previewKind, model.preview]);
        if (model.preview && signature !== previewSignature) {
            $('review-summary').textContent = isRename
                ? `${model.key} → ${model.renameTo} · Файлов: ${model.preview.length} · Замен: ${model.preview.reduce((sum, change) => sum + change.count, 0)}`
                : 'Файлов: ' + new Set(model.preview.map(change => change.path)).size + ' · Языки: ' + model.preview.map(change => change.locale.toUpperCase()).join(', ');
            $('changes').replaceChildren();
            for (const change of model.preview) {
                const card = element('section', undefined, 'change');
                card.append(element('h3', isRename ? `${change.kind} · Замен: ${change.count}` : change.locale.toUpperCase()), element('p', change.path, 'muted'));
                if (isRename) card.append(element('p', 'Строки: ' + change.lines.join(', '), 'muted'));
                const diff = element('div', undefined, 'diff');
                for (const [caption, value] of [['Было', change.before === null ? '(ключ отсутствует)' : change.before], ['Будет', change.after]]) {
                    const column = element('div'); column.append(element('h4', caption), element('pre', value === '' ? '(пустое значение)' : value)); diff.append(column);
                }
                card.append(diff); $('changes').append(card);
            }
        }
        previewSignature = signature;
        if (previousPreview !== null && previousPreview !== !!model.preview) {
            if (model.preview) $('apply').focus();
            else if (fields.size) focusFirstField();
        }
    }
    function drawProposalSelection() {
        if (!state) return;
        const ai = state.ai || {}, proposals = ai.proposals || [];
        const locked = state.busy || state.saving || ai.open || ai.running || !!state.preview || state.sequence < sequence;
        let available = 0, selected = 0;
        for (const suggestion of proposals) {
            const field = fields.get(suggestion.row);
            if (!field || !field.choice) continue;
            const blocked = !!field.proposalReason.textContent;
            field.choice.disabled = locked || blocked;
            if (blocked) field.choice.checked = false;
            else { available++; if (field.choice.checked) selected++; }
        }
        $('proposal-bar').hidden = !proposals.length || aiActive || !!state.preview;
        $('proposal-all').checked = available > 0 && selected === available;
        $('proposal-all').indeterminate = selected > 0 && selected < available;
        $('proposal-all').disabled = locked || !available;
        $('proposal-count').textContent = `${selected} из ${available}`;
        $('proposal-accept').textContent = selected && selected === available ? `Принять все (${selected})` : `Принять выбранные (${selected})`;
        $('proposal-accept').disabled = locked || !selected;
        $('proposal-help').textContent = proposals.length > available ? 'Недоступные предложения отмечены ниже. Выбор относится только к этому ключу.' : 'Только в черновик. Файлы не изменятся.';
        const undo = $('proposal-undo');
        const losingUndoFocus = document.activeElement === undo && !ai.undo;
        undo.hidden = !ai.undo || aiActive || !!state.preview; undo.disabled = locked;
        if (document.activeElement === $('proposal-accept') && $('proposal-bar').hidden && !undo.hidden) undo.focus();
        if (losingUndoFocus) {
            if (proposals.length) $('proposal-all').focus();
            else if (fields.size) focusFirstField();
        }
    }
    function drawAi(model) {
        const ai = model.ai || { open: false, running: false, review: null, error: '', proposals: [] };
        const previousPhase = aiPhase;
        aiPhase = ai.running ? 'waiting' : ai.open ? ai.review ? 'review' : 'input' : '';
        const wasActive = aiActive; aiActive = ai.open || ai.running;
        $('details').hidden = aiActive;
        $('ai').hidden = !aiActive; $('ai-open').hidden = !!model.preview || aiActive;
        $('ai-form').hidden = ai.running || !!ai.review; $('ai-review').hidden = !ai.review || ai.running;
        const recovery = ai.recovery;
        $('ai-recover').hidden = !ai.error || !recovery || ai.running;
        $('ai-recover').textContent = recovery && recovery.type === 'key' ? 'Задать API-ключ' : recovery && recovery.type === 'reload' ? 'Обновить ресурсы' : 'Открыть настройки';
        $('ai-recover').disabled = model.busy;
        $('ai-wait').hidden = !ai.running; $('ai-error').hidden = !ai.error; $('ai-error').textContent = ai.error;
        $('ai-prepare').hidden = !aiActive || ai.running || !!ai.review;
        $('ai-send').hidden = !aiActive || ai.running || !ai.review;
        $('ai-back').hidden = !aiActive || ai.running;
        $('ai-back').textContent = ai.review ? 'Изменить текст' : 'Назад';
        $('ai-cancel').hidden = !ai.running;
        $('ai-prepare').disabled = model.busy || ai.running || !$('ai-text').value.trim() || ![...targets.values()].some(box => box.checked && !box.disabled);
        $('ai-send').disabled = model.busy || ai.running || !ai.review;
        $('ai-open').disabled = model.busy || model.saving;
        if (aiActive && !ai.running) $('edit').hidden = true;
        if (aiActive && (aiGeneration !== model.generation || !wasActive)) {
            aiGeneration = model.generation;
            $('ai-source').replaceChildren(); $('ai-targets').replaceChildren(); targets.clear();
            for (const row of model.rows) {
                const option = element('option', (languages[row.locale] || row.locale) + ' (' + row.locale + ')'); option.value = row.locale; $('ai-source').append(option);
                if (row.status === 'unavailable' || row.stale || !row.options.length) continue;
                const box = element('input'); box.type = 'checkbox'; box.id = 'ai-target-' + row.id; box.value = row.locale;
                box.checked = true;
                const label = element('label'); label.htmlFor = box.id; label.append(box, element('span', languages[row.locale] || row.locale));
                box.container = label; box.addEventListener('change', invalidateAiReview); $('ai-targets').append(label); targets.set(row.locale, box);
            }
            $('ai-source').value = model.locale;
            $('ai-text').value = model.rows.find(row => row.locale === model.locale)?.value || '';
            fit($('ai-text'));
            if (!ai.running) $('ai-text').focus();
        }
        let eligible = 0, selected = 0;
        for (const [locale, box] of targets) {
            const isSource = locale === $('ai-source').value;
            box.container.hidden = isSource;
            box.disabled = ai.running || isSource;
            box.container.className = box.checked ? 'target-choice selected' : 'target-choice';
            if (!isSource) { eligible++; if (box.checked) selected++; }
        }
        $('ai-target-count').textContent = selected + ' из ' + eligible;
        $('ai-target-help').textContent = !eligible ? 'Нет других доступных языков. Добавьте NLS-ресурс нужного языка и обновите переводы.' : !selected ? 'Выберите хотя бы один язык перевода.' : '';
        $('ai-target-help').hidden = !!selected;
        if (aiActive && !model.saving && !model.error) $('status').textContent = ai.running ? 'Ожидаем ответ…' : ai.review ? 'Запрос готов к отправке' : 'Выберите текст и языки';
        if (aiActive && !ai.running && !ai.review) fit($('ai-text'));
        $('ai-text').disabled = ai.running; $('ai-source').disabled = ai.running;
        $('ai-prepare').disabled = model.busy || ai.running || !$('ai-text').value.trim() || ![...targets.values()].some(box => box.checked && !box.disabled);
        if (ai.review) { $('ai-summary').textContent = ai.review.data ? ai.review.data.sourceLocale + ' → ' + ai.review.data.targetLocales.join(', ') + '\n' + ai.review.data.sourceText : ''; $('ai-endpoint').textContent = ai.review.url + ' · ' + ai.review.model; $('ai-payload').textContent = JSON.stringify(ai.review.body, null, 2); }
        if (previousPhase !== aiPhase) {
            if (aiPhase === 'review') $('ai-send').focus();
            else if (aiPhase === 'waiting') $('ai-cancel').focus();
            else if (aiPhase === 'input') $('ai-text').focus();
            else if (wasActive && fields.size && ![...fields.values()].some(field =>
                [field.textarea, field.select, field.choice].includes(document.activeElement))) focusFirstField();
        }
    }
    function invalidateAiReview() {
        if (!state) return;
        fit($('ai-text'));
        if (state.ai && state.ai.review) { $('ai-send').disabled = true; send('aiInvalidate'); }
        drawAi({ ...state, ai: { ...state.ai, review: null } });
    }
    $('ai-text').addEventListener('input', invalidateAiReview);
    $('ai-source').addEventListener('change', invalidateAiReview);
    $('ai-prepare').addEventListener('click', () => {
        $('ai-prepare').disabled = true;
        send('aiPrepare', { text: $('ai-text').value, sourceLocale: $('ai-source').value,
            targets: [...targets].filter(([, box]) => box.checked && !box.disabled).map(([locale]) => locale) });
    });
    $('ai-send').addEventListener('click', () => { $('ai-send').disabled = true; send('aiSend', { token: state.ai.review.token }); });
    for (const [id, type] of [['ai-open', 'aiOpen'], ['ai-cancel', 'aiCancel']]) $(id).addEventListener('click', () => send(type));
    $('ai-back').addEventListener('click', () => send(state.ai && state.ai.review ? 'aiInvalidate' : 'aiClose'));
    $('proposal-all').addEventListener('change', () => {
        for (const suggestion of state.ai.proposals) {
            const field = fields.get(suggestion.row);
            if (!field.choice.disabled) field.choice.checked = $('proposal-all').checked;
        }
        drawProposalSelection();
    });
    $('proposal-accept').addEventListener('click', () => {
        if ($('proposal-accept').disabled) return;
        const items = state.ai.proposals.filter(item => {
            const choice = fields.get(item.row).choice; return choice.checked && !choice.disabled;
        }).map(item => ({ row: item.row, token: item.token, revision: item.revision }));
        send('aiAcceptSelected', { items }); drawProposalSelection();
    });
    $('proposal-undo').addEventListener('click', () => {
        if (!$('proposal-undo').disabled) { send('aiUndoAccept'); drawProposalSelection(); }
    });
    window.addEventListener('message', event => {
        const model = event.data;
        if (!model || model.type !== 'state' || model.sequence < sequence) return;
        draw(model);
    });
    for (const [id, type] of [['preview', 'preview'], ['apply', 'apply'], ['back', 'back'], ['close', 'close'], ['discard', 'discard'], ['reload', 'reload'], ['add-language', 'addLanguage'], ['rename-key', 'rename']]) {
        $(id).addEventListener('click', () => send(type));
    }
    $('error-reload').addEventListener('click', () => send('reload'));
    $('ai-recover').addEventListener('click', () => send(state.ai.recovery.type === 'reload' ? 'reload' : 'aiRecover'));
    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            const button = aiActive ? state.ai && state.ai.review ? $('ai-send') : $('ai-prepare') : state && state.preview ? $('apply') : $('preview');
            if (!button.disabled) { event.preventDefault(); button.click(); }
        }
    });
    vscode.postMessage({ type: 'ready' });
}
function renderI18nView(nonce) {
    return `<!doctype html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root{color-scheme:light dark}body.vscode-light,body.vscode-high-contrast-light{color-scheme:light}body.vscode-dark,body.vscode-high-contrast{color-scheme:dark}*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.5}
main{max-width:640px;margin:auto;padding:20px}header{margin-bottom:18px}h1{font-size:16px;font-weight:600;margin:0;overflow-wrap:anywhere}h2{font-size:16px;margin:0 0 8px}h3,h4{margin:0 0 6px}p{margin:8px 0}#review-summary{overflow-wrap:anywhere}.muted{color:var(--vscode-descriptionForeground);font-size:12px;overflow-wrap:anywhere}.eyebrow{font-size:12px;color:var(--vscode-descriptionForeground);margin:0 0 4px}.translation-row{display:grid;grid-template-columns:100px minmax(0,1fr);gap:16px;padding:8px 0}.language{padding-top:6px}.language label{font-weight:500}.current-locale{color:var(--vscode-descriptionForeground)}.badge{font-size:12px;margin-top:5px;color:var(--vscode-editorWarning-foreground)}textarea,select{display:block;width:100%;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));font:inherit;padding:6px 8px;resize:vertical}textarea{min-height:34px;max-height:180px}select{margin:8px 0}textarea:focus,select:focus,summary:focus-visible,button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button{font:inherit;cursor:pointer;border:1px solid transparent;border-radius:2px;padding:5px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.primary:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.5;cursor:default}button.source{padding:2px 0;text-align:left;font-size:12px;background:transparent;color:var(--vscode-textLink-foreground);overflow-wrap:anywhere}#error{padding:10px;border-left:3px solid var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground);white-space:pre-wrap;margin-bottom:12px}footer{margin-top:20px;padding-top:12px;border-top:1px solid var(--vscode-panel-border);display:flex;align-items:center;gap:12px;flex-wrap:wrap}#status{flex:1;min-width:160px;font-size:12px;color:var(--vscode-descriptionForeground)}.actions{display:flex;gap:8px}.change{margin:12px 0;padding-top:12px;border-top:1px solid var(--vscode-panel-border)}.diff{display:grid;grid-template-columns:1fr 1fr;gap:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.sources{display:flex;flex-direction:column;align-items:flex-start}summary{cursor:pointer;color:var(--vscode-descriptionForeground);font-size:12px;width:fit-content}details{margin:6px 0}#details{margin-top:18px}.field .muted{margin:5px 0}.proposal{margin:8px 0;padding:8px;border-left:2px solid var(--vscode-panel-border)}#ai-form>label,.ai-source-field>label{display:block;font-size:12px;font-weight:500;margin-bottom:6px}#ai-text{min-height:72px}#ai-source{margin:6px 0 0}.ai-options{display:grid;grid-template-columns:170px minmax(0,1fr);gap:18px;margin-top:16px;align-items:start}#ai fieldset{min-width:0;border:0;padding:0;margin:0}#ai legend{padding:0;margin-bottom:6px;font-size:12px;font-weight:500}#ai-target-count{font-weight:400;color:var(--vscode-descriptionForeground);margin-left:6px}#ai-targets{display:flex;flex-wrap:wrap;gap:6px}#ai-targets label{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:5px 9px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;cursor:pointer}#ai-targets label:hover{background:var(--vscode-list-hoverBackground)}#ai-targets label.selected{background:var(--vscode-list-inactiveSelectionBackground);border-color:var(--vscode-panel-border)}#ai-targets input{margin:0;width:14px;height:14px;accent-color:var(--vscode-focusBorder)}#ai-targets input:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}#ai-payload{max-height:260px;overflow:auto}#ai-error{color:var(--vscode-editorWarning-foreground);white-space:pre-wrap}.ai-note{margin:14px 0 8px;color:var(--vscode-descriptionForeground);font-size:12px}.ai-send-summary{padding:12px;border:1px solid var(--vscode-panel-border);border-radius:3px;margin:10px 0}#ai-notes{margin-top:8px}#ai-wait{font-size:13px}#ai-cancel-note{font-size:12px;color:var(--vscode-descriptionForeground)}.buffer-note{color:var(--vscode-descriptionForeground);font-size:12px}
.proposal-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.proposal-toolbar label,.proposal label{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:12px}.proposal input,.proposal-toolbar input{margin:0;width:14px;height:14px;accent-color:var(--vscode-focusBorder)}.proposal input:focus-visible,.proposal-toolbar input:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}#proposal-bar{margin:0 0 10px;padding:10px 0;border-bottom:1px solid var(--vscode-panel-border)}#proposal-bar p{margin:5px 0 0}.proposal pre{margin-top:5px}.proposal-comparison{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}.proposal-comparison p{margin:0 0 4px}.proposal-comparison pre{margin:0}.proposal-comparison>div{min-width:0}.proposal-comparison.stacked{grid-template-columns:1fr}#resource-summary{margin:6px 0 0}.translation-row{border-bottom:1px solid var(--vscode-panel-border)}
@media(max-width:520px){.ai-options{grid-template-columns:1fr;gap:14px}}
@media(max-width:440px){main{padding:16px}.translation-row,.diff,.proposal-comparison{grid-template-columns:1fr;gap:4px}.language{padding-top:0}}
@media(forced-colors:active){button,textarea,select,#ai-targets label{border:1px solid ButtonText}}

</style></head><body><main>
<header><p id="view-caption" class="eyebrow">Переводы</p><h1 id="key">Загружаем…</h1><p id="resource-summary" class="muted"></p></header>
<div id="error" role="alert" hidden></div><button id="error-reload" class="source" type="button" hidden>Обновить ресурсы</button>
<section id="edit" aria-label="Переводы по языкам"><div id="proposal-bar" hidden role="group" aria-label="Предложения ИИ для текущего ключа"><p class="eyebrow">Предложения ИИ</p><div class="proposal-toolbar"><label for="proposal-all"><input id="proposal-all" type="checkbox">Все · <span id="proposal-count" aria-live="polite"></span></label><button id="proposal-accept" type="button" disabled>Принять все</button></div><p id="proposal-help" class="muted"></p></div><div id="rows"></div><button id="ai-open" class="source" type="button">Перевести с ИИ…</button></section>
<section id="review" hidden aria-label="Подтверждение изменений"><h2 id="review-title">Применить переводы?</h2><p id="review-summary"></p><p id="rename-scope" class="muted" hidden>Только точные «$Key$» в BL и имена ключей в NLS текущего checkout. Комментарии, JS, динамические ключи и исключённые файлы не изменяются. Тексты переводов сохраняются.</p><p class="buffer-note">Изменения попадут в открытые файлы редактора, не сохранятся на диск автоматически. Затем сохраните файлы через Save / Save All; доступен Undo.</p><details id="review-details"><summary>Показать изменения</summary><div id="changes"></div></details></section>
<section id="ai" hidden aria-label="Перевод с ИИ">
<div id="ai-error" role="alert" hidden></div><button id="ai-recover" class="source" type="button" hidden>Открыть настройки</button>
<div id="ai-form"><label for="ai-text">Текст для перевода</label><textarea id="ai-text" rows="2" maxlength="65536" aria-describedby="ai-draft-note"></textarea>
<div class="ai-options"><div class="ai-source-field"><label for="ai-source">Исходный язык</label><select id="ai-source"></select></div><fieldset aria-describedby="ai-target-help"><legend>Языки перевода <span id="ai-target-count"></span></legend><div id="ai-targets"></div><p id="ai-target-help" class="muted" hidden></p></fieldset></div></div>
<div id="ai-review" hidden><p id="ai-endpoint" class="muted"></p><div class="ai-send-summary"><pre id="ai-summary"></pre></div><p class="ai-note">Нажимая «Перевести», вы разрешаете отправить этот текст и показанный запрос указанному API.</p><details><summary>Посмотреть полный запрос</summary><pre id="ai-payload"></pre></details></div>
<div id="ai-wait" role="status" hidden><p>Переводим… Поля выше можно редактировать.</p><p id="ai-cancel-note">Отмена остановит ожидание, но провайдер может продолжить вычисление и списать оплату.</p></div>
<p id="ai-draft-note" class="ai-note">Результат появится в черновике — файлы не изменятся.</p>
<details id="ai-notes"><summary>О переводе с ИИ</summary><p class="muted">Существующие переводы и ручные правки не заменяются автоматически. Можно принять все предложения или выбрать языки.</p><p class="muted">Placeholders и markup проверяются частично, без полноценной ICU-валидации. Проверьте перевод перед сохранением.</p><p class="muted">Отмена ожидания не гарантирует отмену вычисления или оплаты у провайдера.</p></details></section>
<details id="details"><summary>Источники и подробности</summary><p id="scope" class="muted"></p><pre id="resource-paths" class="muted"></pre><p id="count" class="muted"></p><p class="muted">Черновик хранится локально без шифрования и синхронизации (Remote SSH — на сервере). Закрытие вкладки сохраняет подтверждённый черновик, но не меняет NLS.</p><div class="sources"><button id="add-language" class="source" type="button" hidden>Добавить язык…</button><button id="rename-key" class="source" type="button" hidden>Переименовать ключ…</button></div><div class="toolbar"><button id="reload" type="button">Обновить из ресурсов</button><button id="discard" type="button">Отменить изменения</button></div></details>
<footer><button id="proposal-undo" class="source" type="button" hidden>Отменить принятие</button><span id="status" role="status" aria-live="polite">Загружаем…</span><div class="actions"><button id="close" type="button">Закрыть</button><button id="back" type="button" hidden>Назад</button><button id="ai-back" type="button" hidden>Назад</button><button id="ai-cancel" type="button" hidden>Отменить запрос</button><button id="ai-prepare" class="primary" type="button" hidden disabled>Проверить запрос</button><button id="ai-send" class="primary" type="button" hidden disabled>Перевести</button><button id="preview" class="primary" type="button" title="Проверить изменения · Ctrl / Cmd + Enter" disabled>Проверить изменения…</button><button id="apply" class="primary" type="button" title="Ctrl / Cmd + Enter" disabled hidden>Применить в файлы</button></div></footer>
</main>
<script nonce="${nonce}">(${client.toString()})()</script></body></html>`;
}
module.exports = { renderI18nView };
