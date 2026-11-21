import { z } from 'zod';
import { bad } from '../core/errors.ts';

export { z };

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw bad(`Ma'lumot noto'g'ri: ${issue.path.join('.') || 'so‘rov'}`, r.error.issues);
  }
  return r.data;
}

export const money = z.number().int().min(0).max(2_000_000_000);
export const signedMoney = z.number().int().min(-2_000_000_000).max(2_000_000_000);
export const id = z.number().int().positive();
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const text = (max = 500) => z.string().trim().max(max);
