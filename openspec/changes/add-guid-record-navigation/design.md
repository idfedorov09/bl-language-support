# Design

## Context

См. [proposal](proposal.md). `parseBlContent` уже превращает имена `records` в guid-members, но не сохраняет полноценную модель GUID-значений и атрибутов для lookup. Поэтому существующие definitions/references — baseline, а не реализация этого change.

## Goals / Non-Goals

**Goals:** компактный индекс статических деклараций с provenance; возможность искать по literal и имени без сетевого подключения.

**Non-Goals:** runtime introspection и полный анализ security/migration semantics.

## Decisions

1. Дополнить сведения record-деclaration каноническим GUID, владельцем, атрибутами, диапазонами и context. Case normalization применяется только к GUID, не к BL-символам.
2. Lookup возвращает кандидатов с source evidence и checkout; выбрать одного можно лишь при достаточном контексте. Исторические migrations и inherited declarations не считаются автоматическим конфликтом.
3. Разрешённые symbol references используют существующую семантическую проверку. Literal matches показываются отдельно; комментарий с UUID не является доказанной зависимостью.
4. Карточка получает label и linked records через доступные локальные descriptors. Локализации/Workbench опциональны: их отсутствие не отключает базовый GUID lookup.
5. Индекс обновляется теми же file/buffer событиями; история результатов не должна удерживать source-тексты всех файлов. Классификация подозрительного конфликта требует основания, которое выводится пользователю.

## Implementation notes

Реализация в рабочем `dev` начата 2026-10-06, не опубликована. Отдельный editor/UI gate ещё не выполнен; main specs остаются историческим baseline.

- `blIndex.js`: все `recordDeclarations` сохраняют исходные диапазоны, RHS и атрибуты; прежние `guid`-members и `records` Map сохранены. Только точный single-quoted UUID RHS индексируется как статический ID, регистр канонизируется без изменения исходника. Computed ID остаётся доступен карточке по имени, не UUID lookup.
- GUID-константы хранятся в `guidConstants` / `constantsByGuid`, отдельно от records; `getGuidDeclarations` объединяет все варианты, `getRecordsByGuid` сохраняет records-only контракт.
- GUID → все `{ owner, record }`, без proximity-выбора внутри индекса. UUID candidate Bloom filter — 1 КиБ только для файлов с UUID; SHA-256 fingerprints отличают изменение содержимого от идентичного reparse при открытии. История не хранит полные исходники.
- `guidNavigation.js`: F12 расширяет существующий definition provider только на GUID-литералах; обычные BL references и import hover сохраняются. Команды `bl.lookupGuid`, `bl.showRecordCard`, `bl.showGuidUsages` возвращают source-backed модель и открывают read-only карточку.
- Scope определяется по source URI (для `{ filePath, name }` — прежде всего по указанному файлу): внешняя `.git`-граница внутри workspace-папки включает дочерние сабмодули; при отсутствии Git используется сама папка. Это файловая граница, не Gradle classpath. В multi-root без source сначала выбирается папка; без известной границы кандидаты остаются явно подписанными. Отсутствие записи локально не расширяет поиск в чужой checkout.
- Карточка разделяет owner/attributes, статические связи, неоднозначные кандидаты атрибутов и другие декларации с тем же GUID. Точные record expressions и UUID-атрибуты разрешаются через локальный индекс; `new Request.getClassKey()` и runtime-выражения не вычисляются. Связь role/access никогда не называется effective permission.
- Повтор имени или GUID в одном source-классе даёт potential conflict/alias warning с evidence. Миграция, наследник или другая копия проекта не создают duplicate error. Неоднозначные symbol usages одного имени не приписываются отдельной дублирующей декларации.
- Использования разделены на `symbol`, `literal`, `text`; они не взаимозаменяемы. Поиск уступает host очередь, поддерживает cancellation и отвергает snapshot при изменении открытого буфера или fingerprint закрытого файла.
- `recordCardView.js`: untrusted escaped hover, theme-native HTML, nonce CSP без сети/внешних ресурсов. Только ручные `openSource` по числовому model ID, `refresh`, `findUsages` и enum `setView`. Изменённые источники обновляют карточку перед повторным переходом; данные не вставляются в исполняемый скрипт.
- NLS/Workbench capabilities пока отсутствуют. Проверены самостоятельная работа и публичный lookup `{ guid, sourceUri }`; optional `resolveLocalizedLabel` сохраняет исходный ключ рядом с названием. Это seam для будущей интеграции, не реализация NLS-переводов или Workbench.

