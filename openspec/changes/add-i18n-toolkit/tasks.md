# Tasks

Статус: пользователь 2026-10-06 разрешил UX research/spec revision и offline Edit Translation. 2026-10-07 разрешены AI задачи 4/5 и mock tests/docs. Теперь отдельно разрешены Search/select/insert задачи 3.2/3.3. Completion 3.1 отдельно разрешён пользователем 2026-10-07; live HTTP, UI запуск и release не разрешены. Compact UI принят пользователем.

## 1. Общий NLS и черновик

- [x] 1.1 Подключить общий language-aware resolver/edit-plan из add-inline-localization без второго parser; проверить реальные XML fixtures, несохранённые ресурсы, default ru, no fallback, source-only scope без target/build и checkout isolation.
- [x] 1.2 Добавить per-key/per-locale draft со missing/empty/conflict, provenance и field revision; проверить сериализацию без секретов, conflicting sources и восстановление выбранного scope без смешения checkout.

## 2. Offline Edit Translation

- [x] 2.1 Добавить явное открытие из BL key/hover/контекстного Z8BL submenu и webview текущей группы; проверить source context, unknown key, отсутствие split и ноль HTTP/discovery/auth calls при открытии.
- [x] 2.2 Реализовать строки locale слева и input/textarea справа, missing/conflict badges, source links, видимый active locale и preview/Apply/Close/discard с local draft recovery; проверить dirty draft, empty existing value, keyboard navigation, доступные labels и discard без изменений файлов.
- [x] 2.3 Подключить theme CSS variables, CSP/nonce, escaping и host-side message validation; проверить malicious key/value/AI text/messages, отсутствие command/HTML execution, смену light/dark/high contrast без потери draft.
- [x] 2.4 Подключить многофайловый preview/Apply; проверить versions всех буферов, конфликт после preview, отмену, XML entities/comments/newlines, отсутствие unrelated overwrite и insertion missing entry в выбранный существующий ресурс. Create нового ресурса/rename остаются отдельной будущей задачей.

## 3. Ключи и поиск

- [x] 3.1 Реализовать единый общий completion локализации preview перевода/source без второго provider-конфликта; проверить "$Workspace.t$", частично введённые $/кавычки, CRLF, comments, unsaved keys и вставку только ключа.
- [x] 3.2 Добавить поиск по key/value с locale/source, scope chooser, loading/empty/cancel и resource navigation; проверить поиск «Документы», многоязычные совпадения, неоднозначность и target exclusion.
- [x] 3.3 Добавить явный Select/Insert key со snapshot исходного BL/editor/range; проверить active-editor switch, dirty source и отказ от stale insertion/вставки самого перевода.

## 4. AI configuration и transport

- [x] 4.1 Добавить user/machine endpoint/model/prompt/timeout settings и Set/Clear API key через SecretStorage; проверить отсутствие ключей в settings/XML/webview/logs, ошибки template variables, отсутствие настроенного provider и полный offline editor без AI.
- [x] 4.2 Реализовать минимальный Chat Completions adapter по design без network discovery/fallback/automatic retry; проверить golden request/response mocks, baseUrl с /v1 без дубля, unsupported provider, bounded response, timeout/abort и совместимость с минимальным VS Code engine.
- [x] 4.3 Добавить host Send gate: workspace trust, endpoint/payload/locale preview, consent, late key resolution и запрет redirects; проверить spies: все offline UI-события дают ноль network calls, malformed messages не отправляют данные, смена endpoint сбрасывает consent, insecure HTTP требует отдельного разрешения.

## 5. Auto Translate и review

