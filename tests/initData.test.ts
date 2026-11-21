import { describe, expect, it } from 'vitest';
import { signInitData, validateInitData } from '../src/auth/initData.ts';

const TOKEN = '123456:TEST_TOKEN';
const now = 1_800_000_000;
const fields = (authDate = now) => ({
  auth_date: String(authDate),
  query_id: 'AAE',
  user: JSON.stringify({ id: 42, first_name: 'Sobitxon' }),
  start_param: 'o_12',
});

describe('initData', () => {
  it('accepts valid data', () => {
    const v = validateInitData(signInitData(fields(), TOKEN), TOKEN, 86400, now + 10);
    expect(v.user.id).toBe(42);
    expect(v.startParam).toBe('o_12');
  });
  it('rejects tampered data', () => {
    const signed = signInitData(fields(), TOKEN).replace('42', '43');
    expect(() => validateInitData(signed, TOKEN, 86400, now)).toThrow();
  });
  it('rejects another bot token', () => {
    expect(() => validateInitData(signInitData(fields(), 'other:token'), TOKEN, 86400, now)).toThrow();
  });
  it('rejects data older than 24 hours', () => {
    expect(() => validateInitData(signInitData(fields(now - 90000), TOKEN), TOKEN, 86400, now)).toThrow('expired');
  });
});
