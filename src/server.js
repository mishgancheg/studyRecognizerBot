// Веб-сервер: раздаёт Mini App (public/) и принимает его запросы (/api/*).
// Каждый запрос /api подписан Telegram: заголовок `Authorization: tma <initData>`.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { verifyInitData } from './telegram-auth.js';

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/**
 * @param {object} deps
 * @param {ReturnType<import('./config.js').parseConfig>} deps.config
 * @param {import('./jobs.js').Jobs} deps.jobs
 * @param {import('./notes-repo.js').NotesRepo} deps.notes
 * @param {(userId: number, text: string) => Promise<void>} [deps.notify] сообщение пользователю в Telegram
 */
export function createApp({ config, jobs, notes, notify = async () => {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.static(path.join(PROJECT_ROOT, 'public'), { index: 'index.html', maxAge: 0 }));

  const api = express.Router();
  api.use((req, _res, next) => {
    const header = req.get('authorization') || '';
    req.tgUser = verifyInitData(header.replace(/^tma\s+/i, ''), {
      botToken: config.telegram.botToken,
      allowedUserIds: config.telegram.allowedUserIds,
      maxAgeSec: config.telegram.initDataMaxAgeSec,
    });
    next();
  });

  api.get('/tree', async (_req, res) => {
    res.json({ semesters: await notes.tree() });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PHOTO_BYTES, files: config.recognition.maxPhotos },
  });
  api.post('/recognize', upload.array('photos', config.recognition.maxPhotos), (req, res) => {
    const photos = req.files || [];
    if (!photos.length) throw Object.assign(new Error('Не загружено ни одного фото'), { status: 400 });
    const bad = photos.find((p) => !/^image\//.test(p.mimetype));
    if (bad) throw Object.assign(new Error(`Файл ${bad.originalname} — не изображение`), { status: 400 });
    const userId = req.tgUser.id;
    const id = jobs.create(photos, async (job) => {
      if (job.status === 'error') await notify(userId, `Распознавание не удалось: ${job.error}`);
    });
    res.json({ id });
  });

  api.get('/jobs/:id', (req, res) => {
    res.json(jobs.get(req.params.id));
  });

  api.get('/jobs/:id/photos/:name', (req, res) => {
    res.sendFile(jobs.photoFile(req.params.id, req.params.name), { maxAge: '1d' });
  });

  api.post('/save', express.json({ limit: '2mb' }), async (req, res) => {
    const { semester, subject, date, topic, text } = req.body || {};
    if (!String(text || '').trim()) throw Object.assign(new Error('Текст пустой'), { status: 400 });
    const file = await notes.save({ semester, subject, date, topic, text });
    await notify(req.tgUser.id, `Запись сохранена в репозиторий:\n${file}`).catch(() => {});
    res.json({ path: file });
  });

  app.use('/api', api);

  // Ошибки отдаются Mini App текстом по-русски; внутренние подробности — только в журнал.
  app.use((err, _req, res, _next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err instanceof multer.MulterError) {
      status = 400;
      message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Фото слишком большое (больше 15 МБ)'
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
            ? `Слишком много фото: не больше ${config.recognition.maxPhotos}`
            : `Ошибка загрузки: ${err.message}`;
    }
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message || 'Внутренняя ошибка' });
  });

  return app;
}