- [x] 5.1 Подключить ручную кнопку, waiting/Cancel, выбранные source/targets и настраиваемый prompt; проверить preview перед отправкой, ноль запроса при отмене, блокировку дубль-click, отсутствие отправки всего проекта и инструментов модели.
- [x] 5.2 Валидировать strict JSON/locale set/string values/placeholder integrity и пометить AI proposals; проверить missing/extra locales, invalid JSON, scripts/markup/форматные параметры, escaped multiline и partial placeholder-check без ложного обещания полноты.
- [x] 5.3 Auto-fill только неизменённых выбранных полей draft, остальное — явный AI diff; проверить ручные edits во время ожидания, existing translations без overwrite, late/stale ответ после cancel/close и неизменность XML до Save.
- [x] 5.4 Показать безопасные errors/timeout/cancel без потери draft или credentials; проверить sanitized snapshots, отсутствие auto retry и предупреждение о негарантированной отмене вычисления/оплаты у провайдера.

## 6. Regression и acceptance

- [x] 6.1 Добавить unit/provider/webview/edit/transport mocks и прогнать npm test, оба CLM corpora и строгий OpenSpec validation; зафиксировать реальные результаты, не выдавать mock за live/runtime проверку.
- [ ] 6.2 После отдельного разрешения проверить offline окно, theme switching, keyboard flow, completion/search и Remote SSH; отдельно согласовать live endpoint и тестовые тексты, не использовать production/приватные данные без согласия.
- [ ] 6.3 После реализации обновить README/AGENTS с фактическими settings/commands/limitations, проверить VSIX состав и sync/archive только подтверждённого поведения; Version bump — по постоянному правилу пользователя; release требует отдельного запроса.

## 7. UX revision и будущие resource edits

- [x] 7.1 По отдельно разрешённому запросу реализовать secondary Rename key: scoped exact BL+NLS surgical versioned preview/native buffer Apply, collisions/ambiguity/read/trust/dirty-draft guards, clean panel identity update. Проверить pure/host/DOM/CLM fixture и source membership/version/races; bump 1.3.5. Создание языка выполнено по 7.8.

- [x] 7.2 По явному запросу пользователя провести UX research по первоисточникам, записать UX revision/acceptance в спеки и реализовать approved offline phase (не AI/search/completion).

- [x] 7.3 Упростить offline UI по compact revision: disclosure технических деталей, one-line growing fields, only problem warnings, conditional source chooser и компактная обязательная review; проверить DOM-mock focus/ack/disclosure/ambiguous source. AI input-first только спецификация; GUI acceptance отдельно.

- [x] 7.4 По screenshot feedback изучить primary UX sources и реализовать AI compact form/default checked: убрать source checkbox из видимых целей, сохранять выбор при source change/ack/back, progressive disclosure, short empty recovery и keyboard/theme styling; проверить actual-script DOM mocks/no source payload и regression без live/UI запуска.

- [x] 7.5 Массовое принятие AI proposals текущего ключа: default checked, общий mixed checkbox, счётчик/частичный выбор, одна кнопка; atomic revision/token/source/size guards, отмена последнего принятия без overwrite новых edits, safe storage acknowledgement. Проверить host и actual-script DOM mocks; без live API/GUI/version bump.

- [x] 7.6 Исправить family-scoped target selection: matching directory+locale-free basename по источникам key, sole target autoselect, no unrelated locales/AI targets и no file creation; проверить duplicates/conflicts/unknown/broken, restore legacy drafts, host Send/Apply/late source guards, actual-script DOM и реальный CLM Action.dictionary.clear.title.

- [x] 7.7 Реализовать одобренную UX-ревизию пунктов 1/2/4/5/6: общий честный NLS summary, скрытый sole chooser/direct source, no-file static row/copyable legacy, draft-versus-buffer copy, current/proposal comparison, specific AI config errors и guarded recovery actions. Проверить DOM/controller/errors/focus/security/regressions; пункт 3 AI form redesign вне scope.

- [x] 7.8 Реализовать необязательное «Добавить язык…» в свёрнутых источниках: anchored family/locale/native path confirmation, guarded no-overwrite create/scaffold/discovery, сохранение drafts/proposals/null targets. Проверить cancellation/case-regional collisions/exclusions/trust/source races/partial failure/DOM и bump 1.3.4; без CLM writes/live API/GUI.

## Evidence текущей offline фазы (2026-10-06)

