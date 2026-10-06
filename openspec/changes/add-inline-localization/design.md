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
