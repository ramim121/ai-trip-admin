import { z } from 'zod'
import { ActivityCategory, ActivityIntensity, TimeOfDay } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit/log'
import { conflict, notFound } from '@/server/http/errors'
import { MAX_BLOCK_END_MINUTE, MINUTES_IN_DAY, type OpeningWindow } from './service'

/**
 * The catalog's write side, for the admin console.
 *
 * Kept apart from `service.ts` for a reason that matters more than tidiness:
 * nothing the AI layer can reach imports this file. The planner's tools import
 * `service.ts`, which contains no mutation at all, so a prompt injection that
 * talks a model into "correcting the price" has no function to call. Separation
 * by module is a weaker boundary than a separate process, but it is the one this
 * codebase can enforce, and it holds as long as `tools.ts` never imports here.
 *
 * Everything a form submits arrives as text, and three of the fields deserve
 * more than a cast:
 *
 *   Opening hours are typed as `Mon-Fri 09:00-17:00`, one window per line, and
 *     parsed here. A grid of 21 numeric inputs would be quicker to build and
 *     miserable to use; a JSON textarea asks a content editor to debug commas.
 *     The parser is pure, and tested.
 *
 *   Images are `url | alt text`, and the alt is REQUIRED — the column is not
 *     nullable precisely so it cannot be skipped, and a line without one is
 *     refused rather than stored as an empty string to satisfy the constraint.
 *
 *   Money is whole taka, and a price typed with a decimal point is REJECTED
 *     rather than rounded. "1800.50" means the editor believes we take poisha;
 *     silently storing 1800 or 1801 would hide the fact that they were wrong.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Time parsing
// ─────────────────────────────────────────────────────────────────────────────

/** Longest alias first, so `su` never wins where `sunday` was written. */
const DAY_NAMES: readonly (readonly string[])[] = [
  ['sunday', 'sun', 'su'],
  ['monday', 'mon', 'mo'],
  ['tuesday', 'tues', 'tue', 'tu'],
  ['wednesday', 'weds', 'wed', 'we'],
  ['thursday', 'thurs', 'thur', 'thu', 'th'],
  ['friday', 'fri', 'fr'],
  ['saturday', 'sat', 'sa'],
]

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const EVERY_DAY_WORDS = new Set(['daily', 'everyday', 'every-day', 'all', 'anyday'])

/** `mon` → 1. Null when the token names no weekday. */
export function parseDayToken(token: string): number | null {
  const cleaned = token.trim().toLowerCase().replace(/\./g, '')
  if (cleaned === '') return null

  if (/^[0-6]$/.test(cleaned)) return Number(cleaned)

  for (const [index, aliases] of DAY_NAMES.entries()) {
    if (aliases.includes(cleaned)) return index
  }

  return null
}

/** `09:30` → 570. `26:00` → 1560, which is 02:00 the next morning. */
export function parseClockTime(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim())
  if (match === null) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])

  // 47 rather than 23, because a closing time is allowed to run into the next
  // day. The window bounds are checked separately, against the block ceiling.
  if (hours > 47) return null

  return hours * 60 + minutes
}

