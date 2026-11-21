import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Migrations use the direct (unpooled) Neon connection.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx scripts/seed.ts' },
  datasource: {
    url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/kinza',
  },
});
