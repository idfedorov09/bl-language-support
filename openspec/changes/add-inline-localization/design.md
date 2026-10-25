# Design

## Context

См. [proposal](proposal.md) и [delta spec](specs/inline-localization/spec.md). В расширении пока нет `.nls`-индекса или локализационных decorations. В референсном Z8 языковые `.nls` содержат XML properties; compiler `NlsUnit.compareLocale()` возвращает `true`, поэтому его lookup нельзя считать готовым языковым resolver.

## Goals / Non-Goals

**Goals:** отдельный language-aware индекс и визуальный слой, не меняющий source/document offsets; строгий warning-контракт выбранных языков.

**Non-Goals:** language fallback, внешнее машинное переводение, подмена source переведённым virtual buffer как незаметный обход требования.

## Decisions

1. Языковой индекс читает XML properties `.nls`, определяет locale по имени ресурса и хранит ключ/значение/source range/checkout. Не подключать DTD, внешние XML entities или сетевые ресурсы. Runtime resource precedence не выдумывать при конфликте.
2. Presentation отделён от text document. Первая implementation task — prototype в штатном редакторе с supported VS Code APIs и проверкой cursor/selection/copy/undo/тем/длинных строк. Модификация BL-текста и CSS/DOM-injection в оболочку редактора не принимаются как решение.
3. **Gate:** если визуальная подмена не проходит контракт безопасного редактирования, остановить дальнейшую реализацию и показать пользователю результат. Варианты — согласованный иной UX либо отказ от подмены. Ни hint рядом, ни отдельная read-only вкладка не включаются молча вместо заказанной фичи.
4. Display mode default — переводы, locale default — `ru`. Обязательные языки задаются отдельным списком; display locale проверяется всегда. Это начальное допущение UX, не связь с locale серверной сессии. Имена новых settings оформляются вместе с manifest в реализации.
5. Warning-диагностика локализаций независима от существующих BL syntax/member errors. Missing active translation сохраняет ключ; missing другого проверяемого языка не скрывает существующий активный перевод.
6. Добавление/rename ключа — versioned multi-file preview, отдельное явное действие. Watchers и unsaved resource buffers обновляют translations; отдельное Copy Translation не меняет Copy Source.

## Risks / Trade-offs

- [Не существует безопасной реализации exact inline replacement в выбранной версии редактора] → обязательный prototype gate, никаких скрытых workaround.
- [Перевод длиннее/многострочный или содержит спецсимволы] → проверить rendering и escape-представление; изменение пользовательского контракта согласовать.
- [Дубли в ресурсах и несколько checkout] → показывать source/conflict; не выбирать случайную локализацию.
- [Слишком много missing warnings] → configurable required locales и lazy per-document diagnostics, без смены severity на Error.

## Migration Plan

После успешного gate добавлять индекс, режим отображения и warnings независимо от completion/rename локализаций. До реализации спецификация остаётся только в change; baseline и BL-файлы не меняются.


## Prototype gate: текущий кандидат

2026-10-06: изолированное dev-расширение `test/localization-prototype/`, отдельный
manifest; в production не зарегистрировано. Публичные decorations: transparent
исходный литерал, `after.contentText` с цветом темы и отрицательным `after.margin`
в ch. API доступны в 1.60.0; CSS strings с внедрёнными правилами/DOM не используются.

Ограничение: геометрия предполагает monospace ASCII key; decorations не заменяют
текстовую модель. Hit testing/word wrap/font ligatures/zoom/clipboard и реальная
позиция следующего текста требуют editor-проверки. Если она не проходит, не считать
соседний/перекрывающий hint replacement. Подход не утверждён для production.

Затронутый курсором/любым выделением ключ раскрывается. Перевод фиксирован fixture,
не результат language-aware resolver. Для multiline кандидат — escaped `\n`,
не истинный многострочный перевод; вариант отображения требует согласования.
Полная acceptance matrix и команда запуска — README прототипа. 190 unit/mock tests,
оба CLM corpora прошли; реальный editor не запускался. Gate pending, следующие
задачи не начаты. NLS в CLM содержит стандартный внешний DOCTYPE properties.dtd:
будущий parser должен отдельно определить безопасную поддержку декларации без
загрузки внешнего ресурса, не путать её с разрешением DTD/entity expansion.


## Уточнение визуального UX после пользовательского теста

2026-10-06: скрины и отзыв пользователя подтверждают отображение переводов в
dev-окне и reveal ключа под курсором (строка 5). Полная safety matrix ещё pending.
Пользователь отдельно запросил серую рамку перевода и missing Warning в прототипе.
Выполнено через `after.border: 1px solid` и `after.borderColor: descriptionForeground`;
исходный range не получает рамку. Reveal снимает attachment и рамку вместе.

Missing demo-key в Prototype.* даёт Warning в отдельной коллекции; selection/toggle
не снимают warning, несохранённые изменения/close обновляют/очищают его. Реальные
CLM-ключи не проверяются против фиктивного словаря. Полный locale-aware NLS этап
не реализован. Официальный JetBrains UX reference — i18n code folding до resource
value и отдельные unresolved-key inspections; новый border UX требует проверки
в реальном редакторе, не выдаётся за точное воспроизведение IDEA.


