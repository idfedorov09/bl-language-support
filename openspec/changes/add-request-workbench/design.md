# Design

Статус: **запланировано, не реализовано**. Решения описывают будущую реализацию по отдельному запросу, а не готовый Workbench. Никакие реальные HTTP-запросы, UI-проверки и изменения extension source в текущую задачу не входят.

## Context

Мотивация — [proposal.md](proposal.md), наблюдаемый контракт — [specs/request-workbench/spec.md](specs/request-workbench/spec.md).

Baseline 1.1.0 — CommonJS-расширение, не LSP. В `extension.js` есть `BlCodeLensProvider` с отдельными native/compiled Java-ссылками, регистрация провайдеров, настройка `bl.codeLens.enabled`, versioned document caches и lifecycle событий. `blIndex.js` хранит FQN, импорты, наследование, members/methods и несколько копий классов; `documentAnalysis.js` сохраняет координаты и локальные области. Общая схема request-атрибутов/dispatcher отсутствует: стандартная очистка маскирует строки, native-атрибуты извлекаются отдельно. Нет webview, профилей или HTTP-клиента. Тесты в `test/` запускаются через Node и mock VS Code; mock пока не моделирует webview/SecretStorage/HTTP.

### Verified reference, not runtime evidence

Ниже пути относительно корня репозитория; sibling `../pro.doczilla.clm` — источник исследования, не обязательная установленная зависимость расширения. Проверен только код, не доступность стенда, реальная авторизация или принадлежность runtime текущему Git HEAD.

| Контракт | Reference path / ключевой участок |
| --- | --- |
| Endpoint `request.json`, чтение form/query или multipart, не raw JSON | `../pro.doczilla.clm/org.zenframework.z8/org.zenframework.z8.servlet/src/main/java/org/zenframework/z8/web/server/{SystemAdapter,RequestParser}.java` |
| Session из параметра/cookie, авторизация и host/schema | тот же каталог, `Adapter.java`, `authorize` и `parseRequest` |
| Class loading и execute privilege | `../pro.doczilla.clm/org.zenframework.z8/org.zenframework.z8.server/src/main/java/org/zenframework/z8/server/request/{RequestDispatcher,Loader}.java` |
| Query/Table actions и переключение `query`/`link` | тот же server source root, `request/actions/ActionFactory.java`, `create` и `initialize` |
| Object JSON data/content; Query platform dispatch; Executable Job | тот же source root, `runtime/OBJECT.java`, `base/query/Query.java`, `base/Executable.java`, `base/job/Job.java` |
| MetaAction наследует ReadAction; hooks и custom getData даже для чтения | тот же source root, `request/actions/{MetaAction,DefaultAction,ReadAction}.java` |
| Request inherited, Entry local | `../pro.doczilla.clm/org.zenframework.z8/org.zenframework.z8.compiler/src/main/java/org/zenframework/z8/compiler/workspace/StartupCodeLines.java` |
| AiAttachment content dispatcher | `../pro.doczilla.clm/pro.doczilla.cloud.gpt/src/main/bl/pro/doczilla/gpt/attachment/table/AiAttachment.bl` и `../pro.doczilla.clm/pro.doczilla.cloud.gpt/src/main/bl/pro/doczilla/gpt/attachment/operation/{Operation,CopyFromWorkspace,CopyToWorkspace,ApplyToWorkspace}.bl` |

`[request]` — сигнал регистрации и отображения кандидата, но HTTP dispatcher не использует registry как строгий whitelist: Loader загружает сгенерированный `$CLASS`, после чего проверяется execute privilege. Поэтому отсутствие маркера не доказывает невозможность ручного вызова, а наличие не доказывает runtime-доступность. `Table` наследует Query; pure Query может получать данные из собственного getData. Список ActionFactory не равен списку допустимых операций для каждой таблицы и роли.

## Goals / Non-Goals

**Goals:**
- Независимый offline-конвейер `BL snapshot → route candidates → editable draft → wire preview`; сетевое исполнение отделено явной границей Send.
- Расширить существующий индекс точечными метаданными, сохраняя навигацию, координаты и работу нескольких checkout/несохранённых документов.
- Показывать происхождение вывода и неопределённость вместо вычисления BL-кода, скрытых probes и уверенной схемы из regex-совпадений.
- Сделать риск отправки и обработку credentials отдельным проверяемым контрактом, доступным тестированию без стенда.

