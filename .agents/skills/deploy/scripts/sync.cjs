#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Синхронизация общего навыка развёртывания с эталоном.
//
// Навык развёртывания одинаков во всех проектах. Его общие файлы (список COMMON ниже) хранятся в одном месте —
// хранилище git на сервере (раздел skillSource в config/deploy.local.yaml), а в каждом проекте лежит их копия.
// Особенности проекта (project.yaml, PROJECT.md, config/local.example.yaml) и файлы с секретами общими не
// считаются и эталоном не трогаются.
//
// В файле .agents/skills/deploy/.sync-base записан коммит эталона, с которого сделана копия проекта. По нему
// команда понимает, кто менял файл: проект (правку нужно отправить в эталон), эталон (свежую версию нужно
// забрать) или оба (правки нужно свести руками).
//
//   node sync.cjs status            сравнить общие файлы проекта с эталоном
//   node sync.cjs pull              забрать из эталона файлы, обновлённые там и не тронутые в проекте
//   node sync.cjs push -m "<что>"   отправить в эталон правки общих файлов, сделанные в этом проекте
//   node sync.cjs init              завести эталон на сервере из общих файлов этого проекта (один раз)
//
// После pull и push изменённые файлы проекта нужно закоммитить вместе с .sync-base.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.join(__dirname, '..');
const PROJECT_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');
const DEPLOY_FILE = path.join(SKILL_DIR, 'config', 'deploy.local.yaml');
const BASE_FILE = path.join(SKILL_DIR, '.sync-base');
const YAML = require(require.resolve('yaml', { paths: [PROJECT_ROOT] }));

// Общие файлы навыка — пути от корня проекта, одинаковые в проекте и в эталоне.
const COMMON = [
  'update.cjs',
  '.agents/skills/deploy/SKILL.md',
  '.agents/skills/deploy/README.md',
  '.agents/skills/deploy/scripts/remote.cjs',
  '.agents/skills/deploy/scripts/srv.cjs',
  '.agents/skills/deploy/scripts/sync.cjs',
  '.agents/skills/deploy/assets/nginx/site.conf',
  '.agents/skills/deploy/assets/nginx/proxy.conf',
  '.agents/skills/deploy/config/.gitignore',
  '.agents/skills/deploy/config/deploy.example.yaml',
];

function fail(msg) {
  console.error(`\x1b[1;31m[sync][ОШИБКА]\x1b[0m ${msg}`);
  process.exit(1);
}
function say(msg) {
  console.log(`\x1b[1;36m[sync]\x1b[0m ${msg}`);
}

function loadSource() {
  if (!fs.existsSync(DEPLOY_FILE)) fail(`Настройки не найдены: ${DEPLOY_FILE}`);
  const cfg = YAML.parse(fs.readFileSync(DEPLOY_FILE, 'utf8')) || {};
  const server = cfg.server || {};
  const src = cfg.skillSource || {};
  const pick = (name) => src[name] || server[name];
  const source = {
    host: pick('host'),
    port: pick('port') || 22,
    user: pick('user'),
    keyPath: pick('keyPath'),
    repo: src.repo,
  };
  for (const [name, value] of Object.entries(source)) {
    if (!value) fail(`Не задано ${name} эталона: раздел skillSource (или server) в config/deploy.local.yaml`);
  }
  return source;
}

