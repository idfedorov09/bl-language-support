# Design

Статус: 2026-10-07 пользователь принял compact UI и разрешил AI apply (tasks 4/5) с mock-проверками. Поиск/select/insert (3.2/3.3) теперь отдельно разрешён. Completion 3.1 теперь отдельно разрешён и реализован; live HTTP, GUI запуск и release отдельно.

## Context

См. proposal.md и specs/i18n-toolkit/spec.md. В репозитории есть CommonJS ядро,
read-only GUID webview с escaping/CSP/валидированными действиями и versioned
JS↔BL модели. Production NLS-index и surgical edit-plan реализованы в local dev.
Dev-прототип с фиксированным словарём — только исторический harness, не resolver.
Compact Toolkit принят; окончательные theme/accessibility gates и live AI pending.

## Goals / Non-Goals

**Goals:** общий NLS resolver, versioned drafts, небольшая model transport abstraction,
один ключ / несколько языков, безопасный путь от предложения к preview/Apply.

**Non-Goals:** новый compiler/LSP, второй NLS-parser, платформенный modal через
внешние приложения, облачный перевод всего проекта, background network/agents.

## Decisions

1. **Источник данных** — общий NLS-index/edit-plan из add-inline-localization.
   Toolkit использует те же checkout/provenance/conflict/version правила. Не
   индексировать target/build-копии ресурсов как developer originals. Предварительно
   нужна безопасная поддержка встреченного Java properties DOCTYPE без загрузки DTD.
2. **Edit Translation** — выделенный VS Code webview panel (вкладка текущей группы,
   без split), визуально компактный editor ключа. Это принятое проектное допущение
   для «окошка», не обещание нативного multi-input modal, которого пока не выбрали.
   Header: key/scope/source locale; ниже language column + input/textarea + status/source;
   footer: Auto Translate, Preview/Save, Cancel. CSP/escaping/message validation
   адаптировать из recordCardView, не превращать read-only карточку в общий editor.
3. **Draft** — per-locale value/original/provenance/status/field revision. Различать
   missing и пустое existing value. Ресурсы меняются только общим versioned edit-plan
   после preview; новый locale/resource выбирается явно. Не перегенерировать весь XML.
4. **Completion и поиск** — тот же resolver; BL completion provider отсутствовал на старте этой фазы; один общий provider
   в localization добавляет key preview/source, без параллельного provider в Toolkit. Search по key/value,
   labels locale/source; выбор target/insertion explicit и актуальный. Не вставлять
   текст перевода в BL. Сохранять многокорневую изоляцию и отмену долгого поиска.
5. **Начальный AI transport** — OpenAI-compatible Chat Completions:
   POST к явно вычисленному `<baseUrl>/chat/completions` (base URL включает `/v1`,
   если требует сервер), `model`, `messages`, bearer key. Ответ — текстовый JSON
   `{ "translations": { "en": "...", "uz": "..." } }` в message.content.
   Не требовать proprietary JSON mode/function calling/Responses API. Несовместимый
   provider сообщает ошибку; нет endpoint fallback, model discovery или silent retry.
   Размер payload/response ограничен, таймаут и AbortSignal; adapter совместим с
   заявленным VS Code engine, global fetch не предполагать.
6. **Настройки — предлагаемые, ещё НЕ manifest:**
   `bl.i18n.ai.baseUrl`, `bl.i18n.ai.model`, `bl.i18n.ai.translationPrompt`,
   `bl.i18n.ai.timeoutMs` (предположение default 30000, bounded). Endpoint/model
   user/machine scoped: workspace не подменяет host. API key — отдельная команда
   Set/Clear через SecretStorage, без `apiKey` setting. По умолчанию профиль не задан.
   HTTPS рекомендован; HTTP к локальному/self-hosted endpoint требует отдельного
   явного согласия на insecure transport, не включается автоматически.
7. **Prompt** — отдельный шаблон с allowlisted `{{sourceText}}`, `{{sourceLocale}}`,
   `{{targetLocales}}`, `{{key}}`. Пустой/ошибочный шаблон показывает ошибку, не
   подменяется молча другим. Provider-neutral default просит точные target locales,
   сохранение placeholders/markup и только согласованный JSON. Текст ресурса — данные,
   не инструкции; модель не получает файлов/инструментов/секретов/произвольных URLs.
