import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { Jobs } from '../src/jobs.js';
import { NotesRepo } from '../src/notes-repo.js';
import { createApp } from '../src/server.js';
import { BOT_TOKEN, USER_ID, bareRepo, git, initData, tmpDir } from './helpers.js';

let server;
let base;
let remote;
let jobs;
const messages = [];

before(async () => {
  const root = tmpDir();
  remote = bareRepo(root);
  const config = parseConfig({
    webServer: { port: 0 },
    telegram: { botToken: BOT_TOKEN, allowedUserIds: String(USER_ID) },
    recognition: { oauthToken: 'x', maxPhotos: 3 },
    notes: { repoUrl: remote },
    data: { dir: root },
  });
  jobs = new Jobs(config.data.jobsDir, async (_dir, names) =>
    names.map((photo, i) => ({ photo, text: `# Страница ${i + 1}` })),);
  const notes = new NotesRepo({ dir: config.data.notesDir, ...config.notes });
  const app = createApp({ config, jobs, notes, notify: async (id, text) => messages.push({ id, text }) });
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const auth = (userId = USER_ID) => ({ Authorization: `tma ${initData({ userId })}` });

test('/health и Mini App открыты без подписи', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /telegram-web-app\.js/);
});

test('/api без подписи и чужому пользователю закрыт', async () => {
  assert.equal((await fetch(`${base}/api/tree`)).status, 401);
  const res = await fetch(`${base}/api/tree`, { headers: auth(7) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'Доступ закрыт');
});

test('полный путь: фото, распознавание, сохранение в репозиторий', async () => {
  const form = new FormData();
  form.append('photos', new Blob([Buffer.from('jpeg1')], { type: 'image/jpeg' }), '01.jpg');
  form.append('photos', new Blob([Buffer.from('jpeg2')], { type: 'image/jpeg' }), '02.jpg');
  const up = await fetch(`${base}/api/recognize`, { method: 'POST', headers: auth(), body: form });
  assert.equal(up.status, 200);
  const { id } = await up.json();
  await jobs.chain;
  const job = await (await fetch(`${base}/api/jobs/${id}`, { headers: auth() })).json();
  assert.equal(job.status, 'done');
  assert.deepEqual(job.pages.map((p) => p.text), ['# Страница 1', '# Страница 2']);
  const photo = await fetch(`${base}/api/jobs/${id}/photos/02.jpg`, { headers: auth() });
  assert.equal(await photo.text(), 'jpeg2');
  assert.equal((await fetch(`${base}/api/jobs/${id}/photos/02.jpg`)).status, 401);
  assert.equal((await fetch(`${base}/api/jobs/${id}/photos/09.jpg`, { headers: auth() })).status, 404);

  const save = await fetch(`${base}/api/save`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ semester: '4', subject: 'Базы данных', date: '2026-11-07', topic: 'SQL', text: job.pages[1].text }),
  });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).path, '4 семестр/Базы данных/Записи/2026-11-07_SQL.md');
  const stored = git(path.dirname(remote), '--git-dir', remote, 'show', 'main:4 семестр/Базы данных/Записи/2026-11-07_SQL.md');
  assert.match(stored, /# Страница 2/);
  assert.equal(messages.at(-1).id, USER_ID);

  const tree = await (await fetch(`${base}/api/tree`, { headers: auth() })).json();
  assert.deepEqual(tree.semesters, [{ number: 4, subjects: ['Базы данных'] }]);
});

test('ошибки загрузки объясняются по-русски', async () => {
  const empty = await fetch(`${base}/api/recognize`, { method: 'POST', headers: auth(), body: new FormData() });
  assert.equal((await empty.json()).error, 'Не загружено ни одного фото');

  const many = new FormData();
  for (let i = 0; i < 4; i++) many.append('photos', new Blob(['x'], { type: 'image/jpeg' }), `${i}.jpg`);
  const res = await fetch(`${base}/api/recognize`, { method: 'POST', headers: auth(), body: many });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /не больше 3/);

  const text = new FormData();
  text.append('photos', new Blob(['x'], { type: 'text/plain' }), 'a.txt');
  assert.match((await (await fetch(`${base}/api/recognize`, { method: 'POST', headers: auth(), body: text })).json()).error, /не изображение/);
});