Реализованы localizationEdits/i18nDraft/i18nView/i18nToolkit, shared parser spans и
snapshot guards; команда/ПКМ/isolated hover action, Active webview без split,
rows/value/status/source, explicit targets, loading/persist acknowledgement,
local bounded draft recovery. Discard/reload подтверждаются, close сохраняет
acknowledged draft. Preview/back/Apply; text-only native WorkspaceEdit без disk
save. XML comments/CDATA/entities/CRLF/BOM, unrelated keys сохранены surgical edits.
Apply требует trust и проверяет source hash/version/scope. No AI/network.

218 unit/provider/pure-model/actual webview script DOM-mock тестов прошли. Проверены
focused input без disabling при storage ack, typed value при смене source, stale
ack/session/row IDs, syntax/CSP, duplicate targets, missing/empty, multilang Apply,
dirty/stale/reload/restore/discard/storage errors, source groups, checkout isolation,
exclusions после preview и close во время async подготовки. **6.1 частично:** offline
проверки готовы; future transport/edit-rename tests pending с будущими этапами.
Все три CLM corpus checks прошли (619 BL/3866 definitions/283 records/52 constants,
7 JS↔BL checks, 26 NLS/2831 entries). CLM не изменён; это не runtime или GUI test.

**6.3 частично:** README/AGENTS/config actual state обновлены; cached vsce ls проверен:
все 7 localization/toolkit modules включены, test/openspec/.agents исключены.
VSIX installation/UI/live/network/assistive-technology не запускались; baseline
не sync/archive. Current version 1.2.2, без нового bump/commit/push/publish.
Пользователь подтвердил предыдущий integrated inline в общем («вроде всё работает»),
не новый Toolkit UI и не поимённую полную editor/theme matrix.


## Evidence compact revision (2026-10-06, 1.2.3)

7.3: компактный key/locale/value экран, one-line growing fields, warnings только
при проблемах, collapsed source/global details; explicit missing/duplicate target
раскрыт сразу. Обязательный preview сохранён в компактной review-фазе, полный diff
раскрываемый. Не потеряны guards/storage recovery, пользовательские disclosure/focus
при ack и Back. AI input-first flow — только спецификация, кнопка/HTTP не добавлены.
README/AGENTS обновлены. 220/220 npm tests, все три CLM corpora и 11/11 strict OpenSpec
проверок прошли; node --check двух UI/controller модулей и git diff --check прошли.
DOM-mock выполняет реальный webview script, но не проверяет фактический рендер,
темы, screen reader или Remote SSH. Первая UI отклонена; новая GUI acceptance pending.
CLM не менялся. Version 1.2.3 не повышена; commit/push/publication не выполнялись.


## Evidence AI apply (2026-10-07, local dev 1.2.4)

Пользователь принял compact UI («сильно лучше») и выбрал AI phase через уточнение.
Tasks 4.1–5.4 выполнены: i18nAi.js, machine/user-only settings, endpoint-bound
Set/Clear SecretStorage, input-first form/request review, explicit prepared Send,
HTTP consent, bounded Node transport (no SDK/global fetch), no redirects/retries,
cancel/absolute timeout, strict JSON/exact locales/partial placeholders/markup,
atomic draft fill и existing/manual proposals с revision-bound accept. Input queue
работает во время сети; late/config/close/reload/source guards, storage errors и
AI provenance проверены. Недоступные источники не становятся ложным missing.

6.1 выполнена в текущем scope: 235/235 npm tests, включая 13 AI config/transport/
controller mock tests и 2 AI actual-script DOM-mock tests. Проверены safe prompt
variables, payload limits, redirect/status/raw-error sanitization, abort/timeout,
missing key/trust/config/forged messages, endpoint credential isolation, zero network
до Send, HTTP consent, cancel во время secret lookup, no partial fill, no manual
clobber, stale accept/source, source selection preserving provenance, draft restore
и storage failure. CLM corpus: 619 BL/3866 definitions/283 records/52 constants;
7 JS↔BL checks; 26 NLS/2831 entries. Никаких HTTP runtime/live API/GUI тестов:
transport использует EventEmitter mocks, UI — fake DOM, не реальную отрисовку.

