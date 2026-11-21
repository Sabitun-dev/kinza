import type { App } from '../app.ts';
import { body, idParam, ok } from '../app.ts';
import type { Deps } from '../../core/context.ts';
import { acceptInvite, createInvite } from '../../auth/users.ts';
import { forbidden, notFound } from '../../core/errors.ts';
import { requireRole } from '../../core/permissions.ts';
import { DEFAULT_SETTINGS, pickPublicSettings, updateSettings, type Settings } from '../../core/settings.ts';
import { audit } from '../../core/audit.ts';
import { fileUrl, saveFile, verifyFileSignature } from '../../core/files.ts';
import { parse, z, text } from '../validate.ts';
import { appUrl } from '../../core/notifier.ts';

export function coreRoutes(app: App, deps: Deps) {
  // Who am I? Unknown users get { user: null } so the app can show "Ruxsat yo'q".
  app.get('/api/me', async (c) => {
    const ctx = c.get('ctx');
    const tg = c.get('tg');
    if (!ctx.user) return ok(c, { user: null, startParam: tg.startParam ?? null });
    const u = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    const s = ctx.settings;
    return ok(c, {
      user: { id: u.id, name: u.name, role: u.role, phone: u.phone, introSeen: u.introSeen },
      settings: u.role === 'OWNER' ? { ...s, logoUrl: fileUrl(s.logoFileId) } : pickPublicSettings(s),
      startParam: tg.startParam ?? null,
      serverTime: ctx.now().toISOString(),
    });
  });

  app.post('/api/me/intro-seen', async (c) => {
    const ctx = c.get('ctx');
    await ctx.db.user.update({ where: { id: ctx.user.id }, data: { introSeen: true } });
    return ok(c, { ok: true });
  });

  app.post('/api/invites/accept', async (c) => {
    const ctx = c.get('ctx');
    const { token } = parse(z.object({ token: z.string().min(8).max(64) }), await body(c));
    const user = await acceptInvite(ctx.db, c.get('tg').user, token, deps.ownerIds);
    return ok(c, { user });
  });

  // ── Settings (owner) ──
  app.get('/api/settings', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    return ok(c, { ...ctx.settings, logoUrl: fileUrl(ctx.settings.logoFileId) });
  });

  app.put('/api/settings', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const patch = (await body<Partial<Settings>>(c)) ?? {};
    // botUsername / appUrl are written by /setup only
    delete patch.botUsername;
    delete patch.appUrl;
    const { changed } = await updateSettings(ctx.db, patch, ctx.user.id);
    if (Object.keys(changed).length) {
      await audit(ctx.db, ctx.user.id, 'settings.update', 'settings', null, undefined, changed);
    }
    return ok(c, { ok: true, changed: Object.keys(changed) });
  });

  // ── Users and invites (owner) ──
  app.get('/api/users', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const users = await ctx.db.user.findMany({ orderBy: [{ active: 'desc' }, { createdAt: 'asc' }] });
    const invites = await ctx.db.invite.findMany({
      where: { usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const bot = ctx.settings.botUsername;
    return ok(c, {
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        phone: u.phone,
        role: u.role,
        active: u.active,
        commissionMode: u.commissionMode,
        commissionBp: u.commissionBp,
        lastSeenAt: u.lastSeenAt,
      })),
      invites: invites.map((i) => ({ ...i, link: inviteLink(bot, i.token) })),
    });
  });

  app.post('/api/invites', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const input = parse(z.object({ role: z.enum(['AGENT', 'DRIVER']), note: text(100).optional() }), await body(c));
    const invite = await createInvite(ctx.db, ctx.user, input.role, input.note);
    return ok(c, { ...invite, link: inviteLink(ctx.settings.botUsername, invite.token) });
  });

  app.post('/api/invites/:id/revoke', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const id = idParam(c);
    await ctx.db.invite.update({ where: { id }, data: { revokedAt: new Date() } });
    await audit(ctx.db, ctx.user.id, 'invite.revoke', 'invite', id);
    return ok(c, { ok: true });
  });

  app.patch('/api/users/:id', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const id = idParam(c);
    const input = parse(
      z.object({
        name: text(100).min(1).optional(),
        active: z.boolean().optional(),
        role: z.enum(['AGENT', 'DRIVER']).optional(),
        commissionMode: z.enum(['NONE', 'COLLECTED', 'DELIVERED']).optional(),
        commissionBp: z.number().int().min(0).max(5000).optional(),
      }),
      await body(c),
    );
    const before = await ctx.db.user.findUnique({ where: { id } });
    if (!before) throw notFound();
    if (before.role === 'OWNER') throw forbidden("Egasini bu yerdan o'zgartirib bo'lmaydi");
    const after = await ctx.db.user.update({ where: { id }, data: input });
    await audit(ctx.db, ctx.user.id, 'user.update', 'user', id, pickUser(before), pickUser(after));
    return ok(c, { ok: true });
  });

  // ── Files ──
  // Upload: raw body, ?kind=PRODUCT_PHOTO&name=x.jpg. Photos are already compressed on the phone.
  app.post('/api/files', async (c) => {
    const ctx = c.get('ctx');
    const kind = parse(
      z.enum(['PRODUCT_PHOTO', 'SHOP_PHOTO', 'LOGO', 'DELIVERY_PHOTO', 'RECEIPT_PHOTO']),
      c.req.query('kind'),
    );
    if ((kind === 'LOGO' || kind === 'PRODUCT_PHOTO') && ctx.user.role !== 'OWNER') throw forbidden();
    const data = new Uint8Array(await c.req.arrayBuffer());
    const file = await saveFile(ctx.db, ctx.blobs, {
      kind,
      name: c.req.query('name') || 'photo.jpg',
      contentType: c.req.header('content-type') || 'application/octet-stream',
      data,
      userId: ctx.user.id,
    });
    return ok(c, { id: file.id, url: fileUrl(file.id) });
  });

  app.get('/api/files/:id', async (c) => {
    const id = idParam(c);
    if (!verifyFileSignature(id, Number(c.req.query('exp')), c.req.query('sig') ?? '')) {
      return c.json({ error: 'Havola eskirgan' }, 403);
    }
    const file = await deps.db.file.findUnique({ where: { id } });
    if (!file) throw notFound();
    const data = await deps.blobs.get(file.key);
    if (!data) throw notFound();
    const disposition = file.contentType.startsWith('image/') ? 'inline' : 'attachment';
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      'content-type': file.contentType,
      'cache-control': 'private, max-age=86400',
      'content-disposition': `${disposition}; filename="${encodeURIComponent(file.name)}"`,
    });
  });

  app.get('/api/defaults', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    return ok(c, DEFAULT_SETTINGS);
  });
}

export function inviteLink(botUsername: string, token: string): string {
  return botUsername ? `https://t.me/${botUsername}/app?startapp=inv_${token}` : appUrl('', `inv_${token}`);
}

const pickUser = (u: { role: string; active: boolean; commissionMode: string; commissionBp: number; name: string }) => ({
  name: u.name,
  role: u.role,
  active: u.active,
  commissionMode: u.commissionMode,
  commissionBp: u.commissionBp,
});