/** 1560 → `26:00`. The inverse of `parseClockTime`, for rendering a form. */
export function formatClockTime(minute: number): string {
  const hours = Math.floor(minute / 60)
  const minutes = minute % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening hours as text
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedOpeningHours {
  windows: OpeningWindow[]
  /** One human-readable complaint per bad line, quoting the line number. */
  errors: string[]
}

/** Hard cap, so pasting a thousand lines cannot become a thousand inserts. */
export const MAX_OPENING_WINDOWS = 60

/**
 * Expand a day specification: `mon`, `mon,wed`, `mon-fri`, `daily`.
 *
 * A range wraps, so `fri-mon` is Friday, Saturday, Sunday, Monday. Venues that
 * open across a weekend describe themselves that way, and refusing the wrap
 * would make them enter two lines for one idea.
 */
function parseDaySpec(spec: string): number[] | null {
  const days = new Set<number>()

  for (const part of spec.split(',')) {
    const token = part.trim().toLowerCase().replace(/\s+/g, '-')
    if (token === '') continue

    if (EVERY_DAY_WORDS.has(token)) {
      for (let day = 0; day <= 6; day += 1) days.add(day)
      continue
    }

    const range = /^(.+?)-(.+)$/.exec(token)
    if (range !== null) {
      const from = parseDayToken(range[1])
      const to = parseDayToken(range[2])
      if (from === null || to === null) return null

      // Walks forward and wraps, which is what makes `fri-mon` four days rather
      // than an error or an empty set.
      for (let step = 0; step <= (to - from + 7) % 7; step += 1) {
        days.add((from + step) % 7)
      }
      continue
    }

    const day = parseDayToken(token)
    if (day === null) return null
    days.add(day)
  }

  return days.size === 0 ? null : [...days].sort((a, b) => a - b)
}

export const OPENING_HOURS_PLACEHOLDER = 'Mon-Fri 09:00-17:00\nSat 10:00-14:00'

/**
 * Parse the opening-hours textarea.
 *
 * Blank lines and `#` comments are skipped, so an editor can annotate a seasonal
 * schedule without the parser objecting. Every other line has to be a day
 * specification followed by a time range.
 *
 * Errors accumulate rather than short-circuit: an editor who mistyped three
 * lines should be told about all three, not made to submit three times.
 *
 * Leaving the box EMPTY is meaningful and legitimate — it records an activity as
 * always available, which is how a beach or a viewpoint is stored. It is not the
 * same as "hours unknown", and the form says so beside the field.
 */
export function parseOpeningHoursText(text: string): ParsedOpeningHours {
  const windows: OpeningWindow[] = []
  const errors: string[] = []

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const lineNumber = index + 1

    const match = /^(.+?)\s+(\d{1,2}:[0-5]\d)\s*(?:-|–|to)\s*(\d{1,2}:[0-5]\d)$/i.exec(line)
    if (match === null) {
      errors.push(
        `Line ${lineNumber}: expected something like "Mon-Fri 09:00-17:00", got "${line}".`
      )
      continue
    }

    const days = parseDaySpec(match[1])
    if (days === null) {
      errors.push(`Line ${lineNumber}: "${match[1].trim()}" is not a day or a range of days.`)
      continue
    }

    const opensMinute = parseClockTime(match[2])
    const closesMinute = parseClockTime(match[3])

    if (opensMinute === null || closesMinute === null) {
      errors.push(`Line ${lineNumber}: the times must be 24-hour, like 09:00 or 18:30.`)
      continue
    }

    if (opensMinute >= MINUTES_IN_DAY) {
      errors.push(
        `Line ${lineNumber}: an opening time must be before 24:00. Only the closing time may run ` +
          'past midnight.'
      )
      continue
    }

    if (closesMinute <= opensMinute) {
      errors.push(
        `Line ${lineNumber}: closing must be after opening. For a venue that runs past midnight, ` +
          'write the closing time as 24:00 or later — 02:00 the next morning is "26:00".'
      )
      continue
    }

    if (closesMinute > MAX_BLOCK_END_MINUTE) {
      errors.push(`Line ${lineNumber}: a window may not run past 48:00.`)
      continue
    }

    for (const dayOfWeek of days) windows.push({ dayOfWeek, opensMinute, closesMinute })
  }

  if (windows.length > MAX_OPENING_WINDOWS) {
    errors.push(
      `That is ${windows.length} windows once the day ranges are expanded; the limit is ` +
        `${MAX_OPENING_WINDOWS}.`
    )
  }

  return { windows, errors }
}

