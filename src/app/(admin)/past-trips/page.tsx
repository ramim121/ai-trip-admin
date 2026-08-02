import { PastTripStatus } from '@/generated/prisma/enums'
import { listAllPastTrips, listModerationQueue } from '@/server/modules/past-trips/service'
import { Locked } from '../_components/locked'
import { CATALOG_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatDateRange } from '../_lib/discover-format'
import { formatDateTime } from '../_lib/format'

/**
 * /past-trips — the published record, and everything waiting on a human.
 *
 * Two things on one screen because they are one job. The trips are the content;
 * the queue underneath is what travellers have sent in and nobody has looked at
 * yet. Splitting them across two pages is how a moderation queue ends up three
 * weeks deep — somebody would have to remember to go and check it.
 *
 * The queue is ordered OLDEST FIRST. A backlog worked newest-first leaves the
 * person who has been waiting longest waiting indefinitely.
 */

export const metadata = { title: 'Past trips · Beyond Borders' }

/** Pending counts change as people submit; a cached page would hide a backlog. */
export const dynamic = 'force-dynamic'

const TH = 'px-4 py-3 font-medium'
const TD = 'px-4 py-3'
const CARD = 'rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
const THEAD =
  'border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400'

function statusTone(status: PastTripStatus): string {
  if (status === PastTripStatus.PUBLISHED) return 'text-emerald-700 dark:text-emerald-400'
  if (status === PastTripStatus.ARCHIVED) return 'text-zinc-500 dark:text-zinc-400'
  return 'text-amber-700 dark:text-amber-400'
}

export default async function PastTripsAdminPage() {
  const admin = await readConsoleAdminWithRole(CATALOG_READ_ROLES)
  if (admin === null) return <Locked />

  const [trips, queue] = await Promise.all([listAllPastTrips(), listModerationQueue()])

  const waiting = queue.media.length + queue.reviews.length

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Past trips</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        The public record of what we have run. Travellers can send photographs and reviews, and
        neither appears on the site until somebody here approves it — there is no auto-approve and
        no fourth state.
      </p>

      {waiting > 0 && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-200">
            {waiting} {waiting === 1 ? 'submission is' : 'submissions are'} waiting
          </p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            {queue.media.length} {queue.media.length === 1 ? 'photograph' : 'photographs'} and{' '}
            {queue.reviews.length} {queue.reviews.length === 1 ? 'review' : 'reviews'}. None of it
            is visible to the public until it is approved.
          </p>
        </div>
      )}

      <div className={`mt-6 overflow-x-auto ${CARD}`}>
        <table className="w-full min-w-[62rem] border-collapse text-sm">
          <thead className={THEAD}>
            <tr>
              <th className={TH}>Trip</th>
              <th className={TH}>When</th>
              <th className={TH}>Travellers</th>
              <th className={TH}>Leaders</th>
              <th className={TH}>Highlights</th>
              <th className={TH}>Participants</th>
              <th className={TH}>Waiting</th>
              <th className={TH}>Status</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {trips.map((trip) => {
              const pending = trip._count.media + trip._count.reviews

              return (
                <tr key={trip.id}>
                  <td className={TD}>
                    <div className="font-medium">{trip.title}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {trip.destinationLabel}, {trip.country}
                    </div>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {formatDateRange(trip.startDate, trip.endDate)}
                  </td>
                  <td className={`${TD} tabular-nums`}>{trip.memberCount}</td>
                  <td
                    className={`${TD} tabular-nums ${
                      trip._count.leaders === 0 ? 'text-amber-700 dark:text-amber-400' : ''
                    }`}
                  >
                    {trip._count.leaders}
                  </td>
                  <td className={`${TD} tabular-nums`}>{trip._count.highlights}</td>
                  <td className={`${TD} tabular-nums`}>
                    {trip._count.participants}
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">may review</div>
                  </td>
                  <td
                    className={`${TD} tabular-nums ${
                      pending > 0 ? 'text-amber-700 dark:text-amber-400' : ''
                    }`}
                  >
                    {pending}
                  </td>
                  <td className={`${TD} ${statusTone(trip.status)}`}>
                    {trip.status}
                    {trip.publishedAt !== null && (
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        {formatDateTime(trip.publishedAt)}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}

            {trips.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  No past trips yet. Run <code>npm run db:seed</code> to load the starter set.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 max-w-prose text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        <strong>Travellers</strong> is the curated total who went — most never made an account, so
        it is deliberately not a count of rows. <strong>Participants</strong> is how many of them we
        can match to an account, and therefore how many may leave a review at all.
      </p>

      {/* ── The queue ────────────────────────────────────────────────────── */}

      <h2 className="mt-10 text-base font-semibold tracking-tight">Waiting on a decision</h2>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Oldest first, because the person who has been waiting longest is the one to answer next. A
        rejection has to carry a reason — it goes back to whoever sent it, and is never published.
      </p>

      <h3 className="mt-6 text-sm font-medium">Reviews ({queue.reviews.length})</h3>

      <div className="mt-3 space-y-4">
        {queue.reviews.map((review) => (
          <article key={review.id} className={`${CARD} p-5`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="font-medium">{review.headline}</h4>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {review.trip.title} · {formatDateTime(review.createdAt)}
              </span>
            </div>

            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {review.user.name} · {review.user.email}
              {review.displayName !== null && ` · wants to be shown as “${review.displayName}”`}
            </p>

            <p className="mt-3 max-w-prose text-sm leading-relaxed">{review.body}</p>

            <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs">
              {review.ratings.map((rating) => (
                <div key={rating.dimension} className="flex gap-1.5">
                  <dt className="text-zinc-500 dark:text-zinc-400">{rating.dimension}</dt>
                  <dd className="tabular-nums">{rating.score}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}

        {queue.reviews.length === 0 && (
          <div className={`${CARD} p-6 text-center text-sm text-zinc-500 dark:text-zinc-400`}>
            Nothing waiting.
          </div>
        )}
      </div>

      <h3 className="mt-8 text-sm font-medium">Photographs ({queue.media.length})</h3>

      <div className="mt-3 space-y-3">
        {queue.media.map((photo) => (
          <article key={photo.id} className={`${CARD} p-4`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-xs">{photo.url}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {photo.trip.title} · {formatDateTime(photo.createdAt)}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {photo.uploadedByUser === null
                ? 'uploaded by staff'
                : `${photo.uploadedByUser.name} · ${photo.uploadedByUser.email}`}
            </p>
            <p className="mt-2 text-sm">
              {photo.caption ?? <span className="text-zinc-500">no caption</span>}
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              alt: {photo.alt.trim() === '' ? '— missing, cannot be approved' : photo.alt}
            </p>
          </article>
        ))}

        {queue.media.length === 0 && (
          <div className={`${CARD} p-6 text-center text-sm text-zinc-500 dark:text-zinc-400`}>
            Nothing waiting.
          </div>
        )}
      </div>

      <p className="mt-6 max-w-prose text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        This screen reads the queue; approving and rejecting from here is the next piece of work.
        Until it lands, a decision is made by setting <code>moderationStatus</code> together with{' '}
        <code>reviewedAt</code> and <code>reviewedByAdminId</code> — the database refuses a decided
        row without a timestamp, and refuses a rejection without a reason, so a half-made decision
        cannot be stored.
      </p>
    </section>
  )
}
