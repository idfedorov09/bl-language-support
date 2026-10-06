# Tasks

Статус: реализация начата по отдельному запросу пользователя 2026-10-06. Lookup использует исходники, не runtime-БД. UI-проверка требует отдельного согласования; change пока не архивируется.

## 1. Индекс статических записей

- [x] 1.1 Сохранить GUID-литерал, owner, атрибуты, диапазоны и checkout в metadata записи существующего parser; проверить fixtures records и сохранить обычные definitions/references по имени.
- [x] 1.2 Добавить канонизацию GUID и lookup кандидатов по значению; проверить эквивалентный регистр, неизвестный GUID и вычисляемый ID без выдуманной декларации.
- [x] 1.3 Обновлять индекс по file/buffer events без удержания полных исходников в истории; проверить изменение несохранённого GUID и удаления/перемещения декларации.

## 2. Навигация и карточки

- [x] 2.1 Добавить переход из GUID-литерала и команду lookup с явным checkout context; проверить несколько кандидатов и отсутствие скрытого выбора другой копии проекта.
- [x] 2.2 Добавить карточку с владельцем, атрибутами, источниками и доказанными связями; проверить переходы и явное различие статической role/access-декларации и эффективных runtime-прав.
- [x] 2.3 Разделить resolved symbol references и literal/text matches; проверить совпадение UUID в коде, произвольной строке и комментарии без ложной семантической связи.

## 3. Конфликты и интеграции

- [x] 3.1 Классифицировать только обоснованные потенциальные конфликты и показывать source evidence; проверить одинаковый UUID в migration, наследнике и другом checkout без безусловной duplicate error или автоматической замены ID.
- [x] 3.2 Подключить локализованные названия и lookup из Workbench при наличии соответствующих capabilities; проверить самостоятельную работу без них, явный выбор source context и отсутствие HTTP/БД-вызовов.

## 4. Проверки и документация

- [x] 4.1 Добавить parser/index/provider-тесты нового lookup; проверить `npm test`, corpus и existing records-навигацию по имени.
- [ ] 4.2 После отдельного согласования editor-проверки подтвердить карточки и списки кандидатов; описать ограничение статическими записями и перенести в baseline только проверенное реализованное поведение.

## 5. UX revision и GUID-константы (отдельно согласовано 2026-10-06)

- [x] 5.1 Индексировать top-level static final guid literals отдельно от records; проверить Workspace.General, computed/string/local exclusions, CRLF, updates/removal и сохранение семантической навигации.
- [x] 5.2 Добавить native Quick Pick с подсказками/partial GUID/name/owner, источниками, dirty context и отменой; проверить неизвестный GUID без fabricated record.
- [x] 5.3 Сделать компактный hover с действующими карточкой/использованиями; проверить привязку к декларации, смену курсора, escaping и отдельный trusted action-блок в рамках VS Code 1.60.
- [x] 5.4 Сделать видимыми loading/results/empty/partial/error/stale в usages, предотвратить repeat и сохранять раздел при refresh; проверить через mock и script tests без UI/runtime.
- [x] 5.5 Сгруппировать команды в подменю Z8BL с короткими названиями; проверить manifest/палитру/engine, обновить docs, npm/corpus/spec validation и VSIX list.

## 6. Повторный feedback: вкладка без сплита (согласованы только исходники)

- [x] 6.1 Открывать карточку и использования в текущей группе без автоматического сплита; проверить общий путь lookup/card/usages для records/константы при наличии одной/двух групп и отсутствии активного text editor; записать неподтверждённый статус ПКМ в editor gate.

## Historical evidence (до UX revision)

- 2026-10-06: `npm test` — 129/129; parser, providers, scopes/submodules, dirty buffers,
  watcher rename/delete, stale prompt/picker/search/source navigation, duplicate evidence,
  symbol/literal/text, CSP/escaping и manual-only messages проверены через mock VS Code API.
- `npm run test:corpus -- ../pro.doczilla.clm` — 618 BL-файлов, 616 классов,
  3804 definition checks и командные карточки 283 статических GUID; в том числе
  реальные role/request access attributes без вычисления `getClassKey()`.
