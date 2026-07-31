import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AdminRole } from '@/generated/prisma/enums'
import {
  getActivity,
  listDestinations,
  listTags,
  type ActivityDetail,
} from '@/server/modules/catalog/service'
import { Locked } from '../../_components/locked'
import {
  CATALOG_READ_ROLES,
  CATALOG_WRITE_ROLES,
  readConsoleAdminWithRole,
} from '../../_lib/console-session'
import { formatDateTime } from '../../_lib/format'
import { setPublished } from '../actions'
import { ActivityForm } from '../activity-form'

/**
 * Edit one activity.
 *
 * Loaded with `includeUnpublished` — this is the screen where a draft is meant to
 * be visible, and the only one.
 *
 * A reader without write access still gets the page, because "what exactly does
 * the catalog say about this" is a fair question for ops mid-booking. They get
 * the record as prose rather than a form, so there is no editable control whose
 * disabled state anybody has to trust.
 *
 * Publish and unpublish sit outside the form on purpose. Submitting the form
 * saves whatever is currently typed; the publish button changes one column and
 * nothing else, so retiring an activity never drags half-finished edits into the
 * catalog with it.
 */
export default async function EditActivityPage(props: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(CATALOG_READ_ROLES)
  if (admin === null) return <Locked />

  const canWrite =
    admin.role === AdminRole.SUPER_ADMIN || CATALOG_WRITE_ROLES.includes(admin.role)

  const { id } = await props.params
  const searchParams = await props.searchParams
  const rawError = searchParams.error
  const error = typeof rawError === 'string' && rawError !== '' ? rawError : undefined

  const activity = await getActivity(id, { includeUnpublished: true })
  if (activity === null) notFound()

  const [destinations, tags] = await Promise.all([
    listDestinations({ includeInactive: true }),
    listTags(),
  ])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/activities"
            className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
          >
            &larr; Activities
          </Link>
          <h1 className="mt-2 text-lg font-semibold tracking-tight">{activity.name}</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {activity.destination.name} · {activity.isActive ? 'Published' : 'Draft'} · last edited{' '}
            {formatDateTime(activity.updatedAt)}
          </p>
        </div>

        {canWrite ? (
          <form action={setPublished}>
            <input type="hidden" name="id" value={activity.id} />
            <input type="hidden" name="isActive" value={activity.isActive ? 'false' : 'true'} />
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              {activity.isActive ? 'Unpublish' : 'Publish'}
            </button>
          </form>
        ) : null}
      </div>

      {activity.isActive ? null : (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          This activity is a draft. It is not listed publicly, not counted in its destination&apos;s
          total, and the planner cannot recommend it.
        </p>
      )}

      {canWrite ? (
        <ActivityForm activity={activity} destinations={destinations} tags={tags} error={error} />
      ) : (
        <ReadOnlyRecord activity={activity} />
      )}
    </div>
  )
}

/** What a staff member without write access sees: the record, not a form. */
function ReadOnlyRecord({ activity }: { activity: ActivityDetail }) {
  const rows: [string, string][] = [
    ['Slug', activity.slug],
    ['Category', activity.category.replace(/_/g, ' ').toLowerCase()],
    ['Duration', `${activity.durationMinutes} minutes on site, excluding travel`],
    [
      'Price per person',
      activity.pricePerPersonBdt === null
        ? 'Free, or quoted on request'
        : `BDT ${activity.pricePerPersonBdt}`,
    ],
    ['Price note', activity.priceNote ?? '—'],
    ['Best time of day', activity.bestTimeOfDay.replace(/_/g, ' ').toLowerCase()],
    ['Intensity', activity.intensity.toLowerCase()],
    ['Booking', activity.bookingRequired ? 'Required in advance' : 'Walk-up'],
    ['Party size', `${activity.minPartySize ?? 'any'} to ${activity.maxPartySize ?? 'any'}`],
    ['Tags', activity.tags.map((tag) => tag.label).join(', ') || '—'],
    [
      'Opening hours',
      activity.openingHours.length === 0
        ? 'Always available — no hours recorded'
        : `${activity.openingHours.length} windows across the week`,
    ],
    ['Images', String(activity.images.length)],
    ['Created', formatDateTime(activity.createdAt)],
  ]

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="max-w-prose text-sm text-zinc-700 dark:text-zinc-300">{activity.summary}</p>

      <dl className="mt-6 grid gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
            <dd className="text-sm text-zinc-900 dark:text-zinc-100">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">
        Editing the catalog is a content role. Ask a curator to change anything here.
      </p>
    </div>
  )
}
