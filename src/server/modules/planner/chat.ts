import { stepCountIs, streamText, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import type { Prisma } from '@/generated/prisma/client'
import { AiCallOutcome, AiSurface, PlannerMessageRole } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import {
  AiLimitError,
  DEFAULT_AI_LIMITS,
  SessionBudget,
  buildMessages,
  getModel,
  plannerSystemPrompt,
  redactForLog,
  sanitiseToolText,
  sanitiseUserText,
  sessionBudgetExhausted,
  withWallClock,
  type AiLimits,
} from '@/server/ai'
import {
  BUDGET_BANDS,
  MAX_PARTY_SIZE,
  MAX_TRIP_DAYS,
  TRANSPORT_PREFERENCES,
  TRIP_PACES,
  TRIP_PURPOSES,
  type TripBrief,
} from '@/server/ai/schemas'
import { buildUsageRecord, describeUsage, toPlannerMessageFields } from '@/server/ai/usage'
import { errorKindOf, recordAiUsage } from '@/server/ai/usage-log'
import { badRequest } from '@/server/http/errors'
import { catalogTools } from '@/server/modules/catalog/tools'
import {
  recordUsage,
  resolveActorEntitlement,
  toPromptEntitlement,
  type Actor,
} from '@/server/modules/entitlements/service'
import { readCachedSetting } from '@/server/settings/read'
import {
  appendMessage,
  conversationHistory,
  sessionTokensUsed,
  updateBrief,
  type PlannerSessionRecord,
} from './session'

/**
 * The conversation itself.
 *
 * Four things have to be true of every turn, and the order they happen in is the
 * design:
 *
 *   1. The budget is checked BEFORE the provider is called, and again BETWEEN
 *      steps. A session with three hundred tokens left and a five-thousand-token
 *      prompt is already over, and learning that from the invoice is the
 *      expensive way to find out. But one turn is up to `MAX_PLANNER_STEPS`
 *      model calls, so a single check up front only ever proved the first one
 *      was affordable — see `stepOutputCap` and the stop conditions below.
 *   2. Nothing we did not write reaches the model as system-role content. The
 *      traveller's words are user-role, and so is the trip brief: `destination`
 *      arrives as client-supplied JSON on session creation and is written back
 *      to by the model's own `recordTripFacts`, which makes it untrusted coming
 *      and going. `buildMessages` is the only assembly point, which makes the
 *      isolation rule structural rather than something each caller remembers.
 *   3. Entitlement state is rebuilt from the database every turn and injected
 *      into the system prompt. Replaying a stored prompt would tell the model a
 *      traveller is still on the free tier after they have paid, and a designer
 *      that explains the wrong limit confidently is worse than one that says
 *      nothing.
 *   4. The turn is persisted with its model and token counts even when the
 *      stream dies halfway. A partial answer the traveller can see but we did
 *      not record is a conversation that forgets what it just said.
 *
 * The wire format is Server-Sent Events carrying one JSON object per frame —
 * not the SDK's own UI-message protocol. This API is consumed by a separate
 * repository over a versioned contract, and pinning that contract to a protocol
 * owned by a dependency's minor version is a migration nobody scheduled.
 */

/** How many model round trips one turn may take, tool calls included. */
export const MAX_PLANNER_STEPS = 8

/** Low by design. The planner assembles real inventory; invention is a defect. */
export const DEFAULT_PLANNER_TEMPERATURE = 0.4
const TEMPERATURE_SETTING_KEY = 'ai.temperature'
const TemperatureSchema = z.number().min(0).max(2)

/**
 * Four characters per token.
 *
 * A deliberate under-approximation, used only to refuse a call we can already
 * see is unaffordable. The authoritative count comes back from the provider and
 * is what actually gets recorded.
 */
function estimateTokens(messages: readonly ModelMessage[]): number {
  const characters = messages.reduce((total, message) => {
    if (typeof message.content === 'string') return total + message.content.length
    return total + JSON.stringify(message.content).length
  }, 0)
  return Math.ceil(characters / 4)
}

// ── Wire frames ─────────────────────────────────────────────────────────────

/**
 * One frame of the stream.
 *
 * `limit` is separate from `error` on purpose: hitting a plan wall mid-answer is
 * a product event the client renders as an offer, not a failure it renders as a
 * broken page.
 */
export type PlannerStreamEvent =
  | { type: 'start'; sessionId: string; userMessageId: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'brief'; brief: TripBrief }
  | { type: 'limit'; reason: string; message: string }
  | {
      type: 'done'
      messageId: string
      model: string
      promptTokens: number
      completionTokens: number
      brief: TripBrief
    }
  | { type: 'error'; code: string; message: string }

function frame(event: PlannerStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  // Nginx and friends buffer streamed responses by default, which turns a live
  // conversation into one long pause followed by a wall of text.
  'x-accel-buffering': 'no',
} as const

// ── The brief-recording tool ────────────────────────────────────────────────

/**
 * What the model may tell us it has learned.
 *
 * A tool rather than a parse of the reply text: asking a model to answer a
 * traveller AND emit structured JSON in the same breath gets you worse prose and
 * unreliable JSON. This way the conversation stays conversational and the facts
 * arrive typed.
 *
 * Every field is optional because the brief accumulates — turn three must be
 * able to record a party size without knowing the dates. `mergeTripBrief`
 * decides what an omission means, and its answer is "nothing": an absent field
 * never clears a value the traveller already gave us.
 */
/**
 * The lengths `TripBriefSchema` will still accept after sanitising.
 *
 * Kept beside the tool that produces the values because that is where they are
 * enforced, and mirrored from the brief schema because that is where they are
 * checked on the way back out.
 */
const TRIP_BRIEF_TEXT_LIMITS = {
  destination: 120,
  interests: 80,
  mustSee: 120,
  avoid: 120,
} as const

const TripFactsSchema = z.object({
  destination: z.string().trim().min(1).max(120).optional(),
  destinationId: z.uuid().optional().describe('Only from listDestinations. Never invented.'),
  totalDays: z.number().int().min(1).max(MAX_TRIP_DAYS).optional(),
  startDate: z.iso.date().optional().describe('Calendar date, YYYY-MM-DD.'),
  partySize: z.number().int().min(1).max(MAX_PARTY_SIZE).optional(),
  purpose: z.enum(TRIP_PURPOSES).optional(),
  pace: z.enum(TRIP_PACES).optional(),
  transportPreference: z.enum(TRANSPORT_PREFERENCES).optional(),
  budgetBand: z.enum(BUDGET_BANDS).optional(),
  interests: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  mustSee: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  avoid: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
})

// ── The turn ────────────────────────────────────────────────────────────────

export interface PlannerTurnInput {
  actor: Actor
  session: PlannerSessionRecord
  /** The traveller's raw text. Sanitised here; callers must not pre-clean it. */
  text: string
  limits?: AiLimits
}

/**
 * Run one turn and stream the answer.
 *
 * Everything decidable before the provider is called happens first and throws an
 * ordinary `ApiError`, so a refused turn is a clean 4xx in the standard envelope
 * rather than a 200 whose body turns out to contain an error. Once the first
 * byte is written the status is committed, and from that point failures are
 * reported inside the stream.
 */
export async function streamPlannerTurn(input: PlannerTurnInput): Promise<Response> {
  const limits = input.limits ?? DEFAULT_AI_LIMITS
  const { session } = input

  const text = sanitiseUserText(input.text, limits)
  if (text.trim() === '') {
    throw badRequest('Your message was empty once cleaned up.', [
      { path: 'text', message: 'Message is empty.' },
    ])
  }

  const [consumed, entitlement, history, temperature, destinationName] = await Promise.all([
    sessionTokensUsed(session.id),
    resolveActorEntitlement(input.actor),
    conversationHistory(session.id),
    readCachedSetting(TEMPERATURE_SETTING_KEY, TemperatureSchema),
    catalogDestinationName(session.tripBrief.destinationId),
  ])

  const budget = new SessionBudget(consumed, limits)

  const prompt = plannerSystemPrompt({
    // No itinerary is in scope during a conversation, so nothing is unlocked
    // yet — the designer plans to the plan's cap, which is the honest default.
    entitlement: toPromptEntitlement(entitlement, false),
    // The catalog's own spelling, or nothing. `tripBrief.destination` is free
    // text a client posted; it goes in the briefing message below, never here.
    ...(destinationName !== undefined ? { destinationName } : {}),
    ...(destinationName === undefined && session.tripBrief.destination
      ? { travellerDestination: session.tripBrief.destination }
      : {}),
    // Their own words, if they wrote any. Untrusted like the place name, and
    // more useful than every structured field put together.
    ...(session.tripBrief.notes ? { travellerNotes: session.tripBrief.notes } : {}),
    todayIso: new Date().toISOString().slice(0, 10),
  })

  const messages = buildMessages(
    { system: prompt.system, briefing: prompt.briefing, history, userText: text },
    limits
  )

  // Throws AiLimitError — a 429 — before a single token is spent.
  budget.assertCanSpend(estimateTokens(messages))

  const active = await getModel()
  const modelLabel = `${active.provider}/${active.modelId}`

  // Persisted before the answer, not after. If the provider dies mid-sentence,
  // what the traveller typed is still part of the conversation.
  const userMessage = await appendMessage({
    sessionId: session.id,
    role: PlannerMessageRole.USER,
    content: text,
  })

  const retrievedActivityIds = new Set<string>()
  const toolNames: string[] = []
  let briefPatch: Partial<TripBrief> = {}

  const tools = {
    ...catalogTools({
      destinationId: session.tripBrief.destinationId ?? null,
      partySize: session.tripBrief.partySize ?? null,
      retrievedActivityIds,
    }),
    recordTripFacts: tool({
      description:
        'Record what you have learned about the trip so far — destination, length, party size, ' +
        'dates, pace, budget, interests. Call this as soon as the traveller tells you something ' +
        'concrete, so their plan survives them closing the tab. Omit anything you are unsure of; ' +
        'omitting a field never erases what we already know.',
      inputSchema: TripFactsSchema,
      execute: async (facts) => {
        // Accumulated rather than written per call: one turn may call this
        // several times, and a single row update at the end is both cheaper and
        // consistent with what the traveller actually ends up seeing.
        briefPatch = { ...briefPatch, ...sanitiseTripFacts(facts) }
        return { recorded: true, fields: Object.keys(facts) }
      },
    }),
  }

  const encoder = new TextEncoder()
  let answer = ''

  /**
   * What is left of this TURN's output allowance, spent down step by step.
   *
   * `maxOutputTokens` is a per-call setting, and a turn is up to
   * `MAX_PLANNER_STEPS` calls. Handing every one of them the full per-request
   * cap is how a documented 2,048-token ceiling became a 16,000-token one, so
   * the turn gets one allowance and each step is capped at whatever survives
   * the steps before it.
   */
  let turnOutputRemaining = limits.maxOutputTokensPerTurn

  /** True once the SESSION budget, rather than this turn's allowance, ran out. */
  let sessionBudgetSpent = false

  /**
   * The cap for the step about to run: the turn's remainder, the per-call
   * ceiling and the session's remainder, whichever binds first.
   */
  const stepOutputCap = (): number => budget.outputCapForNextCall(turnOutputRemaining)

  /**
   * Whether to allow another model call.
   *
   * Stopping at `minUsefulOutputTokens` rather than at zero is deliberate: a
   * step allowed to produce forty tokens spends a full prompt to emit half a
   * sentence, which costs us the prompt and gains the traveller nothing.
   */
  const budgetExhausted = (): boolean => {
    if (stepOutputCap() >= limits.minUsefulOutputTokens) return false
    // Only the session running dry is a product event worth a frame; the turn's
    // own allowance running out is an ordinary long answer ending.
    if (budget.remaining < limits.minUsefulOutputTokens) sessionBudgetSpent = true
    return true
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: PlannerStreamEvent): void => {
        controller.enqueue(encoder.encode(frame(event)))
      }

      send({
        type: 'start',
        sessionId: session.id,
        userMessageId: userMessage.id,
        model: modelLabel,
      })

      let usage: Awaited<ReturnType<typeof collectUsage>> = null
      let finishReason: string | undefined
      /**
       * The class of whatever ended the turn early, or null if nothing did.
       *
       * Kept separate from the `error` frame because the two answer different
       * questions: the frame tells the traveller their reply stopped, this tells
       * ops the provider was called and billed anyway. A turn that timed out at
       * forty-five seconds cost real tokens.
       */
      let failureKind: string | null = null
      const startedAt = Date.now()

      try {
        // The deadline is passed INTO the call rather than merely raced against
        // it, so a timeout actually cancels the upstream request instead of
        // abandoning it to keep streaming tokens we will never read and will
        // still be billed for.
        await withWallClock(async (signal) => {
          const result = streamText({
            model: active.model,
            messages,
            // `buildMessages` puts the system prompt inside the array, which is
            // the whole point of having one assembly point; the SDK refuses a
            // system message in `messages` unless told this was on purpose.
            allowSystemInMessages: true,
            tools,
            // Two conditions, because they bound two different runaways: the
            // step count bounds a tool-calling loop that never converges, and
            // the budget bounds what that loop costs. The step count alone let
            // a session at 119,700 of 120,000 tokens spend eight more calls.
            stopWhen: [stepCountIs(MAX_PLANNER_STEPS), () => budgetExhausted()],
            abortSignal: signal,
            maxOutputTokens: stepOutputCap(),
            // Re-asked before every step rather than fixed for the turn, so the
            // allowance each step gets is what the earlier steps actually left.
            prepareStep: () => ({ maxOutputTokens: stepOutputCap() }),
            // The provider's own count, folded in as soon as it arrives. Without
            // this the budget would still be reading the total it loaded from
            // the database before the turn started, and every check between
            // steps would be answering a question about the past.
            onStepEnd: (step) => {
              budget.recordUsage(step.usage)
              turnOutputRemaining = Math.max(
                0,
                turnOutputRemaining - Math.max(0, Math.trunc(step.usage.outputTokens ?? 0))
              )
            },
            temperature: temperature ?? DEFAULT_PLANNER_TEMPERATURE,
          })

          for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
              answer += part.text
              send({ type: 'delta', text: part.text })
              continue
            }

            if (part.type === 'tool-call') {
              // Names only. Tool *arguments* can carry the traveller's own words,
              // and this frame is the one most likely to end up in a log.
              toolNames.push(part.toolName)
              send({ type: 'tool', name: part.toolName })
              continue
            }

            if (part.type === 'error') throw part.error
          }

          usage = await collectUsage(result.totalUsage)
          finishReason = await result.finishReason

          // A stop condition ends the loop quietly, which is right — whatever
          // the model had already said is still worth reading. But a session
          // that has hit its ceiling is a product event the client renders as
          // an offer, so it is announced rather than left to look like a
          // conversation that simply stopped being interesting.
          if (sessionBudgetSpent) {
            const limit = sessionBudgetExhausted()
            send({ type: 'limit', reason: limit.reason, message: limit.message })
          }
        }, limits.wallClockMs)
      } catch (e) {
        failureKind = errorKindOf(e)

        if (e instanceof AiLimitError) {
          send({ type: 'limit', reason: e.reason, message: e.message })
        } else {
          console.error(
            `[planner] turn failed for session ${session.id}: ${redactForLog(
              e instanceof Error ? `${e.name}: ${e.message}` : String(e)
            )}`
          )
          send({
            type: 'error',
            code: 'INTERNAL',
            message: 'The trip designer stopped unexpectedly. Please try again.',
          })
        }
      }

      // Everything below runs whether the turn succeeded, timed out or failed.
      try {
        const record = buildUsageRecord({
          provider: active.provider,
          modelId: active.modelId,
          purpose: 'PLANNER_TURN',
          usage,
          latencyMs: Date.now() - startedAt,
          ...(finishReason !== undefined ? { finishReason } : {}),
        })

        console.log(describeUsage(record))

        // The spend row. Written even on the failure path — a turn that
        // streamed for forty seconds and then timed out is not free, and an
        // absent row would make the console's totals quietly understate the
        // bill by exactly the calls that went wrong.
        //
        // On that path `usage` is null, because the SDK's total never resolves
        // for a stream that broke. The row therefore carries null token counts
        // rather than zeros: we know it cost something and we do not know how
        // much, and those are different claims.
        recordAiUsage({
          surface: AiSurface.PLANNER,
          outcome: failureKind === null ? AiCallOutcome.SUCCEEDED : AiCallOutcome.FAILED,
          selection: active,
          usage,
          latencyMs: record.latencyMs,
          errorKind: failureKind,
          userId: session.userId,
          anonymousVisitorId: session.anonymousVisitorId,
          plannerSessionId: session.id,
        })

        const toolCalls: Prisma.InputJsonValue = {
          tools: toolNames,
          retrievedActivityIds: [...retrievedActivityIds],
        }

        const fields = toPlannerMessageFields(record)

        const assistant = await appendMessage({
          sessionId: session.id,
          role: PlannerMessageRole.ASSISTANT,
          content: answer,
          toolCalls,
          ...fields,
        })

        // The turn was already counted, atomically, by `claimPrompt` in the
        // route before the model was called. Counting it again here would spend
        // two of the traveller's allowance for one reply.

        const learned = Object.keys(briefPatch).length > 0
        const brief = learned
          ? (await updateBrief(session.id, briefPatch, session.tripBrief)).tripBrief
          : session.tripBrief

        if (learned) send({ type: 'brief', brief })

        send({
          type: 'done',
          messageId: assistant.id,
          model: fields.model,
          promptTokens: fields.promptTokens,
          completionTokens: fields.completionTokens,
          brief,
        })
      } catch (e) {
        console.error(
          `[planner] could not persist turn for session ${session.id}: ${redactForLog(
            e instanceof Error ? `${e.name}: ${e.message}` : String(e)
          )}`
        )
        send({
          type: 'error',
          code: 'INTERNAL',
          message: 'That reply could not be saved. Please reload the conversation.',
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(body, { status: 200, headers: STREAM_HEADERS })
}

/**
 * The destination as an administrator wrote it, not as a client sent it.
 *
 * `tripBrief.destination` is 120 characters of free text accepted on session
 * creation that nothing has ever checked. `Destination.name` is a row in our
 * catalog. Only the second is allowed anywhere near the system message, and
 * this lookup is the only way a place name earns that position — which is why
 * it is keyed on `destinationId` and returns `undefined` rather than falling
 * back to the free text when the row is missing.
 */
async function catalogDestinationName(destinationId?: string): Promise<string | undefined> {
  if (destinationId === undefined) return undefined

  const row = await db.destination.findUnique({
    where: { id: destinationId },
    select: { name: true },
  })

  return row?.name
}

/**
 * Clean what the model told us before it becomes a stored fact.
 *
 * The write-back path is how an injection makes itself permanent: text the
 * model repeats into `recordTripFacts` lands in `tripBrief`, and `tripBrief` is
 * read out and put in front of the model on every later turn. Sanitising the
 * inbound half is not enough on its own, because a model that has been talked
 * into echoing a payload is a laundering service for it.
 *
 * Each field is capped at the length `TripBriefSchema` allows. That is not
 * cosmetic: `[removed]` is longer than most of what it replaces, and a
 * destination that grew past 120 characters would fail `readTripBrief` on the
 * next turn — which does not throw, it silently discards the WHOLE brief and
 * the traveller starts again.
 */
function sanitiseTripFacts(facts: z.infer<typeof TripFactsSchema>): Partial<TripBrief> {
  const clean = (value: string, max: number): string | undefined => {
    const cleaned = sanitiseToolText(value, max).trim()
    return cleaned === '' ? undefined : cleaned
  }

  // Keys are deleted rather than set to undefined. One turn may call this tool
  // several times and the patches are merged in order, so `{ destination:
  // undefined }` from a later call would erase what an earlier one recorded.
  const patch: Partial<TripBrief> = { ...facts }

  if (facts.destination !== undefined) {
    const destination = clean(facts.destination, TRIP_BRIEF_TEXT_LIMITS.destination)
    if (destination === undefined) delete patch.destination
    else patch.destination = destination
  }

  for (const key of ['interests', 'mustSee', 'avoid'] as const) {
    const values = facts[key]
    if (values === undefined) continue

    const cleaned = values.flatMap((value) => {
      const item = clean(value, TRIP_BRIEF_TEXT_LIMITS[key])
      return item === undefined ? [] : [item]
    })

    if (cleaned.length === 0) delete patch[key]
    else patch[key] = cleaned
  }

  return patch
}

/**
 * Count this turn against the account's monthly prompt allowance.
 *
 * Deliberately after the message is on disk: a turn the traveller never
 * received should not be billed against their plan. Anonymous visitors are
 * skipped because they have no counter row — their allowance is enforced on the
 * visitor record instead.
 *
 * A failure here is logged and swallowed. The answer has already been streamed
 * and already been persisted, and turning a counter write into an error frame
 * would tell the traveller their conversation was lost when it was not.
 */
async function countPromptAgainstPlan(actor: Actor): Promise<void> {
  if (actor.kind !== 'user') return

  try {
    await recordUsage(actor.userId, { aiPromptsUsed: 1 })
  } catch (e) {
    console.error(
      `[planner] could not count a prompt for user ${actor.userId}: ${redactForLog(
        e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      )}`
    )
  }
}

/**
 * Await the SDK's usage promise without letting it fail the turn.
 *
 * A provider that reports no usage is a billing problem, not a reason to throw
 * away an answer the traveller has already read.
 */
async function collectUsage(
  pending: PromiseLike<import('ai').LanguageModelUsage>
): Promise<import('ai').LanguageModelUsage | null> {
  try {
    return await pending
  } catch {
    return null
  }
}
