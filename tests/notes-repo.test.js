import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { NotesRepo, noteContent, notePath, safeName } from '../src/notes-repo.js';
import { bareRepo, git, tmpDir } from './helpers.js';

function makeRepo(root, remote) {
  return new NotesRepo({
    dir: path.join(root, 'clone'),
    repoUrl: remote,
    branch: 'main',
    sshKeyPath: '',
    authorName: 'test',
    authorEmail: 'test@example.com',
  });
}

test('путь записи строится по правилам учебного репозитория', () => {
  assert.deepEqual(notePath({ semester: '3', subject: 'Матанализ', date: '2026-11-07', topic: 'Пределы: часть 1' }), {
    dir: '3 семестр/Матанализ/Записи',
    base: '2026-11-07_Пределы часть 1',
  });
  assert.equal(notePath({ semester: 1, subject: 'Физика', date: '2026-11-07', topic: '' }).base, '2026-11-07');
  assert.throws(() => notePath({ semester: 'x', subject: 'A', date: '2026-11-07' }), { status: 400 });
  assert.throws(() => notePath({ semester: 1, subject: '../..', date: '2026-11-07' }), { status: 400 });
  assert.equal(safeName(' ..a/b\\c.. '), 'a b c');
  assert.equal(safeName('...'), '');
});

test('у записи есть шапка с датой, семестром, предметом и темой', () => {
  const text = noteContent({ semester: 2, subject: 'ТФКП', date: '2026-11-07', topic: 'Вычеты', text: 'текст\r\n' });
  assert.equal(text, '---\nдата: 2026-11-07\nсеместр: 2\nпредмет: "ТФКП"\nтема: "Вычеты"\n---\n\nтекст\n');
});

test('сохранение в пустой репозиторий, повтор имени и чтение дерева', async () => {
  const root = tmpDir();
  const remote = bareRepo(root);
  const repo = makeRepo(root, remote);

  assert.deepEqual(await repo.tree(), []);

  const note = { semester: 1, subject: 'Физика', date: '2026-11-07', topic: 'Кинематика', text: '# Скорость' };
  assert.equal(await repo.save(note), '1 семестр/Физика/Записи/2026-11-07_Кинематика.md');
  assert.equal(await repo.save(note), '1 семестр/Физика/Записи/2026-11-07_Кинематика_2.md');

  repo.lastPull = 0;
  assert.deepEqual(await repo.tree(), [{ number: 1, subjects: ['Физика'] }]);
  assert.match(git(root, '--git-dir', remote, 'log', '--oneline', 'main'), /Кинематика_2/);
});

test('сохранение подтягивает чужие коммиты перед отправкой', async () => {
  const root = tmpDir();
  const remote = bareRepo(root);
  const repo = makeRepo(root, remote);
  await repo.save({ semester: 2, subject: 'Химия', date: '2026-11-01', topic: '', text: 'раз' });

  // Пользователь на ноутбуке добавил свой предмет и отправил его.
  const laptop = path.join(root, 'laptop');
  git(root, 'clone', '-q', remote, laptop);
  fs.mkdirSync(path.join(laptop, '2 семестр', 'История'), { recursive: true });
  fs.writeFileSync(path.join(laptop, '2 семестр', 'История', 'план.md'), 'план');
  git(laptop, 'add', '.');
  git(laptop, '-c', 'user.name=u', '-c', 'user.email=u@e', 'commit', '-qm', 'ноутбук');
  git(laptop, 'push', '-q', 'origin', 'main');

  await repo.save({ semester: 2, subject: 'Химия', date: '2026-11-02', topic: '', text: 'два' });
  repo.lastPull = 0;
  assert.deepEqual(await repo.tree(), [{ number: 2, subjects: ['История', 'Химия'] }]);
  assert.equal(git(root, '--git-dir', remote, 'rev-list', '--count', 'main'), '3');
});