8. **Send boundary** — только ручная кнопка, trusted workspace, host-side validation,
   preview endpoint/model/content/locales и согласие на передачу. Credentials
   разрешаются поздно из SecretStorage; webview не получает bearer key. Redirect
   выключен (сообщить пользователю); нет логирования body/token и raw provider errors.
   Изменение endpoint/payload требует нового согласия. Live-запросы не нужны для unit tests.
9. **Ответ** — strict JSON, точный set целевых locales, строки, placeholders и лимиты.
   Одна request generation + field revisions. Auto-fill только unedited selected fields;
   existing values не overwriting по умолчанию, изменённые показывают отдельный AI diff.
   Invalid/late responses не применяются; модельный output untrusted и escaped.
   Для неопознанного формата шаблона сообщить, что placeholder-check partial:
   не обещать полноценную ICU/format semantics эвристикой.
10. **Темы** — webview использует VS Code CSS variables, включая input/button/focus/
    error/warning, theme change без пересоздания draft. Inline мягкий inlay-style
    принадлежит add-inline-localization; style ≠ native InlayHintProvider. Не менять
    minimum engine только ради этого плана. Никакого CSS/DOM injection в editor shell.

## Risks / Trade-offs

- [Изменение общего NLS resolver] → сохранять source spans/guards; не обходиться demo samples.
- [Несовместимые compatible API] → точный минимальный wire contract и явная ошибка.
- [Приватный текст уходит в модель] → только выбранные значения, payload preview и consent.
- [Модель портит шаблон/текст] → schema/placeholder checks, AI provenance, manual review.
- [Документ изменяется при ожидании] → snapshots + field-level conflicts + preview guards.
- [Удалённая SSH-сессия/закрытое окно] → host lifecycle cleanup, abort; no stale UI updates.
- [Cancel не гарантирует отсутствие оплаты] → показать ограничение, без automatic retries.

## Migration Plan

1. Отдельно согласовать apply; завершить нужные части NLS/index/edit-plan.
2. Offline editor реализован и принят; по выбору пользователя следующий этап —
   AI adapter/input-first на mocks, search/completion после отдельного согласования.
3. Проверить UI в Remote SSH, светлой/тёмной/high contrast теме после разрешения.
4. Отдельно согласовать live endpoint, version bump и выпуск. Main specs не sync/archive
   до проверки. Отключение AI не ломает offline editor; отключение Toolkit — навигацию.

## References

- Пользовательский Marketplace reference: https://plugins.jetbrains.com/plugin/29957-i18n-toolkit
- VS Code theme tokens: https://code.visualstudio.com/api/references/theme-color
- Начальный Chat Completions contract: https://platform.openai.com/docs/api-reference/chat/create

Это design references, не внедрённые зависимости. На этом шаге ничего не отправлялось
в translation API; scraping проекта/проверка runtime/публикация не выполнялись.


## UX revision и текущая offline фаза

См. [ux-research.md](ux-research.md): первоисточники Microsoft/Google/GOV.UK/NNg/Mozilla
и конкретные acceptance критерии. Это supersedes прежний сценарий veto close:
обычная webview закрывается, local acknowledged draft восстанавливается. Discard
явный с подтверждением. Не имитировать невозможный onDidDispose cancellation.

Использовать существующие localizationModel/Presentation/index, не demo samples.
Общий parser получает value/entry/root source spans для surgical edits; новый
localizationEdits обслуживает existing translation и insertion missing key в
выбранный существующий ресурс. Create resource/rename — будущая фаза, не обещать.
Только trusted text-only WorkspaceEdit, применяет native buffers (штатные Undo и
Save), без прямых fs writes/auto-save. Preview хранит документы, версии, fingerprints
и отменяется при изменении draft/scope/source; повторный Apply не дублируется.

Workspace-local drafts bounded, несинхронизируемые: только key/scope/locale fields,
selected source identity и fingerprints, не целые XML. Persist error показывать,
не маскировать памятью как durable save. Активный panel сохраняет inputs при theme
switch; host messages сериализованы и input revisions защищают от stale acknowledgements.
После reload restored hash mismatch даёт конфликт, не silent overwrite/rebase.

