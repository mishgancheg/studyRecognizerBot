// Проверка подписи Telegram Mini App (поле initData).
// Алгоритм из документации Telegram: secret = HMAC_SHA256(key="WebAppData", bot_token),
// hash = hex(HMAC_SHA256(key=secret, data_check_string)), где data_check_string — все поля, кроме hash,
// отсортированные по имени и склеенные через \n в виде key=value.
import crypto from 'node:crypto';

export function signInitData(fields, botToken) {
  const dataCheck = Object.keys(fields)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  return crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
}

/**
 * Возвращает пользователя Telegram ({ id, ... }) или бросает ошибку с полем status.
 * @param {string} initData строка window.Telegram.WebApp.initData
 */
export function verifyInitData(initData, { botToken, allowedUserIds, maxAgeSec, now = Date.now() }) {
  const deny = (status, message) => Object.assign(new Error(message), { status });
  if (!initData) throw deny(401, 'Нет подписи Telegram: откройте приложение из бота');

  const params = new URLSearchParams(initData);
  const fields = Object.fromEntries(params.entries());
  const hash = fields.hash || '';
  const expected = signInitData(fields, botToken);
  const ok =
    hash.length === expected.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
  if (!ok) throw deny(401, 'Подпись Telegram не сошлась');

  const authDate = Number(fields.auth_date || 0);
  if (!authDate || now / 1000 - authDate > maxAgeSec) {
    throw deny(401, 'Подпись Telegram устарела: закройте и снова откройте приложение');
  }

  let user;
  try {
    user = JSON.parse(fields.user || '');
  } catch {
    throw deny(401, 'В подписи Telegram нет пользователя');
  }
  if (!allowedUserIds.includes(Number(user.id))) throw deny(403, 'Доступ закрыт');
  return user;
}
