# Tasks

Статус: 2026-10-06 пользователь подтвердил мягкое оформление, Copy исходного
ключа и редактирование/Undo и явно разрешил продолжить NLS-этап. Базовый
пользовательский gate принят для продолжения локального dev, не для релиза.
Полная матрица тем/fonts/wrap/save остаётся открытой (1.1/1.2/1.6/5.2).
Текущий apply — индекс/settings/presentation/Warning/hover/definition/Copy Translation;
completion, resource edits и Toolkit/AI не входят в эту фазу.

## 1. Gate безопасной визуальной подмены

- [ ] 1.1 Сделать ограниченный прототип визуальной замены `"$Workspace.title$"` переводом в штатном редакторе через поддерживаемые VS Code APIs; проверить неизменность document text, save, undo и Git diff, отсутствие DOM/CSS-injection и соответствие заявленной минимальной версии VS Code.
- [ ] 1.2 После отдельного согласования editor-проверки проверить курсор, выделение, обычное копирование ключа, редактирование с раскрытием ключа, hover, темы, длинные/многострочные переводы; оформить матрицу результатов против spec, а не принимать соседний hint за replacement.
- [x] 1.3 Зафиксировать явное пользовательское решение продолжить после проверки базового replacement/reveal/Copy/Undo; сохранить неподтверждённую часть editor matrix открытой до релиза. Не добавлять скрытый source rewrite, read-only substitution или другой workaround.

- [x] 1.4 По уточнению пользователя добавить рамку только переведённой вставки и независимый demo-missing Warning, проверить отдельную диагностическую коллекцию, lexical ranges, dirty updates/close и сохранение warning при toggle/cursor; UI новой рамки и warning остаётся на пользовательской проверке.

- [x] 1.5 По отдельно согласованной UX revision заменить жёсткую рамку мягким theme-aware inlay-style (приглушённый текст/фон) с сохранением replacement/reveal/Warning; проверить публичные APIs/minimum engine и unit fixtures, без native-hint подмены контракта.
- [ ] 1.6 Подтвердить новую плашку в реальном dev-редакторе: light/dark/high contrast, смена темы без правки source, раскрытие/selection/copy и читаемость; записать результаты пользователя отдельно от mock tests.

## 2. Языковой индекс ресурсов — после пользовательского решения gate

- [x] 2.1 Реализовать language-aware чтение XML properties `.nls` с locale, ключом, значением, source range и checkout; проверить fixtures реальных ресурсов, XML escaping и запрет внешних entities/DTD/сетевого чтения, не полагаясь на stub `NlsUnit.compareLocale()`.
- [x] 2.2 Добавить watchers и обработку несохранённых ресурсов с инвалидацией отображения; проверить dirty `.nls`, изменённый BL и несколько checkout.
- [x] 2.3 Обнаруживать противоречивые переводы с источниками вместо guessed runtime precedence; проверить дубли одинакового и разного значения в одном языке.

## 3. Настройки, отображение и предупреждения

- [x] 3.1 Добавить настройки display mode, locale с default `ru` и списка required locales; проверить включённые по умолчанию переводы, переключение язык/ключи и обязательную проверку active locale независимо от списка.
- [x] 3.2 Перенести прошедший gate presentation layer в provider с hover ключ/язык/ресурс и отдельным Copy Translation; проверить, что обычное Copy Source сохраняет ключ и редактирование раскрывает его без изменения offsets.
- [x] 3.3 Добавить независимые localization Warning diagnostics; проверить missing активного языка с сохранением ключа, missing другого required locale с сохранением активного перевода и отсутствие молчаливого language fallback или Error severity.

## 4. Навигация и явные ресурсные изменения

- [x] 4.1 Добавить definition ресурса и completion ключей по выбранному language-aware context; проверить неоднозначный ресурс, несохранённые ключи и язык, отсутствующий в другом checkout.
- [ ] 4.2 Добавить явно запрошенное создание перевода и rename ключа с versioned multi-file preview; проверить отмену, конфликт существующего значения и изменившиеся после preview BL/ресурсные буферы без overwrite.

