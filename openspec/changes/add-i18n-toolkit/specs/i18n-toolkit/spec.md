# Spec Delta

## Purpose

Давать разработчику Z8BL единый toolkit для поиска и редактирования языковых
ресурсов, с опциональными модельными предложениями и контролируемым сохранением.

## ADDED Requirements

### Requirement: Edit Translation по выбранному ключу

Toolkit SHALL открывать окно выбранного локализационного ключа со строками языков:
слева locale, справа редактируемое значение. Окно SHALL показывать missing/conflict,
ресурс и исходный язык; preview/Apply и discard SHALL быть явными отдельными действиями. Применение SHALL менять native NLS-буферы, не сохранять их на диск автоматически.

#### Scenario: Несколько языков
- **WHEN** пользователь открывает Workspace.title в checkout с ru/en/uz ресурсами
- **THEN** видны отдельные строки ru/en/uz, пустое missing поле отличается от существующего пустого значения, ручные изменения остаются в черновике до Save

#### Scenario: Закрытие и восстановление
- **WHEN** пользователь закрывает вкладку с подтверждённым host черновиком и повторно открывает тот же ключ в том же checkout
- **THEN** черновик восстанавливается из local workspace storage, а BL и ресурсы не меняются; другой checkout не получает эти поля

#### Scenario: Явный discard
- **WHEN** пользователь выбирает «Отменить изменения»
- **THEN** удаление изменённого черновика требует подтверждения; отмена диалога сохраняет его

#### Scenario: Ошибка сохранения черновика
- **WHEN** storage update не завершился успешно
- **THEN** окно не показывает «Черновик сохранён», объясняет ошибку и сохраняет текущие поля для копирования/повторного сохранения

### Requirement: Единый checkout и актуальные ресурсы

Toolkit SHALL использовать языковой resolver локализации, несохранённые буферы и
scope выбранного checkout. Противоречивые дубли MUST NOT разрешаться случайным
приоритетом. Неоднозначный выбор источника для изменения SHALL быть явным; однозначный целевой ресурс SHALL выбираться автоматически по family-scoped правилу ниже.

#### Scenario: Два checkout
- **WHEN** одинаковый ключ имеет разные переводы в двух workspace-папках
- **THEN** окно/поиск используют checkout исходного BL, не другой; без контекста сначала выбирается scope

#### Scenario: Конфликт ресурсов
- **WHEN** один язык содержит противоречащие значения ключа в нескольких ресурсах
- **THEN** пользователь видит варианты и выбирает целевой ресурс до изменения

### Requirement: Подсказки ключей в BL

Toolkit SHALL предоставлять completion внутри локализационного литерала с ключом,
переводом выбранного языка и источником. Применение SHALL сохранять синтаксис
литерала и вставлять ключ, не значение перевода; comments/обычные строки вне
контекста MUST NOT подменяться локализационными предложениями. Один общий BL/file
provider SHALL использовать read-only checkout NLS snapshot/resolver, unsaved
buffers и исключения. Preview SHALL различать missing/conflict/unavailable без
fallback; source Markdown MUST NOT быть trusted. Invalid keys MUST NOT предлагаться.
Results SHALL быть bounded (200) с incomplete continuation; stale/cancelled/version-
changed requests MUST NOT возвращать координаты старого документа.

#### Scenario: Выбор подсказки
- **WHEN** пользователь дополняет "$Workspace.t$" и выбирает Workspace.title
- **THEN** BL содержит "$Workspace.title$", не "Документы", без дублирования $/кавычек

#### Scenario: Частично введённые delimiters
- **WHEN** курсор находится после key prefix внутри "$Workspace.t", "$Workspace.t (незакрытая строка), "$" или "$$"
- **THEN** выбор дополняет key и недостающие closing $/quote только в текущей строке, без duplicate delimiters и без additional commands/edits

#### Scenario: Комментарии и обычные строки
- **WHEN** cursor внутри comment, обычного/single-quoted/escaped/multiline литерала либо после closing $/quote
- **THEN** localization completion отсутствует и не меняет документ

