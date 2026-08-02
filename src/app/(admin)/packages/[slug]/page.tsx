import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  DepartureStatus,
  PackageInterestStatus,
  PackageKind,
  PackageStatus,
} from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { Locked } from '../../_components/locked'
import { CATALOG_READ_ROLES, readConsoleAdminWithRole } from '../../_lib/console-session'
import {
  formatDateRange,
  formatDuration,
  formatGroupSize,
  formatMinuteOfDay,
  formatPackagePrice,
  formatTripDate,
} from '../../_lib/discover-format'
import { formatDateTime } from '../../_lib/format'

/**
 * /packages/{slug} — one trip, as ops needs to see it.
 *
 * Queried straight from `db` rather than through `modules/packages/service.ts`,
 * which is the console convention (see subscriptions) and here also a
 * requirement: every read in that module filters to PUBLISHED, and the point of
 * this screen is to work on a trip before it is published.
 *
 * The sections below are the questions a curator has about a package. What are
 * we actually selling — the day-by-day. Who is running it — the leaders, with
 * the role they hold on THIS trip rather than their usual one. Is anyone coming
 * — the departures with real seat counts, and the interest list beside them,
 * kept visibly separate because they are not the same number.
 */

export const metadata = { title: 'Package · Beyond Borders' }

const TH = 'px-4 py-3 font-medium'
const TD = 'px-4 py-3'
const CARD = 'rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
const THEAD =
  'border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400'
const TBODY = 'divide-y divide-zinc-100 dark:divide-zinc-800'

function departureTone(status: DepartureStatus): string {
  if (status === DepartureStatus.GUARANTEED) return 'text-emerald-700 dark:text-emerald-400'
  if (status === DepartureStatus.CANCELLED) return 'text-red-700 dark:text-red-400'
  if (status === DepartureStatus.SOLD_OUT) return 'text-amber-700 dark:text-amber-400'
  return ''
}