**Non-Goals:**
- Общий AST/полная семантика BL, LSP, массовый перенос `extension.js` или компиляция native-обработчиков.
- Автоподключение к runtime, автоматическое чтение метаданных, создание сессии при открытии draft, автоматический Job polling или повтор изменяющего запроса.
- Доказывать read-only, права, обязательность всех параметров или совпадение исходников с серверной сборкой.
- Добавлять generic services/managers/fallback-архитектуру, чуждую текущим CommonJS-модулям.

## Decisions

### 1. Separate additive provider and local draft controller

Использовать существующий контекст класса и document analysis; новый request CodeLens/команда открывают webview draft и не вызывают transport. Java CodeLens остаётся отдельным, с исходным поведением `bl.codeLens.enabled`; Request Workbench получает собственное включение/выключение. Ошибка его анализа не должна останавливать базовые providers. Связанные operation-линзы строятся только при найденном маршруте; несколько родителей/маршрутов показываются как выбор.

Не запускать поиск всего corpus при каждом `provideCodeLenses`: переиспользовать index revision/document version, ограниченный cache, debounce и cancellation. Сохранять диапазоны после очистки текста. Draft связан с URI/версией и выбранным checkout; при обновлении показывать изменения, а не незаметно переоткрывать вкладку или стирать ручные значения.

Альтернативы: gutter-иконка может быть отдельным UI после прототипа, но CodeLens уже соответствует существующему интерфейсу. Полная замена Java provider или новый LSP отвергнуты: не нужны для draft и расширяют scope.

### 2. Small literal-aware request analysis, not BL execution

Добавить ограниченный слой анализа request-атрибутов, статических string-констант, известных dispatcher-веток и чтений `parameters[...]`. Он использует строкосохраняющую очистку/lexical ranges, но не меняет глобально sanitizer, на котором завязаны диагностика и references. Общие additions к class metadata минимальны; метод bodies/parameter evidence доступны отдельному анализу с versioned cache. Расширение не исполняет initializers, BL, Java, Gradle или код workspace.

Планируемые данные:
- `route`: исходный URI/checkout, class FQN, effective request marker и его source, family, action, optional custom method, dispatch evidence.
- `parameter`: имя, предполагаемый тип, default/alias/required evidence, confidence, source ranges, пометка sensitive.
- `draft`: выбранный route и профиль, transport, пользовательские значения/файлы, generation snapshot и риск. Секреты — только ссылки; состояние подтверждения не сохраняется в history.

Confidence: «подтверждено исходником» для прямой связи/константы; «предположение» для типа/ограничения, выведенного эвристикой; «неизвестно» для computed/native/unresolved. Найденное чтение ключа не равно доказательству required. Для `guid.parse(parameters[AttachmentId]) ?: guid.parse(parameters[Json.recordId])` показывать альтернативные имена, а не требовать оба. Динамическую маршрутизацию не подменять похожим публичным методом.

Альтернатива: один regex по всем публичным методам даёт ложный API; runtime introspection нарушает offline-контракт; компилятор/LSP не согласованы. Поэтому явно частичная схема и ручной режим — намеренный интерфейс, не скрытый обход анализа.

### 3. Family-specific recipes distinguish all routing layers

Платформенные recipes хранить как версии описанного source-контракта с provenance. Это кандидаты, не runtime capabilities. Разделить HTTP POST, endpoint, FQN `request`, `action` и custom `method` в модели и UI.

| Family / вариант | Recipe |
| --- | --- |
| Query/Table default, `meta`, `read` | Поля, filters, sort/group, pagination, `recordId`, `values`, `query`/`link`; `count`/`totals` — flags read, не actions |
| `create`, `copy`, `update`, `destroy` | `data` с правильными IDs/значениями; copy дополнительно принимает исходные `recordId`; writable != произвольный expression field |
| `action` | Команда по `name`, `records`, `selection`, `parameters=[{id,value}]` |
| `export` | `columns=[{id,width}]`, `format`, read filters/sort |
| Object | По найденному handler: data/default или content; не считать `action=read` универсальным |
| `content` | Точечный dispatcher и его параметры; не обязательно только скачивание |
| Executable/Job | `parameters` JSON-object по параметрам Job; показать Job response; никакого auto-polling |

