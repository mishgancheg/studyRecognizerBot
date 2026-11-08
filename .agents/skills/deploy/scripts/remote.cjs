#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Развёртывание службы проекта на боевом сервере. Скрипт общий для всех проектов: его эталон хранится вместе с
// навыком и разносится командой `node .agents/skills/deploy/scripts/sync.cjs`. Править его в одном проекте и
// отправлять правку в эталон — `sync.cjs push`.
//
// Скрипт запускается НА РАБОЧЕЙ МАШИНЕ и всё делает по SSH — руками на сервер ходить не нужно.
//
// МОДЕЛЬ РАЗВЁРТЫВАНИЯ — обычная служба systemd прямо на сервере, без Docker. На сервере
// появляется каталог с рабочей копией репозитория, служба systemd, поднимающая её при загрузке
// машины, задание cron, раз в минуту сверяющее копию с веткой на GitHub, и раздел nginx, который
// выставляет приложение наружу по адресу https://<домен> с сертификатом Let's Encrypt.
//
// Ни одно имя, адрес или путь проекта здесь не зашиты. Они берутся из:
//   config/deploy.local.yaml — куда и чем ходить, автообновление (раздел autoUpdate), ключи доступа (access);
//   config/local.yaml        — файл config/local.yaml приложения, копируется на сервер дословно; отсюда же порт;
//   project.yaml             — особенности проекта: шаги развёртывания и обновления, проверки, параметры nginx;
//   package.json и .envrc    — имя проекта и версия Node.js.
//
// Общие соглашения для всех проектов: проверка работоспособности — GET /health; миграции — `npm run migrate`;
// проверка файла ключей — `npm run access:check -- --file <файл>`.
//
//   node remote.cjs keygen      # завести отдельный ключ только для чтения репозитория
//   node remote.cjs deploy      # полное развёртывание либо повторное — команда безопасна к повтору
//   node remote.cjs status      # диагностика: служба, git, доступность, автообновление, nginx
//   node remote.cjs stop        # остановить службу
//   node remote.cjs start       # запустить службу
//   node remote.cjs restart     # перезапустить службу
//   node remote.cjs push-config # положить на сервер config/local.yaml и deploy/deploy-config.yml
//   node remote.cjs push-auth   # проверить и атомарно доставить файл ключей доступа без перезапуска
//   node remote.cjs update      # немедленное обновление из ветки (update.cjs --force)
//   node remote.cjs alias       # зарегистрировать службу в утилите restart/logs/stop под алиасом
//   node remote.cjs logs [N]    # последние N строк журнала службы
//   node remote.cjs updatelog   # итог последнего автообновления и разбор ошибок
//   node remote.cjs shell       # интерактивная оболочка в каталоге проекта на сервере
//   node remote.cjs exec -- ... # произвольная команда в каталоге проекта
//   node remote.cjs uninstall --yes  # снести службу, cron, раздел nginx и каталог проекта
//   node remote.cjs ssh         # напечатать готовую команду ssh
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.join(__dirname, '..');
// Корень проекта: .agents/skills/<навык>/scripts/remote.cjs — четыре уровня вверх.
const PROJECT_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');
const CONFIG_DIR = path.join(SKILL_DIR, 'config');
const DEPLOY_FILE = path.join(CONFIG_DIR, 'deploy.local.yaml');
const LOCAL_YAML_FILE = path.join(CONFIG_DIR, 'local.yaml');
const PROJECT_FILE = path.join(SKILL_DIR, 'project.yaml');
// Файл ключей доступа к маршрутам службы на сервере — там его ищет приложение (webServer.auth.file).
const ACCESS_REMOTE = 'config/access.local.yaml';
// Проверка работоспособности — одна для всех проектов.
const HEALTH_PATH = '/health';

// Шаблоны nginx хранятся в assets/nginx/ этого навыка.
const TPL = {
  site: path.join(SKILL_DIR, 'assets', 'nginx', 'site.conf'),
  snippet: path.join(SKILL_DIR, 'assets', 'nginx', 'proxy.conf'),
};

// Разборщик YAML — пакет `yaml` из зависимостей проекта (его же читает update.cjs на сервере).
const YAML = require(require.resolve('yaml', { paths: [PROJECT_ROOT] }));

// Имена, вычисляемые один раз в main() из разобранных настроек.
let SERVICE, UPSTREAM, SNIPPET;

function fail(msg) {
  console.error(`\x1b[1;31m[remote][ОШИБКА]\x1b[0m ${msg}`);
  process.exit(1);
}
function say(msg) {
  console.log(`\x1b[1;36m[remote]\x1b[0m ${msg}`);
}
function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}
// Значение в одинарных кавычках для оболочки: внутренние кавычки экранируются.
function sq(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

// Имя, пригодное для systemd и nginx, из произвольного имени пакета.
function sanitizeName(n) {
  return (
    String(n)
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/\//g, '-')
      .replace(/[^a-z0-9_.-]/g, '-') || 'app'
  );
}

function readYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (error) {
    fail(`Не удалось разобрать ${file}: ${error.message}`);
  }
}

function readProjectName(cfg) {
  if (cfg.service && cfg.service.name) return sanitizeName(cfg.service.name);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    if (pkg.name) return sanitizeName(pkg.name);
  } catch {
    /* дальше подставится значение по умолчанию */
  }
  return 'app';
}

// Версия Node.js — из настроек навыка, иначе из `.envrc` проекта (`nvm use X.Y.Z`).
// Тот же файл читают `.agents/skills/deploy/scripts/srv.cjs` и `update.cjs`, поэтому версия везде одна.
function readNodeVersion(cfg) {
  if (cfg.node && cfg.node.version) return String(cfg.node.version);
  try {
    const m = fs.readFileSync(path.join(PROJECT_ROOT, '.envrc'), 'utf8').match(/nvm\s+use\s+([0-9]+\.[0-9]+\.[0-9]+)/);
    if (m) return m[1];
  } catch {
    /* дальше подставится значение по умолчанию */
  }
  return '22.19.0';
}

// Значение по пути через точку: get(obj, 'webServer.port').
function get(obj, dotted) {
  return dotted.split('.').reduce((node, part) => (node == null ? undefined : node[part]), obj);
}