UI: compact key header, locale/value rows, badges текстом, source selector при
ambiguity/missing, inline errors, aria-live status; Edit primary Preview, review
primary Apply in editor. Back/Close/discard/source secondary. Нет кнопки Auto
Translate, пока её этап не реализован. Zero network и no remote fonts.


## Compact UI revision (2026-10-06)

Пользователь отклонил первую offline UI-композицию как перегруженную. Основной
экран теперь узкий: ключ, строки «язык — перевод», Закрыть / Сохранить. Нормальный
found не получает banner; missing, conflict, unavailable и stale остаются видимыми.
Поля начинаются с одной строки и растут для многострочного текста. Подробности
checkout/storage/reload/discard скрыты в disclosure; source links и select — в
«Источник» каждой строки. Если target ещё не выбран, chooser раскрывается сразу,
не теряется обязательность явного выбора. Пользовательское раскрытие не сбрасывать
при storage ack. Неизвестные locales показывать как код, не угадывать язык.

«Сохранить…» запускает обязательную проверку, НЕ disk save. Компактная фаза review
показывает изменённые языки и пояснение native buffers; полные файлы/было/будет
доступны в disclosure. Primary «Применить», secondary «Назад». Version/hash/trust
guards, recovery и preview неизменны; окно остаётся Active webview, не native dialog.

Будущий AI flow (план, НЕ текущая реализация): «Перевести с ИИ» открывает отдельный
компактный шаг с полем исходного текста, source locale и target locales. Пользователь
вводит текст сам; допустимое предзаполнение из выбранного поля редактируемо и не
запускает сеть. Затем видны endpoint/model/payload и согласие, отдельное «Перевести»
отправляет запрос. Cancel до отправки — ноль сети. Ответ — proposals в draft, без
auto-save и без overwrite ручных правок. Prompt/endpoint/key настройки вне основного
экрана. Не добавлять неработающую AI-кнопку в offline UI.


## AI apply (2026-10-07)

User разрешил tasks 4/5; компактная композиция принята («сильно лучше»).
Реализация без нового SDK и без global fetch: Node http/https request с lazy import,
absolute timeout, bounded response, no redirects/retries/discovery. Настройки machine
scope, host читает global/default через inspect, не workspace override. Base URL без
userinfo/query/hash; secret per endpoint SHA256 в SecretStorage, Set/Clear команды
из Palette (не новые пункты ПКМ). Не переносить credential к другому endpoint.

AI input-first: отдельный шаг в той же Active вкладке, editable text и source locale,
checkbox targets только доступных строк. Подготовка host payload offline, затем
review endpoint/model/точных messages, Translate отправляет только prepared token.
Config/payload меняются — review требуется заново. HTTP дополнительно native modal
с явным согласием на незашифрованную передачу. API key разрешается после consent,
никогда не возвращается в webview. Endpoint/key не требуются для offline editor.

Запрос не держит очередь webview до конца: input/recovery продолжают работать;
Cancel/close/reload/discard/config change/trust loss инвалидируют generation и
cancel token. Поздний ответ не применяется даже если transport проигнорировал abort.
После валидного ответа auto-fill только unchanged missing/empty fields; existing
или edited поля получают отдельное предложение с кнопкой «Использовать». При
нажатии host проверяет row revision, чтобы не заменить ещё не показанный ввод.
Все строки валидируются до изменения draft; draft updates staged atomically в
памяти с лимитом сериализации, затем storage ack. AI provenance сохраняется для
изменённых восстановимых полей, AI source input/payload в storage не сохраняются.

Strict translations object/exact locales/string limits, XML controls, simple
{name}/{0}/${name}/$Key$/printf и literal markup preservation. Это частичная
проверка, не полноценный ICU parser; предупреждение видно в AI шаге. Raw provider
errors/bodies/token не логировать и не выводить; ошибки fixed safe codes. Ответ,
содержащий credential, отклоняется без отображения. Нет silent JSON fence extraction.


### Проверенные reference contracts (2026-10-07)

Прочитана официальная Chat Completions reference create (HTML):
https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/
Wire contract POST /chat/completions, model/messages, choices/message content.
Docs MCP markdown fetch этой страницы вернул 404; использован напрямую fetched
HTML, не выдаём failed fetch за прочитанный markdown. SDK/provider discovery нет.
Прочитаны VS Code API reference SecretStorage/workspace configuration inspect:
https://code.visualstudio.com/api/references/vscode-api
и Node 14.17 HTTPS request reference для минимального extension host:
https://nodejs.org/download/release/v14.17.0/docs/api/https.html
Это documentation requests, не live translation API, GUI или runtime проверки.


