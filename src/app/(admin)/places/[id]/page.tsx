import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActivityCategory, ActivityIntensity, TimeOfDay } from '@/generated/prisma/enums'
import type { ActivityDetail } from '@/server/modules/catalog/service'
import { listDestinations, listTags } from '@/server/modules/catalog/service'
import { readCandidate, suggestCategory, suggestSlug } from '@/server/modules/places/service'
import { Locked } from '../../_components/locked'
import { CATALOG_WRITE_ROLES, readConsoleAdminWithRole } from '../../_lib/console-session'
import { formatDateTime } from '../../_lib/format'
import { ActivityForm } from '../../activities/activity-form'
import { approveCandidate, rejectPlace } from '../actions'

/**
 * /places/[id] — decide whether an imported place becomes something we sell.
 *
 * THE FORM HERE IS THE ACTIVITY FORM, unchanged, because approving is not a
 * lighter act than authoring: it produces the same catalogue row through the
 * same `createActivity`. Anything less would be a second way into `activities`
 * with weaker validation, which is how a catalogue ends up holding rows nobody
 * can explain.
 *
 * WHAT GOOGLE GAVE US IS SHOWN BESIDE IT AND NEVER PRE-FILLED INTO THE PROSE.
 * The name, address and rating are reference material for a person deciding; the
 * summary and description are ours to write. Copying Google's text into our
 * fields would put their content in our catalogue — a licensing question and a
 * quality one, since their one-liner is written for a map pin rather than for
 * somebody choosing how to spend a Tuesday.
 *
 * THREE THINGS ARE PRE-FILLED, all of them ours: a slug, a category guess and
 * the destination. Each is a starting point the curator can overwrite, and none
 * is a claim about the venue.
 */

export const metadata = { title: 'Review place · Beyond Borders' }

/** Google's type strings, minus the two that sit on nearly everything. */
const NOISE_TYPES = new Set(['point_of_interest', 'establishment'])

