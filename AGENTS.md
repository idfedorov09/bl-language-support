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
- По постоянному указанию пользователя от 2026-10-07 каждая итерация с изменениями
  завершает минимум **patch bump**, если явно не согласовано иное. Minor/major —
  по SemVer; один bump на итерацию, не на каждый файл/коммит/запуск тестов.
  Объяснения без изменений не требуют bump. Синхронизируйте package.json и обе
  версии корневого package в package-lock.json; сообщайте итоговую версию.
- **Без автоматических commit, push, publication, live HTTP-запросов
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
| `blCompletion.js` | Один routed BL completion: scoped view существующего индекса, native symbols/NLS, version guards |
| `localizationModel.js`, `localizationPresentation.js`, `localizationCompletion.js`, `localization.js` | Безопасный XML-properties parser, checkout-scoped NLS, visual-only replacement, независимые Warning, hover/definition |
| `localizationEdits.js`, `i18nDraft.js`, `i18nView.js`, `i18nToolkit.js`, `i18nAi.js`, `i18nSearch.js`, `i18nResources.js`, `i18nRename.js` | Общие surgical XML edits, bounded workspace-local drafts, offline редактор/preview/native Apply |
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
language server**. NLS-локализация реализована в локальном dev: реальные ресурсы,
soft replacement, default ru, independent Warning, hover/F12, Copy Translation.
Пользователь подтвердил прототип/reveal/Copy/Undo; итоговые темы/fonts/wrap ещё
pending. Пользователь затем сообщил, что integrated inline «вроде всё работает»;
это общее acceptance evidence, не отдельные темы/fonts/wrap. Не архивировать change.
Offline Edit Translation реализован в локальном dev по add-i18n-toolkit: язык/value,
local draft recovery, family-scoped target (sole autoselect), preview/native Apply. Первая композиция Toolkit
отклонена пользователем как перегруженная; compact revision реализована и принята
2026-10-07 («сильно лучше»), полная theme/accessibility matrix ещё pending. Default — key/locale/value; technical/source details в disclosure,
chooser раскрыт при отсутствующем target. «Проверить изменения…» открывает обязательный review; «Применить в файлы» меняет
native buffers, не делает disk save.
AI этап разрешён 2026-10-07: input-first/request review, endpoint-bound SecretStorage,
minimal Chat Completions, cancel/timeout/response validation, safe proposals в draft.
Mock-проверки есть; live provider/новый AI GUI не проверены. Search/select/insert
реализованы в local dev 1.3.0 по tasks 3.2/3.3; localization completion 3.1 — в 1.3.3,
explicit resource create реализован в 1.3.4, rename локализационных ключей — в 1.3.5 (не BL symbols/F2).
Первый этап BL completion реализован в локальном dev 1.4.0 по enhance-bl-intellisense:
members/inheritance/locals/indexed arrays/maps/new/import, scoped source-only и dirty buffers;
unit/corpus подтверждены, popup/Remote SSH GUI gate pending. Signature help, auto-import,
outline/tokens, symbol rename, генераторы и Request Workbench пока только запланированы.
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
  Опциональные maskedRanges используют original offsets; isCodePosition учитывает
  CRLF и incomplete/empty strings/comments, не отдельный regex-parser.
- BL completion регистрируется один раз в localization.register с routed provider
  из blCompletion; partial "$ context идёт только в NLS, остальные strings/comments/
  attributes не получают symbols. JS независим. CompletionIndex — scoped view
  существующих class objects, не второй parser/discovery; strict ties unknown,
  explicit imports/outer .git/exclusions (в том числе buffers) обязательны.
  Completion chain хранит collection shape/declaring imports: каждый индекс снимает
  одну размерность. Не убирать unknown overload returns ради surviving known type.
  Inline parent нужен container/container.container и private/protected доступа;
  class-only receiver static, new Class class-first/instance. Native не выдумывать.
  Plain name insertion/ranges без commands/snippets/auto-import/save; overloads
  одной строкой с bounded untrusted evidence, cap 200/incomplete. Version/BL epoch/
  dependency edits/config/folders/cancel/dispose guards до и после awaits.
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