#### Scenario: Unsaved ресурсы и язык
- **WHEN** обнаруженный NLS имеет несохранённый ключ и пользователь меняет active locale
- **THEN** следующий completion использует актуальные keys/preview из этого checkout, не другой папки или target/build

#### Scenario: Конфликтный перевод
- **WHEN** выбранный язык имеет conflicting sources или broken resource
- **THEN** detail обозначает conflict/unavailable, documentation содержит источники, но не выдаёт произвольное значение за перевод

### Requirement: Поиск по переводам и выбор ключа

Toolkit SHALL искать по ключу и текстам переводов в доступных языках выбранного
scope, показывать locale/source и поддерживать переход в ресурс. При выборе для
вставки SHALL проверяться актуальность исходного BL-документа и позиции.

#### Scenario: Поиск по значению
- **WHEN** пользователь ищет «Документы» и выбирает результат Workspace.title / ru
- **THEN** preview показывает ключ/язык/источник; явная вставка добавляет локализационный ключ в исходный BL

#### Scenario: Исходный документ изменён
- **WHEN** BL изменился или активный editor сменился после открытия выбора
- **THEN** результат не вставляется молча в устаревшую позицию или другой файл

### Requirement: Опциональная настройка модели и промпта

Toolkit SHALL предлагать user-controlled OpenAI-compatible endpoint/model и отдельный
translation prompt. API key MUST храниться в защищённом хранилище, не в settings,
XML, логах или webview. Без конфигурации AI SHALL быть недоступен с пояснением;
ручное редактирование MUST оставаться работоспособным.

#### Scenario: Промпт пользователя
- **WHEN** пользователь задаёт стиль перевода отдельной настройкой
- **THEN** следующий явный запрос учитывает промпт и показывает выбранные source/target locales и модель до отправки

#### Scenario: Endpoint отсутствует
- **WHEN** профиль модели не настроен
- **THEN** окно работает offline, а Auto Translate не отправляет запрос и объясняет недостающую настройку

### Requirement: Только явный Auto Translate

Открытие/поиск/редактирование SHALL быть offline. Сетевой запрос SHALL выполняться
только по нажатию Auto Translate в trusted workspace, после подтверждения endpoint
и передаваемого содержимого. SHALL передаваться только выбранный текст/ключ/языки
и согласованный контекст, не весь проект. Другой provider/язык MUST NOT подставляться
молча; credentials MUST NOT пересылаться на другой host через redirect.

#### Scenario: Окно открыто
- **WHEN** пользователь открывает Edit Translation или меняет язык/профиль
- **THEN** число сетевых запросов равно нулю, включая discovery моделей и auto-auth

#### Scenario: Перевод выбранных языков
- **WHEN** пользователь подтверждает перевод ru → en/uz кнопкой Auto Translate
- **THEN** видны waiting/Cancel; отправляется только выбранный payload в выбранный endpoint

### Requirement: Ответ модели является черновиком

Валидный ответ SHALL автоматически заполнять выбранные поля черновика с пометкой
AI suggestion, без автоматического Save. Существующие переводы и edits, сделанные
во время ожидания, MUST NOT перезаписываться без явного выбора. Некорректный ответ
MUST NOT менять исходники или частично применять непроверенные поля.

#### Scenario: Успешный ответ
- **WHEN** модель вернула валидные en/uz значения для выбранного ключа
- **THEN** поля автоматически заполнены как предложения; ресурсы неизменны до preview/Save

#### Scenario: Ручная правка во время ожидания
- **WHEN** пользователь поменял en до прихода ответа
- **THEN** его en сохраняется; AI-вариант показан отдельно для выбора

### Requirement: Целостность и ошибки AI-перевода

Toolkit SHALL сохранять проверяемые placeholders/шаблонные параметры и валидировать
набор target locales и строковых значений. Errors/timeouts/unsupported responses
SHALL объясняться без потери черновика. Cancel/закрытие окна SHALL отменять ожидание;
поздний/stale ответ MUST NOT применяться. Автоматический retry MUST NOT выполняться.

