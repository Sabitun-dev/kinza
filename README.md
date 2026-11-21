# KINZA DISTRO

Telegram Mini App + bot for a beverage distribution business (Kinza drinks, Namangan).

The full setup guide, user guide and restore steps are added in the last build phase.

## Quick commands

```bash
npm install          # install
npm run typecheck    # check types
npm test             # run all tests (in-memory Postgres, no setup needed)
npm run build        # build the Mini App into public/app
```

## Folders

| Folder | What is inside |
|---|---|
| `webapp/` | The Mini App (React + Vite + Tailwind) |
| `src/` | Business logic, API, bot, PDFs (plain TypeScript modules) |
| `src/shared/` | Code used by both app and server (money, quantities, dates, texts) |
| `netlify/functions/` | `api`, `telegram` (webhook), `scheduler` (every 15 min), `setup` |
| `prisma/` | Database schema and migrations |
| `tests/` | Vitest tests |
