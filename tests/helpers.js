import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signInitData } from '../src/telegram-auth.js';

export const BOT_TOKEN = '123456:TEST-token';
export const USER_ID = 42;

export function tmpDir(prefix = 'textrec-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Пустой «удалённый» репозиторий (голый, как на GitHub) и путь к нему. */
export function bareRepo(root) {
  const dir = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  return dir;
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Строка initData, подписанная как настоящий Telegram. */
export function initData({ userId = USER_ID, authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN } = {}) {
  const fields = { auth_date: String(authDate), query_id: 'AAE', user: JSON.stringify({ id: userId, first_name: 'Тест' }) };
  fields.hash = signInitData(fields, token);
  return new URLSearchParams(fields).toString();
}