AiAttachment reference сочетает стандартную Table-семантику и `content`-методы `copyFromWorkspace`, `copyToWorkspace`, `applyToWorkspace`. Поля `recordId`, `name`, `threadId`, `workspaceId` полезны для read draft; custom методы анализируются через `getOperation` и const values в `Operation.bl`. Например, `copyToWorkspace` принимает `attachmentId` либо `recordId`. Эту прикладную схему извлекать из источника, не hardcode имени AiAttachment в общую платформу.

Две копии одного FQN должны сохранять provenance и контекст. Текущий `preferNearbyClasses` полезен, но его первый результат не является доказательством выбора при равных кандидатах: для request-схемы проверять неоднозначность явно. Raw/manual режим сохраняет неизвестные ключи; регенерация — пользовательское применение diff. Одновременные `count`/`totals` отражают выбранные flags и платформенные приоритеты, не отдельные «методы подсчёта».

### 4. Z8-specific wire serialization

Штатный endpoint — пользовательский base URL + `request.json`; новый draft по умолчанию POST, form-urlencoded. Сложные значения сериализуются в JSON один раз как значения form-полей, затем URL-encoding. `raw` в редакторе — редактирование модели параметров и просмотра wire, не утверждение, что сервер принимает raw JSON. Файлы переводят transport в multipart; binary field/file metadata требуют отдельного fixture по контракту RequestParser и операции. Не читать содержимое/не загружать файлы просто при открытии линзы.

Исполнение находится в extension host, не в webview. Опора на `node:http`/`node:https` с тестируемым adapter предпочтительна неявному использованию global fetch: текущий `engines.vscode` начинается с `^1.60.0`. Поддержка Remote extension host, proxy, multipart и abort требует локального прототипа и проверки минимальной поддерживаемой версии; без необходимости не повышать engine и не добавлять зависимость молча. Credentials подставляются непосредственно перед Send. Не принимать команду webview как разрешение менять endpoint без проверки; redirects на другой origin не должны передавать credentials.

Альтернатива: универсальный Postman-клон слишком широк; raw JSON body по имени endpoint вводит в заблуждение. Цель — минимальный Z8 transport с открытым wire preview.

### 5. Explicit execution gate, conservative risk

Состояния: draft → validated → awaiting confirmation (если риск известный изменяющий/unknown) → sending → response/transport failure. Send требует доверенного workspace и явно выбранного профиля. Отмена/изменение endpoint, маршрута или payload сбрасывает подтверждение. Открытие, смена action, обновление схемы и экспорт — чисто локальные операции, включая `meta`.

CRUD mutation, commands, custom content и Executable — mutating/unknown. Default/read/meta имеют постоянное «не гарантированно read-only» и повышаются до unknown при прикладных hooks, getData, неразрешённой цепочке/native-конфигурации. В reference ReadAction вызывает hooks до формирования ответа; MetaAction наследует этот initialization. Поэтому «безопасный потому что read/meta» не является категорией. Для production/необозначенной среды требуется особенно заметное указание endpoint/маршрута в подтверждении, без auto-selection другой среды.

Не делать retry изменяющего/unknown запроса автоматически, не повторять Send при re-render/восстановлении вкладки. Timeout/abort — прекращение клиентского ожидания, не откат. Результат с неизвестным состоянием сервера сообщать прямо. Получение runtime metadata возможно только отдельным draft+Send; оно не является обязательным для UI.

### 6. Profiles, webview boundary and sanitized persistence

Обычные настройки хранят только ID/name профиля, base URL и обозначение среды; credentials — VS Code SecretStorage с областью workspace/profile. Штатный session credential может идти параметром/cookie; дополнительные sensitive headers явно конфигурируются без обещания bearer-авторизации Z8. Не импортировать `.env`, browser cookies или runtime secrets автоматически.