function sshArgs(source) {
  return ['-i', source.keyPath, '-p', String(source.port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'];
}

function gitEnv(source) {
  const quoted = sshArgs(source).map((a) => (/[\s"]/.test(a) ? `"${a}"` : a));
  return { ...process.env, GIT_SSH_COMMAND: `ssh ${quoted.join(' ')}` };
}

function git(args, { cwd, env, allowFail = false } = {}) {
  const res = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8' });
  if (res.error) fail(`не удалось запустить git: ${res.error.message}`);
  if (res.status !== 0 && !allowFail) fail(`git ${args.join(' ')}: ${(res.stderr || res.stdout).trim()}`);
  return res;
}

function repoUrl(source) {
  return `ssh://${source.user}@${source.host}:${source.port}${source.repo}`;
}

// Временная копия эталона; удаляется при выходе из процесса.
function cloneSource(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-skill-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  git(['clone', '--quiet', repoUrl(source), dir], { env: gitEnv(source) });
  const head = git(['rev-parse', 'HEAD'], { cwd: dir, allowFail: true });
  return { dir, head: head.status === 0 ? head.stdout.trim() : '' };
}

const normalize = (text) => (text === null ? null : text.replace(/\r\n/g, '\n'));

function readLocal(file) {
  const full = path.join(PROJECT_ROOT, file);
  return fs.existsSync(full) ? normalize(fs.readFileSync(full, 'utf8')) : null;
}

function readAt(dir, rev, file) {
  if (!rev) return null;
  const res = git(['show', `${rev}:${file}`], { cwd: dir, allowFail: true });
  return res.status === 0 ? normalize(res.stdout) : null;
}

function readBase() {
  return fs.existsSync(BASE_FILE) ? fs.readFileSync(BASE_FILE, 'utf8').trim() : '';
}

function writeBase(hash) {
  fs.writeFileSync(BASE_FILE, `${hash}\n`);
}

// Состояние каждого общего файла относительно эталона и коммита, с которого сделана копия.
function compare(clone) {
  const base = readBase();
  const baseKnown = base && git(['cat-file', '-e', `${base}^{commit}`], { cwd: clone.dir, allowFail: true }).status === 0;
  return COMMON.map((file) => {
    const local = readLocal(file);
    const ref = readAt(clone.dir, clone.head, file);
    const old = baseKnown ? readAt(clone.dir, base, file) : null;
    let state;
    if (local === ref) state = 'same';
    else if (!baseKnown) state = 'conflict';
    else if (local === old) state = 'theirs';
    else if (ref === old) state = 'ours';
    else state = 'conflict';
    return { file, state, local, ref };
  });
}

const LABEL = {
  same: 'совпадает с эталоном',
  ours: 'изменён в проекте — отправьте в эталон: sync.cjs push -m "<что изменено>"',
  theirs: 'обновлён в эталоне — заберите: sync.cjs pull',
  conflict: 'изменён и в проекте, и в эталоне — сведите правки руками, затем push',
};

function printReport(rows) {
  for (const row of rows) console.log(`  ${row.state === 'same' ? '✓' : '•'} ${row.file} — ${LABEL[row.state]}`);
}

function cmdStatus(source) {
  const clone = cloneSource(source);
  say(`Эталон ${repoUrl(source)}, коммит ${clone.head.slice(0, 7) || '(пусто)'}; копия проекта от ${readBase().slice(0, 7) || '(не записано)'}`);
  printReport(compare(clone));
}

function cmdPull(source) {
  const clone = cloneSource(source);
  const rows = compare(clone);
  const conflicts = rows.filter((r) => r.state === 'conflict');
  if (conflicts.length) {
    printReport(conflicts);
    fail('Есть файлы, изменённые и в проекте, и в эталоне. Сведите правки руками (эталон: sync.cjs status), затем push.');
  }
  const taken = rows.filter((r) => r.state === 'theirs');
  for (const row of taken) {
    const full = path.join(PROJECT_ROOT, row.file);
    if (row.ref === null) {
      fs.rmSync(full, { force: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, row.ref);
    }
    console.log(`  ← ${row.file}`);
  }
  writeBase(clone.head);
  rows.filter((r) => r.state === 'ours').forEach((r) => console.log(`  • ${r.file} — ${LABEL.ours}`));
  say(taken.length ? `Забрано файлов: ${taken.length}. Закоммитьте их вместе с .sync-base.` : 'Забирать нечего.');
}

function cmdPush(source, args) {
  const idx = args.indexOf('-m');
  const message = idx >= 0 ? args[idx + 1] : '';
  if (!message) fail('Укажите, что изменено: node sync.cjs push -m "<описание правки>"');
  const clone = cloneSource(source);
  const rows = compare(clone);
  const blocked = rows.filter((r) => r.state === 'theirs' || r.state === 'conflict');
  if (blocked.length) {
    printReport(blocked);
    fail('Эталон ушёл вперёд. Сначала выполните sync.cjs pull (и сведите конфликты), затем повторите push.');
  }
  const ours = rows.filter((r) => r.state === 'ours');
  if (!ours.length) return say('Отправлять нечего: общие файлы проекта совпадают с эталоном.');
  for (const row of ours) {
    const full = path.join(clone.dir, row.file);
    if (row.local === null) {
      fs.rmSync(full, { force: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, row.local);
    }
    console.log(`  → ${row.file}`);
  }
  commitAndPush(source, clone.dir, `${message}\n\nИз проекта ${path.basename(PROJECT_ROOT)}`);
}

function commitAndPush(source, dir, message) {
  git(['add', '-A'], { cwd: dir });
  git(['commit', '--quiet', '-m', message], { cwd: dir });
  git(['push', '--quiet', 'origin', 'HEAD:master'], { cwd: dir, env: gitEnv(source) });
  const head = git(['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();
  writeBase(head);
  say(`Эталон обновлён до ${head.slice(0, 7)}. Закоммитьте .sync-base в проекте.`);
}

// Заводит пустое хранилище на сервере и кладёт в него общие файлы этого проекта первым коммитом.
function cmdInit(source) {
  const script = `set -e
if [ -d ${source.repo}/refs ]; then echo EXISTS; exit 0; fi
git init --quiet --bare --initial-branch=master ${source.repo} && echo CREATED`;
  const res = spawnSync('ssh', [...sshArgs(source), `${source.user}@${source.host}`, script], { encoding: 'utf8' });
  if (res.status !== 0) fail(`не удалось завести хранилище на сервере: ${(res.stderr || res.stdout).trim()}`);
  const clone = cloneSource(source);
  if (clone.head) fail(`Эталон ${repoUrl(source)} уже заведён (коммит ${clone.head.slice(0, 7)}). Пользуйтесь status, pull и push.`);
  for (const file of COMMON) {
    const local = readLocal(file);
    if (local === null) fail(`В проекте нет общего файла ${file}`);
    const full = path.join(clone.dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, local);
  }
  fs.writeFileSync(
    path.join(clone.dir, 'README.md'),
    `# Эталон общего навыка развёртывания

Здесь хранятся общие для всех проектов файлы навыка \`.agents/skills/deploy\` и автообновления \`update.cjs\` — по
тем же путям, что в проекте. Напрямую сюда не коммитят: правку делают в любом проекте и отправляют командой
\`node .agents/skills/deploy/scripts/sync.cjs push -m "<что изменено>"\`, а остальные проекты забирают её командой
\`sync.cjs pull\`. Описание — в \`.agents/skills/deploy/SKILL.md\`.
`,
  );
  commitAndPush(source, clone.dir, `Эталон навыка развёртывания\n\nИз проекта ${path.basename(PROJECT_ROOT)}`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const source = loadSource();
  switch (cmd) {
    case 'status':
      return cmdStatus(source);
    case 'pull':
      return cmdPull(source);
    case 'push':
      return cmdPush(source, rest);
    case 'init':
      return cmdInit(source);
    default:
      console.log(`Синхронизация общего навыка развёртывания с эталоном — команды:
  status            Сравнить общие файлы проекта с эталоном
  pull              Забрать из эталона файлы, обновлённые там и не тронутые в проекте
  push -m "<что>"   Отправить в эталон правки общих файлов, сделанные в этом проекте
  init              Завести эталон на сервере из общих файлов этого проекта (один раз)`);
      if (cmd && cmd !== 'help') process.exit(1);
  }
}

main();
