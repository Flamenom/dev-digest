# DevDigest на сервере: пошаговая установка

Инструкция ведёт от пустой VM до работающего DevDigest на `https://<домен>` со входом
через Google-аккаунт домена `onlytraf.com`. Шаги идут строго по порядку; каждый
заканчивается проверкой «Готово, если…».

Полный справочник (все настройки, коды выхода, диаграммы) — в
[`docs/deployment.md`](./deployment.md). Этот файл — практический чеклист по нему.

Условные обозначения:
- `<домен>` — публичное имя сервера без схемы и слэша, например `devdigest.onlytraf.com`.
- `<IP>` — публичный IP VM.
- Команды с `$` выполняются на VM под обычным пользователем (не root), если не сказано иначе.

---

## Шаг 0. Что подготовить заранее

| Что | Где взять |
| --- | --- |
| VM: Ubuntu 22.04/24.04 или Debian 12, минимум 2 vCPU / 4 GB RAM / 40 GB SSD (лучше 4 vCPU / 8 GB / 80 GB) | любой облачный провайдер |
| Доступ к DNS-зоне домена | регистратор / Cloudflare / Route53 и т.п. |
| Доступ в Google Cloud Console с правами на проект в Workspace `onlytraf.com` | console.cloud.google.com |
| Права admin на репозиторий `Flamenom/dev-digest` (чтобы добавить deploy key) | GitHub |
| Ключ LLM (OpenRouter / OpenAI / Anthropic), токен GitHub и/или GitLab | вводятся в UI после запуска |
| Менеджер паролей (1Password и т.п.) | для хранения секретов **вне** VM |
| (опционально) два DSN Sentry: проект Node (API) и Browser (web) | sentry.io |

---

## Шаг 1. DNS

1. Создай A-запись `<домен>` → `<IP>` (и AAAA, если у VM есть IPv6).
2. Если DNS в Cloudflare — **выключи проксирование (серое облако)**: сертификат
   выпускает Caddy на самой VM через Let's Encrypt, ему нужен прямой доступ на 80/443.

Готово, если с твоего компьютера:

```sh
dig +short <домен>      # печатает <IP>
```

Делай этот шаг первым: распространение DNS может занять время, а без него Caddy не
получит сертификат.

---

## Шаг 2. Базовая настройка VM

Подключись по SSH и выполни:

```sh
# обновления и утилиты
$ sudo apt-get update && sudo apt-get -y upgrade
$ sudo apt-get install -y git curl openssl ca-certificates ufw

# swap 2 GB (нужен для сборки образов на машине с 4 GB RAM)
$ sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
$ sudo mkswap /swapfile && sudo swapon /swapfile
$ echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# файрвол: SSH + HTTP + HTTPS (+ HTTP/3)
$ sudo ufw allow OpenSSH
$ sudo ufw allow 80/tcp
$ sudo ufw allow 443/tcp
$ sudo ufw allow 443/udp
$ sudo ufw enable
```

Если у провайдера есть свой облачный файрвол (Security Group и т.п.) — открой там те же
порты: 22, 80/tcp, 443/tcp, 443/udp. Порт Postgres открывать **не нужно**: он не
публикуется наружу вообще.

Готово, если `sudo ufw status` показывает разрешённые 22, 80, 443.

---

## Шаг 3. Docker и Node 22

```sh
# Docker Engine + Compose plugin (официальный скрипт)
$ curl -fsSL https://get.docker.com | sudo sh
$ sudo usermod -aG docker "$USER"
# перелогинься (exit и снова ssh), чтобы группа docker применилась

# Node.js 22 LTS — нужен только скриптам check-compose.sh и update.sh, не контейнерам
$ curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
$ sudo apt-get install -y nodejs
```

Готово, если:

```sh
$ docker version --format '{{.Server.Version}}'   # >= 24
$ docker compose version                          # >= 2.24
$ node --version                                  # v22.x
$ docker run --rm hello-world                     # работает без sudo
```

---

## Шаг 4. Доступ к репозиторию (read-only deploy key)

```sh
$ ssh-keygen -t ed25519 -C "devdigest-vm" -f ~/.ssh/devdigest_deploy -N ""
$ cat ~/.ssh/devdigest_deploy.pub
```

1. Скопируй выведенный **публичный** ключ.
2. GitHub → `Flamenom/dev-digest` → **Settings → Deploy keys → Add deploy key**.
   Вставь ключ, **галочку «Allow write access» НЕ ставь**.
3. Пропиши ключ для github.com на VM:

```sh
$ cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/devdigest_deploy
  IdentitiesOnly yes
EOF
$ chmod 600 ~/.ssh/config
$ ssh -T git@github.com    # ответ "Hi Flamenom/dev-digest! You've successfully authenticated…"
```

4. Клонируй репозиторий:

```sh
$ sudo mkdir -p /opt/devdigest && sudo chown "$USER":"$USER" /opt/devdigest
$ git clone git@github.com:Flamenom/dev-digest.git /opt/devdigest
$ cd /opt/devdigest
```

Все дальнейшие команды — из `/opt/devdigest`.

> Кто может пушить в `main`, тот решает, что соберёт и запустит следующий
> `deploy/update.sh`. Включи защиту ветки `main` в GitHub.

Готово, если `git -C /opt/devdigest log --oneline -1` показывает последний коммит `main`.

---

## Шаг 5. Google OAuth-клиент

В Google Cloud Console (проект в Workspace `onlytraf.com`):

1. **APIs & Services → OAuth consent screen**:
   - User type: **Internal** (войти смогут только аккаунты Workspace);
   - App name: `DevDigest`, support email — свой; сохранить.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**;
   - Name: `DevDigest`;
   - **Authorized redirect URIs**: ровно
     `https://<домен>/api/auth/google/callback`
     (https, без слэша в конце, твой реальный домен).
   - «Authorized JavaScript origins» заполнять не нужно.
3. Нажми **Create** и сохрани **Client ID** и **Client secret** в менеджер паролей.

Готово, если у тебя есть Client ID (`….apps.googleusercontent.com`) и Client secret.

---

## Шаг 6. Файл настроек `deploy/.env`

### 6.1. Создать файл

```sh
$ cp deploy/.env.example deploy/.env
$ chmod 600 deploy/.env
```

`deploy/.env` в `.gitignore` — он никогда не попадёт в git. Не коммить и не
пересылай его.

### 6.2. Сгенерировать секреты прямо в файл

Эта функция записывает значение в `.env`, не выводя его на экран:

```sh
$ set_env() { sed -i "s|^$1=.*|$1=$2|" deploy/.env; }

$ set_env POSTGRES_PASSWORD  "$(openssl rand -hex 24)"
$ set_env APP_DB_PASSWORD    "$(openssl rand -hex 24)"
$ set_env BACKUP_DB_PASSWORD "$(openssl rand -hex 24)"
$ set_env SECRETS_MASTER_KEY "$(openssl rand -base64 32)"
```

Три пароля БД должны быть разными (каждый ≥ 32 символов `[A-Za-z0-9_-]`) — команды
выше это обеспечивают.

### 6.3. Заполнить остальное

```sh
$ set_env PUBLIC_HOSTNAME     "<домен>"
$ set_env AUTH_ALLOWED_DOMAIN "onlytraf.com"
$ set_env AUTH_ADMIN_EMAILS   "<твой-email>@onlytraf.com"   # через запятую, если админов несколько
$ nano deploy/.env    # вписать GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET руками
```

Опционально в том же файле:

| Настройка | Что указать |
| --- | --- |
| `SENTRY_DSN` | DSN Sentry-проекта **Node** (API). Пусто = выключено |
| `SENTRY_WEB_DSN` | DSN Sentry-проекта **Browser** (web). Публичный, вшивается в бандл при сборке |
| `BACKUP_SCHEDULE` | время ночного дампа, HH:MM UTC (по умолчанию `03:15`) |
| `BACKUP_RETAIN` | сколько ночных дампов хранить (по умолчанию 14) |
| `DEPLOY_BRANCH` | ветка, которую отслеживает сервер (по умолчанию `main`) |
| `API_MEM_LIMIT` и др. `*_MEM_LIMIT` / `*_CPUS` | лимиты ресурсов, если VM больше/меньше рекомендованной |

