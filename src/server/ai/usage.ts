import type { LanguageModelUsage } from 'ai'
import type { AiProviderId } from './provider'

/**
 * What one model call cost us.
 *
 * The planner service calls `buildUsageRecord` after every generation and
 * persists the result onto the PlannerMessage row. Nothing here touches the
 * database — this file only does the arithmetic, so it can be unit tested and
 * reused from a backfill script.
 *
 * On the unit: money in this product is whole taka in an Int column, but a
 * single Gemini call costs a small fraction of one taka, and rounding each call
 * to the nearest taka would record every one of them as zero. So AI spend is
 * accounted in *micro-taka* — millionths of a BDT, still an integer, still
 * exactly summable. `estimatedCostBdt` is the rounded figure for display only;
 * never sum that one.
 */

export const MICRO_BDT_PER_BDT = 1_000_000

/**
 * Fallback USD→BDT rate.
 *
 * The authoritative rate is the admin-set one in Setting — the same value the
 * website uses for display prices — and the planner service passes it in. This
 * constant only keeps the arithmetic defined before anyone has set one.
 */
export const DEFAULT_USD_TO_BDT_RATE = 122

/** Per-million-token prices, in USD, as published by the provider. */
export interface ModelPrice {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
  /** Cache-read price, when the provider bills cached prompt tokens cheaper. */
  cachedInputPerMillionUsd?: number
  /** Where the figure came from, so a stale rate can be traced and fixed. */
  source: string
}

function priceKey(provider: AiProviderId, modelId: string): string {
  return `${provider}:${modelId}`
}

/**
 * Known prices.
 *
 * Deliberately sparse. Vendor prices change and new model ids appear far faster
 * than this file will be edited, and a *wrong* cost quietly entered into our
 * books is worse than an absent one — it looks like data. An unpriced model
 * therefore yields `estimatedCostMicroBdt: null` and `pricingKnown: false`,
 * which is visible, alertable, and impossible to mistake for zero spend.
 *
 * Ops fills gaps at runtime with `registerModelPrice` rather than by deploying.
 */
const PRICES = new Map<string, ModelPrice>([
  [
    'google:gemini-2.5-flash',
    {
      inputPerMillionUsd: 0.3,
      outputPerMillionUsd: 2.5,
      cachedInputPerMillionUsd: 0.075,
      source: 'seed default — confirm against the provider price list before trusting invoices',
    },
  ],
])

/**
 * Teach the accountant about a model, e.g. from an admin settings row read at
 * boot. Overwrites any existing entry for the same model.
 */
export function registerModelPrice(
  provider: AiProviderId,
  modelId: string,
  price: ModelPrice
): void {
  PRICES.set(priceKey(provider, modelId), price)
}

export function getModelPrice(provider: AiProviderId, modelId: string): ModelPrice | null {
  return PRICES.get(priceKey(provider, modelId)) ?? null
}

/** Every price currently known, for an admin screen. */
export function listModelPrices(): { key: string; price: ModelPrice }[] {
  return [...PRICES.entries()].map(([key, price]) => ({ key, price }))
}

// ── Token normalisation ─────────────────────────────────────────────────────

export interface NormalisedUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Prompt tokens served from the provider's cache, already inside promptTokens. */
  cachedInputTokens: number
  /** Thinking tokens, already inside completionTokens. Billed as output. */
  reasoningTokens: number
}

/**
 * Flatten the SDK's usage object into plain integers.
 *
 * Every field on `LanguageModelUsage` is `number | undefined`, because
 * providers disagree about what they report. Treating absent as zero is right
 * for accounting — but `totalTokens` falls back to input + output rather than
 * to zero, so a provider that omits the total cannot make a call look free to
 * the session budget.
 */
export function normaliseUsage(usage?: LanguageModelUsage | null): NormalisedUsage {
  const promptTokens = Math.max(0, Math.trunc(usage?.inputTokens ?? 0))
  const completionTokens = Math.max(0, Math.trunc(usage?.outputTokens ?? 0))

  const reported = usage?.totalTokens
  const totalTokens =
    reported === undefined ? promptTokens + completionTokens : Math.max(0, Math.trunc(reported))

  // Cached tokens are a subset of the prompt; a provider reporting more than
  // the prompt itself would otherwise produce a negative full-price count.
  const cachedInputTokens = Math.min(
    promptTokens,
    Math.max(0, Math.trunc(usage?.inputTokenDetails?.cacheReadTokens ?? 0))
  )
  const reasoningTokens = Math.max(0, Math.trunc(usage?.outputTokenDetails?.reasoningTokens ?? 0))

  return { promptTokens, completionTokens, totalTokens, cachedInputTokens, reasoningTokens }
}

// ── Cost ────────────────────────────────────────────────────────────────────

/** What the call was for. Lets us see where the AI budget actually goes. */
export const AI_CALL_PURPOSES = [
  'TEASER',
  'PLANNER_TURN',
  'DAY_PLAN',
  'ACTIVITY_SUGGESTION',
  'SUMMARY',
] as const
export type AiCallPurpose = (typeof AI_CALL_PURPOSES)[number]

export interface UsageRecordInput {
  provider: AiProviderId
  modelId: string
  purpose: AiCallPurpose
  usage?: LanguageModelUsage | null
  /** Admin-set rate from Setting. Falls back to the module default. */
  usdToBdtRate?: number
  latencyMs?: number
  finishReason?: string
  /**
   * True when we answered from our own teaser cache and never called the
   * provider. Recorded rather than skipped: "this cost nothing because the
   * cache worked" is precisely the number that justifies the cache.
   */
  servedFromCache?: boolean
}

