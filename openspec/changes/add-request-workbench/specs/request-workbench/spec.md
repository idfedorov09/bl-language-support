# Spec Delta

## Purpose

Request Workbench позволяет восстановить черновик Z8-запроса по BL-исходникам, проверить и отредактировать его во вкладке редактора, а затем явно отправить в выбранную среду с учётом неполного анализа и рисков изменения данных.

Статус change: **запланировано, не реализовано**; приведённые SHALL/MUST описывают будущий контракт, а не возможности baseline 1.1.0. Реализация требует отдельного запроса пользователя.

## ADDED Requirements

### Requirement: Offline request draft from code

Расширение SHALL показывать CodeLens «Открыть запрос» у распознанного request-класса и операции, которую удалось статически связать с request-маршрутом. Нажатие SHALL открывать новую Postman-like вкладку с локальным черновиком. Открытие, выбор варианта, обновление черновика и восстановление истории MUST NOT отправлять HTTP-запросы, включая probes метаданных, авторизацию и получение runtime-схемы.

#### Scenario: Open draft without a server
- **WHEN** пользователь нажимает CodeLens request-класса без настроенного профиля среды
- **THEN** открывается новая вкладка с именем класса, найденными вариантами и редактируемыми параметрами, а сетевых запросов нет

#### Scenario: Open linked operation
- **WHEN** пользователь нажимает CodeLens операции, для которой известны request-класс, `action` и прикладной `method`
- **THEN** новая вкладка содержит этот маршрут как черновик и не выполняет операцию

### Requirement: Document and checkout context

Построение draft SHALL использовать актуальный несохранённый текст открытых BL-документов и контекст исходного checkout. Одинаковые FQN из разных checkout MUST NOT смешиваться; при неразрешённой неоднозначности расширение SHALL предложить явный выбор источника и указать неполноту схемы, а не незаметно выбирать другую сборку.

#### Scenario: Unsaved dispatcher edit
- **WHEN** пользователь добавляет новую статическую ветку диспетчера в открытый BL-файл без сохранения и открывает его draft
- **THEN** анализ учитывает текущую версию документа, показывает новую ветку и не требует сохранения исходника

#### Scenario: Same class in two checkouts
- **WHEN** workspace содержит две копии одного request FQN и активный файл принадлежит одной из них
- **THEN** вкладка показывает происхождение из контекста активного checkout и не подмешивает параметры второй копии; если контекст не позволяет выбрать, требуется выбор пользователя

### Requirement: Effective request marker and handler family

Автоматическое предложение request-класса SHALL учитывать унаследованный `[request]` и локальное `[request false]`. Один `[entry]` MUST NOT считаться доказательством request-регистрации. Расширение SHALL показывать распознанное семейство Query/Table, Object data/content либо Executable/Job отдельно от маркера регистрации и SHALL пояснять, что исходники не доказывают runtime-доступность и права.

#### Scenario: Inherited request enabled
- **WHEN** класс наследует `[request true]` и не задаёт собственное `[request false]`
- **THEN** он предлагается как request-кандидат с указанием источника унаследованного маркера

#### Scenario: Entry without request proof
- **WHEN** класс имеет только `[entry]` либо явно отключает унаследованный request-маркер
- **THEN** расширение не объявляет его автоматически зарегистрированным request только по `[entry]`; ручной draft не скрывает отсутствие подтверждения

### Requirement: Distinct HTTP request action and method

Вкладка SHALL раздельно показывать HTTP-метод и endpoint, `request` как FQN класса, платформенный `action` и прикладной `method`. Она MUST NOT трактовать `read` как HTTP-метод, `method` как любую публичную BL-функцию или `count`/`totals` как отдельные Z8 actions.

#### Scenario: Standard read
- **WHEN** пользователь выбирает чтение таблицы
- **THEN** интерфейс показывает HTTP POST, `request=<FQN>`, `action=read`, а `count` и `totals` доступны как независимые параметры этого варианта

#### Scenario: Custom content method
- **WHEN** пользователь выбирает прикладной маршрут обработчика content
- **THEN** `action=content` и его `method` отображаются отдельными значениями, не заменяя HTTP POST

### Requirement: Family appropriate variants

