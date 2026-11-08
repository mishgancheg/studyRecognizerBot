// Задания распознавания: фото складываются в каталог задания, распознавание идёт строго по одному
// (лимиты подписки общие), итог пишется в result.json рядом с фото. Старые задания удаляются по сроку.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const PHOTO_RE = /^[0-9]{2}\.jpg$/;

export class Jobs {
  /**
   * @param {string} dir каталог заданий
   * @param {(dir: string, names: string[]) => Promise<{ photo: string, text: string }[]>} recognizeFn распознавание
   *   (текст по страницам: страница = одно фото)
   */
  constructor(dir, recognizeFn) {
    this.dir = dir;
    this.recognizeFn = recognizeFn;
    this.chain = Promise.resolve();
    fs.mkdirSync(dir, { recursive: true });
    this.markInterrupted();
  }

  /** Задания, оборванные перезапуском службы, помечаются ошибкой, чтобы Mini App не ждал их вечно. */
  markInterrupted() {
    for (const name of fs.readdirSync(this.dir)) {
      if (!ID_RE.test(name)) continue;
      try {
        const state = this.get(name);
        if (state.status === 'queued' || state.status === 'running') {
          this.write(name, { ...state, status: 'error', error: 'Распознавание прервано перезапуском службы — отправьте фото ещё раз' });
        }
      } catch {
        /* каталог без result.json — пропускаем */
      }
    }
  }

  newId(now = new Date()) {
    const s = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `${s.slice(0, 8)}-${s.slice(8)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  jobDir(id) {
    if (!ID_RE.test(id)) throw Object.assign(new Error('Неизвестное задание'), { status: 404 });
    return path.join(this.dir, id);
  }

  write(id, state) {
    const file = path.join(this.jobDir(id), 'result.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ id, ...state }));
    fs.renameSync(`${file}.tmp`, file);
  }

  get(id) {
    const file = path.join(this.jobDir(id), 'result.json');
    if (!fs.existsSync(file)) throw Object.assign(new Error('Неизвестное задание'), { status: 404 });
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** Путь к фото задания; Mini App показывает его рядом с распознанным текстом. */
  photoFile(id, name) {
    const file = path.join(this.jobDir(id), String(name));
    if (!PHOTO_RE.test(name) || !fs.existsSync(file)) {
      throw Object.assign(new Error('Фото уже удалено с сервера'), { status: 404 });
    }
    return file;
  }

  /**
   * Создаёт задание из загруженных фото и ставит его в очередь.
   * @param {{ buffer: Buffer }[]} photos фото по порядку
   */
  create(photos, onDone = () => {}) {
    const id = this.newId();
    const dir = this.jobDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const names = photos.map((p, i) => {
      const name = `${String(i + 1).padStart(2, '0')}.jpg`;
      fs.writeFileSync(path.join(dir, name), p.buffer);
      return name;
    });
    const created = Date.now();
    this.write(id, { status: 'queued', photos: names.length, created });

    this.chain = this.chain
      .then(async () => {
        this.write(id, { status: 'running', photos: names.length, created, started: Date.now() });
        let state;
        try {
          const pages = await this.recognizeFn(dir, names);
          state = { status: 'done', photos: names.length, created, finished: Date.now(), pages };
        } catch (error) {
          state = { status: 'error', photos: names.length, created, finished: Date.now(), error: error.message };
        }
        this.write(id, state);
        await Promise.resolve(onDone({ id, ...state })).catch(() => {});
      })
      // Сбой одного задания (например, удалённый каталог) не должен останавливать очередь.
      .catch((error) => console.error(`Задание ${id}: ${error.message}`));
    return id;
  }

  /** Удаляет задания старше заданного числа дней. Возвращает число удалённых. */
  cleanup(days, now = Date.now()) {
    let removed = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!ID_RE.test(name)) continue;
      const full = path.join(this.dir, name);
      if (now - fs.statSync(full).mtimeMs > days * 86_400_000) {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }
}