## 5. Проверки и документация

- [ ] 5.1 Добавить unit/provider-тесты XML-индекса, настроек, warnings и edit plans; проверить `npm test`, corpus и независимость existing BL error diagnostics/навигации от локализации.
- [ ] 5.2 Повторить отдельно согласованные editor-проверки итогового presentation layer, опубликовать подтверждённые ограничения в README и обновить baseline только для реализованного поведения; проверить отсутствие обещания exact replacement при непрошедшем gate.


## Evidence прототипа — 2026-10-06

- Изолированное dev-расширение: `test/localization-prototype/`, инструкция и
  acceptance matrix в его README. Основной extension.js/manifest не изменены;
  `test/**` исключает прототип из поставки.
- Кандидат: transparent literal + after.contentText + публичный negative margin
  в ch. Это не CSS/DOM injection, но корректность геометрии НЕ доказана mock API.
- Fixed fixture Workspace.title соответствует русскому NLS в pro.doczilla.base.core;
  это НЕ NLS-индекс. Locale фиксирован ru только для gate. Missing сохраняет ключ,
  Warning/provider/settings ещё не реализованы.
- Использованные поля и события сверены с официальным vscode.d.ts 1.60.0.
- 4 новых tests: lexical literals/comments/unknown, multicursor reveal, CRLF/special/
  escaped multiline/Unicode, API fixture без write/save/clipboard методов.
- `npm test`: 190/190. BL corpus: 619 файлов, 3866 definitions, 283 records и 52
  GUID constants. JS↔BL corpus: 7 command checks. CLM использован read-only.
- Реальные cursor/mouse/selection/copy/save/undo/themes/fonts/wrap/UI **не проверены**.
  Поэтому 1.1 не закрыт (есть проверка чистой модели/API, но нет save/undo/editor),
  1.2/1.3 и следующие этапы тоже не закрыты. Решение gate — pending, не pass/fail.
- Multiline кандидат показывает escaped \n; его UX не утверждён.
- Version bump, commit/push, упаковка production, runtime/HTTP/UI не выполнялись.

Remote SSH подготовка: `.vscode/launch.json` запускает обе dev-extensions через F5, прототип явно workspace-kind; инструкция обновлена. `.vscode/**` исключён из VSIX. Remote Extension Host агентом не запускался; gate остаётся pending.

По скринам пользователя Remote dev-окно запускается и подключено, но остаётся на
Welcome; Examples.bl открыт в исходном debug-окне. Это не результат presentation
gate. Исправлен dev harness: onStartupFinished, автооткрытие fixture только в
Development mode, явная команда открытия и Output channel с activation/open/render
статусом. Регрессионный API test покрывает пустое dev-окно, Active/non-preview tab,
курсор вне ключа и видимую ошибку открытия. Настоящий GUI остаётся непроверенным.


UX evidence 2026-10-06: пользователь подтвердил чтение перевода и раскрытие
исходного ключа при курсоре на строке 5, приложил два скрина dev-окна Remote SSH.
Это частичный gate: copy/save/undo/темы/fonts/wrap не подтверждены. По отдельному
уточнению добавлены тонкая рамка after-attachment и DiagnosticSeverity.Warning
для demo Prototype.* при missing в ru-словаре. Другая коллекция не затрагивает
BL errors. Это НЕ полный production 3.3: нет NLS/locale/requiredLocales.
Ресурсный этап не начат, gate остаётся pending до остальных acceptance checks.

Новый запрос: сначала зафиксировать Toolkit и soft UI в спеках. Создан add-i18n-toolkit (план), appearance revision внесена в 1.5; код/HTTP на этом этапе не менялись. Скрин пользователя подтверждает demo Warning, но не полное завершение gate.