## Инварианты локализации

- Не менять BL text/offsets/undo ради отображения. Только точные `"$Key$"` вне
  комментариев/других строк; все затронутые selection/cursors раскрывают ключ.
- `bl.i18n.*` — resource settings, default translations/ru/requiredLocales [].
  Active locale проверяется всегда, Warning отдельно от BL errors/режима display.
- NLS source discovery исключает target/build/node_modules/.git и user excludes;
  buffers не обходят exclusions. Scope — внешняя .git в содержащем workspace.
- Parser не загружает DTD/entities/сеть; conventional Java DOCTYPE инертен.
  Ошибка parse/read делает locale unavailable, не definitive missing. Разные
  values — conflict с evidence, одинаковые — все sources; runtime precedence не гадать.
- Watchers/buffers/folder/config revisions отменяют stale rendering/navigation.
  Hover source — untrusted appendText. Localization action — отдельный trusted блок
  только hardcoded bl.editTranslation, encoded sourceUri/key из lexical model;
  не объединять с source-controlled Markdown. Не расширять trust/API engine.
- Toolkit — offline; source-only shared snapshot/parser. Только валидированные IDs
  row/option, bounded values/monotonic sequence/session; nonce CSP/connect-src none.
  Никаких путей/commands из webview. Apply trusted, text-only WorkspaceEdit после
  source hash/document version/scope guards; не fs writes/auto-save.
- Localization completion — один BL/file provider в localization, не в Toolkit.
  Shared string scanner + KEY grammar, single-line partial "$ context только;
  main range после opening "$ до closing quote/EOL, plain key+$+optional quote.
  Не использовать snippets/additional edits/commands для вставки и не мешать JS.
  Prefix filter/cap 200/incomplete continuation, untrusted bounded documentation,
  chosen-locale resolver без fallback. Version/epoch/cancel/root guards обязательны;
  discovery/unsaved/exclusions общие. Не выдавать его за BL symbol IntelliSense.
- Toolkit edit/AI targets — только семейства валидных источников текущего key:
  exact directory + basename без locale suffix общего parser. Единственный existing
  source или missing-key sibling auto-selected; ambiguity explicit. Read-only index/
  inline/search остаются checkout-wide. No family anchor — no guess; no language
  file — no AI target/automatic file creation, required/active row объясняет отсутствие.
  Fresh family membership проверять Prepare/Send/response/accept/undo/preview/Apply;
  старые чужие targets stale, текст/AI provenance сохранить без auto-rebase.
- Toolkit UX 1.3.2: host resourceSets summary без guessed module, full paths в
  details; sole selected option direct Open File, null/ambiguous chooser explicit.
  No-file row static, recovered text read-only/copyable. AI comparison current vs
  proposal responsive/stacked, immediate manual input + focus/selection preservation.
  Recovery commands/settings только host allowlist, resource reload explicit
  с discard confirmation; cancellation не удаляет draft/proposals/Undo.
  AI form redesign не разрешён в этой ревизии. Draft saved != disk saved.