#### Scenario: Повреждённый placeholder
- **WHEN** ответ меняет или теряет обязательный {name} либо %s
- **THEN** предложение помечается невалидным и не подставляется автоматически в поле

#### Scenario: Отмена
- **WHEN** пользователь нажал Cancel или закрыл окно при запросе
- **THEN** поздний ответ не обновляет UI/XML; показано отсутствие гарантии отмены вычисления/списания у провайдера

### Requirement: Versioned preview и безопасный Save

Save SHALL показывать многофайловый preview и проверять свежесть всех затронутых
буферов/ресурсов. Apply MUST NOT перезаписывать чужие изменения, XML-экранирование,
комментарии или unrelated keys. Отмена preview SHALL оставлять файлы неизменными.

#### Scenario: Несохранённый ресурс изменился
- **WHEN** NLS-буфер изменился после загрузки окна или preview
- **THEN** Save требует обновить/согласовать конфликт, не перезаписывая свежий текст

### Requirement: Theme-aware и доступное окно

Окно SHALL использовать тему VS Code для текста, фона, полей, focus, warning и
контраста, обновляться при смене темы и поддерживать клавиатуру/доступные labels.
Веб-контент/ответ модели MUST NOT исполняться как HTML/команда; ошибки MUST NOT
передавать секреты в UI.

#### Scenario: Смена темы
- **WHEN** тема меняется со светлой на тёмную или high contrast при открытом окне
- **THEN** поля и статусы остаются читаемыми, фокус различим, черновик сохраняется


### Requirement: Offline UX и staged Apply

Offline editor SHALL следовать acceptance контрактам ux-research.md: одно primary
действие на фазу, видимые статусы, локальное восстановление подтверждённых drafts,
text-labelled missing/empty/conflict и concrete recovery. Preview SHALL показывать
только изменённые языки с файлами и было/стало. Apply SHALL быть text-only atomic
WorkspaceEdit в обычных буферах; автоматический disk save MUST NOT выполняться.
Дубли/конфликт SHALL требовать выбора целевого source, missing — существующего
ресурса; implicit creation/guess/merge MUST NOT выполняться.

#### Scenario: Возврат из preview
- **WHEN** пользователь выбирает «Назад к переводам»
- **THEN** все draft поля остаются, NLS не изменяется, primary снова «Сохранить…»

#### Scenario: Apply и штатное сохранение
- **WHEN** пользователь применяет актуальный preview в trusted workspace
- **THEN** обычные .nls buffers получают surgical edits, UI объясняет Save/Save All и Undo, unrelated XML/comments/line endings сохраняются

#### Scenario: Новый контекст ресурса
- **WHEN** target buffer/source изменился после load или preview
- **THEN** Apply блокируется с пояснением и действием обновления; поля пользователя не теряются и не делается silent rebase


### Requirement: Компактный редактор с раскрываемыми подробностями

Toolkit SHALL по умолчанию показывать ключ, locale/value строки и Close/Save без
постоянных found banners, resource paths или служебного toolbar. Технические
подробности SHALL быть доступны через disclosure. Missing/conflict/unavailable/stale
SHALL оставаться видимыми; обязательный source chooser SHALL раскрываться при
отсутствии target. Save SHALL открывать компактную обязательную review-фазу с
изменёнными языками, объяснением native buffers и раскрываемым full diff. Существующие
guard/draft/Apply контракты MUST NOT ослабляться ради упрощения.

#### Scenario: Обычный перевод
- **WHEN** ключ разрешён в одном ресурсе каждого языка
- **THEN** видны компактные поля без found banners, а source/path/reload/discard скрыты в раскрываемых подробностях

#### Scenario: Неоднозначный source
- **WHEN** target отсутствует при missing или duplicate/conflict
- **THEN** chooser виден сразу; Save недоступен для edited строки без выбранного target

