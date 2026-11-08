#!/usr/bin/env node

/**
 * srv.cjs — установка, удаление и переустановка службы systemd для этого проекта.
 *
 * Скрипт работает НА СЕРВЕРЕ и делает ровно одно: превращает каталог с проектом в постоянно
 * работающую службу Linux, которая поднимается при загрузке машины и сама встаёт обратно после
 * падения. Имя службы, версия Node.js и путь к точке входа не задаются руками — они вычитываются
 * из самого проекта (`package.json`, `.env`, `.envrc`), поэтому одна и та же команда даёт
 * одинаковый результат на любой машине.
 *
 * Запуск (из корня проекта):
 *   node .agents/skills/deploy/scripts/srv.cjs install     — поставить и запустить службу
 *   node .agents/skills/deploy/scripts/srv.cjs delete      — остановить и удалить службу
 *   node .agents/skills/deploy/scripts/srv.cjs reinstall   — переустановить и показать журнал
 */
const version = '2026-09-10';

/* Цвета вывода */
const c = '\x1b[1;36m',
  lc = '\x1b[0;36m';
const g = '\x1b[1;32m';
const m = '\x1b[1;35m';
const r = '\x1b[1;31m';
const y = '\x1b[1;33m';
const c0 = '\x1b[0m';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..');
process.chdir(PROJECT_ROOT);

let SERVICE_NAME = '';
let NODE_VERSION = '';
let PORT = '';
let COMMAND = '';

const trim = (v) => String(v || '').trim();

function log(...args) {
  console.log(...args);
}

function err(...args) {
  console.error(...args);
}

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    const errObj = new Error(stderr || stdout || e.message);
    errObj.code = e.status;
    throw errObj;
  }
}

function showUsage() {
  log(
    `
srv.cjs ${version}

Использование:
  node .agents/skills/deploy/scripts/srv.cjs i|install   [-n <имя службы>] [-v <версия node>]
  node .agents/skills/deploy/scripts/srv.cjs d|delete    [-n <имя службы>] [-p <порт>]
  node .agents/skills/deploy/scripts/srv.cjs r|reinstall [-n <имя службы>] [-p <порт>] [-v <версия node>]

Команды:
  i, install    — поставить и запустить службу systemd
  d, delete     — остановить и удалить службу
  r, reinstall  — переустановить (удалить + поставить) и показать журнал

Доводы:
  -n <имя>      — другое имя службы (по умолчанию из .env / package.json)
  -v <версия>   — версия Node.js (по умолчанию из .envrc)
  -p <порт>     — порт для добивания зависшего процесса при удалении (по умолчанию из config/)

Каталоги:
  Скрипт:        ${SCRIPT_DIR}
  Корень проекта: ${PROJECT_ROOT}
`.trim(),
  );
}

