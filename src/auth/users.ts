import { randomBytes } from 'node:crypto';
import type { DbOrTx } from '../core/db.ts';
import type { AuthUser } from '../core/context.ts';
import type { Role } from '../generated/prisma/enums.ts';
import type { TelegramUser } from './initData.ts';
import { AppError, bad } from '../core/errors.ts';
import { audit } from '../core/audit.ts';

export const INVITE_DAYS = 7;

const fullName = (u: TelegramUser) => [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || 'Foydalanuvchi';

export function toAuthUser(u: { id: number; telegramId: bigint; name: string; role: Role; active: boolean }): AuthUser {
  return { id: u.id, telegramId: Number(u.telegramId), name: u.name, role: u.role, active: u.active };
}

/**
 * Finds the app user for a Telegram account. Owners (from OWNER_TELEGRAM_IDS) are created
 * automatically. Everyone else must have accepted an invite. Returns null for unknown users.
 */
export async function resolveUser(db: DbOrTx, tg: TelegramUser, ownerIds: number[]): Promise<AuthUser | null> {
  const isOwnerId = ownerIds.includes(tg.id);
  let user = await db.user.findUnique({ where: { telegramId: BigInt(tg.id) } });
  if (!user && isOwnerId) {
    user = await db.user.create({
      data: { telegramId: BigInt(tg.id), name: fullName(tg), username: tg.username, role: 'OWNER' },
    });
  } else if (user && isOwnerId && (user.role !== 'OWNER' || !user.active)) {
    user = await db.user.update({ where: { id: user.id }, data: { role: 'OWNER', active: true } });
  }
  if (!user) return null;
  if (user.username !== (tg.username ?? null) || !user.lastSeenAt || Date.now() - user.lastSeenAt.getTime() > 3_600_000) {
    user = await db.user.update({
      where: { id: user.id },
      data: { username: tg.username ?? null, lastSeenAt: new Date() },
    });
  }
  return toAuthUser(user);
}

export async function createInvite(db: DbOrTx, by: AuthUser, role: Role, note?: string) {
  if (role === 'OWNER') throw bad("Egasi faqat OWNER_TELEGRAM_IDS orqali qo'shiladi");
  const token = randomBytes(12).toString('base64url');
  const invite = await db.invite.create({
    data: {
      token,
      role,
      note: note?.slice(0, 100) || null,
      createdById: by.id,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    },
  });
  await audit(db, by.id, 'invite.create', 'invite', invite.id, undefined, { role, note });
  return invite;
}

/** Uses a single-use invite. Re-activates a previously deactivated person with the new role. */
export async function acceptInvite(db: DbOrTx, tg: TelegramUser, token: string, ownerIds: number[]) {
  const existing = await resolveUser(db, tg, ownerIds);
  if (existing?.active && existing.role === 'OWNER') return existing;
  const invite = await db.invite.findUnique({ where: { token } });
  if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt < new Date()) {
    throw new AppError("Taklif havolasi eskirgan yoki ishlatilgan. Egasidan yangisini so'rang.", 403, 'invite_invalid');
  }
  const claimed = await db.invite.updateMany({
    where: { id: invite.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw new AppError('Taklif havolasi ishlatilgan.', 403, 'invite_invalid');

  const user = await db.user.upsert({
    where: { telegramId: BigInt(tg.id) },
    create: { telegramId: BigInt(tg.id), name: fullName(tg), username: tg.username, role: invite.role },
    update: { role: invite.role, active: true },
  });
  await db.invite.update({ where: { id: invite.id }, data: { usedById: user.id } });
  await audit(db, user.id, 'invite.accept', 'user', user.id, undefined, { role: invite.role, inviteId: invite.id });
  return toAuthUser(user);
}
