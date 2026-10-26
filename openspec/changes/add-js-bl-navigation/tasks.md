# Tasks

Статус: код в рабочем dev, unit/provider/corpus подтверждены; editor gate 4.2 ещё не выполнен. Сетевые запросы, публикация и реализация Workbench не входят в изменение.

## 1. Статическая модель маршрутов

- [x] 1.1 Ввести request descriptor с checkout, FQN, handler family, action, custom selector, параметрами, source ranges и confidence; проверить отдельное представление HTTP method, `request`, `action`, `method` и `name`.
- [x] 1.2 Сравнить ограниченный dependency-free recognizer и JS AST-подход на fixtures реальных `HttpRequest.send` и wrappers; зафиксировать выбранный подход и проверить точность диапазонов, стоимость зависимости и отсутствие исполнения JS.
- [x] 1.3 Реализовать recognizers literal/разрешаемых constant-вызовов и подтверждённых BL-диспетчеров; проверить `AiAttachment/content`, `Analyzer/read`, `action=action` и отсутствие маршрута у произвольного public-метода.

## 2. Навигация и подсказки

- [x] 2.1 Добавить JS→BL навигацию к request-классу, ветке диспетчера и разрешённому обработчику; проверить известный маршрут, динамический selector и отсутствие случайного short-name target.
- [x] 2.2 Добавить обратный список JS request-вызовов отдельной категорией от BL references; проверить подтверждённые маршруты, несвязанные строковые совпадения и cancellation.
- [x] 2.3 Добавить completion маршрутов и известных параметров с provenance; проверить, что чтение параметра не делает его безусловно required, а неизвестные типы остаются предположениями.

- [x] 2.4 По согласованной UX revision заменить JS DefinitionProvider явной командой ПКМ → Z8BL → Найти серверные BL-исходники; проверить категории/пути, cursor context, partial/empty states, вкладку без split, cancellation/stale и разделение JS/BL меню; поднять patch до 1.2.1.

## 3. Актуальность и опциональная интеграция

- [x] 3.1 Подключить file/buffer events и versioned caches для JS/BL с caller checkout context; проверить несохранённые изменения обоих языков и одноимённые классы в нескольких checkout.
- [x] 3.2 При наличии реализованного Request Workbench добавить явное Open Request из выбранного вызова; проверить draft со статическими параметрами, ручной ввод динамических значений и отсутствие HTTP/credentials при открытии. Без Workbench проверить полноценную самостоятельную навигацию.

- [x] 3.3 По отдельному уточнению пользователя всегда исключать `**/target/**` для JS-навигации, открытых буферов, discovery и событий; проверить default/очищенный index.exclude, пересборку без stale результатов и отсутствие ложного исключения внешнего ancestor path.

## 4. Проверки и документация

- [x] 4.1 Добавить unit/integration fixtures распознавания и providers; проверить `npm test`, corpus BL-навигации и неизменность existing BL Shift+F12, Java CodeLens и diagnostics.
- [ ] 4.2 После отдельного согласования editor-проверки подтвердить переходы и обратный список, описать поддерживаемые patterns и пределы статического анализа; обновлять baseline только для реализованного и проверенного scope.

Evidence и выбранный scope — в design.md; 183 unit-теста, BL corpus и 7 реальных CLM JS provider checks пройдены. Editor/UI не запускался; archive/sync не выполнялись.

UX revision 1.2.1: 186 Node-тестов, BL corpus (3866 definition checks), 7 CLM JS↔BL command checks и strict OpenSpec validation прошли. Локальный VSIX собран pinned vsce 4.0.0; версия, наличие production parsers и отсутствие tests/specs/CI в архиве проверены. Реальный editor/UI не запускался; 4.2 остаётся открытым.
