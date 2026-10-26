# Навигация из Z8BL в Java

## Purpose

Зафиксировать существующие ссылки и команды перехода из BL в скомпилированный или native Java, включая поиск файлов, настройки CodeLens и ограничения сопоставления символов.

## Baseline status

Реализовано в версии 1.1.0, ветка `dev`, commit `026539c`; инвентаризация — 2026-10-06. Переходы используют существующие Java-файлы и эвристическое сопоставление имён, не карты строк, компиляцию или debugger. Кнопки открытия Request Workbench нет. Evidence ниже описывает исходники и имеющиеся тесты, не их запуск.

## Requirements

### Requirement: Поиск скомпилированного Java

Расширение SHALL искать существующий скомпилированный Java по пути `<module>/.java/<relative BL path>.java`, где BL-корень — `src/bl` или `src/main/bl`. Навигация SHALL NOT запускать компилятор или создавать отсутствующий Java-файл.

#### Scenario: Скомпилированный файл существует
- **WHEN** соответствующий Java-файл уже существует в `.java` модуля
- **THEN** он доступен как цель команды и Compiled Java CodeLens

#### Scenario: Скомпилированный файл отсутствует
- **WHEN** соответствующего Java-файла нет
- **THEN** CodeLens для него отсутствует, а навигация не создаёт файл

### Requirement: Поиск native Java

Расширение SHALL читать class-level binding `[native "..."]` или `[primary "..."]` и искать указанный FQN в `src/main/java` и `src/java` рабочей области. При нескольких копиях SHALL предпочитаться файл, ближайший по общему файловому префиксу к вызывающему BL-файлу; field-level binding SHALL NOT заменять class-level binding.

#### Scenario: Native binding класса
- **WHEN** BL-класс связан с Java-классом через `native` или `primary` и target найден
- **THEN** навигация использует соответствующий Java-файл

#### Scenario: Копии в разных checkout
- **WHEN** в workspace доступны несколько Java-файлов для одного binding
- **THEN** выбирается ближайшая по файловому расположению копия относительно caller

### Requirement: Java CodeLens

Расширение SHALL по умолчанию показывать `→ Native Java: <file>` у найденного class binding и `→ Compiled Java: <file>` над объявлением BL-класса при наличии target. Настройка `bl.codeLens.enabled = false` SHALL скрывать CodeLens без отключения definition provider.

#### Scenario: Открытие через ссылку
- **WHEN** пользователь нажимает Native Java или Compiled Java CodeLens
- **THEN** открывается соответствующий существующий Java-файл без компиляции

#### Scenario: CodeLens выключен
- **WHEN** `bl.codeLens.enabled` изменено на `false`
- **THEN** Java CodeLens перестаёт предоставляться, но обычный BL-переход к определению остаётся доступен

### Requirement: Java-цели для перехода к определению

Definition provider SHALL разрешать поддерживаемые `native`/`primary` атрибуты в Java-файл. Если явно импортированный тип не найден как BL-класс, provider SHALL пытаться найти Java-файл по полному имени импорта.

#### Scenario: Native attribute
- **WHEN** переход вызван на имени в поддерживаемом binding и Java target найден
- **THEN** возвращается начало соответствующего Java-файла

#### Scenario: Явно импортированный Java-тип
- **WHEN** имя связано с explicit import, BL-объявление отсутствует, а Java-файл по FQN найден
- **THEN** переход возвращает этот Java-файл, а не другой одноимённый BL-класс

### Requirement: Переход от имён атрибутов

Переход по поддерживаемому имени атрибута SHALL искать соответствующую строковую константу в Java-классе `org.zenframework.z8.compiler.core.IAttribute`. Внутри `records` совпадающее имя поля SHALL разрешаться в BL-поле прежде поиска Java-константы.

#### Scenario: Атрибут платформы
- **WHEN** имя атрибута найдено среди констант `IAttribute`
- **THEN** переход возвращает позицию соответствующей константы

#### Scenario: Атрибут записи
- **WHEN** атрибут находится внутри `records` и совпадает с разрешённым полем таблицы
- **THEN** переход указывает на BL-объявление поля

### Requirement: Контекстные команды Java-навигации

Команды перехода к compiled и native Java SHALL использовать поддерживаемое эвристическое сопоставление выбранного метода, поля или локальной переменной. Для compiled methods SHALL учитываться префикс `z8_`; при несопоставленном символе SHALL открываться начало найденного файла.

#### Scenario: Сопоставленный compiled method
- **WHEN** выбранный BL-метод сопоставлен с Java-объявлением `z8_<name>`
- **THEN** команда открывает файл и переводит курсор к найденному объявлению

#### Scenario: Символ не сопоставлен
- **WHEN** Java-файл найден, но выбранный символ не сопоставлен эвристическим поиском
- **THEN** команда открывает начало файла, не утверждая точного source-map перехода

### Requirement: Предупреждения и обновление Java-целей

Команды SHALL предупреждать о неподходящем типе файла, отсутствии native binding или нужного Java target. Создание, изменение и удаление Java-файлов, а также изменение workspace SHALL обновлять связанные результаты поиска и CodeLens.

#### Scenario: Цель отсутствует
- **WHEN** пользователь вызывает Java-навигацию, а необходимый binding или target не найден
- **THEN** расширение показывает предупреждение вместо компиляции либо генерации замены

#### Scenario: Ранее отсутствовавший Java-файл создан
- **WHEN** Java target создан после неудачного поиска и событие файловой системы обработано
- **THEN** последующий поиск может найти файл, а устаревший отрицательный результат не сохраняется

## Evidence

- [Java lookup, CodeLens, definition и context navigation](../../../extension.js).
- [Определение BL-корня и модуля, class binding](../../../blIndex.js) и [команды/настройки](../../../package.json).
- [Native binding и выбор checkout](../../../test/index.test.js), [native definition tests](../../../test/navigation.test.js).
- [Java cache/watchers и переключение CodeLens](../../../test/performance.test.js); точность compiled Java cursor mapping отдельно UI-тестами не подтверждена.
