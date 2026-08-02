import { Prisma } from '@/generated/prisma/client'
import { PollStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { notFound } from '@/server/http/errors'

/**
 * Public polls: "where should we go next?", and the results people see once
 * they have voted.
 *
 * ONE VOTE PER VOTER IS A DATABASE CONSTRAINT, NOT A CHECK IN THIS FILE
 *
 * `poll_votes` is UNIQUE on (pollId, voterKey). The write below simply happens
 * and lets that constraint decide; nothing here reads-then-writes, because a
 * poll whose numbers can be inflated by opening two tabs is a poll whose
 * numbers are worthless, and the read-then-write gap is exactly how that
 * happens.
 *
 * A duplicate is therefore not an error to report — it IS the answer. The
 * caller gets "you already voted, here is what you chose, here are the
 * results", which is what a returning visitor wanted anyway.
 *
 * WHY `voteCount` IS DENORMALISED
 *
 * A results read becomes one row per option instead of a group-by over every
 * vote ever cast. It is incremented in the same transaction as the vote, so it
 * cannot drift from the rows; `poll_votes` stays the record of truth, and
 * `recountPoll` exists for the day somebody needs to prove it.
 */

/** Postgres unique violation, as Prisma reports it. */
const UNIQUE_VIOLATION = 'P2002'

const OPTION_SELECT = {
  id: true,
  label: true,
  subtitle: true,
  imageUrl: true,
  sortOrder: true,
  voteCount: true,
} as const

const POLL_SELECT = {
  id: true,
  slug: true,
  question: true,
  description: true,
  status: true,
  opensAt: true,
  closesAt: true,
  showResultsBeforeVote: true,
  options: { orderBy: { sortOrder: 'asc' }, select: OPTION_SELECT },
} as const

export type PollRow = Prisma.PollGetPayload<{ select: typeof POLL_SELECT }>
export type PollOptionRow = Prisma.PollOptionGetPayload<{ select: typeof OPTION_SELECT }>

/**
 * Who is voting, as one string.
 *
 * A derived key rather than a pair of nullable columns, because the uniqueness
 * has to hold across every case at once and Postgres cannot make one index span
 * "whichever of these happens to be set".
 *
 * Signing in after voting anonymously produces a different key, deliberately.
 * The alternative — folding an account onto whatever visitor row it was last
 * seen beside — would refuse a genuine first vote from a new account because a
 * stranger on the same office router had already voted.
 */
export function userVoterKey(userId: string): string {
  return `u:${userId}`
}

export function visitorVoterKey(visitorId: string): string {
  return `v:${visitorId}`
}

/**
 * Is this poll open for votes right now?
 *
 * Status AND window, both. A poll left OPEN past its `closesAt` is closed —
 * relying on somebody flipping a status by hand at midnight is how a poll stays
 * open for a week after it ended.
 */
export function isOpen(poll: Pick<PollRow, 'status' | 'opensAt' | 'closesAt'>, now: Date): boolean {
  if (poll.status !== PollStatus.OPEN) return false
  if (poll.opensAt !== null && poll.opensAt > now) return false
  if (poll.closesAt !== null && poll.closesAt <= now) return false
  return true
}

/**
 * The poll to show on Discover: the first open one in curator order.
 *
 * Null when there is none, and the page then renders nothing rather than an
 * empty widget. A poll section with no poll in it is worse than no poll section.
 */
export async function activePoll(now: Date = new Date()): Promise<PollRow | null> {
  const polls = await db.poll.findMany({
    where: {
      status: PollStatus.OPEN,
      OR: [{ opensAt: null }, { opensAt: { lte: now } }],
      AND: [{ OR: [{ closesAt: null }, { closesAt: { gt: now } }] }],
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    take: 1,
    select: POLL_SELECT,
  })

  return polls[0] ?? null
}

export async function getPoll(slug: string): Promise<PollRow | null> {
  return db.poll.findUnique({ where: { slug }, select: POLL_SELECT })
}

/** Which option this voter already chose, or null if they have not voted. */
export async function existingVote(pollId: string, voterKey: string): Promise<string | null> {
  const vote = await db.pollVote.findUnique({
    where: { pollId_voterKey: { pollId, voterKey } },
    select: { optionId: true },
  })
  return vote?.optionId ?? null
}

export interface VoteInput {
  slug: string
  optionId: string
  voterKey: string
  userId?: string | null
  anonymousVisitorId?: string | null
}

export interface VoteResult {
  poll: PollRow
  /** What this voter chose — the new vote, or the one they already had. */
  chosenOptionId: string
  /** False when the constraint said they had already voted. Not an error. */
  counted: boolean
}

/**
 * Cast one vote.
 *
 * The insert and the increment are one transaction, so a counted vote and its
 * tally cannot come apart: a crash between them would otherwise leave a vote
 * that exists and is not counted, which is undetectable afterwards.
 *
 * The unique violation is caught rather than pre-empted. Checking first and
 * inserting second leaves a window in which two concurrent requests both find
 * nothing and both insert — and the second insert is the one this whole feature
 * exists to prevent.
 *
 * A closed poll is not an exception. Somebody clicking an option on a poll that
 * closed while their page was open gets the results and `counted: false`, which
 * the client renders as "voting has closed" — refusing outright would leave
 * them staring at a form that no longer does anything.
 */
export async function castVote(input: VoteInput, now: Date = new Date()): Promise<VoteResult> {
  const poll = await getPoll(input.slug)
  if (poll === null) throw notFound('That poll was not found.')

  if (!isOpen(poll, now)) {
    const already = await existingVote(poll.id, input.voterKey)
    return { poll, chosenOptionId: already ?? input.optionId, counted: false }
  }

  // The option must belong to THIS poll. The composite foreign key added in the
  // migration enforces it at the storage layer too — this check exists so the
  // caller gets a 404 with a sentence rather than a constraint violation.
  const option = poll.options.find((candidate) => candidate.id === input.optionId)
  if (option === undefined) throw notFound('That option is not on this poll.')

  try {
    await db.$transaction(async (tx) => {
      await tx.pollVote.create({
        data: {
          pollId: poll.id,
          optionId: option.id,
          voterKey: input.voterKey,
          userId: input.userId ?? null,
          anonymousVisitorId: input.anonymousVisitorId ?? null,
        },
        select: { id: true },
      })

      await tx.pollOption.update({
        where: { id: option.id },
        data: { voteCount: { increment: 1 } },
        select: { id: true },
      })
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === UNIQUE_VIOLATION) {
      const already = await existingVote(poll.id, input.voterKey)
      // Re-read, so a second click still shows the tallies as they stand rather
      // than the ones from before the first click.
      const refreshed = (await getPoll(input.slug)) ?? poll
      return { poll: refreshed, chosenOptionId: already ?? option.id, counted: false }
    }
    throw e
  }

  const refreshed = (await getPoll(input.slug)) ?? poll
  return { poll: refreshed, chosenOptionId: option.id, counted: true }
}

/**
 * Rebuild every option's tally from the votes themselves.
 *
 * The denormalised counter should never need this — it is written inside the
 * same transaction as the vote. It exists because "should never" is not an
 * argument anybody can check, and a tally nobody can verify is a tally nobody
 * should publish. Console only.
 */
export async function recountPoll(pollId: string): Promise<{ optionId: string; votes: number }[]> {
  const [counts, options] = await Promise.all([
    db.pollVote.groupBy({ by: ['optionId'], where: { pollId }, _count: { _all: true } }),
    db.pollOption.findMany({ where: { pollId }, select: { id: true } }),
  ])

  const byOption = new Map(counts.map((row) => [row.optionId, row._count._all]))

  return Promise.all(
    options.map(async (option) => {
      const votes = byOption.get(option.id) ?? 0
      await db.pollOption.update({
        where: { id: option.id },
        data: { voteCount: votes },
        select: { id: true },
      })
      return { optionId: option.id, votes }
    })
  )
}

/** Every poll, drafts and closed ones included. Console only. */
export async function listAllPolls(take = 100) {
  return db.poll.findMany({
    orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
    take,
    select: {
      id: true,
      slug: true,
      question: true,
      description: true,
      status: true,
      opensAt: true,
      closesAt: true,
      showResultsBeforeVote: true,
      createdAt: true,
      options: { orderBy: { sortOrder: 'asc' }, select: OPTION_SELECT },
      _count: { select: { votes: true } },
    },
  })
}