#### Scenario: Подтверждение черновика
- **WHEN** storage подтверждает ввод или пользователь возвращается из review
- **THEN** ввод и фокус не теряются, раскрытые пользователем source details не схлопываются

### Requirement: Ввод исходного текста перед AI-переводом

Auto Translate SHALL сначала открывать редактируемый исходный текст с
выбором source/target locales. Первое нажатие MUST NOT отправлять запрос. Отправка
SHALL происходить отдельным действием Translate после payload/endpoint/model
review и consent; результат SHALL оставаться draft proposal без auto-save.

#### Scenario: Пользователь задаёт текст
- **WHEN** пользователь выбирает AI translation, вводит текст и подтверждает отправку
- **THEN** переводится именно подтверждённый текст для выбранных языков, а не неявно весь ресурс

#### Scenario: Отмена ввода
- **WHEN** пользователь закрыл шаг исходного текста до отправки
- **THEN** число запросов равно нулю, существующие поля и ресурсы неизменны


### Requirement: Пользовательский endpoint и изолированные credentials

AI настройки SHALL использовать global/default values без workspace overrides.
Credentials SHALL храниться per endpoint в SecretStorage и разрешаться только
после consent перед Send. Webview MUST NOT получать credential или raw API errors.
HTTP SHALL требовать отдельное согласие; redirects/retries/discovery MUST NOT
выполняться. Request/response SHALL иметь конечный таймаут и предел размера.

#### Scenario: Смена провайдера
- **WHEN** пользователь меняет base URL после сохранения ключа
- **THEN** старый credential не используется для нового endpoint, а prepared review инвалидируется

#### Scenario: Подмена settings проектом
- **WHEN** workspace settings содержат другой endpoint/model/prompt
- **THEN** Send использует только пользовательскую конфигурацию, не значения проекта

#### Scenario: Отмена до получения credential
- **WHEN** отмена или закрытие пришли во время consent/SecretStorage lookup
- **THEN** prepared gate инвалидируется немедленно, запрос после завершения lookup не отправляется

### Requirement: Atomic AI draft и revision-bound proposals

Ответ SHALL валидироваться полностью до изменения draft. Auto-fill SHALL затрагивать
только unchanged missing/empty поля; другие поля SHALL показывать предложение с
явным revision-bound accept. Выбор ресурса без изменения текста SHALL сохранять
AI provenance. Draft updates SHALL проверять общий лимит до commit; storage errors
MUST NOT выдавать in-memory поля за сохранённый draft. Сеть MUST NOT блокировать
очередь ручного ввода/Cancel. AI input/payload MUST NOT сохраняться в workspaceState.

#### Scenario: Устаревшее нажатие использовать
- **WHEN** поле изменилось после показанного предложения и до обработки accept
- **THEN** accept со старым row revision не заменяет новое значение

#### Scenario: Невалидный второй язык
- **WHEN** один перевод валиден, но другой нарушает schema/placeholder/size contract
- **THEN** ни одно поле не заполняется частичным ответом

#### Scenario: Возврат к тексту запроса
- **WHEN** пользователь выбирает «Изменить текст» на review запроса
- **THEN** input сохраняется, prepared token сбрасывается, отправка требует нового review


### Requirement: Компактная AI форма и выбранные целевые языки

AI input form SHALL использовать компактные постоянные labels и все доступные
целевые языки selected по умолчанию независимо от existing/edited значения. Source
locale SHALL не отображаться как выключенный target и MUST NOT попадать в target
payload. Смена source SHALL сохранять выбор остальных языков. Host acknowledgements
MUST NOT сбрасывать выбор пользователя. Пояснения storage/advanced limitations SHALL
не перегружать основной input шаг; consent и cancellation/payment предупреждение
SHALL оставаться видимыми в соответствующей фазе. Overwrite/guard contracts MUST NOT
ослабляться. При нулевом выборе SHALL объясняться причина недоступного primary.

#### Scenario: Все целевые языки
- **WHEN** пользователь открывает AI форму для ru в проекте с ru/en/uz ресурсами
- **THEN** en и uz selected, ru отсутствует в видимой группе целей, ручные/existing значения не перезаписываются без предложения/accept