/** `[1,2,3,4,5]` → `Mon-Fri`; `[1,3]` → `Mon,Wed`; all seven → `Daily`. */
function formatDayGroup(days: readonly number[]): string {
  if (days.length === 7) return 'Daily'

  // Only a contiguous run collapses into a range. A wrapping run (Fri, Sat, Sun)
  // stays a list, because `Fri-Sun` reads as three days to some people and five
  // to others, and the parser accepting both spellings does not make the
  // rendering unambiguous.
  const contiguous = days.every((day, index) => index === 0 || day === days[index - 1] + 1)

  if (contiguous && days.length > 2) {
    return `${DAY_LABELS[days[0]]}-${DAY_LABELS[days[days.length - 1]]}`
  }

  return days.map((day) => DAY_LABELS[day]).join(',')
}

/**
 * Render stored windows back into textarea form.
 *
 * Days sharing a time range are grouped onto one line, so a schedule entered as
 * `Mon-Fri 09:00-17:00` comes back as `Mon-Fri 09:00-17:00` rather than five
 * separate lines. An editor who opens a record and saves it unchanged should not
 * find their input rewritten.
 */
export function formatOpeningHours(windows: readonly OpeningWindow[]): string {
  const byRange = new Map<string, number[]>()

  for (const window of windows) {
    const key = `${window.opensMinute}:${window.closesMinute}`
    const days = byRange.get(key)
    if (days) days.push(window.dayOfWeek)
    else byRange.set(key, [window.dayOfWeek])
  }

  const lines: string[] = []

  for (const [key, days] of byRange) {
    const [opens, closes] = key.split(':').map(Number)
    const sorted = [...new Set(days)].sort((a, b) => a - b)
    lines.push(`${formatDayGroup(sorted)} ${formatClockTime(opens)}-${formatClockTime(closes)}`)
  }

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Images as text
// ─────────────────────────────────────────────────────────────────────────────

export interface ImageInput {
  url: string
  alt: string
  sortOrder: number
}

export const MAX_IMAGES = 20

export const IMAGES_PLACEHOLDER =
  'https://cdn.example.com/himchari-waterfall.jpg | The waterfall at Himchari after the monsoon'

/**
 * Parse the images textarea: one `url | alt text` per line.
 *
 * A line with no alt text is an ERROR, not an image with an empty alt. The
 * column is required in the schema for exactly this reason — an image nobody
 * described is invisible to a screen reader, and a field that is optional
 * anywhere guarantees somebody ships one.
 *
 * Order is the order of the lines, and the first is the card image everywhere.
 */
export function parseImagesText(text: string): { images: ImageInput[]; errors: string[] } {
  const images: ImageInput[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const lineNumber = index + 1
    const separator = line.indexOf('|')

    if (separator === -1) {
      errors.push(
        `Line ${lineNumber}: write the URL, then a "|", then alt text describing the photograph.`
      )
      continue
    }

    const url = line.slice(0, separator).trim()
    const alt = line.slice(separator + 1).trim()

    if (url === '') {
      errors.push(`Line ${lineNumber}: the URL is missing.`)
      continue
    }

    if (!/^https?:\/\/\S+$/i.test(url) && !url.startsWith('/')) {
      errors.push(`Line ${lineNumber}: "${url}" is not an http(s) URL or a path starting with "/".`)
      continue
    }

    if (alt === '') {
      errors.push(
        `Line ${lineNumber}: alt text is required. Describe what is in the photograph for someone ` +
          'who cannot see it.'
      )
      continue
    }

    if (seen.has(url)) {
      errors.push(`Line ${lineNumber}: this URL is already listed above.`)
      continue
    }

    seen.add(url)
    images.push({ url, alt, sortOrder: images.length })
  }

  if (images.length > MAX_IMAGES) {
    errors.push(`At most ${MAX_IMAGES} images. That is ${images.length}.`)
  }

  return { images, errors }
}

export function formatImages(images: readonly { url: string; alt: string }[]): string {
  return images.map((image) => `${image.url} | ${image.alt}`).join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// The activity form
// ─────────────────────────────────────────────────────────────────────────────

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `Himchari National Park & Waterfall` → `himchari-national-park-waterfall`. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

/** An empty string from a form means "not set", never the empty string. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))

/**
 * Whole taka, and no decimal point.
 *
 * `z.coerce.number()` would accept "1800.50" and hand us 1800.5, which then
 * truncates silently into an Int column. Money is validated as the digits it has
 * to be, so an editor who types a decimal is told the currency has no minor unit
 * rather than discovering later that fifty poisha went missing.
 */
const bdtAmount = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (value === '') return
    if (!/^\d{1,9}$/.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Prices are whole taka: digits only, with no decimal point, no comma and no currency ' +
          'symbol. Leave it blank for a free activity, or one quoted on request.',
      })
    }
  })
  .transform((value) => (value === '' ? null : Number(value)))

