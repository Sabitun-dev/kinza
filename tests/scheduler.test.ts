import { describe, expect, it } from 'vitest';
import { createTestApp, OWNER_TG } from './helpers/app.ts';
import { addProduct, addShop, addStock } from './helpers/fixtures.ts';
import { runScheduler } from '../src/scheduler/run.ts';
import { handleCallback } from '../src/bot/callbacks.ts';

// Monday 23 Nov 2026. Tashkent = UTC+5.
const at = (hhmm: string, day = '2026-11-23') => new Date(`${day}T${hhmm}:00+05:00`);

async function world() {
  let clock = at('07:00');
  const t = await createTestApp({ now: () => clock });
  const setClock = (d: Date) => (clock = d);
  const agent = await t.addUser(2001, 'AGENT');
  const driver = await t.addUser(3001, 'DRIVER');
  const limon = await addProduct(t, 'Limon');
  await addStock(t, limon, 24 * 5);
  const mine = await addShop(t, 'Owner shop');
  const agents = await addShop(t, 'Agent shop', { agentId: agent.id });
  // Delivery today for each shop
  for (const s of [mine, agents]) {
    await t.owner.post('/api/orders', { shopId: s, lines: [{ productId: limon, qtyCans: 48 }], confirm: true, deliveryDate: '2026-11-23' });
  }
  // Overdue debt on the agent's shop
  await t.owner.post(`/api/shops/${agents}/opening-balance`, { amount: 300_000, date: '2026-11-01' });
  // Order for later in the week (makes the Tashkent proposal non-empty)
  await t.owner.post('/api/orders', { shopId: mine, lines: [{ productId: limon, qtyCans: 24 * 40 }], confirm: true, force: true, deliveryDate: '2026-11-25' });
  // Custom reminder for the agent, due today
  await t.db.reminder.create({ data: { userId: agent.id, note: "Baraka bilan gaplashish", dueDate: new Date('2026-11-23T00:00:00Z') } });
  return { ...t, setClock, agent, driver, limon, mine, agents };
}

const to = (t: Awaited<ReturnType<typeof world>>, tg: number) => t.notifier.sent.filter((m) => m.chatId === tg);

describe('scheduler', () => {
  it('sends the 08:00 digest once per person with working buttons', async () => {
    const t = await world();
    t.notifier.sent.length = 0;
    t.setClock(at('07:50'));
    await runScheduler(t.deps);
    expect(t.notifier.sent.filter((m) => m.text?.includes('Xayrli tong'))).toHaveLength(0);

    t.setClock(at('08:05'));
    await runScheduler(t.deps);
    const owner = to(t, OWNER_TG).find((m) => m.text?.includes('Xayrli tong'))!;
    expect(owner.text).toContain('Bugun yetkazish: 2 ta');
    expect(owner.text).toContain("Muddati o'tgan qarz");
    expect(owner.buttons!.flat().some((b) => 'app' in b && b.app.startsWith('d_'))).toBe(true);

    const agent = to(t, 2001).find((m) => m.text?.includes('Xayrli tong'))!;
    expect(agent.text).toContain('Agent shop');
    expect(agent.text).not.toContain('Owner shop');
    expect(agent.text).toContain('Eslatmalar: 1');

    const driver = to(t, 3001).find((m) => m.text?.includes('Xayrli tong'))!;
    expect(driver.text).toContain('Bugun yetkazish: 2 ta');
    expect(driver.text).not.toContain("Muddati o'tgan");

    // Overdue alert and the agent's own reminder
    expect(to(t, OWNER_TG).some((m) => m.text?.includes("muddati o'tgan qarz") && m.text.includes('Agent shop'))).toBe(true);
    expect(to(t, 2001).some((m) => m.text?.includes('Eslatma') && m.text.includes('Baraka'))).toBe(true);
    expect(to(t, 3001).some((m) => m.text?.includes('Eslatma'))).toBe(false);

    // Running again the same day sends nothing new
    const count = t.notifier.sent.length;
    t.setClock(at('08:20'));
    await runScheduler(t.deps);
    expect(t.notifier.sent.length).toBe(count);
  });

  it('20:00 digest has tomorrow and the Tashkent proposal; cutoff reminder fires', async () => {
    const t = await world();
    t.setClock(at('15:05'));
    await runScheduler(t.deps);
    const cutoff = to(t, OWNER_TG).find((m) => m.text?.includes('Toshkentga buyurtma bering'));
    expect(cutoff).toBeTruthy();
    expect(cutoff!.buttons![0][0]).toEqual({ text: '📦 Toshkentga buyurtma', app: 'tashkent' });
    t.setClock(at('20:01'));
    await runScheduler(t.deps);
    const ev = to(t, OWNER_TG).find((m) => m.text?.includes('🌙'))!;
    expect(ev.text).toContain('Toshkentga buyurtma kerak');
  });

  it('snooze buttons postpone reminders and alerts by one day', async () => {
    const t = await world();
    const r = await t.db.reminder.findFirstOrThrow();
    const agentUser = { id: t.agent.id, telegramId: 2001, name: 'A', role: 'AGENT' as const, active: true };
    await handleCallback(t.deps, agentUser, `snz:${r.id}`);
    t.setClock(at('08:05'));
    await runScheduler(t.deps);
    expect(to(t, 2001).some((m) => m.text?.includes('Eslatma'))).toBe(false);
    t.setClock(at('08:05', '2026-11-24'));
    await runScheduler(t.deps);
    expect(to(t, 2001).some((m) => m.text?.includes('Eslatma'))).toBe(true);
  });

  it('daily backup is stored', async () => {
    const t = await world();
    t.setClock(at('03:10'));
    await runScheduler(t.deps);
    const keys = await t.blobs.list('backups/');
    expect(keys).toEqual(['backups/kinza-2026-11-23.json.gz']);
  });
});
