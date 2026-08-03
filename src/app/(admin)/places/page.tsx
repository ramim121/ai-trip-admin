import Link from 'next/link'
import { PlaceCandidateStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { countCandidates, listCandidates } from '@/server/modules/places/service'
import { placesConfigured } from '@/server/places/client'
import { Locked } from '../_components/locked'
import {
  CATALOG_READ_ROLES,
  CATALOG_WRITE_ROLES,
  readConsoleAdminWithRole,
} from '../_lib/console-session'
import { formatDateTime } from '../_lib/format'
import { importPlaces, reopenPlace } from './actions'

/**
 * /places — venues Google knows about, waiting for us to decide.
 *
 * THIS SCREEN IS THE GATE, and the gate is why the integration has this shape.
 * The planner may only recommend rows from `activities`, enforced by a foreign
 * key, and an import lands in `place_candidates` instead — a table nothing
 * traveller-facing can read. So a place sitting in this queue is incapable of
 * appearing in somebody's trip, whatever anybody forgets to check.
 *
 * WHAT GOOGLE CANNOT TELL US is the whole reason a person stands here. Places
 * knows a venue exists and roughly where. It does not know how long to allow for
 * it, what it costs in taka, which of our categories it belongs to, or whether
 * it is worth a morning — the four things an itinerary is actually made of. So
 * approving is not a rubber stamp; it is writing an activity, with the place as
 * a starting point.
 *
 * PENDING IS OLDEST-FIRST, like the quote queue and for the same reason: a
 * newest-first work list is one where the thing nobody has answered sinks
 * quietly out of sight.
 */

export const metadata = { title: 'Place imports · Beyond Borders' }

const STATUSES = [
  PlaceCandidateStatus.PENDING,
  PlaceCandidateStatus.APPROVED,
  PlaceCandidateStatus.REJECTED,
] as const

const STATUS_LABEL: Record<PlaceCandidateStatus, string> = {
  PENDING: 'Waiting',
  APPROVED: 'In the catalogue',
  REJECTED: 'Turned down',
}

function isStatus(value: string): value is PlaceCandidateStatus {
  return Object.hasOwn(PlaceCandidateStatus, value)
}

/** Google's type strings, minus the two that sit on nearly everything. */
const NOISE_TYPES = new Set(['point_of_interest', 'establishment'])

function usefulTypes(types: readonly string[]): string[] {
  const useful = types.filter((type) => !NOISE_TYPES.has(type))
  return useful.length > 0 ? useful.slice(0, 3) : types.slice(0, 2)
}

export default async function PlacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(CATALOG_READ_ROLES)
  if (admin === null) return <Locked />

  const canWrite = (await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)) !== null

  const query = await searchParams
  const done = typeof query.done === 'string' ? query.done : null
  const error = typeof query.error === 'string' ? query.error : null

  // An unrecognised `?status=` falls back to the queue rather than 404ing. This
  // is a filter, and the safe reading of a nonsense filter is the default view.
  const raw = typeof query.status === 'string' ? query.status : null
  const status = raw !== null && isStatus(raw) ? raw : PlaceCandidateStatus.PENDING

  const [candidates, counts, destinations] = await Promise.all([
    listCandidates(status),
    countCandidates(),
    db.destination.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, country: true },
    }),
  ])

  const configured = placesConfigured()

  const tabClass = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      active
        ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
        : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400'
    }`

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Place imports</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Venues pulled from Google, waiting to be turned into activities. Nothing here is visible to
        a traveller — the planner can only recommend what is in the catalogue, and a place joins the
        catalogue when somebody approves it and writes the parts Google does not know.
      </p>

      {done !== null && (
        <p className="mt-3 max-w-prose rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {done}
        </p>
      )}

      {error !== null && (
        <p
          role="alert"
          className="mt-3 max-w-prose rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {/* ── Import ───────────────────────────────────────────────────────── */}
      {canWrite &&
        (configured ? (
          <form
            action={importPlaces}
            className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="min-w-48">
              <label className="block text-sm font-medium" htmlFor="destinationId">
                Destination
              </label>
              <select
                id="destinationId"
                name="destinationId"
                required
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                {destinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.name}, {destination.country}
                  </option>
                ))}
              </select>
            </div>

            <div className="min-w-72 flex-1">
              <label className="block text-sm font-medium" htmlFor="query">
                What to look for
              </label>
              <input
                id="query"
                name="query"
                required
                minLength={3}
                maxLength={200}
                placeholder="beach resorts, seafood restaurants, boat trips…"
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              {/* Worth stating that it is a bias: results are pulled toward the
                  destination's coordinates but not restricted to them, so a
                  jetty an hour away can still appear. */}
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Searched near the destination. Up to 20 results; anything already decided is
                skipped.
              </p>
            </div>

            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            >
              Search Google
            </button>
          </form>
        ) : (
          <p className="mt-6 max-w-prose rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="font-semibold">Google Places is not configured.</span> Set
            <code className="mx-1 font-mono text-xs">GOOGLE_PLACES_API_KEY</code>
            on the server to import. Anything already imported stays reviewable below.
          </p>
        ))}

      {/* ── Queue ────────────────────────────────────────────────────────── */}
      <nav className="mt-6 flex flex-wrap gap-2">
        {STATUSES.map((value) => (
          <Link key={value} href={`/places?status=${value}`} className={tabClass(status === value)}>
            {STATUS_LABEL[value]} ({counts[value]})
          </Link>
        ))}
      </nav>

      {candidates.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          {status === PlaceCandidateStatus.PENDING
            ? 'Nothing waiting. Search above to pull some places in.'
            : `Nothing ${STATUS_LABEL[status].toLowerCase()} yet.`}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full min-w-[64rem] border-collapse text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-3 font-medium">Place</th>
                <th className="px-4 py-3 font-medium">Destination</th>
                <th className="px-4 py-3 font-medium">Google says</th>
                <th className="px-4 py-3 font-medium">Found by</th>
                <th className="px-4 py-3 font-medium">
                  {status === PlaceCandidateStatus.PENDING ? 'Imported' : 'Decided'}
                </th>
                {canWrite && <th className="px-4 py-3 font-medium" />}
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {candidates.map((candidate) => (
                <tr key={candidate.id}>
                  <td className="px-4 py-3">
                    {canWrite && candidate.status === PlaceCandidateStatus.PENDING ? (
                      <Link
                        href={`/places/${candidate.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {candidate.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{candidate.name}</span>
                    )}

                    {candidate.formattedAddress !== null && (
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        {candidate.formattedAddress}
                      </div>
                    )}

                    {candidate.status === PlaceCandidateStatus.APPROVED &&
                      candidate.activity !== null && (
                        <div className="text-xs text-emerald-700 dark:text-emerald-400">
                          → {candidate.activity.name}
                          {!candidate.activity.isActive && ' (unpublished)'}
                        </div>
                      )}

                    {candidate.status === PlaceCandidateStatus.REJECTED &&
                      candidate.rejectedReason !== null && (
                        <div className="text-xs text-zinc-500 italic dark:text-zinc-400">
                          {candidate.rejectedReason}
                        </div>
                      )}
                  </td>

                  <td className="px-4 py-3 whitespace-nowrap">{candidate.destination.name}</td>

                  <td className="px-4 py-3">
                    <div className="text-xs text-zinc-600 dark:text-zinc-400">
                      {usefulTypes(candidate.googleTypes).join(', ') || '—'}
                    </div>
                    {candidate.rating !== null && (
                      <div className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                        {String(candidate.rating)}★ ({candidate.userRatingCount ?? 0})
                      </div>
                    )}
                  </td>

                  <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                    &ldquo;{candidate.searchQuery}&rdquo;
                  </td>

                  <td className="px-4 py-3 text-xs whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                    {candidate.status === PlaceCandidateStatus.PENDING
                      ? formatDateTime(candidate.importedAt)
                      : formatDateTime(candidate.reviewedAt)}
                    {candidate.reviewedBy !== null && (
                      <div className="text-zinc-500 dark:text-zinc-400">
                        {candidate.reviewedBy.name ?? candidate.reviewedBy.email}
                      </div>
                    )}
                  </td>

                  {canWrite && (
                    <td className="px-4 py-3 whitespace-nowrap">
                      {candidate.status === PlaceCandidateStatus.PENDING && (
                        <Link
                          href={`/places/${candidate.id}`}
                          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
                        >
                          Review
                        </Link>
                      )}

                      {/* A rejection is a judgement rather than a fact, and
                          judgements age — a place closed for renovation
                          reopens. Reopening keeps the record that somebody once
                          said no; deleting the row would not. */}
                      {candidate.status === PlaceCandidateStatus.REJECTED && (
                        <form action={reopenPlace}>
                          <input type="hidden" name="candidateId" value={candidate.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
                          >
                            Look again
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