## AI compact form revision (2026-10-07)

По feedback screenshot после 1.2.5 устраняем визуальный дубль header и большой
технический абзац. Primary edit action «Проверить запрос» объясняет следующую фазу;
review «Перевести» сохраняет consent. Source/targets в компактной responsive grid,
native labelled checkboxes внутри мягких theme-aware рамок, все eligible selected
по умолчанию (existing/edited тоже). Source locale не target: его label скрывается
без clearing checked; при смене source остальные выборы не сбрасываются. Defaults
применяются при новом открытии AI формы, не на каждом host state. Short empty target
recovery, static technical notes disclosure, cancellation/payment note при ожидании.
Global storage/reload details на AI шаге скрыты, но доступны после возврата. Никаких
новых запросов, зависимостей, изменения backend contract, version bump или release.
Research/acceptance и exact sources в ux-research.md; новый GUI gate pending.


## Массовое принятие AI proposals (2026-10-07)

Пользователь разрешил apply компактного selection UX. Эта revision заменяет
per-row «Использовать» на contextual toolbar над rows и checkboxes у самих
предложений: общий «Все · N из M», одна secondary action «Принять все (N)» /
«Принять выбранные (N)». Save остаётся primary: принятие не пишет NLS. Native
checkbox semantics/mixed state, labels, focus/theme tokens; no extra modal.
Defaults только для новых opaque proposal tokens; acknowledgements не сбрасывают
ручной выбор. После manual edit предложение видно, но blocked с пояснением;
повторная генерация даёт свежий token. Host проверяет tokens/revisions и resources,
stages clone draft, затем commit всех selected rows либо ни одной. No silent skips.
Undo последнего acceptance хранит прежние fields/proposals и expected revisions
только в памяти панели, восстанавливает через новый monotonic revision, не whole
old draft (unrelated edits сохраняются). New affected edit/new AI run/reload/discard/
apply инвалидируют Undo. Fresh resource guard действует и на Undo. Storage errors
не откатываются скрыто и не маскируются: draft остаётся в памяти, показана ошибка.


## Поиск и выбор ключа (2026-10-07)

Разрешены tasks 3.2/3.3, не completion. Отдельная команда bl.searchTranslations /
«Z8BL: Найти перевод» в Palette и существующем BL submenu. Native QuickPick:
case-insensitive Unicode NFC substring по key/value/locale/source, слова запроса
AND; поиск использует полные значения, display compact/codicon-escaped. Custom
filter + alwaysShow не теряют совпадения из-за усечённого preview. 200 результатов
максимум на экран, title показывает actual total и предлагает уточнить запрос.
Loading/empty/invalid-resource/cancel состояния, no default result auto-accept.
Одинаковые key/locale/value объединяются с полным provenance; разные values
остаются отдельными conflict вариантами, incomplete locale помечен, no precedence.

Active workspace document задаёт checkout. Без editor discovery общих NLS
определяет distinct checkout roots; при нескольких нужен explicit chooser. Shared
rootFor сохраняет outer Git/submodule contract; workspace fallback не включает
отдельные nested Git checkout. Исключения/unsaved overlays — общий NLS-index.

После результата отдельный action picker: Edit Translation / Insert key / Open
source. Insert показан только при безопасном captured single selection в BL и
лексически вставляемом ключе. Поддерживаются точный локализационный литерал,
выбранная целиком double-quoted строка, пустые кавычки либо code position/selection;
comments/обычные строки под курсором/unterminated literals/multiline/multi-cursor
не заменяются угадыванием. Результат всегда quoted "$Key$", не текст перевода.
Version/text fingerprint/editor identity/selection/scope/resource guards до edit
и внутри builder callback; native TextEditor.edit с undo stops, no save. Даже dirty
BL допустим, если captured version актуальна. Editor switch не перенаправляет edit.

