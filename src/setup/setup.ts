import { getDb } from '../core/db.ts';
import { parseOwnerIds } from '../core/context.ts';
import { netlifyBlobStore } from '../core/files.ts';
import { appUrl, esc } from '../core/notifier.ts';
import { updateSettings } from '../core/settings.ts';
import { ensureBaseData } from './baseData.ts';
import { loadFonts } from '../pdf/fonts.ts';
import { t } from '../shared/i18n/index.ts';

interface Check {
  name: string;
  ok: boolean;
  info?: string;
}

const ENV_VARS = ['BOT_TOKEN', 'WEBHOOK_SECRET', 'SETUP_SECRET', 'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'OWNER_TELEGRAM_IDS'];

/**
 * Connects the bot to this site and checks every part. Running it again is safe:
 * it only (re)sets the webhook, commands and menu button, and fills empty lists.
 */
export async function runSetup(origin: string): Promise<string> {
  const checks: Check[] = [];
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const info = await fn();
      checks.push({ name, ok: true, info: info || undefined });
    } catch (err) {
      checks.push({ name, ok: false, info: (err as Error).message.slice(0, 300) });
    }
  };

  for (const v of ENV_VARS) {
    checks.push({ name: `Env: ${v}`, ok: !!process.env[v], info: process.env[v] ? 'bor' : "yo'q — Netlify'da qo'shing" });
  }
  const owners = parseOwnerIds(process.env.OWNER_TELEGRAM_IDS);
  checks.push({ name: 'Egasi ID', ok: owners.length > 0, info: owners.length ? `${owners.length} ta` : "OWNER_TELEGRAM_IDS bo'sh" });

  const token = process.env.BOT_TOKEN ?? '';
  const tg = async (method: string, body?: unknown) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(json.description ?? `${method} failed`);
    return json.result;
  };

  let botUsername = '';
  const db = process.env.DATABASE_URL ? getDb() : null;

  await step('Database ulanishi', async () => {
    if (!db) throw new Error("DATABASE_URL yo'q");
    await db.$queryRaw`SELECT 1`;
  });
  await step('Database jadvallari (migratsiya)', async () => {
    if (!db) throw new Error("DATABASE_URL yo'q");
    const n = await db.user.count();
    return `users: ${n}`;
  });
  await step("Boshlang'ich ro'yxatlar", async () => {
    if (!db) throw new Error("DATABASE_URL yo'q");
    const created = await ensureBaseData(db);
    return created.length ? `yaratildi: ${created.join(', ')}` : 'bor';
  });
  await step('Bot tokeni (getMe)', async () => {
    const me = (await tg('getMe')) as { username: string };
    botUsername = me.username;
    return `@${me.username}`;
  });
  await step('Webhook', async () => {
    await tg('setWebhook', {
      url: `${origin}/telegram`,
      secret_token: process.env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    return `${origin}/telegram`;
  });
  await step('Bot buyruqlari', async () => {
    const c = t;
    await tg('setMyCommands', {
      commands: [
        { command: 'start', description: c('bot.commands.start') },
        { command: 'phone', description: c('bot.commands.phone') },
        { command: 'id', description: c('bot.commands.id') },
        { command: 'help', description: c('bot.commands.help') },
      ],
    });
  });
  await step('"Ochish" menyu tugmasi', async () => {
    await tg('setChatMenuButton', {
      menu_button: { type: 'web_app', text: t('bot.open'), web_app: { url: appUrl(origin) } },
    });
    return appUrl(origin);
  });
  await step('Sozlamalarga sayt manzilini yozish', async () => {
    if (!db) throw new Error("DATABASE_URL yo'q");
    await updateSettings(db, { appUrl: origin, ...(botUsername ? { botUsername } : {}) }, null);
    return botUsername ? `@${botUsername}` : origin;
  });
  await step('Fayl ombori (Netlify Blobs)', async () => {
    const blobs = await netlifyBlobStore();
    await blobs.put('setup/check.txt', new TextEncoder().encode(new Date().toISOString()), 'text/plain');
    const back = await blobs.get('setup/check.txt');
    if (!back) throw new Error("O'qib bo'lmadi");
  });
  await step("PDF shrifti (O'g'il, G'isht, Ш, Ч)", async () => {
    const f = loadFonts();
    return `${Math.round(f.regular.byteLength / 1024)} KB`;
  });

  const allOk = checks.every((c) => c.ok);
  const rows = checks
    .map((c) => `<tr><td>${c.ok ? '✅' : '❌'}</td><td>${esc(c.name)}</td><td>${esc(c.info ?? '')}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KINZA DISTRO — sozlash</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#10261b}
h1{color:#0f5d3a}table{border-collapse:collapse;width:100%}td{padding:10px 8px;border-bottom:1px solid #e3ebe6;vertical-align:top}
td:first-child{width:28px}.ok{background:#e8f5ee;padding:12px 16px;border-radius:12px}.bad{background:#fdecec;padding:12px 16px;border-radius:12px}</style></head>
<body><h1>KINZA DISTRO — sozlash</h1>
<p class="${allOk ? 'ok' : 'bad'}">${allOk ? "Hammasi tayyor ✅ Endi botga /start yozing." : "Ba'zi qadamlar bajarilmadi ❌ Qizil qatorlarni tuzatib, sahifani yangilang."}</p>
<table>${rows}</table>
${botUsername ? `<p>Bot: <a href="https://t.me/${botUsername}">@${botUsername}</a> · Mini App: <a href="https://t.me/${botUsername}/app">t.me/${botUsername}/app</a></p>` : ''}
<p style="color:#5b6f64">Bu sahifani istalgancha qayta ochish mumkin.</p></body></html>`;
}