11/11 strict OpenSpec checks, syntax всех 4 toolkit/AI модулей и git diff --check
прошли. README/AGENTS/config actual state обновлены. 6.3 частично: cached vsce ls
включает i18nAi.js и остальные 7 localization/toolkit modules, test/.agents/openspec
исключены; baseline sync/archive pending с недоделанными этапами и AI acceptance.
Не проверены реальные endpoint/Remote SSH AI flow/themes/assistive technology.
Search/completion/resource create/rename не реализованы. CLM не изменён.
Версия осталась 1.2.4; bump/commit/push/publish не выполнялись.


## Evidence AI compact UX revision (2026-10-07, 1.2.5)

7.4 выполнена: прочитаны Fluent Checkbox, IBM Carbon Form, VS Code Webviews и
NN/g Progressive Disclosure; exact references/limits в ux-research.md. Web tool
вернул пустые результаты; HTML fetched напрямую и прочитан, не fabricated citations.
При открытии все доступные target locales selected независимо от existing/edited.
Source скрыт, не становится target; смена source/host ack/review back не сбрасывают
пользовательский выбор. Source-only/none selected получили recovery. Compact grid,
single AI context header, softer checkbox group, short draft note + advanced notes
disclosure. Consent и cancel/payment ограничение видимы; raw data safety неизменна.
Focus переводится к Send/Cancel/input при смене фаз, но ответ не отбирает фокус у
пользователя, редактирующего translation row. Storage details скрыты только в AI.

238/238 npm tests (3 новых actual-script DOM mocks + обновлённый default target
regression), все три CLM corpora, 11/11 strict OpenSpec, node --check i18nView.js и
git diff --check прошли. Проверены defaults existing/edited, unavailable omission,
source toggle/deselection/ack/new-open, no hidden-source payload, empty recovery,
phase focus/manual input, semantic disclosure markup. Это fake DOM, не real layout.
Новое GUI/theme/Remote SSH acceptance не получено; live API/browser/runtime не
запускались. CLM/submodules не менялись. Version 1.2.5 сохранена; no bump/commit/push.


## Evidence массового принятия (2026-10-07, local dev 1.2.7)

7.5 выполнена по явному «го»: contextual toolbar и native checkboxes у proposals
текущего ключа, default checked, mixed/select-all/none, одна batch button с count.
Выбор сохраняется при ack/subset acceptance. Недоступные/stale/manual-after-proposal
строки видны с причиной. Убраны per-row buttons и legacy single acceptance handler.
Batch token/proposal+row revision/session/sequence/resource hash/scope/total draft
size guards; staged all-or-nothing commit. Source/late manual edits не overwrite.
Undo последнего acceptance возвращает values/targets/AI provenance/proposals с
новыми monotonic revisions/tokens, не откатывает unrelated rows. New affected edit,
new AI run/reload/discard/apply инвалидируют Undo. History/proposals только in-memory,
reopen восстанавливает лишь acknowledged draft. Ошибки storage явно unsaved, no
silent rollback; XML/HTTP при acceptance/Undo не меняются/не вызываются.

249/249 npm tests прошли: 11 новых host/actual-script DOM-mock regressions, включая
partial selection/focus/ack, malicious IDs/tokens/duplicates, source change, manual
revision race, aggregate size atomic rejection, undo/new edit/provenance/reopen,
new run/reload/apply invalidation и storage failures. Все три CLM corpus checks
прошли: 619 BL/617 classes/3866 definitions/283 records/52 constants; 7 JS↔BL checks
с target excluded; 26 NLS/2831 entries. Strict OpenSpec: 11/11, syntax трёх draft/UI/
controller modules и git diff --check прошли. README/AGENTS/spec/design/research
обновлены; main specs не sync/archive. GUI/темы/Remote SSH/live API не запускались;
DOM mocks не доказывают фактическую отрисовку. CLM/submodules не менялись. Версия
1.2.7 оставлена; bump/commit/push/publish не выполнялись.

## Evidence поиска/выбора/вставки (2026-10-07, local dev 1.3.0)