// Подстановка {{local.<путь>}} в командах шагов project.yaml — значением из config/local.yaml навыка.
function expandStep(run, local) {
  return String(run).replace(/\{\{local\.([\w.]+)\}\}/g, (_, key) => {
    const value = get(local, key);
    if (value === undefined || value === null || value === '') {
      fail(`В config/local.yaml навыка нет значения ${key}, нужного шагу из project.yaml`);
    }
    return sq(value);
  });
}

function loadConfig() {
  if (!fs.existsSync(DEPLOY_FILE)) {
    fail(`Настройки не найдены: ${DEPLOY_FILE}
Скопируйте config/deploy.example.yaml в config/deploy.local.yaml и заполните его.`);
  }
  if (!fs.existsSync(LOCAL_YAML_FILE)) {
    fail(`Не найден ${LOCAL_YAML_FILE}
Скопируйте config/local.example.yaml в config/local.yaml — это файл настроек самого приложения.`);
  }
  if (!fs.existsSync(PROJECT_FILE)) fail(`Не найдено описание проекта: ${PROJECT_FILE}`);

  const cfg = readYaml(DEPLOY_FILE);
  const server = cfg.server || {};
  const project = cfg.project || {};
  const git = cfg.git || {};
  const site = cfg.site || {};
  const envSection = cfg.env || {};
  const autoUpdate = cfg.autoUpdate || {};
  const req = (v, name) => {
    // Значение в угловых скобках — заполнитель из образца: с ним развёртывание ушло бы на несуществующий адрес.
    if (!v) fail(`В config/deploy.local.yaml не заполнено обязательное поле: ${name}`);
    if (/<[^>]*>/.test(String(v))) fail(`В поле ${name} остался заполнитель «${v}» — впишите настоящее значение`);
    return v;
  };

  // config/local.yaml приложения копируется на сервер дословно. Отсюда читаются порт (на него смотрит nginx),
  // признак защиты ключами и значения для подстановок в шагах проекта.
  const localYaml = fs.readFileSync(LOCAL_YAML_FILE, 'utf8');
  const local = readYaml(LOCAL_YAML_FILE);
  const profile = readYaml(PROJECT_FILE);

  const name = readProjectName(cfg);
  const dns = req(site.dns, 'site.dns');
  // Родительский домен: по нему ищется подстановочный сертификат вида *.example.com.
  const apex = dns.split('.').slice(-2).join('.');
  const nginx = profile.nginx || {};
  return {
    name,
    title: profile.title || name,
    instance: (cfg.service && cfg.service.instance) || 'prod',
    nodeVersion: readNodeVersion(cfg),
    host: req(server.host, 'server.host'),
    port: server.port || '22',
    user: req(server.user, 'server.user'),
    keyPath: req(server.keyPath, 'server.keyPath'),
    repoUrl: req(git.repoUrl, 'git.repoUrl'),
    deployKeyPath: git.deployKeyPath || '',
    branch: autoUpdate.branch || 'master',
    projectPath: project.path || `/opt/node/${name}`,
    dns,
    apex,
    emails: [].concat(autoUpdate.emails || []),
    debug: envSection.DEBUG || '',
    appPort: req(get(local, 'webServer.port'), 'webServer.port в config/local.yaml навыка'),
    authEnabled: get(local, 'webServer.auth.enabled') === true,
    access: cfg.access,
    localYaml, // дословно -> config/local.yaml на сервере
    deployConfigYaml: YAML.stringify({ branch: 'master', ...autoUpdate }), // -> deploy/deploy-config.yml
    deploySteps: (profile.deploy || []).map((s) => ({ title: s.title, run: expandStep(s.run, local) })),
    statusChecks: profile.status || [],
    nginx: {
      clientMaxBodySize: nginx.clientMaxBodySize || '1m',
      proxyTimeout: nginx.proxyTimeout || '60s',
      extraLocations: nginx.extraLocations || '',
    },
  };
}

// Каталог уровнем выше проекта: там update.cjs держит свои журналы.
function logPaths(cfg) {
  const p = cfg.projectPath.replace(/\/+$/, '');
  const von = p.replace(/\/[^/]+$/, '') || '/';
  const base = `${von}/deploy__${p.replace(/^.*\//, '')}__`;
  return {
    von,
    status: `${base}status.log`,
    lastDeploy: `${base}last_deploy.log`,
    cumulative: `${base}cumulative.log`,
    errors: `${base}errors.log`,
  };
}

// Полный путь к update.cjs на сервере — его запускает задание автообновления.
function cronScript(cfg) {
  return `${cfg.projectPath.replace(/\/+$/, '')}/update.cjs`;
}

// Признак строки автообновления в crontab пользователя — путь к update.cjs, окружённый пробелами (так
// /opt/node/app не совпадёт с /var/opt/node/app). По нему deploy заменяет прежнюю строку проекта, а
// status и uninstall находят её, не задевая чужих заданий того же пользователя.
function cronMatch(cfg) {
  return sq(` ${cronScript(cfg)} `);
}

// Задание автообновления в личном расписании пользователя — там его видно командой `crontab -l`.
// Строка проекта заменяется, чужие задания остаются как были. Строк PATH= и SHELL= здесь нет: в общем
// расписании они подействовали бы на все чужие задания, а update.cjs запускается полным путём, сам
// переходит в свой каталог и сам дописывает каталог Node.js в PATH своих команд. Обычный вывод прогона
// выбрасывается: итог и ход обновления update.cjs пишет в свои журналы. Поток ошибок дописывается в
// errors.log: только там остаётся след падения, которое update.cjs сам записать не успел. Расписание, которое
// не удалось прочитать (любая ошибка, кроме «расписания ещё нет»), останавливает сценарий — иначе
// чужие задания были бы затёрты. Сценарию нужна переменная NODE_DIR из nodeEnvPrelude().
function cronInstallBody(cfg) {
  return `
echo '── Автообновление раз в минуту ──'
if ! CRON_OLD=$(LC_ALL=C crontab -l 2>&1); then
  case "$CRON_OLD" in
    'no crontab for'*) CRON_OLD='' ;;
    *) echo "Не удалось прочитать crontab: $CRON_OLD"; exit 1 ;;
  esac
fi
CRON_KEEP=$(printf '%s\\n' "$CRON_OLD" | grep -vF ${cronMatch(cfg)} || true)
{
  [ -z "$CRON_KEEP" ] || printf '%s\\n' "$CRON_KEEP"
  echo "* * * * * $NODE_DIR/node ${cronScript(cfg)} >/dev/null 2>>${logPaths(cfg).errors}"
} | crontab -
echo 'Задание автообновления поставлено в crontab пользователя ${cfg.user} (посмотреть: crontab -l)'`;
}

