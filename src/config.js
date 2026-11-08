// Настройки приложения: config/local.yaml (образец — .agents/skills/deploy/config/local.example.yaml).
// На сервере этот файл кладёт навык развёртывания из .agents/skills/deploy/config/local.yaml.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

function required(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`В config/local.yaml не задано обязательное поле ${name}`);
  }
  return value;
}

/** Разбирает и проверяет настройки. Пути данных считаются от корня проекта, если заданы относительно. */
export function parseConfig(raw) {
  const c = raw || {};
  const tg = c.telegram || {};
  const rec = c.recognition || {};
  const notes = c.notes || {};
  const data = c.data || {};
  const web = c.webServer || {};

  const dataDir = path.resolve(PROJECT_ROOT, data.dir || '_data');
  const allowed = []
    .concat(required(tg.allowedUserIds, 'telegram.allowedUserIds'))
    .flatMap((v) => String(v).split(','))
    .map((v) => Number(v.trim()))
    .filter(Boolean);

  return {
    webServer: {
      host: web.host || '127.0.0.1',
      port: Number(required(web.port, 'webServer.port')),
    },
    telegram: {
      botToken: required(tg.botToken, 'telegram.botToken'),
      allowedUserIds: allowed,
      publicUrl: String(tg.publicUrl || '').replace(/\/+$/, ''),
      // Сколько секунд подпись Mini App считается свежей.
      initDataMaxAgeSec: Number(tg.initDataMaxAgeSec || 24 * 3600),
    },
    recognition: {
      oauthToken: required(rec.oauthToken, 'recognition.oauthToken'),
      model: rec.model || 'opus',
      timeoutSec: Number(rec.timeoutSec || 600),
      maxPhotos: Number(rec.maxPhotos || 30),
    },
    notes: {
      repoUrl: required(notes.repoUrl, 'notes.repoUrl'),
      branch: notes.branch || 'main',
      sshKeyPath: notes.sshKeyPath || '',
      authorName: notes.authorName || 'textrec-bot',
      authorEmail: notes.authorEmail || 'textrec-bot@users.noreply.github.com',
    },
    data: {
      dir: dataDir,
      jobsDir: path.join(dataDir, 'jobs'),
      notesDir: path.join(dataDir, 'notes'),
      claudeConfigDir: path.join(dataDir, 'claude-config'),
      photoRetentionDays: Number(data.photoRetentionDays || 30),
    },
  };
}

export function loadConfig(file = path.join(PROJECT_ROOT, 'config', 'local.yaml')) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `Не найден ${file}. Скопируйте .agents/skills/deploy/config/local.example.yaml в config/local.yaml и заполните.`,
    );
  }
  return parseConfig(YAML.parse(fs.readFileSync(file, 'utf8')));
}