По явному «го» выполнены 3.2/3.3. i18nSearch.js: native key/value/locale/source
QuickPick, full-text Unicode NFC/case-insensitive AND terms, capped 200 с actual
count/loading/empty/partial-index/cancel. Same key/locale/value сгруппированы с
полным provenance; conflicting values показаны отдельно. Context checkout из
active workspace document; без него distinct roots с explicit chooser. Shared
NLS discovery/rootFor/unsaved overlays/exclusions, parent workspace fallback не
смешивается с отдельным nested Git checkout. No second XML parser/network/settings.

Explicit Edit/Insert/Source actions. Search Edit позволяет существующий NLS key,
даже отсутствующий в BL, через host-only guarded Toolkit entry; публичный hover/
Palette editTranslation сохраняет lexical source validation. Duplicated source
chooser, Active group jump и точный key span; собственный NLS open event не ломает
навигацию, fresh source/root/hash повторно проверяются. Insert captured BL version/
text/editor/single selection/lexical range + NLS/scope/trust/cancel guards до native
edit и в callback. Quoted "$Key$", не translation; no duplicate delimiters,
comments/ordinary cursor strings/multiline/multi-cursor/invalid keys excluded.
Native Undo stops/no save; stale actions дают concrete retry без auto-rebase.

262/262 npm tests прошли, включая 13 новых pure/native-picker/controller regression
тестов: multilingual/full-long-text/NFC, empty/conflict/duplicates/incomplete,
source chooser/self open, unknown-in-BL editor entry, dirty native insertion,
editor/document/selection/trust/callback races, sources/delete/exclusions change,
checkout/no-context isolation, unsaved NLS, cap/codicon-safe text, cancel/disposal
и genuinely delayed/stale loading. Нативная GUI не запускалась: mocks не доказывают
реальные theme/layout/accessibility/Remote SSH поведение.

Все три CLM corpus checks прошли: 619 BL/617 classes/3866 definitions/283 records/
52 constants, 7 JS↔BL checks (target excluded), 26 NLS/2831 entries. NLS corpus
дополнен поиском «Документы» → Workspace.title/ru → реальный Toolkit ru/en, без
source writes; последний NLS прогон выполнен на 1.3.0. Strict OpenSpec 11/11,
syntax и git diff --check прошли. Cached vsce ls включает i18nSearch.js и все 8
существующих localization/Toolkit modules, test/openspec/.agents исключены.

README/AGENTS/config/change artifacts обновлены. Версия поднята один раз по SemVer
1.2.8 → 1.3.0 (совместимая новая функция), package/lock root версии согласованы.
CLM/submodules не менялись. Main specs не sync/archive; completion/resource create/
rename остаются будущими этапами. Commit/push/publish/live HTTP/GUI не выполнялись.


## Evidence family-scoped target исправления (2026-10-07, local dev 1.3.1)

По отдельно подтверждённому запросу выполнен 7.6. Shared locale suffix parser даёт
family identity exact directory+stem. Anchors только валидные источники key;
Toolkit rows/options ограничены их families. Sole existing source или missing-key
sibling auto-selected, duplicates/conflicts explicit. No anchors — no guessed
module. Unrelated malformed resources не ломают family; related broken — unavailable.
Нет NLS-файла языка — нет AI target, active/required/restored row остаётся с
пояснением и copyable read-only text. No automatic resource creation.

Legacy unrelated target не мигрируется: null/stale/value/AI provenance сохранены,
включая повторное сохранение/восстановление stale draft. Saved null не получает
новый target автоматически. Host Prepare/Send (в том числе после async secret/
HTTP consent)/response/accept/undo/preview/Apply recheck fresh family membership;
source hash/version/size guards и native buffer-only no-save сохраняются.

