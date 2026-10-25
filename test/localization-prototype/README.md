# Gate: визуальная замена ключа (dev only)

Это отдельное dev-расширение, **не готовая локализация**. Оно не активируется
основным плагином и не входит в VSIX (`test/**` уже исключён).
Фиксированный fixture `$Workspace.title$ → Документы` соответствует source ресурсу
`pro.doczilla.base.core/WEB-INF/resources/pro.doczilla.base.core_ru.nls` в CLM.
Остальные `Prototype.*` — синтетические случаи. NLS-файлы не индексируются,
язык пока фиксирован `ru`; Warning для demo-ключей `Prototype.*` реализован,
production NLS diagnostics/definition/completion/rename отсутствуют.

## Подход и ограничения

Публичные TextEditor decorations: исходный литерал окрашивается в transparent,
перевод добавляется `after.contentText`, отрицательный `after.margin` компенсирует
ширину исходного литерала. Никакой правки BL, DOM-injection или вставки CSS через
`textDecoration`; используются только типизированные поля API. Наличие API сверено
с официальным `vscode.d.ts` версии 1.60.0.

Это **кандидат**, не гарантия replacement: `ch` предполагает одинаковую ширину
ASCII-символов в monospace. Геометрия glyphs/ligatures, word wrap, mouse hit testing,
позиция следующего текста и отсутствие overlays должны пройти реальный editor gate.
Если требуют неподдерживаемого CSS/DOM вмешательства — подход отклоняется.
Многострочный перевод представлен escaped `\n` через JSON.stringify; приемлемость
такого отображения отдельно согласуется, не считается выполненным multiline UX.

Курсор или выделение, касающиеся литерала (включая границы), снимают замену и
раскрывают ключ. Это касается всех multicursors. Hover показывает ключ и перевод.
Переведённая вставка теперь — **мягкая плашка в стиле inlay hint**, без
контрастной обводки: цвет текста `editorInlayHint.foreground`, фон
`editorInlayHint.background` из текущей темы. Light/dark/high contrast и
пользовательские overrides этих токенов разрешаются самим VS Code. Событие смены
темы обновляет видимые decorations. Токены и attachment API проверены по исходникам
VS Code 1.60.0; engine не менялся. Размер шрифта/скругление не эмулируются через
CSS-injection. Это **стиль замены**, не native hint рядом с видимым ключом.
После раскрытия ключа исчезает вся плашка, source остаётся прежним.
`Prototype.missing` остаётся видимым и даёт DiagnosticSeverity.Warning в
отдельной коллекции `z8bl-localization-prototype`, с источником
`Z8BL Localization Prototype` и явной пометкой тестового ru-словаря.
Warning не зависит от курсора/режима переводов, обновляется при несохранённом
редактировании и удаляется при закрытии документа. Реальные ключи других
проектов не помечаются missing по этому фиктивному словарю.

Команда `Z8BL Prototype: Переводы / ключи` переключает показ. Файлы не редактируются
автоматически; обычные copy/save/undo принадлежат VS Code.

## Ручной запуск — после согласования editor-проверки

### Remote SSH — основной сценарий

Конфигурация уже создана в `.vscode/launch.json`; создавать её вручную не нужно.

1. В подключённом по Remote SSH окне откройте папку
   `/home/codex/projects/dz/bl-language-support` именно как корень workspace.
2. В **Run and Debug** выберите **Z8BL: Inline Localization Prototype** и нажмите
   **F5** (на некоторых клавиатурах — Fn+F5).
3. В новом **Extension Development Host** прототип активируется после startup
   и **сам открывает Examples.bl**. Курсор ставится на первый комментарий, не ключ.
4. Проверяйте переводы именно в этом новом окне. Если открыть Examples.bl в
   исходном окне с красной debug-полосой, прототип в нём не запущен.
5. Команда **Z8BL Prototype: Переводы / ключи** переключает режим;
   **Z8BL Prototype: Открыть тестовый файл** повторно открывает fixture.

В **Output → Z8BL Localization Prototype** нового окна должны появиться строки
`Activated in this window`, `Opened Examples.bl in this window; language=bl`
и количество replacement candidates. Если канал/обе команды отсутствуют —
прототип не загружен в этом host; смотрите Running Extensions и Debug Console.
Автооткрытие выполняется только в ExtensionMode.Development, не при обычной
установке прототипа. Файл открывается вкладкой текущей группы без записи на диск.

Конфигурация запускает основной плагин и прототип вместе. Для прототипа явно
задан `extensionKind: ["workspace"]`, чтобы его host был удалённым workspace.
Не устанавливайте настольный VS Code на SSH-сервер ради запуска. Если extension
не виден, проверьте **Developer: Show Running Extensions** в dev-окне и Debug Console
исходного окна. Открытие/поведение Remote Extension Host ещё не проверено агентом.

