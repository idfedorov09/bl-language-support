# Tasks

Статус: **запланировано, не реализовано**. Все задачи ниже относятся к будущей реализации после отдельного запроса пользователя; текущая задача создаёт только документацию. Наличие checklist не разрешает apply, реальные HTTP-запросы, UI-проверку, version bump, commit/push либо публикацию. Сетевые проверки планируются на изолированных mocks; runtime/UI возможны лишь по отдельному запросу с выбранным стендом.

## 1. Offline request model and test isolation

- [ ] 1.1 Добавить небольшую модель route/parameter/draft с family, provenance, confidence и risk, не заменяя существующий индекс/LSP; проверка: Node unit tests для сериализуемого draft, неизвестных значений и отсутствия secret values в persisted model.
- [ ] 1.2 Расширить test helpers моками CodeLens/webview/SecretStorage/transport и spies на любые сетевые действия; проверка: тест открыть/переключить/обновить/восстановить draft имеет ноль network calls, включая meta/auth/polling.

## 2. Source analysis and checkout context

- [ ] 2.1 Добавить literal-aware анализ `[request]`, `[request false]`, локального `[entry]` и handler family через текущие классы/наследование, сохраняя диапазоны sanitizer; проверка: fixtures для inherited true/false, entry-only, Query/Table/Object/Executable, comments/strings и baseline navigation assertions.
- [ ] 2.2 Добавить статическое разрешение dispatcher-веток, string constants и связи operation → request route без объявления всех public methods API; проверка: fixtures AiAttachment дают три content-метода, helper исключён, computed branch помечена unknown, неоднозначная операция предлагает выбор.
- [ ] 2.3 Вывести parameter evidence из чтений/parse/aliases/defaults и найденных guard clauses, не подменяя read-key обязательностью; проверка: fixtures `attachmentId`/`recordId`, необязательного чтения, неразрешённого native handler и partial schema показывают верные источники/confidence.
- [ ] 2.4 Учесть несохранённые документы, duplicate FQN и ties разных checkout, version/index invalidation и bounded cache; проверка: dirty source обновляет schema без save, две копии не смешиваются, одинаково близкие кандидаты не выбираются скрытно, cancellation/stale-result tests проходят.

## 3. Family-specific recipes and serializers

- [ ] 3.1 Добавить описанные платформенные Query/Table варианты и read builder для fields/filter/sort/pagination/IDs/query/link; проверка: unit fixtures покрывают default/meta/read, `count`/`totals` как flags, field IDs/наследование/expressions, а не выдуманные actions и writable expressions.
- [ ] 3.2 Добавить CRUD, command, export, Object content/data и Executable Job recipes; проверка: fixtures покрывают `data`, copy исходные IDs, destroy shapes, `{id,value}` command parameters и отличающийся Job parameters object, custom content и отсутствие CRUD для Object/Executable по умолчанию.
- [ ] 3.3 Реализовать POST form-urlencoded и multipart wire serialization без двойного JSON/URL-encoding; проверка: golden payload fixtures соответствуют RequestParser-контракту `request.json`, files/file metadata и complex form parameters, raw-edit модели не переключает transport на raw JSON body.

## 4. CodeLens and Postman-like draft tab

- [ ] 4.1 Добавить независимые request CodeLens/команду и настройку включения Workbench, не меняя baseline Java CodeLens; проверка: mock-provider tests показывают отдельные request/Java ссылки, operation route selection, корректные source ranges и работоспособность definitions/references при отключении/ошибке Workbench.
- [ ] 4.2 Добавить локальную Postman-like webview со вкладками параметров/raw модели/wire preview и раздельными HTTP/request/action/method, источниками и confidence; проверка: mock messages/render fixtures открывают новый draft без сервера, не отправляют сеть и не объявляют unknown schema полной.
- [ ] 4.3 Сохранять ручные значения/неизвестные keys и применять регенерацию только явным diff/merge; проверка: action/source change fixtures сохраняют edits до подтверждения, cancel не теряет значения и не запускает Send.
- [ ] 4.4 Реализовать строгий CSP, локальные ресурсы, escaping source/response, проверку webview messages и lifecycle cleanup; проверка: malicious BL/HTML/message fixtures не запускают scripts/command URI, не читают секреты, закрытая вкладка освобождает listeners/cache.

