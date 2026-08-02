import Link from 'next/link'
import { PackageStatus } from '@/generated/prisma/enums'
import { listAllPackages } from '@/server/modules/packages/service'
import { Locked } from '../_components/locked'
import { CATALOG_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatPackagePrice } from '../_lib/discover-format'
import { formatDateTime } from '../_lib/format'

/**
 * /packages — every trip in the Discover catalogue, drafts included.
 *
 * The one place that shows unpublished rows. Everything the public site reads
 * goes through a WHERE clause that excludes them, which is right there and
 * wrong here: a curator's list of what exists is not a traveller's list of what
 * they can book, and this screen is the first one.
 *
 * The counts on each row are what tell a curator whether a package is actually
 * finished. A PUBLISHED trip with no itinerary days renders as a card that
 * opens onto an empty page; a trip with no leader assigned has nobody to put on
 * it. Both are visible here at a glance rather than by opening eight pages.
 */

export const metadata = { title: 'Packages · Beyond Borders' }

const TH = 'px-4 py-3 font-medium'
const TD = 'px-4 py-3'

/** What a status means for whether travellers can see it. */
function statusTone(status: PackageStatus): string {
  if (status === PackageStatus.PUBLISHED) return 'text-emerald-700 dark:text-emerald-400'
  if (status === PackageStatus.ARCHIVED) return 'text-zinc-500 dark:text-zinc-400'
  return 'text-amber-700 dark:text-amber-400'
}

export default async function PackagesPage() {
  const admin = await readConsoleAdminWithRole(CATALOG_READ_ROLES)
  if (admin === null) return <Locked />

  const packages = await listAllPackages()

  const published = packages.filter((row) => row.status === PackageStatus.PUBLISHED)
  const incomplete = published.filter((row) => row._count.days === 0 || row._count.leaders === 0)

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Packages</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        The Discover catalogue. {published.length} of {packages.length} are published and visible on
        the website; the rest are invisible to travellers, and a draft slug 404s exactly as an
        unknown one does.
      </p>

      {incomplete.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-200">
            {incomplete.length} published {incomplete.length === 1 ? 'package is' : 'packages are'}{' '}
            missing content
          </p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            A published trip with no itinerary days is a card that opens onto an empty page, and one
            with no leader assigned has nobody to put on it. Affected:{' '}
            {incomplete.map((row) => row.slug).join(', ')}.
          </p>
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[68rem] border-collapse text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className={TH}>Trip</th>
              <th className={TH}>Tab</th>
              <th className={TH}>Type</th>
              <th className={TH}>Price</th>
              <th className={TH}>Length</th>
              <th className={TH}>Days</th>
              <th className={TH}>Departures</th>
              <th className={TH}>Leaders</th>
              <th className={TH}>Registered</th>
              <th className={TH}>Status</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {packages.map((row) => (
              <tr key={row.id}>
                <td className={TD}>
                  <Link
                    href={`/packages/${row.slug}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {row.title}
                  </Link>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {row.destinationLabel}
                  </div>
                </td>
                <td className={TD}>{row.scope}</td>
                <td className={TD}>{row.kind}</td>
                <td className={`${TD} whitespace-nowrap tabular-nums`}>
                  {formatPackagePrice(row.pricingMode, row.priceFromBdt, row.priceToBdt)}
                </td>
                <td className={`${TD} tabular-nums`}>{row.durationDays} d</td>
                <td
                  className={`${TD} tabular-nums ${
                    row._count.days === 0 ? 'text-amber-700 dark:text-amber-400' : ''
                  }`}
                >
                  {row._count.days}
                </td>
                <td className={`${TD} tabular-nums`}>{row._count.departures}</td>
                <td
                  className={`${TD} tabular-nums ${
                    row._count.leaders === 0 ? 'text-amber-700 dark:text-amber-400' : ''
                  }`}
                >
                  {row._count.leaders}
                </td>
                <td className={`${TD} tabular-nums`}>{row._count.interests}</td>
                <td className={`${TD} ${statusTone(row.status)}`}>
                  {row.status}
                  {row.publishedAt !== null && (
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {formatDateTime(row.publishedAt)}
                    </div>
                  )}
                </td>
              </tr>
            ))}

            {packages.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  No packages yet. Run <code>npm run db:seed</code> to load the starter catalogue.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 max-w-prose text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        Two counts here look alike and are not. <strong>Registered</strong> is people on the
        interest list — a lead. Seats held on a dated departure are a commitment, and live on the
        departure itself on each trip’s own page. They are never added together, so a waiting list
        can never close a departure.
      </p>

      <div className="mt-6 flex flex-wrap gap-4 text-sm">
        <Link href="/leaders" className="underline underline-offset-4">
          Trip leaders
        </Link>
        <Link href="/interests" className="underline underline-offset-4">
          Interest list
        </Link>
        <Link href="/polls" className="underline underline-offset-4">
          Polls
        </Link>
      </div>
    </section>
  )
}
