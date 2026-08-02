import {
  AiCallOutcome,
  AiSurface,
  BillingInterval,
  PlanCode,
  SubscriptionStatus,
} from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import {
  envModelSelection,
  resolveModelSelection,
  schemaConstrainedModel,
  type ModelSelection,
} from '@/server/ai/provider'
import { MICRO_BDT_PER_BDT, getModelPrice, type ModelPrice } from '@/server/ai/usage'
import { anonymousPromptLimit } from '@/server/modules/entitlements/anonymous'
import { resolvePeriod } from '@/server/modules/entitlements/service'
import {
  TEASER_DAILY_GENERATION_RULE,
  TEASER_REQUESTS_PER_IP_PER_HOUR,
  TEASER_REQUESTS_UNRESOLVED_PER_HOUR,
  teaserEnabled,
} from '@/server/modules/entitlements/teaser'

/**
 * Everything the AI console shows, read in one place.
 *
 * The screen answers three questions and they come from three different tables,
 * which is why this module exists rather than a page assembling its own queries:
 *
 *   what did we SPEND         ai_usage_events, grouped by model and by surface
 *   what is LEFT, site-wide   rate_limit_buckets, the fixed windows
 *   what is LEFT, per person  usage_counters against the plan's ceilings
 *
 * The third is the one worth being careful about. A traveller's allowance is
 * `plan.aiPromptsPerPeriod - counter.aiPromptsUsed`, and the period boundary is
 * NOT the row's own `periodStart` — it is whatever `resolvePeriod` derives from
 * their live subscription right now. Reading the boundary off the counter row
 * would report a reset date that has already passed for anybody whose billing
 * date moved, and "when do I get more" is the question this screen is asked most.
 *
 * Nothing here mutates. It is a reporting module, and a reporting module that
 * can write is one incident away from being blamed for the numbers it shows.
 */

/** A day and a month: the two windows every spend question gets asked in. */
export const DAY_MS = 24 * 60 * 60 * 1_000
export const MONTH_MS = 30 * DAY_MS

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelConfiguration {
  /** What the planner will use for the next turn, override included. */
  active: ModelSelection
  /** What env alone says, so a settings override is visibly an override. */
  fromEnv: ModelSelection
  /**
   * The cheap tier used where a schema forces the output shape. Null when
   * AI_MODEL_CHEAP is unset, in which case those calls fall back to `active`.
   */
  cheap: ModelSelection | null
  /** The `ai.teaser.enabled` kill switch, as it stands right now. */
  teaserEnabled: boolean
}

export async function readModelConfiguration(): Promise<ModelConfiguration> {
  const cheapOverride = schemaConstrainedModel()

  const [active, cheap, enabled] = await Promise.all([
    resolveModelSelection(),
    cheapOverride === undefined ? Promise.resolve(null) : resolveModelSelection(cheapOverride),
    teaserEnabled(),
  ])

  return { active, fromEnv: envModelSelection(), cheap, teaserEnabled: enabled }
}

// ─────────────────────────────────────────────────────────────────────────────
// Spend, per model
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelUsageRow {
  provider: string
  model: string
  calls: number
  succeeded: number
  failed: number
  /** Never reached a provider: a quota wall or a kill switch. */
  refused: number
  /** Answered from our cache. Free, and counted so the saving is visible. */
  cached: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /**
   * Integer millionths of a taka, or null when this model has no published
   * price in `usage.ts`. Null is NOT zero, and the console must render it as
   * "unpriced" — a model quietly reported as free is how an invoice becomes a
   * surprise.
   */
  estimatedCostMicroBdt: number | null
  price: ModelPrice | null
  firstSeenAt: Date
  lastSeenAt: Date
}

/**
 * The conversion used for the cost column.
 *
 * Display-only, like every USD figure in this product, and deliberately a
 * constant rather than the admin-set rate. This screen reports what the invoice
 * will say; re-deriving it through a rate ops can edit would make last week's
 * number change when somebody corrects the rate today.
 */
const USD_TO_BDT_FOR_REPORTING = 122

/**
 * Group the spend log by model.
 *
 * One `groupBy` on (provider, model, outcome, cached), folded in JavaScript,
 * rather than four counting queries. The cardinality is tiny — a handful of
 * models times three outcomes — so the fold is free, and one query means every
 * number on the screen describes the same instant.
 */
