// Проверка для `status` навыка развёртывания: есть ли у сервера доступ на запись к репозиторию с учёбой
// (git push --dry-run проходит, только если ключ добавлен в Deploy keys с правом записи).
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';

const { notes } = loadConfig();
const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: `ssh -i "${notes.sshKeyPath}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
};
try {
  execFileSync('git', ['ls-remote', notes.repoUrl, 'HEAD'], { env, stdio: 'pipe' });
  console.log(`чтение ${notes.repoUrl}: есть`);
} catch {
  console.log(`чтения ${notes.repoUrl} НЕТ — добавьте ключ ${notes.sshKeyPath}.pub в Deploy keys репозитория`);
  process.exit(0);
}
console.log('право записи видно только при сохранении: если запись не уходит, проверьте галочку Allow write access');