Для распознанного Query/Table вкладка SHALL предлагать платформенные варианты без `action` (default), `meta`, `read`, `create`, `copy`, `update`, `destroy`, `action`, `export`, `content`, помечая их как кандидаты, а не гарантию допустимости. Для Object SHALL предлагаться data-вызов и найденный content-обработчик; для Executable SHALL строиться Job-вызов, а не произвольный CRUD. Неизвестное семейство SHALL оставаться явно неизвестным с ручным редактированием маршрута.

#### Scenario: Table with inherited fields
- **WHEN** открывается draft распознанного наследника Table
- **THEN** доступны стандартные Query/Table варианты, и UI не обещает, что пользователь runtime имеет права на каждый из них

#### Scenario: Object data handler
- **WHEN** исходник содержит Object-обработчик `getData(parameters)` без Query/Table-наследования
- **THEN** вкладка не приписывает ему стандартную CRUD-семантику `action=read`

#### Scenario: Executable job
- **WHEN** пользователь открывает распознанный Executable с объявленными параметрами
- **THEN** draft описывает Job-вызов с параметрами job и не предлагает CRUD таблицы по умолчанию

### Requirement: Query and table parameter construction

Для Query/Table вкладка SHALL позволять выбрать найденные field IDs и явно задать `fields`, `recordId`, `start`, `limit`, `filter`, `where`, `quickFilter`, `period`, `having`, `sort`, `group`, `values`, `count`, `totals`, `query` и `link` там, где они относятся к выбранному варианту. Для CRUD SHALL редактироваться `data`, для команд `action` — `name`, `records`, `selection`, `parameters`, для `export` — `columns` и `format`. Вычисляемые поля, ограничения и права SHALL отделяться от пригодности поля для записи.

#### Scenario: Read recipe
- **WHEN** пользователь выбирает поля, пагинацию и сортировку стандартного `read`
- **THEN** preview содержит field IDs, `start`/`limit` и структуру `sort`, а включение `count` не меняет `action=read`

#### Scenario: Update recipe
- **WHEN** пользователь выбирает `update` и вводит ID записи и изменяемые значения
- **THEN** preview содержит `data` с ID и значениями; поля, известные только как выражения, не предлагаются автоматически как writable

#### Scenario: Command versus job parameters
- **WHEN** пользователь переключается между командой таблицы и Executable/Job
- **THEN** параметры команды представлены набором `{id,value}`, а параметры Job — объектом по IDs; UI не выдаёт эти два формата за взаимозаменяемые

### Requirement: Source based custom methods

Вкладка SHALL извлекать прикладные `method` только из найденной маршрутизации и её статически разрешимых констант; публичная функция без такой связи MUST NOT объявляться API-методом. Для подтверждённого AiAttachment-контракта SHALL отдельно предлагаться `action=content` с `copyFromWorkspace`, `copyToWorkspace`, `applyToWorkspace`. Динамические ветки SHALL оставаться явно неразрешёнными.

#### Scenario: AiAttachment routes
- **WHEN** индекс содержит AiAttachment и связанные статические константы/операции из reference fixture
- **THEN** draft предлагает три content-метода с их BL-источниками наряду со стандартными вариантами таблицы

#### Scenario: Arbitrary public method
- **WHEN** request-класс содержит публичный helper без найденной связи с dispatcher
- **THEN** helper не появляется в списке доказанных прикладных `method`

#### Scenario: Computed method name
- **WHEN** dispatcher вычисляет имя метода из runtime-данных
- **THEN** UI показывает «не разрешено статически», сохраняет ручной ввод и не генерирует уверенный маршрут из догадки

### Requirement: Parameter provenance and confidence

Для выведенных маршрутов и параметров вкладка SHALL показывать источник (файл и позицию), основание вывода и уверенность «подтверждено исходником», «предположение» либо «неизвестно». Найденное чтение параметра MUST NOT само по себе объявлять его обязательным, а неполная схема SHALL быть явно обозначена. Типы, defaults и aliases SHALL показываться только с их основанием либо с меткой предположения.

#### Scenario: Parsed GUID and alias
- **WHEN** операция читает `attachmentId` через `guid.parse` и допускает `recordId` как альтернативу
- **THEN** UI показывает GUID-тип и оба имени с источником, не объявляя оба параметра одновременно обязательными

