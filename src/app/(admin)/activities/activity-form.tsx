import Link from 'next/link'
import type { ReactNode } from 'react'
import { ActivityCategory, ActivityIntensity, TimeOfDay } from '@/generated/prisma/enums'
import {
  IMAGES_PLACEHOLDER,
  OPENING_HOURS_PLACEHOLDER,
  formatImages,
  formatOpeningHours,
} from '@/server/modules/catalog/admin'
import type {
  ActivityDetail,
  DestinationSummary,
  TagSummary,
} from '@/server/modules/catalog/service'
import { saveActivity } from './actions'

/**
 * The create/edit form, shared by both screens.
 *
 * Server-rendered, no client JavaScript. A plain `<form action={saveActivity}>`
 * posts, the action validates, and a failure comes back as `?error=` on the same
 * page — the pattern the plans editor already uses, and one that keeps working
 * when a bundle does not load.
 *
 * Two fields are textareas rather than widgets, and both are a deliberate trade:
 *
 *   Opening hours as `Mon-Fri 09:00-17:00`, one line per window. A grid of
 *     twenty-one inputs would be quicker to build and miserable to fill in, and
 *     a JSON box asks a content editor to debug commas. The parser accepts the
 *     spellings people actually type and reports failures by line number.
 *
 *   Images as `url | alt text`, one per line, with the alt REQUIRED. The column
 *     is non-nullable precisely so nobody can skip it; an optional-looking input
 *     beside each URL is how it would get skipped anyway.
 *
 * Every value is echoed back through `defaultValue`, so a rejected save does not
 * cost the editor their typing.
 */

const FIELD =
  'w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 ' +
  'placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none ' +
  'dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100'

const LABEL = 'block text-sm font-medium text-zinc-700 dark:text-zinc-300'

const HINT = 'mt-1 text-xs text-zinc-500 dark:text-zinc-400'

const SECTION =
  'rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900'

const CHECKBOX = 'size-4 rounded border-zinc-300 dark:border-zinc-700'

