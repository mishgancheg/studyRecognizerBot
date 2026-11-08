#!/usr/bin/env node

// Автообновление рабочей копии проекта на сервере.
//
// ЧТО ЭТО ТАКОЕ. Скрипт живёт в корне проекта НА СЕРВЕРЕ и запускается по расписанию (cron, раз в
// минуту). Он смотрит, не появилось ли в ветке новых изменений, и если появились — забирает их,
// переустанавливает зависимости, выполняет шаги обновления проекта (раздел `update` файла
// `.agents/skills/deploy/project.yaml`), догоняет схему баз данных миграциями (`npm run migrate`) и
// перезапускает службу. Скрипт общий для всех проектов: его эталон хранится вместе с навыком
// развёртывания и разносится командой `node .agents/skills/deploy/scripts/sync.cjs`.
// Результат каждой такой попытки он записывает в журнал рядом с проектом и, если настроено,
// присылает письмо и сообщение в Телеграм.
//
// ПОЧЕМУ ЖЁСТКИЙ СБРОС, А НЕ `git pull`. Рабочая копия на сервере — не место для правок: всё, что
// в ней изменено руками, скрипт отбрасывает (`git reset --hard` + `git clean -fd`) и приводит копию
// ровно к состоянию ветки. Слияние с местными правками на сервере рано или поздно упирается в
// конфликт, разбирать который посреди ночи некому. Файлы, перечисленные в `.gitignore`
// (`config/local.yaml` с секретами, `.env`, каталоги данных проекта), очистка не трогает — они переживают
// любое обновление.
//
// ПОЧЕМУ ОТКАЗ GIT НЕ СРАЗУ СЧИТАЕТСЯ ПОЛОМКОЙ. Обращение к GitHub изредка не удаётся по причинам,
// которые проходят сами: обрыв сети, недоступность стороны. Раз в минуту такой отказ породил бы
// поток ложных тревог, поэтому сообщение уходит только после пяти подряд неудачных проверок и
// только один раз, а восстановление доступа отмечается отдельной записью.
//
// Запуск вручную: `./update.cjs -f` (или `--force`) — обновиться немедленно, не дожидаясь новых изменений.

// Падение, которое не поймала обработка ошибок ниже, — в том числе раньше, чем заведены журналы (скажем,
// после сорванной установки зависимостей нет модуля yaml), — печатается в поток ошибок со временем и
// стеком. Расписание дописывает этот поток в deploy__<проект>__errors.log, и от падения остаётся след.
process.on('uncaughtException', (error) => {
  console.error(`${new Date().toISOString()} update.cjs упал: ${error.stack || error}`);
  process.exit(1);
});

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const YAML = require('yaml');
const { execSync, spawn } = require('child_process');

// Дата-версия скрипта; имя проекта дописывается к ней при запуске — из SERVICE_NAME либо package.json.
const versionDate = '2026.11.01';

// Имя каталога проекта — из него складываются имена файлов журнала.
const scriptDirName = path.basename(__dirname);
// Рабочий каталог = каталог проекта: все команды git/npm выполняются именно в нём.
process.chdir(__dirname);
const CWD = process.cwd();
// Каталог уровнем выше проекта: там лежат журналы, чтобы `git clean` их не задел.
const VON = path.resolve(path.join(CWD, '..'));

const DEFAULT_CONFIG = {
  branch: 'master',
  emails: [],
  telegramChatIds: [],
  telegramBotToken: '',
};

// Версия Node.js, на которой всё запускается, если её не удалось вычитать ни из `.envrc`,
// ни из `deploy/deploy-config.yml`.
const DEFAULT_NODE_VERSION = '22.19.0';

// Цвета вывода в терминал
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const color = {};
const colorG = {};
['cyan', 'green', 'magenta', 'red', 'yellow'].forEach((col) => {
  const firstLetter = col[0];
  color[firstLetter] = (text) => `${colors.bright}${colors[col]}${text}${colors.reset}`;
  color[`l${firstLetter}`] = (text) => `${colors[col]}${text}${colors.reset}`;
  colorG[firstLetter] = (text) => `${colors.bright}${colors[col]}${text}${colors.green}`;
  colorG[`l${firstLetter}`] = (text) => `${colors[col]}${text}${colors.green}`;
});

