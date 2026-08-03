# Beyond Borders — Setup Guide

AI-assisted trip planning for a Bangladesh-based travel company. The product is **two separate repositories** that talk over HTTP:

| Repo                                                         | What it is                                   | Port   | Owns the database?                               |
| ------------------------------------------------------------ | -------------------------------------------- | ------ | ------------------------------------------------ |
| [`ai-trip-admin`](https://github.com/ramim121/ai-trip-admin) | Staff console **and** the `/api/v1` REST API | `3001` | **Yes** — schema, migrations, all business logic |
| [`ai-trip`](https://github.com/ramim121/ai-trip)             | Public website                               | `3000` | **No** — never connects to Postgres              |

The public site holds no database credentials. Every read and write goes through `/api/v1`, which is also the API a future mobile app will use. That is the whole reason for the split, so please don't "simplify" it by giving the web app a Prisma client.

This file is committed to both repositories and is identical in each.

---

## 1. Prerequisites

- **Node.js 20.9+** (developed on 22.17). Next.js 16 requires 20.9 as a hard minimum.
- **PostgreSQL 14+** (developed on 18.4).
- **npm** — the lockfiles are npm lockfiles. pnpm/yarn will work but will produce a different lockfile; don't commit that.
- **Git**.

> **A note on versions.** This project runs **Next.js 16** and **Prisma 7**, both of which changed things you may have muscle memory for: `middleware.ts` is now `proxy.ts`, `cookies()`/`headers()`/`params` are async-only, and Prisma requires an explicit driver adapter with the client generated into `src/generated/`. Each repo ships an `AGENTS.md` pointing at the bundled docs in `node_modules/next/dist/docs/`. Read those before writing framework code rather than relying on recall.

---

## 2. Database

Create the database once. Any Postgres will do — local, Docker, or hosted.

```bash
psql -U postgres -c "CREATE DATABASE beyond_borders;"
```

**If your password contains `#`, `@`, `/`, `:` or `?`, percent-encode it in the connection string.** A raw `#` truncates the URL and Postgres silently receives the wrong password — a password of `Pa55w#rd` must be written `Pa55w%23rd`. This costs people an hour more often than it should.

---

## 3. Admin / API — `ai-trip-admin`

```bash
git clone https://github.com/ramim121/ai-trip-admin.git
cd ai-trip-admin
npm install
cp .env.example .env
```

Fill in `.env`:

```bash
DATABASE_URL="postgresql://postgres:YOUR%23PASSWORD@localhost:5432/beyond_borders?schema=public"

# Two DIFFERENT secrets — the app refuses to boot if they match.
# Generate each with:  openssl rand -base64 48
AUTH_USER_SECRET="…"
AUTH_ADMIN_SECRET="…"

# Google AI Studio key. Free tier is fine for development.
GOOGLE_GENERATIVE_AI_API_KEY="…"

# Optional. Powers the catalogue import screen at /places; without it that
# screen says so and nothing else changes. A SEPARATE key from the one above —
# different Google product, different quota, and one key for both means
# rotating either takes down the other. Enable "Places API (New)".
GOOGLE_PLACES_API_KEY="…"
```

Travellers and staff are signed with **separate secrets** deliberately: a stolen traveller token must be unverifiable against an admin route even if someone forgets an audience check. Rotating one does not log out the other.

Then:

```bash
npx prisma generate          # emits the client into src/generated/prisma
npx prisma migrate deploy    # applies migrations (use `migrate dev` when authoring new ones)
npm run db:seed              # plans, destinations, activities, one admin, one demo traveller
npm run dev                  # http://localhost:3001
```

### Seeded accounts

| Role        | Email                           | Password                       |
| ----------- | ------------------------------- | ------------------------------ |
| Super admin | `admin@beyondborders.local`     | `local-dev-admin-password`     |
| Traveller   | `traveller@beyondborders.local` | `local-dev-traveller-password` |

Override with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_USER_PASSWORD`. **Change these before any deployment reachable from outside your machine.** The seed is idempotent — re-running reports `already present` rather than duplicating.

### `TRUSTED_PROXY_HOPS` — read this before deploying

Defaults to `0`, meaning "trust nothing, resolve no client IP". That is correct when the process is reached directly, and it is the safe direction to be wrong in.

Set it to the number of reverse proxies **you** operate in front of the app: `1` behind a single nginx, `2` behind Cloudflare in front of nginx. Proxies _append_ the peer they saw to the right of `X-Forwarded-For`, so this count is the only thing separating the part of that header an attacker wrote from the part you did. Set it **too high** and no IP resolves (a short chain is refused outright — annoying but safe). Set it **too low** and the anonymous quota is keyed on an address the caller typed, which is free rein over your AI spend. Count the hops; don't guess.

---

## 4. Public website — `ai-trip`

Start the admin API first — the web app is useless without it.

```bash
git clone https://github.com/ramim121/ai-trip.git
cd ai-trip
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

```bash
API_BASE_URL="http://localhost:3001"          # server-side only; never NEXT_PUBLIC_*
SESSION_COOKIE_SECRET="…"                     # openssl rand -base64 48
```

`API_BASE_URL` must never be exposed as `NEXT_PUBLIC_*`. The browser talks only to this app's own `/api/session/*` and `/api/planner/*` routes, which attach tokens server-side and set them as `httpOnly` cookies. Access and refresh tokens never reach client JavaScript.

```bash
npm run gen:api    # regenerates the typed client from the admin OpenAPI spec
npm run dev        # http://localhost:3000
```

### Keeping the two repos in sync

Separate repos mean no shared package, so the contract is **generated rather than remembered**:

1. Admin defines every request/response as a Zod schema.
2. Those compile to an OpenAPI 3.1 document, served at `/api/openapi.json` and written to `openapi/v1.json`.
3. Web runs `npm run gen:api` to codegen `src/lib/api/generated/schema.d.ts`.
4. CI regenerates and **fails on any diff**.

So a breaking API change turns the web build red instead of turning up in production. After changing any admin endpoint: run `npm run openapi:write` in admin, then `npm run gen:api` in web, and commit both.

---

## 5. Everyday commands

Both repos:

```bash
npm run dev           # dev server
npm run build         # production build
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier
npm test              # vitest
npm run test:e2e      # playwright (run `npx playwright install` once first)
```

Admin only:

```bash
npm run db:seed        # idempotent
npm run openapi:write  # regenerate openapi/v1.json
npx prisma studio      # browse the database
npx prisma migrate dev --name your_change   # author a migration
```

---

## 6. How the pieces fit

**Auth.** The API issues a short-lived access token (15 min) and a rotating refresh token (30 days). Refresh tokens are stored only as SHA-256 hashes and rotate on every use; each login forms a _family_. Presenting an already-rotated token proves a duplicate exists, so the whole family is revoked and both parties must log in again. A `familyExpiresAt` ceiling means no amount of diligent refreshing extends a session forever.

**Entitlements.** Every limit is enforced **server-side**, never from a client-supplied flag:

|                     | Free   | Premium 5 — ৳500/mo | Premium 100 — ৳5,000/mo |
| ------------------- | ------ | ------------------- | ----------------------- |
| Itinerary length    | 2 days | unlimited           | unlimited               |
| Saved itineraries   | 3      | unlimited           | unlimited               |
| Itineraries / month | —      | 5                   | 100                     |

Those are the live rows today, not constants: prices and limits are edited in the console and `/pricing` reads them on every request, so nothing here is baked into code.

There were once a one-off 200 BDT "unlock this itinerary" purchase and 10/50/100 monthly tiers. Both are gone — `PlanCode` is now `FREE | PREMIUM_5 | PREMIUM_100`, the `ItineraryUnlock` model and the `itineraries.isFullyUnlocked` column were dropped.

**Unlimited accounts.** `users.unlimited` exempts one account from every ceiling — length, saved count, monthly volume and AI prompts. A database flag rather than an env allowlist, so it can be granted without a deploy, and it is read inside the same query that computes the entitlement so nothing downstream needs to know about it.

Anonymous visitors get exactly **one** AI preview, identified by signed cookie + hashed IP + device fingerprint. The teaser response is cached on the normalised questionnaire answers, so bypass attempts mostly hit cache and cost nothing.

**The AI is grounded, not free-associating.** It may only recommend activities returned by its catalog tools. Inventing a venue is treated as a hard failure, because you cannot sell, price, or honour something that isn't in your inventory. The system prompt is built exclusively from data you authored — a traveller's typed destination goes into a separate sanitised user-role message that is explicitly framed as untrusted, never into the system prompt.

**Money is BDT, stored as integer taka.** Never floats. USD is display-only via an admin-set rate.

**Quotations — how a bespoke trip gets priced.** A traveller saves a trip and asks for a quote; it appears in `/quotes`, oldest first; somebody prices it by hand and sends it; the traveller accepts or declines.

Four rules make the loop safe, and three of them live in the database rather than in the service:

- **A price somebody has seen is immutable.** Sending stamps `sentAt`, and a trigger then refuses every change to that revision. A correction has to be a new version.
- **A draft is invisible.** `readMyQuote` and `listMyQuotes` filter out any revision with a null `sentAt`, because ops drafts numbers before agreeing to stand behind them.
- **One open quote per trip**, enforced by a partial unique index — asking twice while a conversation is open is the same conversation. `withdrawQuote` is the release valve; without it a request nobody can price would lock a traveller out of their own itinerary forever.
- **The total is computed, never accepted.** Subtotal and discount go in; a CHECK constraint refuses a row where `total ≠ subtotal − discount`.

A quote can only be asked for on a **saved** trip. Requesting sets the itinerary to `SUBMITTED`, which counts against the saved-trip cap, so accepting a DRAFT would be a way around `POST /save`.

**Promo codes** are created and edited at `/coupons` by OPS. There is no delete — `coupon_redemptions` cascades, and that history is what you need when somebody says a discount was promised, so switching a code off is the whole of "stop it". The ceiling is enforced by counting redemption **rows**; `redeemedCount` is a denormalised counter for the list view and the console flags loudly if the two ever disagree.

**Place imports — how the catalogue grows.** `/places` searches Google Places and queues what comes back. A curator opens one, writes it up, and approves it; approving creates a real activity through the same `createActivity` the hand-authored path uses.

The curation step is structural rather than procedural. Imports land in `place_candidates`, a table the planner cannot read — `itinerary_blocks.activityId` is a foreign key into `activities`, so a candidate is incapable of appearing in a trip whatever anybody forgets to check. Approval _inserts_ into `activities`; it never flips a flag on a row that was already visible.

A human is not optional here because Google answers "does this place exist, and where", while an activity has to answer "what is it, how long does it take, what does it cost in taka, and when is it worth doing" — the four things a planned day is made of, and Places carries none of them. Google's own text is shown beside the form and never pre-filled into it: their one-liner is written for a map pin, and copying it would put their content in our catalogue.

One row per `googlePlaceId`, which is what makes a rejection stick — without it, re-running a search would re-queue something already turned down. Rejections carry a required reason and can be reopened, because judgements age.

`GOOGLE_PLACES_API_KEY` is optional; without it the screen says so and nothing else changes. It is **server-side only** — never `NEXT_PUBLIC_*`, because a Places key in a browser bundle is a key anybody can spend. Enable **Places API (New)** in Google Cloud rather than the legacy Places API; the client falls back to legacy when New is refused, but legacy is closed to new projects and will eventually stop.

**Manual blocks.** A traveller can put a hotel, meal, rest or free hour on any day by hand. Anything added that way is created `isLocked: true`, because Rebuild-day deletes every unpinned block before re-planning — an unlocked hand-typed hotel would silently vanish. The lock on each block is a toggle, so it can be released deliberately. Note that the conflict engine only inspects `ACTIVITY` blocks, so a manual block laid over an activity reports no clash.

---

## 7. Restoring the agent tooling (optional)

`.agents/`, `.claude/`, `.windsurf/` and `skills-lock.json` are gitignored. They hold Prisma's official agent skill docs, and `.claude/skills/*` are **symlinks** into `.agents/` — git on Windows checks those out as text files containing a dead path, so committing them would hand every collaborator broken links.

Restore locally with `npx prisma init` (it re-installs the skill set and leaves your existing schema alone). Nothing in the application reads them.

---

## 8. Testing purchases — the sandbox gateway

Real payments are not connected. A **mock provider** stands in so the whole purchase flow is testable end to end: checkout, a simulated gateway screen, settlement, and the entitlement actually being granted.

```bash
PAYMENTS_MOCK_ENABLED=true      # default true in development
```

Buy a plan anywhere in the UI and you land on a simulated gateway page carrying an unmissable **TEST MODE** banner, with Pay / Decline / Cancel buttons. Paying grants the real entitlement — the subscription becomes active and the ceilings lift — so you can exercise every downstream path without moving money.

**It cannot quietly reach production.** Two independent flags guard it: the mock provider refuses to initiate _or_ settle when `NODE_ENV=production` unless `PAYMENTS_ALLOW_MOCK_IN_PRODUCTION=true` is also set. One flag is too easy to flip by accident. Every mock payment is stored with `isTest = true` and badged in the admin payments list, so test rows can never be mistaken for revenue.

To go live, implement `PaymentProvider` for bKash or SSLCommerz and register it. No business logic changes — that is what the interface is for.

## 9. Known gaps

- **No real payment gateway.** See §8. bKash/SSLCommerz need merchant credentials; the sandbox provider covers testing until then.
- **No transactional email.** Password-reset and verification tokens are created correctly but not delivered; in development the reset link is logged to the server console.
- **Playwright browsers are not installed** by `npm install`. Run `npx playwright install` before `npm run test:e2e`.
- **Testimonial portraits are intentionally empty.** `IMAGE_SLOTS.testimonial*` render placeholders. Fill them only with photographs of real travellers who gave permission — a generated face beside a customer quote invents a customer.
- **Prompt versions are not persisted.** `PlannerMessage` records the model but not which prompt version produced the turn, so stored conversations are attributable only by timestamp. Adding a `promptVersion` column would close it.
- **Quotes never expire on their own.** `QuoteStatus.EXPIRED` exists in the enum and nothing writes it: there is no scheduled job, so a revision past its `validUntil` keeps status `SENT` and stays acceptable. The traveller's UI compares the date itself and says the price may no longer stand, but the API would still take the decision. A cron flipping stale quotes to `EXPIRED` would close it.
- **The conflict engine only sees `ACTIVITY` blocks.** Overlap, travel-gap and opening-hours checks all filter to that kind, so a manually added hotel or meal placed over an activity reports no clash — and inserting one between two activities suppresses the travel-time warning that used to sit between them, because `syncTransitBlocks` only plans transfers between adjacent activities.
- **Ops screens have no API.** Pricing, sending and withdrawing a quote, and every coupon write, happen through server actions rather than `/api/v1`. That is deliberate — the console is server-rendered with no client JavaScript, so it needs no endpoint — but it means a future mobile ops app would need those routes written.
- **`CouponRedemption.userId` is `SetNull`.** Deleting a user nulls their redemption rows, so the per-account ceiling (`maxPerUser`) stops counting their past use while the total ceiling is unaffected. Rare, but it is a real way to regain a per-account allowance.

## 10. Security posture

Two adversarial review passes have run against this code, each followed by independent verifiers who were told to assume the fixes were broken and to attack them.

The first pass found 11 defects — including a prompt-injection path where a client-supplied destination reached the system message, a saved-itinerary cap beatable by concurrent requests, and an anonymous quota keyed on an attacker-writable header. All 11 were fixed; verifiers then confirmed 10 closed by tracing the code, and the remaining one plus two new findings were fixed afterwards.

Currently closed and verified: system-prompt isolation (including the model's own write-back path), atomic quota claims under concurrency, trusted-proxy IP resolution, cross-audience token rejection, per-turn token budgets, and payment settlement idempotency.

Worth knowing if you deploy this:

- Set `TRUSTED_PROXY_HOPS` correctly (§3). Too low hands the anonymous quota key back to the caller.
- Change the seeded credentials (§3).
- The anonymous quota is deliberately defence-in-depth rather than airtight — cookie, hashed IP and device fingerprint, plus a normalised teaser cache so bypass attempts mostly cost nothing, plus a rate limit that does not depend on visitor identity at all.
