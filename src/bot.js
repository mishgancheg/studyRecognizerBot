// Телеграм-бот: пускает только разрешённых пользователей и открывает Mini App.
// Получает обновления опросом (long polling), поэтому вебхук и отдельный адрес для бота не нужны.
import { Bot, InlineKeyboard } from 'grammy';

export function createBot({ config }) {
  const bot = new Bot(config.telegram.botToken);
  const allowed = new Set(config.telegram.allowedUserIds);
  const appUrl = config.telegram.publicUrl ? `${config.telegram.publicUrl}/` : '';

  const openKeyboard = () => (appUrl ? new InlineKeyboard().webApp('📷 Оцифровать конспект', appUrl) : undefined);

  bot.use(async (ctx, next) => {
    if (ctx.from && allowed.has(ctx.from.id)) return next();
    if (ctx.chat?.type === 'private') await ctx.reply('Доступ закрыт.');
  });

  bot.on('message', async (ctx) => {
    if (!appUrl) {
      await ctx.reply('Адрес Mini App не настроен (telegram.publicUrl).');
      return;
    }
    await ctx.reply('Нажмите кнопку, чтобы загрузить фото конспекта, проверить текст и сохранить его.', {
      reply_markup: openKeyboard(),
    });
  });

  bot.catch((err) => console.error('Ошибка бота:', err.error || err));

  /** Запуск: кнопка меню рядом с полем ввода открывает Mini App, затем опрос обновлений. */
  async function start() {
    if (appUrl) {
      for (const chatId of allowed) {
        await bot.api
          .setChatMenuButton({ chat_id: chatId, menu_button: { type: 'web_app', text: 'Оцифровать', web_app: { url: appUrl } } })
          .catch((e) => console.error(`Кнопка меню для ${chatId} не поставлена: ${e.message}`));
      }
    }
    bot
      .start({ drop_pending_updates: true, onStart: (me) => console.log(`Бот @${me.username} запущен`) })
      .catch((e) => {
        // Без бота Mini App не открыть: падаем, и systemd перезапустит службу.
        console.error(`Бот остановился: ${e.message}`);
        process.exit(1);
      });
  }

  async function notify(userId, text) {
    await bot.api.sendMessage(userId, text, { reply_markup: openKeyboard() });
  }

  return { bot, start, notify, stop: () => bot.stop() };
}