const optionalInteger = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      if (value === '') return
      if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) {
        ctx.addIssue({
          code: 'custom',
          message: `${label} must be a whole number from ${min} to ${max}.`,
        })
      }
    })
    .transform((value) => (value === '' ? null : Number(value)))

/**
 * A coordinate, kept as a STRING all the way to Postgres.
 *
 * `Decimal(9,6)` holds the value exactly. Parsing to a float first and handing
 * Prisma the result would round-trip through binary floating point for no reason
 * at all, so the string is validated and never converted.
 */
const coordinate = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      if (value === '') return
      if (!/^-?\d{1,3}(?:\.\d{1,6})?$/.test(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `${label} must be decimal degrees with at most 6 decimal places, e.g. 21.427200.`,
        })
        return
      }
      const parsed = Number(value)
      if (parsed < min || parsed > max) {
        ctx.addIssue({ code: 'custom', message: `${label} must be between ${min} and ${max}.` })
      }
    })
    .transform((value) => (value === '' ? null : value))

/** An unchecked box is absent from the FormData entirely; a checked one is `"on"`. */
const checkbox = z
  .string()
  .optional()
  .transform((value) => value === 'on' || value === 'true')

/**
 * What the console submits.
 *
 * Declared over the raw strings a `FormData` actually contains, so this schema is
 * the only place that has to know a checkbox arrives as the literal `"on"` and an
 * untouched number field arrives as `""`.
 */
export const ActivityFormSchema = z
  .object({
    destinationId: z.uuid('Choose a destination.'),
    slug: z
      .string()
      .trim()
      .min(3, 'The slug must be at least 3 characters.')
      .max(120)
      .regex(SLUG_PATTERN, 'Lowercase letters, digits and single hyphens only.'),
    name: z.string().trim().min(1, 'A name is required.').max(200),
    summary: z
      .string()
      .trim()
      .min(1, 'A one-line summary is required — it is what a shortlist shows.')
      .max(400),
    description: z.string().trim().min(1, 'A description is required.').max(8000),
    category: z.enum(ActivityCategory),
    durationMinutes: z
      .string()
      .trim()
      .regex(/^\d{1,4}$/, 'Duration must be a whole number of minutes.')
      .transform(Number)
      .pipe(
        z
          .int()
          .min(15, 'Anything under 15 minutes is not a block worth scheduling.')
          .max(MINUTES_IN_DAY, 'A single activity cannot be longer than a day.')
      ),
    pricePerPersonBdt: bdtAmount,
    priceNote: optionalText(300),
    latitude: coordinate(-90, 90, 'Latitude'),
    longitude: coordinate(-180, 180, 'Longitude'),
    bestTimeOfDay: z.enum(TimeOfDay),
    minPartySize: optionalInteger(1, 1000, 'Minimum party size'),
    maxPartySize: optionalInteger(1, 1000, 'Maximum party size'),
    intensity: z.enum(ActivityIntensity),
    bookingRequired: checkbox,
    isActive: checkbox,
    sourceUrl: optionalText(500),
    sortOrder: z
      .string()
      .trim()
      .transform((value) => (value === '' ? '0' : value))
      .refine((value) => /^\d{1,5}$/.test(value), 'Sort order must be a whole number.')
      .transform(Number),
    tagSlugs: z.array(z.string().trim().min(1)).max(20),
    images: z
      .array(z.object({ url: z.string(), alt: z.string(), sortOrder: z.int() }))
      .max(MAX_IMAGES),
    openingHours: z
      .array(
        z.object({
          dayOfWeek: z.int().min(0).max(6),
          opensMinute: z
            .int()
            .min(0)
            .max(MINUTES_IN_DAY - 1),
          closesMinute: z.int().min(1).max(MAX_BLOCK_END_MINUTE),
        })
      )
      .max(MAX_OPENING_WINDOWS),
  })
  .superRefine((value, ctx) => {
    if (
      value.minPartySize !== null &&
      value.maxPartySize !== null &&
      value.maxPartySize < value.minPartySize
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxPartySize'],
        message: 'The maximum party size cannot be below the minimum.',
      })
    }

    // Half a position is worse than none: it would place the activity on the
    // equator or the prime meridian, and every travel estimate around it would
    // be wrong while looking entirely plausible.
    if ((value.latitude === null) !== (value.longitude === null)) {
      ctx.addIssue({
        code: 'custom',
        path: [value.latitude === null ? 'latitude' : 'longitude'],
        message: 'Give both latitude and longitude, or neither.',
      })
    }
  })

