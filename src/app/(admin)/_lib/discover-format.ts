import { PackagePricingMode } from '@/generated/prisma/enums'

/**
 * Rendering helpers shared by the Discover console screens.
 *
 * Each encodes a rule that would be wrong if it were written twice. A package
 * with no price is not free. A departure date is a calendar date, not a
 * timestamp in somebody's timezone. An itinerary time is minutes from local
 * midnight, which only becomes a clock time once something formats it.
 *
 * Kept apart from `format.ts` because that file's rules are genuinely different:
 * money there is whole taka in one currency, and times there are Asia/Dhaka
 * wall-clock. Both are correct for payments and wrong here.
 */

const TAKA = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })

/**
 * A package's price, in the shape its pricing mode actually means.
 *
 * INTEREST_ONLY has no price by database constraint, so it says so rather than
 * printing a zero or an em dash that reads as missing data. A range prints as a
 * range; a single figure prints as "from", because every price here is per
 * person and a departure may override it.
 */
export function formatPackagePrice(
  pricingMode: PackagePricingMode,
  from: number | null,
  to: number | null
): string {
  if (pricingMode === PackagePricingMode.INTEREST_ONLY || from === null) return 'Not priced yet'
  if (to !== null && to !== from) return `৳ ${TAKA.format(from)} – ${TAKA.format(to)}`
  return `from ৳ ${TAKA.format(from)}`
}

/**
 * A `@db.Date` as the calendar date it is.
 *
 * Postgres hands these back at UTC midnight. Formatting one in Asia/Dhaka
 * happens to render 17 October as 17 October, but the same value formatted
 * anywhere west of UTC renders as the 16th — so reading the UTC fields is the
 * only version that cannot be wrong for somebody.
 */
const DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

export function formatTripDate(value: Date): string {
  return DAY.format(value)
}

export function formatDateRange(start: Date, end: Date): string {
  return `${formatTripDate(start)} – ${formatTripDate(end)}`
}

/**
 * Minutes from local midnight as a clock time.
 *
 * Null means the itinerary is deliberately vague — "afternoon at leisure" has
 * no start time — so it renders as nothing rather than as 00:00, which would be
 * a specific and wrong claim about midnight.
 */
export function formatMinuteOfDay(minute: number | null): string {
  if (minute === null) return ''
  const hours = Math.floor(minute / 60) % 24
  const minutes = minute % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** A duration in the units a person would say it in. */
export function formatDuration(minutes: number | null): string {
  if (minutes === null) return ''
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** "8–14 travellers", or an em dash on a trip with no band. */
export function formatGroupSize(min: number | null, max: number | null): string {
  if (min === null && max === null) return '—'
  if (min !== null && max !== null) return `${min}–${max} travellers`
  if (min !== null) return `${min}+ travellers`
  return `up to ${max} travellers`
}
