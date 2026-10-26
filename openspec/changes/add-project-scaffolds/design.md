# Design

## Context

См. [proposal](proposal.md). В manifest нет snippets или генераторов. Существующее ядро знает source roots, module paths и BL symbols; будущие route/localization descriptors могут дополнить генератор без новой архитектуры прикладного проекта.

## Goals / Non-Goals

**Goals:** детерминированно построить proposed edits по выбранному context/аналогу и проверить конфликты до записи.

**Non-Goals:** автозапуск Gradle, runtime, migrations или request-выполнения; скрытое изменение security/bootstrap.

## Decisions

1. Генерация состоит из выбора context, выбора локального аналога/шаблона, подготовки edit plan, preview и explicit apply. Шаблон и затрагиваемые пути видны; источник не копируется целиком вместе с существующими IDs или побочными операциями.
2. Edit plan версионирует existing buffers и содержит новые файлы. Перед применением проверяются duplicate path/symbol и dirty/version conflicts. Ошибка применения сообщается; не обещать filesystem transaction или незаметный частичный успех.
3. Для request operation использовать подтверждённое handler family и dispatcher; не путать внутренний BL-метод и HTTP route. Регистрация, доступы и локализации включаются отдельными выбранными пунктами preview.
4. Static record IDs устойчивы; новые role-access IDs рассчитываются по подтверждённому Z8 `guid.create(roleId.toString() + objectId)`, с выбором соответствующего soa/request/table/field ID. Неизвестные входы блокируют эту часть генерации, не создают случайный substitute.
5. Локализационные edits и request drafts формируются через соответствующие capabilities, если они доступны. Генератор обычного класса не зависит от готовности Workbench и не сохраняет secrets в templates.

## Risks / Trade-offs

- [Локальный аналог содержит legacy или небезопасный паттерн] → показывать источник, копировать структуру, а не business side effects; проверять contract целевого слоя.
- [Несколько файлов изменились после preview] → invalidate plan и предложить пересчёт без overwrite.
- [Запись вне выбранного checkout] → проверка целевых путей; внешние изменения требуют явного выбора, не nearest-folder догадки.
- [Расширяется scope до миграции/прав] → explicit opt-in и видимый diff, не автоматические дополнительные файлы.

## Migration Plan

Начать с обычного класса и поля; operation/records/локализации добавлять после тестов conflict/cancel. Существующие project files и IDs не мигрировать автоматически.
