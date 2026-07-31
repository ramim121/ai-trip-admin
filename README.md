# Beyond Borders — Admin Console & API

The backend of record for the Beyond Borders travel platform. This repository owns the PostgreSQL database, every migration, all business logic, the staff console, and the versioned `/api/v1` REST API.

The [public website](https://github.com/ramim121/ai-trip) is a separate repository with **no database access** — it consumes this API, as will a future mobile app.

**→ [SETUP.md](./SETUP.md) has the full setup guide for both projects.**

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL, two auth secrets, Gemini key
npx prisma generate
npx prisma migrate deploy
npm run db:seed
npm run dev               # http://localhost:3001
```

## What's here

- **Auth** — argon2id passwords, audience-separated JWTs, rotating refresh tokens with family-wide reuse detection and an absolute session ceiling. Travellers and staff live in separate tables with separate signing secrets; there is deliberately no `isAdmin` flag on a user.
- **Entitlements** — plans, subscriptions, per-itinerary unlocks, usage counters. Every limit is enforced server-side through atomic conditional claims, never from a client-supplied flag.
- **Catalog** — destinations and activities with opening hours, tags, durations and BDT prices. This is what the AI is grounded on.
- **AI planner** — Gemini via the Vercel AI SDK, tool-grounded so it can only recommend activities that exist in the catalog. Prompt-injection isolation, per-session token budgets, and rate limiting.
- **OpenAPI** — every endpoint registered and emitted to `openapi/v1.json`, which the web repo codegens its typed client from.

## Stack

Next.js 16 · React 19 · Prisma 7 · PostgreSQL · Tailwind v4 · Zod v4 · Vitest · Playwright

> **Next.js 16 and Prisma 7 both introduced breaking changes.** `middleware.ts` is now `proxy.ts`; `cookies()`/`headers()`/`params` are async-only; Prisma needs an explicit driver adapter and generates into `src/generated/`. See [AGENTS.md](./AGENTS.md) and the bundled docs in `node_modules/next/dist/docs/`.

## Commands

```bash
npm run dev            npm run build          npm run typecheck
npm run lint           npm run format:check   npm test
npm run db:seed        npm run openapi:write  npx prisma studio
```
