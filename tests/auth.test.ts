import { describe, expect, it } from 'vitest';
import { createTestApp, OWNER_TG } from './helpers/app.ts';
import { sanitizeFor } from '../src/core/permissions.ts';

describe('auth and roles', () => {
  it('owner is created from OWNER_TELEGRAM_IDS', async () => {
    const { owner } = await createTestApp();
    const me = await owner.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.data.user.role).toBe('OWNER');
  });

  it('unknown users get "no access"', async () => {
    const { as } = await createTestApp();
    const me = await as(555).get('/api/me');
    expect(me.data.user).toBeNull();
    const r = await as(555).get('/api/settings');
    expect(r.status).toBe(403);
    expect(r.data.error).toContain("Ruxsat yo'q");
  });

  it('rejects requests without valid initData', async () => {
    const { app } = await createTestApp();
    const r = await app.request('/api/me', { headers: { authorization: 'tma user=1&hash=abc' } });
    expect(r.status).toBe(401);
  });

  it('invite is single-use and sets the role', async () => {
    const { owner, as } = await createTestApp();
    const inv = await owner.post('/api/invites', { role: 'AGENT' });
    expect(inv.data.link).toContain('inv_');
    const a = await as(2001).post('/api/invites/accept', { token: inv.data.token });
    expect(a.data.user.role).toBe('AGENT');
    const b = await as(2002).post('/api/invites/accept', { token: inv.data.token });
    expect(b.status).toBe(403);
  });

  it('agents cannot open owner endpoints; deactivated users lose access', async () => {
    const { owner, addUser } = await createTestApp();
    const agent = await addUser(2001, 'AGENT');
    expect((await agent.get('/api/settings')).status).toBe(403);
    expect((await agent.post('/api/invites', { role: 'AGENT' })).status).toBe(403);
    await owner.patch(`/api/users/${agent.id}`, { active: false });
    expect((await agent.get('/api/me')).data.user).toBeNull();
  });

  it('owner cannot be invited', async () => {
    const { owner } = await createTestApp();
    const r = await owner.post('/api/invites', { role: 'OWNER' });
    expect(r.status).toBe(400);
    expect(OWNER_TG).toBe(1001);
  });

  it('sanitizer strips cost fields for agents and prices for drivers', () => {
    const data = { items: [{ flavour: 'Limon', pricePerPack: 120000, costPerCan: 3875, grossProfit: 1 }], total: 5 };
    expect(sanitizeFor('AGENT', data)).toEqual({ items: [{ flavour: 'Limon', pricePerPack: 120000 }], total: 5 });
    expect(sanitizeFor('DRIVER', data)).toEqual({ items: [{ flavour: 'Limon' }], total: 5 });
  });

  it('settings are saved and audited', async () => {
    const { owner, db } = await createTestApp();
    await owner.put('/api/settings', { businessName: 'Sobitxon Savdo', deliveryDays: 3 });
    const s = await owner.get('/api/settings');
    expect(s.data.businessName).toBe('Sobitxon Savdo');
    expect(s.data.deliveryDays).toBe(3);
    expect(await db.auditLog.count({ where: { action: 'settings.update' } })).toBe(1);
  });
});
