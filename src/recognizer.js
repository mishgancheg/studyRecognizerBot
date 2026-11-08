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

export function buildPrompt(photoNames) {
  return `Это фотографии страниц рукописного конспекта студента с пары, по порядку: ${photoNames.join(', ')}.
Открой каждый файл инструментом Read в указанном порядке и перепиши конспект в текст.

Правила:
- Выведи ТОЛЬКО текст конспекта в формате Markdown — без вступлений, пояснений и заключений от себя.
- Сохраняй структуру: заголовки, списки, нумерацию, выделения, порядок страниц. Страницы склей в один текст.
- Формулы записывай в LaTeX: внутри строки $...$, отдельной строкой $$...$$.
- Таблицы — таблицами Markdown.
- Рисунки, графики и схемы опиши кратко в квадратных скобках: [Рисунок: ...].
- Неразборчивое слово помечай как [неразборчиво]; не додумывай и не исправляй смысл записей.
- Сокращения оставляй как в тетради.`;
}

/** Убирает обёртку ```markdown ... ```, если модель завернула в неё весь ответ. */
export function cleanResult(text) {
  const t = String(text || '').trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

/**
 * Распознаёт фото из каталога задания. Возвращает текст Markdown.
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
      const text = cleanResult(parsed.result);
      if (!text) return reject(new Error('Claude Code вернул пустой текст'));
      resolve(text);
    });
  });
}
