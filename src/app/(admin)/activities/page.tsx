import Link from 'next/link'
import { AdminRole } from '@/generated/prisma/enums'
import { listDestinations, searchActivities } from '@/server/modules/catalog/service'
import { Locked } from '../_components/locked'
import {
  CATALOG_READ_ROLES,
  CATALOG_WRITE_ROLES,
  readConsoleAdminWithRole,
} from '../_lib/console-session'
import { formatBdt } from '../_lib/format'
import { setPublished } from './actions'

/**
 * The catalog list.
 *
 * Shows UNPUBLISHED rows alongside published ones, which is the one thing this
 * screen does that no public surface may: a draft is invisible everywhere else,
 * and a curator who cannot see their own drafts writes them twice.
 *
 * Reading is open to all staff. The publish controls render only for the roles
 * that may write — but that is presentation, not protection: `setPublished`
 * re-checks the role itself, because a server action is a URL anyone can post to
 * whether or not the button was ever drawn for them.
 */

const CELL = 'px-4 py-3 align-top text-sm'
const HEAD = 'px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500'

function StatusPill({ isActive }: { isActive: boolean }) {
  return (
    <span
      className={
        isActive
          ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
          : 'rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300'
      }
    >
      {isActive ? 'Published' : 'Draft'}
    </span>
  )
}

export default async function ActivitiesPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(CATALOG_READ_ROLES)
  if (admin === null) return <Locked />

  const canWrite = admin.role === AdminRole.SUPER_ADMIN || CATALOG_WRITE_ROLES.includes(admin.role)

  const searchParams = await props.searchParams
  const single = (key: string): string | undefined => {
    const value = searchParams[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  const destinationId = single('destination')
  const query = single('q')
  const error = single('error')

  const [destinations, result] = await Promise.all([
    listDestinations({ includeInactive: true }),
    searchActivities({
      destinationId,
      query,
      // The whole point of this screen. Everywhere else in the product this is
      // false, and has to be.
      includeUnpublished: true,
      limit: 25,
    }),
  ])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Activities</h1>
          <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
            The curated catalog. This is the only inventory the AI planner may recommend, so a row
            that is wrong here is wrong in somebody&apos;s itinerary.
          </p>
        </div>

        {canWrite ? (
          <Link
            href="/activities/new"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            New activity
          </Link>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      ) : null}

      {/* A GET form, so a filtered view is a URL that can be bookmarked and shared. */}
      <form
        method="get"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <label className="block">
          <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Destination
          </span>
          <select
            name="destination"
            defaultValue={destinationId ?? ''}
            className="mt-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">All destinations</option>
            {destinations.map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destination.name} ({destination.activityCount} published)
                {destination.isActive ? '' : ' — retired'}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Search</span>
          <input
            type="search"
            name="q"
            defaultValue={query ?? ''}
            placeholder="Name, summary or slug"
            className="mt-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>

        <button
          type="submit"
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Filter
        </button>

        {destinationId || query ? (
          <Link
            href="/activities"
            className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[64rem] border-collapse">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className={HEAD}>Activity</th>
              <th className={HEAD}>Destination</th>
              <th className={HEAD}>Category</th>
              <th className={HEAD}>Duration</th>
              <th className={HEAD}>Price</th>
              <th className={HEAD}>Booking</th>
              <th className={HEAD}>Status</th>
              <th className={HEAD}>{canWrite ? 'Actions' : ''}</th>
            </tr>
          </thead>

          <tbody>
            {result.activities.length === 0 ? (
              <tr>
                <td className={`${CELL} text-zinc-500`} colSpan={8}>
                  No activities match this filter.
                </td>
              </tr>
            ) : null}

            {result.activities.map((activity) => (
              <tr
                key={activity.id}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
              >
                <td className={CELL}>
                  <Link
                    href={`/activities/${activity.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {activity.name}
                  </Link>
                  <p className="mt-1 max-w-md text-xs text-zinc-500 dark:text-zinc-400">
                    {activity.summary}
                  </p>
                </td>
                <td className={CELL}>{activity.destination.name}</td>
                <td className={`${CELL} lowercase`}>{activity.category.replace(/_/g, ' ')}</td>
                <td className={CELL}>{activity.durationMinutes} min</td>
                <td className={CELL}>
                  {activity.pricePerPersonBdt === null ? (
                    // Not "৳ 0". Null means free or quoted case by case, and
                    // printing zero would tell a curator we charge nothing.
                    <span className="text-zinc-500">On request</span>
                  ) : (
                    formatBdt(activity.pricePerPersonBdt)
                  )}
                </td>
                <td className={CELL}>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {activity.bookingRequired ? 'Required' : 'Walk-up'}
                  </span>
                </td>
                <td className={CELL}>
                  <StatusPill isActive={activity.isActive} />
                </td>
                <td className={CELL}>
                  {canWrite ? (
                    <form action={setPublished}>
                      <input type="hidden" name="id" value={activity.id} />
                      <input
                        type="hidden"
                        name="isActive"
                        value={activity.isActive ? 'false' : 'true'}
                      />
                      <button
                        type="submit"
                        className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        {activity.isActive ? 'Unpublish' : 'Publish'}
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Showing {result.activities.length} of {result.matched} matching{' '}
        {result.matched === 1 ? 'activity' : 'activities'}
        {result.truncated ? ' (more exist — narrow the filter)' : ''}.
      </p>
    </div>
  )
}