- JS syntax, strict OpenSpec validation и `git diff --check` — успешны.
  `vsce ls` с закреплённым 4.0.0 включает новые JS-модули и исключает skills/specs/tests/developer docs.
- По 3.2: NLS/Workbench пока отсутствуют. Проверены независимый offline lookup,
  `{ guid, sourceUri }` и optional resolver названия с сохранением ключа; это не
  установленная NLS/Workbench-функция и не отправка запросов.
- На момент предыдущей реализации — **9/10** (до пяти UX-задач). Editor-проверка не разрешена и не запускалась. Требуются отдельное
  согласование и проверка карточек/списков в настоящем VS Code; только затем
  закрывается 4.2, синхронизируются main specs и рассматривается archive.
  Версия 1.1.0 не повышалась, commit/push/publication не выполнялись.


## Evidence UX revision и оставшийся gate

- 2026-10-06: `npm test` — **148/148**. Constants parser/index, CRLF, exclusions,
  rename/delete/dirty, QuickPick (часть UUID/имя/owner/context/cancel/stale),
  Workspace.General F12/hover/usages и source-bound hover command links проверены.
- Controller и emitted script tests: loading виден до завершения поиска,
  повтор блокируется, есть counts/empty/partial/error/stale/cancelled,
  клавиатурные tabs/ARIA, выбранный раздел сохраняется при refresh;
  старые usage links удаляются при failed retry, не только скрываются в HTML.
- Последний `npm run test:corpus -- ../pro.doczilla.clm` — **618 BL-файлов,
  616 классов, 3856 definition checks, 283 records GUID cards + 52 GUID constant cards**.
  Между двумя read-only прогонами внешний CLM corpus изменялся: предыдущий дал
  620/618/3868/278/51. Это не фиксированный snapshot и не изменения расширением.
  На предыдущем corpus отдельно сравнен parser с отключённым constant scan:
  0 различий records declarations (278 static records). Оба corpus-прогона успешны.
- `node --check` изменённых JS, `git diff --check`, strict OpenSpec validation —
  успешны. `vsce ls` с закреплённым 4.0.0 включает runtime JS и исключает
  tests/skills/OpenSpec/AGENTS/CONTRIBUTING; VSIX не собирался и не устанавливался.
- Проверены manifest: stable command IDs, palette, один Z8BL submenu,
  Java/GUID/debug groups, shortTitle; engine ^1.60.0 и версия 1.1.0 сохранены.
- UX sources и trust policy описаны в design; README/AGENTS/CONTRIBUTING обновлены.
- **14/15**: task 4.2 остаётся незавершённой. Mock/corpus не подтверждают UI в
  настоящем VS Code; скриншоты пользователя — feedback. Editor/runtime/HTTP
  проверки не запускались, baseline не sync/archive. Version bump, commit,
  push и publication не выполнялись. Изменяется только bl-language-support;
  CLM и его сабмодули использованы как read-only corpus/reference.


## Evidence повторного feedback: вкладка без сплита

- `openCard` использует `ViewColumn.Active` вместо `ViewColumn.Beside`.
  Общий путь lookup/card/usages открывает отдельную вкладку в текущей группе;
  существующие пользовательские сплиты не закрываются и не объединяются.
- `npm test` — **149/149**. Новая regression проверяет все три команды для
  records и GUID-константы, editor context первой/второй группы и отсутствие
  active text editor. Это mock API: подтверждён запрос Active, не реальный layout.
- `node --check` изменённых JS, strict OpenSpec validation (10/10) и
  `git diff --check` успешны. Corpus повторно не запускался: parser/index не менялись.
- Текущий manifest имеет одно подменю Z8BL и актуальные названия; это не
  подтверждение ПКМ. Пользователь повторно сообщил о плоском меню со старыми
  названиями. Возможная старая загруженная копия/manifest — гипотеза, не установленная
  причина. Проверять в свежезапущенном dev-хосте нужного checkout; editor gate открыт.
- **15/16**, остаётся 4.2. Согласованы и изменены только исходники/тесты/документация
  bl-language-support; CLM/сабмодули не затронуты. VSIX не собирался/не устанавливался,
  UI не запускался; версия, commit/push/publication и main specs не менялись.