export default async function ReviewPlacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // The WRITE roles, like `activities/new`: there is nothing here the queue does
  // not already show, so a reader who reached this URL is lost or trying it on.
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  if (admin === null) return <Locked />

  const [{ id }, query] = await Promise.all([params, searchParams])
  const rawError = query.error
  const error = typeof rawError === 'string' && rawError !== '' ? rawError : undefined

  const candidate = await readCandidate(id).catch(() => null)
  if (candidate === null) notFound()

  const [destinations, tags] = await Promise.all([
    listDestinations({ includeInactive: true }),
    listTags(),
  ])

  const decided = candidate.status !== 'PENDING'
  const usefulTypes = candidate.googleTypes.filter((type) => !NOISE_TYPES.has(type))

  /*
   * A synthetic `ActivityDetail`, purely to seed the form's defaults.
   *
   * It is NOT an activity and is never written — `createActivity` builds the real
   * row from what gets posted. The `id` is empty deliberately: the shared form
   * renders a hidden `id` only when one is present, and an id here would make it
   * believe it was editing something and post an update instead.
   *
   * Everything descriptive is left blank rather than seeded from Google. The
   * empty summary and description ARE the screen: they are the fields a person
   * has to fill, and pre-filling them from a map blurb is how curation quietly
   * becomes a rubber stamp.
   */
  const seed: ActivityDetail = {
    id: '',
    slug: suggestSlug(candidate.destination.slug, candidate.name),
    destinationId: candidate.destinationId,
    destination: candidate.destination,
    name: candidate.name,
    summary: '',
    description: '',
    category: suggestCategory(candidate.googleTypes) as ActivityCategory,
    durationMinutes: 120,
    pricePerPersonBdt: null,
    priceNote: null,
    location:
      candidate.latitude === null || candidate.longitude === null
        ? null
        : { latitude: Number(candidate.latitude), longitude: Number(candidate.longitude) },
    bestTimeOfDay: TimeOfDay.ANY,
    minPartySize: null,
    maxPartySize: null,
    intensity: ActivityIntensity.MODERATE,
    bookingRequired: false,
    // A new row starts unpublished, exactly as `activities/new` does. Publishing
    // is the separate deliberate act, so an approval saved mid-proofread cannot
    // reach a traveller.
    isActive: false,
    sourceUrl: candidate.websiteUri ?? candidate.googleMapsUri,
    sortOrder: 0,
    tags: [],
    images: [],
    primaryImage: null,
    openingHours: [],
    createdAt: candidate.importedAt,
    updatedAt: candidate.importedAt,
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/places"
          className="text-sm text-zinc-600 underline underline-offset-4 hover:no-underline dark:text-zinc-400"
        >
          ← Place imports
        </Link>

        <h1 className="mt-3 text-xl font-semibold tracking-tight">{candidate.name}</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {candidate.destination.name}, {candidate.destination.country} · found by searching &ldquo;
          {candidate.searchQuery}&rdquo; · imported {formatDateTime(candidate.importedAt)}
        </p>
      </div>

      {/* ── What Google told us ──────────────────────────────────────────── */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold tracking-tight">What Google knows</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Reference only. None of this is copied into the catalogue — the fields below are ours to
          write, which is the whole reason this screen exists.
        </p>

        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
              Address
            </dt>
            <dd className="mt-1">{candidate.formattedAddress ?? '—'}</dd>
          </div>

          <div>
            <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
              Rating
            </dt>
            <dd className="mt-1 tabular-nums">
              {candidate.rating === null
                ? 'Not rated'
                : `${String(candidate.rating)}★ from ${candidate.userRatingCount ?? 0} reviews`}
            </dd>
          </div>

          <div>
            <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
              Google&rsquo;s categories
            </dt>
            <dd className="mt-1 text-xs">
              {usefulTypes.length > 0 ? usefulTypes.join(', ') : '—'}
            </dd>
          </div>

          <div>
            <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
              Price band
            </dt>
            {/* Google's band is not a price and cannot become one. It is shown so
                a curator can sanity-check the taka figure they type, and for no
                other reason. */}
            <dd className="mt-1 text-xs">
              {candidate.priceLevel === null
                ? '—'
                : `${candidate.priceLevel
                    .replace('PRICE_LEVEL_', '')
                    .toLowerCase()
                    .replace('_', ' ')} — a band, not a price`}
            </dd>
          </div>

          {candidate.openingHoursText !== null && (
            <div className="sm:col-span-2">
              <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                Hours as Google has them
              </dt>
              <dd className="mt-1 text-xs whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
                {candidate.openingHoursText}
              </dd>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Retype these into the opening-hours box below if they are right. They are not copied
                across automatically — Google&rsquo;s hours go stale, and the catalogue is what
                somebody will be standing outside at 9am trusting.
              </p>
            </div>
          )}

          <div className="sm:col-span-2">
            <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
              Links
            </dt>
            <dd className="mt-1 flex flex-wrap gap-3 text-xs">
              {candidate.websiteUri !== null && (
                <a
                  href={candidate.websiteUri}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-4"
                >
                  Their website
                </a>
              )}
              {candidate.googleMapsUri !== null && (
                <a
                  href={candidate.googleMapsUri}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-4"
                >
                  On Google Maps
                </a>
              )}
              {candidate.websiteUri === null && candidate.googleMapsUri === null && <span>—</span>}
            </dd>
          </div>
        </dl>
      </section>

      {decided ? (
        <section className="rounded-lg border border-dashed border-zinc-300 p-6 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          This place was already {candidate.status === 'APPROVED' ? 'approved' : 'turned down'}
          {candidate.reviewedAt !== null && ` on ${formatDateTime(candidate.reviewedAt)}`}
          {candidate.reviewedBy !== null &&
            ` by ${candidate.reviewedBy.name ?? candidate.reviewedBy.email}`}
          .
          {candidate.rejectedReason !== null && (
            <span className="mt-2 block italic">{candidate.rejectedReason}</span>
          )}
          {candidate.activity !== null && (
            <Link
              href={`/activities/${candidate.activity.id}`}
              className="mt-2 block underline underline-offset-4"
            >
              Open {candidate.activity.name} in the catalogue
            </Link>
          )}
        </section>
      ) : (
        <>
          <section>
            <h2 className="text-sm font-semibold tracking-tight">Write it up</h2>
            <p className="mt-1 max-w-prose text-xs text-zinc-500 dark:text-zinc-400">
              The same form as authoring an activity by hand, because that is what approving does.
              Duration, price and the two descriptions are exactly what Google cannot tell us and
              what the planner cannot work without.
            </p>

            <div className="mt-4">
              <ActivityForm
                activity={seed}
                destinations={destinations}
                tags={tags}
                error={error}
                action={approveCandidate}
                submitLabel="Approve and add to catalogue"
                hiddenFields={<input type="hidden" name="candidateId" value={candidate.id} />}
              />
            </div>
          </section>

          {/* ── Or turn it down ───────────────────────────────────────────── */}
          <section className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold tracking-tight">Or turn it down</h2>
            <p className="mt-1 max-w-prose text-xs text-zinc-500 dark:text-zinc-400">
              A reason is required and is kept. The next person to run this search will not see the
              place queued again, so that reason is the only explanation they will get.
            </p>

            {/* A SEPARATE FORM, not another button inside the one above. A second
                submit there would post the whole activity draft, so "turn down"
                would run the approval validation and fail on empty fields nobody
                was asked to fill. */}
            <form action={rejectPlace} className="mt-4 flex flex-col gap-3">
              <input type="hidden" name="candidateId" value={candidate.id} />

              <label className="block">
                <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Why not
                </span>
                <input
                  name="reason"
                  required
                  maxLength={500}
                  placeholder="Permanently closed · not something we can book · duplicate of an existing activity"
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

              <button
                type="submit"
                className="self-start rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
              >
                Turn down
              </button>
            </form>
          </section>
        </>
      )}
    </div>
  )
}
