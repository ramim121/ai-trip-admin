import 'dotenv/config'
import {
  AdminRole,
  BillingInterval,
  ModerationStatus,
  PackageStatus,
  CouponType,
  PastTripStatus,
  PlanCode,
  type ReviewDimension,
} from '@/generated/prisma/enums'
import { db, disconnectDb } from '@/lib/db'
import { hashPassword } from '@/server/auth/crypto'
import { normalizeEmail } from '@/server/auth/email'
import { MIN_PASSWORD_LENGTH } from '@/server/modules/auth/schema'
import { DESTINATIONS, TAG_LABELS } from './seed-data/catalog'
import { PACKAGES, POLLS, TRIP_LEADERS } from './seed-data/discover'
import { SOUTH_ASIA_PACKAGES } from './seed-data/packages-south-asia'
import { PAST_TRIPS, REVIEWERS } from './seed-data/past-trips'

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

interface DiscoverCounts {
  leaders: number
  packages: number
  departures: number
  days: number
  items: number
  assignments: number
  polls: number
  pollOptions: number
}

/**
 * A calendar date `days` from now, at UTC midnight.
 *
 * Departures are seeded relative to the run rather than as fixed dates. A seed
 * with hard-coded dates quietly stops having any upcoming departures a few
 * months after it is written, and Discover then shows a catalogue of trips that
 * all appear to have already run.
 */
function dateInDays(days: number): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days))
}

/**
 * The Discover catalogue: trips, the people who run them, and the poll.
 *
 * Upsert-keyed on slug, like the catalog and for the same reason — this content
 * is owned by the seed, so correcting a price here has to reach the database
 * without anyone deleting rows by hand.
 *
 * Two different treatments of child rows, and the difference matters:
 *
 *   • Itinerary days, their items and the leader assignments are REPLACED
 *     wholesale. They are pure content, so dropping a day from the seed has to
 *     actually drop it — a merge would leave yesterday's day 4 behind forever.
 *
 *   • Departures and poll options are upserted in place, never deleted. Both
 *     carry state the seed does not own: `seatsTaken` on a departure is real
 *     bookings, and `voteCount` on an option is real votes. Replacing them would
 *     silently reset both, which is a data-loss bug wearing the costume of an
 *     idempotent seed.
 */
