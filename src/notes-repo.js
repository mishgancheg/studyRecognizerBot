// Репозиторий с учёбой: локальный клон на сервере, чтение папок семестров и предметов, сохранение записи.
// Устройство репозитория: «<N> семестр/<Предмет>/Записи/<дата>_<тема>.md».
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const NOTES_FOLDER = 'Записи';
const SEMESTER_RE = /^(\d+) семестр$/;
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Название папки или части имени файла без запрещённых знаков. */
export function safeName(value, max = 80) {
  return String(value || '')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, max)
    // Точки и пробелы по краям недопустимы в Windows, а имя из одних точек вело бы в соседнюю папку.
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

export function notePath({ semester, subject, date, topic }) {
  const n = Number(semester);
  if (!Number.isInteger(n) || n < 1 || n > 12) throw Object.assign(new Error('Неверный номер семестра'), { status: 400 });
  const subj = safeName(subject);
  if (!subj) throw Object.assign(new Error('Не указан предмет'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw Object.assign(new Error('Неверная дата'), { status: 400 });
  const t = safeName(topic);
  return { dir: path.posix.join(`${n} семестр`, subj, NOTES_FOLDER), base: t ? `${date}_${t}` : date };
}

export function noteContent({ semester, subject, date, topic, text }) {
  const esc = (v) => JSON.stringify(String(v));
  const head = ['---', `дата: ${date}`, `семестр: ${Number(semester)}`, `предмет: ${esc(safeName(subject))}`];
  if (safeName(topic)) head.push(`тема: ${esc(safeName(topic))}`);
  head.push('---', '');
  return `${head.join('\n')}\n${String(text).replace(/\r\n/g, '\n').trim()}\n`;
}

export class NotesRepo {
  constructor({ dir, repoUrl, branch, sshKeyPath, authorName, authorEmail }) {
    Object.assign(this, { dir, repoUrl, branch, sshKeyPath, authorName, authorEmail });
    this.queue = Promise.resolve();
    this.lastPull = 0;
  }

  git(args, opts = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (this.sshKeyPath) {
      env.GIT_SSH_COMMAND = `ssh -i "${this.sshKeyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    }
    return run('git', args, { cwd: opts.cwd || this.dir, env, maxBuffer: 16 * 1024 * 1024 });
  }

  /** Все операции с клоном идут строго по очереди. */
  serial(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async ensureClone() {
    if (fs.existsSync(path.join(this.dir, '.git'))) return;
    fs.mkdirSync(path.dirname(this.dir), { recursive: true });
    await this.git(['clone', this.repoUrl, this.dir], { cwd: path.dirname(this.dir) });
  }

  async remoteHasBranch() {
    const { stdout } = await this.git(['ls-remote', '--heads', 'origin', this.branch]);
    return stdout.trim() !== '';
  }

  async pull() {
    if (!(await this.remoteHasBranch())) return; // пустой репозиторий: тянуть нечего
    await this.git(['fetch', 'origin', this.branch]);
    const { stdout } = await this.git(['branch', '--show-current']);
    if (stdout.trim() !== this.branch) await this.git(['checkout', '-B', this.branch, `origin/${this.branch}`]);
    await this.git(['rebase', `origin/${this.branch}`]);
    this.lastPull = Date.now();
  }

  /** Семестры и предметы из папок репозитория. Подтягивает свежее не чаще раза в 30 с. */
  tree() {
    return this.serial(async () => {
      await this.ensureClone();
      if (Date.now() - this.lastPull > 30_000) await this.pull();
      const semesters = [];
      for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) {
        const m = e.isDirectory() && e.name.match(SEMESTER_RE);
        if (!m) continue;
        const subjects = fs
          .readdirSync(path.join(this.dir, e.name), { withFileTypes: true })
          .filter((s) => s.isDirectory() && !s.name.startsWith('.'))
          .map((s) => s.name)
          .sort((a, b) => a.localeCompare(b, 'ru'));
        semesters.push({ number: Number(m[1]), subjects });
      }
      return semesters.sort((a, b) => a.number - b.number);
    });
  }

  /** Сохраняет запись, коммитит и отправляет на GitHub. Возвращает путь файла в репозитории. */
  save(note) {
    return this.serial(async () => {
      await this.ensureClone();
      await this.pull();
      const { dir, base } = notePath(note);
      fs.mkdirSync(path.join(this.dir, dir), { recursive: true });
      let rel = `${dir}/${base}.md`;
      for (let i = 2; fs.existsSync(path.join(this.dir, rel)); i++) rel = `${dir}/${base}_${i}.md`;
      fs.writeFileSync(path.join(this.dir, rel), noteContent(note), 'utf8');

      const who = ['-c', `user.name=${this.authorName}`, '-c', `user.email=${this.authorEmail}`];
      await this.git(['add', '--', rel]);
      await this.git([...who, 'commit', '-q', '-m', `Запись: ${rel}`]);
      try {
        await this.git(['push', 'origin', `HEAD:refs/heads/${this.branch}`]);
      } catch {
        try {
          // Кто-то успел отправить свой коммит: подтягиваем и пробуем ещё раз.
          await this.pull();
          await this.git(['push', 'origin', `HEAD:refs/heads/${this.branch}`]);
        } catch (error) {
          // Не отправилось — откатываем коммит, чтобы повторное сохранение не плодило копий файла.
          await this.git(['reset', '--hard', 'HEAD~1']).catch(() => {});
          throw new Error(`Не удалось отправить запись на GitHub: ${error.stderr || error.message}`);
        }
      }
      this.lastPull = Date.now();
      return rel;
    });
  }
}