Search records — host model, не command arguments из source. Перед действием
проверяются epoch/current snapshot + выбранные source hash/spans. Source duplicates
требуют explicit chooser; собственное открытие NLS инвалидирует индекс законно,
затем fresh source/hash/root проверяются заново, без отмены собственной навигации.
ToolKit host-only openSearchTranslation проверяет существующий key и expected root;
публичная bl.editTranslation сохраняет прежнюю проверку наличия BL литерала.
Opening/Edit/Search offline и не модифицируют BL/XML. Main specs не sync/archive;
GUI/Remote SSH acceptance отдельный gate. Minor bump по SemVer в конце итерации.


## Family-scoped целевые ресурсы (2026-10-07, исправление 1.3.1)

Пользователь подтвердил исправление после screenshot: global locale existence не
означает, что перевод можно писать в любой модуль. Набор — точная папка + basename
без locale suffix общего parser (включая региональные locales). Anchors — valid
resources с текущим key во всех languages. Options/locale rows строятся только из
существующих файлов anchored families. Несколько anchors/families не получают
runtime precedence: сохраняются все связанные варианты; unrelated family нельзя
использовать как insertion fallback, даже в той же папке. Если anchors нет, набор
не угадывается по имени key/BL-класса; options пустые, понятное recovery сообщение.

Один existing source или один valid missing-key sibling file selected автоматически.
Дубли/конфликты/multiple targets требуют explicit source. New file creation не
входит в исправление. Только locale/required/related family locales и restored
locales могут образовывать rows; related unavailable ресурс не становится missing.
Отсутствующий язык по required/active/старому draft остаётся visible с объяснением,
без selectable AI target. Ресурс без key != отсутствующий файл.

AI targets: related options nonempty, status != unavailable, not stale. Проверка
host Prepare/Send и fresh source до response/apply; webview checkbox отсутствие не
security gate. Старый target из чужого family не restore/rebase: value сохранён
для копирования, target null/stale, Apply blocked, AI target unavailable. Черновик
без saved target не получает молча другую identity; обычные hash/version/preview
и explicit native Apply/no-save contracts сохраняются. Offline inline/search index
по-прежнему checkout-wide, только Toolkit edit targets family-scoped.


## UX revision 1/2/4/5/6 (2026-10-07, 1.3.2)

Пользователь явно выбрал спеки+реализацию этих пунктов. AI form redesign (3) не
разрешён. Summary из host draft: реальные anchored families, exact relative path
в details, single basename + имеющиеся locales; при нескольких наборах явно
показывать количество, не угадывать один module. Sole selected target не имеет
видимого select/disclosure, только «Открыть файл»; ambiguity/сохранённый null target
сохраняют explicit chooser. No file row — static explanation без пустого textarea;
recovered value остаётся read-only/copyable. Broken resource остаётся unavailable.

Primary edit «Проверить изменения…», review «Применить в файлы», количество файлов
и буферный/no-auto-save контракт видимы. Draft acknowledgement не равен disk save,
после Apply явно Save/Save All + Undo. AI proposal comparison показывает нынешнее
значение и предложение рядом (responsive stack), native selection/batch/undo
не меняются; comparison обновляет current из фактического ввода, не old snapshot.

Ошибки endpoint/model/prompt/timeout конкретны и указывают только известные setting
IDs. Recovery buttons — host allowlisted actions: открыть user settings выбранного
из host error ID, existing credential command, explicit reload с прежним discard
confirmation. Webview не может передать произвольный command/settings/path.
Source stale warning имеет adjacent recovery; raw provider exceptions не раскрывать.
Поля/focus/manual selection сохраняются на ack; no CSS/framework/dependencies/engine
change. UI/theme/Remote SSH и live provider tests — отдельный gate.


## Автодополнение локализации (2026-10-07, task 3.1, 1.3.3)

Пользователь явно выбрал implementation completion. Один BL/file provider в общем
localization, триггеры $ и ., manual Ctrl+Space. JS completion не меняется. Shared
lexical string scan пропускает comments/other strings; контекст только double-quoted
строка, начинающаяся с $, current line, ASCII localization key grammar общего
scanner. Поддерживаются "$Workspace.t$", "$Workspace.t", "$Workspace.t (без closing
quote), "$" и "$$". Cursor в key или на его конце; после closing $/quote не предлагать.
Invalid embedded text/escapes/multiline/ordinary string/single quote не чинить.