#### Scenario: Смена исходного языка
- **WHEN** пользователь снял выбор uz и переключил source с ru на en
- **THEN** en скрыт из целей, ru выбран, uz остаётся невыбранным и input сохраняется

#### Scenario: Подтверждение состояния host
- **WHEN** приходит state acknowledgement или пользователь возвращается к input из review
- **THEN** выбранные target языки и исходный текст не сбрасываются

#### Scenario: Ни одного языка
- **WHEN** доступен только source или все цели сняты
- **THEN** primary недоступен с конкретным пояснением, запрос не отправляется


### Requirement: Массовое принятие предложений текущего ключа

Toolkit SHALL показывать contextual панель только при наличии AI proposals текущего
ключа. Все доступные предложения SHALL быть selected по умолчанию; общий checkbox
SHALL выбирать/снимать весь доступный набор и показывать mixed state при частичном
выборе. Выбор SHALL сохраняться при host ack, недоступные proposals SHALL иметь
пояснение. Одна кнопка SHALL показывать «Принять все (N)» либо «Принять выбранные (N)»;
при нулевом выборе она недоступна. Дублирующие per-row accept кнопки MUST NOT
перегружать UI. Принятие SHALL переносить значения только в draft, без network,
нового confirmation modal или auto-apply/save.

Host SHALL валидировать session/sequence, уникальные IDs, opaque proposal tokens,
revision на момент предложения/нажатия, свежесть ресурсов и общий лимит draft до
атомарного изменения выбранных строк. При устаревшем поле/ресурсе или ошибке одного
элемента весь выбранный набор MUST NOT применяться частично. Неизменённые остальные
proposals SHALL оставаться доступны. Принятие SHALL показывать количество и
возможность отмены последней операции. Undo SHALL возвращать предыдущие value/target/
AI provenance и proposals, сохраняя монотонность revisions. Новые edits в затронутых
строках, новый AI run и reload/discard/apply SHALL инвалидировать undo; несвязанные
edits SHALL сохраняться. Undo history/proposals MUST NOT сохраняться в workspaceState.
Storage failure MUST NOT выдавать in-memory acceptance/undo за durable save.

#### Scenario: Все переводы за один клик
- **WHEN** ответ предлагает существующие en/uz переводы
- **THEN** оба доступны и отмечены, «Принять все (2)» атомарно обновляет draft, показывает количество и Undo; XML неизменен

#### Scenario: Частичный выбор
- **WHEN** пользователь снимает uz и приходит storage acknowledgement
- **THEN** uz остаётся невыбранным, общий checkbox mixed, кнопка «Принять выбранные (1)» меняет только en

#### Scenario: Поле изменилось после предложения
- **WHEN** после появления предложения пользователь меняет en или ресурс меняется до принятия
- **THEN** новое значение не перезаписывается, UI/host объясняют необходимость повторного перевода/обновления; выбранный stale batch не применяется частично

#### Scenario: Отмена принятия
- **WHEN** пользователь нажимает Undo до новых правок затронутых полей
- **THEN** предыдущие значения и предложения восстановлены без изменения unrelated rows, XML и отправки запросов

#### Scenario: Новая ручная правка после принятия
- **WHEN** пользователь изменяет принятое поле
- **THEN** Undo прошлой операции недоступен и не может стереть новый ввод


### Requirement: Компактный native поиск с provenance

Команда bl.searchTranslations SHALL показывать native QuickPick поиска по полным
key/value строкам всех доступных языков текущего checkout, insensitive к регистру
и Unicode NFC. Results SHALL показывать key/locale/value/source, conflict и
incomplete evidence; совпадающие key/locale/value SHALL сохранять все источники.
Перечень SHALL ограничиваться 200 строками с видимым actual total и приглашением
уточнить запрос, не скрывать совпадения за пределами preview. Loading/empty/cancel
SHALL быть явными. Без editor SHALL выбираться checkout; активный файл вне
workspace MUST NOT молча перенаправлять поиск. Nested sibling Git checkouts
MUST NOT смешиваться с workspace fallback; target/build и user excludes сохраняются.
Выбор SHALL открывать explicit Edit/Insert/Source actions, без auto-insert/HTTP.