272/272 npm tests: 10 новых pure/controller/actual-script DOM regressions для
CLM-shaped family isolation, regional locales, ambiguous/missing/default insertion,
unknown/broken resources, legacy stale/null recovery, absent/stale AI checkboxes,
forged Prepare, deletion перед Send/во время credential lookup, disappearance
anchors во время response и до preview/Apply. Моковые API, реальной сети нет.
Реальный CLM NLS corpus: 26 resources/2831 entries, Action.dictionary.clear.title
в ClearAction.bl открывает настоящий Toolkit controller; только core_ru/core_en
selected, uz active row без options. CLM BL corpus: 619 files/617 classes/3866
checks/283 records/52 constants; JS corpus: 7 checks, target excluded. Strict
OpenSpec 11/11, syntax и git diff --check прошли. Cached vsce ls включает все
9 localization/Toolkit modules, не включает test/openspec/.agents.

README/AGENTS/config/change artifacts обновлены; версия один раз 1.3.0 → 1.3.1,
package/lock root synchronized. CLM/submodules не менялись. GUI/Remote SSH/live
provider не запускались; mock DOM не доказывает отрисовку. Commit/push/publication,
sync/archive не выполнялись; остальные pending tasks не отмечены выполненными.


## Evidence UX revision 1/2/4/5/6 (2026-10-07, local dev 1.3.2)

Пользователь явно выбрал спеки+реализацию 1/2/4/5/6; 3 AI form redesign исключён.
Research официальных VS Code/Carbon/Fluent/Atlassian/NNg страниц зафиксирован в
ux-research.md с ограничениями доступа: web tool пустой, primary HTML проверен
напрямую; HAX timeout не выдаётся за новый verified источник/метрику успеха.

Host draft resourceSets дают честный header single set/locales либо multiple
count; полные реальные пути в details. Sole selected target: direct «Открыть файл»,
select/disclosure скрыты; ambiguous/saved-null explicit chooser сохранён. No-file
row static без пустого textarea, recovered text read-only/copyable. Related broken
отдельно unavailable; existing file без key объясняет insertion. Нет создания NLS.
Primary «Проверить изменения…» / «Применить в файлы», review distinct file count,
черновик != disk save, native buffer Apply и штатные Save/Undo без изменений.

AI comparison «Сейчас / Предложение ИИ» safe textContent, обновляет manual input
сразу, длинные/многострочные values stacked, narrow viewport responsive. Batch
selection/accept/Undo guards неизменны; AI form не перестроена. Recovery specific
baseUrl/model/prompt/timeout errors, host allowlisted settings/SecretStorage commands,
source reload через прежний explicit confirmation. Cancelled reload/discard теперь
сохраняет draft/proposals/guarded Undo; только confirmed reset очищает. Stale/hash/
revision проверки Undo по-прежнему обязательны. Focus не идёт в hidden no-file row.

283/283 npm tests, включая 11 новых actual-script DOM/controller regressions:
resource summary/paths/sole source/null chooser, no-file/recovered/broken, missing
insertion, live comparison/stack/focus, bounded recovery messages/forged command,
4 specific settings/zero network, credential SecretStorage, cancellation сохраняет
proposal tokens/undo, draft-versus-buffer labels и Back skipping hidden textarea.
Mock APIs/DOM, не GUI. Все три CLM corpora passed: 619 BL/617 classes/3866 checks,
283 records/52 constants; 7 JS checks с target excluded; 26 NLS/2831 entries,
реальный ClearAction Toolkit core_ru/core_en/no-uz regression. Strict OpenSpec
11/11, syntax и git diff --check passed. Cached vsce ls включает 9 существующих
localization/Toolkit modules; test/openspec/.agents не shipped.

README/AGENTS/config/proposal/design/spec/research/tasks обновлены, main specs
не sync/archive. Один patch bump 1.3.1 → 1.3.2, package/lock root согласованы.
Затронут только bl-language-support; CLM/submodules не менялись. GUI/themes/Remote
SSH/live provider не запускались, commit/push/publication не выполнялись. 7.7
выполнен; оставшиеся completion/create-resource/final UI/release gates не закрыты.


## Evidence localization completion (2026-10-07, local dev 1.3.3)

