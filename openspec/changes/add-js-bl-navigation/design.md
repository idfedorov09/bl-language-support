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
4. В JavaScript добавляются явная команда `bl.showServerSources`, hover/completion providers и обратный список request usages. JS DefinitionProvider не регистрируется: Cmd+Click/F12 принадлежат нативной JS-навигации. Existing BL Shift+F12 сохраняет свою семантику; JS results показываются как отдельная категория.
5. Выбран Acorn 8.19.0 для строгого JS AST и Acorn-loose 8.5.2 только для completion в недописанном документе. Strict parse failure не переключает server sources/usages на неточный AST. Никакого исполнения JS, AST-LSP или compiler semantics для BL.
6. Source-only JS scope дополнительно всегда исключает `**/target/**`, даже при `bl.index.exclude=[]` и открытом generated буфере. Это отдельное явное уточнение пользователя, не скрытая дедупликация или guessed target. JS bundle events не сбрасывают source-кэши. Остальные исключения берутся из общей настройки; BL defaults не изменены.
7. Route index использует только классы caller checkout; missing bases/imports не разрешаются чужой копией, ambiguous dependency tie остаётся unknown. Список серверных исходников возвращает все FQN class-кандидаты в scope.
8. Обе команды сразу открывают Quick Pick с busy/status/count; results versioned, cancel/stale не коммитят старый snapshot. Открытие цели — новая вкладка в текущей группе, без split. BL reference provider не изменён.

## Risks / Trade-offs

- [Вычисляемые строки и wrappers] → partial descriptor, источник и ручной ввод вместо guessed target.
- [Метод наследника меняет routing] → анализ выбранного request-класса и chain, а не всех одноимённых методов workspace.
- [Маршрут кажется чтением, но меняет данные] → имя action не используется как доказательство безопасности для Workbench.
- [Не найденный route ошибочно принят за сломанный сервер] → warning о статическом анализе, не runtime verdict.

## Migration Plan

Добавить навигацию без сетевого слоя; интеграцию Open Request включать только при наличии Workbench. В fixtures сохранить оба существующих паттерна: `AiAttachment/content` и `Analyzer/read`.

## Prototype / выбранный parser

Сравнение ограниченного dependency-free recognizer (`HttpRequest.send({`) и AST на реальных исходниках CLM:

| Fixture | Простой recognizer | Acorn: send calls |
| --- | --- | --- |
| scenario/variables/File.js | 3 | 5 |
| analyzer/Analyzer.js | 5 | 5 |
| gpt/GPT.js | 31 | 31 |
| adversarial comments/string + Z8.apply | 2 ложных кандидата | 1 реальный wrapper-call |

Диапазоны Acorn сверены с исходниками, включая CRLF/quotes. Прототип был локальным,
без исполнения JS. Exact dependencies добавлены в package/lockfile; измеренная
установленная папка Acorn ~592 KiB, Acorn-loose ~148 KiB. Это не размер VSIX.
CI выполняет npm ci; production modules не исключаются blanket `node_modules/**`.

## Реализованный статический scope

JS: literal/локальные const, однозначный Z8.define statics в том же файле, явный
shortClassName/FQN namespace; global single-классы не угадываются. Поддержаны прямой
object, immutable single-use const object и Z8.apply двух известных объектов.
Shadowing, присваивания/delete и unknown spreads инвалидируют доказуемые значения.
Произвольные wrappers, mutable object flow, template expressions, JSX не разрешаются.

BL: virtual getData/processContentRequest с map-параметром; простые selector aliases,
final string-константы, if/else-if equality, direct/self helper calls, direct return,
assignment результата и возвращаемый operation-класс. Action/name — явно объявленное
inline Action-поле, не обычный public-метод. Изменённый id/static field не угадывается.
Known parameters несут source, required/type остаются unknown; route-specific подсказки
не смешиваются с параметрами всех соседних веток при известном selector.

Descriptors разделяют request/action/method/name и httpMethod (unknown), содержат
checkout, handler family, confidence, field/source ranges и handler evidence.
Workbench отсутствует: нет его команд, draft, credentials или HTTP вызовов.

## Evidence / ограничения проверки

2026-10-06, локальный dev 1.2.0 (не выпуск): 183 Node-теста прошли.
BL corpus: 619 файлов / 617 классов, 3866 definition checks, 283 records и 52 GUID constants.
JS corpus: 7 provider checks на AiAttachment/content, Analyzer/read,
MessageAction/removeThread + getCompactions, UserAssistant/action/name и GPT.request.
Обратный поиск removeThreadAndMessages на актуальных исходниках CLM даёт 1 source call;
fixture содержит 1273 JS-файла, target автоматически не участвует. Без исключения
prototype видел также 4 собранные копии; после уточнения пользователя они не считаются
developer calls. Время source-only cold search около 1 s в mock corpus, не UI SLA.

Это provider/mock проверки, не настоящие Cmd+Click/Peek/Ctrl+Space в VS Code.
Editor gate 4.2 остаётся незавершённым; main spec не синхронизирован, change не архивирован.
BL references, GUID, Java CodeLens/diagnostics покрыты существующим npm test/corpus.
CLM и его submodules использованы read-only; runtime не исследовался/не запускался.


## UX revision 1.2.1

По отдельному запросу пользователя JS→BL перенесён из definition provider в
`bl.showServerSources`: ПКМ → Z8BL → Найти серверные BL-исходники / Command Palette.
Курсор внутри распознанного первого аргумента HttpRequest.send, не обязательно на
request/action/method/name. Единственное подменю Z8BL доступно в BL и JS; BL-only
пункты скрыты в JS. Нативный JS Cmd+Click/F12 не перехватывается.

Список всегда предлагает все доступные категории: класс, диспетчер, ветка,
обработчик. Категории не зависят от выбранного поля; unknown selector не создаёт
фиктивного обработчика, но найденный класс/диспетчер остаётся доступен с пояснением.
Для каждого результата показаны категория, source name, путь, строка и confidence.
Отмена закрывает поиск; изменение буфера/источников/индекса отменяет snapshot.
Контекстная URI должна совпадать с активным JS-документом: другой editor не используется
молча. Открытие результата — ViewColumn.Active, preview:false, без split.

Пустой/неподдержанный контекст и syntax error объясняются видимым сообщением;
неразрешённый класс — пустым списком с пояснением. Target/ исключён как прежде.
Editor gate 4.2 остаётся открытым: mock-тесты не доказывают поведение реального UI.

Проверки UX revision: 186 Node-тестов, 3866 BL corpus definition checks, 7 CLM command checks, strict OpenSpec 10/10. VSIX 1.2.1 собран vsce 4.0.0, состав проверен (Acorn/Acorn-loose включены, tests/specs/CI исключены). Нативный JS provider отсутствует в регистрации; реальный Cmd+Click и контекстное меню проверяются пользователем в editor gate.