#### Scenario: Incomplete analysis
- **WHEN** часть маршрутизации или параметров находится в неизвестной native/runtime-реализации
- **THEN** draft помечается как частичный и пользователь может дописать параметры без сообщения о гарантированно полной схеме

### Requirement: Manual edits and deliberate regeneration

Вкладка SHALL предоставлять редактируемые form-параметры и текстовое raw-представление их модели, включая неизвестные ключи. Изменение источника, action или обновление схемы MUST NOT молча стирать ручные значения; несовместимые данные SHALL быть показаны пользователю до явного применения нового draft. Raw-редактирование MUST NOT незаметно переключать штатный транспорт на JSON body.

#### Scenario: Preserve manual value
- **WHEN** пользователь вводит собственное значение параметра и затем обновляет draft после изменения BL-кода
- **THEN** до подтверждения слияния сохраняется ручное значение и показывается предложенное изменение

#### Scenario: Unsupported parameter
- **WHEN** пользователь вводит неизвестный анализатору ключ в raw-модель
- **THEN** ключ сохраняется как ручной, отсутствие статического подтверждения обозначено, а отправка не происходит

### Requirement: Z8 transport serialization

Для штатного `request.json` draft SHALL по умолчанию использовать HTTP POST и `application/x-www-form-urlencoded`; при явно добавленных файлах SHALL использовать multipart/form-data. Сложные значения Z8 (`fields`, `data`, фильтры, массивы IDs и параметры команд/Job) SHALL сериализоваться в JSON-строки отдельных form-параметров без двойного кодирования. Raw JSON body MUST NOT предлагаться как эквивалент этого стандартного транспорта.

#### Scenario: Form read serialization
- **WHEN** пользователь готовит standard read с `fields=["recordId","name"]`
- **THEN** wire preview показывает POST в `request.json` и одну JSON-строку для `fields` как form-значение, не объект raw JSON body

#### Scenario: Files require multipart
- **WHEN** пользователь добавляет файл к content-вызову
- **THEN** preview показывает multipart со строковыми параметрами и file parts; draft не загружает файл до Send

### Requirement: Explicit environment profiles and protected credentials

Пользователь SHALL явно выбрать профиль с endpoint и обозначением среды перед Send. Credentials SHALL храниться в защищённом хранилище секретов отдельно от обычных настроек, репозитория и сохранённых drafts; preview SHALL использовать маски/ссылки на секреты. Расширение MUST NOT читать credentials из соседних checkout или выводить их в webview, BL Debug и ошибки. Профиль SHALL поддерживать Z8 session как параметр либо cookie без утверждения, что произвольный bearer token заменяет штатную авторизацию.

#### Scenario: No active profile
- **WHEN** пользователь пытается отправить draft без явно выбранного профиля
- **THEN** Send не выполняет HTTP и просит выбрать endpoint/среду

#### Scenario: Secret persistence
- **WHEN** пользователь сохраняет session credential в профиле
- **THEN** обычные настройки, draft и preview не содержат открытого credential, а значение доступно только механизму исполнения через защищённое хранилище

### Requirement: User initiated execution

Отправка SHALL происходить только после явного Send в доверенном workspace, проверки профиля и всех обязательных подтверждений. Открытие вкладки, изменение параметров, импорт/экспорт, восстановление истории или запрос схемы MUST NOT самостоятельно инициировать сеть. Изменяющие и неизвестные запросы MUST NOT автоматически повторяться после transport failure; отмена SHALL пояснять, что прекращение ожидания не гарантирует откат серверной операции.

#### Scenario: Untrusted workspace
- **WHEN** пользователь нажимает Send в недоверенном workspace
- **THEN** HTTP-запрос не выполняется и UI объясняет ограничение доверия

#### Scenario: No hidden metadata probe
- **WHEN** пользователь выбирает `meta` или обновляет автоматически найденные поля
- **THEN** строится локальный draft/анализ, а запрос метаданных возможен только отдельным явным Send

#### Scenario: Failed mutation is not retried
- **WHEN** исполнение `update` завершилось transport failure с неизвестным результатом на сервере
- **THEN** UI показывает неопределённость результата и не повторяет запрос автоматически

