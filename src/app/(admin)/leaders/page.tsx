import Link from 'next/link'
import { db } from '@/lib/db'
import { Locked } from '../_components/locked'
import { CATALOG_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'

/**
 * /leaders — the people who run trips.
 *
 * A table of people rather than three text columns on each package, because the
 * same guide leads eleven trips and their photo should not be uploaded eleven
 * times. What is worth reading here is the trips beside each name, and the role
 * on each: the role is per package, so somebody can be the LEADER on eight and
 * the local GUIDE on the ninth.
 */

export const metadata = { title: 'Trip leaders · Beyond Borders' }

const CARD = 'rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'

export default async function LeadersPage() {
  const admin = await readConsoleAdminWithRole(CATALOG_READ_ROLES)
  if (admin === null) return <Locked />

  const leaders = await db.tripLeader.findMany({
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      slug: true,
      name: true,
      role: true,
      headline: true,
      bio: true,
      yearsExperience: true,
      tripsLed: true,
      languages: true,
      isActive: true,
      packages: {
        orderBy: { package: { sortOrder: 'asc' } },
        select: {
          role: true,
          isPrimary: true,
          package: { select: { slug: true, title: true, status: true } },
        },
      },
    },
  })

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Trip leaders</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Leaders, managers and local guides. The role beside each trip is the one they hold on that
        trip — it overrides their usual role, because the same person leads some departures and goes
        along as the local specialist on others.
      </p>

      <div className="mt-6 space-y-4">
        {leaders.map((leader) => (
          <article key={leader.id} className={`${CARD} p-5`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-medium">
                {leader.name}
                {!leader.isActive && (
                  <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                    · no longer active
                  </span>
                )}
              </h2>
              <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                usually {leader.role}
              </span>
            </div>

            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{leader.headline}</p>
            <p className="mt-3 max-w-prose text-sm leading-relaxed">{leader.bio}</p>

            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              {leader.yearsExperience ?? '—'} years · {leader.tripsLed} trips led ·{' '}
              {leader.languages.join(', ')}
            </p>

            {leader.packages.length > 0 ? (
              <ul className="mt-4 flex flex-wrap gap-2 text-xs">
                {leader.packages.map((assignment) => (
                  <li key={assignment.package.slug}>
                    <Link
                      href={`/packages/${assignment.package.slug}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 underline-offset-4 hover:underline dark:border-zinc-700"
                    >
                      <span>{assignment.package.title}</span>
                      <span className="text-zinc-500 dark:text-zinc-400">
                        {assignment.role}
                        {assignment.isPrimary && ' · primary'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
                Not assigned to any trip.
              </p>
            )}
          </article>
        ))}

        {leaders.length === 0 && (
          <div className={`${CARD} p-8 text-center text-sm text-zinc-500 dark:text-zinc-400`}>
            No trip leaders yet. Run <code>npm run db:seed</code> to load the starter set.
          </div>
        )}
      </div>
    </section>
  )
}
