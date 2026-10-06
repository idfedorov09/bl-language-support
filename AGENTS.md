# Z8BL: инструкции для агентов

При работе из этого Git-корня прочитайте родительский `../AGENTS.md`, если он
доступен; этот файл приоритетнее при конфликте. Отвечайте по-русски.

## Scope и порядок работы

- Проверьте фактическую ветку и `git status`. Обычная разработка/PR — в `dev`,
  `master` — релизная ветка. Не переключайте ветку и не трогайте чужие изменения молча.
- Различайте исследование, планирование и реализацию. Наличие proposal/tasks
  **не разрешает apply**; для реализации нужен отдельный запрос пользователя.
  Если запрос неоднозначен, коротко изложите план и уточните, приступать ли к правкам.
- В согласованном scope идите автономно до результата. Не маскируйте неожиданный
  блокер workaround/fallback: объясните проблему и варианты до смены подхода.
- Держите изменения локальными, сохраняйте unrelated changes. Не переписывайте
  ядро на LSP и не добавляйте зависимости или новые механизмы вне запроса.
- **Без автоматических version bump, commit, push, publication, live HTTP-запросов
  и UI/браузерных проверок.** Для них нужен отдельный запрос/разрешение.
- Временные выгрузки и одноразовые скрипты — только в `tmp/` общей рабочей области
  по родительским инструкциям (для checkout в `dz` — `../tmp/`), не в новом каталоге проекта.
  Не включайте секреты и приватные данные в логи, тестовые fixtures и отчёты.

## Карта проекта

| Путь | Содержание |
| --- | --- |
| `extension.js` | Definition/reference/hover/CodeLens providers, диагностика, настройки, команды и наблюдение за файлами |
| `blIndex.js` | Эвристический парсер `.bl`, индекс классов/членов, импорты, наследование и резолвинг типов |
| `documentAnalysis.js` | Анализ и кеши документов с сохранением координат |
| `requestModel.js` | Строгий JS AST / tolerant completion AST, source-only BL-модель маршрутов |
| `requestNavigation.js` | Явная команда JS→BL, hover/completion, отдельный обратный Quick Pick, scoped route index и актуальность |
| `guidNavigation.js` | Offline GUID lookup, hover, карточки, usages и безопасные переходы к источникам |
| `recordCardView.js` | Read-only renderer карточек records / GUID-констант и hover, CSP и экранирование |
| `syntaxes/bl.tmLanguage.json`, `language-configuration.json` | TextMate, комментарии, скобки |
| `package.json` | Точные команды, настройки/defaults, language id и версия |
| `test/` | Node unit/performance/navigation-тесты и локальный BL corpus |
| [openspec/specs/](openspec/specs/) | Подтверждённый baseline, не желания |
| [openspec/changes/](openspec/changes/) | Отдельные будущие changes и незавершённые задачи |
| [openspec/config.yaml](openspec/config.yaml), [openspec/README.md](openspec/README.md) | Контекст, правила OpenSpec, карта capabilities/backlog |
| [.agents/skills/](.agents/skills/) | Шесть официальных локальных OpenSpec skills; прочитайте нужный `SKILL.md` |

Текущее ядро — CommonJS и локальный эвристический индекс, **не компилятор и не
language server**. Полноценный BL IntelliSense, NLS-переводы,
генераторы и Request Workbench пока только запланированы; не описывайте их как готовые.
GUID lookup и карточки реализованы в текущем `dev`, не опубликованы. Unit/corpus
подтверждены; editor/UI gate change `add-guid-record-navigation` ещё не выполнен,
поэтому этот change не архивирован и не перенесён в main specs.
JS ↔ BL реализуется по `add-js-bl-navigation` в текущем `dev`; unit/provider/corpus
проверены, отдельный editor gate не выполнен. Не архивировать change до него.
Для BL/Z8 reference используйте соседний `../pro.doczilla.clm`, включая его
`org.zenframework.z8`, без изменений в нём, если это не входит в задачу.

## Инварианты навигации и диагностики

- `sanitizeText()` маскирует комментарии/строки, **сохраняя длину текста,
  переносы строк и позиции символов**. Не сдвигайте line/column/offset при очистке;
  координаты объявлений и диагностик должны соответствовать исходному документу.