/** Enum values read better in a dropdown as `water sports` than `WATER_SPORTS`. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase()
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint ? <span className={`${HINT} block`}>{hint}</span> : null}
    </label>
  )
}

export function ActivityForm({
  activity,
  destinations,
  tags,
  error,
}: {
  /** Null when creating. */
  activity: ActivityDetail | null
  destinations: DestinationSummary[]
  tags: TagSummary[]
  error?: string
}) {
  const selectedTags = new Set(activity?.tags.map((tag) => tag.slug) ?? [])

  return (
    <form action={saveActivity} className="flex flex-col gap-6">
      {activity ? <input type="hidden" name="id" value={activity.id} /> : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      ) : null}

      <section className={SECTION}>
        <h2 className="text-sm font-semibold tracking-tight">What and where</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Destination">
            <select
              name="destinationId"
              required
              defaultValue={activity?.destinationId ?? ''}
              className={FIELD}
            >
              <option value="" disabled>
                Choose a destination
              </option>
              {destinations.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.name}
                  {destination.isActive ? '' : ' (retired)'}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Slug" hint="Lowercase and hyphenated. Permanent once anything links to it.">
            <input
              type="text"
              name="slug"
              required
              maxLength={120}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              defaultValue={activity?.slug ?? ''}
              placeholder="coxs-bazar-himchari-national-park"
              className={FIELD}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Name">
              <input
                type="text"
                name="name"
                required
                maxLength={200}
                defaultValue={activity?.name ?? ''}
                className={FIELD}
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="Summary"
              hint="One line. This is what the planner puts in front of a traveller on a shortlist."
            >
              <input
                type="text"
                name="summary"
                required
                maxLength={400}
                defaultValue={activity?.summary ?? ''}
                className={FIELD}
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="Description"
              hint="Full prose for the detail page. Be specific and honest — the model works from this rather than inventing around it."
            >
              <textarea
                name="description"
                required
                rows={8}
                maxLength={8000}
                defaultValue={activity?.description ?? ''}
                className={FIELD}
              />
            </Field>
          </div>
        </div>
      </section>

      <section className={SECTION}>
        <h2 className="text-sm font-semibold tracking-tight">Shape of the outing</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Category">
            <select
              name="category"
              defaultValue={activity?.category ?? ActivityCategory.SIGHTSEEING}
              className={FIELD}
            >
              {Object.values(ActivityCategory).map((value) => (
                <option key={value} value={value}>
                  {humanise(value)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Best time of day" hint="ANY suits every slot and is never filtered out.">
            <select
              name="bestTimeOfDay"
              defaultValue={activity?.bestTimeOfDay ?? TimeOfDay.ANY}
              className={FIELD}
            >
              {Object.values(TimeOfDay).map((value) => (
                <option key={value} value={value}>
                  {humanise(value)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Intensity">
            <select
              name="intensity"
              defaultValue={activity?.intensity ?? ActivityIntensity.MODERATE}
              className={FIELD}
            >
              {Object.values(ActivityIntensity).map((value) => (
                <option key={value} value={value}>
                  {humanise(value)}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Duration (minutes)"
            hint="Time on site only. The planner adds transit blocks for getting there and back."
          >
            <input
              type="number"
              name="durationMinutes"
              required
              min={15}
              max={1440}
              step={5}
              defaultValue={activity?.durationMinutes ?? 120}
              className={FIELD}
            />
          </Field>

          <Field label="Minimum party size" hint="Blank means no lower bound.">
            <input
              type="number"
              name="minPartySize"
              min={1}
              max={1000}
              defaultValue={activity?.minPartySize ?? ''}
              className={FIELD}
            />
          </Field>

          <Field label="Maximum party size" hint="Blank means no upper bound.">
            <input
              type="number"
              name="maxPartySize"
              min={1}
              max={1000}
              defaultValue={activity?.maxPartySize ?? ''}
              className={FIELD}
            />
          </Field>
        </div>
      </section>

      <section className={SECTION}>
        <h2 className="text-sm font-semibold tracking-tight">Price</h2>
        <p className={HINT}>
          Whole taka per person — digits only, no decimal point and no comma. There is no minor unit
          in circulation, so a price with poisha in it is refused rather than rounded. Leave it
          blank for a free sight, or for anything ops quotes case by case, and say which in the note.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Price per person (BDT)">
            <input
              type="text"
              inputMode="numeric"
              name="pricePerPersonBdt"
              maxLength={9}
              defaultValue={activity?.pricePerPersonBdt ?? ''}
              placeholder="1800"
              className={FIELD}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Price note">
              <input
                type="text"
                name="priceNote"
                maxLength={300}
                defaultValue={activity?.priceNote ?? ''}
                placeholder="Park entry only; a shared jeep from Kolatoli is about BDT 600 return"
                className={FIELD}
              />
            </Field>
          </div>
        </div>
      </section>

      <section className={SECTION}>
        <h2 className="text-sm font-semibold tracking-tight">Interest tags</h2>
        <p className={HINT}>
          How a trip brief finds this activity. The planner ranks by how many of a traveller&apos;s
          stated interests these answer, so tag what the outing genuinely is — padding the list with
          near-misses puts it in front of people who did not ask for it.
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {tags.map((tag) => (
            <label key={tag.slug} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="tagSlugs"
                value={tag.slug}
                defaultChecked={selectedTags.has(tag.slug)}
                className={CHECKBOX}
              />
              <span className="text-zinc-700 dark:text-zinc-300">{tag.label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className={SECTION}>
        <h2 className="text-sm font-semibold tracking-tight">Opening hours</h2>
        <p className={HINT}>
          One window per line, as <code>Mon-Fri 09:00-17:00</code>. Ranges, comma lists and{' '}
          <code>Daily</code> all work. For a venue that runs past midnight, write the closing time as
          24:00 or later — 02:00 the next morning is <code>26:00</code>. A midday break is two lines.
        </p>
        <p className={HINT}>
          <strong>Leave this empty for somewhere always open</strong> — a beach, a viewpoint, a
          stretch of coast road. Empty means always available, not unknown. Once any line exists, a
          weekday with no line is treated as closed that day.
        </p>

        <div className="mt-4">
          <Field label="Windows">
            <textarea
              name="openingHoursText"
              rows={6}
              defaultValue={activity ? formatOpeningHours(activity.openingHours) : ''}
              placeholder={OPENING_HOURS_PLACEHOLDER}
              className={`${FIELD} font-mono`}
            />
          </Field>
        </div>
      </section>

      <section className={SECTION}>
        <h2 className="text-sm font-semibold tracking-tight">Images</h2>
        <p className={HINT}>
          One per line, as <code>url | alt text</code>. The first is the card image everywhere. Alt
          text is required and is not decoration: describe what is in the photograph for someone who
          cannot see it.
        </p>

        <div className="mt-4">
          <Field label="Images">
            <textarea
              name="imagesText"
              rows={5}
              defaultValue={activity ? formatImages(activity.images) : ''}
              placeholder={IMAGES_PLACEHOLDER}
              className={`${FIELD} font-mono`}
            />
          </Field>
        </div>
      </section>

      <section className={SECTION}>
        <h2 className="text-sm font-semibold tracking-tight">Position and provenance</h2>
        <p className={HINT}>
          Coordinates drive the planner&apos;s travel-time estimates. Give both or neither — half a
          position puts the activity on the equator and makes every estimate around it wrong while
          looking perfectly plausible.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Latitude" hint="Decimal degrees, e.g. 21.427200.">
            <input
              type="text"
              inputMode="decimal"
              name="latitude"
              defaultValue={activity?.location?.latitude ?? ''}
              placeholder="21.427200"
              className={FIELD}
            />
          </Field>

          <Field label="Longitude" hint="Decimal degrees, e.g. 92.005800.">
            <input
              type="text"
              inputMode="decimal"
              name="longitude"
              defaultValue={activity?.location?.longitude ?? ''}
              placeholder="92.005800"
              className={FIELD}
            />
          </Field>

          <Field
            label="Source URL"
            hint="Where price and hours were last verified, for the next content review."
          >
            <input
              type="url"
              name="sourceUrl"
              maxLength={500}
              defaultValue={activity?.sourceUrl ?? ''}
              className={FIELD}
            />
          </Field>

          <Field
            label="Sort order"
            hint="Lower comes first within its destination, and breaks ties in search ranking."
          >
            <input
              type="number"
              name="sortOrder"
              min={0}
              max={99999}
              defaultValue={activity?.sortOrder ?? 0}
              className={FIELD}
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="bookingRequired"
              defaultChecked={activity?.bookingRequired ?? false}
              className={CHECKBOX}
            />
            <span className="text-zinc-700 dark:text-zinc-300">Booking required in advance</span>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={activity?.isActive ?? false}
              className={CHECKBOX}
            />
            <span className="text-zinc-700 dark:text-zinc-300">
              Published — visible to travellers, and recommendable by the planner
            </span>
          </label>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {activity ? 'Save changes' : 'Create activity'}
        </button>
        <Link
          href="/activities"
          className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
