# Proposal

Статус: 2026-10-06 пользователь явно разрешил UX research/spec revision и реализацию offline Edit Translation. 2026-10-07 отдельно разрешён AI этап с mocks; search/completion/live API/release не входили в него. Теперь отдельно разрешены поиск/выбор/вставка (3.2/3.3); completion теперь отдельно разрешён (3.1); live API/GUI/release остаются вне этапа. См. ux-research.md.

## Why

Просмотр локализованных названий в BL полезно дополнить единым рабочим местом:
найти перевод, выбрать ключ, отредактировать языки и при желании получить черновик
переводов от модели — без ручного обхода нескольких XML-ресурсов.

## What Changes

- **Edit Translation**: окно выбранного ключа, строки «язык слева — поле перевода
  справа», статусы missing/conflict, источник каждого языка и явные Save/Cancel.
- Дополнение локализационных ключей в BL с preview выбранного перевода и provenance.
- Поиск по ключу **и текстам переводов**; выбор вставляет ключ, не перевод в BL.
- **Auto Translate**: отдельная кнопка → ввод исходного текста → выбор исходного/целевых языков → подтверждение отправки,
  loading/Cancel; ответ заполняет черновик, но не сохраняет XML автоматически.
- Настраиваемые base URL, model и отдельный translation prompt для
  OpenAI-compatible API; секретный API key вне settings/source/webview.
- Массовое принятие предложений ИИ для текущего ключа: выбор языков, «Принять все» и отмена последнего принятия без автоматического Save.
- Целевые ресурсы только из соответствующего набора NLS ключа, автоматический выбор однозначного файла; отсутствующие файлы языка не становятся AI targets.
- Одобренная UX-ревизия 1/2/4/5/6: общий NLS-контекст, no-file состояния, понятное применение, сравнение AI и безопасные recovery actions; AI form redesign вне scope.
- Предпросмотр многофайловых изменений, поддержка несохранённых буферов,
  предотвращение overwrite и сохранение существующих placeholders.
- Theme-aware, keyboard-accessible UI; лёгкое inlay-style отображение в BL
  уточняется в **add-inline-localization**, не дублируется Toolkit.

## Capabilities

### New Capabilities

- `i18n-toolkit`: редактирование многоязычных переводов, поиск/выбор ключа,
  модельные предложения и безопасное применение черновика.

### Modified Capabilities

Нет: основные specs не содержат production NLS. Toolkit использует реализованный общий
resolver и общий surgical edit-plan рядом с `add-inline-localization`, не создаёт второй XML-парсер или
отдельные правила checkout. Existing BL/GUID/JS↔BL/Java contracts не меняются.

## Impact

Будущая интеграция с командами/контекстным подменю Z8BL, NLS-index и versioned edit
plans, theme-aware webview, VS Code SecretStorage и host-side HTTP adapter.
В локальном dev уже есть общий production NLS resolver, offline редактор и AI
input-first/transport/proposals. Compact UI принят; AI GUI/live provider ещё pending.
При AI apply manifest получил machine-scoped settings и Palette credential команды,
новых dependencies нет. Search/select/insert реализованы в local dev; localization completion реализован по отдельно подтверждённому task 3.1; explicit Add language реализован в 1.3.4; rename локализационных ключей реализован в 1.3.5.
Предлагаемый начальный wire contract — Chat Completions; универсальная совместимость
со всеми провайдерами не обещается. Live API/runtime проверки отдельно согласуются.

## Non-goals

Не делать внешнее машинное переведение по умолчанию, bulk-перевод всего проекта,
автоматический Save после ответа, агентское исполнение/инструменты, отправку всего
репозитория, HTTP-запросы при открытии окна, silent fallback модели или языка.
Не менять runtime locale. Не копировать код/брендинг reference-плагина.

## Reference

Пользовательский UX reference: JetBrains Marketplace i18n Toolkit,
https://plugins.jetbrains.com/plugin/29957-i18n-toolkit
(изучено 2026-10-06). Это источник идей, не зависимость и не доказательство,
что какой-либо его механизм уже реализован в Z8BL.


## Добавление языка (разрешено 2026-10-07)

Отдельно согласованы спеки и реализация явного добавления языка в существующее
семейство текущего ключа. Secondary «Добавить язык…» скрыто в «Источники и
подробности», не в primary toolbar и не рядом с каждым missing. Семейство sole
определяется автоматически; неоднозначное выбирается явно. Native выбор locale,
preview точного пути и подтверждение создания. Rename по-прежнему вне этапа.
Новый файл создаётся native WorkspaceEdit, без overwrite; пустая Java XML-properties
структура в новом буфере, её сохранение — штатный Save. Никаких копий ключей/переводов,
auto-AI, auto-save других ресурсов или незаметной миграции старого черновика.


## Переименование ключа (разрешено 2026-10-07)

Отдельно согласован task 7.1: secondary «Переименовать ключ…» в подробностях,
native ввод нового key, обязательный preview точных BL/NLS edits и guarded
text-only WorkspaceEdit без auto-save. Scope — обнаруженные source BL/NLS текущего
checkout, unsaved overlays и общие exclusions. Комментарии, JS, динамические ключи
и тексты переводов не переименовываются; ограничение видно в review. Коллизии и
неоднозначный NLS не разрешаются автоматически. Текущий draft/proposals/Undo и
существующий draft нового key блокируют rename, не удаляются и не мигрируют молча.