#### Scenario: Длинное значение
- **WHEN** искомое слово находится за пределами короткого preview
- **THEN** результат всё равно найден по полному тексту и содержит locale/source

#### Scenario: Дубли и конфликты
- **WHEN** ru ключ найден в нескольких источниках, часть values совпадает, часть различается
- **THEN** совпавшие значения сгруппированы с provenance, conflicting values показаны отдельно, Source требует явного выбора

#### Scenario: Cancel при загрузке
- **WHEN** пользователь закрывает поиск или extension отменён до окончания snapshot
- **THEN** поздняя загрузка не открывает picker/editor и не пишет в BL/NLS

### Requirement: Явная guarded вставка выбранного ключа

Insert SHALL использовать captured BL document/editor/version/text/selection и
лексический контекст. Только single selection в коде, точном localization literal,
пустой double-quoted строке или целиком выбранном double-quoted literal SHALL
разрешать Insert. Comments/unterminated strings/обычная строка под курсором/
multiline/multi-cursor MUST NOT менять код угадыванием. Insert SHALL давать
quoted "$Key$" с native Undo, не перевод или дублированные quotes/dollars. Guarded
native edit SHALL проверять доверие workspace, свежесть NLS/source scope и BL
до операции и внутри callback; failure MUST NOT писать в другой/stale документ.
Закрытие action chooser SHALL ничего не менять; Save MUST NOT выполняться.

#### Scenario: Замена имеющегося ключа
- **WHEN** курсор находится внутри "$Old.key$" и явно выбран Insert нового ключа
- **THEN** весь литерал становится "$New.key$" без дублирования delimiters

#### Scenario: Dirty документ
- **WHEN** исходный BL уже unsaved, но version/selection не менялись после открытия поиска
- **THEN** Insert меняет только captured range в этом буфере и не сохраняет файл

#### Scenario: Смена editor или выделения
- **WHEN** после открытия выбора пользователь меняет editor/selection/document version
- **THEN** Insert отказывает с пояснением, оба документа остаются неизменными

#### Scenario: Изменённый NLS
- **WHEN** выбранный источник или настройки/scope изменились во время выбора действия
- **THEN** action требует повторить поиск и не использует stale перевод/позицию


### Requirement: Соответствующий набор NLS и автоматический target

Toolkit SHALL определять related resource families по valid источникам текущего
key: точная папка и basename без locale suffix общего parser. Options/AI target
eligibility MUST NOT использовать unrelated family/module только потому, что там
есть файл того же языка. Если текущий key не даёт anchors, Toolkit MUST NOT
угадывать module/family по имени или выбирать любой resource. Один valid existing
source или один matching missing-key sibling SHALL быть selected по умолчанию;
multiple options/conflicts SHALL требовать explicit выбора. Новые NLS-файлы MUST NOT
создаваться автоматически. Inline/search checkout-wide resolver MUST NOT менять
свои read-only contracts из-за ограничения edit targets.

Locale rows SHALL включать active/required/related locales и восстановленные поля,
не все languages всего checkout. Отсутствующий related файл языка SHALL не
предлагаться для AI; required/restored row SHALL объяснять отсутствие файла и
сохранять текст для копирования. Related malformed resource SHALL показываться
unavailable, не missing. Host SHALL проверять eligible family targets на Prepare/
Send/response/Apply; удалённый/изменившийся source MUST NOT перенаправляться в иной
module. Legacy saved target вне текущих options SHALL становиться stale/null без
потери value и без silent migration/rebase. AI MUST NOT отправлять stale поля.

#### Scenario: Core key без узбекского ресурса
- **WHEN** Action.dictionary.clear.title найден в core_ru/core_en, а uz есть только в workflow/cloud.gpt
- **THEN** ru/en targets выбраны автоматически, uz не предлагается AI и чужие uz файлы не появляются в options

