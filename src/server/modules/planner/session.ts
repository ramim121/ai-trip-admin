import type { ModelMessage } from 'ai'
import type { Prisma } from '@/generated/prisma/client'
import { PlannerMessageRole, PlannerSessionStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { TripBriefSchema, mergeTripBrief, type TripBrief } from '@/server/ai/schemas'
import { badRequest, conflict, notFound } from '@/server/http/errors'
import type { Actor } from '@/server/modules/entitlements/service'

/**
 * One planning conversation, and the brief it is accumulating.
 *
 * Two ideas run through this file.
 *
 * Ownership is a WHERE clause, never an `if`. Every read of a session is scoped
 * to the actor inside the query, so there is no code path that loads somebody
 * else's session and then remembers to check. A session that does not match
 * answers 404 rather than 403: "not yours" and "does not exist" have to be the
 * same answer, or the endpoint becomes a way to enumerate real session ids.
 *
 * The brief is rebuilt through `TripBriefSchema` on every read. It lives in a
 * Json column, so the value in the database is whatever was true of this code
 * the day it was written — an older shape, a field since removed, something an
 * admin edited by hand. Parsing on the way out means the rest of the planner
 * only ever sees a brief that is valid *now*, and a row that has rotted degrades
 * to an empty brief instead of throwing in the middle of a conversation.
 */

/** How much history is replayed to the model. Older turns are still stored. */
export const MAX_HISTORY_MESSAGES = 40

/**
 * How many conversations one actor may have open at once.
 *
 * `POST /planner/sessions {"resume": false}` is the deliberate "plan another
 * trip" button, and it used to mint a row every time it was pressed — unbounded
 * ACTIVE sessions per account, each one carrying a fresh `SessionBudget` with a
 * fresh token allowance, which turns spending our AI budget into a clicking
 * exercise rather than a planning one.
 *
 * Ten, because it is far more trips than anyone plans simultaneously and is
 * still a number. Note what this does and does not bound: it bounds ROWS and
 * concurrent budgets. What bounds SPEND is `Plan.aiPromptsPerPeriod`, metered
 * per account per period, and that is the ceiling recycling sessions cannot get
 * around.
 */
export const MAX_ACTIVE_SESSIONS = 10

export interface PlannerSessionRecord {
  id: string
  userId: string | null
  anonymousVisitorId: string | null
  status: PlannerSessionStatus
  tripBrief: TripBrief
  createdAt: Date
  lastMessageAt: Date
}

const SESSION_SELECT = {
  id: true,
  userId: true,
  anonymousVisitorId: true,
  status: true,
  tripBrief: true,
  createdAt: true,
  lastMessageAt: true,
} as const

/** The brief with every field absent — where a conversation starts. */
export function emptyTripBrief(): TripBrief {
  return TripBriefSchema.parse({})
}

/**
 * Read a stored brief back into the current shape.
 *
 * Never throws. A brief that no longer parses is a brief the traveller will
 * simply be asked about again, which is a far better outcome than a 500 in the
 * middle of a conversation they were enjoying.
 */
export function readTripBrief(value: Prisma.JsonValue | null | undefined): TripBrief {
  const parsed = TripBriefSchema.safeParse(value ?? {})
  if (parsed.success) return parsed.data

  console.warn('[planner] stored tripBrief did not parse; starting from an empty brief')
  return emptyTripBrief()
}

function toRecord(row: {
  id: string
  userId: string | null
  anonymousVisitorId: string | null
  status: PlannerSessionStatus
  tripBrief: Prisma.JsonValue
  createdAt: Date
  lastMessageAt: Date
}): PlannerSessionRecord {
  return { ...row, tripBrief: readTripBrief(row.tripBrief) }
}

/**
 * The ownership predicate for one actor.
 *
 * An anonymous actor with no visitor id owns nothing. Returning `{}` there would
 * match every session in the table, so the deliberately impossible predicate is
 * the point: an unidentified caller fails closed, not open.
 */
function ownedBy(actor: Actor): Prisma.PlannerSessionWhereInput {
  if (actor.kind === 'user') return { userId: actor.userId }
  return actor.visitorId === null
    ? { anonymousVisitorId: '00000000-0000-0000-0000-000000000000' }
    : { anonymousVisitorId: actor.visitorId }
}

/**
 * Start a conversation.
 *
 * Exactly one owner column is set, because the database enforces that with a
 * CHECK constraint — both set would let a signed-in user burn the anonymous
 * quota, neither would orphan the conversation.
 *
 * Capped at `MAX_ACTIVE_SESSIONS` open conversations per actor. The count is
 * taken immediately before the insert rather than under a lock, which is a
 * deliberate proportion: a burst of N simultaneous requests can overshoot by up
 * to N, but the overshoot does not compound — every later request re-counts and
 * is refused — so "unlimited sessions" becomes "bounded sessions", which is the
 * property that matters. The ceiling that has to be exact is the per-period AI
 * allowance, and that one is a predicate-bearing claim in the entitlement
 * service rather than a count.
 *
 * 409 rather than 403: nothing about their plan forbids this, they simply have
 * too many trips open, and finishing or abandoning one fixes it.
 */
export async function createSession(
  actor: Actor,
  brief: Partial<TripBrief> = {}
): Promise<PlannerSessionRecord> {
  if (actor.kind === 'anonymous' && actor.visitorId === null) {
    throw badRequest('This visitor could not be identified, so no planning session can be started.')
  }

  const open = await db.plannerSession.count({
    where: { ...ownedBy(actor), status: PlannerSessionStatus.ACTIVE },
  })

  if (open >= MAX_ACTIVE_SESSIONS) {
    throw conflict(
      `You already have ${MAX_ACTIVE_SESSIONS} planning conversations open. Finish or abandon ` +
        'one before starting another.'
    )
  }

  const merged = mergeTripBrief(emptyTripBrief(), brief)

  const row = await db.plannerSession.create({
    data: {
      userId: actor.kind === 'user' ? actor.userId : null,
      anonymousVisitorId: actor.kind === 'anonymous' ? actor.visitorId : null,
      tripBrief: merged as Prisma.InputJsonValue,
    },
    select: SESSION_SELECT,
  })

  return toRecord(row)
}

/**
 * Resume a conversation, or start one.
 *
 * Reuses the actor's most recent ACTIVE session rather than accumulating a row
 * per page load — a traveller who refreshes has not started a second trip.
 */
export async function createOrResumeSession(
  actor: Actor,
  brief: Partial<TripBrief> = {}
): Promise<{ session: PlannerSessionRecord; resumed: boolean }> {
  const existing = await db.plannerSession.findFirst({
    where: { ...ownedBy(actor), status: PlannerSessionStatus.ACTIVE },
    orderBy: { lastMessageAt: 'desc' },
    select: SESSION_SELECT,
  })

  if (existing === null) {
    return { session: await createSession(actor, brief), resumed: false }
  }

  // Anything supplied on resume is new information about the same trip, so it
  // is folded in rather than discarded — or allowed to replace what we know.
  const session =
    Object.keys(brief).length === 0
      ? toRecord(existing)
      : await updateBrief(existing.id, brief, readTripBrief(existing.tripBrief))

  return { session, resumed: true }
}

/** Load a session this actor owns, or 404. */
export async function loadSession(actor: Actor, sessionId: string): Promise<PlannerSessionRecord> {
  const row = await db.plannerSession.findFirst({
    where: { id: sessionId, ...ownedBy(actor) },
    select: SESSION_SELECT,
  })

  if (row === null) throw notFound('That planning session was not found.')

  return toRecord(row)
}

/**
 * Fold newly-learned facts into the brief.
 *
 * `mergeTripBrief` decides the semantics — scalars overwrite, lists union,
 * `undefined` never clears — so a model that omits a field it was not asked
 * about cannot erase what the traveller already told us.
 */
export async function updateBrief(
  sessionId: string,
  patch: Partial<TripBrief>,
  base?: TripBrief
): Promise<PlannerSessionRecord> {
  const current =
    base ??
    readTripBrief(
      (
        await db.plannerSession.findUniqueOrThrow({
          where: { id: sessionId },
          select: { tripBrief: true },
        })
      ).tripBrief
    )

  const merged = mergeTripBrief(current, patch)

  const row = await db.plannerSession.update({
    where: { id: sessionId },
    data: { tripBrief: merged as Prisma.InputJsonValue },
    select: SESSION_SELECT,
  })

  return toRecord(row)
}

export interface AppendMessageInput {
  sessionId: string
  role: PlannerMessageRole
  content: string
  /** Which catalog rows were retrieved, so a recommendation can be replayed. */
  toolCalls?: Prisma.InputJsonValue | undefined
  /** `provider/model-id`. Recorded per message: the model can change mid-conversation. */
  model?: string | undefined
  promptTokens?: number | undefined
  completionTokens?: number | undefined
}

/**
 * Persist one turn and mark the session as alive.
 *
 * Both writes go in one transaction so a stored message can never leave
 * `lastMessageAt` behind — that column is what the resume query orders on, and a
 * session that looks stale is a session a traveller loses.
 */
export async function appendMessage(input: AppendMessageInput): Promise<{ id: string }> {
  const [message] = await db.$transaction([
    db.plannerMessage.create({
      data: {
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
        model: input.model ?? null,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
      },
      select: { id: true },
    }),
    db.plannerSession.update({
      where: { id: input.sessionId },
      data: { lastMessageAt: new Date() },
      select: { id: true },
    }),
  ])

  return message
}

export interface StoredMessage {
  id: string
  role: PlannerMessageRole
  content: string
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  createdAt: Date
}

export async function listMessages(
  sessionId: string,
  limit = MAX_HISTORY_MESSAGES
): Promise<StoredMessage[]> {
  const rows = await db.plannerMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      role: true,
      content: true,
      model: true,
      promptTokens: true,
      completionTokens: true,
      createdAt: true,
    },
  })

  // Newest-first in the query so `take` keeps the *recent* turns; reversed here
  // because a conversation is read forwards.
  return rows.reverse()
}