### Requirement: Side effect risk and confirmations

Вкладка SHALL различать известные изменяющие операции и операции с неизвестными побочными эффектами и MUST требовать отдельное подтверждение перед их Send. `create`, `copy`, `update`, `destroy`, пользовательские content/commands и Executable SHALL считаться изменяющими либо неизвестными. `read`, `meta` и default SHALL показывать предупреждение «не гарантированно read-only»; наличие прикладных hooks/getData или неразрешённого поведения SHALL переводить их в категорию неизвестного риска. Подтверждение SHALL включать endpoint/среду, маршрут и согласованные параметры и SHALL терять силу при их изменении.

#### Scenario: Destructive request cancelled
- **WHEN** пользователь нажимает Send для `destroy` и отменяет подтверждение
- **THEN** ни один HTTP-запрос не отправляется

#### Scenario: Read with custom hook
- **WHEN** выбран `read` класса с прикладным `beforeRead` либо неизвестной реализацией hook
- **THEN** UI не маркирует запрос как гарантированно безопасный и требует подтверждение неизвестного риска перед Send

#### Scenario: Confirmation does not authorize another endpoint
- **WHEN** пользователь меняет профиль после подтверждения потенциально изменяющей операции
- **THEN** старое подтверждение не разрешает отправку в новую среду

### Requirement: Transport and Z8 result are distinct

После явного исполнения вкладка SHALL раздельно отображать transport error/HTTP status, Z8 `success`/status/messages при наличии JSON-envelope и тело ответа. HTTP 200 MUST NOT само по себе считаться прикладным успехом. Бинарный ответ SHALL отображаться как бинарный, Job-ответ — как job identifier/state без неявного polling; недоступный Z8-envelope SHALL обозначаться как неизвестный, а не успешный.

#### Scenario: HTTP 200 application failure
- **WHEN** ответ имеет HTTP 200 и Z8 `success=false`
- **THEN** вкладка показывает HTTP 200 отдельно и обозначает прикладную ошибку с её доступными сообщениями

#### Scenario: Binary content response
- **WHEN** content-запрос возвращает бинарные данные вместо JSON-envelope
- **THEN** UI не пытается доказать Z8 `success` разбором бинарного тела и показывает тип/размер и доступное сохранение файла

#### Scenario: Job response
- **WHEN** Executable возвращает идентификатор job
- **THEN** вкладка показывает job ID и доступное состояние, но не начинает автоматически polling

### Requirement: Sanitized history and export

Сохранённая история и экспорт draft/HTTP/cURL SHALL исключать credentials, cookies, session, чувствительные headers и явно помеченные пользователем sensitive-параметры, заменяя их placeholders. Полные тела ответов MUST NOT сохраняться в истории по умолчанию. Перед экспортом SHALL показываться санитизированное содержимое для проверки; восстановление истории SHALL создавать новый неподписанный draft без отправки и ранее выданного подтверждения.

#### Scenario: Export does not disclose session
- **WHEN** пользователь экспортирует запрос с session и sensitive custom header
- **THEN** экспорт и его preview содержат placeholders вместо значений секретов и не выполняют HTTP

#### Scenario: Restore is draft only
- **WHEN** пользователь восстанавливает историю потенциально изменяющего запроса
- **THEN** открывается draft без credentials и действующего подтверждения, а сеть и polling не запускаются

### Requirement: Existing language features remain available

Request Workbench SHALL добавляться независимо от существующих definitions/references, диагностики и переходов native/compiled Java; CodeLens запросов MUST NOT заменять Java CodeLens. При отключении Workbench или ошибке его анализа существующие языковые функции SHALL сохранять baseline-поведение, а ошибка построения draft SHALL показываться явно без выполнения сети или скрытого запуска альтернативного обработчика.

#### Scenario: Java lens remains
- **WHEN** у BL-класса доступны compiled Java и распознанный request-маршрут
- **THEN** пользователь видит отдельные переходы Java и открытие draft без потери Java-навигации

#### Scenario: Workbench disabled or analysis fails
- **WHEN** Workbench отключён либо анализ request-схемы завершается ошибкой
- **THEN** BL definitions/references и существующая диагностика продолжают работать; при ошибке UI сообщает её, не отправляя запрос