export default async function PackageDetailPage(ctx: PageProps<'/packages/[slug]'>) {
  const admin = await readConsoleAdminWithRole(CATALOG_READ_ROLES)
  if (admin === null) return <Locked />

  const { slug } = await ctx.params

  const pkg = await db.travelPackage.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      description: true,
      scope: true,
      kind: true,
      pricingMode: true,
      status: true,
      destinationLabel: true,
      country: true,
      durationDays: true,
      durationNights: true,
      priceFromBdt: true,
      priceToBdt: true,
      groupSizeMin: true,
      groupSizeMax: true,
      highlights: true,
      inclusions: true,
      exclusions: true,
      publishedAt: true,
      updatedAt: true,
      destination: { select: { slug: true, name: true } },
      days: {
        orderBy: { dayNumber: 'asc' },
        select: {
          id: true,
          dayNumber: true,
          title: true,
          summary: true,
          accommodation: true,
          meals: true,
          items: {
            orderBy: { position: 'asc' },
            select: {
              id: true,
              kind: true,
              title: true,
              detail: true,
              startMinute: true,
              durationMinutes: true,
            },
          },
        },
      },
      departures: {
        orderBy: { startDate: 'asc' },
        select: {
          id: true,
          startDate: true,
          endDate: true,
          capacity: true,
          seatsTaken: true,
          priceBdt: true,
          status: true,
          notes: true,
        },
      },
      leaders: {
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        select: {
          id: true,
          role: true,
          isPrimary: true,
          leader: {
            select: {
              slug: true,
              name: true,
              headline: true,
              yearsExperience: true,
              tripsLed: true,
              languages: true,
            },
          },
        },
      },
      interests: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          partySize: true,
          status: true,
          createdAt: true,
          departure: { select: { startDate: true } },
        },
      },
    },
  })

  if (pkg === null) notFound()

  const live = pkg.interests.filter((row) => row.status !== PackageInterestStatus.WITHDRAWN)
  const travellersRegistered = live.reduce((total, row) => total + row.partySize, 0)

  return (
    <section>
      <Link
        href="/packages"
        className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
      >
        ← All packages
      </Link>

      <h1 className="mt-3 text-xl font-semibold tracking-tight">{pkg.title}</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">{pkg.summary}</p>

      <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Status', value: pkg.status },
          {
            label: 'Price',
            value: formatPackagePrice(pkg.pricingMode, pkg.priceFromBdt, pkg.priceToBdt),
          },
          { label: 'Length', value: `${pkg.durationDays} days, ${pkg.durationNights} nights` },
          {
            label: 'Group size',
            value:
              pkg.kind === PackageKind.GROUP
                ? formatGroupSize(pkg.groupSizeMin, pkg.groupSizeMax)
                : 'Private departure',
          },
        ].map((item) => (
          <div key={item.label} className={`${CARD} p-4`}>
            <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {item.label}
            </dt>
            <dd className="mt-1 font-medium">{item.value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
        {pkg.scope} · {pkg.kind} · {pkg.pricingMode} · {pkg.destinationLabel}, {pkg.country}
        {pkg.destination !== null && ` · linked to catalog destination “${pkg.destination.name}”`}
        {pkg.status === PackageStatus.PUBLISHED
          ? ` · published ${formatDateTime(pkg.publishedAt)}`
          : ' · not visible to travellers'}
      </p>

      {/* ── People ───────────────────────────────────────────────────────── */}

      <h2 className="mt-10 text-base font-semibold tracking-tight">Who is running it</h2>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        The role shown is the one they hold on <em>this</em> trip, which may differ from their usual
        one — the same guide leads eight trips and goes along as the local guide on the ninth. At
        most one can be primary, enforced by a partial unique index.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pkg.leaders.map((entry) => (
          <div key={entry.id} className={`${CARD} p-4`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{entry.leader.name}</span>
              <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {entry.role}
                {entry.isPrimary && ' · primary'}
              </span>
            </div>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{entry.leader.headline}</p>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              {entry.leader.yearsExperience ?? '—'} years · {entry.leader.tripsLed} trips led ·{' '}
              {entry.leader.languages.join(', ')}
            </p>
          </div>
        ))}

        {pkg.leaders.length === 0 && (
          <div className={`${CARD} p-4 text-sm text-amber-700 dark:text-amber-400`}>
            Nobody is assigned. A published group trip with no leader has nobody to put on the card.
          </div>
        )}
      </div>

      {/* ── Departures ───────────────────────────────────────────────────── */}

      <h2 className="mt-10 text-base font-semibold tracking-tight">Departures</h2>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Seats held, not leads. <code>seatsTaken ≤ capacity</code> is a database CHECK, so the
        statement that would take the seventeenth seat on a sixteen-seat trip fails rather than
        succeeding quietly.
      </p>

      <div className={`mt-4 overflow-x-auto ${CARD}`}>
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <thead className={THEAD}>
            <tr>
              <th className={TH}>Dates</th>
              <th className={TH}>Seats</th>
              <th className={TH}>Price override</th>
              <th className={TH}>Status</th>
              <th className={TH}>Notes</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {pkg.departures.map((departure) => (
              <tr key={departure.id}>
                <td className={`${TD} whitespace-nowrap`}>
                  {formatDateRange(departure.startDate, departure.endDate)}
                </td>
                <td className={`${TD} tabular-nums`}>
                  {departure.seatsTaken} / {departure.capacity}
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {Math.max(0, departure.capacity - departure.seatsTaken)} left
                  </div>
                </td>
                <td className={`${TD} tabular-nums`}>
                  {departure.priceBdt === null ? (
                    <span className="text-zinc-500 dark:text-zinc-400">package price</span>
                  ) : (
                    `৳ ${departure.priceBdt.toLocaleString('en-GB')}`
                  )}
                </td>
                <td className={`${TD} ${departureTone(departure.status)}`}>{departure.status}</td>
                <td className={`${TD} text-zinc-600 dark:text-zinc-400`}>
                  {departure.notes ?? '—'}
                </td>
              </tr>
            ))}

            {pkg.departures.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  No fixed departures. This trip runs on the traveller’s own dates.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Itinerary ────────────────────────────────────────────────────── */}

      <h2 className="mt-10 text-base font-semibold tracking-tight">The day-by-day</h2>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        This is the product description on the public page, not a summary of it. Times are minutes
        from local midnight, the same convention the planner uses; an item with no time is
        deliberately vague rather than missing data.
      </p>

      <ol className="mt-4 space-y-4">
        {pkg.days.map((day) => (
          <li key={day.id} className={`${CARD} p-4`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">
                Day {day.dayNumber} · {day.title}
              </h3>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {day.accommodation ?? 'no overnight'}
                {day.meals.length > 0 && ` · ${day.meals.join(', ')}`}
              </span>
            </div>

            {day.summary !== null && (
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{day.summary}</p>
            )}

            <ul className="mt-3 space-y-1.5 text-sm">
              {day.items.map((item) => (
                <li key={item.id} className="flex gap-3">
                  <span className="w-14 shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
                    {formatMinuteOfDay(item.startMinute) || '—'}
                  </span>
                  <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                    {item.kind}
                  </span>
                  <span className="flex-1">
                    {item.title}
                    {item.durationMinutes !== null && (
                      <span className="text-zinc-500 dark:text-zinc-400">
                        {' '}
                        · {formatDuration(item.durationMinutes)}
                      </span>
                    )}
                    {item.detail !== null && (
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {item.detail}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}

        {pkg.days.length === 0 && (
          <li className={`${CARD} p-4 text-sm text-amber-700 dark:text-amber-400`}>
            No itinerary yet. A published trip with no days is a card that opens onto an empty page.
          </li>
        )}
      </ol>

      {/* ── Interest ─────────────────────────────────────────────────────── */}

      <h2 className="mt-10 text-base font-semibold tracking-tight">Interest list</h2>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        {live.length} {live.length === 1 ? 'registration' : 'registrations'}, covering{' '}
        {travellersRegistered} {travellersRegistered === 1 ? 'traveller' : 'travellers'}. One per
        email address, enforced by a unique index — the public card prints this count, so a
        duplicate would inflate the number the feature exists to communicate.
      </p>

      <div className={`mt-4 overflow-x-auto ${CARD}`}>
        <table className="w-full min-w-[48rem] border-collapse text-sm">
          <thead className={THEAD}>
            <tr>
              <th className={TH}>Who</th>
              <th className={TH}>Party</th>
              <th className={TH}>Wants</th>
              <th className={TH}>Status</th>
              <th className={TH}>Registered</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {pkg.interests.map((row) => (
              <tr key={row.id}>
                <td className={TD}>
                  <div className="font-medium">{row.name}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {row.email}
                    {row.phone !== null && ` · ${row.phone}`}
                  </div>
                </td>
                <td className={`${TD} tabular-nums`}>{row.partySize}</td>
                <td className={TD}>
                  {row.departure === null ? (
                    <span className="text-zinc-500 dark:text-zinc-400">any date</span>
                  ) : (
                    formatTripDate(row.departure.startDate)
                  )}
                </td>
                <td className={TD}>{row.status}</td>
                <td className={`${TD} whitespace-nowrap text-zinc-600 dark:text-zinc-400`}>
                  {formatDateTime(row.createdAt)}
                </td>
              </tr>
            ))}

            {pkg.interests.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  Nobody has registered yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Copy ─────────────────────────────────────────────────────────── */}

      <h2 className="mt-10 text-base font-semibold tracking-tight">Page copy</h2>

      <div className={`mt-4 ${CARD} p-4`}>
        <p className="whitespace-pre-line text-sm leading-relaxed">{pkg.description}</p>

        <div className="mt-6 grid gap-6 sm:grid-cols-3">
          {[
            { title: 'Highlights', items: pkg.highlights },
            { title: 'Included', items: pkg.inclusions },
            { title: 'Not included', items: pkg.exclusions },
          ].map((column) => (
            <div key={column.title}>
              <h3 className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {column.title}
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {column.items.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
        Last edited {formatDateTime(pkg.updatedAt)}. This content is owned by{' '}
        <code>prisma/seed-data/discover.ts</code> and re-applied on every seed run, so edit it there
        rather than in the database.
      </p>
    </section>
  )
}
