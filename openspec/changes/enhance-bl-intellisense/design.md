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

## Risks / Trade-offs

- [Эвристический parser не покрывает весь BL] → поддерживаемые конструкции проверять fixtures, неизвестное не выдавать за точную семантику.
- [Rename меняет несколько файлов] → preview, проверка конфликтов и версий; никаких неподтверждённых JS/строковых замен.
- [Дополнительные providers ухудшают отзывчивость] → разделяемые versioned caches, cancellation и existing performance tests.
- [Неописанные native-члены] → явно сохранять ограничение; не подставлять случайный одноимённый member.

## Migration Plan

Добавлять providers инкрементально, сохраняя публичные команды и настройки 1.1.0. Отдельное решение о compiler/LSP требует нового proposal и оценки совместимости; переход не подразумевается этим change.
