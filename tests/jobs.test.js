import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Jobs } from '../src/jobs.js';
import { cleanResult, splitPages } from '../src/recognizer.js';
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
    return names.map((photo) => ({ photo, text: `текст ${photo}` }));
  });
  const done = [];
  const a = jobs.create([photo('1'), photo('2')], (j) => done.push(j));
  const b = jobs.create([photo('3')], (j) => done.push(j));
  await jobs.chain;
  assert.deepEqual(seen, [['01.jpg', '02.jpg'], ['01.jpg']]);
  assert.deepEqual(jobs.get(a).pages, [
    { photo: '01.jpg', text: 'текст 01.jpg' },
    { photo: '02.jpg', text: 'текст 02.jpg' },
  ]);
  assert.match(jobs.photoFile(a, '02.jpg'), /02.jpg$/);
  assert.throws(() => jobs.photoFile(a, '03.jpg'), { status: 404 });
  assert.throws(() => jobs.photoFile(a, 'result.json'), { status: 404 });
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

test('ответ модели делится на страницы по меткам', () => {
  const names = ['01.jpg', '02.jpg', '03.jpg'];
  const raw = '```markdown\n<<<01.jpg>>>\n# Тема\nначало\n\n<<<02.jpg>>>\n$x^2$\n<<<03.jpg>>>\n\n```';
  assert.deepEqual(splitPages(raw, names), [
    { photo: '01.jpg', text: '# Тема\nначало' },
    { photo: '02.jpg', text: '$x^2$' },
    { photo: '03.jpg', text: '' },
  ]);
  assert.deepEqual(splitPages('без меток', names.slice(0, 2)), [
    { photo: '01.jpg', text: 'без меток' },
    { photo: '02.jpg', text: '' },
  ]);
});
