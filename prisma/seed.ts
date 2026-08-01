import 'dotenv/config'
import { AdminRole, BillingInterval, PlanCode } from '@/generated/prisma/enums'
import { db, disconnectDb } from '@/lib/db'
import { hashPassword } from '@/server/auth/crypto'
import { normalizeEmail } from '@/server/auth/email'
import { MIN_PASSWORD_LENGTH } from '@/server/modules/auth/schema'
import { DESTINATIONS, TAG_LABELS } from './seed-data/catalog'

/**
 * Idempotent development seed: one SUPER_ADMIN and one demo traveller, the
 * runtime settings, the five entitlement plans, and the curated catalog.
 *
 * Run with `npm run db:seed`. Prisma 7 no longer runs seeds implicitly after a
 * migration, so this happens only when asked for.
 *
 * Two idempotency strategies, deliberately different:
 *
 *   • Accounts, settings and plans are idempotent by *skipping*. An upsert with
 *     a password in its update branch would silently reset the admin credential
 *     every time anyone ran the seed — including after someone had deliberately
 *     changed it. The same reasoning covers money and configuration: if ops has
 *     edited the USD rate or a plan price in the admin console, re-running the
 *     seed must not quietly revert it. Existing rows are reported and left
 *     exactly as they are.
 *
 *   • The catalog is idempotent by *upserting*, keyed on slug. Destinations and
 *     activities are content this file owns, and correcting a price or an
 *     opening time here has to reach the database without anyone deleting rows
 *     by hand. Child rows are replaced wholesale rather than merged, so
 *     dropping a tag from the seed actually drops it.
 *
 * `dotenv/config` is imported because this may be run as `tsx prisma/seed.ts`
 * directly, without the CLI that would otherwise have loaded `.env`. The seed
 * reaches the database through `@/lib/db`, so a `.env` missing AUTH_USER_SECRET
 * or AUTH_ADMIN_SECRET fails here with the same validation message the server
 * would give. That is the intended behaviour, not an obstacle.
 */

/**
 * `.local` is reserved by RFC 6762 for multicast DNS and never resolves on the
 * public internet, so these defaults cannot accidentally send mail to, or
 * collide with, a real address.
 */
const DEFAULT_ADMIN_EMAIL = 'admin@beyondborders.local'
const DEFAULT_ADMIN_PASSWORD = 'local-dev-admin-password'
const DEFAULT_ADMIN_NAME = 'Beyond Borders Admin'

const DEMO_USER_EMAIL = 'traveller@beyondborders.local'
const DEMO_USER_PASSWORD = 'local-dev-traveller-password'
const DEMO_USER_NAME = 'Demo Traveller'

/**
 * Read a credential from the environment, falling back to a local default.
 *
 * The fallback is refused outside development. A published default password on
 * a SUPER_ADMIN account is not a seeding convenience, it is a backdoor, and the
 * case being guarded against is someone running this against staging "just to
 * get some data in".
 */
