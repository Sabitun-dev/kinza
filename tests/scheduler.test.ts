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
  it('08:00: today\'s area and shop names (owner and agent separately), drivers keep their delivery digest', async () => {
    const t = await world();
    t.notifier.sent.length = 0;
    t.setClock(at('07:50'));
    await runScheduler(t.deps);
    expect(t.notifier.sent.filter((m) => m.text?.includes('Bugun:'))).toHaveLength(0);

    t.setClock(at('08:05'));
    await runScheduler(t.deps);
    const owner = to(t, OWNER_TG).find((m) => m.text?.includes('☀️'))!;
    expect(owner.text).toContain("Bugun: A hudud — 1 ta do'kon");
    expect(owner.text).toContain('1. Owner shop');
    expect(owner.text).not.toContain('Agent shop');
    expect(owner.buttons!.flat()).toContainEqual({ text: 'Ochish', app: 'today' });
    expect(owner.buttons!.flat().some((b) => 'app' in b && b.app === 'drive')).toBe(true);

    const agent = to(t, 2001).find((m) => m.text?.includes('☀️'))!;
    expect(agent.text).toContain('1. Agent shop');
    expect(agent.text).not.toContain('Owner shop');
    expect(agent.text).toContain('Eslatmalar: 1');

    const driver = to(t, 3001).find((m) => m.text?.includes('Xayrli tong'))!;
    expect(driver.text).toContain('Bugun yetkazish: 2 ta');
    expect(driver.text).not.toContain("Muddati o'tgan");

    // Overdue alert and the agent's own reminder still come
    expect(to(t, OWNER_TG).some((m) => m.text?.includes("muddati o'tgan qarz") && m.text.includes('Agent shop'))).toBe(true);
    expect(to(t, 2001).some((m) => m.text?.includes('Eslatma') && m.text.includes('Baraka'))).toBe(true);
    expect(to(t, 3001).some((m) => m.text?.includes('Eslatma'))).toBe(false);

    // Running again the same day sends nothing new
    const count = t.notifier.sent.length;
    t.setClock(at('08:20'));
    await runScheduler(t.deps);
    expect(t.notifier.sent.length).toBe(count);

    // 17:00: names of shops still left
    t.setClock(at('17:05'));
    await runScheduler(t.deps);
    const left = to(t, OWNER_TG).find((m) => m.text?.includes("Hali 1 ta do'kon qoldi"));
    expect(left?.text).toContain('Owner shop');
  });

  it('Tashkent: the cutoff reminder only on the order day (Thursday); 20:00 has tomorrow\'s list and the proposal', async () => {
    const t = await world();
    t.setClock(at('15:05'));
    await runScheduler(t.deps);
    expect(to(t, OWNER_TG).some((m) => m.text?.includes('Toshkentga buyurtma bering'))).toBe(false); // Monday

    t.setClock(at('20:01'));
    await runScheduler(t.deps);
    const mon = to(t, OWNER_TG).find((m) => m.text?.includes('🌙'))!;
    expect(mon.text).toContain('Kun yakuni qilinmagan');
    expect(mon.text).toContain('Ertaga');
    expect(mon.text).toContain('Owner shop'); // still ⏳ today → carried to tomorrow
    expect(mon.text).not.toContain('Toshkentga buyurtma');

    const THU = '2026-11-26';
    t.setClock(at('15:05', THU));
    await runScheduler(t.deps);
    const cutoff = to(t, OWNER_TG).find((m) => m.text?.includes('Toshkentga buyurtma bering'));
    expect(cutoff).toBeTruthy();
    expect(cutoff!.buttons![0][0]).toEqual({ text: '📦 Toshkentga buyurtma', app: 'tashkent' });
    t.setClock(at('20:01', THU));
    await runScheduler(t.deps);
    const thu = to(t, OWNER_TG).filter((m) => m.text?.includes('🌙')).at(-1)!;
    expect(thu.text).toContain('Toshkentga buyurtma (Shanba keladi)');
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
