# Design

## Context

См. [proposal](proposal.md) и [baseline навигации](../../specs/bl-index-and-navigation/spec.md). В `extension.js` зарегистрированы definitions, references, Java CodeLens и import hover. `blIndex.js` и `documentAnalysis.js` дают эвристические объявления, return types и scopes; completion/signature/symbols/rename/semantic providers отсутствуют.

## Goals / Non-Goals

**Goals:** расширить существующий индекс необходимыми сигнатурами и диапазонами; использовать один контекст разрешения для всех editor features; не ухудшить работу на больших workspace.

**Non-Goals:** не внедрять полноценный Java language server или compiler diagnostics под видом этой итерации. Мотивация и пользовательский scope — в proposal/specs.

## Decisions

1. Новые VS Code providers используют существующий index/document context. Дополнительный разбор — по версии документа, а не отдельный полный workspace scan для каждой подсказки. Альтернатива — второй независимый regex-parser — отвергнута из-за расхождения scopes и типов.
2. Сохранять declared signatures и source ranges для overloads. Signature help показывает все релевантные варианты, пока точный выбор не доказан; это не расширяет текущую диагностику до type checker.
3. Auto-import и rename формируют проверяемые edits. Checkout proximity и existing explicit import сохраняются; rename строится по подтверждённым definitions и версиям документов.
4. Document symbols и semantic tokens добавляются по достоверным объявлениям; TextMate остаётся базовым слоем. Общая инфраструктура индекса не требует реализации других backlog-фич.

### Completion: этап 2026-10-08

- Повторно используем `DocumentAnalysis`, lexical mask, access-chain scanner,
  declared member/method metadata и `BlIndex`. Scoped view содержит те же class
  objects, без повторного parser/discovery и без присоединения чужого checkout.
  Полные имена с одинаково близкими копиями и неоднозначный short type остаются unknown.
- Тип цепочки хранит declared type, owner imports, остаток array/map dimensions,
  class/instance mode и inline owner. Каждый `[i]` снимает одну размерность;
  `items.` не выдаёт members элемента, `items[i].` выдаёт. Неописанные native
  методы контейнера не выдумываются. `new Class.method` сохраняет class-first
  resolution, но новый объект имеет instance members.
- Inline context хранит enclosing owner: `this`, `super`, `container` и nested
  `container.container` разрешаются из lexical context, не по имени класса.
  Visibility/static берём из объявлений (в Z8 default public); class receiver
  не предлагает instance member, private/protected учитывают inheritance/containers.
  Scanner хранит колонные boundaries: курсор до/после закрытия inline body на одной
  строке получает соответствующего owner. Unknown inline base не превращается в outer this.
- Один BL/file provider (триггеры `$` и `.`). Точный partial localization context
  маршрутизируется в существующий completion без смешивания списков; вне него
  symbol completion не работает в strings/comments/attributes. JS независим.
- Native CompletionItem/List, plain insertion имени (метод без добавления скобок),
  replacement range текущего identifier; для `import` — FQN. Класс вне доступного
  short context вставляется FQN, не меняет imports. До 200 результатов + incomplete,
  дальнейший prefix уточняет список; signature/source detail untrusted и bounded.
  Overloads, включая унаследованные, сгруппированы в одну row по имени со всеми
  подтверждёнными сигнатурами (bounded evidence). Unknown/different overload return
  остаётся неопределённым, даже когда другая overload имеет известный return.
- Versioned context ждёт existing index readiness/dirty overlays и проверяет
  cancellation, source/dependency versions, BL events/config/folders/disposal.
  Scoped views bounded/cache по index revision; каждый request не сканирует диск.
  Completion obeys BL index.exclude даже для buffers (legacy BL navigation не меняется).
  Для import до class header общий index parser предоставляет только file/package/import
  context без выдуманного anonymous class. Tied FQN copies не исчезают из short-name
  кандидатов; неоднозначность своего package не позволяет перейти в чужой package.

Signature help, auto-import, outline, semantic tokens и symbol rename не входят
в разрешённый первый этап и остаются отдельными незавершёнными tasks.

## Risks / Trade-offs

- [Эвристический parser не покрывает весь BL] → поддерживаемые конструкции проверять fixtures, неизвестное не выдавать за точную семантику.
- [Rename меняет несколько файлов] → preview, проверка конфликтов и версий; никаких неподтверждённых JS/строковых замен.
- [Дополнительные providers ухудшают отзывчивость] → разделяемые versioned caches, cancellation и existing performance tests.
- [Неописанные native-члены] → явно сохранять ограничение; не подставлять случайный одноимённый member.

## Migration Plan

Добавлять providers инкрементально, сохраняя публичные команды и настройки 1.1.0. Отдельное решение о compiler/LSP требует нового proposal и оценки совместимости; переход не подразумевается этим change.