- BL symbol locations в definitions/references охватывают всё имя, не только
  нулевую точку. Обычная self-definition должна содержать любую позицию внутри имени:
  это нужно штатному переключению VS Code на alternativeDefinitionCommand.
  Не подменяйте definitions списком usages и не вызывайте references из provider
  определений; Java-переход без symbol coordinates — отдельный file jump.
- На объявлении явного `virtual` override definition может вести к ближайшему
  наследуемому virtual BL-методу с совпадающими разрешёнными типами параметров.
  Не угадывайте связь по одному имени или неизвестной сигнатуре. Для inline-класса
  поиск начинается с его declared base, типы override — из imports исходника.
  Reference provider использует symbol identity без UI-перехода к базе: родитель
  и другие overrides не становятся использованиями выбранного дочернего метода.
- При false positive проверьте разбор класса/метода в `blIndex.js`, импорты,
  `resolveClassName`/`resolveTypeName`, затем кандидаты типов и chain/call logic
  в `collectDiagnostics`. Не лечите неверный резолвинг выключением всех проверок.
- Для цепочек `a.b().c`, inline `class { ... }`, `super` и доступа `[i]` сохраняйте
  правильного владельца и тип элемента массива/карты; не используйте тип контейнера
  вместо element type при следующем сегменте цепочки.
- `new Class.method(...)` требует разрешения первого сегмента именно как класса:
  проверяйте `isNewKeywordBefore` и `resolveChainTypeCandidates(..., forceFirstClass)`.
  Не теряйте это правило при навигации и диагностике.
- Сохраняйте обработку открытых несохранённых буферов, изоляцию одноимённых классов
  между checkout'ами и существующие настройки исключения/режима диагностики.
  При исправлении добавьте regression test, а не только исключение для одного примера.
- GUID lookup возвращает все неоднозначные декларации. Scope — внешняя `.git`
  внутри содержащей workspace-папки, включая сабмодули; без Git — сама папка.
  Без source context в multi-root требуется выбор папки; не выбирайте другой
  checkout молча. Полный source path остаётся evidence, не доказательством classpath.
- Не объединяйте symbol usages с UUID value/text matches. Computed IDs не
  вычисляются; повтор в migration/наследнике/другом checkout не duplicate error.
  Потенциальный конфликт/неоднозначная связь в карточке требует основания и источников.
- GUID-константы — только поля outer-класса `static final guid` с точным
  single-quoted UUID RHS; отдельный kind, не `records`. `getRecordsByGuid`
  остаётся records-only; `getGuidDeclarations` охватывает оба вида.
- Source metadata в hover untrusted. В VS Code 1.60 boolean trust допустим
  только для отдельного программно сформированного блока с двумя hardcoded
  command URI: `bl.showRecordCard` / `bl.showGuidUsages`, encoded arguments,
  без source-controlled labels. Не доверять всему hover и не повышать engine молча.
- Поиск использований сразу открывает видимый раздел с loading/ARIA; не
  коммитить частичные links старого/отменённого snapshot, сохранять выбранный
  раздел при refresh. Команды ПКМ находятся в одном подменю Z8BL.
- Карточка offline/read-only. Webview принимает только разрешённые действия
  и числовые IDs из модели, не пути/URI/команды из сообщения. Не переносите
  исходники в скрипт; сохраняйте nonce CSP, escaping и проверку свежести источников.

- JS request navigation требует строгого Acorn AST. Acorn-loose допустим только
  для completion, не как evidence server sources/reverse usages. Не исполнять JS.
- JS→BL — только явная команда `bl.showServerSources` в ПКМ → Z8BL / Command Palette.
  Не регистрировать JavaScript DefinitionProvider и не перехватывать Cmd+Click/F12.
  Подменю JS содержит только серверную команду; BL-only команды видны только в BL.
- Не смешивать `request`, платформенный `action`, прикладные `method`/`name`
  и HTTP method. Результаты JS-вызовов — отдельный Quick Pick, не BL references.
- Маршруты разрешаются через virtual BL-диспетчеры / Action-поля с source ranges;
  публичное имя метода само по себе не endpoint. Unknown signature/constant/route
  остаётся unknown; не подменять случайным совпадением по имени.