Evidence: `test/guid-ux.test.js`, `test/guidIndex.test.js`, `test/guid-navigation.test.js`, `test/guid-context.test.js`, `test/guid-review.test.js`, `test/recordCardView.test.js`. `test/corpus.js` дополнен F12 и командными карточками всех статических GUID реального corpus; тестовый VS Code API не подтверждает настоящий editor UI.

## UX revision (2026-10-06)

По feedback пользователя согласованы apply и статические GUID-константы. Quick Pick заменяет ввод без подсказок: имя, UUID, kind и относительный source path; частичный ввод фильтрует, полный неизвестный UUID допускает явный поиск с сообщением об отсутствии декларации. Типы `record`/`constant` не смешиваются с runtime-БД или arbitrary UUID occurrences.

Hover показывает краткую идентичность/атрибуты/относительный путь; рабочие «Открыть карточку»/«Использования» используют encoded model coordinates. Исходный текст остаётся untrusted. Для VS Code 1.60, где `MarkdownString.isTrusted` только boolean, trusted action-блок отдельный и содержит исключительно два hardcoded command URI с безопасно сериализованными аргументами. Ни один source-controlled label не входит в trusted Markdown.

В карточке используются разделы «Карточка»/«Использования»: ручное действие сразу переключает видимый раздел, показывает loading с aria-live, блокирует повторный запуск и затем выдаёт счётчики/empty/error/partial/stale. При обновлении сохраняется выбранный раздел; старые результаты не выдаются за новое завершение поиска. Никаких автоматических HTTP-запросов или success-toast.

Контекстное меню имеет один пункт Z8BL и логические группы внутри; IDs и палитра сохраняются, engine не повышается. Проверки включают mock QuickPick/events, переходы hover, состояние webview, parser/index/corpus; editor gate остаётся отдельно согласуемым.

Повторный feedback пользователя: подменю в настоящем редакторе **не подтверждено**,
на скриншоте остались плоский список и прежние названия команд. Текущий manifest
содержит одно подменю; возможна загруженная старая копия/manifest, но причина
не установлена. Не приравнивать manifest-тест к работающему UI и не добавлять
ещё одно подменю или скрытый fallback без основания.

Открытие карточки действительно использовало `ViewColumn.Beside`; по запросу
пользователя заменено на `ViewColumn.Active`. Все три команды и обе hover actions
используют общий `openCard`, поэтому карточка и usages открываются отдельной
вкладкой в текущей группе. Уже созданные пользователем группы не закрываются и
не объединяются. Согласованы только исходники/тесты/спеки; VSIX и UI не запускаются.

### UX sources и выбранный паттерн

Read-only web research 2026-10-06: страницы проверены обычным HTTPS-fetch,
без открытия browser/UI или обращения к Doczilla runtime. Web search tool
в этой сессии не вернул содержимое; это не скрывалось под выдуманными цитатами.

- [VS Code — Quick Picks](https://code.visualstudio.com/api/ux-guidelines/quick-picks):
  фильтрация и короткие description/detail. Наш выбор — native picker, имя / UUID / kind+source,
  без ошибки на неполный ввод; неизвестный полный UUID получает отдельное действие поиска.
- [VS Code — Context Menus](https://code.visualstudio.com/api/ux-guidelines/context-menus):
  контекстные действия и подменю для большой группы. Наш выбор — одна группа Z8BL только в BL.
- [VS Code — Notifications](https://code.visualstudio.com/api/ux-guidelines/notifications):
  прогресс предпочтительнее показывать в контексте, глобальные notifications — не основной путь.
  Наш выбор — локальный loading/status, без success-toast для каждого поиска.
- [Nielsen Norman Group — Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/):
  немедленная обратная связь на действие. Наш выбор — видимый раздел usages, disabled repeat,
  счётчики и различение empty/partial/error/stale/cancelled.

Это основания UX-решения, не обещание одинакового поведения с коммерческим продуктом
и не подтверждение удобства в настоящем VS Code. Разделы доступны с клавиатуры и ARIA;
результаты сохраняют отдельные provenance-группы, поиск остаётся ручным/offline.

## Risks / Trade-offs

- [Legacy GUID повторяется законно] → кандидаты и контекст вместо общей duplicate error.
- [ID вычисляется через guid.create] → lookup статических literals не обещает вычислить произвольный runtime ID.
- [Связь роли похожа на effective permission] → UI подписывает её как декларацию исходника.
- [Несколько checkout] → сохранять caller context и source path; lookup из ответа явно выбирает workspace context.

## Migration Plan

Расширить parser metadata без изменения обычной навигации по имени записи. Добавить lookup/card отдельно; existing IDs и source files не переписывать.
