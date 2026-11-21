import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import type { Deps } from '../core/context.ts';
import { resolveUser } from '../auth/users.ts';
import { getSettings } from '../core/settings.ts';
import { appUrl, esc } from '../core/notifier.ts';
import { t } from '../shared/i18n/index.ts';
import { handleCallback } from './callbacks.ts';

/** Builds the bot. Called once per function instance; updates arrive through the webhook. */
export async function createBot(deps: Deps) {
  const bot = new Bot(deps.botToken);
  await bot.init();
  const base = async () => (await getSettings(deps.db)).appUrl || process.env.URL || '';

  const openKeyboard = async (start?: string) =>
    new InlineKeyboard().webApp(t('bot.open'), appUrl(await base(), start));

  bot.command('start', async (ctx) => {
    if (!ctx.from || ctx.chat.type !== 'private') return;
    const payload = ctx.match?.trim();
    const user = await resolveUser(deps.db, ctx.from, deps.ownerIds);
    if (payload?.startsWith('inv_')) {
      await ctx.reply(t('bot.invite'), { reply_markup: await openKeyboard(payload) });
      return;
    }
    if (!user || !user.active) {
      await ctx.reply(t('bot.noAccess', { id: ctx.from.id }), { parse_mode: 'HTML' });
      return;
    }
    await ctx.reply(t('bot.welcome', { name: esc(user.name) }), {
      parse_mode: 'HTML',
      reply_markup: await openKeyboard(payload || undefined),
    });
    const full = await deps.db.user.findUnique({ where: { id: user.id } });
    if (!full?.phone) {
      await ctx.reply(t('bot.askPhone'), {
        reply_markup: new Keyboard().requestContact(t('bot.sharePhone')).oneTime().resized(),
      });
    }
  });

  bot.command('phone', async (ctx) => {
    await ctx.reply(t('bot.askPhone'), {
      reply_markup: new Keyboard().requestContact(t('bot.sharePhone')).oneTime().resized(),
    });
  });

  bot.command('id', (ctx) => ctx.reply(t('bot.yourId', { id: ctx.from?.id ?? 0 }), { parse_mode: 'HTML' }));
  bot.command('help', (ctx) => ctx.reply(t('bot.help')));

  bot.command('backup', async (ctx) => {
    if (!ctx.from) return;
    const user = await resolveUser(deps.db, ctx.from, deps.ownerIds);
    if (user?.role !== 'OWNER') return;
    await ctx.reply(t('bot.backupStarted'));
    const { runBackup } = await import('../backup/backup.ts');
    await runBackup(deps, { sendTo: [user.telegramId], reason: 'manual' });
  });

  // Phone numbers are trusted only from a contact the user shared about themselves.
  bot.on('message:contact', async (ctx) => {
    const contact = ctx.message.contact;
    if (!ctx.from || contact.user_id !== ctx.from.id) {
      await ctx.reply(t('bot.phoneNotYours'), { reply_markup: { remove_keyboard: true } });
      return;
    }
    const user = await resolveUser(deps.db, ctx.from, deps.ownerIds);
    if (!user) {
      await ctx.reply(t('bot.noAccess', { id: ctx.from.id }), { parse_mode: 'HTML' });
      return;
    }
    const phone = contact.phone_number.startsWith('+') ? contact.phone_number : `+${contact.phone_number}`;
    await deps.db.user.update({ where: { id: user.id }, data: { phone } });
    await ctx.reply(t('bot.phoneSaved'), { reply_markup: { remove_keyboard: true } });
  });

  bot.on('callback_query:data', async (ctx) => {
    const user = await resolveUser(deps.db, ctx.from, deps.ownerIds);
    if (!user?.active) {
      await ctx.answerCallbackQuery({ text: t('common.noAccess'), show_alert: true });
      return;
    }
    const answer = await handleCallback(deps, user, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery({ text: answer });
  });

  bot.catch((err) => console.error('Bot error', err.error));
  return bot;
}
