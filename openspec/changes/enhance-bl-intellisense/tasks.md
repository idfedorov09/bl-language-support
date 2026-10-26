# Tasks

Статус: 2026-10-08 отдельно согласован первый этап completion (1.1, 1.2, 2.1,
completion-часть проверок). Другие задачи остаются backlog без разрешения на apply.

## 1. Общая модель символов

- [x] 1.1 Дополнить metadata существующего BL-индекса диапазонами объявлений и параметрами перегрузок без второго независимого parser; проверить fixtures классов, наследования, enum, records, inline-классов и массивов/map.
- [x] 1.2 Подготовить общий versioned context для новых providers с cancellation и несохранёнными зависимостями; проверить повторное использование анализа и инвалидацию при изменении любого участвующего буфера.

## 2. Completion и signature help

- [x] 2.1 Зарегистрировать completion для подтверждённых классов, членов, локальных переменных и imports; проверить scopes, `container`, `items[0].`, explicit-import priority и отсутствие выдуманных members неизвестного типа.
- [ ] 2.2 Добавить signature help с перегрузками и активным аргументом; проверить вложенные вызовы, незавершённые выражения и сохранение вариантов при неоднозначных типах.
- [ ] 2.3 Добавить auto-import с выбором FQN и checkout; проверить отсутствие дублей, сохранение существующих imports и отказ от скрытой замены одноимённого типа.

## 3. Структура и семантическая подсветка

- [ ] 3.1 Добавить document symbols для достоверных объявлений; проверить дерево классов/методов/полей и полезную частичную структуру незавершённого файла.
- [ ] 3.2 Добавить semantic tokens поверх TextMate без изменения смысла диагностики; проверить диапазоны и классификацию параметров, locals, records и неизвестных конструкций.

## 4. Безопасное переименование

- [ ] 4.1 Реализовать prepare/rename по существующим resolved definitions и references с preview; проверить исключение комментариев, обычных строк и одноимённых чужих символов.
- [ ] 4.2 Проверять конфликты имён и версии всех изменяемых документов перед применением; проверить отмену, изменившийся буфер и пересчёт устаревшего edit plan без перезаписи правок.

## 5. Интеграционные проверки

- [x] 5.1 Расширить mock VS Code API и completion provider-тесты: fields/methods/inheritance, indexed arrays/maps, inline/container, locals, new/import, ambiguous/unknown/foreign checkout, dirty/stale/cancelled contexts и NLS/JS coexistence; проверить `npm test` и CLM corpus, сохранив existing navigation/diagnostics/performance contracts. Зафиксировать поддерживаемый completion и ограничения в README; синхронизировать версии по SemVer.
- [ ] 5.3 После отдельного разрешения остальных этапов расширить provider-тесты signature help, outline/tokens, auto-import и symbol rename; повторить unit/corpus проверки.
- [ ] 5.2 После отдельного согласования проверки в VS Code подтвердить completion, signature help, outline, tokens и rename preview; записать поддерживаемые конструкции и ограничения в README и обновить baseline specs только после проверки реализованного поведения.

## Проверки первого этапа (2026-10-08, local dev 1.4.0)

- `npm test`: 389/389, включая 11 model и 51 completion provider regression tests.
- BL CLM corpus: 619 файлов, 617 классов, 3866 definition checks,
  283 records и 52 GUID constant cards; существующая MessageAction navigation сохранена.
- `test:completion-corpus`: 7 реальных CLM контекстов (thread/inheritance,
  XFile array, Parameter map, inline container, super, new/import), mock editor,
  никаких изменений в CLM/запусков компилятора или runtime.
- JS corpus: 7 command checks, source discovery исключает target; NLS corpus:
  26 ресурсов / 2831 entries. Localization/JS completion coexistence проверен.
- Strict OpenSpec 11/11, syntax checks и `git diff --check`; состав cached pinned
  VSCE включает blCompletion и Toolkit runtime modules, excludes tests/specs/agents.
- Нативный popup, темы/клавиатура/Remote SSH не запускались: acceptance пользователь
  выполняет отдельно. Будущие этапы, main-spec sync/archive и публикация не выполнены.
