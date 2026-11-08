import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Jobs } from '../src/jobs.js';
import { cleanResult } from '../src/recognizer.js';
import { tmpDir } from './helpers.js';

const photo = (s) => ({ buffer: Buffer.from(s) });

test('задания выполняются по одному и сохраняют итог', async () => {
  const seen = [];
  let running = 0;
  const jobs = new Jobs(tmpDir(), async (dir, names) => {
    running++;
    assert.equal(running, 1, 'два распознавания одновременно');
    await new Promise((r) => setTimeout(r, 20));
    seen.push(names);
    running--;
    return `текст из ${names.length}`;
  });
  const done = [];
  const a = jobs.create([photo('1'), photo('2')], (j) => done.push(j));
  const b = jobs.create([photo('3')], (j) => done.push(j));
  await jobs.chain;
  assert.deepEqual(seen, [['01.jpg', '02.jpg'], ['01.jpg']]);
  assert.equal(jobs.get(a).text, 'текст из 2');
  assert.equal(jobs.get(b).status, 'done');
  assert.equal(done.length, 2);
});

test('ошибка распознавания попадает в задание', async () => {
  const jobs = new Jobs(tmpDir(), async () => {
    throw new Error('лимит');
  });
  const id = jobs.create([photo('1')]);
  await jobs.chain;
  assert.deepEqual([jobs.get(id).status, jobs.get(id).error], ['error', 'лимит']);
});

test('оборванные перезапуском задания помечаются ошибкой', () => {
  const dir = tmpDir();
  const first = new Jobs(dir, () => new Promise(() => {}));
  const id = first.create([photo('1')]);
  const second = new Jobs(dir, async () => '');
  assert.equal(second.get(id).status, 'error');
});

test('неверный номер задания не выходит за каталог', () => {
  const jobs = new Jobs(tmpDir(), async () => '');
  assert.throws(() => jobs.get('../../etc'), { status: 404 });
});

test('старые задания удаляются', async () => {
  const dir = tmpDir();
  const jobs = new Jobs(dir, async () => '');
  const id = jobs.create([photo('1')]);
  await jobs.chain;
  const old = (Date.now() - 40 * 86_400_000) / 1000;
  fs.utimesSync(path.join(dir, id), old, old);
  assert.equal(jobs.cleanup(30), 1);
  assert.equal(fs.existsSync(path.join(dir, id)), false);
});

test('обёртка ```markdown снимается с ответа', () => {
  assert.equal(cleanResult('```markdown\n# Тема\nтекст\n```'), '# Тема\nтекст');
  assert.equal(cleanResult('  # Тема  '), '# Тема');
});