#### Scenario: В файле языка отсутствует запись
- **WHEN** matching core_en.nls существует, но не содержит текущий key, известный из core_ru.nls
- **THEN** core_en selected по умолчанию; подтверждённый Apply добавляет key только в этот существующий файл

#### Scenario: Несколько вариантов
- **WHEN** anchored families дают несколько целевых sources одного языка или conflicting declarations
- **THEN** target не угадывается и пользователь выбирает его явно

#### Scenario: Старый неверный target
- **WHEN** stored uz draft указывает workflow_uz для core key
- **THEN** текст восстановлен, workflow target не selected, row stale и не является AI target; source writes blocked

#### Scenario: Файл пропал перед отправкой
- **WHEN** matching target исчез после подготовки AI запроса
- **THEN** host не отправляет запрос и не выбирает unrelated ресурс того же языка


### Requirement: Спокойный контекст ресурсов и понятные состояния языков

Toolkit SHALL показывать общий контекст реальных NLS-наборов ключа; при нескольких
families MUST NOT объявлять одну выбранной молча. Sole selected source SHALL
показывать direct Open File без лишнего selector; ambiguity или сохранённый null
SHALL сохранять явный chooser. No-file язык SHALL показывать static explanation,
не пустое editable поле; восстановленный текст SHALL быть доступен для копирования.
Existing файл без ключа SHALL объяснять, что запись будет добавлена при применении.
Unavailable ресурс MUST NOT выдаваться за отсутствующий. Полные пути SHALL быть
доступны в details, не на каждом normal row.

#### Scenario: Однозначный набор
- **WHEN** ключ связан только с core_ru/core_en и оба targets определены
- **THEN** header показывает core/RU/EN, rows имеют Open File без видимого select

#### Scenario: Обязательный язык без файла
- **WHEN** required uz не имеет matching файла
- **THEN** видна статическая причина без пустого поля; legacy текст не теряется

### Requirement: Ясное применение и сравнение предложений

Edit primary SHALL называться «Проверить изменения…», review primary «Применить в
файлы». Review SHALL показывать число файлов и сохранение только в native buffers;
draft acknowledgement MUST NOT обещать disk save. AI предложения SHALL показывать
current value и candidate с названиями, responsive comparison и AI provenance.
Batch selection/guards/Undo SHALL сохраняться без автоматического Apply.

#### Scenario: Сохранённый черновик
- **WHEN** host подтверждает storage update до Apply
- **THEN** UI отличает сохранённый draft от ещё неизменённых файлов

#### Scenario: Сравнение после ввода
- **WHEN** поле вручную изменено при видимом AI proposal
- **THEN** current comparison показывает новый ввод, а blocked proposal не принимает его молча

### Requirement: Конкретная ошибка и безопасное восстановление

AI configuration errors SHALL называть конкретное некорректное/отсутствующее
поле. Recovery SHALL открывать соответствующие user settings только по host
allowlist, не по command/path из webview. Stale recovery SHALL вызывать existing
explicit reload с discard confirmation; отмена MUST NOT потерять draft value.
Credential recovery SHALL использовать existing SecretStorage command. Unknown
provider errors MUST NOT выводить raw message/credential. AI form redesign MUST
NOT входить в эту ревизию.

#### Scenario: Модель отсутствует
- **WHEN** baseUrl задан, а model пуст
- **THEN** UI называет model и предлагает открыть только настройки bl.i18n.ai.model; сети нет

#### Scenario: Источник изменился
- **WHEN** source freshness guard блокирует действие
- **THEN** объяснение предлагает обновить ресурсы; reload не выполняется автоматически


### Requirement: Необязательное явное добавление языка

