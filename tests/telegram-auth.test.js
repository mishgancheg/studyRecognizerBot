import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyInitData } from '../src/telegram-auth.js';
import { BOT_TOKEN, USER_ID, initData } from './helpers.js';

const opts = { botToken: BOT_TOKEN, allowedUserIds: [USER_ID], maxAgeSec: 3600 };

test('пропускает разрешённого пользователя с верной подписью', () => {
  assert.equal(verifyInitData(initData(), opts).id, USER_ID);
});

test('отклоняет подпись другим токеном', () => {
  assert.throws(() => verifyInitData(initData({ token: '1:other' }), opts), { status: 401 });
});

test('отклоняет подделанное поле', () => {
  const forged = initData().replace(/auth_date=\d+/, `auth_date=${Math.floor(Date.now() / 1000) - 1}`);
  assert.throws(() => verifyInitData(forged, opts), { status: 401 });
});

test('отклоняет устаревшую подпись', () => {
  const old = initData({ authDate: Math.floor(Date.now() / 1000) - 7200 });
  assert.throws(() => verifyInitData(old, opts), { status: 401 });
});

test('отклоняет постороннего пользователя', () => {
  assert.throws(() => verifyInitData(initData({ userId: 7 }), opts), { status: 403 });
});

test('отклоняет пустую подпись', () => {
  assert.throws(() => verifyInitData('', opts), { status: 401 });
});