Main CompletionItem.range начинается после opening "$ и заканчивается перед
closing quote либо на конце текущей строки. InsertText = key + $ + closing quote
только если её не было. Range single-line и содержит cursor; не использовать
additionalTextEdits/snippets/commands. FilterText key+$, label ключ, detail locale/
translation или missing/conflict/unavailable без fallback, untrusted Markdown
preview с provenance. Replacement охватывает suffix key+optional closing $, не
оставляет старый хвост и не дублирует delimiters. Document offset — UTF-16 native.

Checkout-wide read-only shared snapshot/parser/resolver, не family edit filtering.
Group keys один раз; resolve по sources ключа + всем invalid resources даёт прежние
conflict/incomplete правила без полного повторного сканирования corpus на ключ.
Candidates case-insensitive prefix, deterministic order, максимум 200/list и
isIncomplete для продолжения фильтрации. Documentation bounded 8 sources/1024 chars
на value; source Markdown не trusted. Невставляемые NLS keys не предлагаются.
Unsaved overlays/exclusions/multi-root/submodule/scope контракты общие.

Version/snapshot epoch/cancellation/root guards до/после await; disposed/changed
context возвращает пустой список, без stale replacement. No fs writes/network/
auto-Apply; выбор использует native completion edit/Undo. UI/Remote SSH остаются
пользовательской проверкой, fake provider tests не доказывают popup rendering.


API contract сверён с официальной reference VS Code:
https://code.visualstudio.com/api/references/vscode-api (2026-10-07; web tool
вернул пустой результат, официальный HTML прочитан напрямую). CompletionItem.range
single-line/contains requested position, filterText использует prefix из range,
CompletionList.isIncomplete вызывает повторный запрос при вводе. Не менять
insertText/range через resolveCompletionItem и не вводить additionalTextEdits для
delimiter repair. Это reference contract, не GUI/Remote SSH acceptance evidence.


## Явное добавление языка (2026-10-07, 1.3.4)

Точечная фаза resource create заменяет прежнее «ещё нет» только для создания языка
в anchored family. Rename остаётся будущей задачей. UI — secondary text action
«Добавить язык…» в свёрнутом «Источники и подробности»; скрыт при отсутствии anchors,
в review/AI, блокируется во время работы. Нет новых context-menu/Palette commands.

Host выбирает sole family либо native QuickPick из actual anchor identities,
затем locale (common codes + явный ввод другого кода). Общий locale suffix parser
валидирует региональные коды и normalized collision. Путь строит только host:
existing directory + family basename + canonical suffix. Webview передаёт только
action, никогда path/locale/family как доверенные параметры. Preview native modal
показывает полный путь и раздельную семантику: createFile создаёт файл на диске;
insert XML scaffold меняет новый native buffer, Save пользовательский. Новый
буфер используется общим индексом через обычную discovery+overlay, не поддельный
resource/untitled fallback. Skeleton содержит XML declaration и стандартный Java
properties DOCTYPE, без DTD fetch, entry/comments/копирования языковых значений.

До preview и повторно после consent проверить trusted workspace/alive, root,
общую discovery epoch и hashes выбранного family. Проспективные exclusions
используют те же patterns индекса через штатный VS Code selector matcher, не
второй glob parser. Parent directory должен существовать в реальном checkout;
symlinked directory отклоняется с пояснением, без создания папок. Directory listing
и open buffers проверяются на case/locale-equivalent collisions, включая malformed
и undiscovered ресурсы. Native createFile overwrite=false/ignoreIfExists=false
защищает от появившегося exact-path файла. Это не защита от злонамеренной подмены
директорий другим процессом между проверкой и editor API.

Создание использует отдельный WorkspaceEdit createFile+insert только для нового
ресурса, не смешивается с Apply текущих переводов. Native resource operations не
обещают text-only all-or-nothing: при failure проверить существование и честно
сообщить возможный частичный create, не удалять/перезаписывать файл автоматически.
После успешного create явно инвалидировать discovery; новая строка доступна только
после shared parser/discovery. Если индекс не видит файл — сообщение, без bypass.
Прочие row values/options/revisions/proposals/Undo сохраняются. Для затронутого
locale обновить options, сохраняя прежнюю выбранную identity; clean no-file row
подключить к явно созданному ресурсу. Edited/stale/null восстановленный row не
перебазировать, value/provenance оставить. Добавлять DOM rows без rebuild текущих
полей/selection/focus. После записи хранить acknowledgement, но не выдавать ошибку
storage или индекса за отсутствие уже созданного файла. Close во время native
operation не отменяет завершённый create, повторный клик не создаёт дубль.