export interface AiUsageRecord {
  provider: AiProviderId
  modelId: string
  purpose: AiCallPurpose
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  /** Integer millionths of a taka. `null` when the model's price is unknown. */
  estimatedCostMicroBdt: number | null
  /** Whole taka, for display. Rounds a sub-taka call to 0 — never sum this. */
  estimatedCostBdt: number | null
  /** False means we could not price the call, not that it was free. */
  pricingKnown: boolean
  usdToBdtRate: number
  latencyMs: number | null
  finishReason: string | null
  servedFromCache: boolean
}

const ZERO_USAGE: NormalisedUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
}

/**
 * Price a call.
 *
 * Cached prompt tokens are billed at the cache rate *and subtracted* from the
 * full-price input, because providers report them inside `inputTokens`;
 * charging both would overstate every cached call.
 */
function estimateMicroBdt(usage: NormalisedUsage, price: ModelPrice, usdToBdtRate: number): number {
  // Only discount when the provider actually publishes a cache rate; otherwise
  // cached tokens bill at the ordinary input price.
  const cached = price.cachedInputPerMillionUsd === undefined ? 0 : usage.cachedInputTokens
  const fullPriceInput = usage.promptTokens - cached

  const usd =
    (fullPriceInput * price.inputPerMillionUsd +
      cached * (price.cachedInputPerMillionUsd ?? 0) +
      usage.completionTokens * price.outputPerMillionUsd) /
    1_000_000

  return Math.round(usd * usdToBdtRate * MICRO_BDT_PER_BDT)
}

/**
 * Build the record the planner service persists.
 *
 * A cache hit records zero tokens and zero cost — but `pricingKnown` stays
 * true, because we know exactly what it cost: nothing.
 */
export function buildUsageRecord(input: UsageRecordInput): AiUsageRecord {
  const usdToBdtRate = input.usdToBdtRate ?? DEFAULT_USD_TO_BDT_RATE
  const servedFromCache = input.servedFromCache ?? false
  const usage = servedFromCache ? ZERO_USAGE : normaliseUsage(input.usage)

  const price = getModelPrice(input.provider, input.modelId)
  const pricingKnown = servedFromCache || price !== null

  const estimatedCostMicroBdt = servedFromCache
    ? 0
    : price === null
      ? null
      : estimateMicroBdt(usage, price, usdToBdtRate)

  return {
    provider: input.provider,
    modelId: input.modelId,
    purpose: input.purpose,
    ...usage,
    estimatedCostMicroBdt,
    estimatedCostBdt:
      estimatedCostMicroBdt === null ? null : Math.round(estimatedCostMicroBdt / MICRO_BDT_PER_BDT),
    pricingKnown,
    usdToBdtRate,
    latencyMs: input.latencyMs ?? null,
    finishReason: input.finishReason ?? null,
    servedFromCache,
  }
}

/**
 * The subset of a usage record that PlannerMessage currently has columns for.
 *
 * `model` carries the provider as well, because the table has one string column
 * and "gemini-2.5-flash" alone would stop identifying the call the moment the
 * same model id is reachable through a second provider.
 *
 * Note there is no cost column yet: `estimatedCostMicroBdt` is computed and
 * returned by `buildUsageRecord` but has nowhere to live until the schema gains
 * one. Persist the tokens now; the cost is recoverable from them and the price
 * table until then.
 */
export function toPlannerMessageFields(record: AiUsageRecord): {
  model: string
  promptTokens: number
  completionTokens: number
} {
  return {
    model: `${record.provider}/${record.modelId}`,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
  }
}

export interface UsageTotals {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimatedCostMicroBdt: number
  /**
   * False when at least one call could not be priced, so the total is a lower
   * bound. A dashboard showing this must say so rather than imply precision.
   */
  pricingComplete: boolean
}

/** Roll a session's calls into one line. */
export function sumUsageRecords(records: readonly AiUsageRecord[]): UsageTotals {
  return records.reduce<UsageTotals>(
    (totals, record) => ({
      calls: totals.calls + 1,
      promptTokens: totals.promptTokens + record.promptTokens,
      completionTokens: totals.completionTokens + record.completionTokens,
      totalTokens: totals.totalTokens + record.totalTokens,
      estimatedCostMicroBdt: totals.estimatedCostMicroBdt + (record.estimatedCostMicroBdt ?? 0),
      pricingComplete: totals.pricingComplete && record.pricingKnown,
    }),
    {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostMicroBdt: 0,
      pricingComplete: true,
    }
  )
}

/**
 * One-line log summary. Model ids, counts and money only — no prompt text — so
 * it needs no redaction before it is written.
 */
export function describeUsage(record: AiUsageRecord): string {
  const cost =
    record.estimatedCostMicroBdt === null
      ? 'cost=unknown'
      : `cost=${(record.estimatedCostMicroBdt / MICRO_BDT_PER_BDT).toFixed(4)}BDT`
  const cache = record.servedFromCache ? ' cached' : ''
  return `[ai] ${record.provider}/${record.modelId} ${record.purpose} in=${record.promptTokens} out=${record.completionTokens} ${cost}${cache}`
}