function serviceExists(name) {
  try {
    const out = sh(`systemctl list-units --all -t service --full --no-legend ${name}.service`, { shell: '/bin/bash' });
    return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.service\\b`).test(out);
  } catch {
    return false;
  }
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Версия Node.js: довод `-v`, затем строка `nvm use X.Y.Z` из `.envrc`, затем текущая. */
function detectNodeVersion() {
  let ver = '';
  if (NODE_VERSION) {
    ver = NODE_VERSION;
    err(`${c}**** Версия Node.js задана доводом: ${g}${ver}${c} ****${c0}`);
  } else {
    const envrc = path.join(PROJECT_ROOT, '.envrc');
    if (fs.existsSync(envrc)) {
      const mm = readFileSafe(envrc).match(/^\s*nvm\s+use\s+([0-9]+\.[0-9]+\.[0-9]+)/m);
      if (mm) {
        ver = mm[1];
        err(`${c}**** Версия Node.js из .envrc: ${g}${ver}${c} ****${c0}`);
      }
    }
  }
  if (!ver) {
    try {
      ver = sh('node -v 2>/dev/null', { shell: '/bin/bash' }).replace(/^v/, '');
      if (ver) {
        err(`${c}**** Взята текущая версия Node.js: ${g}${ver}${c} ****${c0}`);
      }
    } catch {
      /* ниже будет отказ */
    }
  }
  if (!ver) {
    err(`${r}**** Ошибка: не удалось определить версию Node.js ****${c0}`);
    process.exit(1);
  }
  return ver;
}

/** Полный путь к двоичному файлу node нужной версии: сначала установка nvm, потом системный node. */
function findNodePath(ver) {
  const nvmPath = path.join(os.homedir(), '.nvm', 'versions', 'node', `v${ver}`, 'bin', 'node');
  if (fs.existsSync(nvmPath)) {
    err(`${c}**** Node.js найден в nvm: ${g}${nvmPath}${c} ****${c0}`);
    return nvmPath;
  }
  try {
    const whichNode = sh('which node 2>/dev/null', { shell: '/bin/bash' });
    if (whichNode) {
      let currentVersion = '';
      try {
        currentVersion = sh('node -v 2>/dev/null', { shell: '/bin/bash' }).replace(/^v/, '');
      } catch {
        /* не важно */
      }
      if (currentVersion === ver) {
        err(`${c}**** Node.js найден в системе: ${g}${whichNode}${c} ****${c0}`);
      } else {
        err(`${y}**** Внимание: системная версия Node.js (${currentVersion}) отличается от нужной (${ver}) ****${c0}`);
        err(`${c}**** Всё равно берём системный путь: ${g}${whichNode}${c} ****${c0}`);
      }
      return whichNode;
    }
  } catch {
    /* ниже будет отказ */
  }
  err(`${r}**** Ошибка: двоичный файл node не найден ****${c0}`);
  process.exit(1);
}

function parsePackageJson(field) {
  const packageFile = path.join(PROJECT_ROOT, 'package.json');
  if (!fs.existsSync(packageFile)) {
    err(`${r}**** Ошибка: package.json не найден: ${packageFile} ****${c0}`);
    process.exit(1);
  }
  try {
    const value = JSON.parse(fs.readFileSync(packageFile, 'utf8'))[field] || '';
    if (!value) throw new Error('пусто');
    return value;
  } catch {
    err(`${r}**** Ошибка: в package.json не прочитано поле ${field} ****${c0}`);
    process.exit(1);
  }
}

/** Разбор `.env` в корне проекта — оттуда берутся SERVICE_NAME и SERVICE_INSTANCE. */
function parseDotEnvVars() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  for (const line of readFileSafe(envPath).split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const mm = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!mm) continue;
    let val = mm[2];
    const q = val[0];
    if ((q === '"' || q === "'") && val[val.length - 1] === q) {
      val = val.slice(1, -1);
    }
    result[mm[1]] = val;
  }
  return result;
}

/**
 * Имя службы: довод `-n`, иначе SERVICE_NAME из `.env`, иначе имя из `package.json`; к основе
 * добавляется `--<экземпляр>` из SERVICE_INSTANCE. Ровно та же логика в `update.cjs`.
 */
function getServiceName() {
  const fromArg = trim(SERVICE_NAME);
  if (fromArg) {
    return fromArg;
  }
  const envVars = parseDotEnvVars();
  const baseName = trim(envVars.SERVICE_NAME) || parsePackageJson('name');
  const rawInstance = trim(envVars.SERVICE_INSTANCE);
  return `${baseName}${rawInstance ? `--${rawInstance}` : ''}`;
}

/**
 * Порт, на котором слушает приложение. Берётся из настроек проекта (`config/` пакета `config`,
 * ключ `webServer.port`) — там же, где его читает само приложение. Нужен только при удалении службы,
 * чтобы добить процесс, переживший остановку.
 */
function detectPort() {
  if (PORT) return PORT;
  try {
    const projectRequire = require('module').createRequire(path.join(PROJECT_ROOT, 'package.json'));
    const cfg = projectRequire('config');
    const port = cfg?.webServer?.port;
    if (port && String(port).match(/^[0-9]{2,5}$/)) return String(port);
  } catch {
    /* ниже будет отказ */
  }
  err(`${r}**** Ошибка: не удалось определить порт из настроек ****${c0}`);
  process.exit(1);
}

/**
 * Пишет файл юнита systemd.
 *
 * `EnvironmentFile` подключает `.env` проекта: там задаётся имя службы.
 * `Restart=always` со `StartLimitIntervalSec=0` означает «поднимать всегда, сколько бы раз ни
 * падало»: служба должна переживать разовые сбои без участия человека.
 */
function generateUnitFile(serviceName, nodePath, mainFile) {
  const serviceFile = `/etc/systemd/system/${serviceName}.service`;
  const content = `[Unit]
Description=${serviceName}
After=network.target postgresql.service
StartLimitIntervalSec=0

[Service]
User=root
WorkingDirectory=${PROJECT_ROOT}
EnvironmentFile=${PROJECT_ROOT}/.env
ExecStart=${nodePath} ${mainFile}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
  fs.writeFileSync(serviceFile, content, 'utf8');
  err(
    `
${c}**** Файл юнита для ${g}${serviceName}${c} записан ****${c0}
${lc}   WorkingDirectory: ${g}${PROJECT_ROOT}${c0}
${lc}   ExecStart: ${g}${nodePath} ${mainFile}${c0}
${lc}   Посмотреть: ${g}cat ${serviceFile}${c0}
`.trim(),
  );
}

function installService() {
  log(`${c}**** Установка службы ****${c0}`);
  const ver = detectNodeVersion();
  const nodePath = findNodePath(ver);
  const mainFile = parsePackageJson('main');
  const serviceName = getServiceName();

  err(
    `
${c}**** Настройки службы ****${c0}
${lc}   Имя службы: ${g}${serviceName}${c0}
${lc}   Версия Node.js: ${g}${ver}${c0}
${lc}   Путь к node: ${g}${nodePath}${c0}
${lc}   Точка входа: ${g}${mainFile}${c0}
${lc}   Корень проекта: ${g}${PROJECT_ROOT}${c0}
`.trim(),
  );

  if (serviceExists(serviceName)) {
    err(`${c}**** Служба ${g}${serviceName}${c} уже установлена ****${c0}`);
    return;
  }

  generateUnitFile(serviceName, nodePath, mainFile);

  sh('systemctl daemon-reload');
  try {
    sh(`systemctl enable --now ${serviceName}`);
  } catch (e) {
    err(`${r}**** Ошибка: службу ${serviceName} установить не удалось ****${c0}\n${e.message || String(e)}`);
    process.exit(1);
  }

  log(
    `
${c}**** Служба ${g}${serviceName}${c} установлена и запущена ****${c0}

${m}Состояние: ${y}systemctl -l status ${serviceName}${c0}
${m}Журнал:    ${y}journalctl -o cat -xefu ${serviceName}${c0}
`.trim(),
  );
}

function deleteService() {
  const serviceName = getServiceName();
  const port = detectPort();
  log(`${c}**** Удаление службы ${g}${serviceName}${c}, порт ${g}${port}${c} ****${c0}`);

  if (!serviceExists(serviceName)) {
    log(`${c}**** Служба ${g}${serviceName}${c} не найдена ****${c0}`);
    return;
  }

  try {
    sh(`systemctl stop ${serviceName}`);
  } catch {
    /* уже остановлена */
  }
  try {
    sh(`systemctl disable ${serviceName}`);
  } catch {
    /* уже выключена */
  }
  try {
    fs.unlinkSync(`/etc/systemd/system/${serviceName}.service`);
  } catch {
    /* уже удалён */
  }

  // Процесс, переживший остановку, продолжал бы держать порт — добиваем его.
  try {
    const pid = sh(`lsof -i tcp:${port} 2>/dev/null | grep ${port} | awk '{print $2}' | head -1`, {
      shell: '/bin/bash',
    });
    if (pid) {
      log(`${c}**** Добиваем процесс ${g}${pid}${c} на порту ${g}${port}${c} ****${c0}`);
      try {
        sh(`kill -9 ${pid}`);
      } catch {
        /* уже умер */
      }
    }
  } catch {
    /* lsof может отсутствовать */
  }

  try {
    sh('systemctl daemon-reload');
  } catch {
    /* не критично */
  }
  log(`${c}**** Служба ${g}${serviceName}${c} удалена ****${c0}`);
}

async function reinstallService() {
  log(`${c}**** Переустановка службы ****${c0}`);
  deleteService();
  installService();
  const serviceName = getServiceName();
  log(`${c}**** Служба ${g}${serviceName}${c} переустановлена ****${c0}`);
  try {
    log(sh(`systemctl status ${serviceName}`));
  } catch (e) {
    log(e.message);
  }
  log(`\n${m}Журнал (Ctrl+C для выхода): ${y}journalctl -o cat -xefu ${serviceName}${c0}`);
  const p = spawn('journalctl', ['-o', 'cat', '-xefu', serviceName], { stdio: 'inherit' });
  await new Promise((resolve) => p.on('exit', resolve));
}

async function main() {
  if (process.argv.length <= 2) {
    showUsage();
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const cmd = args.shift();
  switch (cmd) {
    case 'i':
    case 'install':
      COMMAND = 'install';
      break;
    case 'd':
    case 'delete':
      COMMAND = 'delete';
      break;
    case 'r':
    case 'reinstall':
      COMMAND = 'reinstall';
      break;
    default:
      err(`${r}**** Ошибка: неизвестная команда «${cmd}» ****${c0}`);
      showUsage();
      process.exit(1);
  }

  while (args.length > 0) {
    const a = args.shift();
    switch (a) {
      case '-n':
        SERVICE_NAME = args.shift() || '';
        break;
      case '-v':
        NODE_VERSION = args.shift() || '';
        break;
      case '-p':
        PORT = args.shift() || '';
        break;
      default:
        err(`${r}**** Ошибка: неизвестный довод «${a}» ****${c0}`);
        showUsage();
        process.exit(1);
    }
  }

  switch (COMMAND) {
    case 'install':
      installService();
      break;
    case 'delete':
      deleteService();
      break;
    case 'reinstall':
      await reinstallService();
      break;
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    err(String(e && e.message ? e.message : e));
    process.exit(1);
  });
