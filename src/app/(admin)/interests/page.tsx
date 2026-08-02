import Link from 'next/link'
import { PackageInterestStatus, PackagePricingMode } from '@/generated/prisma/enums'
import { listInterests } from '@/server/modules/packages/service'
import { Locked } from '../_components/locked'
import { COMMERCE_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatTripDate } from '../_lib/discover-format'
import { formatDateTime } from '../_lib/format'

/**
 * /interests — everyone who said they would come.
 *
 * Two different things arrive in this one list, and the pricing column is what
 * tells them apart. On a trip we have not costed, a registration is the demand
 * signal that decides whether we run it at all. On a priced trip it is an
 * enquiry from somebody who could have booked and did not — a different
 * conversation, and usually a more urgent one.
 *
 * OPS rather than CONTENT, because this is a list of names, addresses and phone
 * numbers belonging to people who have not bought anything. It is the leads
 * list, not the catalogue.
 */

export const metadata = { title: 'Interest list · Beyond Borders' }

const TH = 'px-4 py-3 font-medium'
const TD = 'px-4 py-3'

function statusTone(status: PackageInterestStatus): string {
  if (status === PackageInterestStatus.NEW) return 'text-amber-700 dark:text-amber-400'
  if (status === PackageInterestStatus.CONVERTED) return 'text-emerald-700 dark:text-emerald-400'
  if (status === PackageInterestStatus.WITHDRAWN) return 'text-zinc-500 dark:text-zinc-400'
  return ''
}

export default async function InterestsPage() {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const interests = await listInterests()

  const untouched = interests.filter((row) => row.status === PackageInterestStatus.NEW)
  const travellers = interests
    .filter((row) => row.status !== PackageInterestStatus.WITHDRAWN)
    .reduce((total, row) => total + row.partySize, 0)

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Interest list</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        The {interests.length} most recent registrations, newest first — {travellers} travellers
        between them, and {untouched.length} nobody has replied to yet.
      </p>

      <p className="mt-3 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        A registration on a <strong>not priced yet</strong> trip is the demand signal that decides
        whether we run it. On a priced trip it is somebody who could have booked and did not, which
        is a different conversation and usually a more urgent one.
      </p>

      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[62rem] border-collapse text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className={TH}>Who</th>
              <th className={TH}>Trip</th>
              <th className={TH}>Party</th>
              <th className={TH}>Wants</th>
              <th className={TH}>Account</th>
              <th className={TH}>Status</th>
              <th className={TH}>Registered</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {interests.map((row) => (
              <tr key={row.id}>
                <td className={TD}>
                  <div className="font-medium">{row.name}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {row.email}
                    {row.phone !== null && ` · ${row.phone}`}
                  </div>
                  {row.message !== null && (
                    <p className="mt-1 max-w-md text-xs text-zinc-600 dark:text-zinc-400">
                      “{row.message}”
                    </p>
                  )}
                </td>
                <td className={TD}>
                  <Link
                    href={`/packages/${row.package.slug}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {row.package.title}
                  </Link>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {row.package.pricingMode === PackagePricingMode.INTEREST_ONLY
                      ? 'not priced yet'
                      : 'priced'}
                  </div>
                </td>
                <td className={`${TD} tabular-nums`}>{row.partySize}</td>
                <td className={`${TD} whitespace-nowrap`}>
                  {row.departure === null ? (
                    <span className="text-zinc-500 dark:text-zinc-400">any date</span>
                  ) : (
                    formatTripDate(row.departure.startDate)
                  )}
                </td>
                <td className={TD}>
                  {row.user === null ? (
                    <span className="text-zinc-500 dark:text-zinc-400">signed out</span>
                  ) : (
                    <span title={row.user.email}>has an account</span>
                  )}
                </td>
                <td className={`${TD} ${statusTone(row.status)}`}>
                  {row.status}
                  {row.contactedAt !== null && (
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {formatDateTime(row.contactedAt)}
                    </div>
                  )}
                </td>
                <td className={`${TD} whitespace-nowrap text-zinc-600 dark:text-zinc-400`}>
                  {formatDateTime(row.createdAt)}
                </td>
              </tr>
            ))}

            {interests.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  Nobody has registered interest in any trip yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 max-w-prose text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        One registration per email address per trip, enforced by a unique index. A repeat
        registration updates the details rather than adding a row — somebody correcting a phone
        number is doing the obvious thing, and the count on the public card would otherwise inflate
        on every refresh. “Has an account” means they were signed in when they registered; the
        address shown is always the one they typed, which is not necessarily their account’s.
      </p>
    </section>
  )
}