Пользователь выбрал completion через явное уточнение. Task 3.1 выполнен:
localizationCompletion.js + common stringLiterals/LOCALIZATION_KEY grammar,
единственный BL/file provider в localization.register с $/. triggers. На старте
BL completion provider не существовал; JS provider/selector не изменён. Shared
read-only snapshot/parser/resolver, checkout-wide provenance без family edit filter.
Prefix case-insensitive, cap 200/isIncomplete continuation, chosen-locale detail,
missing/conflict/unavailable без fallback; untrusted bounded Markdown (8 sources,
1024 chars/value). Только plain key+$+optional quote, same-line range после opening
"$; нет snippets/additionalTextEdits/commands, BL/NLS не пишутся самим provider.
Complete/partial $/quote, suffix replacement, CRLF/UTF-16, comments/other/escaped/
multiline literal exclusion. Captured version/epoch/root/cancel/dispose guards.

295/295 npm tests passed, включая 12 новых pure/provider regressions: partial
contexts/delimiters/suffix/native completion edit contract, grammar/comments,
shared resolver equality/duplicates/empty/missing/conflict/incomplete, bounded
10k corpus с неполным списком, single BL registration/JS isolation, safe Markdown,
locale/display mode, dirty NLS/create/delete/excludes/generated buffers, multiple
checkout/submodule/untitled/outside-workspace и genuinely delayed stale responses
после edits/cancel/close/config/folders/dispose. Без real editor popup/network.
Все 3 CLM corpora passed: 619 BL/617 classes/3866 definitions/283 records/52 constants,
7 JS checks; 26 NLS/2831 entries. NLS corpus теперь проверяет реальный Workspace.title
completion ru=Документы/en=Documents/uz=missing, source provenance и insertText/range
без BL/NLS writes; ClearAction Toolkit regression сохранён. Syntax, git diff --check,
strict OpenSpec 11/11 passed. Cached vsce ls включает localizationCompletion.js и
9 прежних localization/Toolkit modules, test/openspec/.agents не shipped.

README/AGENTS/config/proposal/design/spec/tasks/карта backlog обновлены. Existing
inline change 4.1 (definition+completion) закрыт теми же provider/corpus checks;
resource edits/rename/final GUI gates не закрыты. Main specs не sync/archive.
Один согласованный patch 1.3.2 → 1.3.3, package/lock root synchronized.
Изменён только bl-language-support, CLM/submodules не менялись. GUI/themes/Remote
SSH/live API/commit/push/publication не запускались. Общий BL symbol IntelliSense
не реализован и не обещан.


## Evidence явного добавления языка (2026-10-07, local dev 1.3.4)

7.8 выполнен по явному запросу пользователя с условием неброского UI. Secondary
«Добавить язык…» внутри свёрнутого «Источники и подробности»; native chooser для
ambiguous anchored families, common locale picker/custom code, exact path modal.
Host строит путь, общий locale/family parser, подпись источников и fresh scope/epoch/
trust guards до/после consent, real parent directory и case/region/open-buffer
collisions. Проспективные exclusions — те же discovery patterns через штатный
VS Code languages.match/RelativePattern, без второго glob parser.

Отдельный WorkspaceEdit createFile(overwrite=false, ignoreIfExists=false)+insert
пустой Java XML-properties scaffold. Новый файл существует, XML остаётся dirty
buffer до Save; не auto-save других NLS, не копировать keys/translations. После
create явная discovery invalidation, shared parser/overlay, новые eligible AI
цели только после discovery. Не bypass exclusions при post-create error. Partial
native failure честно объясняет возможный create, нет delete/overwrite/retry.
Другие row values/options/revisions/proposals/Undo сохранены; affected locale
сохраняет identity/hash/null/stale, старые edits не rebase. DOM строки добавляются
инкрементально, source options обновляются без пересборки fields/focus/selection.
Duplicate click во время native диалога ack без повторного picker.

