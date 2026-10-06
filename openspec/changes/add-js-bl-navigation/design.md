# Design

## Context

См. [proposal](proposal.md). Текущий reference provider проверяет BL-символы и намеренно игнорирует строки. В референсном CLM JS `HttpRequest.send` передаёт строковый request FQN, action и custom method; `AiAttachment` маршрутизирует content через `getOperation`, а `Analyzer` — через `getData`.

## Goals / Non-Goals

**Goals:** создать статическую модель маршрутов с source ranges, confidence и параметрами; использовать её также для Workbench после его реализации.

**Non-Goals:** исполнять JS, проводить HTTP probes или заменять existing BL references глобальным текстовым поиском.

## Decisions

1. Выделить общий request descriptor: класс/checkout, handler family, action, custom selector, handler source, known parameters и confidence. Workbench использует тот же контракт, чтобы не дублировать правила dispatch.
2. Первые recognizers работают с literal/разрешаемыми constant-значениями в `HttpRequest.send` и BL `if`-диспетчерах, включая простые helper-переходы. `action=action` и `name` отдельны от `method`; любую публичную функцию считать endpoint нельзя.
3. Хранить versioned JS call sites и BL route evidence; учитывать unsaved buffers и checkout proximity. Изменение любого источника инвалидирует связанные descriptors.
4. В JavaScript добавляются отдельные definition/completion commands/providers и обратный список request usages. Existing BL Shift+F12 сохраняет свою семантику; JS results показываются как отдельная категория.
5. Не выбирать JS AST-библиотеку до ограниченного прототипа recognizer: сравнить dependency-free разбор и AST на реальных fixtures, выбрать по корректности/диапазонам/стоимости. Это решение не изменяет заданный статический scope; произвольный динамический JS исключён.

## Risks / Trade-offs

- [Вычисляемые строки и wrappers] → partial descriptor, источник и ручной ввод вместо guessed target.
- [Метод наследника меняет routing] → анализ выбранного request-класса и chain, а не всех одноимённых методов workspace.
- [Маршрут кажется чтением, но меняет данные] → имя action не используется как доказательство безопасности для Workbench.
- [Не найденный route ошибочно принят за сломанный сервер] → warning о статическом анализе, не runtime verdict.

## Migration Plan

Добавить навигацию без сетевого слоя; интеграцию Open Request включать только при наличии Workbench. В fixtures сохранить оба существующих паттерна: `AiAttachment/content` и `Analyzer/read`.