Soft UI apply 2026-10-06: пользователь отдельно разрешил сделать оформление и
отдать на тест до Toolkit. В dev-прототипе сняты border/borderColor,
применены штатные inlay foreground/background; topic theme event обновляет слой.
Токены проверены в официальном colorRegistry.ts 1.60.0, attachment поля — в
vscode.d.ts. Unit проверяет токены, отсутствие жёсткой рамки, refresh трёх theme kinds,
неизменность текста, reveal/toggle/Warning. Это НЕ проверка реальной отрисовки тем.
1.5 code/API завершён, новый editor gate 1.6 pending; полный gate 1.1–1.3 не закрыт.
Toolkit/AI/реальные NLS и baseline не менялись; версия/commit/push не выполнялись.


## Реальные NLS: текущая фаза 2026-10-06

Пользовательское evidence: «да кайф» для soft style, «да так / продолжай» в ответ
на Copy ключа и edit/Undo. Это не автоматическое подтверждение high contrast,
ligatures, wrap или Save/Git diff всей matrix. 1.3 закрывает именно явное решение
продолжить локальный dev; прочие gate tasks остаются открытыми.

- Реализованы `localizationModel.js`, `localizationPresentation.js`, `localization.js`,
  main integration, `bl.i18n.displayMode/locale/requiredLocales`, toggle/copy commands.
- XML-properties parser: стандартный DOCTYPE инертен, CDATA/XML entities/UTF-8,
  source ranges; custom DTD/entities отвергаются без network/filesystem expansion.
- Watchers/open/change/save/close и scoped snapshots; dirty обнаруженного ресурса
  важнее диска; source-only exclusions и checkout isolation. Новый ресурс появляется
  после create/save, untitled вне папки не становится project resource.
- Conflict вместо runtime precedence; parse/read failure — unavailable Warning,
  не definitive missing. Warnings независимы от core BL и display mode.
- Hover untrusted, F12 выдаёт все source ranges выбранного языка. **4.1 частично:**
  definition готов, completion ещё не начат. **4.2 не начат:** нет resource writes.
- **5.1 частично:** 203 unit/provider tests проходят, в том числе parser/security,
  dirty buffers, per-locale status, excluded generated paths, custom exclusions,
  checkout/multi-root isolation, cancellation/stale document, copy/settings/theme mocks.
  Edit-plan tests pending вместе с implementation 4.2.
- Все три CLM corpora прошли: 619 BL / 3866 definitions / 283 records / 52 constants;
  7 JS↔BL command checks; NLS 26 source files / 2831 entries, Workspace.title ru/en,
  missing uz и source ranges. Это offline/API checks, не editor или runtime CLM.
- Добавлен F5 **Z8BL: Real NLS (CLM)** (только main extension). Документация
  перечисляет dev limitations; итоговый integrated GUI ещё нужен пользователю.
- Version 1.2.1 сохранена; нет bump/commit/push/publish/archive/main-spec sync.
Toolkit/AI остаются только отдельным планом.


Следующий пользовательский feedback: integrated inline после 1.2.2 «вроде всё
работает». Отдельные high contrast/fonts/wrap не перечислены, полная matrix не
закрыта. Approved offline Toolkit расширил shared parser source spans и общий
surgical edit-plan для Edit Translation/missing insertion. Это не key completion,
новый resource/rename и не automatic disk save; broad 4.1/4.2/5.1/5.2 не закрыты.


## Completion linkage (2026-10-07, 1.3.3)

Compound 4.1 теперь выполнен: existing shared definition provider ранее проверен,
localization key completion отдельно разрешён и реализован по add-i18n-toolkit 3.1.
Единый scanner/grammar/index/resolver; source/locale preview, ambiguous/incomplete
без fallback, unsaved keys, checkout isolation. 295/295 tests и CLM NLS provider
ranges + Workspace.title completion ru/en/missing uz edit contract passed.
См. task 3.1 evidence и design add-i18n-toolkit; не второй provider/отдельный parser.
Resource creation/rename/final GUI не входят в этот этап; 4.2/5 gates не закрыты.
Main specs не sync/archive, GUI/Remote SSH не проверены, CLM не менялся.
