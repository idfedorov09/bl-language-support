# Спецификации Z8BL Language Support

OpenSpec ведётся в этом репозитории. **`specs/` — зафиксированный baseline; `changes/` — планы и незавершённые изменения с явным статусом.**

## Исходное состояние

Инвентаризация: **2026-10-06**, версия **1.1.0**, ветка **`dev`**, commit **`026539c`**. Источники — манифест, код и существующие тесты расширения; BL/Z8 reference — соседний checkout `../pro.doczilla.clm`. Evidence-ссылки в спеках указывают исходники, а не удостоверяют запуск тестов или runtime.

| Основная спецификация | Что уже есть |
| --- | --- |
| [bl-editor](specs/bl-editor/spec.md) | Регистрация `.bl`/`BL`, TextMate, комментарии и пары, import hover |
| [bl-index-and-navigation](specs/bl-index-and-navigation/spec.md) | Локальный индекс, definitions/references, наследование, scopes, несохранённые зависимости, выбор близкого checkout |
| [bl-diagnostics](specs/bl-diagnostics/spec.md) | Эвристические BL-проверки, настройки расписания, debug-команды |
| [bl-java-navigation](specs/bl-java-navigation/spec.md) | Compiled/native Java, CodeLens и команды перехода |

Ядро уже существует: CommonJS, локальный эвристический анализ, versioned caches и тесты. Это **не compiler/LSP**: нет точного выбора перегрузки по аргументам и compiler source maps. В исходном baseline есть навигация по именам `records`, но не по GUID-значению. Новая реализация GUID в `dev` описана ниже; она ещё не выпущена и не перенесена в main specs. Переписывание ядра не входит в планы по умолчанию.

## Изменения и планы

Все шесть changes имеют `proposal.md`, delta `specs/`, `design.md` и `tasks.md`. Отдельно согласованы GUID lookup и JS↔BL; код и проверки описаны в их changes, editor gates остаются открыты. Остальные changes — планы.

| Change | Содержание | Статус |
| --- | --- | --- |
| [enhance-bl-intellisense](changes/enhance-bl-intellisense/proposal.md) | Completion, signature help, auto-import, outline, semantic tokens, безопасный rename | План |
| [add-js-bl-navigation](changes/add-js-bl-navigation/proposal.md) | JS request → BL через ПКМ-команду (не F12), обратные вызовы, подсказки маршрутов | Код + unit/provider/corpus; target/ исключён, editor gate не выполнен |
| [add-guid-record-navigation](changes/add-guid-record-navigation/proposal.md) | GUID lookup, карточки статических записей, различение символов и текстовых совпадений | Код + UX revision (константы, подсказки, hover, usages, подменю); unit/corpus проверены, editor gate не выполнен |
| [add-inline-localization](changes/add-inline-localization/proposal.md) | Перевод **вместо** `"$Workspace.title$"` только визуально; default `ru`, missing — **Warning** | План |
| [add-project-scaffolds](changes/add-project-scaffolds/proposal.md) | Классы, requests, операции, поля и records по локальным аналогам с многофайловым preview | План |
| [add-request-workbench](changes/add-request-workbench/proposal.md) | CodeLens → отдельная Postman-like вкладка с восстановленным request, выбором операций и ручным Send | План |

GUID change не архивируется до отдельного согласования и проверки карточек/списков в настоящем редакторе. Текущая реализация offline/read-only; NLS и Workbench отсутствуют, предусмотрены только optional resolver названия и command API `{ guid, sourceUri }`. Точное состояние и evidence — в [tasks](changes/add-guid-record-navigation/tasks.md) и [design](changes/add-guid-record-navigation/design.md).

**Особые границы:**

- Локализация не меняет исходник, save, copy source или undo. Сначала обязательный prototype gate штатного редактора; при провале обсуждаем UX, не подменяем фичу hint-ом или скрытым workaround. Язык берётся из настроек; missing другого required locale тоже даёт warning; молчаливого language fallback нет.
- Workbench строит draft offline. `request`, `action`, прикладные `method`/`name` и HTTP method — разные вещи. Wire format учитывает Z8 POST form/multipart, а не обещает raw JSON. Открытие вкладки не отправляет запросы. Даже `action=read` не гарантирует read-only; HTTP 200 не гарантирует Z8 success.
- JS-навигация и Workbench могут разделять descriptors маршрутов; GUID lookup и обычные генераторы работают самостоятельно. Интеграции с соседними capabilities включаются только при их наличии.

GUID lookup выбран пользователем первым; затем согласована JS↔BL-навигация. Порядок других изменений **не согласован**; инкрементальный IntelliSense, prototype gate локализации и общий request descriptor остаются отдельными обсуждениями. Сроки и релизная версия не обещаны; большой change можно разбить до реализации.

## Как вести изменения

1. Сверить фактическую ветку и код с baseline; прочитать [AGENTS.md](../AGENTS.md).
2. Исследовать идею, создать/уточнить proposal, delta requirements, design и проверяемые tasks.
3. Обсудить scope и технические риски. **Наличие change или статус planning artifacts `done` не разрешает реализацию.**
4. Только после отдельного запроса пользователя выполнять apply, отмечая реально выполненные задачи и проверки.
5. После реализации и проверок синхронизировать main specs и архивировать change. Не архивировать backlog как будто он реализован.

Релизы и SemVer — в [CONTRIBUTING.md](../CONTRIBUTING.md); документационная инициализация не меняет версию.

## Локальные skills и CLI

Для Codex установлены repo-local skills в [`.agents/skills/`](../.agents/skills/), без глобального skill override:

- `$openspec-explore` — исследование без реализации.
- `$openspec-propose` — полный пакет планирования нового change.
- `$openspec-update-change` — уточнение существующего пакета.
- `$openspec-apply-change` — реализация только после отдельного запроса.
- `$openspec-sync-specs` — синхронизация подтверждённого поведения.
- `$openspec-archive-change` — завершение реализованного change.

Работать с ними нужно в контексте этого репозитория. CLI при инициализации: **OpenSpec 1.13.1**, Node **≥20.19**. OpenSpec — dev tooling, не runtime/npm dependency расширения.

```sh
# Если CLI ещё не установлен на другой машине:
npm install -g @fission-ai/openspec@1.13.1

# Проверка уже инициализированного проекта:
openspec list --specs
openspec list
openspec status --change add-request-workbench
openspec validate --all --strict --no-interactive
```

Skills сгенерированы командой `openspec init --tools codex --language ru --profile core --no-animation --no-copilot-cloud .`. Не запускать повторную инициализацию без необходимости и не перезаписывать project context. В `.gitignore` есть локальное исключение для `openspec/`: спеки должны попадать в Git даже при глобальном ignore. Skills, спеки и developer-инструкции исключены из VSIX через `.vscodeignore`.