## 5. Profiles and execution safety

- [ ] 5.1 Добавить явно выбираемые profile metadata и credentials через VS Code SecretStorage, включая Z8 session parameter/cookie; проверка: mock storage/settings/log snapshots не содержат session/custom secret headers, незаданный профиль не вызывает transport, credentials других checkout не читаются.
- [ ] 5.2 Реализовать conservative risk classification и подтверждение изменяющих/unknown операций, включая hooks/getData для read/meta/default; проверка: `destroy`/content/Job/custom-read fixtures требуют подтверждение, cancel/смена endpoint/route/payload сбрасывают authorization, предупреждение read-only отсутствия гарантии всегда видимо.
- [ ] 5.3 Добавить host-side Send gate с workspace trust, validated HTTP(S) endpoint, late secret resolution и запретом утечки credentials при redirect; проверка: изолированный transport mock получает запрос только после явного Send/всех подтверждений, untrusted workspace и malformed message дают ноль calls, secrets не появляются в webview/errors.
- [ ] 5.4 Реализовать transport adapter с timeout/abort и без автоматического retry mutations/unknown, не полагаясь на global fetch; проверка: mocks моделируют unknown result/abort/redirect, не повторяют запрос и показывают отсутствие гарантии rollback, compatibility проверена для заявленного VS Code engine без реального HTTP.

## 6. Results, history and export

- [ ] 6.1 Добавить раздельное отображение HTTP status, Z8 success/status/messages, JSON/binary/Job response и timing; проверка: fixtures HTTP 200 + `success=false`, transport error, invalid envelope, binary и job ID не выглядят как гарантированный success и не запускают polling.
- [ ] 6.2 Добавить санитизацию history и export HTTP/cURL с placeholders для session/cookies/headers/marked sensitive keys и без response body по умолчанию; проверка: snapshots и secret-leak assertions покрывают URL/form/multipart/custom headers/response echo, export требует preview и не вызывает сеть.
- [ ] 6.3 Реализовать восстановление/очистку истории и версию saved draft без сохранённого confirmation; проверка: restore открывает новый draft без credentials/Send, неизвестная версия сообщается явно, явное удаление профиля/истории не меняет unrelated extension state.

## 7. Regression and acceptance

- [ ] 7.1 Прогнать `npm test` и `npm run test:corpus -- ../pro.doczilla.clm` для index/navigation/diagnostics/Java regressions и request fixtures; проверка: зафиксировать результаты команд и конкретный corpus checkout, отсутствие доступного corpus обозначить отдельно, не выдавать unit/corpus проверки за runtime-покрытие.
- [ ] 7.2 Проверить bounded request-analysis retention/performance, duplicate-checkout updates и disposed webview behavior; проверка: локальные fixture counters/retention tests подтверждают отсутствие полного rescan на каждом CodeLens, stale responses и утечки listeners, все network spies остаются пустыми вне Send tests.
- [ ] 7.3 После отдельного запроса на UI-проверку подтвердить CodeLens → новая Postman-like вкладка, manual editing, warning/confidence/profile preview и совместимость с Java CodeLens в extension development host; проверка: записать выполненные offline UI-сценарии, а без разрешения оставить задачу незавершённой; реальные HTTP/production проверки не являются частью этой задачи.
- [ ] 7.4 После реализации обновить README/документацию с фактическими командами/настройками, limitations и проверенными сценариями, сверить change strict validation и baseline-границы; проверка: `openspec validate add-request-workbench --strict --no-interactive` проходит и тексты не утверждают полную схему/read-only, release/version bump/archive без отдельного разрешения не выполняются.