- Route index ограничен checkout; недостающие bases/imports не брать из другой
  папки, неоднозначный dependency tie не выбирать молча. Buffer/file events,
  revision и generation должны отменять stale targets/results; открытия исходника
  самим picker не должны ошибочно отменять собственную навигацию.
- Дефолт `bl.index.exclude` сохранён для BL. JS discovery дополнительно всегда
  исключает `**/target/**` по явному запросу пользователя: generated/minified
  bundles — не developer sources. Открытые JS-буферы target также не участвуют;
  их события не должны инвалидировать source-кэши. Это явно описанный контракт,
  не дедупликация найденных вызовов.
- Production Acorn-зависимости должны входить в VSIX; не возвращать blanket
  `node_modules/**` в `.vscodeignore`. CI/локальные тесты требуют `npm ci`.

## Отладка в VS Code

После установки нового VSIX или правок в dev-хосте — **Developer: Reload Window**.
Само изменение checkout не обновляет установленную Marketplace-копию.
Основной Output channel — **BL Debug**. Названия команд сверяйте с manifest:

| Команда | Сигнал |
| --- | --- |
| `BL: Вывод диагностик` / `bl.dumpDiagnostics` | `Total diagnostics`, `Line diagnostics`, диапазоны и `[source code]` |
| `BL: Анализ текущей строки` / `bl.analyzeLine` | `LineText`, `Chains`, `Segments` (включая `[i]`), `ForceClass`, `Candidates[n]`, `Segment[n] found=...` |
| `BL: Показать контекст (debug)` / `bl.showContext` | Базовый/inline-контекст и разрешение выбранного символа |
| `BL: Найти серверные BL-исходники` / `bl.showServerSources` | Курсор внутри JS request-объекта; Quick Pick класса/диспетчера/ветки/обработчика с source paths, открытие в текущей группе |
| `BL: Найти клиентские JS-вызовы` / `bl.showClientCalls` | Курсор на имени BL request/маршрута/обработчика; отдельный Quick Pick с загрузкой, количеством и переходом в JS |
| `BL: Найти GUID` / `bl.lookupGuid` | Quick Pick по части GUID/имени/владельцу либо `{ guid, sourceUri }`; явный выбор кандидата |
| `BL: Открыть карточку GUID / records` / `bl.showRecordCard` | Курсор на записи/GUID либо `{ filePath, name }` или `{ guid, sourceUri }` |
| `BL: Найти использования GUID / records` / `bl.showGuidUsages` | Та же адресация, раздельные symbol/literal/text результаты |

Поставьте курсор на проблемную строку: сначала dump, затем analyze на **той же
строке**. Проверьте источник `BL` и коды `chain`, `call`, `brace`,
`return-modifier`; диагностика другого provider не становится ошибкой этого
расширения. Сопоставьте `Candidates[0]` и последующие сегменты с парсером/индексом.
Дополнительные трассы включаются через `bl.debug.trace`; команды работают и без него.

В репорте укажите BL-пример, путь/строку, ожидаемую и фактическую цель F12/Ctrl+Click,
оба debug-вывода, настройки и наличие нескольких checkout'ов. Дебаг-текст может
содержать приватные значения: санитизируйте отчёт перед передачей.

## Проверки и релизные границы

Обычные проверки: `npm ci --ignore-scripts`, `npm test`, `npm run test:corpus -- ../pro.doczilla.clm`,
`npm run test:request-corpus -- ../pro.doczilla.clm`,
`openspec validate --all --strict --no-interactive`. Они не подтверждают UI,
runtime Doczilla или корректность всех BL-программ. В отчёте разделите выполненные
и невыполненные проверки, назовите затронутые файлы/проекты и ограничения.

CLI закреплён на OpenSpec **1.13.1**. Main specs обновляйте только по
подтверждённому поведению; не sync/archive незавершённые feature changes.

SemVer: **major** — несовместимый пользовательский контракт/отказ от обещанной
поддержки; **minor** — совместимые новые функции; **patch** — совместимые
исправления/производительность. Docs/OpenSpec/tooling-only без перепубликации —
**без bump**. Никогда не переиспользуйте опубликованную версию.
Push в `master` и ручной запуск publish workflow могут публиковать расширение,
а не только проверять его. Подробные критерии, процесс релиза и reproducible
установка инструментов — в [CONTRIBUTING.md](CONTRIBUTING.md).