const echo = {
  c: (text) => console.log(color.c(text)),
  g: (text) => console.log(color.g(text)),
  r: (text) => console.log(color.r(text)),
  y: (text) => console.log(color.y(text)),
};

let logBuffer = '';

// Каталог с двоичными файлами node/npm выбранной версии. Подставляется в PATH каждой команды:
// cron запускается с урезанным окружением, и без этого `npm` был бы взят системный (старый).
let nodeBinDir = '';
let nodeVersion = null;

const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0].replace('T', '');
const ytdl = timestamp.slice(2, 14); // ГГММДДЧЧММСС
const runTimeLogFile = path.join(VON, `deploy__${scriptDirName}__processing__${ytdl}.log`);
const lastDeployLogFile = path.join(VON, `deploy__${scriptDirName}__last_deploy.log`);
const cumulativeLogFile = path.join(VON, `deploy__${scriptDirName}__cumulative.log`);
// Однострочный итог последнего обновления, пригодный для чтения программой (его показывают
// команды `status` и `updatelog` навыка развёртывания): «SUCCESS|FAIL | <время> | <подробность>».
const statusFile = path.join(VON, `deploy__${scriptDirName}__status.log`);
// Поток ошибок самого скрипта: расписание дописывает его сюда (`2>>`). При обычной работе файл пуст.
const errorsLogFile = path.join(VON, `deploy__${scriptDirName}__errors.log`);
const gitFailureStateFile = path.join(VON, `deploy__${scriptDirName}__git_failures.json`);
const GIT_FAILURE_NOTIFICATION_THRESHOLD = 5;

