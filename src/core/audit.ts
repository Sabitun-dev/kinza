import type { DbOrTx } from './db.ts';

/** Records who changed what. Called for every money, stock, price and document change. */
export async function audit(
  db: DbOrTx,
  userId: number | null | undefined,
  action: string,
  entity: string,
  entityId: string | number | null,
  before?: unknown,
  after?: unknown,
) {
  await db.auditLog.create({
    data: {
      userId: userId ?? null,
      action,
      entity,
      entityId: entityId == null ? null : String(entityId),
      before: before === undefined ? undefined : (toJson(before) as never),
      after: after === undefined ? undefined : (toJson(after) as never),
    },
  });
}

function toJson(v: unknown) {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