Cancel выбора/preview — никаких disk/buffer/draft changes, network всегда ноль.
Новый язык с отсутствующим key продолжает получать missing Warning; AI разрешён
только после обнаружения валидного файла, существующие fresh guards неизменны.
GUI/Remote SSH/native file Undo требуют пользовательского теста; mocks не заменяют его.


Native contracts проверены по официальному исходнику VS Code 1.60.0:
https://github.com/microsoft/vscode/blob/1.60.0/src/vs/vscode.d.ts
(createFile no overwrite/ignore, insert/RelativePattern) и
https://github.com/microsoft/vscode/blob/1.60.0/src/vs/workbench/api/common/extHost.api.impl.ts
(languages.match использует URI/languageId). Первоначальная попытка URL
extHostApiImpl.ts дала 404; прочитан правильный extHost.api.impl.ts. Web tool
вернул пустой ответ, не является evidence. Native GUI/Undo не проверены.


## Rename локализационного ключа (2026-10-07, task 7.1)

Действие hidden в свёрнутых источниках, не новый пункт ПКМ/F2 и не Symbol Rename.
Native InputBox валидирует общий LOCALIZATION_KEY (1–256 chars, no trimming silently).
Не выполнять rename без trusted workspace/valid anchor, при dirty current draft,
AI proposals/acceptance Undo либо существующем target-key draft/panel. Объяснить
«сначала примените или отмените черновик/предложения»; ничего не discard. Другие
ключи/черновики сохраняются; их stale source hash guards продолжат работать.

Общий localization.renameSnapshot использует те же rootFor/excludes/discovery/parser,
обнаруженные unsaved NLS+BL buffers, force discovery и read failures как blocking.
Отдельный rename revision отслеживает eligible BL watcher/buffer lifecycle, не
инвалидируя read-only NLS rendering на каждое BL событие. Имена/контент всех scoped
source files fingerprints входят в подпись preview: Apply перепроверяет membership,
вновь появившиеся references/collisions, versions всех opened touched документов,
root/trust/revisions после всех await. Self-open документов в Prepare законно
меняет revision; final snapshot после opening должен совпадать по контенту.
Нет partial результатов/auto-rebase; changed signature требует новый preview.

Pure i18nRename — bounded план (10k files, 64 Mi UTF-16 chars, 20k replacements),
общий BL literal scanner и shared surgical XML key-span edits. Один anchored
family + ровно одна old-key запись на locale; multiple families/duplicate entries
блокируются даже при одинаковых values, runtime precedence не угадывается. Любой
невалидный scoped NLS блокирует проверку old/new keys, не skipped. New key collision
в любом NLS или точном BL literal блокирует rename. No anchors — no rename.

В BL меняется только key span между "$ и $", не кавычки/доллары/ordinary strings/
comments/escaped literals/dynamic expressions. NLS меняет raw attribute span общего
parser, включая encoded old key; XML проверяется повторно. Значения/CDATA/comments/
BOM/newlines/quotes сохраняются. Preview группирует по files: BL/NLS, полный
relative path, строки замен, old→new и counts. Всегда видимое ограничение: только
точные BL-литералы и NLS; JS/dynamic/excluded files вне scope. Translation Apply UI
не изменяет семантику; rename отдельный kind в том же review и той же Active вкладке.

После explicit Apply один text-only WorkspaceEdit, no disk writes/save/create.
False/reject не выдаётся за успех. После success панель переходит на new key/new
map identity/title, новый clean draft из fresh NLS, old clean storage slot удаляется
после ack. Post-commit storage/index errors сообщают уже состоявшийся rename;
без rollback/retry. Close во время apply не отменяет committed edit, next open
нового key работает. Native Undo меняет файлы; панель не имитирует rename Undo и
при external Undo предлагает явное reload. GUI/Remote SSH/native undo ещё gate.


Rename physical-path guard дополнительно отклоняет aliases одного touched файла
и выход по symlink вне real checkout; source discovery duplicates блокируются до
plan. Реальный root/path повторно проверяется перед native dispatch. Это не
security boundary против злонамеренной FS-подмены другим процессом между последней
проверкой и редактором/последующим пользовательским Save. Native GUI Undo не тестировался.