// ── Работа по SSH ────────────────────────────────────────────────────────────
function sshBaseArgs(cfg) {
  return [
    '-i',
    cfg.keyPath,
    '-p',
    String(cfg.port),
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    `${cfg.user}@${cfg.host}`,
  ];
}

// Выполняет сценарий на сервере. Обычный запуск отдаёт сценарий удалённому `bash -l` через
// стандартный ввод: так он не упирается в предельную длину одного довода командной строки, а
// сценарии здесь длинные — в них встроены ключи и файлы настроек.
function sshRun(cfg, script, { interactive = false } = {}) {
  if (interactive) {
    const res = spawnSync('ssh', ['-t', ...sshBaseArgs(cfg), script], { stdio: 'inherit' });
    if (res.error) fail(`не удалось запустить ssh: ${res.error.message}`);
    return res.status;
  }
  const res = spawnSync('ssh', [...sshBaseArgs(cfg), 'bash -l'], {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (res.error) fail(`не удалось запустить ssh: ${res.error.message}`);
  return res.status;
}

// ── Общие куски сценариев ────────────────────────────────────────────────────

// Преамбула: путь к нужной версии Node.js впереди всех прочих. Без неё сработал бы системный
// `node`, который на сервере бывает древним, а `npm` из nvm им попросту не запускается.
function nodeEnvPrelude(cfg) {
  return `NODE_DIR="$HOME/.nvm/versions/node/v${cfg.nodeVersion}/bin"
export PATH="$NODE_DIR:$PATH"`;
}

function deployKeyPathRemote(cfg) {
  return `$HOME/.ssh/${cfg.name}-deploy`;
}

// Две проверки адреса /health: на самой машине и снаружи через nginx.
function healthBody(cfg) {
  return `curl -fsS -o /dev/null -w 'на самой машине http://127.0.0.1:${cfg.appPort}${HEALTH_PATH} — код %{http_code}\\n' -m 8 "http://127.0.0.1:${cfg.appPort}${HEALTH_PATH}" || echo 'на самой машине НЕ ОТВЕЧАЕТ'
curl -fsS -o /dev/null -w 'снаружи https://${cfg.dns}${HEALTH_PATH} — код %{http_code}\\n' -m 12 "https://${cfg.dns}${HEALTH_PATH}" || echo 'снаружи НЕ ОТВЕЧАЕТ'`;
}

// Раздел nginx для домена. Сертификат ищется в трёх местах по очереди: отдельный сертификат этого
// поддомена, подстановочный сертификат родительского домена (*.example.com), и лишь если нет ни
// того ни другого — выписывается новый через certbot.
//
// Найденный сертификат обязательно проверяется на срок годности (`openssl x509 -checkend 0`).
// Просроченный подстановочный сертификат — не редкость: его выписывают проверкой через записи DNS,
// которая обычно делается руками и потому не продлевается сама. Браузер такому сертификату не
// верит, и сайт оказывается недоступен, хотя файл на месте, поэтому просроченный считается
// отсутствующим и вместо него запрашивается новый.
function nginxBody(cfg) {
  if (!fs.existsSync(TPL.site) || !fs.existsSync(TPL.snippet)) {
    fail(`Не найдены образцы настроек nginx:\n  ${TPL.site}\n  ${TPL.snippet}`);
  }
  const extra = String(cfg.nginx.extraLocations).replace(/\n*$/, '');
  const site = fs
    .readFileSync(TPL.site, 'utf8')
    .replace(/\{\{extra_locations\}\}\n/g, extra ? `${extra.replace(/^(?=.)/gm, '    ')}\n\n` : '')
    .replace(/\{\{domain\}\}/g, cfg.dns)
    .replace(/\{\{upstream\}\}/g, UPSTREAM)
    .replace(/\{\{snippet\}\}/g, SNIPPET)
    .replace(/\{\{port\}\}/g, String(cfg.appPort))
    .replace(/\{\{client_max_body_size\}\}/g, cfg.nginx.clientMaxBodySize)
    .replace(/\{\{proxy_timeout\}\}/g, cfg.nginx.proxyTimeout);
  const email = cfg.emails.length ? `-m ${cfg.emails.join(',')}` : '--register-unsafely-without-email';
  return `
echo '── Настройка nginx ──'
mkdir -p /etc/nginx/snippets
echo ${b64(fs.readFileSync(TPL.snippet, 'utf8'))} | base64 -d > /etc/nginx/snippets/${SNIPPET}

# Сертификат годен: файл есть и срок его действия ещё не истёк.
cert_alive() { [ -f "$1/fullchain.pem" ] && openssl x509 -in "$1/fullchain.pem" -noout -checkend 0 >/dev/null 2>&1; }

CERT_DIR=''
if cert_alive "/etc/letsencrypt/live/${cfg.dns}"; then
  CERT_DIR="/etc/letsencrypt/live/${cfg.dns}"
  echo "Сертификат: отдельный, для ${cfg.dns}"
elif cert_alive "/etc/letsencrypt/live/${cfg.apex}" \\
  && openssl x509 -in "/etc/letsencrypt/live/${cfg.apex}/fullchain.pem" -noout -text 2>/dev/null \\
     | grep -q "DNS:\\*\\.${cfg.apex.replace(/\./g, '\\.')}"; then
  CERT_DIR="/etc/letsencrypt/live/${cfg.apex}"
  echo "Сертификат: подстановочный *.${cfg.apex} — отдельный выписывать не нужно"
else
  if [ -f "/etc/letsencrypt/live/${cfg.apex}/fullchain.pem" ]; then
    echo "Подстановочный сертификат *.${cfg.apex} просрочен — пользоваться им нельзя."
  fi
  echo "Годного сертификата нет — запрашиваем его у Let's Encrypt для ${cfg.dns}…"
  if certbot certonly --nginx -d ${cfg.dns} --non-interactive --agree-tos ${email}; then
    CERT_DIR="/etc/letsencrypt/live/${cfg.dns}"
  else
    echo "ВНИМАНИЕ: certbot не выписал сертификат (домен ещё не указывает на этот сервер или закрыт порт 80)."
    echo "Раздел nginx не записан. Повторите deploy, когда домен заработает."
  fi
fi

if [ -n "$CERT_DIR" ]; then
  SITE=/etc/nginx/sites-available/${cfg.dns}.conf
  LINK=/etc/nginx/sites-enabled/${cfg.dns}.conf
  echo ${b64(site)} | base64 -d | sed "s#{{cert_dir}}#$CERT_DIR#g" > "$SITE"
  ln -sf "$SITE" "$LINK"
  if nginx -t 2>&1 | tail -2; then
    systemctl reload nginx && echo "nginx перезагружен — https://${cfg.dns}/ работает."
  else
    echo "ОШИБКА: nginx -t не принял настройки. Разберитесь с файлом $SITE."
    exit 1
  fi
fi`;
}

// ── Ключи доступа ────────────────────────────────────────────────────────────

// Локальная проверка раздела access теми же правилами, что у службы: `npm run access:check -- --file <файл>`.
// Правила проекта (например, обязательные поля клиента) спрятаны внутри его команды access:check. Раздел
// выписывается во временный файл с правами 0600, который удаляется сразу после проверки. Возвращает текст файла.
function checkedAccessFile(cfg, { allowEmpty = false } = {}) {
  if (!cfg.access) {
    fail('В config/deploy.local.yaml нет раздела access. Образец — config/deploy.example.yaml; ключ выпускает npm run access:issue-key.');
  }
  const content = YAML.stringify(cfg.access);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-access-'));
  const file = path.join(dir, 'access.local.yaml');
  try {
    fs.writeFileSync(file, content, { mode: 0o600 });
    const command = `npm run --silent access:check -- --file "${file}"${allowEmpty ? ' --allow-empty' : ''}`;
    const result = spawnSync(command, { cwd: PROJECT_ROOT, stdio: 'inherit', shell: true });
    if (result.status !== 0) fail('Раздел access не прошёл проверку — на сервер он не отправлен.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return content;
}

// Доставка файла ключей: временный файл в том же каталоге, права 0600 владельцу службы (root), атомарная замена.
function accessUploadBody(content) {
  return `umask 077
mkdir -p config
TMP_ACCESS="$(mktemp config/.access.local.yaml.XXXXXX)"
echo ${b64(content)} | base64 -d > "$TMP_ACCESS"
chmod 600 "$TMP_ACCESS"
chown root:root "$TMP_ACCESS"
mv -f "$TMP_ACCESS" ${ACCESS_REMOTE}
umask 022
echo '${ACCESS_REMOTE} доставлен; служба применит его при ближайшем перечитывании'`;
}

// При развёртывании файл ключей обязателен, если защита включена; иначе доставляется, только если раздел задан.
function accessDeliveryBody(cfg) {
  if (!cfg.authEnabled && !cfg.access) return "echo 'Защита ключами выключена, раздела access нет'";
  return accessUploadBody(checkedAccessFile(cfg));
}

// ── Команды ──────────────────────────────────────────────────────────────────
function cmdKeygen(cfg) {
  const target = cfg.deployKeyPath || path.join(path.dirname(cfg.keyPath), `${cfg.name}-deploy`);
  if (fs.existsSync(target)) {
    say(`Ключ уже есть: ${target}`);
  } else {
    say(`Создаём ключ только для чтения репозитория: ${target}`);
    const res = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', target, '-C', `${cfg.name}-deploy`], {
      stdio: 'inherit',
    });
    if (res.status !== 0) fail('ssh-keygen отработал с ошибкой.');
  }
  const pub = fs.readFileSync(`${target}.pub`, 'utf8').trim();
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('Добавьте этот ОТКРЫТЫЙ ключ в GitHub как Deploy Key ТОЛЬКО ДЛЯ ЧТЕНИЯ:');
  console.log('  репозиторий → Settings → Deploy keys → Add deploy key');
  console.log(`  Название: ${cfg.name} server     Галку «Allow write access» НЕ ставить`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log(pub);
  console.log('──────────────────────────────────────────────────────────────');
  if (!cfg.deployKeyPath) {
    console.log(`Затем впишите  git.deployKeyPath: ${target}  в config/deploy.local.yaml`);
  }
}

// Полное развёртывание. Команда безопасна к повтору: второй и последующие запуски просто
// приводят сервер к описанному здесь состоянию, ничего не ломая и не теряя.
function cmdDeploy(cfg) {
  if (!cfg.deployKeyPath) fail('Не заполнено git.deployKeyPath. Выполните: node remote.cjs keygen');
  if (!fs.existsSync(cfg.deployKeyPath)) {
    fail(`Ключ для репозитория не найден: ${cfg.deployKeyPath}. Выполните: node remote.cjs keygen`);
  }

  const keyRemote = deployKeyPathRemote(cfg);
  const envFile = [
    `SERVICE_NAME=${cfg.name}`,
    `SERVICE_INSTANCE=${cfg.instance}`,
    cfg.debug ? `DEBUG=${cfg.debug}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const projectSteps = cfg.deploySteps.map((s) => `echo ${sq(`── ${s.title} ──`)}\n${s.run}`).join('\n\n');

  const script = `
set -euo pipefail
${nodeEnvPrelude(cfg)}

echo '── Проверка Node.js ──'
if [ ! -x "$NODE_DIR/node" ]; then
  echo 'Нужной версии Node.js в nvm нет — ставим её…'
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install ${cfg.nodeVersion}
fi
echo "node $(node -v), npm $(npm -v)"

echo '── Системные пакеты ──'
if ! command -v git >/dev/null 2>&1 || ! command -v lsof >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git lsof
fi
echo 'git и lsof на месте'

echo '── Ключ доступа к репозиторию ──'
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
umask 077
echo ${b64(fs.readFileSync(cfg.deployKeyPath, 'utf8'))} | base64 -d > ${keyRemote}
chmod 600 ${keyRemote}
touch "$HOME/.ssh/known_hosts"
ssh-keyscan -t rsa,ed25519 github.com 2>/dev/null >> "$HOME/.ssh/known_hosts" || true
sort -u "$HOME/.ssh/known_hosts" -o "$HOME/.ssh/known_hosts"
umask 022
GIT_SSH="ssh -i ${keyRemote} -o StrictHostKeyChecking=accept-new"

echo '── Рабочая копия репозитория ──'
mkdir -p "$(dirname ${sq(cfg.projectPath)})"
if [ ! -d ${sq(cfg.projectPath)}/.git ]; then
  echo 'Клонируем репозиторий…'
  GIT_SSH_COMMAND="$GIT_SSH" git clone -b ${sq(cfg.branch)} ${sq(cfg.repoUrl)} ${sq(cfg.projectPath)}
fi
cd ${sq(cfg.projectPath)}
# Ключ прописывается в настройках самой рабочей копии: тогда автообновление по расписанию
# обращается к GitHub тем же ключом, ничего не зная про переменные окружения. Адрес репозитория
# сверяется с настройками: после переименования репозитория копия иначе ходила бы по старому адресу.
git config core.sshCommand "$GIT_SSH"
git remote set-url origin ${sq(cfg.repoUrl)}
git fetch origin ${sq(cfg.branch)} --prune
git checkout -B ${sq(cfg.branch)} origin/${sq(cfg.branch)}
git reset --hard origin/${sq(cfg.branch)}
git clean -fd
git log -1 --pretty='Рабочая копия: %h %ci %B' | sed -n 1p

echo '── Файлы настроек ──'
mkdir -p config deploy
umask 077
echo ${b64(cfg.localYaml)} | base64 -d > config/local.yaml
echo ${b64(cfg.deployConfigYaml)} | base64 -d > deploy/deploy-config.yml
cat > .env <<'ENVEOF'
${envFile}
ENVEOF
umask 022
echo 'config/local.yaml, deploy/deploy-config.yml и .env записаны'
${accessDeliveryBody(cfg)}

echo '── Зависимости ──'
npm ci --no-audit --no-fund

${projectSteps}

echo '── Миграции баз данных ──'
npm run --silent migrate
echo 'Схема баз данных актуальна'

echo '── Служба systemd ──'
node .agents/skills/deploy/scripts/srv.cjs delete -p ${cfg.appPort} || true
node .agents/skills/deploy/scripts/srv.cjs install
sleep 3
systemctl is-active ${SERVICE} || { echo 'Служба не поднялась:'; journalctl -o cat --no-pager -n 40 -u ${SERVICE}; exit 1; }

${aliasRegisterBody(serviceAlias(), { exitOnTaken: false })}

${cronInstallBody(cfg)}

echo '── Проверка доступности на самой машине ──'
curl -fsS -o /dev/null -w 'Ответ приложения на 127.0.0.1:${cfg.appPort}${HEALTH_PATH} — код %{http_code}\\n' -m 10 "http://127.0.0.1:${cfg.appPort}${HEALTH_PATH}" \\
  || echo 'ВНИМАНИЕ: приложение на 127.0.0.1:${cfg.appPort} не ответило'
${nginxBody(cfg)}
`;
  say(`Разворачиваем ${cfg.name} (${cfg.title}) на ${cfg.user}@${cfg.host}, домен ${cfg.dns}`);
  const code = sshRun(cfg, script);
  if (code !== 0) fail(`Развёртывание не удалось (код возврата ${code}). Диагностика: node remote.cjs status`);
  say(`Готово. Адрес: https://${cfg.dns}/`);
}

function cmdStatus(cfg) {
  const lp = logPaths(cfg);
  const checks = cfg.statusChecks
    .map(
      (c) => `echo
echo ${sq(`===== ${String(c.title).toUpperCase()} =====`)}
( cd ${sq(cfg.projectPath)} 2>/dev/null && { ${c.run}; } ) || echo '(проверка не выполнилась: нет каталога проекта или команда упала)'`,
    )
    .join('\n');
  const script = `
${nodeEnvPrelude(cfg)}
echo '===== СЛУЖБА ====='
systemctl is-active ${SERVICE} 2>/dev/null || echo 'служба не запущена'
systemctl is-enabled ${SERVICE} 2>/dev/null || echo 'служба не включена в автозапуск'
systemctl show ${SERVICE} -p ActiveEnterTimestamp --value 2>/dev/null | sed 's/^/работает с: /'
${checks}
echo
echo '===== РАБОЧАЯ КОПИЯ ====='
cd ${sq(cfg.projectPath)} 2>/dev/null && git log -1 --pretty='%h  %ci  %B' | sed -n 1p || echo '(каталог проекта не найден)'
echo
echo '===== ДОСТУПНОСТЬ ====='
${healthBody(cfg)}
echo
echo '===== АВТООБНОВЛЕНИЕ ====='
crontab -l 2>/dev/null | grep -F ${cronMatch(cfg)} || echo 'задания автообновления в crontab нет'
echo -n 'итог последнего обновления: '
cat ${lp.status} 2>/dev/null || echo '(обновление ещё ни разу не отрабатывало — проверка идёт раз в минуту)'
ERRS=$(grep -aF '[ERROR]' ${lp.lastDeploy} 2>/dev/null | wc -l | tr -d ' ')
if [ "\${ERRS:-0}" -gt 0 ] 2>/dev/null; then
  echo "⚠ строк с ошибками в последнем обновлении: \${ERRS} — подробности: node remote.cjs updatelog"
  grep -aF '[ERROR]' ${lp.lastDeploy} 2>/dev/null | tail -4
else
  echo 'ошибок в последнем обновлении не отмечено'
fi
if [ -s ${lp.errors} ]; then
  echo "⚠ update.cjs писал в поток ошибок, последний раз $(date -r ${lp.errors} '+%F %T') — подробности: node remote.cjs updatelog"
  tail -4 ${lp.errors}
fi
echo
echo '===== NGINX ====='
if [ -f /etc/nginx/sites-enabled/${cfg.dns}.conf ] || [ -L /etc/nginx/sites-enabled/${cfg.dns}.conf ]; then
  echo -n 'раздел для домена есть; сертификат: '
  grep -m1 ssl_certificate /etc/nginx/sites-available/${cfg.dns}.conf 2>/dev/null | sed 's/^\\s*//' || echo 'не найден'
else
  echo 'раздела nginx для этого домена нет'
fi
`;
  say(`Диагностика ${cfg.name} (${cfg.dns})`);
  sshRun(cfg, script);
}

// Короткое имя службы для утилиты restart / logs / stop: подчёркивания и дефисы делят имя службы на
// слова, берутся первые буквы слов в нижнем регистре (my-app--prod даёт map).
function serviceAlias() {
  return SERVICE.split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toLowerCase())
    .join('');
}

// Сценарий регистрации на сервере. Печатает строки с префиксом ALIAS: нет утилиты — сообщение;
// служба уже зарегистрирована — ничего не делает; алиас занят — перечень занятых и просьба
// придумать другой (с exitOnTaken выходит кодом 2, иначе идёт дальше — для deploy).
function aliasRegisterBody(alias, { exitOnTaken }) {
  return `
echo '── Алиас службы для restart / logs / stop ──'
if ! command -v restart >/dev/null 2>&1; then
  echo 'ALIAS: утилиты restart/logs/stop на сервере нет — алиас не заводится'
elif [ ! -f /etc/restart-config.json ]; then
  echo 'ALIAS: утилита есть, но /etc/restart-config.json не найден — алиас не заводится'
else
  TAKEN=$(jq -r '.service_aliases | to_entries[] | "\\(.key) -> \\(.value)"' /etc/restart-config.json 2>/dev/null)
  MINE=$(printf '%s\\n' "$TAKEN" | awk -v s=${sq(SERVICE)} '$3 == s { print $1 }' | head -1)
  if [ -n "$MINE" ]; then
    echo "ALIAS: служба ${SERVICE} уже зарегистрирована как '$MINE' — работают: restart $MINE, logs $MINE, stop $MINE"
  elif printf '%s\\n' "$TAKEN" | awk '{ print $1 }' | grep -qx -- ${sq(alias)}; then
    echo "ALIAS ЗАНЯТ: '${alias}' уже указывает на другую службу. Занятые алиасы:"
    printf '%s\\n' "$TAKEN" | sed 's/^/  /'
    echo 'Придумай другой алиас по правилам из SKILL.md и повтори: node remote.cjs alias --alias <новый>'
    ${exitOnTaken ? 'exit 2' : 'true'}
  elif restart add ${sq(alias)} ${sq(SERVICE)} </dev/null; then
    echo "ALIAS: '${alias}' -> ${SERVICE} зарегистрирован; теперь работают: restart ${alias}, logs ${alias}, stop ${alias}"
  else
    echo "ALIAS: не удалось зарегистрировать '${alias}' — см. вывод утилиты выше"
    ${exitOnTaken ? 'exit 1' : 'true'}
  fi
fi`;
}

//   node remote.cjs alias                  зарегистрировать алиас, посчитанный из имени службы
//   node remote.cjs alias --alias <имя>    зарегистрировать заданный алиас (1–8 строчных букв и цифр)
function cmdAlias(cfg, args) {
  const idx = args.indexOf('--alias');
  const alias = idx >= 0 ? String(args[idx + 1] ?? '') : serviceAlias();
  if (!/^[a-z0-9]{1,8}$/.test(alias)) fail(`алиас «${alias}» не годится: от 1 до 8 строчных латинских букв и цифр`);
  say(`Регистрирую алиас '${alias}' для службы ${SERVICE}`);
  process.exit(sshRun(cfg, aliasRegisterBody(alias, { exitOnTaken: true })) || 0);
}

// Ждёт, пока автообновление доведёт копию на сервере до отправленного коммита, и одним заходом
// печатает итог: обновление, служба, доступность, старт. Опрос раз в 5 секунд, предел — 120 секунд:
// задание проверяет ветку раз в минуту, само обновление занимает около 20 секунд. Это единственный
// правильный способ дождаться выпуска: не паузы вслепую и не три отдельных вызова status,
// updatelog и logs.
//
//   node remote.cjs wait-update            ждать коммит origin/<ветка> этой рабочей копии
//   node remote.cjs wait-update <коммит>   ждать указанный коммит (полный хеш)
function cmdWaitUpdate(cfg, args) {
  let expected = args[0];
  if (!expected) {
    const res = spawnSync('git', ['rev-parse', `origin/${cfg.branch}`], { encoding: 'utf8', cwd: PROJECT_ROOT });
    if (res.status !== 0) fail(`не удалось узнать коммит origin/${cfg.branch} — сначала выполните git push`);
    expected = res.stdout.trim();
  }
  const short = expected.slice(0, 7);
  const lp = logPaths(cfg);
  const script = `
cd ${sq(cfg.projectPath)} || { echo 'каталог проекта не найден'; exit 1; }
WANT=${sq(expected)}
for i in $(seq 1 24); do
  if [ "$(git rev-parse HEAD 2>/dev/null)" = "$WANT" ] \\
     && grep -aqF "Последний коммит: $WANT" ${lp.lastDeploy} 2>/dev/null \\
     && grep -aqF '#FINISH#' ${lp.lastDeploy} 2>/dev/null; then
    echo "обновление до ${short} завершено, ждали $((i * 5)) с"
    echo -n 'итог: '; cat ${lp.status} 2>/dev/null || echo '(нет записи)'
    echo -n 'служба: '; systemctl is-active ${SERVICE} 2>/dev/null || echo 'НЕ ЗАПУЩЕНА'
    ${healthBody(cfg).replace(/\n/g, '\n    ')}
    journalctl -o cat --no-pager -n 40 -u ${SERVICE} 2>/dev/null | grep -iE 'listen|слуша|запущен|started|error|ошибк' | tail -3
    exit 0
  fi
  sleep 5
done
echo "за 120 с сервер не дошёл до ${short}: копия на $(git rev-parse --short HEAD 2>/dev/null)"
echo -n 'итог последнего обновления: '; cat ${lp.status} 2>/dev/null || echo '(нет записи)'
[ -s ${lp.errors} ] && { echo 'хвост потока ошибок update.cjs:'; tail -5 ${lp.errors}; }
exit 2
`;
  say(`Жду, пока сервер обновится до ${short} (не дольше 120 с)`);
  process.exit(sshRun(cfg, script) || 0);
}

function cmdStop(cfg) {
  say('Останавливаем службу (автообновление продолжит работать и поднимет её при новом коммите)');
  sshRun(cfg, `systemctl stop ${SERVICE} && echo 'служба остановлена'`);
}

function cmdStart(cfg) {
  say('Запускаем службу');
  sshRun(cfg, `systemctl start ${SERVICE} && echo 'служба запущена'`);
}

function cmdRestart(cfg) {
  say('Перезапускаем службу');
  sshRun(cfg, `systemctl restart ${SERVICE} && sleep 2 && systemctl is-active ${SERVICE}`);
}

function cmdUpdate(cfg) {
  say('Немедленное обновление из ветки (update.cjs --force)');
  sshRun(
    cfg,
    `${nodeEnvPrelude(cfg)}
cd ${sq(cfg.projectPath)} && node update.cjs --force`,
  );
}

// Быстрый путь для смены настроек: config/local.yaml и раздел autoUpdate (deploy/deploy-config.yml)
// кладутся на сервер, служба перезапускается. Ни репозиторий, ни зависимости при этом не трогаются —
// секунды вместо минут. Ключи доступа доставляет отдельная команда push-auth.
//
//   node remote.cjs push-config               положить оба файла и перезапустить службу
//   node remote.cjs push-config --no-restart  только положить; перезапустить потом командой restart
//
// Содержимое файлов никуда не печатается: в них пароли и токены. Сообщается только, что именно
// изменилось: создан, обновлён или совпал.
function cmdPushConfig(cfg, args) {
  const noRestart = args.includes('--no-restart');
  const restartBlock = noRestart
    ? `echo 'Перезапуск пропущен (--no-restart). Применить новые настройки: node remote.cjs restart'`
    : `echo 'Перезапускаем службу…'
systemctl restart ${SERVICE}
sleep 3
systemctl is-active ${SERVICE}
curl -fsS -o /dev/null -w 'проверка: http://127.0.0.1:${cfg.appPort}${HEALTH_PATH} — код %{http_code}\\n' -m 10 "http://127.0.0.1:${cfg.appPort}${HEALTH_PATH}" \\
  || echo 'ВНИМАНИЕ: приложение не ответило — смотрите: node remote.cjs logs 100'`;

  const script = `
set -uo pipefail
cd ${sq(cfg.projectPath)} 2>/dev/null || { echo 'Каталог проекта ${cfg.projectPath} не найден — выполните: node remote.cjs deploy'; exit 1; }
umask 077
echo ${b64(cfg.localYaml)} | base64 -d > /tmp/pc-local.yaml
echo ${b64(cfg.deployConfigYaml)} | base64 -d > /tmp/pc-deploy-config.yml
CHANGED=0
push_file() {
  src="$1"; dst="$2"
  if [ ! -f "$dst" ]; then
    cp "$src" "$dst"; echo "  $dst — создан"; CHANGED=1; return
  fi
  if [ "$(sha256sum "$src" | cut -d' ' -f1)" = "$(sha256sum "$dst" | cut -d' ' -f1)" ]; then
    echo "  $dst — совпадает, не тронут"; return
  fi
  cp "$dst" "/tmp/pc-prev-$(basename "$dst")"
  cp "$src" "$dst"
  echo "  $dst — обновлён (прежний остался в /tmp/pc-prev-$(basename "$dst"))"
  CHANGED=1
}
mkdir -p config deploy
echo 'Раскладываем файлы настроек:'
push_file /tmp/pc-local.yaml config/local.yaml
push_file /tmp/pc-deploy-config.yml deploy/deploy-config.yml
rm -f /tmp/pc-local.yaml /tmp/pc-deploy-config.yml
umask 022
if [ "$CHANGED" = '0' ]; then
  echo 'Оба файла уже такие же — перезапускать нечего.'
  exit 0
fi
${restartBlock}
if ! grep -qs "127.0.0.1:${cfg.appPort}" /etc/nginx/sites-available/${cfg.dns}.conf; then
  echo '⚠ nginx направляет запросы не на 127.0.0.1:${cfg.appPort} — изменился webServer.port? Выполните: node remote.cjs deploy'
fi
`;
  say(`Кладём настройки на ${cfg.user}@${cfg.host}`);
  const code = sshRun(cfg, script);
  if (code !== 0) fail(`Не удалось разложить настройки (код возврата ${code}). Диагностика: node remote.cjs status`);
}

// Доставка файла ключей без перезапуска: служба перечитывает его сама и пишет в журнал событие применения.
//   node remote.cjs push-auth [--allow-empty]   --allow-empty — экстренный отзыв всех ключей пустым списком
function cmdPushAuth(cfg, args) {
  const content = checkedAccessFile(cfg, { allowEmpty: args.includes('--allow-empty') });
  const script = `
set -euo pipefail
cd ${sq(cfg.projectPath)} 2>/dev/null || { echo 'Каталог проекта ${cfg.projectPath} не найден — выполните: node remote.cjs deploy'; exit 1; }
${accessUploadBody(content)}
`;
  say(`Доставляем файл ключей доступа на ${cfg.user}@${cfg.host}`);
  const code = sshRun(cfg, script);
  if (code !== 0) fail(`Файл ключей не доставлен (код возврата ${code}).`);
  say('Применение подтверждается записью о применении файла доступа в журнале службы: node remote.cjs logs 50');
}

function cmdLogs(cfg, n) {
  const lines = /^\d+$/.test(String(n)) ? n : '200';
  say(`Последние ${lines} строк журнала службы`);
  sshRun(cfg, `journalctl -o cat --no-pager -n ${lines} -u ${SERVICE}`);
}

// Разбор истории автообновления: итог последнего прогона, строки с ошибками и хвост журнала.
function cmdUpdatelog(cfg, n) {
  const lines = /^\d+$/.test(String(n)) ? n : '80';
  const lp = logPaths(cfg);
  const script = `
echo '===== ИТОГ ПОСЛЕДНЕГО ОБНОВЛЕНИЯ ====='
cat ${lp.status} 2>/dev/null || echo '(обновление ещё ни разу не отрабатывало — проверка идёт раз в минуту)'
echo
echo '===== СТРОКИ С ОШИБКАМИ (последний прогон и история) ====='
{ grep -aF '[ERROR]' ${lp.lastDeploy} 2>/dev/null; grep -aF '[ERROR]' ${lp.cumulative} 2>/dev/null; } | tail -20
grep -aqF '[ERROR]' ${lp.lastDeploy} ${lp.cumulative} 2>/dev/null || echo '(записей [ERROR] нет)'
echo
echo '===== ПОТОК ОШИБОК update.cjs (след падений и прочие сообщения об ошибках, хвост 30 строк) ====='
tail -n 30 ${lp.errors} 2>/dev/null | grep . || echo '(пусто)'
echo
echo '===== ЖУРНАЛ ПОСЛЕДНЕГО ОБНОВЛЕНИЯ (хвост ${lines} строк) ====='
tail -n ${lines} ${lp.lastDeploy} 2>/dev/null || echo '(завершённых обновлений пока не записано)'
`;
  say('Журнал автообновления и разбор ошибок');
  sshRun(cfg, script);
}

function cmdShell(cfg) {
  say('Открываем оболочку в каталоге проекта на сервере (выход — exit)');
  sshRun(cfg, `cd ${sq(cfg.projectPath)} && exec bash -l`, { interactive: true });
}

function cmdExec(cfg, args) {
  const idx = args.indexOf('--');
  const parts = idx >= 0 ? args.slice(idx + 1) : args;
  if (!parts.length) fail('Использование: node remote.cjs exec -- <команда…>');
  const inner = parts.join(' ');
  say(`Выполняем на сервере: ${inner}`);
  sshRun(
    cfg,
    `${nodeEnvPrelude(cfg)}
cd ${sq(cfg.projectPath)} && ${inner}`,
  );
}

function cmdUninstall(cfg, yes) {
  if (!yes) {
    fail(`Действие необратимо. Повторите с --yes, чтобы снести службу, задание cron, раздел nginx и каталог проекта:
  node remote.cjs uninstall --yes`);
  }
  const lp = logPaths(cfg);
  const script = `
set -uo pipefail
${nodeEnvPrelude(cfg)}
echo 'Снимаем задание автообновления…'
if CRON_OLD=$(crontab -l 2>/dev/null); then
  printf '%s\\n' "$CRON_OLD" | grep -vF ${cronMatch(cfg)} | crontab -
fi
echo 'Останавливаем и удаляем службу…'
cd ${sq(cfg.projectPath)} 2>/dev/null && node .agents/skills/deploy/scripts/srv.cjs delete -p ${cfg.appPort} || {
  systemctl disable --now ${SERVICE} 2>/dev/null || true
  rm -f /etc/systemd/system/${SERVICE}.service
  systemctl daemon-reload
}
echo 'Убираем раздел nginx…'
if [ -f /etc/nginx/sites-available/${cfg.dns}.conf ] || [ -L /etc/nginx/sites-enabled/${cfg.dns}.conf ]; then
  rm -f /etc/nginx/sites-enabled/${cfg.dns}.conf /etc/nginx/sites-available/${cfg.dns}.conf /etc/nginx/snippets/${SNIPPET}
  nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo 'раздел nginx удалён' || echo 'nginx не перезагружен — проверьте nginx -t'
fi
echo 'Удаляем каталог проекта и журналы обновления…'
cd /
rm -rf ${sq(cfg.projectPath)}
rm -f ${lp.status} ${lp.lastDeploy} ${lp.cumulative} ${lp.errors}
echo 'Замечание: сертификат для ${cfg.dns} и внешние каталоги данных службы оставлены на месте.'
echo 'Готово.'
`;
  say(`Сносим ${cfg.name} с сервера`);
  sshRun(cfg, script);
}

function cmdSsh(cfg) {
  console.log(`ssh ${sshBaseArgs(cfg).join(' ')}`);
}

// ── Точка входа ──────────────────────────────────────────────────────────────
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  SERVICE = `${cfg.name}--${cfg.instance}`;
  UPSTREAM = `${cfg.name.replace(/[^a-z0-9-]/gi, '-')}_upstream`;
  SNIPPET = `${cfg.name}-proxy.conf`;
  switch (cmd) {
    case 'keygen':
      return cmdKeygen(cfg);
    case 'deploy':
      return cmdDeploy(cfg);
    case 'status':
      return cmdStatus(cfg);
    case 'stop':
      return cmdStop(cfg);
    case 'start':
      return cmdStart(cfg);
    case 'restart':
      return cmdRestart(cfg);
    case 'push-config':
      return cmdPushConfig(cfg, rest);
    case 'push-auth':
      return cmdPushAuth(cfg, rest);
    case 'update':
      return cmdUpdate(cfg);
    case 'wait-update':
      return cmdWaitUpdate(cfg, rest);
    case 'alias':
      return cmdAlias(cfg, rest);
    case 'logs':
      return cmdLogs(cfg, rest[0]);
    case 'updatelog':
      return cmdUpdatelog(cfg, rest[0]);
    case 'shell':
      return cmdShell(cfg);
    case 'exec':
      return cmdExec(cfg, rest);
    case 'uninstall':
      return cmdUninstall(cfg, rest.includes('--yes'));
    case 'ssh':
      return cmdSsh(cfg);
    default:
      console.log(`Развёртывание «${cfg.name}» (${cfg.title}) на сервере — команды:
  keygen            Завести ключ только для чтения репозитория и напечатать открытую половину
  deploy            Полное развёртывание либо повторное: код, настройки, зависимости, шаги проекта,
                    миграции, служба systemd, автообновление по расписанию и раздел nginx
  status            Диагностика: служба, проверки проекта, рабочая копия, доступность, обновление, nginx
  stop              Остановить службу
  start             Запустить службу
  restart           Перезапустить службу
  push-config       Положить на сервер config/local.yaml и deploy/deploy-config.yml и перезапустить службу
                      [--no-restart] только положить, перезапустить потом
  push-auth         Проверить и атомарно доставить файл ключей доступа (config/access.local.yaml) без перезапуска
                      [--allow-empty] пустой список клиентов — экстренный отзыв всех ключей
  update            Немедленное обновление из ветки (update.cjs --force)
  wait-update [хеш] Дождаться, пока автообновление дойдёт до отправленного коммита, и напечатать итог
  alias [--alias X] Зарегистрировать службу в утилите restart/logs/stop под коротким алиасом
  logs [N]          Последние N строк журнала службы (по умолчанию 200)
  updatelog [N]     Итог последнего автообновления, ошибки и хвост журнала (по умолчанию 80)
  shell             Оболочка в каталоге проекта на сервере
  exec -- <cmd…>    Произвольная команда в каталоге проекта
  uninstall --yes   Снести службу, cron, раздел nginx и каталог проекта
  ssh               Напечатать готовую команду ssh`);
      if (cmd && cmd !== 'help') process.exit(1);
  }
}

main();
