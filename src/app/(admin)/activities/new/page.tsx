import Link from 'next/link'
import { listDestinations, listTags } from '@/server/modules/catalog/service'
import { Locked } from '../../_components/locked'
import { CATALOG_WRITE_ROLES, readConsoleAdminWithRole } from '../../_lib/console-session'
import { ActivityForm } from '../activity-form'

/**
 * Create an activity.
 *
 * Gated on the WRITE roles rather than the read ones: there is nothing to look at
 * here, so a reader who reached this URL is either lost or trying something.
 *
 * The form leaves `isActive` unchecked by default. A new row starts as a draft,
 * so a half-written activity cannot reach a traveller between the save and the
 * proofread — publishing is the separate, deliberate act on the list screen.
 */
export default async function NewActivityPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  if (admin === null) return <Locked />

  const searchParams = await props.searchParams
  const rawError = searchParams.error
  const error = typeof rawError === 'string' && rawError !== '' ? rawError : undefined

  const [destinations, tags] = await Promise.all([
    listDestinations({ includeInactive: true }),
    listTags(),
  ])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/activities"
          className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
        >
          &larr; Activities
        </Link>
        <h1 className="mt-2 text-lg font-semibold tracking-tight">New activity</h1>
        <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
          It saves as a draft unless you tick Published. Everything written here is something the
          planner may put in front of a traveller and ops is then expected to deliver, so a price or
          an opening time you are unsure of is better left blank than guessed at.
        </p>
      </div>

      <ActivityForm activity={null} destinations={destinations} tags={tags} error={error} />
    </div>
  )
}
