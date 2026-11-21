// Applies database migrations during the Netlify build, but only for the production deploy.
// Deploy previews and branch deploys never touch the production database.
import { execSync } from 'node:child_process';

if (process.env.CONTEXT === 'production') {
  if (!process.env.DATABASE_URL_UNPOOLED && !process.env.DATABASE_URL) {
    console.error('DATABASE_URL_UNPOOLED is missing. Set it in Netlify environment variables.');
    process.exit(1);
  }
  console.log('Production build: applying migrations…');
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
} else {
  console.log(`Build context "${process.env.CONTEXT ?? 'local'}": skipping migrations.`);
}
