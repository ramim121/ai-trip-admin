import { PollStatus } from '@/generated/prisma/enums'
import { isOpen, listAllPolls } from '@/server/modules/polls/service'
import { Locked } from '../_components/locked'
import { CATALOG_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatDateTime } from '../_lib/format'

/**
 * /polls — what the public poll is being told.
 *
 * Staff see every tally unconditionally. Travellers do not: on the public
 * endpoint the counts are OMITTED until somebody votes — not shipped with a
 * flag asking the client to hide them, because a response carrying the numbers
 * has them one devtools tab away and the rule becomes decoration.
 *
 * The "open" reading is worth trusting over the status column. A poll left OPEN
 * past its close date is closed, and the two disagree exactly when nobody has
 * got round to flipping the status by hand.
 */

export const metadata = { title: 'Polls · Beyond Borders' }

const CARD = 'rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'

export default async function PollsPage() {
  const admin = await readConsoleAdminWithRole(CATALOG_READ_ROLES)
  if (admin === null) return <Locked />

  const now = new Date()
  const polls = await listAllPolls()

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Polls</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        One vote per voter is a unique constraint in Postgres, not a check in application code — a
        poll whose numbers can be inflated by opening a second tab is a poll whose numbers are
        worthless. The Discover page shows the first poll that is genuinely open, in this order.
      </p>

      <div className="mt-6 space-y-6">
        {polls.map((poll) => {
          const total = poll.options.reduce((sum, option) => sum + option.voteCount, 0)
          const open = isOpen(poll, now)
          const leader = [...poll.options].sort((a, b) => b.voteCount - a.voteCount)[0]

          return (
            <article key={poll.id} className={`${CARD} p-5`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-medium">{poll.question}</h2>
                <span
                  className={`text-xs uppercase tracking-wide ${
                    open
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  {open ? 'open' : 'not accepting votes'} · {poll.status}
                </span>
              </div>

              {poll.description !== null && (
                <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
                  {poll.description}
                </p>
              )}

              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                /{poll.slug} · {poll._count.votes} {poll._count.votes === 1 ? 'vote' : 'votes'} ·
                opens {formatDateTime(poll.opensAt)} · closes {formatDateTime(poll.closesAt)} ·{' '}
                {poll.showResultsBeforeVote
                  ? 'results shown before voting'
                  : 'results hidden until they vote'}
              </p>

              {poll.status === PollStatus.OPEN && !open && (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                  Status says OPEN but the window has passed, so votes are refused. The public
                  endpoint reports it closed — status alone is never the answer.
                </p>
              )}

              <ul className="mt-4 space-y-3">
                {poll.options.map((option) => {
                  const share = total === 0 ? 0 : option.voteCount / total
                  const isLeader = leader !== undefined && option.id === leader.id && total > 0

                  return (
                    <li key={option.id}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className={isLeader ? 'font-medium' : ''}>
                          {option.label}
                          {option.subtitle !== null && (
                            <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                              {option.subtitle}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-400">
                          {option.voteCount} · {Math.round(share * 100)}%
                        </span>
                      </div>

                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <div
                          className={`h-full ${
                            isLeader ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-500'
                          }`}
                          style={{ width: `${Math.round(share * 100)}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>

              {total === 0 && (
                <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
                  Nobody has voted yet.
                </p>
              )}
            </article>
          )
        })}

        {polls.length === 0 && (
          <div className={`${CARD} p-8 text-center text-sm text-zinc-500 dark:text-zinc-400`}>
            No polls yet. Run <code>npm run db:seed</code> to load the starter poll.
          </div>
        )}
      </div>

      <p className="mt-6 max-w-prose text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        The percentages come from a denormalised counter written inside the same transaction as each
        vote, so it cannot drift from the rows. <code>poll_votes</code> remains the record of truth,
        and <code>recountPoll</code> rebuilds the counters from it for the day somebody needs to
        prove that.
      </p>
    </section>
  )
}