Полный список — раздел «Settings reference» в [`deployment.md`](./deployment.md#settings-reference).

### 6.4. Сохранить секреты вне VM — обязательно

Перенеси в менеджер паролей (открой `nano deploy/.env` и скопируй вручную):

- `SECRETS_MASTER_KEY` — **самое важное**. Им зашифрованы все ключи LLM и токены
  GitHub/GitLab в базе. Без него даже восстановленный дамп бесполезен: все ключи
  придётся вводить заново.
- `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `BACKUP_DB_PASSWORD`.
- `GOOGLE_CLIENT_SECRET`.

Готово, если `grep -c replace-me deploy/.env` печатает `0`.

---

## Шаг 7. Каталог для бэкапов

```sh
$ sudo install -d -m 0700 -o 999 -g 999 deploy/backups
```

Владелец `999:999` — пользователь `postgres` внутри контейнера `backup`; без этого
он не сможет писать дампы, а `update.sh` откажется запускаться.

Готово, если `sudo ls -ld deploy/backups` показывает `drwx------ 999 999`.

---

## Шаг 8. Статическая проверка конфигурации

```sh
$ bash deploy/check-compose.sh deploy/.env
```

Контейнеры не запускаются. Проверяется: compose-файл собирается с твоим `.env`,
наружу открыт только proxy, роли БД, лимиты и ротация логов, бэкап-сервис, а также
секреты (нет плейсхолдеров, длина, пароли не повторяются). Значения не печатаются —
только имена настроек.

Готово, если последняя строка — `✔ all deployment checks passed`. Любой `FAIL`
исправь в `deploy/.env` и запусти снова.

---

## Шаг 9. Первый запуск

```sh
$ deploy/dc.sh up -d --build
```

Первая сборка образов занимает 5–15 минут. Всегда вызывай compose через
`deploy/dc.sh` — обёртка подставляет нужный compose-файл и версию релиза.

Порядок старта автоматический: `postgres` → `migrate` (миграции + создание ролей БД,
затем завершается) → `api` → `web` → `proxy` (получает TLS-сертификат) и `backup`.

Следи за статусом:

```sh
$ deploy/dc.sh ps
$ deploy/dc.sh logs -f migrate     # должен закончиться успешно (exit 0)
$ deploy/dc.sh logs -f proxy       # выпуск сертификата Let's Encrypt
```

Готово, если в `deploy/dc.sh ps` у `api`, `web`, `backup`, `postgres` статус
`healthy`, у `proxy` — `running`, а `migrate` — `exited (0)`.

---

## Шаг 10. Smoke-проверка

С **своего компьютера** (из клона репозитория):

```sh
bash deploy/smoke.sh <домен>
```

Или **на самой VM** (многие облака не пускают VM на свой же публичный IP):

```sh
$ SMOKE_RESOLVE_IP=127.0.0.1 bash deploy/smoke.sh <домен>
```

Проверяется: редирект HTTP→HTTPS, валидный сертификат и HSTS, `/api/health/ready`,
401 без авторизации, редирект на `accounts.google.com`, отдача веб-страницы.

Готово, если все 6 строк — `ok` и код выхода 0.

---

## Шаг 11. Первый вход и настройка в UI

1. Открой `https://<домен>` и войди Google-аккаунтом из `AUTH_ADMIN_EMAILS` — ты
   станешь **Admin**. Остальные сотрудники `@onlytraf.com` при первом входе
   становятся **Member**; роли меняются в **Settings → Members**.
2. **Settings → API Keys**: введи ключ LLM и токены GitHub и/или GitLab, нажми
   **Test connection** для каждого. Для GitLab токену нужен scope `api`.
3. **Агенты-ревьюеры.** В проде их нет (демо-данные не создаются). Открой
   **Agents → Create** (или сразу `https://<домен>/agents?create=1`) и заведи
   хотя бы одного агента: модель, системный промпт, при желании skills.
   Пока ни одного включённого агента нет, «Run all» на PR неактивен.
4. **Add repository** — подключи первый репозиторий, открой PR, запусти ревью.

Готово, если ревью на тестовом PR завершилось и показало findings.

---

## Шаг 12. Подключить локальный MCP (для каждого разработчика)

1. В DevDigest: **Settings → API tokens → Create**. Значение показывается один раз —
   скопируй.
2. В **локальном, не коммитящемся** окружении MCP-сервера (Claude Code) задай:
   - `DEVDIGEST_API_BASE=https://<домен>/api`
   - `DEVDIGEST_API_TOKEN=<токен>`
3. Никогда не коммить токен (ни в `.mcp.json`, ни куда-либо ещё). Админ может
   посмотреть и отозвать чужие токены в **Settings → Members**.

---

## Шаг 13. Проверить бэкапы

Ночной дамп делается сам в `BACKUP_SCHEDULE` (UTC). Сразу после установки сделай
пробный:

```sh
$ deploy/dc.sh run --rm -T backup dump nightly
$ sudo ls -l deploy/backups          # появился devdigest-<дата>-nightly.dump
```

Важно: **бэкапы хранятся только на этой VM.** Если VM пропадёт — пропадут и они.
Периодически копируй дампы куда-то ещё (например, `scp` на другую машину или в
облачное хранилище).

Один раз отрепетируй восстановление по разделу
[«Restore a dump»](./deployment.md#restore-a-dump), пока данных мало и это не страшно.

---

## Обновление на новую версию

После мёрджа в `main`:

```sh
$ cd /opt/devdigest
$ git fetch && git diff HEAD..origin/main -- deploy/.env.example   # появились новые настройки?
# если да — добавь их в deploy/.env
$ deploy/update.sh
```

Что делает `update.sh`: проверки → дамп перед обновлением → `git pull --ff-only` →
сборка новых образов (старая версия продолжает работать) → если есть новые
миграции, останавливает API → запуск → ожидание healthy → smoke-проверка.

| Код выхода | Что значит | Что делать |
| --- | --- | --- |
| `0` | обновлено (`smoke: ok`) или уже актуально | ничего |
| `1` | отказ на проверках/сборке, ничего не поменялось | прочитать сообщение, исправить, повторить |
| `2` | новая версия не поднялась, **автоматически откатились** на прошлую | разобраться по логам (`deploy/dc.sh logs api`) |
| `3` | не поднялась, **а миграции уже применились** | выполнить напечатанные команды восстановления из дампа |

Миграции работают только вперёд: откат через миграцию = восстановление дампа, всё
записанное после него теряется. Поэтому обновляйся вне рабочего времени.

Ручной откат на предыдущий релиз: `deploy/update.sh rollback`.

---

## Регулярное обслуживание

| Что | Как часто | Команда |
| --- | --- | --- |
| Статус сервисов | при подозрении на проблему | `deploy/dc.sh ps` |
| Здоровье бэкапов (`backup` должен быть `healthy`) | раз в неделю | `deploy/dc.sh ps backup && sudo ls -lt deploy/backups \| head` |
| Копия дампов вне VM | по вкусу, например раз в неделю | `scp` / rsync / облако |
| Место на диске — действовать при 80 % | раз в неделю | `df -h /` |
| Логи API | при ошибках | `deploy/dc.sh logs --tail 200 api` |

Если диск заполняется: удали клоны отключённых репозиториев
(`deploy/dc.sh exec api ls /data/clones`, затем `rm -rf` нужного каталога),
уменьши `BACKUP_RETAIN`, вынеси старые дампы с VM, выполни `docker builder prune`.

---

## Частые проблемы

| Симптом | Причина | Что делать |
| --- | --- | --- |
| Ошибка сертификата в браузере, в `deploy/dc.sh logs proxy` ошибки ACME | DNS ещё не указывает на VM или закрыты 80/443 | проверить `dig +short <домен>` и файрвол, затем `deploy/dc.sh restart proxy` |
| Google: `redirect_uri_mismatch` | redirect URI в OAuth-клиенте не совпадает | ровно `https://<домен>/api/auth/google/callback` |
| После входа снова страница входа с `error=auth_domain_not_allowed` | аккаунт не из `AUTH_ALLOWED_DOMAIN` | входить аккаунтом `@onlytraf.com` |
| После входа снова страница входа с `error=auth_state_invalid` | сайт открыт не через `https://<домен>` | открывать только по https и домену; прогнать smoke |
| `migrate` завершился с ошибкой, `api` не стартует | плохой пароль БД или упала миграция | `deploy/dc.sh logs migrate` — там имя настройки; исправить `.env`, `check-compose.sh`, `deploy/dc.sh up -d` |
| В логах API: `No admin — … AUTH_ADMIN_EMAILS is empty` | не задан первый админ | заполнить `AUTH_ADMIN_EMAILS`, `deploy/dc.sh up -d`, войти этим аккаунтом |
| В логах API: `secrets can't be decrypted with the current master key` | изменился `SECRETS_MASTER_KEY` | вернуть исходный ключ из менеджера паролей или заново ввести ключи в Settings → API Keys |
| Контейнер постоянно перезапускается (OOM) | не хватает лимита памяти | поднять `API_MEM_LIMIT` (или другой `*_MEM_LIMIT`), `deploy/dc.sh up -d` |
| `backup` в статусе `unhealthy` | нет удачного дампа 26 ч, часто — неверный владелец каталога | `deploy/dc.sh logs backup`; `sudo chown 999:999 deploy/backups && sudo chmod 0700 deploy/backups` |
| Smoke падает на VM, но проходит с ноутбука | облако не пускает VM на свой публичный IP | запускать с `SMOKE_RESOLVE_IP=127.0.0.1` |

Больше случаев — в разделе [Troubleshooting](./deployment.md#troubleshooting).

---

## Итоговый чеклист

- [ ] DNS `<домен>` → `<IP>`, без прокси Cloudflare
- [ ] VM: обновления, swap, ufw (22, 80, 443/tcp, 443/udp)
- [ ] Docker ≥ 24, Compose ≥ 2.24, Node 22
- [ ] Read-only deploy key, репозиторий в `/opt/devdigest`, ветка `main` защищена
- [ ] Google OAuth-клиент (Internal, redirect URI)
- [ ] `deploy/.env` заполнен, `chmod 600`, секреты сохранены в менеджере паролей
- [ ] `deploy/backups` с владельцем 999:999 и правами 0700
- [ ] `check-compose.sh` → `✔ all deployment checks passed`
- [ ] `deploy/dc.sh up -d --build`, все сервисы healthy
- [ ] `smoke.sh` → 6 × `ok`
- [ ] Вход админом, ключи LLM/GitHub/GitLab, создан хотя бы один агент
- [ ] Пробный дамп создан, восстановление отрепетировано