async function seedDiscover(): Promise<DiscoverCounts> {
  const counts: DiscoverCounts = {
    leaders: 0,
    packages: 0,
    departures: 0,
    days: 0,
    items: 0,
    assignments: 0,
    polls: 0,
    pollOptions: 0,
  }

  const leaderIdBySlug = new Map<string, string>()

  for (const leader of TRIP_LEADERS) {
    const fields = {
      name: leader.name,
      role: leader.role,
      headline: leader.headline,
      bio: leader.bio,
      yearsExperience: leader.yearsExperience,
      tripsLed: leader.tripsLed,
      languages: leader.languages,
      sortOrder: leader.sortOrder,
      isActive: true,
    }

    const { id } = await db.tripLeader.upsert({
      where: { slug: leader.slug },
      update: fields,
      create: { slug: leader.slug, ...fields },
      select: { id: true },
    })

    leaderIdBySlug.set(leader.slug, id)
    counts.leaders += 1
  }

  const destinations = await db.destination.findMany({ select: { id: true, slug: true } })
  const destinationIdBySlug = new Map(destinations.map((row) => [row.slug, row.id]))

  for (const pkg of [...PACKAGES, ...SOUTH_ASIA_PACKAGES]) {
    // A destination slug that resolves to nothing is a typo, and a typo that
    // silently seeds `destinationId: null` produces a package that renders
    // correctly and has quietly lost its link to the planner's inventory.
    let destinationId: string | null = null
    if (pkg.destinationSlug !== undefined) {
      const resolved = destinationIdBySlug.get(pkg.destinationSlug)
      if (resolved === undefined) {
        throw new Error(
          `Package "${pkg.slug}" references unknown destination "${pkg.destinationSlug}".`
        )
      }
      destinationId = resolved
    }

    const fields = {
      title: pkg.title,
      summary: pkg.summary,
      description: pkg.description,
      scope: pkg.scope,
      kind: pkg.kind,
      pricingMode: pkg.pricingMode,
      destinationId,
      destinationLabel: pkg.destinationLabel,
      country: pkg.country,
      durationDays: pkg.durationDays,
      durationNights: pkg.durationNights,
      priceFromBdt: pkg.priceFromBdt ?? null,
      priceToBdt: pkg.priceToBdt ?? null,
      groupSizeMin: pkg.groupSizeMin ?? null,
      groupSizeMax: pkg.groupSizeMax ?? null,
      highlights: pkg.highlights,
      inclusions: pkg.inclusions,
      exclusions: pkg.exclusions,
      status: pkg.status,
      publishedAt: pkg.status === PackageStatus.PUBLISHED ? new Date() : null,
      sortOrder: pkg.sortOrder,
      metaTitle: `${pkg.title} · Beyond Borders`,
      metaDescription: pkg.metaDescription,
    }

    const { id: packageId } = await db.travelPackage.upsert({
      where: { slug: pkg.slug },
      update: fields,
      create: { slug: pkg.slug, ...fields },
      select: { id: true },
    })
    counts.packages += 1

    // Content: replaced wholesale. Cascade takes the items with the days.
    await db.packageItineraryDay.deleteMany({ where: { packageId } })
    for (const day of pkg.days) {
      const { id: dayId } = await db.packageItineraryDay.create({
        data: {
          packageId,
          dayNumber: day.dayNumber,
          title: day.title,
          summary: day.summary ?? null,
          accommodation: day.accommodation ?? null,
          meals: day.meals,
        },
        select: { id: true },
      })
      counts.days += 1

      if (day.items.length > 0) {
        await db.packageItineraryItem.createMany({
          data: day.items.map((item, index) => ({
            dayId,
            kind: item.kind,
            title: item.title,
            detail: item.detail ?? null,
            startMinute: item.startMinute ?? null,
            durationMinutes: item.durationMinutes ?? null,
            position: index,
          })),
        })
        counts.items += day.items.length
      }
    }

    await db.packageLeader.deleteMany({ where: { packageId } })
    for (const [index, assignment] of pkg.leaders.entries()) {
      const leaderId = leaderIdBySlug.get(assignment.slug)
      if (leaderId === undefined) {
        throw new Error(`Package "${pkg.slug}" references unknown leader "${assignment.slug}".`)
      }

      await db.packageLeader.create({
        data: {
          packageId,
          leaderId,
          role: assignment.role,
          isPrimary: assignment.isPrimary === true,
          sortOrder: index,
        },
        select: { id: true },
      })
      counts.assignments += 1
    }

    // State: upserted, never deleted. `seatsTaken` is real bookings.
    for (const departure of pkg.departures) {
      const startDate = dateInDays(departure.startsInDays)
      const endDate = dateInDays(departure.startsInDays + departure.nights)

      await db.packageDeparture.upsert({
        where: { packageId_startDate: { packageId, startDate } },
        // `seatsTaken` is deliberately absent from the update branch. Re-running
        // the seed must not reset a departure that has since sold seats.
        update: {
          endDate,
          capacity: departure.capacity,
          priceBdt: departure.priceBdt ?? null,
          status: departure.status,
          notes: departure.notes ?? null,
        },
        create: {
          packageId,
          startDate,
          endDate,
          capacity: departure.capacity,
          seatsTaken: departure.seatsTaken,
          priceBdt: departure.priceBdt ?? null,
          status: departure.status,
          notes: departure.notes ?? null,
        },
        select: { id: true },
      })
      counts.departures += 1
    }
  }

  for (const poll of POLLS) {
    const fields = {
      question: poll.question,
      description: poll.description,
      status: poll.status,
      closesAt: dateInDays(poll.closesInDays),
      showResultsBeforeVote: poll.showResultsBeforeVote,
      sortOrder: poll.sortOrder,
    }

    const { id: pollId } = await db.poll.upsert({
      where: { slug: poll.slug },
      update: fields,
      create: { slug: poll.slug, ...fields },
      select: { id: true },
    })
    counts.polls += 1

    // Options are matched on label rather than replaced. `voteCount` is real
    // votes, and PollVote rows point at these ids — deleting and recreating
    // would cascade the votes away and reset the poll on every seed run.
    for (const option of poll.options) {
      const existing = await db.pollOption.findFirst({
        where: { pollId, label: option.label },
        select: { id: true },
      })

      if (existing === null) {
        await db.pollOption.create({
          data: {
            pollId,
            label: option.label,
            subtitle: option.subtitle,
            sortOrder: option.sortOrder,
          },
          select: { id: true },
        })
      } else {
        await db.pollOption.update({
          where: { id: existing.id },
          data: { subtitle: option.subtitle, sortOrder: option.sortOrder },
          select: { id: true },
        })
      }
      counts.pollOptions += 1
    }
  }

  return counts
}