## Новая UX revision: мягкий inlay-style (пока спецификация)

Пользователь подтвердил Warning и рамку на новом скрине, но запросил заменить
агрессивное оформление более мягким. Новый целевой вид: приглушённый текст и
ненавязчивый фон на основе темы, без жёсткой рамки по умолчанию. Использовать
`editorInlayHint.foreground/background` либо явно согласованные theme-aware токены;
до внедрения проверить поддержку в минимальном engine. Смена light/dark/high contrast
не меняет source/draft. Читаемость важнее низкого контраста.

Это визуальный стиль, **не обязательный native InlayHintProvider**: native подсказка
рядом с ключом не выполняет прежний replacement-контракт. Не обещать скругление,
font-size или pixel-perfect JetBrains, если публичные attachment APIs этого не дают.
Не внедрять CSS через textDecoration/DOM. На этапе предыдущей спецификации прототип оставался с рамкой. После отдельного
запроса на apply текущий dev-кандидат обновлён (см. ниже); новый UI gate не пройден.

Completion/ресурсные edits используют общий NLS-index. Будущий Edit Translation,
rich key search и optional OpenAI-compatible auto-translation вынесены в отдельный
change `add-i18n-toolkit`; нет автоматического расширения текущего apply на HTTP/AI.
Последние скрины подтверждают demo replacement/reveal/Warning, не полный safety gate:
save/undo/copy/темы/ligatures/wrap ещё не проверены по всей матрице.


## Реализация мягкого dev-кандидата

2026-10-06: после отдельного запроса пользователя применены
`after.color = editorInlayHint.foreground`, `after.backgroundColor = editorInlayHint.background`,
normal font style/weight. Border/borderColor удалены. Ни hardcoded цветов,
ни CSS-injection; minimum engine 1.60.0 сохранён, наличие theme tokens/API проверено
по официальному исходнику именно этого тега. Theme resolution/contrast — штатные
значения темы VS Code; реальный high contrast требуется проверить пользователю.

192 unit-теста проходят, в mock отдельно проверен refresh при трёх theme kinds и
неизменность source. Native InlayHintProvider не добавлен; replacement/reveal/Warning
и запуск Remote SSH сохранены. Это dev-кандидат на пользовательский тест, не
production NLS resolver и не Toolkit; main specs не синхронизированы.


## Пользовательское решение gate и NLS-этап 2026-10-06

Пользователь подтвердил мягкое оформление и базовые Copy исходного ключа /
редактирование / Undo, затем явно запросил продолжение. Разрешено внедрение того же
presentation layer в локальный основной плагин, без нового UX/fallback. Это решение
не закрывает всю editor matrix; темы/high contrast/fonts/wrap/save ещё нужны перед
релизом. Исторические статусы выше относятся к предыдущим этапам прототипа.

Новые CommonJS modules: `localizationModel.js` — constrained XML-properties parser
и language resolver; `localizationPresentation.js` — lexical ranges/reveal;
`localization.js` — checkout-scoped lazy snapshots/providers/events. Production
не импортирует test/**. BL providers сохраняют свои обязанности вне точного
локализационного литерала; JS definitions по-прежнему не регистрируются.

Parser не использует DTD loader/сеть: разрешает инертный conventional Java DOCTYPE,
проверяет XML 1.0 UTF-8, entry/comment/properties, standard/numeric entities и CDATA.
Неизвестный XML/custom DTD/entities или повреждённый ресурс исключает **весь файл**,
а не оставляет частично угаданный индекс. Для такого языка resolver возвращает
unavailable (с evidence), а не false missing/found. Conflicting значения дают
conflict; одинаковые дубли возвращают все deterministic sources, без приоритета.

Discovery — `**/*.nls`, mandatory target/build/node_modules/.git плюс user excludes;
open buffer overlays только обнаруженных исходных ресурсов. Новый файл входит после
create/save discovery. Scope — outermost .git внутри содержащей workspace-папки,
иначе эта папка; без workspace нет guessed cross-checkout index. Buffers, watcher,
config/folder revisions инвалидируют snapshot; version/cancellation guards не дают
старому result переписать display/diagnostics или вернуть неверный definition.

`bl.i18n.displayMode = translations`, `locale = ru`, `requiredLocales = []` —
resource settings. Active locale проверяется всегда, no fallback. Независимая
коллекция Z8BL i18n Warning; conflict/unavailable сохраняет ключ. Invalid required
locale не скрывает существующий active translation. F12 хранит source key range,
hover выводит untrusted text/evidence. Copy Translation — отдельная команда,
toggle сохраняет setting папки, не BL source.

Многострочное значение остаётся JSON-escaped single-line display. Monospace/ch
геометрия и public theme tokens те же, что в одобренном прототипе; final GUI tests
не выдуманы. Completion/create/rename и future Toolkit/AI не реализованы этим этапом.
Проверки и актуальный task status — tasks.md; baseline не синхронизирован.