Toolkit SHALL предоставлять secondary «Добавить язык…» внутри свёрнутого раздела
источников, не перегружая главный editor/AI экран. Host SHALL ограничивать создание
существующими anchored families текущего ключа в trusted checkout. Sole family
SHALL определяться автоматически; ambiguity SHALL требовать выбора. Locale SHALL
проходить общий parser, а путь SHALL строиться host, не из webview arguments.
Native confirmation SHALL показывать точный путь и отличать создание файла на
диске от XML-буфера, который пользователь сохраняет через Save. Cancel MUST NOT
создавать файл или менять черновик. Создание SHALL использовать отдельный native
WorkspaceEdit без overwrite/ignore existing, не auto-save текущих ресурсов.

#### Scenario: Тихое secondary действие
- **WHEN** пользователь открывает обычный editor переводов
- **THEN** «Добавить язык…» находится в свёрнутых источниках, не primary toolbar; отсутствующие языки не создаются автоматически

#### Scenario: Новый язык в base-core
- **WHEN** key есть в единственном core family с ru/en и пользователь выбирает uz и подтверждает путь
- **THEN** создаётся только core_uz.nls, новый буфер содержит пустую Java XML-properties структуру без copied keys/translations, uz доступен после shared discovery, key остаётся missing до ввода и Apply

#### Scenario: Отмена и коллизия
- **WHEN** пользователь отменил выбор/confirm либо есть case/region-equivalent файл, open buffer, исключённый путь, symlink directory или источник изменился до подтверждения
- **THEN** создание не выполняется; collision/stale/exclusion объясняется без overwrite и fallback

#### Scenario: Сохранение черновика
- **WHEN** добавлен язык при наличии ручных правок и AI proposals других языков
- **THEN** их values/target identities/revisions/provenance/proposals сохраняются; old stale/null edited draft не получает молча новый target

#### Scenario: Ошибка после native create
- **WHEN** editor API завершился частично либо новый файл не обнаружен/не разобран индексом
- **THEN** сообщение честно указывает возможный или состоявшийся create и необходимость проверки, файл не удаляется, нет synthetic target/implicit retry


### Requirement: Безопасное явное переименование локализационного ключа

Toolkit SHALL предоставлять secondary «Переименовать ключ…» в свёрнутых
подробностях. Native ввод SHALL валидировать общий синтаксис ключа. Rename SHALL
показывать обязательный file-grouped preview точных BL literals и NLS key attributes
с old/new именами, путями, строками и количеством замен. Только explicit Apply
SHALL менять native buffers одним text-only WorkspaceEdit, без auto-save/create.

#### Scenario: Workspace title в CLM
- **WHEN** пользователь переименовывает Workspace.title в Workspace.heading
- **THEN** preview показывает Workspace.bl и core_ru/core_en NLS, переводы сохраняются, BL dollars/quotes не меняются, после Apply новое имя отображается в той же вкладке

#### Scenario: Ограниченный явный scope
- **WHEN** key встречается в комментариях, обычной/escaped строке, JS, dynamic expression или generated/excluded file
- **THEN** эти места не изменяются; preview явно сообщает, что rename охватывает только точные BL literals и NLS текущего checkout

#### Scenario: Коллизия и неоднозначность
- **WHEN** new key уже существует в NLS/точном BL literal либо old key имеет multiple families/duplicate locale entries или scoped NLS недоступен
- **THEN** rename блокируется с причиной, без выбора runtime precedence, partial preview или source writes

#### Scenario: Черновики и AI
- **WHEN** текущий key имеет dirty draft, предложения ИИ/acceptance Undo либо new-key draft/panel уже существует
- **THEN** rename не очищает и не переносит их молча, сообщает о необходимости сначала применить/отменить текущее состояние

#### Scenario: Изменение после preview
- **WHEN** изменился buffer/source membership/content, появился new-key collision, поменялись exclusions/root/trust или окно закрыто до Apply
- **THEN** старый preview не применяется, требуется новый review; чужие changes сохраняются

#### Scenario: Отмена и post-commit error
- **WHEN** ввод или review отменены либо после успешного native edit не обновились storage/index
- **THEN** отмена не меняет файлы/черновики, а post-commit error честно сообщает о состоявшемся rename и необходимости проверки без rollback
