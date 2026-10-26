# UX research → решения offline Edit Translation

Дата: 2026-10-06. Пользователь явно разрешил исследовать UX, обновить спеки и
реализовать offline Toolkit. Это не разрешение на AI, runtime HTTP, выпуск или
браузерную проверку. Web search выполнен; страницы первоисточников прочитаны.

## Первоисточники и применимость

| Источник | Рекомендация / реальный паттерн | Решение для Z8BL |
| --- | --- | --- |
| Microsoft: [Webviews UX](https://code.visualstudio.com/api/ux-guidelines/webviews), [Views](https://code.visualstudio.com/api/ux-guidelines/views) | Интегрироваться в VS Code, применять темы, accessibility/keyboard; не открывать лишние окна автоматически. GitHub Pull Request detail — приведённый Microsoft пример уместной webview. | Явная команда/hover; вкладка в текущей группе; CSS theme tokens, labels, focus, минимум кнопок. |
| Google: [Google Forms autosave announcement](https://support.google.com/docs/thread/119809411?hl=en&msgid=125747792) | Реальный продукт сохраняет draft progress, восстанавливает по повторному открытию формы и предоставляет отдельный Clear Form. | Закрытие не означает discard; host подтверждает сохранение draft, повторное открытие восстанавливает, discard отдельный и подтверждаемый. Не копировать cloud/30 days/account модель. |
| GOV.UK: [Check answers](https://design-system.service.gov.uk/patterns/check-answers/) | Перед submission можно проверить ответы и исправить их; паттерн повышает уверенность и даёт второй шанс заметить ошибку. | Один общий preview изменений всех языков: путь, язык, было/стало; Back сохраняет черновик; Apply отдельный. |
| NN/g: [10 usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/), [Complex applications](https://www.nngroup.com/articles/usability-heuristics-complex-applications/) | Видимость статуса, контроль пользователя, предотвращение ошибок, recognition instead of recall; информативная recovery, а не только сообщение error. | Состояния loading/saving draft/saved/storage error/changed resources/applied; missing/empty/conflict текстом, не только цветом; причины блокировки и конкретное действие восстановления. |
| Mozilla: [Primary button](https://protocol.mozilla.org/components/detail/button--primary) | Primary обозначает главное действие, обычно одно на экран. | Edit: Сохранить…; review: Применить (compact revision). Back/Close/source/discard вторичные. |

Не утверждаем статистически доказанный рост удобства Z8BL: эти документы и
успешные продуктовые паттерны — основания для дизайна, не результаты нашего
user study или A/B теста. Доступ к IBM Carbon forms вернул 403, его содержимое
не использовано как проверенный источник. Не переносим потребительский web UI
в редактор без адаптации к существующим VS Code interaction patterns.

## Acceptance контракты текущей фазы

1. Compact revision после пользовательского feedback: в header только ключ;
   checkout/число языков/storage/reload/discard — в «Подробностях». Locale и
   одно начальное поле напротив (растёт для multiline), без found banners. Source
   paths/select — в «Источник», раскрыт сразу при отсутствующем target. Длинные строки не обрезаются
   в editable value. Responsive layout, без внешних шрифтов/аналитики/CDN.
2. Host-side draft: ключ scope+key; сохраняем только поля/targets/fingerprints,
   без credentials и целых ресурсных файлов. Workspace-local storage без sync,
   ограниченные размеры. Индикатор «Сохранён» только после storage acknowledgement.
   При ошибке — явное «не сохранён», поля остаются в текущем окне. Отправленные
   и подтверждённые edits сохраняются при close/reopen/reload; не обещаем сохранение
   input, который не успел получить host acknowledgement при завершении процесса.
3. Закрытие вкладки не пытается veto/reopen через onDidDispose. Кнопка «Закрыть»
   сохраняет draft; «Отменить изменения» подтверждает уничтожение. Это явная UX
   revision старого сценария с непредоставляемым обычной webview close veto.
4. Выбор ресурса обязателен при missing/duplicate/conflict; единственная декларация
   может быть выбрана автоматически; source доступен в disclosure. Нельзя исправлять все
   conflicts одним guessed runtime precedence. No resource → объяснение; создание
   нового .nls/нового языка и rename ещё будущие задачи, не скрытое auto-create.
5. «Сохранить…» → компактное обязательное подтверждение → «Применить».
   Изменённые языки и native buffer explanation видны сразу; файлы/было/стало
   раскрываются через «Показать изменения», без удаления review/guard этапа.
   Text-only WorkspaceEdit меняет native buffers, не делает автоматический Save
   на диск. Явно объяснить дальнейший штатный Save/Save All и Undo. Missing entry
   добавляется только в явно выбранный существующий ресурс.
6. Fingerprints от load/draft и document versions от preview проверяются;
   stale не overwrite. «Обновить из ресурсов» с подтверждением discard начинает
   новый draft; пользователь может перед этим скопировать свой текст. Не делать
   silent merge/rebase. Preview cancellation/back не меняет resource.
7. Изменения surgical: оставить unrelated XML, comments, DOCTYPE, CRLF/BOM;
   корректно обработать entities, CDATA и empty/self-closing entry. Parser общий.
8. Theme CSS variables, keyboard Tab/Shift+Tab, видимый focus, labels/aria-describedby,
   aria-live polite для статуса, роль alert для ошибки; missing/empty/conflict
   имеют текстовые названия. Focus не теряется на каждом вводе/ack/theme change.
9. Webview messages несут только row/option IDs и ограниченный value/revision;
   пути берутся из host model. Nonce CSP, connect-src none, escaped text, no
   source-controlled command execution. Apply только trusted workspace.
10. Тесты model/parser/draft/storage/webview protocol/stale/version/undo-compatible
    edit shape обязательны; GUI/theme/assistive technology проверить отдельно
    пользователю. AI/search/completion остаются не реализованными в этой фазе.


## Пользовательский feedback и текущая ревизия

Первая offline композиция отклонена пользователем как перегруженная. Источники
выше — основания, но не доказательство качества предыдущего UI. Compact revision
отдельно описана в design/spec и реализуется как локальная UI-правка; визуальная
приёмка нового варианта ещё не получена. Будущий AI input-first flow зафиксирован
в спеках, без реализации AI или новых запросов к provider в этой фазе.


2026-10-07 пользователь принял компактную композицию («сильно лучше»), затем
отдельно выбрал AI этап. Реализованный AI input-first сохраняет одну primary на
фазу и основную форму без технической конфигурации. AI UI проверен только DOM-mock;
новое пользовательское acceptance и theme/accessibility matrix pending.


## AI form revision по пользовательскому screenshot (2026-10-07)

Пользователь оценил AI форму как перегруженную и потребовал default checked.
Прочитаны первоисточники напрямую (web tool вернул пустой ответ; HTML получен
urllib, это поиск документации, не GUI или live AI). Не приписываем Z8BL метрики
успеха этих компаний и не называем документацию пользовательским A/B тестом.

| Источник | Проверенная рекомендация | Решение |
| --- | --- | --- |
| Microsoft Fluent Checkbox: https://fluent2.microsoft.design/components/web/react/core/checkbox/usage | Short scannable labels, descriptive group label, checked means yes, checkbox selection requires submission | Короткие названия языков, fieldset/legend, native checkboxes с видимым focus; default checked — явное требование пользователя, не универсальная рекомендация Fluent. |
| IBM Carbon Form: https://carbondesignsystem.com/components/form/usage/ | Persistent labels, short concise labels, secondary non-pertinent help can be disclosed; AI presence distinguishes generated portions | Поле с постоянной label; короткое пояснение «черновик», технические ограничения в disclosure; AI provenance на предложениях/значениях, не декоративный AI-branded весь экран. |
| VS Code Webviews: https://code.visualstudio.com/api/ux-guidelines/webviews | Themeable, keyboard/ARIA accessible; do not use webviews for wizards or duplicate settings | Не строим многошаговый wizard; остаются editing + обязательная data-send confirmation в существующей вкладке. Не переносим API settings на экран, не меняем editor shell. |
| NN/g Progressive disclosure: https://www.nngroup.com/articles/progressive-disclosure/ | Основные опции сначала, редкие/advanced по запросу | Storage/reload скрыты во время AI; ограничения отдельным disclosure, но consent endpoint/model/source/targets всегда видны перед Send. |

### Acceptance AI compact revision

- Один header: AI context + ключ без повторяющегося большого заголовка.
- Text first; рядом компактные группы source locale и target locales, responsive stack.
- Все доступные target checkboxes selected при открытии, даже при existing/edited
  переводах. Исходный язык не отображается в targets (не выключенный unchecked
  пункт). При смене source показывается прежний source, выборы других языков
  сохраняются. Ноль hidden-source targets в payload.
- Short draft helper, expanded safety notes только по запросу; cancel payment warning
  остаётся непосредственно у Cancel во время ожидания, не скрывается как consent.
- Ясные primary «Проверить запрос» / «Перевести»; никакой сети по открытию, выбору
  checkbox или source. No targets/none checked — конкретное объяснение.
- Source/input/target picks переживают host ack/review/back. Theme tokens, native
  checkbox focus, no :has (минимальная VS Code 1.60), безопасный textContent/value.
- Host validation/request contract/guard/AI overwrite policy неизменны; default
  checked не означает overwrite/auto-apply. GUI/themes/browser/live AI отдельно.


## Mass acceptance research (2026-10-07)

Первичные источники прочитаны напрямую через HTML fetch; web.run выдавал пустой
результат. Это documentation research, не browser/UI test. Не приписывать гайдам
успешность нашего UX или измеренные product metrics.

- Adobe React Spectrum ActionBar: https://react-spectrum.adobe.com/ActionBar.html
  (официальный текущий S2 reference): action bar для single/bulk selection,
  contextual actions/count/clear selection. Переносим только паттерн, не SDK.
- Microsoft Fluent Checkbox: https://fluent2.microsoft.design/components/web/react/core/checkbox/usage
  parent checkbox выбирает/снимает children; mixed state при частичном выборе,
  short positive labels, разделение selection и отдельного action button.

Наша продуктовая рекомендация, approved пользователем: default checked для всех
eligible proposals текущего ключа, явная кнопка выполнения (не auto-accept),
контекстная панель вместо постоянного toolbar, только один acceptance action.
Draft-only reversible action не требует нового modal: запись остаётся отдельным
review/Apply. All scope явно ограничен предложениям одного ключа. Недоступные
предложения видны с причиной, blocked batch не применяется частично. Undo не
стирает поздние ручные edits. Это design judgment, не буквальное требование гайдов.
Acceptance: selection сохраняется при ack/частичном принятии; native keyboard
checkbox/mixed semantics; safe textContent; theme colors/focus; новая GUI acceptance
остаётся отдельным gate.


## Research и одобренная ревизия 1/2/4/5/6 (2026-10-07)

Web search/open инструмент вернул пустые результаты; перечисленные ниже страницы
проверены прямой загрузкой официального HTML (не GUI/live translation API).
Исходные тексты временно в ../tmp/z8bl-ux-source-*.txt, не shipped artifacts.

- VS Code Webviews: https://code.visualstudio.com/api/ux-guidelines/webviews —
  theme/keyboard/accessibility; использовать editor-native язык и небольшой UI.
- IBM Carbon Form: https://carbondesignsystem.com/components/form/usage/ — labels,
  helper/error text, простая базовая форма, различать generated AI portions.
- Microsoft Fluent Button: https://fluent2.microsoft.design/components/web/react/core/button/usage —
  понятные action labels; Close != Cancel. Применение не маскировать словом Save.
- Atlassian Inline Message: https://atlassian.design/components/inline-message/usage —
  краткий контекст, конкретная проблема, доступные actions/information.
- NN/g Progressive Disclosure: https://www.nngroup.com/articles/progressive-disclosure/ —
  редкие controls secondary, важные задачи первыми; не плодить disclosures.

HAX повторная загрузка завершилась timeout: не использован как новый проверенный
источник. Не приводим недоступные страницы/успех продуктов как метрики нашего UX.
Single resource summary/no-file static row/current comparison — собственные
проектные решения из диагностики Toolkit, не цитаты или универсальные стандарты.
Пользователь выбрал 1/2/4/5/6; 3 (изменение AI form) исключён. Acceptance см.
новые requirements spec и design revision; actual theme/rendering ещё не проверены.