export async function usageByModel(since: Date): Promise<ModelUsageRow[]> {
  const groups = await db.aiUsageEvent.groupBy({
    by: ['provider', 'model', 'outcome', 'cached'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
  })

  const rows = new Map<string, ModelUsageRow>()

  for (const group of groups) {
    const key = `${group.provider}/${group.model}`
    const count = group._count._all
    const first = group._min.createdAt
    const last = group._max.createdAt

    const row = rows.get(key) ?? {
      provider: group.provider,
      model: group.model,
      calls: 0,
      succeeded: 0,
      failed: 0,
      refused: 0,
      cached: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostMicroBdt: null,
      price: null,
      firstSeenAt: first ?? since,
      lastSeenAt: last ?? since,
    }

    row.calls += count
    if (group.outcome === AiCallOutcome.SUCCEEDED) row.succeeded += count
    if (group.outcome === AiCallOutcome.FAILED) row.failed += count
    if (group.outcome === AiCallOutcome.REFUSED) row.refused += count
    if (group.cached) row.cached += count

    row.promptTokens += group._sum.promptTokens ?? 0
    row.completionTokens += group._sum.completionTokens ?? 0
    row.totalTokens += group._sum.totalTokens ?? 0

    if (first !== null && first < row.firstSeenAt) row.firstSeenAt = first
    if (last !== null && last > row.lastSeenAt) row.lastSeenAt = last

    rows.set(key, row)
  }

  return [...rows.values()]
    .map((row) => {
      // The price table is keyed by AiProviderId; `provider` here is whatever
      // string was logged. A row written under a provider name we no longer
      // recognise simply finds no price, which is the honest answer.
      const price = getModelPrice(row.provider as Parameters<typeof getModelPrice>[0], row.model)
      if (price === null) return row

      const usd =
        (row.promptTokens * price.inputPerMillionUsd +
          row.completionTokens * price.outputPerMillionUsd) /
        1_000_000

      return {
        ...row,
        price,
        estimatedCostMicroBdt: Math.round(usd * USD_TO_BDT_FOR_REPORTING * MICRO_BDT_PER_BDT),
      }
    })
    .sort((a, b) => b.calls - a.calls)
}

// ─────────────────────────────────────────────────────────────────────────────
// Spend, per surface
// ─────────────────────────────────────────────────────────────────────────────

export interface SurfaceUsageRow {
  surface: AiSurface
  calls: number
  succeeded: number
  failed: number
  refused: number
  cached: number
  totalTokens: number
}

export async function usageBySurface(since: Date): Promise<SurfaceUsageRow[]> {
  const groups = await db.aiUsageEvent.groupBy({
    by: ['surface', 'outcome', 'cached'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { totalTokens: true },
  })

  const rows = new Map<AiSurface, SurfaceUsageRow>()

  for (const group of groups) {
    const count = group._count._all
    const row = rows.get(group.surface) ?? {
      surface: group.surface,
      calls: 0,
      succeeded: 0,
      failed: 0,
      refused: 0,
      cached: 0,
      totalTokens: 0,
    }

    row.calls += count
    if (group.outcome === AiCallOutcome.SUCCEEDED) row.succeeded += count
    if (group.outcome === AiCallOutcome.FAILED) row.failed += count
    if (group.outcome === AiCallOutcome.REFUSED) row.refused += count
    if (group.cached) row.cached += count
    row.totalTokens += group._sum.totalTokens ?? 0

    rows.set(group.surface, row)
  }

  return [...rows.values()].sort((a, b) => b.calls - a.calls)
}

/** The most recent failures, for the "is something broken right now" question. */
export interface RecentFailure {
  createdAt: Date
  surface: AiSurface
  provider: string
  model: string
  errorKind: string | null
  latencyMs: number | null
}

export async function recentFailures(limit: number): Promise<RecentFailure[]> {
  return db.aiUsageEvent.findMany({
    where: { outcome: AiCallOutcome.FAILED },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      createdAt: true,
      surface: true,
      provider: true,
      model: true,
      errorKind: true,
      latencyMs: true,
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Site-wide ceilings
// ─────────────────────────────────────────────────────────────────────────────

export interface CeilingStatus {
  label: string
  /** What the counter is called in `rate_limit_buckets`. */
  bucketKey: string
  limit: number
  hits: number
  /** `limit - hits`, floored at zero. What is actually left right now. */
  remaining: number
  windowSeconds: number
  windowStart: Date
  /** When the allowance returns. The question this section exists to answer. */
  resetsAt: Date
  /** A note on what the ceiling protects, shown beside it. */
  note: string
}

/**
 * Read one fixed window without creating it.
 *
 * `consumeRateLimit` would record a hit, which on a reporting screen means
 * opening the console spends the allowance it came to look at. The window start
 * is recomputed here with the same flooring the limiter uses, so an absent row
 * reads as zero hits in the window currently open — which is exactly what an
 * absent row means.
 */
async function readCeiling(
  label: string,
  bucketKey: string,
  limit: number,
  windowSeconds: number,
  note: string,
  now: Date
): Promise<CeilingStatus> {
  const windowMs = windowSeconds * 1_000
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs)

  const bucket = await db.rateLimitBucket.findUnique({
    where: { bucketKey_windowStart: { bucketKey, windowStart } },
    select: { hits: true },
  })

  const hits = bucket?.hits ?? 0

  return {
    label,
    bucketKey,
    limit,
    hits,
    remaining: Math.max(0, limit - hits),
    windowSeconds,
    windowStart,
    resetsAt: new Date(windowStart.getTime() + windowMs),
    note,
  }
}

/** Every ceiling that is not per-caller: the ones ops can actually act on. */
export async function siteCeilings(now: Date = new Date()): Promise<CeilingStatus[]> {
  return Promise.all([
    readCeiling(
      'Uncached previews, site-wide',
      TEASER_DAILY_GENERATION_RULE.key,
      TEASER_DAILY_GENERATION_RULE.limit,
      TEASER_DAILY_GENERATION_RULE.windowSeconds,
      'Counts model calls, not replies — a cached preview never touches this. Deliberately not ' +
        'editable from the console: a spend ceiling that can be raised at 2am is not a ceiling.',
      now
    ),
    readCeiling(
      'Previews from unidentified callers',
      'teaser:ip:unresolved',
      TEASER_REQUESTS_UNRESOLVED_PER_HOUR,
      60 * 60,
      'One shared pool for every caller whose address we could not resolve. If this is ' +
        'throttling, TRUSTED_PROXY_HOPS is probably lower than the number of proxies actually ' +
        'in front of this process.',
      now
    ),
  ])
}

/**
 * The busiest per-address preview buckets in the window open right now.
 *
 * The keys are salted digests, never addresses — this table is deliberately not
 * a record of who asked for what. A digest at or near its limit is still
 * actionable: it says one network is looping, which is what the limit is for.
 */
export interface AddressBucket {
  bucketKey: string
  hits: number
  limit: number
  resetsAt: Date
}

export async function busiestAddressBuckets(
  take: number,
  now: Date = new Date()
): Promise<AddressBucket[]> {
  const windowMs = 60 * 60 * 1_000
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs)

  const buckets = await db.rateLimitBucket.findMany({
    where: { windowStart, bucketKey: { startsWith: 'teaser:ip:' } },
    orderBy: { hits: 'desc' },
    take,
    select: { bucketKey: true, hits: true },
  })

  return buckets.map((bucket) => ({
    bucketKey: bucket.bucketKey,
    hits: bucket.hits,
    limit:
      bucket.bucketKey === 'teaser:ip:unresolved'
        ? TEASER_REQUESTS_UNRESOLVED_PER_HOUR
        : TEASER_REQUESTS_PER_IP_PER_HOUR,
    resetsAt: new Date(windowStart.getTime() + windowMs),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-account allowances
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountAllowance {
  userId: string
  email: string
  name: string
  planName: string
  aiPromptsUsed: number
  itinerariesCreated: number
  /** Null means unmetered on this tier. Render as "unlimited", never as 0. */
  aiPromptsPerPeriod: number | null
  itinerariesPerPeriod: number | null
  /** Null when the ceiling is null. Zero means genuinely nothing left. */
  promptsRemaining: number | null
  itinerariesRemaining: number | null
  periodStart: Date
  /** When this account's counters go back to zero. */
  periodEnd: Date
  /** True when the counter row's window is not the window now in force. */
  periodStale: boolean
}

/**
 * Who is using their allowance, and how much of it is left.
 *
 * Three queries joined in memory rather than one clever one. The counters, the
 * live subscriptions and the plan ceilings are three different questions, and
 * `resolveEntitlement` — which answers all of them for ONE user — would be a
 * query per row here.
 *
 * The period is re-derived per user rather than read off the counter, for the
 * reason in the module comment: a counter row keyed on last month's boundary is
 * not this month's allowance, and showing its `periodEnd` would tell a
 * traveller their limit resets on a date that has already gone.
 */
export async function accountAllowances(
  take: number,
  now: Date = new Date()
): Promise<AccountAllowance[]> {
  const counters = await db.usageCounter.findMany({
    where: { periodEnd: { gt: now } },
    orderBy: [{ aiPromptsUsed: 'desc' }, { itinerariesCreated: 'desc' }],
    take,
    select: {
      userId: true,
      periodStart: true,
      periodEnd: true,
      aiPromptsUsed: true,
      itinerariesCreated: true,
      user: { select: { email: true, name: true } },
    },
  })

  if (counters.length === 0) return []

  const userIds = counters.map((counter) => counter.userId)

  const [subscriptions, freePlan] = await Promise.all([
    db.subscription.findMany({
      where: {
        userId: { in: userIds },
        status: SubscriptionStatus.ACTIVE,
        plan: { interval: { not: BillingInterval.NONE } },
        currentPeriodEnd: { gt: now },
      },
      // The same tie-break `resolveEntitlement` uses: strongest plan, then the
      // furthest-running row. Two screens disagreeing about which plan an
      // account is on would be worse than either being wrong alone.
      orderBy: [{ plan: { sortOrder: 'desc' } }, { currentPeriodEnd: 'desc' }],
      select: {
        userId: true,
        currentPeriodEnd: true,
        plan: { select: { name: true, aiPromptsPerPeriod: true, itinerariesPerPeriod: true } },
      },
    }),
    db.plan.findUnique({
      where: { code: PlanCode.FREE },
      select: { name: true, aiPromptsPerPeriod: true, itinerariesPerPeriod: true },
    }),
  ])

  // First row per user wins, and the query already ordered them strongest first.
  const live = new Map<string, (typeof subscriptions)[number]>()
  for (const subscription of subscriptions) {
    if (!live.has(subscription.userId)) live.set(subscription.userId, subscription)
  }

  return counters.map((counter) => {
    const subscription = live.get(counter.userId) ?? null
    const plan = subscription?.plan ?? freePlan
    const period = resolvePeriod(now, subscription?.currentPeriodEnd ?? null)

    const aiPromptsPerPeriod = plan ? plan.aiPromptsPerPeriod : null
    const itinerariesPerPeriod = plan ? plan.itinerariesPerPeriod : null

    return {
      userId: counter.userId,
      email: counter.user.email,
      name: counter.user.name,
      planName: plan?.name ?? 'Free',
      aiPromptsUsed: counter.aiPromptsUsed,
      itinerariesCreated: counter.itinerariesCreated,
      aiPromptsPerPeriod,
      itinerariesPerPeriod,
      promptsRemaining:
        aiPromptsPerPeriod === null
          ? null
          : Math.max(0, aiPromptsPerPeriod - counter.aiPromptsUsed),
      itinerariesRemaining:
        itinerariesPerPeriod === null
          ? null
          : Math.max(0, itinerariesPerPeriod - counter.itinerariesCreated),
      periodStart: period.start,
      periodEnd: period.end,
      // The counter belongs to a window that is no longer in force — a billing
      // date moved under it. The usage shown is real, but it is being metered
      // against a different window than the one it was written into.
      periodStale: counter.periodStart.getTime() !== period.start.getTime(),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Anonymous visitors and the cache
// ─────────────────────────────────────────────────────────────────────────────

export interface AnonymousSummary {
  /** Lifetime previews one visitor gets. Does not reset — that is the product. */
  promptLimit: number
  visitors: number
  visitorsAtLimit: number
  seenLastDay: number
  converted: number
}

export async function anonymousSummary(now: Date = new Date()): Promise<AnonymousSummary> {
  const limit = await anonymousPromptLimit()
  const dayAgo = new Date(now.getTime() - DAY_MS)

  const [visitors, visitorsAtLimit, seenLastDay, converted] = await Promise.all([
    db.anonymousVisitor.count(),
    db.anonymousVisitor.count({ where: { promptsUsed: { gte: limit } } }),
    db.anonymousVisitor.count({ where: { lastSeenAt: { gte: dayAgo } } }),
    db.anonymousVisitor.count({ where: { convertedUserId: { not: null } } }),
  ])

  return { promptLimit: limit, visitors, visitorsAtLimit, seenLastDay, converted }
}

export interface CacheSummary {
  entries: number
  /** Replies served from the cache — each one a model call not made. */
  hits: number
  hottestKeyHits: number
}

export async function cacheSummary(): Promise<CacheSummary> {
  const [entries, aggregate, hottest] = await Promise.all([
    db.teaserCache.count(),
    db.teaserCache.aggregate({ _sum: { hitCount: true } }),
    db.teaserCache.findFirst({ orderBy: { hitCount: 'desc' }, select: { hitCount: true } }),
  ])

  return {
    entries,
    hits: aggregate._sum.hitCount ?? 0,
    hottestKeyHits: hottest?.hitCount ?? 0,
  }
}

/** Whether each provider credential is present, without revealing any of them. */
export function credentialPresence(): { provider: string; configured: boolean }[] {
  const config = env()
  return [
    { provider: 'google', configured: Boolean(config.GOOGLE_GENERATIVE_AI_API_KEY) },
    { provider: 'openai', configured: Boolean(config.OPENAI_API_KEY) },
    { provider: 'anthropic', configured: Boolean(config.ANTHROPIC_API_KEY) },
  ]
}
