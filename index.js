// Точка входа службы: веб-сервер Mini App и телеграм-бот в одном процессе.
import { loadConfig } from './src/config.js';
import { createApp } from './src/server.js';
import { createBot } from './src/bot.js';
import { Jobs } from './src/jobs.js';
import { NotesRepo } from './src/notes-repo.js';
import { recognize } from './src/recognizer.js';

const config = loadConfig();

const jobs = new Jobs(config.data.jobsDir, (dir, names) =>
  recognize(dir, names, { ...config.recognition, claudeConfigDir: config.data.claudeConfigDir }),
);
const notes = new NotesRepo({ dir: config.data.notesDir, ...config.notes });
const tg = createBot({ config });
const app = createApp({ config, jobs, notes, notify: tg.notify });

const cleanup = () => {
  const n = jobs.cleanup(config.data.photoRetentionDays);
  if (n) console.log(`Удалено старых заданий с фото: ${n}`);
};
cleanup();
setInterval(cleanup, 6 * 3600 * 1000).unref();

const server = app.listen(config.webServer.port, config.webServer.host, () => {
  console.log(`Mini App: http://${config.webServer.host}:${config.webServer.port}/`);
});
await tg.start();

const shutdown = async () => {
  server.close();
  await tg.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