export type ActivityFormValues = z.output<typeof ActivityFormSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Writes
//
// Children — tags, images, opening hours — are replaced wholesale inside the
// same transaction that writes the parent, exactly as the seed does. A merge
// would leave a deleted opening window behind, and the planner would go on
// scheduling against hours the venue no longer keeps.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminContext {
  adminUserId: string
  ip?: string | null
  userAgent?: string | null
}

/** Resolve tag slugs to ids, refusing any that does not exist. */
async function resolveTagIds(slugs: readonly string[]): Promise<string[]> {
  const unique = [...new Set(slugs)]
  if (unique.length === 0) return []

  const rows = await db.tag.findMany({
    where: { slug: { in: unique } },
    select: { id: true, slug: true },
  })

  if (rows.length !== unique.length) {
    const found = new Set(rows.map((row) => row.slug))
    const missing = unique.filter((slug) => !found.has(slug))
    // Refused loudly rather than created on the fly: a typo that silently mints
    // a tag fragments the interest vocabulary the planner ranks against, and
    // nobody notices until a search quietly stops matching.
    throw notFound(`Unknown tag${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`)
  }

  return rows.map((row) => row.id)
}

function activityFields(values: ActivityFormValues) {
  return {
    destinationId: values.destinationId,
    name: values.name,
    summary: values.summary,
    description: values.description,
    category: values.category,
    durationMinutes: values.durationMinutes,
    pricePerPersonBdt: values.pricePerPersonBdt,
    priceNote: values.priceNote,
    latitude: values.latitude,
    longitude: values.longitude,
    bestTimeOfDay: values.bestTimeOfDay,
    minPartySize: values.minPartySize,
    maxPartySize: values.maxPartySize,
    intensity: values.intensity,
    bookingRequired: values.bookingRequired,
    isActive: values.isActive,
    sourceUrl: values.sourceUrl,
    sortOrder: values.sortOrder,
  }
}

/** The subset of a row worth putting in an audit entry. */
function auditSnapshot(values: ActivityFormValues) {
  return {
    slug: values.slug,
    name: values.name,
    destinationId: values.destinationId,
    category: values.category,
    durationMinutes: values.durationMinutes,
    pricePerPersonBdt: values.pricePerPersonBdt,
    isActive: values.isActive,
    tagCount: values.tagSlugs.length,
    imageCount: values.images.length,
    openingWindowCount: values.openingHours.length,
  }
}