310/310 npm tests passed (15 новых pure/controller/actual-script DOM regressions):
locale/scaffold, sole/ambiguous family, custom region, cancel, forged path ignored,
malformed/case/regional/open-buffer collisions, source/workspace/trust/exclusion/
symlink/close races, native partial failure, storage/index post-create errors,
no anchors, draft/proposals/Undo and source hashes, incremental DOM options/focus,
duplicate consent clicks и AI Prepare eligibility без network. Это mocks, не GUI.
Все 3 CLM corpora passed: 619 BL/617 classes/3866 definitions/283 records/52 constants;
7 JS checks/target excluded; 26 NLS/2831 entries. NLS corpus дополнительно создаёт
core_uz.nls только в Map/native-buffer fixture и проверяет отсутствие файла в
настоящем CLM до/после. CLM/submodules не изменены.

Syntax и git diff --check passed, cached vsce ls включает новый i18nResources.js
и 10 прежних NLS/Toolkit modules; test/openspec/.agents не shipped. Strict OpenSpec
11/11 passed. Native API сверено с официальными VS Code 1.60.0 declarations и
languages.match implementation (raw GitHub); resource partial atomicity не обещается.
README/AGENTS/config/change docs обновлены, main specs не sync/archive. Один patch
1.3.3 → 1.3.4, обе lock root версии synchronized. GUI/native Undo/Remote SSH/live
provider/commit/push/publication не запускались. Rename/6.2/6.3 остаются pending.


## Evidence rename локализационного ключа (local dev 1.3.5)

7.1 выполнен по отдельному «го» после плана Rename. Secondary действие в свёрнутых
источниках, native InputBox/key grammar, обязательный file-grouped preview с
путями/строками/count/old→new, видимое ограничение точных BL/NLS и separate native
text-only Apply. Shared parser/lexical scanner/surgical key spans, значения и XML
format не переписываются. JS/dynamic/comments/generated/excluded вне scope.

Shared renameSnapshot с force discovery/dirty overlays/outer checkout и отдельной
BL revision, read failures blocking. Full-source membership+fingerprints и touched
document versions/root/trust/physical-path checks до Apply, no collisions/multiple
families/duplicate locales/broken NLS. Duplicate discovery paths и physical aliases
не создают overlapping edits. Current dirty draft/stale/proposals/Undo и target
draft/panel блокируют rename без discard/merge. Native target-panel reservation
защищает identity во время Apply. Success rebind current tab/map/title to new key;
post-commit storage/index/close не rollback, ошибки не выданы за отсутствие правок.

327/327 npm tests passed (17 новых pure/controller/actual-script DOM regressions):
key limits/scoped plan bounds/XML entities/CDATA/BOM/CRLF/comments/values/lines,
exact BL literal spans, collisions/ambiguities/read failure, cancel/Back, dirty
draft/other-key storage preservation/other-checkout isolation, discovered dirty
buffers vs generated/excluded/undiscovered, changed membership/ref/collision/version/
exclusions/trust/root/realpath and delayed read/close guards, native false/close
during commit, post-commit storage/index errors, target-panel reservation, physical
aliases/duplicate source paths. DOM verifies understated action/blocker tooltip,
file/line summary, correct phase labels/focus/safe textContent and no HTML injection.
Это mocks, не real GUI/native Undo/Remote SSH. Никакого translation HTTP.

Все 3 CLM corpora passed: 619 BL/617 classes/3866 definitions/283 records/52 constants;
7 JS command checks с target excluded; 26 NLS/2831 entries. NLS corpus переименовывает
реальный Workspace.title в Map/native-buffer fixture: точно Workspace.bl:81 и
core_ru/core_en:33, values Документы/Documents сохранены. Assert реальные файлы
CLM не изменены. Cached vsce ls включает i18nRename.js и 11 прежних NLS/Toolkit
modules; test/openspec/.agents исключены. Syntax, git diff --check и strict OpenSpec
11/11 passed. README/AGENTS/config/proposal/design/spec/tasks обновлены.

Один patch 1.3.4 → 1.3.5, обе package-lock root версии synchronized. Только plugin
checkout + временные логи в ../tmp; CLM/submodules не менялись. Main specs не
sync/archive, GUI/Remote SSH/native Undo/live API/commit/push/publication не запускались.
6.2/6.3 остаются pending: rename implementation не закрывает final acceptance/release.