function credential(name: string, fallback: string): string {
  const provided = process.env[name]?.trim()
  if (provided) return provided

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${name} must be set outside development. Refusing to seed a well-known default password.`
    )
  }

  return fallback
}

/** Keep seeded accounts usable under the same rule the API enforces. */
function assertUsablePassword(name: string, value: string): void {
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
}

interface SeedResult {
  label: string
  email: string
  detail: string
  created: boolean
}

async function seedAdmin(): Promise<SeedResult> {
  const email = normalizeEmail(credential('SEED_ADMIN_EMAIL', DEFAULT_ADMIN_EMAIL))
  const password = credential('SEED_ADMIN_PASSWORD', DEFAULT_ADMIN_PASSWORD)
  const name = process.env.SEED_ADMIN_NAME?.trim() || DEFAULT_ADMIN_NAME

  assertUsablePassword('SEED_ADMIN_PASSWORD', password)

  const existing = await db.adminUser.findUnique({
    where: { email },
    select: { role: true, status: true },
  })

  if (existing) {
    return {
      label: 'admin',
      email,
      detail: `role=${existing.role} status=${existing.status}`,
      created: false,
    }
  }

  const admin = await db.adminUser.create({
    data: {
      email,
      name,
      passwordHash: await hashPassword(password),
      role: AdminRole.SUPER_ADMIN,
    },
    select: { role: true, status: true },
  })

  return {
    label: 'admin',
    email,
    detail: `role=${admin.role} status=${admin.status}`,
    created: true,
  }
}

async function seedTraveller(): Promise<SeedResult> {
  const email = normalizeEmail(process.env.SEED_USER_EMAIL?.trim() || DEMO_USER_EMAIL)
  const password = credential('SEED_USER_PASSWORD', DEMO_USER_PASSWORD)

  assertUsablePassword('SEED_USER_PASSWORD', password)

  const existing = await db.user.findUnique({
    where: { email },
    select: { status: true },
  })

  if (existing) {
    return {
      label: 'traveller',
      email,
      detail: `status=${existing.status}`,
      created: false,
    }
  }

  const user = await db.user.create({
    data: {
      email,
      name: DEMO_USER_NAME,
      passwordHash: await hashPassword(password),
      // Pre-verified so local work on authenticated flows does not first
      // require a verification email that no provider exists to send yet.
      emailVerifiedAt: new Date(),
    },
    select: { status: true },
  })

  return {
    label: 'traveller',
    email,
    detail: `status=${user.status} emailVerified=true`,
    created: true,
  }
}

function report(result: SeedResult): void {
  const state = result.created ? 'created' : 'already present, left unchanged'
  console.log(`  ${result.label.padEnd(10)} ${result.email}  ${result.detail}  — ${state}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime settings
// ─────────────────────────────────────────────────────────────────────────────

/** A JSON value Prisma will accept into a non-nullable `Json` column. */
type SettingValue =
  string | number | boolean | SettingValue[] | { [key: string]: SettingValue | null }

interface SettingSeed {
  key: string
  value: SettingValue
  description: string
  /** Public settings are served to the website; assume anyone can read them. */
  isPublic: boolean
}

/**
 * Configuration ops can change without a redeploy.
 *
 * No credentials live here. API keys and merchant secrets stay in the
 * environment: this table is editable from the admin console, readable by
 * anyone with database access, and half of it is served to the public web app.
 * A secret in a row that a CONTENT admin can open is not a secret.
 */
const SETTINGS: SettingSeed[] = [
  {
    key: 'bdtPerUsd',
    value: 122,
    description:
      'Taka per 1 USD, maintained by an admin. USD is display-only — every stored amount is whole BDT, and this rate is applied at render time so a rate change never rewrites history.',
    isPublic: true,
  },
  {
    key: 'payments.enabledProviders',
    value: ['MANUAL_BANK'],
    description:
      'Providers currently accepting money. bKash and SSLCommerz are added here once live merchant credentials are issued and a callback has been verified end to end.',
    isPublic: false,
  },
  {
    key: 'payments.bkash',
    value: {
      mode: 'sandbox',
      merchantShortCode: null,
      callbackPath: '/api/v1/payments/bkash/callback',
      intentDefault: 'sale',
    },
    description:
      'bKash Tokenized Checkout settings. App key, app secret, username and password are environment variables, never rows in this table.',
    isPublic: false,
  },
  {
    key: 'payments.sslcommerz',
    value: {
      mode: 'sandbox',
      storeId: null,
      callbackPath: '/api/v1/payments/sslcommerz/callback',
      currency: 'BDT',
    },
    description:
      'SSLCommerz gateway settings. The store password is an environment variable. Every IPN is re-validated against the gateway before a payment is marked SUCCEEDED.',
    isPublic: false,
  },
  {
    key: 'payments.manualBank',
    value: {
      bankName: 'REPLACE BEFORE LAUNCH',
      accountName: 'REPLACE BEFORE LAUNCH',
      accountNumber: '0000-0000-0000',
      branch: 'REPLACE BEFORE LAUNCH',
      routingNumber: '000000000',
      instructions:
        'Transfer the quoted amount and email the deposit slip to accounts@beyondborders.example, quoting your booking reference.',
    },
    description:
      'Bank transfer instructions shown for large trip bookings. Seeded with obvious placeholders on purpose: a plausible-looking fake account number is how travellers wire money into the void.',
    isPublic: true,
  },
  {
    key: 'payments.itineraryUnlockPriceBdt',
    value: 200,
    description:
      'Price of the one-off full-length unlock for a single itinerary. Kept in step with the UNLOCK_SINGLE plan row, which is what the checkout actually charges.',
    isPublic: true,
  },
  {
    key: 'ai.provider',
    value: 'google',
    description:
      'Informational only. The provider actually in force is the `provider` field of the `ai.model` row, because resolveModelSelection() reads ONE row and takes both fields from it. Editing this row alone changes nothing — edit `ai.model`.',
    isPublic: false,
  },
  {
    /*
     * An OBJECT, not a bare model id.
     *
     * `readModelSetting()` in server/ai/provider.ts parses this value with
     * `z.object({ provider?, model? })`. A bare string fails that parse, and the
     * failure path is one `console.warn` followed by a silent fall back to the
     * environment — so a row seeded as `'gemini-2.5-flash'` was not an override
     * that happened to agree with AI_MODEL, it was an override that never
     * applied at all. The single documented way to move off a model without a
     * deploy did nothing, and it did it quietly, which is the worst way for a
     * lever to be broken: from the console it looks set.
     *
     * Both fields live in this one row rather than in two, because that is what
     * the reader supports; see the `ai.provider` note above.
     */
    key: 'ai.model',
    value: { provider: 'google', model: 'gemini-2.5-flash' },
    description:
      'Provider and model used for planner generation, overriding AI_PROVIDER and AI_MODEL. MUST be an object — {"provider":"google","model":"gemini-2.5-flash"}. A bare string is rejected and the environment is silently used instead. Recorded per message on PlannerMessage.',
    isPublic: false,
  },
  {
    key: 'ai.temperature',
    value: 0.4,
    description:
      'Low by design. The planner assembles real inventory against real opening hours; invention is a defect here, not creativity.',
    isPublic: false,
  },
  {
    key: 'ai.maxOutputTokens',
    value: 4096,
    description: 'Hard ceiling per generation, so a runaway response cannot become a runaway bill.',
    isPublic: false,
  },
  {
    key: 'ai.catalogOnly',
    value: true,
    description:
      'The model may only recommend activities that exist in the catalog. Never set this false in production — an invented activity cannot be booked, and its price is fiction.',
    isPublic: false,
  },
  {
    key: 'ai.teaser.enabled',
    value: true,
    description:
      'Whether anonymous visitors get their single teaser reply. Turning this off is the kill switch when AI spend needs to stop immediately.',
    isPublic: false,
  },
  {
    key: 'ai.teaser.promptLimit',
    value: 1,
    description:
      'AI prompts an anonymous visitor gets, ever. Enforced against AnonymousVisitor, which treats a match on cookie, IP hash OR fingerprint hash as the same visitor.',
    isPublic: true,
  },
]

async function seedSettings(): Promise<{ created: number; skipped: number }> {
  let created = 0
  let skipped = 0

  for (const setting of SETTINGS) {
    const existing = await db.setting.findUnique({
      where: { key: setting.key },
      select: { key: true },
    })

    if (existing) {
      skipped += 1
      continue
    }

    await db.setting.create({
      data: {
        key: setting.key,
        value: setting.value,
        description: setting.description,
        isPublic: setting.isPublic,
      },
    })
    created += 1
  }

  return { created, skipped }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entitlement plans
// ─────────────────────────────────────────────────────────────────────────────

interface PlanSeed {
  code: PlanCode
  name: string
  description: string
  priceBdt: number
  interval: BillingInterval
  maxSavedItineraries: number | null
  maxItineraryDays: number | null
  itinerariesPerPeriod: number | null
  aiPromptsPerPeriod: number | null
  sortOrder: number
}

/**
 * The free tier's monthly AI turn allowance, and the floor every one-off tier
 * inherits. Duplicated from FREE_AI_PROMPTS_PER_PERIOD in the entitlement
 * service, which explains the number; the two are checked against each other by
 * `service.test.ts`.
 */
const FREE_AI_PROMPTS = 30

/**
 * How many planner turns a paid itinerary is worth.
 *
 * Fifteen turns per included itinerary, so PREMIUM_10 gets 150 a month. A trip
 * takes three or four turns to shape when it goes well, so this is roughly four
 * times what a subscriber who used their whole allowance would need — generous
 * enough that no paying customer meets the wall, finite enough that a
 * compromised subscription cannot be turned into an unmetered AI endpoint.
 */
const AI_PROMPTS_PER_INCLUDED_ITINERARY = 15

/** null on any limit means unlimited. Enforcement must test for null first. */
const PLANS: PlanSeed[] = [
  {
    code: PlanCode.FREE,
    name: 'Free',
    description:
      'Signed-in planning: itineraries up to 2 days long, and up to 3 of them saved at a time. Everything else needs an unlock or a subscription.',
    priceBdt: 0,
    interval: BillingInterval.NONE,
    maxSavedItineraries: 3,
    maxItineraryDays: 2,
    // Not capped per period: the 3-itinerary ceiling already bounds what a free
    // account may KEEP. What bounds what it may ASK is the column below — a
    // free account with no prompt ceiling is an unmetered model endpoint with a
    // sign-up form in front of it.
    itinerariesPerPeriod: null,
    aiPromptsPerPeriod: FREE_AI_PROMPTS,
    sortOrder: 0,
  },
  {
    code: PlanCode.UNLOCK_SINGLE,
    name: 'Full itinerary unlock',
    description:
      'A one-off 200 BDT purchase that reveals the full length of one specific itinerary, permanently. Not a tier anyone sits on — buying it records an ItineraryUnlock against that itinerary and nothing else changes.',
    priceBdt: 200,
    interval: BillingInterval.NONE,
    // FREE's numbers, deliberately, and not the nulls this row used to carry.
    // What the 200 BDT buys is the ItineraryUnlock row against one itinerary;
    // none of the grant is carried by these columns. Leaving them null meant a
    // payment handler doing the obvious thing on settlement — create a
    // Subscription from upgrade.planCode, which unlockOffer publishes to every
    // client — would have converted one 200 BDT purchase into a permanent
    // account-wide grant of unlimited days AND unlimited saves. The query in
    // service.ts now excludes interval = NONE from every subscription lookup;
    // these values are the second lock on the same door.
    maxSavedItineraries: 3,
    maxItineraryDays: 2,
    itinerariesPerPeriod: null,
    aiPromptsPerPeriod: FREE_AI_PROMPTS,
    sortOrder: 1,
  },
  {
    code: PlanCode.PREMIUM_10,
    name: 'Premium 10',
    description: 'Ten full-length itineraries a month, no day limit, unlimited saved trips.',
    priceBdt: 990,
    interval: BillingInterval.MONTHLY,
    maxSavedItineraries: null,
    maxItineraryDays: null,
    itinerariesPerPeriod: 10,
    aiPromptsPerPeriod: 10 * AI_PROMPTS_PER_INCLUDED_ITINERARY,
    sortOrder: 2,
  },
  {
    code: PlanCode.PREMIUM_50,
    name: 'Premium 50',
    description: 'Fifty full-length itineraries a month. Sized for agents and frequent planners.',
    priceBdt: 2900,
    interval: BillingInterval.MONTHLY,
    maxSavedItineraries: null,
    maxItineraryDays: null,
    itinerariesPerPeriod: 50,
    aiPromptsPerPeriod: 50 * AI_PROMPTS_PER_INCLUDED_ITINERARY,
    sortOrder: 3,
  },
  {
    code: PlanCode.PREMIUM_100,
    name: 'Premium 100',
    description:
      'A hundred full-length itineraries a month, for travel desks planning on behalf of clients.',
    priceBdt: 4900,
    interval: BillingInterval.MONTHLY,
    maxSavedItineraries: null,
    maxItineraryDays: null,
    itinerariesPerPeriod: 100,
    aiPromptsPerPeriod: 100 * AI_PROMPTS_PER_INCLUDED_ITINERARY,
    sortOrder: 4,
  },
]

async function seedPlans(): Promise<{ created: number; skipped: number }> {
  let created = 0
  let skipped = 0

  for (const plan of PLANS) {
    const existing = await db.plan.findUnique({
      where: { code: plan.code },
      select: { code: true },
    })

    if (existing) {
      skipped += 1
      continue
    }

    await db.plan.create({ data: plan })
    created += 1
  }

  return { created, skipped }
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

interface CatalogCounts {
  tags: number
  destinations: number
  activities: number
  openingHours: number
  activityTags: number
}

async function seedCatalog(): Promise<CatalogCounts> {
  const counts: CatalogCounts = {
    tags: 0,
    destinations: 0,
    activities: 0,
    openingHours: 0,
    activityTags: 0,
  }

  for (const [slug, label] of Object.entries(TAG_LABELS)) {
    await db.tag.upsert({ where: { slug }, update: { label }, create: { slug, label } })
    counts.tags += 1
  }

  const tagRows = await db.tag.findMany({ select: { id: true, slug: true } })
  const tagIdBySlug = new Map(tagRows.map((tag) => [tag.slug, tag.id]))

  /** A tag slug on an activity that is not in TAG_LABELS is a typo, and a typo
   *  that silently creates a new tag fragments the interest vocabulary the
   *  planner matches against. Fail loudly instead. */
  function tagId(slug: string, activitySlug: string): string {
    const id = tagIdBySlug.get(slug)
    if (!id) {
      throw new Error(
        `Activity "${activitySlug}" references unknown tag "${slug}". Add it to TAG_LABELS.`
      )
    }
    return id
  }

  for (const destination of DESTINATIONS) {
    const destinationFields = {
      name: destination.name,
      country: destination.country,
      region: destination.region,
      summary: destination.summary,
      timezone: destination.timezone,
      latitude: destination.latitude,
      longitude: destination.longitude,
      sortOrder: destination.sortOrder,
      isActive: true,
    }

    const { id: destinationId } = await db.destination.upsert({
      where: { slug: destination.slug },
      update: destinationFields,
      create: { slug: destination.slug, ...destinationFields },
      select: { id: true },
    })
    counts.destinations += 1

    for (const [index, activity] of destination.activities.entries()) {
      const activityFields = {
        destinationId,
        name: activity.name,
        summary: activity.summary,
        description: activity.description,
        category: activity.category,
        durationMinutes: activity.durationMinutes,
        pricePerPersonBdt: activity.pricePerPersonBdt,
        priceNote: activity.priceNote,
        latitude: activity.latitude,
        longitude: activity.longitude,
        bestTimeOfDay: activity.bestTimeOfDay,
        minPartySize: activity.minPartySize,
        maxPartySize: activity.maxPartySize,
        intensity: activity.intensity,
        bookingRequired: activity.bookingRequired,
        sourceUrl: activity.sourceUrl,
        isActive: true,
        // Position within its destination, so the catalog listing has a stable
        // curated order rather than whatever the database returns.
        sortOrder: index,
      }

      const { id: activityId } = await db.activity.upsert({
        where: { slug: activity.slug },
        update: activityFields,
        create: { slug: activity.slug, ...activityFields },
        select: { id: true },
      })
      counts.activities += 1

      // Children are replaced, not merged: a merge would leave a tag or an
      // opening window behind after it had been deleted from the seed, and the
      // planner would keep scheduling against hours that no longer apply.
      await db.activityTag.deleteMany({ where: { activityId } })
      if (activity.tags.length > 0) {
        await db.activityTag.createMany({
          data: activity.tags.map((slug) => ({ activityId, tagId: tagId(slug, activity.slug) })),
        })
        counts.activityTags += activity.tags.length
      }

      await db.activityOpeningHours.deleteMany({ where: { activityId } })
      if (activity.openingHours.length > 0) {
        await db.activityOpeningHours.createMany({
          data: activity.openingHours.map((window) => ({ activityId, ...window })),
        })
        counts.openingHours += activity.openingHours.length
      }
    }
  }

  return counts
}

async function main(): Promise<void> {
  console.log('Seeding Beyond Borders…')

  console.log('\nAccounts')
  report(await seedAdmin())
  report(await seedTraveller())

  console.log('\nConfiguration')
  const settings = await seedSettings()
  console.log(`  settings   ${settings.created} created, ${settings.skipped} already present`)
  const plans = await seedPlans()
  console.log(`  plans      ${plans.created} created, ${plans.skipped} already present`)

  console.log('\nCatalog')
  const catalog = await seedCatalog()
  console.log(`  tags            ${catalog.tags}`)
  console.log(`  destinations    ${catalog.destinations}`)
  console.log(`  activities      ${catalog.activities}`)
  console.log(`  activity tags   ${catalog.activityTags}`)
  console.log(`  opening hours   ${catalog.openingHours}`)

  // Read the totals back rather than trusting the counters above: the point of
  // the check is to catch a write that did not land.
  const [tags, destinations, activities, activityTags, openingHours, planRows, settingRows] =
    await Promise.all([
      db.tag.count(),
      db.destination.count(),
      db.activity.count(),
      db.activityTag.count(),
      db.activityOpeningHours.count(),
      db.plan.count(),
      db.setting.count(),
    ])

  console.log('\nRow counts in the database')
  console.log(
    `  settings=${settingRows} plans=${planRows} tags=${tags} destinations=${destinations} ` +
      `activities=${activities} activity_tags=${activityTags} opening_hours=${openingHours}`
  )

  // Passwords are never printed. Echoing one here would copy a live credential
  // into terminal scrollback and into CI logs, which is exactly where
  // credentials get harvested from.
  console.log(
    '\nPasswords are not shown. Set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD to choose them;\n' +
      'otherwise the local development defaults documented at the top of prisma/seed.ts apply.'
  )
}

main()
  .catch((e: unknown) => {
    console.error('\nSeed failed:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDb()
  })
