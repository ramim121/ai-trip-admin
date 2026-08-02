import type { LanguageModelUsage } from 'ai'
import { after } from 'next/server'
import { AiCallOutcome, AiSurface } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import type { ModelSelection } from './provider'
import { normaliseUsage } from './usage'

/**
 * Writing one row per model call.
 *
 * The counterpart to `usage.ts`, which deliberately touches no database — that
 * file does the arithmetic, this one persists the result. Splitting them keeps
 * the pricing logic unit-testable without a Postgres, and keeps the write path
 * out of anything that only wants to add up tokens.
 *
 * WHY A SECOND TABLE, GIVEN PlannerMessage ALREADY HAS `model` AND TOKENS
 *
 * Because PlannerMessage only exists where a planner message does. Four of the
 * things ops needs to see leave no row there at all:
 *
 *   - the teaser, which has no PlannerMessage and is the surface strangers can
 *     reach without signing in — that is, the one most worth watching;
 *   - a failure, where the provider was called and billed and no message was
 *     produced;
 *   - a refusal, where a quota or a kill switch saved us the call;
 *   - a cache hit, which is the number that justifies the cache existing.
 *
 * A console built on PlannerMessage would have shown the cheap model as free,
 * an outage as silence, and the cache as nothing at all.
 *
 * NOTHING HERE MAY BREAK A REQUEST
 *
 * This is instrumentation. A traveller waiting on an itinerary must not be
 * handed a 500 because a log insert deadlocked, so every failure is caught and
 * logged and the request proceeds. That is one of the few places in this
 * codebase where swallowing an error is right, and it is right for a specific
 * reason: an outage in the accounting table taking the product down is strictly
 * worse than a gap in the accounting table.
 */

/** What the caller knows about who made the call. All three are optional. */
export interface AiActorContext {
  userId?: string | null
  anonymousVisitorId?: string | null
  plannerSessionId?: string | null
}

export interface AiUsageEventInput extends AiActorContext {
  surface: AiSurface
  outcome: AiCallOutcome
  /** The resolved selection, so `modelSource` records whether an override was live. */
  selection: Pick<ModelSelection, 'provider' | 'modelId' | 'source'>
  /** True only when we answered from our own cache and no provider was called. */
  cached?: boolean
  /** The SDK's usage object. Absent on every path that did not reach a provider. */
  usage?: LanguageModelUsage | null
  latencyMs?: number | null
  /** The error's class, never its message. See `errorKindOf` for why. */
  errorKind?: string | null
}

/**
 * The class of a thrown value, for the `errorKind` column.
 *
 * Deliberately the constructor name and nothing else. Provider errors quote the
 * request back — a rejected call includes the prompt that caused it — and this
 * table is read by staff who have no business reading a traveller's words.
 * `AI_APICallError` says what went wrong; the message would say who it happened
 * to.
 */
export function errorKindOf(e: unknown): string {
  if (e instanceof Error) return e.name || e.constructor.name
  return typeof e
}

/**
 * A cached reply carries no token counts.
 *
 * The database enforces this (`ai_usage_events_cached_calls_are_free`) because
 * a mis-wired call site would otherwise make "saved by the cache" and real
 * spend indistinguishable. Normalising here rather than letting the constraint
 * fire keeps a wiring mistake from becoming a failed insert nobody sees.
 */
function tokensFor(input: AiUsageEventInput): {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
} {
  if (input.cached === true || input.usage == null) {
    return { promptTokens: null, completionTokens: null, totalTokens: null }
  }

  const usage = normaliseUsage(input.usage)
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  }
}

/** The insert, awaited. Exported for tests and for scripts that want the throw. */
export async function writeAiUsageEvent(input: AiUsageEventInput): Promise<void> {
  const tokens = tokensFor(input)

  await db.aiUsageEvent.create({
    data: {
      surface: input.surface,
      outcome: input.outcome,
      provider: input.selection.provider,
      model: input.selection.modelId,
      modelSource: input.selection.source,
      cached: input.cached ?? false,
      ...tokens,
      latencyMs: input.latencyMs == null ? null : Math.max(0, Math.trunc(input.latencyMs)),
      errorKind: input.errorKind ?? null,
      userId: input.userId ?? null,
      anonymousVisitorId: input.anonymousVisitorId ?? null,
      plannerSessionId: input.plannerSessionId ?? null,
    },
    select: { id: true },
  })
}

/**
 * Record a call without making anyone wait for it.
 *
 * `after()` runs the callback once the response has been sent, which is exactly
 * right for a spend log: the row is not part of the answer, and holding a
 * streamed itinerary open for an INSERT would be paying latency for bookkeeping.
 *
 * It is also what makes this safe outside a request — `after()` throws when
 * there is no request context to defer within, and a seed script or a test has
 * none. That case falls through to a background write with the same swallow, so
 * a caller never has to know which one it is in.
 */
export function recordAiUsage(input: AiUsageEventInput): void {
  const write = async (): Promise<void> => {
    try {
      await writeAiUsageEvent(input)
    } catch (e) {
      // Logged with the surface and the model, because a gap in the spend log
      // is worth noticing even though it is not worth failing a request over.
      const description = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      console.error(
        `[ai-usage] could not record a ${input.surface} call to ` +
          `${input.selection.provider}/${input.selection.modelId}: ${description}`
      )
    }
  }

  try {
    after(write)
  } catch {
    // No request context — a script, a test, a background job. Start it and let
    // it settle on its own; `write` never rejects, so this cannot become an
    // unhandled rejection.
    void write()
  }
}