export async function createActivity(
  values: ActivityFormValues,
  context: AdminContext
): Promise<string> {
  const tagIds = await resolveTagIds(values.tagSlugs)

  const existing = await db.activity.findUnique({
    where: { slug: values.slug },
    select: { id: true },
  })
  if (existing) throw conflict(`An activity with the slug "${values.slug}" already exists.`)

  const id = await db.$transaction(async (tx) => {
    const created = await tx.activity.create({
      data: { slug: values.slug, ...activityFields(values) },
      select: { id: true },
    })

    if (tagIds.length > 0) {
      await tx.activityTag.createMany({
        data: tagIds.map((tagId) => ({ activityId: created.id, tagId })),
      })
    }

    if (values.images.length > 0) {
      await tx.activityImage.createMany({
        data: values.images.map((image) => ({ activityId: created.id, ...image })),
      })
    }

    if (values.openingHours.length > 0) {
      await tx.activityOpeningHours.createMany({
        data: values.openingHours.map((window) => ({ activityId: created.id, ...window })),
      })
    }

    return created.id
  })

  await recordAudit({
    action: 'activity.created',
    entityType: 'activity',
    entityId: id,
    adminUserId: context.adminUserId,
    after: auditSnapshot(values),
    ip: context.ip,
    userAgent: context.userAgent,
  })

  return id
}

export async function updateActivity(
  id: string,
  values: ActivityFormValues,
  context: AdminContext
): Promise<void> {
  const tagIds = await resolveTagIds(values.tagSlugs)

  const before = await db.activity.findUnique({
    where: { id },
    select: {
      slug: true,
      name: true,
      destinationId: true,
      category: true,
      durationMinutes: true,
      pricePerPersonBdt: true,
      isActive: true,
    },
  })

  if (before === null) throw notFound('No such activity.')

  const clash = await db.activity.findUnique({ where: { slug: values.slug }, select: { id: true } })
  if (clash && clash.id !== id) {
    throw conflict(`Another activity already uses the slug "${values.slug}".`)
  }

  await db.$transaction(async (tx) => {
    await tx.activity.update({
      where: { id },
      data: { slug: values.slug, ...activityFields(values) },
      select: { id: true },
    })

    await tx.activityTag.deleteMany({ where: { activityId: id } })
    if (tagIds.length > 0) {
      await tx.activityTag.createMany({ data: tagIds.map((tagId) => ({ activityId: id, tagId })) })
    }

    await tx.activityImage.deleteMany({ where: { activityId: id } })
    if (values.images.length > 0) {
      await tx.activityImage.createMany({
        data: values.images.map((image) => ({ activityId: id, ...image })),
      })
    }

    await tx.activityOpeningHours.deleteMany({ where: { activityId: id } })
    if (values.openingHours.length > 0) {
      await tx.activityOpeningHours.createMany({
        data: values.openingHours.map((window) => ({ activityId: id, ...window })),
      })
    }
  })

  await recordAudit({
    action: 'activity.updated',
    entityType: 'activity',
    entityId: id,
    adminUserId: context.adminUserId,
    before,
    after: auditSnapshot(values),
    ip: context.ip,
    userAgent: context.userAgent,
  })
}

/**
 * Publish or retire one activity.
 *
 * Its own function rather than just a field on the edit form, because it is its
 * own decision: unpublishing withdraws inventory from every search and every
 * future plan, and that deserves one deliberate click with its own audit line
 * rather than a checkbox somebody toggles while fixing a typo.
 *
 * Existing itineraries keep their blocks. This is not a delete, and the block's
 * FK is `SetNull` even for one — a booked plan does not lose a day because ops
 * retired a museum.
 */
export async function setActivityPublished(
  id: string,
  isActive: boolean,
  context: AdminContext
): Promise<void> {
  const before = await db.activity.findUnique({
    where: { id },
    select: { isActive: true, name: true, slug: true },
  })

  if (before === null) throw notFound('No such activity.')
  // Idempotent: a double-submitted form should not write a second audit line
  // claiming a change that did not happen.
  if (before.isActive === isActive) return

  await db.activity.update({ where: { id }, data: { isActive }, select: { id: true } })

  await recordAudit({
    action: isActive ? 'activity.published' : 'activity.unpublished',
    entityType: 'activity',
    entityId: id,
    adminUserId: context.adminUserId,
    before: { isActive: before.isActive },
    after: { isActive, slug: before.slug, name: before.name },
    ip: context.ip,
    userAgent: context.userAgent,
  })
}
