import { afterEach } from 'vitest';
import { closeTestDbs } from './db.ts';

afterEach(async () => {
  await closeTestDbs();
});