const clearColors = (text) => text.replace(/\x1B\[[0-9;]*[mGKH]/g, '');
// Пометки отчёта: цвет <red>, <y>, <g>, <r>, жирный шрифт <b> и место итога <status>. В письме они становятся
// разметкой HTML, а из консоли, журнала и Телеграма вычищаются.
const MARKUP_TAG = /(<\/?(?:red|y|g|r|b|status)>)/;
// Текст извне (сообщение коммита) может сам содержать «<b>»: его знаки экранируются, чтобы не стать пометкой.
// Уже экранированные знаки повторно не трогаются.
const escapeMarkup = (text) =>
  text
    .replace(/&(?!(?:amp|lt|gt);)/g, '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const clearHtmlColors = (text) =>
  text
    .split(MARKUP_TAG)
    .filter((_, index) => index % 2 === 0)
    .join('')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const logIt = (msg, isTitle) => {
  if (isTitle) {
    const lng = 60 - (msg.length + 2);
    const left = Math.floor(lng / 2);
    const right = lng - left;
    msg = `${'='.repeat(left)} ${msg} ${'='.repeat(right)}`;
  }
  const msg4console = clearHtmlColors(msg);
  echo.g(msg4console);
  logBuffer += `${msg}\n`;
  fs.appendFileSync(runTimeLogFile, `${clearColors(msg4console)}\n`);
};

const logError = (msg) => {
  console.error(color.r(msg));
  const msg2 = `[ERROR] ${msg}`;
  logBuffer += `<red>${msg2}</red>\n`;
  fs.appendFileSync(cumulativeLogFile, `${msg2}\n`);
  try {
    fs.appendFileSync(runTimeLogFile, `${msg2}\n`);
  } catch {
    /* журнал текущего прогона мог ещё не появиться */
  }
};

const nowPretty = () => `${new Date().toISOString().replace('T', ' ').substring(0, 19)}Z`;

/** Записывает однострочный итог текущего прогона. */
const writeStatus = (status, detail = '') => {
  try {
    fs.writeFileSync(statusFile, `${status} | ${nowPretty()} | ${String(detail).split('\n')[0]}\n`);
  } catch {
    /* попытка не пытка */
  }
};

/** Подрезает журнал, если он перевалил за 2 МБ: оставляет последние 10 КБ. */
const truncateLogIfNeeded = (logFile) => {
  const maxFileSize = 2 * 1024 * 1024;
  const keepSize = 10 * 1024;
  try {
    if (!fs.existsSync(logFile)) {
      return;
    }
    const stats = fs.statSync(logFile);
    if (stats.size <= maxFileSize) {
      return;
    }
    const fd = fs.openSync(logFile, 'r');
    const buffer = Buffer.alloc(keepSize);
    fs.readSync(fd, buffer, 0, keepSize, stats.size - keepSize);
    fs.closeSync(fd);
    const tailContent = buffer.toString('utf8').replace(/^[\r\n]*/, '');
    fs.writeFileSync(logFile, tailContent);
    logIt(`${path.basename(logFile)} truncated to ${Math.round(tailContent.length / 1024)}KB`);
  } catch (error) {
    logError(`Failed to truncate ${path.basename(logFile)}: ${error.message}`);
  }
};

const logTryUpdate = (updateReason = '') => {
  truncateLogIfNeeded(cumulativeLogFile);
  truncateLogIfNeeded(errorsLogFile);
  const message = updateReason ? `Update reason: ${updateReason}` : nowPretty();
  fs.appendFileSync(cumulativeLogFile, `${message}\n`);
};

/**
 * Выполняет команду оболочки в каталоге проекта. PATH дополняется каталогом выбранной версии
 * Node.js, поэтому `node` и `npm` всегда те же самые, каким бы бедным ни было окружение cron.
 */
function execCommand(command, options = {}) {
  const env = { ...process.env, ...options.env };
  if (nodeBinDir) {
    env.PATH = `${nodeBinDir}:${env.PATH || ''}`;
  }
  return execSync(command, {
    encoding: 'utf8',
    stdio: options.silent ? 'inherit' : 'pipe',
    shell: '/bin/bash',
    ...options,
    env,
  });
}

const formatError = (error) => {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  const message = error?.message ? String(error.message).trim() : String(error).trim();
  return [...new Set([stderr, message].filter(Boolean))].join('\n');
};

class RepoInfoError extends Error {
  constructor(cause) {
    super(formatError(cause));
    this.name = 'RepoInfoError';
    this.cause = cause;
  }
}

const readGitFailureState = () => {
  try {
    return JSON.parse(fs.readFileSync(gitFailureStateFile, 'utf8'));
  } catch {
    return null;
  }
};

const recordGitFailure = (error) => {
  const previous = readGitFailureState();
  const now = new Date().toISOString();
  const state = {
    count: Number(previous?.count || 0) + 1,
    firstFailureAt: previous?.firstFailureAt || now,
    lastFailureAt: now,
    lastError: formatError(error),
    notified: Boolean(previous?.notified),
  };
  fs.writeFileSync(gitFailureStateFile, `${JSON.stringify(state, null, 2)}\n`);
  return state;
};

const markGitFailureNotified = (state) => {
  fs.writeFileSync(gitFailureStateFile, `${JSON.stringify({ ...state, notified: true }, null, 2)}\n`);
};

const clearGitFailureState = () => {
  const previous = readGitFailureState();
  try {
    fs.unlinkSync(gitFailureStateFile);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  return previous;
};

/**
 * Определяет версию Node.js (из `.envrc`, из `deploy/deploy-config.yml` или ту, которой запущен скрипт)
 * и находит каталог с её двоичными файлами. Сначала пробуется установка через nvm, потом —
 * каталог текущего процесса.
 */
function resolveNode(configNodeVersion) {
  try {
    if (fs.existsSync('.envrc')) {
      const m = fs.readFileSync('.envrc', 'utf8').match(/nvm\s+use\s+([0-9]+\.[0-9]+\.[0-9]+)/);
      if (m) {
        nodeVersion = m[1];
      }
    }
  } catch {
    logError('Не удалось прочитать .envrc');
  }
  let from = ' .envrc';
  if (!nodeVersion && configNodeVersion) {
    nodeVersion = String(configNodeVersion);
    from = ' deploy/deploy-config.yml';
  }
  if (!nodeVersion) {
    nodeVersion = process.version.replace(/^v/, '') || DEFAULT_NODE_VERSION;
    from = ' текущий процесс';
  }

  const nvmBin = path.join(os.homedir(), '.nvm', 'versions', 'node', `v${nodeVersion}`, 'bin');
  if (fs.existsSync(path.join(nvmBin, 'node'))) {
    nodeBinDir = nvmBin;
  } else {
    nodeBinDir = path.dirname(process.execPath);
  }
  logIt(`Node.js ${colorG.lg(nodeVersion)} (источник версии:${from}), каталог: ${colorG.lg(nodeBinDir)}`);
}

/** Разбирает доводы запуска. */
function parseArgs() {
  const pArgs = process.argv.slice(2);
  const args = { expectedBranch: null, force: false, help: false };
  for (let i = 0; i < pArgs.length; i++) {
    switch (pArgs[i]) {
      case '-b':
      case '--branch':
        args.expectedBranch = pArgs[++i];
        break;
      case '-f':
      case '--force':
        args.force = true;
        break;
      case '-?':
      case '--help':
        args.help = true;
        break;
    }
  }
  return args;
}

/** Человекочитаемое название проекта — `productName` из package.json (запасной вариант — `name`). */
function readProductTitle() {
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    return pkg.productName || pkg.name || 'проект';
  } catch {
    return 'проект';
  }
}

function showHelp() {
  console.log(`
================================================================================
    Обновление и пересборка проекта ${readProductTitle()}

    Запуск:
        node update.cjs [доводы]

    Доводы:

    -b|--branch <ветка>
        Ветка git, за которой следим. По умолчанию — из deploy/deploy-config.yml (master).
    -f|--force
        Обновиться немедленно, даже если новых изменений в ветке нет.
    -?|--help
        Показать эту справку.

    Пример: node update.cjs -b master --force
================================================================================
`);
}

/** YAML-список получателей (адреса писем, номера чатов Телеграма); пустые значения отбрасываются. */
const toRecipientList = (value) =>
  []
    .concat(value || [])
    .map((one) => String(one).trim())
    .filter(Boolean);

/**
 * Читает `deploy/deploy-config.yml`: ветка, получатели писем, блок SMTP, токен бота Телеграма и чаты
 * получателей сообщений о результате обновления.
 */
function loadConfig() {
  const configFile = path.join(CWD, 'deploy', 'deploy-config.yml');
  if (!fs.existsSync(configFile)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const config = YAML.parse(fs.readFileSync(configFile, 'utf8')) || {};
    const deployReportBot = (config.telegram && config.telegram.deployReportBot) || {};
    const smtp = config.smtp && config.smtp.host ? config.smtp : null;
    return {
      branch: config.branch || DEFAULT_CONFIG.branch,
      nodeVersion: config.nodeVersion,
      emails: toRecipientList(config.emails),
      smtp,
      telegramChatIds: toRecipientList(deployReportBot.chatIds),
      telegramBotToken: deployReportBot.token || DEFAULT_CONFIG.telegramBotToken,
    };
  } catch (error) {
    console.warn(`Не удалось разобрать ${configFile}:`, error.message);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Имя службы systemd. Основа берётся из `.env` (`SERVICE_NAME`) либо из `package.json`, а
 * необязательное окончание `--<экземпляр>` — из `SERVICE_INSTANCE`. Ровно та же логика в
 * `.agents/skills/deploy/scripts/srv.cjs`, иначе скрипт перезапускал бы не ту службу, которую ставил.
 */
function getServiceName() {
  let serviceName = '';
  let serviceInstance = '';
  try {
    if (fs.existsSync('.env')) {
      const envContent = fs.readFileSync('.env', 'utf8');
      let match = envContent.match(/^SERVICE_NAME=([^\r\n]+)/m);
      if (match) {
        serviceName = match[1].trim();
      }
      match = envContent.match(/^SERVICE_INSTANCE=([^\r\n]+)/m);
      if (match) {
        serviceInstance = `--${match[1].trim()}`;
      }
    }
    if (!serviceName) {
      serviceName = JSON.parse(fs.readFileSync('package.json', 'utf8')).name;
    }
    return { serviceName, serviceUnit: `${serviceName}${serviceInstance}` };
  } catch (error) {
    console.error('Не удалось определить имя службы:', error.message);
    process.exit(1);
  }
}

function systemctlServiceExists(serviceUnit) {
  try {
    const out = execCommand(`systemctl list-unit-files "${serviceUnit}.service"`);
    return new RegExp(`\\b${serviceUnit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.service\\b`).test(out);
  } catch {
    return false;
  }
}

/** Сведения о состоянии рабочей копии и о вершине ветки на GitHub. */
function getRepoInfo() {
  try {
    const branch = execCommand('git rev-parse --abbrev-ref HEAD').trim();
    const headHash = execCommand('git rev-parse HEAD').trim();
    // Только первая строка: формат %s склеил бы в одну строку весь первый абзац сообщения.
    const headCommitMessage = execCommand(`git log -n 1 --format=%B ${headHash}`).split('\n')[0].trim();
    const headDdate = execCommand(
      `git log -n 1 --format="%at" ${headHash} | xargs -I{} date -d @{} +%d.%m.%Y_%H:%M:%S`,
    ).trim();
    execCommand(`git fetch origin ${branch} --prune`);
    const upstreamHash = execCommand(`git rev-parse ${branch}@{upstream}`).trim();
    return { branch, headDdate, headHash, headCommitMessage, upstreamHash };
  } catch (error) {
    throw new RepoInfoError(error);
  }
}

// Есть ли на машине рабочая команда `mail`. Нет — канал письма молча пропускается.
function hasMailCommand() {
  try {
    execSync('command -v mail', { stdio: 'ignore', shell: '/bin/bash' });
    return true;
  } catch {
    return false;
  }
}

const MARKUP_HTML = {
  '<red>': '<span style="color:#ff0000;">',
  '</red>': '</span>',
  '<y>': '<span style="background-color:#ffff00;">',
  '</y>': '</span>',
  '<g>': '<span style="background-color:#00ff00;">',
  '</g>': '</span>',
  '<r>': '<span style="background-color:#ff0000; color:#ffffff;">',
  '</r>': '</span>',
  '<b>': '<b>',
  '</b>': '</b>',
  '<status>': '',
  '</status>': '',
};

// Пометки отчёта становятся разметкой HTML, а весь прочий текст экранируется, чтобы почта показала его как есть.
const colorizeHTML = (text) =>
  text
    .split(MARKUP_TAG)
    .map((part, index) => (index % 2 ? MARKUP_HTML[part] : escapeMarkup(part)))
    .join('')
    .replace(/\[ERROR]/g, '<span style="color:#ffffff; background-color: #ff0000">[ERROR]</span>');

/** Письмо через системную команду `mail` — запасной канал, когда блок `smtp:` не задан. */
async function sendEmailNotification(emails, status, body, serviceName) {
  if (!emails.length) {
    return;
  }
  if (!hasMailCommand()) {
    logIt('Команда `mail` недоступна — письмо не отправляется');
    return;
  }
  const s = status === 'FAIL' ? '<r>FAIL</r> ' : status === 'SUCCESS' ? '<g>SUCCESS</g> ' : '';
  const hostname = os.hostname();
  const htmlContent = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<title>${status} Update ${serviceName} (on ${hostname})</title></head>
<body><pre>
${colorizeHTML(clearColors(body.replace('<status>', s)))}
</pre></body></html>`;

  for (const emailAddress of emails) {
    try {
      logIt(`Отправка письма о результате обновления: ${emailAddress}`);
      const subject = `${status} Update: ${serviceName} (on ${hostname})`;
      const command = `mail -a "Content-Type: text/html; charset=UTF-8" -s "${subject.replace(/"/g, '\\"')}" "${emailAddress}"`;
      const child = spawn('/bin/bash', ['-lc', command], { stdio: ['pipe', 'inherit', 'inherit'] });
      child.stdin.write(htmlContent);
      child.stdin.end();
      await new Promise((resolve, reject) => {
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mail exit code ${code}`))));
        child.on('error', reject);
      });
    } catch (error) {
      console.error(`Письмо на ${emailAddress} не ушло:`, error.message);
    }
  }
}

/**
 * Письмо по протоколу SMTP через nodemailer — основной канал, когда в `deploy/deploy-config.yml` задан
 * блок `smtp:`. Он не требует почтовой службы на самой машине.
 */
async function sendSmtpNotification(config, status, body, serviceName) {
  const { smtp, emails } = config;
  if (!smtp) {
    return;
  }
  if (!emails.length) {
    logIt('SMTP настроен, но получатели (emails) не заданы — письмо не отправляется');
    return;
  }
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    logIt('SMTP настроен, но пакет nodemailer не установлен — письмо не отправляется');
    return;
  }
  const s = status === 'FAIL' ? '<r>FAIL</r> ' : status === 'SUCCESS' ? '<g>SUCCESS</g> ' : '';
  const hostname = os.hostname();
  const port = Number(smtp.port) || 25;
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"></head><body><pre>
${colorizeHTML(clearColors(body.replace('<status>', s)))}
</pre></body></html>`;
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port,
    secure: port === 465, // 465 — TLS сразу, 587/25 — STARTTLS либо без шифрования
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  try {
    logIt(`Отправка письма по SMTP на ${emails.join(', ')} через ${smtp.host}:${port}`);
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: emails,
      subject: `${status} Update: ${serviceName} (on ${hostname})`,
      html,
    });
  } catch (error) {
    console.error(`SMTP не отправил письмо: ${error.message}`);
  }
}

/** Отправляет сообщение в один чат Телеграма; отказ только печатается и не прерывает обновление. */
function postTelegramMessage(botToken, chatId, text) {
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        timeout: 15000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error(`Телеграм не принял сообщение для чата ${chatId}: HTTP ${res.statusCode}: ${data}`);
          }
          resolve();
        });
      },
    );
    // Недоступный Телеграм не должен подвесить обновление.
    req.on('timeout', () => req.destroy(new Error('превышено время ожидания, 15 с')));
    req.on('error', (error) => {
      console.error(`Сообщение в чат Телеграма ${chatId} не ушло: ${error.message}`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Сообщение о результате обновления в Телеграм — по очереди в каждый чат из `telegram.deployReportBot.chatIds`.
 * Личный чат и группа для Телеграма равноправны: у группы номер просто отрицательный.
 */
async function sendTelegramNotification(config, status, body, serviceName) {
  const { telegramChatIds, telegramBotToken } = config;
  if (!telegramBotToken || !telegramChatIds.length) {
    logIt('Токен бота или чаты получателей не заданы — сообщение в Телеграм не отправляется');
    return;
  }

  const hostname = os.hostname();
  const icon = status === 'SUCCESS' ? '✅' : '❌';
  let raw = `${icon} ${status} — ${serviceName} @ ${hostname}\n\n${clearColors(clearHtmlColors(body))}`;
  // Одно сообщение Телеграма ограничено 4096 знаками; оставляем запас на рамку блока кода.
  if (raw.length > 3800) {
    raw = `${raw.slice(0, 3800)}\n…(обрезано)`;
  }
  // Внутри блока кода MarkdownV2 особыми остаются только обратная косая черта и обратный апостроф.
  const fenced = '```\n' + raw.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '\n```';

  for (const chatId of telegramChatIds) {
    logIt(`Отправка сообщения о результате обновления в чат Телеграма ${chatId}`);
    await postTelegramMessage(telegramBotToken, chatId, fenced);
  }
}

/** Рассылает итог по всем настроенным каналам; ненастроенный канал молча пропускается. */
async function sendNotifications(config, status, body, serviceName) {
  if (config.smtp) {
    await sendSmtpNotification(config, status, body, serviceName);
  } else {
    await sendEmailNotification(config.emails, status, body, serviceName);
  }
  await sendTelegramNotification(config, status, body, serviceName);
}

/**
 * Печатает, на чём стоит рабочая копия. Когда обновление действительно приезжает, этот снимок
 * появляется в отчёте дважды — до и после, — и раньше оба выглядели одинаково, так что различить их
 * можно было только по порядку следования. Снимок, который вот-вот сменится, подписан «предыдущий».
 */
const printCurrentBranch = ({ previous = false } = {}) => {
  const i = getRepoInfo();
  const message = colorG.lg(escapeMarkup(i.headCommitMessage));
  logIt(`Текущая ветка: ${colorG.lg(i.branch)}
${previous ? 'Предыдущий коммит' : 'Последний коммит'}: ${colorG.lg(i.headHash)}, дата: ${colorG.lg(i.headDdate)}
${previous ? `Предыдущее сообщение коммита: ${message}` : `Применён коммит: <b>${message}</b>`}`);
  return i;
};

/**
 * Ставит зависимости начисто. Берём `npm ci`: он ставит ровно то, что записано в
 * `package-lock.json`, и сам сносит прежний `node_modules`.
 */
const reinstallDependencies = () => {
  logIt('УСТАНОВКА ЗАВИСИМОСТЕЙ', true);
  execCommand('npm ci --no-audit --no-fund');
  logIt('Зависимости установлены');
};

// Особенности проекта для общего навыка развёртывания. Раздел `update` — шаги автообновления после установки
// зависимостей (например, докачать браузер под новую версию playwright).
const PROJECT_FILE = path.join(CWD, '.agents', 'skills', 'deploy', 'project.yaml');

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Подставляет в команду шага значения `{{local.<путь>}}` из `config/local.yaml` (например, каталог файлов
 * службы `{{local.files.dir}}`), чтобы пути не дублировались в описании проекта.
 */
const expandStep = (run) => {
  let local;
  return run.replace(/\{\{local\.([\w.]+)\}\}/g, (_, key) => {
    local ??= YAML.parse(fs.readFileSync(path.join(CWD, 'config', 'local.yaml'), 'utf8')) || {};
    const value = key.split('.').reduce((node, part) => node?.[part], local);
    if (value === undefined || value === null || value === '') {
      throw new Error(`В config/local.yaml нет значения ${key}, нужного шагу из project.yaml`);
    }
    return shellQuote(value);
  });
};

const runProjectUpdateSteps = () => {
  if (!fs.existsSync(PROJECT_FILE)) {
    return;
  }
  const steps = (YAML.parse(fs.readFileSync(PROJECT_FILE, 'utf8')) || {}).update || [];
  for (const step of steps) {
    logIt(String(step.title).toUpperCase(), true);
    execCommand(expandStep(step.run));
    logIt('Готово');
  }
};

/**
 * Прогоняет миграции всех баз проекта (`npm run migrate`) при остановленной службе: новый код почти всегда
 * рассчитывает на новую схему, а прежний процесс во время миграции продолжал бы писать в таблицы по старой схеме.
 */
const migrateDatabases = () => {
  const out = String(execCommand('npm run --silent migrate')).trim();
  // Схема почти всегда уже накатана, и команда в этом случае молчит. Раздел с заголовком заводится
  // только когда что-то действительно применилось: пустая рубрика «миграций нет» в отчёте о сборке
  // занимала место и не сообщала ничего.
  if (!out) {
    return;
  }
  logIt('МИГРАЦИИ БАЗ ДАННЫХ', true);
  logIt(out);
};

// Штатная остановка службы даёт процессу завершить запись в базы, поэтому после неё прежний код больше ничего не
// пишет в таблицы и миграция идёт без параллельных писателей.
const stopService = (serviceUnit) => {
  if (!systemctlServiceExists(serviceUnit)) {
    logIt(`Служба ${serviceUnit} в systemd не найдена — останавливать нечего`);
    return false;
  }
  logIt(`ОСТАНОВКА СЛУЖБЫ ${serviceUnit}`, true);
  execCommand(`systemctl stop "${serviceUnit}"`);
  return true;
};

const startService = (serviceUnit) => {
  execCommand(`systemctl start "${serviceUnit}"`);
  logIt('Служба запущена');
};

async function main() {
  const { serviceName, serviceUnit } = getServiceName();
  console.log(`Update script version: ${versionDate}-${serviceName}`);

  logTryUpdate();
  fs.writeFileSync(runTimeLogFile, '');
  const args = parseArgs();

  if (args.help) {
    showHelp();
    return;
  }

  logIt(`<status>Обновление <y>${colorG.y(serviceName)}</y> ${nowPretty()}`);
  logIt(`Каталог проекта: ${colorG.y(CWD)}`);

  const config = loadConfig();
  resolveNode(config.nodeVersion);

  const expectedBranch = args.expectedBranch || config.branch;
  let updateDeployedLogFile = false;
  try {
    // 1) Правки, сделанные на сервере руками, отбрасываем.
    if (execCommand('git status --porcelain').trim().length > 0) {
      logIt('Найдены незакоммиченные изменения. Сброс к HEAD…');
      execCommand('git reset --hard HEAD');
      execCommand('git clean -fd');
    }

    let needUpdate = false;
    let updateReason = args.force ? 'принудительно (--force)' : '';
    let repoInfo;
    try {
      repoInfo = getRepoInfo();
      const previousGitFailure = clearGitFailureState();
      if (previousGitFailure?.notified) {
        writeStatus('SUCCESS', 'доступ к репозиторию восстановился');
      }
    } catch (error) {
      if (!(error instanceof RepoInfoError)) {
        throw error;
      }
      const failureState = recordGitFailure(error);
      if (failureState.count < GIT_FAILURE_NOTIFICATION_THRESHOLD) {
        logIt(
          `Проверка репозитория не удалась (${failureState.count} из ${GIT_FAILURE_NOTIFICATION_THRESHOLD}). Следующая проверка повторит попытку без тревожного сообщения.`,
        );
        return;
      }
      if (failureState.notified) {
        logIt('Репозиторий по-прежнему недоступен. О длящейся неполадке уже сообщено.');
        return;
      }
      markGitFailureNotified(failureState);
      throw new Error(
        `Проверка репозитория не удалась ${failureState.count} раз подряд начиная с ${failureState.firstFailureAt}.\n${formatError(error)}`,
      );
    }
    let { branch, headHash, upstreamHash } = repoInfo;

    // 2) Рабочая копия сидит не на той ветке — жёстко переводим её на нужную.
    const expectedUpstream = `origin/${expectedBranch}`;
    if (branch !== expectedBranch) {
      needUpdate = true;
      updateReason += `${updateReason ? '. ' : ''}ветка не та (${branch} вместо ${expectedBranch})`;
      logIt(`Переход на ветку ${expectedBranch}…`);
      execCommand(`git fetch origin ${expectedBranch} --prune`);
      execCommand(`git checkout -B ${expectedBranch} ${expectedUpstream}`);
      execCommand(`git reset --hard ${expectedUpstream}`);
      execCommand('git clean -fd');
      ({ branch, headHash, upstreamHash } = printCurrentBranch());
      if (branch !== expectedBranch) {
        throw new Error(`Не удалось перейти на ветку ${expectedBranch}`);
      }
    }

    // 3) Ветка та, но в ней появились новые коммиты.
    if (headHash !== upstreamHash) {
      needUpdate = true;
      const commits = `копия на ${headHash.slice(0, 7)}, ветка на ${upstreamHash.slice(0, 7)}`;
      updateReason += `${updateReason ? '. ' : ''}появились новые коммиты (${commits})`;
      printCurrentBranch({ previous: true });
      logIt(`НАЙДЕНЫ ИЗМЕНЕНИЯ. Обновление ветки ${expectedBranch}…`);
      execCommand(`git fetch origin ${expectedBranch} --prune`);
      execCommand(`git checkout -B ${expectedBranch} ${expectedUpstream}`);
      execCommand(`git reset --hard ${expectedUpstream}`);
      execCommand('git clean -fd');
      printCurrentBranch();
    }

    if (needUpdate || args.force) {
      updateDeployedLogFile = true;
      logTryUpdate(updateReason);
      reinstallDependencies();
      runProjectUpdateSteps();
      const stopped = stopService(serviceUnit);
      // При ошибке миграции служба должна оставаться остановленной: новый код не может безопасно работать со старой
      // структурой базы. Общая обработка ошибки сохранит причину и отправит уведомление о неудачном обновлении.
      migrateDatabases();
      if (stopped) {
        startService(serviceUnit);
      }
      logIt(`Обновление завершено успешно ${nowPretty()}`);
      writeStatus('SUCCESS', updateReason || 'обновление завершено');
      await sendNotifications(config, 'SUCCESS', logBuffer, serviceName);
    } else {
      logIt('Изменений нет. Обновление пропущено.');
      writeStatus('SUCCESS', 'проверка выполнена, изменений нет');
    }
  } catch (err) {
    const message = formatError(err);
    logError(message);
    writeStatus('FAIL', message);
    await sendNotifications(config, 'FAIL', logBuffer, serviceName);
  } finally {
    logIt('#FINISH#');
    if (updateDeployedLogFile) {
      fs.copyFileSync(runTimeLogFile, lastDeployLogFile);
    }
    try {
      fs.unlinkSync(runTimeLogFile);
    } catch {
      /* файл мог не создаться */
    }
  }
}

process.on('SIGINT', () => {
  console.log('\nОбновление прервано');
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\nОбновление остановлено');
  process.exit(1);
});

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`${new Date().toISOString()} Обновление не удалось: ${error.stack || error.message}`);
    process.exit(1);
  });