### Локальная машина с VS Code

Если checkout находится локально, можно запустить обе dev-extensions командой:

```sh
code \
  --extensionDevelopmentPath=/home/codex/projects/dz/bl-language-support \
  --extensionDevelopmentPath=/home/codex/projects/dz/bl-language-support/test/localization-prototype \
  /home/codex/projects/dz/bl-language-support/test/localization-prototype/Examples.bl
```

Не использовать одновременно старую установленную копию Z8BL для проверки;
проверьте, что язык файла — BL и обе dev-extensions запущены. Перенесите курсор
на строку комментария, иначе локализационный литерал на текущем курсоре раскроется.
Файл fixture можно открыть read-only; сценарии редактирования лучше делать в
несохранённом копированном BL-буфере. Не менять реальные CLM-файлы ради gate.

## Матрица acceptance

2026-10-06: пользователь показал скрины dev-окна в Remote SSH на macOS и
подтвердил визуальное чтение переводов и раскрытие ключа под курсором на строке 5.
Это частичное подтверждение, не вся матрица. Пользователь затем показал Warning и прежнюю рамку в UI; новая мягкая плашка
пока проверена только unit/API fixtures. Copy/save/undo/fonts/wrap/high contrast
и multiline UX отдельно не подтверждены. Mock API не рисует текст.

| Сценарий | Критерий |
| --- | --- |
| Чтение | Замена показана на скрине пользователя; wrap/геометрия всех случаев не подтверждены |
| Короткий/длинный перевод, соседний текст | Следующее поле/оператор находится после перевода |
| Mouse click, стрелки, Home/End | Раскрытие ключа, предсказуемое положение курсора |
| Выделение и несколько курсоров | Все затронутые ключи раскрываются; не меняется документ |
| Обычный Copy и Copy Line | Clipboard содержит ключ, не декоративный перевод |
| Вставка/backspace/delete/undo/redo | Редактируется только исходный ключ, нет скрытых edits |
| Save/Git diff | Без пользовательских edits документ/диск неизменны |
| Мягкая плашка | Текст/фон текущей темы без жёсткой рамки; после раскрытия исчезает (новый UI pending) |
| Missing | Prototype.missing остаётся ключом и Warning; показано на пользовательском скрине |
| Hover | Ключ и fixture-перевод; без trusted source commands |
| Светлая/тёмная/high contrast тема | Перевод видим, не сливается с фоном |
| Monospace fonts, ligatures, zoom/font size | Нет расхождения ширины и перекрытий |
| Word wrap, horizontal scroll | Переносы/scroll/hit testing пригодны для работы |
| Multi-line/Unicode/special | Решение escaped multiline явно принято или отклонено |
| Toggle, split editors, reload | Режим сбрасывает decorations; новый редактор обновляется |

Если существенный сценарий не проходит, не внедрять этот слой в production.
Сначала согласовать исправление в рамках supported API либо иной UX.


## UX reference

Изучена официальная документация JetBrains `Internationalization and localization`
(https://www.jetbrains.com/help/idea/internationalization-and-localization.html):
IDEA сворачивает resource references до локализованных значений; неразрешённые
keys проверяются отдельной inspection. Для VS Code выбран свой decoration layer,
не утверждается идентичность платформенных folding APIs или точная копия темы IDEA.
Первый вариант с рамкой заменён по новому уточнению пользователя на мягкую
плашку с публичными attachment color/backgroundColor и штатными inlay theme tokens.


## Проверка мягкого оформления

Остановить отладку, закрыть старое dev-окно, снова F5 в исходном Remote SSH окне.
В новом Extension Development Host автоматически откроется Examples.bl.
Проверить приглушённый фон/текст без рамок, раскрытие ключа под курсором,
warning на строке 9, затем сменить light/dark/high contrast темы именно в dev-окне.
В Output → Z8BL Localization Prototype новая activation line содержит `style=inlay`.
Это следующий пользовательский UI gate, не уже выполненная проверка.


## Продолжение после принятия прототипа

2026-10-06: пользователь принял soft UI и подтвердил обычный Copy с исходным
ключом, редактирование и Undo. После явного запроса подключены реальные `.nls`
в основной плагин; этот harness остаётся фиксированным demo. Для нового теста
использовать F5 **Z8BL: Real NLS (CLM)**, не запускать demo renderer одновременно.
Полная матрица реальных тем/high contrast/ligatures/wrap по-прежнему pending;
предыдущие заметки отражают исторические этапы, не отменяют последнее evidence.
