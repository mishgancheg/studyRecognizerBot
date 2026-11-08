# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Назначение

Личный Telegram-бот с Mini App для оцифровки рукописных конспектов. Пользователь загружает фото в Mini App, сервер
распознаёт их через Claude Code по подписке, пользователь правит текст, и запись коммитится в приватный репозиторий
`github.com/mishgancheg/study` по пути `<N> семестр/<Предмет>/Записи/<YYYY-MM-DD>_<тема>.md`. Оттуда записи
забирает Claude Code на ноутбуке. Предыстория и решения — `claudedocs/PLAN.md` (раздел о Python/Docker устарел:
проект на Node.js, развёртывание навыком `deploy`).

## Команды

```bash
npm test                                   # все тесты (node:test)
node --test tests/notes-repo.test.js       # один файл тестов
node --test --test-name-pattern="пустой" tests/notes-repo.test.js   # один тест
npm start                                  # запуск; нужен config/local.yaml (образец в навыке deploy)
```

Node.js 22.19.0 (`.envrc`). Локальный запуск с боевым токеном бота конфликтует с ботом на сервере (409 Conflict).

## Архитектура

Один процесс (`index.js`): Express раздаёт `public/` (Mini App) и `/api/*`, grammY опрашивает Telegram.

- `src/telegram-auth.js` — каждый `/api` запрос несёт `Authorization: tma <initData>`; подпись проверяется
  HMAC-ом от токена бота, пользователь — по `telegram.allowedUserIds`. Других способов входа нет.
- `src/jobs.js` — задание = каталог `<data.dir>/jobs/<id>/` с фото `01.jpg…` и `result.json`. Распознавание строго
  по одному (общие лимиты подписки). Mini App опрашивает `/api/jobs/:id`; черновик живёт в localStorage браузера.
- `src/recognizer.js` — запускает `node_modules/@anthropic-ai/claude-code/bin/claude.exe -p` с `--allowedTools Read`,
  `--setting-sources ""`, своим `CLAUDE_CONFIG_DIR` и окружением с нуля (только `CLAUDE_CODE_OAUTH_TOKEN`).
  Изоляция обязательна: у root на сервере глобальные настройки Claude указывают на другой шлюз и модель.
- `src/notes-repo.js` — клон репозитория с учёбой в `<data.dir>/notes`, все git-операции через очередь;
  сохранение = pull --rebase, запись, commit, push (при неудаче — повтор, затем откат коммита). Список семестров и
  предметов в Mini App строится из папок клона.
- `public/app.js` — фото ужимаются в браузере до 2400 px; предпросмотр Markdown вынимает формулы `$…$`/`$$…$$` до
  разбора marked и рисует их KaTeX.

## Развёртывание

Навык `.agents/skills/deploy` (общий для нескольких проектов; `.claude/skills` — ссылка на `.agents/skills`, её
создают локально). Особенности этого проекта — `project.yaml` и `PROJECT.md` навыка; общие файлы (`SKILL.md`,
`scripts/`, `update.cjs`) правятся только через `sync.cjs`. Сервер: служба `textrec--prod` в `/opt/py/textrec`,
данные в `/opt/py/textrec-data`, адрес `https://textrec.bazilio.ru`, ветка `main` подтягивается автоматически.
Баз данных нет: `npm run migrate` — заглушка, которую требует навык.

## Секреты

`claudedocs/credits.md` (токены бота и Claude, Telegram ID) и `.agents/skills/deploy/config/{deploy.local,local}.yaml`
закрыты от git. Не выводи их значения в чат и журналы. Репозиторий кода публичный.

## Общение с пользователем

Пользователь не разработчик. Отвечай по-русски полными предложениями и поясняй технические термины простыми словами.