- Draft workspaceState local/not-synced/not-encrypted, только dirty fields/target
  fingerprints, не XML corpus/credentials; limits/errors обязательны. «Сохранён»
  только после storage ack. onDidDispose не cancel/reopen: восстановление draft.
  Discard/reload подтверждаемые; stale не rebase, не overwrite. UI source values
  через textContent/value, одна primary на фазу; input focus не терять при save ack.
  AI реализован по tasks 4/5; Search/select/insert по 3.2/3.3, key completion по 3.1.
  Rename ключей реализован по 7.1: secondary details, native key input, exact scoped
  BL+NLS versioned preview, отдельный text-only Apply без auto-save. Shared scanner/
  parser, force discovery/dirty overlays, отдельная BL rename revision; membership/
  full-source hashes/document versions/root/trust/real-path guards после awaits.
  No collisions/ambiguous families/duplicates/invalid NLS, no dynamic/JS rename.
  Current dirty draft/proposals/Undo и target-key draft/panel блокируют rename,
  не discard/migrate. Success rebind same panel to new key; post-commit errors
  честные, no rollback. Source spans/values/BOM/comments/newlines сохранять.
  Дальнейший scope rename без нового этапа не расширять. Explicit Add language реализован по отдельно разрешённому 7.8: secondary в details, native family/locale/path consent, separate createFile+insert без overwrite/auto-save, shared discovery. Не смешивать resource ops с text-only Apply переводов; созданный XML-буфер требует Save. Не копировать ключи, не rebase старые null/stale targets; draft/proposals сохранять. Native поиск — source-only, scope
  chooser без editor, full-text/capped 200/provenance/конфликты/пустые состояния.
  Actions explicit; Insert captured BL version/text/editor/single selection +
  lexical range/trust/NLS epoch/hash guards и native edit/Undo, no auto-save.
  Не вставлять в comments/ordinary cursor strings/multiline/multi-cursor.
  Search → toolkit host-only entry проверяет key/expected root/cancel; Palette
  editTranslation по-прежнему требует BL literal. Собственное открытие NLS
  инвалидирует индекс: проверять свежий hash/root, не отменять свою навигацию.
- AI config machine/user-only через inspect global/default, не workspace override.
  SecretStorage per endpoint, late resolution; webview не получает credential.
  Send только prepared host token после endpoint/model/payload consent и trust;
  HTTP требует отдельного consent, no redirects/retries/discovery. Cancel/config/
  close/reload инвалидируют late results; network не блокирует queue редактирования.
  AI form: все eligible targets checked по умолчанию, source label скрыт и не
  отправляется; source changes/acks/review не сбрасывают ручной выбор. Technical
  notes в disclosure, consent и cancel/payment warning видимы в нужной фазе.
  Ответ strict JSON/exact locales/bounded strings + partial placeholder/markup checks;
  существующие/edited поля — предложения с revision-bound accept, не auto-overwrite.
  Mass acceptance: contextual default-checked proposals текущего ключа, один batch
  action и mixed checkbox. Host tokens + proposal/row revisions + fresh sources +
  total size, all-or-nothing. Undo в памяти только последнего acceptance, новые
  affected edits/new AI run/reload/discard/apply инвалидируют; unrelated edits
  сохраняются. Undo/proposals не persist. No auto-apply/save. Не выводить raw
  provider errors/token; HTTP tests только mocks.
- Для пользовательского теста Remote SSH использовать F5 **Z8BL: Real NLS (CLM)**,
  не одновременно два renderer'а из старого prototype harness.

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
| `BL: Найти перевод` / `bl.searchTranslations` | Native QuickPick key/value по checkout, explicit Edit/Insert/Source; guards не позволяют stale insertion |
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
`npm run test:completion-corpus -- ../pro.doczilla.clm`,
`npm run test:request-corpus -- ../pro.doczilla.clm`,
`npm run test:localization-corpus -- ../pro.doczilla.clm`,
`openspec validate --all --strict --no-interactive`. Они не подтверждают UI,
runtime Doczilla или корректность всех BL-программ. В отчёте разделите выполненные
и невыполненные проверки, назовите затронутые файлы/проекты и ограничения.

CLI закреплён на OpenSpec **1.13.1**. Main specs обновляйте только по
подтверждённому поведению; не sync/archive незавершённые feature changes.

SemVer: **major** — несовместимый пользовательский контракт/отказ от обещанной
поддержки; **minor** — совместимые новые функции; **patch** — совместимые
исправления/производительность. Постоянное указание пользователя: минимум patch
на каждую итерацию с изменениями, включая docs/spec/tooling-only, если явно не
согласован пропуск. Никогда не переиспользуйте опубликованную версию.
Push в `master` и ручной запуск publish workflow могут публиковать расширение,
а не только проверять его. Подробные критерии, процесс релиза и reproducible
установка инструментов — в [CONTRIBUTING.md](CONTRIBUTING.md).