Webview получает только draft/metadata/маскированные ссылки на credentials, валидируемые сообщения и санитизированный preview; секреты разрешаются в extension host. Задать строгий CSP, локальные ресурсы, escaping BL-строк и ответов, запрет внешних scripts/непроверенных command URI. API-ответы — данные, не HTML/код. Secrets не попадают в логи, error details и обычное persisted state.

History по умолчанию содержит санитизированный маршрут/параметры и минимальное описание результата без response body. Sensitive keys/headers/cookies/URL-параметры маскируются; custom parameters пользователь может пометить чувствительными. Экспорт HTTP/cURL строится только из санитизированной модели и показывается до сохранения; история восстанавливается как новый draft без secret values и confirmation. Нельзя обещать определить все персональные/бизнес-данные автоматически: review export обязателен, raw response не сохраняется автоматически.

### 7. Results separate transport from application outcome

Отображать HTTP status/headers/timing отдельно от Z8 envelope `success`, status/messages и data. HTTP 200 с `success=false` — прикладная ошибка. Отсутствие envelope — неизвестно/не применимо, а не `success=true`. Binary content и export отображаются как файл/тип/размер, JSON через escaped text/tree. Job ID не означает завершение; любое дальнейшее получение статуса — отдельное пользовательское действие.

Альтернатива: красный/зелёный статус только по HTTP недостаточен для Z8 и скрывает ошибку. Автоматический polling нарушает offline/explicit-send границу и откладывается, а не встраивается скрытно.

## Risks / Trade-offs

- [Эвристический индекс не содержит полного dispatcher/attributes AST] → узкий literal-aware анализ, provenance и partial-schema; отдельные fixtures для несохранённого/незавершённого текста, без исполнения BL.
- [Несколько FQN и native/runtime replacement] → сохранять checkout/document context и неоднозначность; исходник не выдавать за контракт текущей сборки.
- [Read/meta могут иметь побочные эффекты] → постоянное предупреждение, консервативная unknown-классификация hooks и обязательное подтверждение неизвестного риска.
- [Credentials или документы могут утечь через preview/export/logs] → host-side secret resolution, CSP/escaping, sanitization known/configured secrets и пользовательский review; полные response bodies не сохранять по умолчанию.
- [Transport timeout после успешной мутации] → не повторять автоматически, явно показывать неопределённый результат и отсутствие гарантии отката.
- [Большой workspace и анализ транзитивных операций] → bounded caches, version/index invalidation, ограниченный список traversal и cancellation; неподдержанный участок остаётся unknown, не guessed route.
- [Node/VS Code compatibility и Remote host] → проверить `^1.60.0`, transports и webview lifecycle на локальных mocks/прототипах; не полагаться на global fetch и не менять engines без отдельного обоснования.
- [Формат multipart/Job/command неодинаков] → отдельные сериализаторы recipes и fixture assertions; не объединять разные форматы под одним «универсальным JSON».

## Migration Plan

Сейчас сохраняются только planning artifacts, все implementation tasks незавершены. В будущей реализации начать с offline draft и тестов; executor/profiles добавить отдельно в рамках того же согласованного контракта после offline/security fixtures. Baseline-провайдеры и настройки не мигрировать и не переименовывать. Новую конфигурацию вводить с независимым выключением Workbench; неизвестную версию saved draft не исполнять, сообщать о невозможности восстановления.

При проблеме отключение Workbench оставляет baseline features доступными; rollback будущего кода не должен удалять пользовательские credentials/сохранённые drafts автоматически. Удаление профиля/истории — явное действие. Version bump, release, sync main specs и archive выполняются только после отдельного запроса и релевантных проверок; этот документ не назначает номер релиза.

## Open Questions

- Точная компоновка Postman-like webview и добавление gutter-иконки проверяются локальным UI-прототипом по отдельному запросу; CodeLens+новая вкладка остаются обязательной точкой входа.
- Конкретные UX labels уровней confidence и дополнительных profile fields можно уточнить при реализации без изменения safety/offline-контрактов.
- Размеры cache/истории/response preview уточняются measurements на fixture/corpus; bounded retention и отсутствие автоматического сохранения raw response остаются обязательными.
