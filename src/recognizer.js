// Распознавание фото конспекта через Claude Code в неинтерактивном режиме (`claude -p`) по подписке
// пользователя (токен из `claude setup-token`). Платный API не используется.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Путь к исполняемому файлу Claude Code из зависимостей проекта. */
export function claudeBinary() {
  const pkgFile = require.resolve('@anthropic-ai/claude-code/package.json');
  const bin = require(pkgFile).bin;
  return path.join(path.dirname(pkgFile), typeof bin === 'string' ? bin : bin.claude);
}

/** Строка-метка, которой модель открывает текст каждой фотографии. */
export const pageMarker = (name) => `<<<${name}>>>`;

export function buildPrompt(photoNames) {
  return `Тебе приложен набор изображений.
Нужно достать все содержимое с абсолютной точностью, включая рисунки.
Тщательно посмотри на содержимое каждой страницы и вытащи текст 1 в 1 оттуда, однако если ты уверен, что в записи есть ошибка (неправильно написанный термин, неверная переменная, неправильный знак), исправь, но предупреди в итоге своего респонза. Если встречаются рисунки, в квадратных скобках опиши что там проиллюстрировано. Если встречаются зачеркнутые области - их выписывать не стоит.
Каждую страницу выделяй в отдельную текстовую вставку, которую можно редактировать и копировать. Формулы во вставке в режиме просмотра должны быть отрендерены.

Если вдруг тебе попадается недоделанная задача, не надо ее доделывать. вместо этого добавь [НЕЗАКОНЧЕННОЕ РЕШЕНИЕ]. 

Данное извлечение необходимо для того, чтобы составить виртуальную интерактивную тетрадь с конспектами. `;
}

/** Убирает обёртку ```markdown ... ```, если модель завернула в неё весь ответ. */
export function cleanResult(text) {
  const t = String(text || '').trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

/**
 * Делит ответ модели на страницы по меткам. Текст до первой метки и при полном отсутствии меток
 * достаётся первой странице, метка с незнакомым именем продолжает предыдущую страницу.
 * @returns {{ photo: string, text: string }[]}
 */
export function splitPages(raw, photoNames) {
  const texts = photoNames.map(() => '');
  const re = /^[ \t]*<<<\s*([^<>\s]+)\s*>>>[ \t]*$/gm;
  let cur = 0;
  let last = 0;
  const text = cleanResult(raw);
  for (let m; (m = re.exec(text)); ) {
    texts[cur] += text.slice(last, m.index);
    const idx = photoNames.indexOf(m[1]);
    if (idx >= 0) cur = idx;
    last = re.lastIndex;
  }
  texts[cur] += text.slice(last);
  return photoNames.map((photo, i) => ({ photo, text: cleanResult(texts[i]) }));
}

/**
 * Распознаёт фото из каталога задания за один вызов Claude Code. Возвращает текст Markdown по страницам.
 * @param {string} dir каталог с фото
 * @param {string[]} photoNames имена файлов по порядку
 */
export function recognize(dir, photoNames, { oauthToken, model, timeoutSec, claudeConfigDir }) {
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  const args = [
    '-p',
    buildPrompt(photoNames),
    '--model',
    model,
    '--output-format',
    'json',
    '--allowedTools',
    'Read',
    // Пользовательские и проектные настройки Claude на сервере не подхватываем: там может стоять другой шлюз.
    '--setting-sources',
    '',
    '--no-session-persistence',
  ];
  // Окружение собирается с нуля: переменные ANTHROPIC_* из окружения службы не должны перенаправить запрос.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || process.env.USERPROFILE,
    USERPROFILE: process.env.USERPROFILE,
    SYSTEMROOT: process.env.SYSTEMROOT,
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

  return new Promise((resolve, reject) => {
    const child = spawn(claudeBinary(), args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Не удалось запустить Claude Code: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`Распознавание не уложилось в ${timeoutSec} с и было прервано`));
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        return reject(new Error(`Claude Code завершился с кодом ${code}: ${(err || out).trim().slice(0, 500)}`));
      }
      if (parsed.is_error || parsed.subtype !== 'success') {
        return reject(new Error(`Claude Code вернул ошибку: ${String(parsed.result || parsed.subtype).slice(0, 500)}`));
      }
      const pages = splitPages(parsed.result, photoNames);
      if (!pages.some((p) => p.text)) return reject(new Error('Claude Code вернул пустой текст'));
      resolve(pages);
    });
  });
}