interface PastTripCounts {
  reviewers: number
  trips: number
  leaders: number
  participants: number
  highlights: number
  media: number
  reviews: number
  ratings: number
}

/**
 * The trips we have already run, and what people said about them.
 *
 * Two idempotency strategies again, and the split is the same one the rest of
 * this file makes. The trip and its content are upserted — the seed owns them.
 * The reviewer ACCOUNTS are skipped if present, because they carry password
 * hashes, and an upsert with a password in its update branch silently resets a
 * credential somebody may have deliberately changed.
 *
 * Reviews are seeded APPROVED with a `reviewedAt`, which the migration's CHECK
 * requires of any decided row. That is the one place this seed writes a
 * moderation outcome without a human behind it, and it is confined to content
 * this file authored: nothing here approves anything a traveller submitted.
 */
async function seedPastTrips(): Promise<PastTripCounts> {
  const counts: PastTripCounts = {
    reviewers: 0,
    trips: 0,
    leaders: 0,
    participants: 0,
    highlights: 0,
    media: 0,
    reviews: 0,
    ratings: 0,
  }

  const password = credential('SEED_USER_PASSWORD', DEMO_USER_PASSWORD)
  assertUsablePassword('SEED_USER_PASSWORD', password)

  const userIdByEmail = new Map<string, string>()

  for (const reviewer of REVIEWERS) {
    const email = normalizeEmail(reviewer.email)

    const existing = await db.user.findUnique({ where: { email }, select: { id: true } })
    if (existing !== null) {
      userIdByEmail.set(email, existing.id)
      continue
    }

    const created = await db.user.create({
      data: {
        email,
        name: reviewer.name,
        passwordHash: await hashPassword(password),
        // Pre-verified for the same reason the demo traveller is: local work on
        // authenticated flows should not first need an email nobody can send.
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    })

    userIdByEmail.set(email, created.id)
    counts.reviewers += 1
  }

  const leaders = await db.tripLeader.findMany({ select: { id: true, slug: true } })
  const leaderIdBySlug = new Map(leaders.map((row) => [row.slug, row.id]))

  const packages = await db.travelPackage.findMany({ select: { id: true, slug: true } })
  const packageIdBySlug = new Map(packages.map((row) => [row.slug, row.id]))

  const now = new Date()

  /**
   * `YYYY-MM-DD` as a `@db.Date`.
   *
   * Fixed dates, unlike a departure's. A past trip only ever has to be in the
   * past and already is, so relative dates bought nothing and cost the one
   * thing that mattered: the month in a trip's title drifting away from the
   * month on its page every time somebody reseeded.
   */
  const calendarDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`)

  for (const trip of PAST_TRIPS) {
    // A package slug that resolves to nothing is a typo, and a typo that
    // silently seeds `packageId: null` produces a trip that renders correctly
    // and has quietly lost its link to what we still sell.
    let packageId: string | null = null
    if (trip.packageSlug !== undefined) {
      const resolved = packageIdBySlug.get(trip.packageSlug)
      if (resolved === undefined) {
        throw new Error(
          `Past trip "${trip.slug}" references unknown package "${trip.packageSlug}".`
        )
      }
      packageId = resolved
    }

    const startDate = calendarDate(trip.startDate)
    const endDate = calendarDate(trip.endDate)

    const fields = {
      title: trip.title,
      summary: trip.summary,
      story: trip.story,
      packageId,
      destinationLabel: trip.destinationLabel,
      country: trip.country,
      scope: trip.scope,
      startDate,
      endDate,
      memberCount: trip.memberCount,
      heroImageUrl: trip.heroImageUrl ?? null,
      status: PastTripStatus.PUBLISHED,
      publishedAt: now,
      metaTitle: `${trip.title} · Beyond Borders`,
      metaDescription: trip.summary,
    }

    const { id: tripId } = await db.pastTrip.upsert({
      where: { slug: trip.slug },
      update: fields,
      create: { slug: trip.slug, ...fields },
      select: { id: true },
    })
    counts.trips += 1

    // Content the seed owns: replaced wholesale, so removing a highlight here
    // actually removes it.
    await db.pastTripLeader.deleteMany({ where: { tripId } })
    for (const [index, assignment] of trip.leaders.entries()) {
      const leaderId = leaderIdBySlug.get(assignment.slug)
      if (leaderId === undefined) {
        throw new Error(`Past trip "${trip.slug}" references unknown leader "${assignment.slug}".`)
      }

      await db.pastTripLeader.create({
        data: { tripId, leaderId, role: assignment.role, sortOrder: index },
        select: { id: true },
      })
      counts.leaders += 1
    }

    await db.tripHighlight.deleteMany({ where: { tripId } })
    if (trip.highlights.length > 0) {
      await db.tripHighlight.createMany({
        data: trip.highlights.map((highlight, index) => ({
          tripId,
          kind: highlight.kind,
          title: highlight.title,
          body: highlight.body,
          dayNumber: highlight.dayNumber ?? null,
          sortOrder: index,
        })),
      })
      counts.highlights += trip.highlights.length
    }

    // Gallery rows are matched on url rather than wiped, because a real upload
    // from a traveller lives in this table beside the seeded ones and must not
    // be deleted by a seed run.
    for (const [index, media] of trip.media.entries()) {
      const existing = await db.tripMedia.findFirst({
        where: { tripId, url: media.url },
        select: { id: true },
      })

      const mediaFields = {
        alt: media.alt,
        caption: media.caption ?? null,
        moderationStatus: ModerationStatus.APPROVED,
        reviewedAt: now,
        sortOrder: index,
      }

      if (existing === null) {
        await db.tripMedia.create({
          data: { tripId, url: media.url, ...mediaFields },
          select: { id: true },
        })
      } else {
        await db.tripMedia.update({
          where: { id: existing.id },
          data: mediaFields,
          select: { id: true },
        })
      }
      counts.media += 1
    }

    for (const review of trip.reviews) {
      const email = normalizeEmail(review.reviewerEmail)
      const userId = userIdByEmail.get(email)
      if (userId === undefined) {
        throw new Error(`Past trip "${trip.slug}" references unknown reviewer "${email}".`)
      }

      // Somebody has to have been on the trip to review it. The seed creates
      // the participation row rather than bypassing the rule it exists to
      // enforce — the review endpoint checks this same table.
      await db.tripParticipant.upsert({
        where: { tripId_email: { tripId, email } },
        update: { userId, name: review.displayName ?? email },
        create: { tripId, userId, name: review.displayName ?? email, email },
        select: { id: true },
      })
      counts.participants += 1

      const reviewFields = {
        headline: review.headline,
        body: review.body,
        displayName: review.displayName ?? null,
        moderationStatus: ModerationStatus.APPROVED,
        reviewedAt: now,
      }

      const { id: reviewId } = await db.tripReview.upsert({
        where: { tripId_userId: { tripId, userId } },
        update: reviewFields,
        create: { tripId, userId, ...reviewFields },
        select: { id: true },
      })
      counts.reviews += 1

      // Replaced rather than merged: a dimension dropped from the seed has to
      // disappear from the averages, not linger at its last value.
      await db.tripReviewRating.deleteMany({ where: { reviewId } })
      const scores = Object.entries(review.ratings) as [ReviewDimension, number][]
      await db.tripReviewRating.createMany({
        data: scores.map(([dimension, score]) => ({ reviewId, dimension, score })),
      })
      counts.ratings += scores.length
    }
  }

  return counts
}

/**
 * Promo codes.
 *
 * Three, and between them they exercise every branch of the coupon engine: a
 * capped percentage, a flat amount with a floor, and a code restricted to one
 * trip. A seed of three identical percentages would leave the cap, the minimum
 * spend and the package restriction untested by anything anybody clicks.
 *
 * Upserted on `code`, which the database requires to be uppercase — the lookup
 * is an exact match, so a lowercase row would be a code that exists and can
 * never be redeemed.
 *
 * No redemptions are seeded. Those are written by real bookings, and inventing
 * them would inflate `redeemedCount` against ceilings nobody consumed.
 */
async function seedCoupons(): Promise<number> {
  const now = new Date()
  const inDays = (days: number): Date => new Date(now.getTime() + days * 86_400_000)

  // Restricted codes need a package. Resolved by slug so a missing trip is an
  // error here rather than a code that silently applies to everything.
  const monsoonTarget = await db.travelPackage.findUnique({
    where: { slug: 'sajek-valley-cloud-chase' },
    select: { id: true },
  })

  const coupons = [
    {
      code: 'EARLYBIRD',
      label: 'Early bird — 15% off',
      description:
        'Book ahead and take 15% off, up to ৳8,000. One per traveller, and it ends when the ' +
        'season fills.',
      type: CouponType.PERCENT,
      value: 15,
      // Uncapped, 15% of the Sri Lanka trip would be ৳16,800. A percentage
      // without a ceiling is a discount whose size depends on which trip
      // somebody picks, which is not what "15% off" is meant to promise.
      maxDiscountBdt: 8_000,
      minSpendBdt: 15_000,
      startsAt: null,
      endsAt: inDays(60),
      maxRedemptions: 200,
      maxPerUser: 1,
      packageId: null,
    },
    {
      code: 'GROUPSAVE',
      label: 'Group saver — ৳5,000 off',
      description: 'A flat ৳5,000 off bookings over ৳80,000. Best on a party of two or more.',
      type: CouponType.FIXED,
      value: 5_000,
      // A FIXED coupon needs no cap: the value IS the cap. The database
      // refuses one anyway, so this is not a decision anybody can get wrong.
      maxDiscountBdt: null,
      minSpendBdt: 80_000,
      startsAt: null,
      endsAt: null,
      maxRedemptions: null,
      maxPerUser: 2,
      packageId: null,
    },
    {
      code: 'MONSOON10',
      label: 'Monsoon in the hills — 10% off',
      description: '10% off the Sajek departures, capped at ৳4,000. This one trip only.',
      type: CouponType.PERCENT,
      value: 10,
      maxDiscountBdt: 4_000,
      minSpendBdt: null,
      startsAt: null,
      endsAt: inDays(45),
      maxRedemptions: 50,
      maxPerUser: 1,
      packageId: monsoonTarget?.id ?? null,
    },
  ]

  for (const coupon of coupons) {
    const { code, ...fields } = coupon
    await db.coupon.upsert({
      where: { code },
      // `redeemedCount` is deliberately absent from both branches. It is a
      // count of real redemptions, and resetting it on a seed run would hand
      // back ceilings that travellers have already consumed.
      update: { ...fields, isActive: true },
      create: { code, ...fields, isActive: true },
      select: { id: true },
    })
  }

  return coupons.length
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

  console.log('\nDiscover')
  const discover = await seedDiscover()
  console.log(`  trip leaders    ${discover.leaders}`)
  console.log(`  packages        ${discover.packages}`)
  console.log(`  departures      ${discover.departures}`)
  console.log(`  itinerary days  ${discover.days}`)
  console.log(`  itinerary items ${discover.items}`)
  console.log(`  leader roles    ${discover.assignments}`)
  console.log(`  polls           ${discover.polls} (${discover.pollOptions} options)`)

  console.log('\nPast trips')
  const past = await seedPastTrips()
  console.log(`  reviewer accounts ${past.reviewers} created`)
  console.log(`  trips             ${past.trips}`)
  console.log(`  leaders           ${past.leaders}`)
  console.log(`  participants      ${past.participants}`)
  console.log(`  highlights        ${past.highlights}`)
  console.log(`  gallery           ${past.media}`)
  console.log(`  reviews           ${past.reviews} (${past.ratings} dimension scores)`)

  console.log('\nCommerce')
  console.log(`  coupons         ${await seedCoupons()}`)

  // Read the totals back rather than trusting the counters above: the point of
  // the check is to catch a write that did not land.
  const [
    tags,
    destinations,
    activities,
    activityTags,
    openingHours,
    planRows,
    settingRows,
    packageRows,
    departureRows,
    leaderRows,
    pollRows,
    pollOptionRows,
  ] = await Promise.all([
    db.tag.count(),
    db.destination.count(),
    db.activity.count(),
    db.activityTag.count(),
    db.activityOpeningHours.count(),
    db.plan.count(),
    db.setting.count(),
    db.travelPackage.count(),
    db.packageDeparture.count(),
    db.tripLeader.count(),
    db.poll.count(),
    db.pollOption.count(),
  ])

  console.log('\nRow counts in the database')
  console.log(
    `  settings=${settingRows} plans=${planRows} tags=${tags} destinations=${destinations} ` +
      `activities=${activities} activity_tags=${activityTags} opening_hours=${openingHours}`
  )
  console.log(
    `  packages=${packageRows} departures=${departureRows} trip_leaders=${leaderRows} ` +
      `polls=${pollRows} poll_options=${pollOptionRows}`
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
