import { z } from 'zod'
import { PollStatus } from '@/generated/prisma/enums'
import type { PollRow } from './service'

/**
 * The wire contract for the public poll.
 *
 * The interesting decision here is what `PublicPollOption.votes` contains, and
 * it is not always the tally.
 *
 * Results are hidden until somebody votes — the product rule, and also the
 * anti-herding one, since seeing the leader before choosing changes the choice.
 * That rule has to be enforced by OMITTING the numbers, not by asking the
 * client not to render them. A response that ships every count alongside a
 * `hasVoted: false` flag is a response whose results are one devtools tab away,
 * and then the rule is decoration.
 *
 * So `votes` and `share` are null until the viewer is entitled to see them, and
 * `resultsVisible` says which of the two shapes arrived.
 */

export const PublicPollOption = z
  .object({
    id: z.uuid(),
    label: z.string(),
    subtitle: z.string().nullable(),
    imageUrl: z.string().nullable(),
    votes: z
      .int()
      .nonnegative()
      .nullable()
      .describe('Null until this viewer may see results. Null means hidden, never zero.'),
    share: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe(
        'This option’s fraction of the total, 0–1, so no client has to divide by a total that ' +
          'may be zero. Null alongside a null `votes`.'
      ),
  })
  .meta({ id: 'PublicPollOption' })
export type PublicPollOption = z.infer<typeof PublicPollOption>

export const PublicPoll = z
  .object({
    slug: z.string(),
    question: z.string(),
    description: z.string().nullable(),
    status: z.enum(PollStatus),
    closesAt: z.iso.datetime().nullable().describe('Null means open until somebody closes it.'),
    open: z
      .boolean()
      .describe(
        'Status AND window together. A poll left OPEN past its `closesAt` reports false here — ' +
          'do not re-derive this from `status` alone.'
      ),
    resultsVisible: z
      .boolean()
      .describe('True when the counts below are populated rather than null.'),
    votedOptionId: z
      .uuid()
      .nullable()
      .describe('What this viewer already chose, so the page can mark it without a second call.'),
    totalVotes: z.int().nonnegative().nullable(),
    options: z.array(PublicPollOption),
  })
  .meta({ id: 'PublicPoll' })
export type PublicPoll = z.infer<typeof PublicPoll>

export const ActivePollResponse = z
  .object({
    poll: PublicPoll.nullable().describe('Null when no poll is running. Render nothing.'),
  })
  .meta({ id: 'ActivePollResponse' })
export type ActivePollResponse = z.infer<typeof ActivePollResponse>

export const CastVoteBody = z
  .object({
    optionId: z.uuid(),
    deviceFingerprint: z
      .string()
      .trim()
      .max(256)
      .optional()
      .describe(
        'The same weak signal the planner preview uses to recognise a browser. It is one of ' +
          'three, and it is not trusted on its own.'
      ),
  })
  .meta({ id: 'CastVoteBody' })
export type CastVoteBody = z.infer<typeof CastVoteBody>

export const CastVoteResponse = z
  .object({
    counted: z
      .boolean()
      .describe(
        'False when this voter had already voted, or the poll had closed. Not an error — the ' +
          'results come back either way, which is what a returning visitor wanted.'
      ),
    poll: PublicPoll.describe('With results now visible, since they have voted.'),
  })
  .meta({ id: 'CastVoteResponse' })
export type CastVoteResponse = z.infer<typeof CastVoteResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Projection
// ─────────────────────────────────────────────────────────────────────────────

export interface PollView {
  /** The option this viewer chose, or null. */
  votedOptionId: string | null
  /** Whether the poll is open right now — status and window together. */
  open: boolean
}

/**
 * Render a poll for one viewer.
 *
 * Results become visible when ANY of three things is true: they voted, the poll
 * is configured to show results up front, or the poll has closed. The third is
 * what stops a finished poll being a permanently locked box for everyone who
 * never got round to voting in it.
 */
export function toPublicPoll(poll: PollRow, view: PollView): PublicPoll {
  const resultsVisible = view.votedOptionId !== null || poll.showResultsBeforeVote || !view.open

  const totalVotes = poll.options.reduce((total, option) => total + option.voteCount, 0)

  return {
    slug: poll.slug,
    question: poll.question,
    description: poll.description,
    status: poll.status,
    closesAt: poll.closesAt?.toISOString() ?? null,
    open: view.open,
    resultsVisible,
    votedOptionId: view.votedOptionId,
    totalVotes: resultsVisible ? totalVotes : null,
    options: poll.options.map((option) => ({
      id: option.id,
      label: option.label,
      subtitle: option.subtitle,
      imageUrl: option.imageUrl,
      votes: resultsVisible ? option.voteCount : null,
      // Guarded against a zero total rather than shipping NaN. The first person
      // to vote on a poll sees a total that was zero a moment ago, and `0/0`
      // renders as "NaN%" on a page nobody tested empty.
      share: resultsVisible ? (totalVotes === 0 ? 0 : option.voteCount / totalVotes) : null,
    })),
  }
}