/**
 * Prior turns, as the model expects them.
 *
 * SYSTEM and TOOL rows are dropped. The system prompt is rebuilt from current
 * entitlement state on every call — replaying a stale one would tell the model a
 * traveller is still on the free tier after they have paid — and tool traffic is
 * stored for audit rather than for replay.
 */
export async function conversationHistory(
  sessionId: string,
  limit = MAX_HISTORY_MESSAGES
): Promise<ModelMessage[]> {
  const rows = await listMessages(sessionId, limit)

  return rows.flatMap((row): ModelMessage[] => {
    if (row.role === PlannerMessageRole.USER) return [{ role: 'user', content: row.content }]
    if (row.role === PlannerMessageRole.ASSISTANT) {
      return row.content.trim() === '' ? [] : [{ role: 'assistant', content: row.content }]
    }
    return []
  })
}

/**
 * Everything this session has spent, for `SessionBudget`.
 *
 * Summed in the database rather than in memory: the budget is checked before
 * every turn, and loading forty rows to add two columns is a query we would
 * regret at the hundredth one.
 */
export async function sessionTokensUsed(sessionId: string): Promise<number> {
  const totals = await db.plannerMessage.aggregate({
    where: { sessionId },
    _sum: { promptTokens: true, completionTokens: true },
  })

  return (totals._sum.promptTokens ?? 0) + (totals._sum.completionTokens ?? 0)
}

/** Mark a session as having produced an itinerary. */
export async function markConverted(sessionId: string): Promise<void> {
  await db.plannerSession.update({
    where: { id: sessionId },
    data: { status: PlannerSessionStatus.CONVERTED },
    select: { id: true },
  })
}
