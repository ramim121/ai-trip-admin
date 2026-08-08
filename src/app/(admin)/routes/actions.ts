'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { recordAudit } from '@/server/audit/log'
import {
  createRoute,
  deleteRoute,
  PRICE_UNITS,
  setRouteActive,
  TRANSPORT_MODES,
  updateRoute,
} from '@/server/modules/journey/routes'
import { CATALOG_WRITE_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'

/**
 * Maintaining the routes we know the price of.
 *
 * WRITTEN BY CONTENT RATHER THAN OPS, which is why the role here is the
 * catalogue one. A route estimate is inventory knowledge — the same category as
 * an activity's price and its opening hours — and it is written long before
 * anybody is quoting a specific trip against it.
 *
 * As everywhere in this console, the role check inside each action is the only
 * thing controlling what is written; the page's check controls only what is
 * displayed. A server action is an HTTP endpoint with a generated URL, reachable
 * whether or not the form that binds it ever rendered.
 */

/** Whole taka. A fractional input is a mistake rather than a value to round. */
const TakaField = z
  .string()
  .trim()
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= 10_000_000, {
    message: 'Prices are a whole number of taka.',
  })

/** Whole minutes. A day is the ceiling; nothing here is a multi-day crossing. */
const MinutesField = z
  .string()
  .trim()
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 1 && value <= 1440, {
    message: 'A journey takes between one minute and a full day.',
  })

const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))

const RouteForm = z.object({
  fromLocation: z.string().trim().min(1, 'A route needs a start.').max(80),
  toLocation: z.string().trim().min(1, 'A route needs an end.').max(80),
  mode: z.enum(TRANSPORT_MODES),
  durationMinMinutes: MinutesField,
  durationMaxMinutes: MinutesField,
  priceMinBdt: TakaField,
  priceMaxBdt: TakaField,
  pricePer: z.enum(PRICE_UNITS),
  note: OptionalText(300),
  // An unchecked checkbox posts nothing at all, so absence is the false case
  // rather than a missing field to complain about.
  isActive: z.union([z.literal('on'), z.undefined()]).transform((value) => value === 'on'),
})

const EditForm = RouteForm.extend({ id: z.uuid() })
const IdForm = z.object({ id: z.uuid() })
/*
 * `desiredActive` RATHER THAN `isActive`, and the distinct name is the point.
 *
 * The row's edit form already carries an `isActive` checkbox, and the retire
 * button lives inside that same form because HTML forbids nesting one form in
 * another. Two fields of one name post two values, and `Object.fromEntries`
 * keeps whichever came last — so the toggle would have worked only by DOM order,
 * and silently inverted the day somebody moved the checkbox below the button.
 */
const ToggleForm = IdForm.extend({ desiredActive: z.enum(['true', 'false']) })

function backTo(message: string): never {
  redirect(`/routes?error=${encodeURIComponent(message)}`)
}

/** What a thrown service error says, without handing a stack to the page. */
function describe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return 'That did not work. Try again.'
}

function saved(message: string): never {
  revalidatePath('/routes')
  redirect(`/routes?done=${encodeURIComponent(message)}`)
}

export async function createRouteAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  // Silently doing nothing would look like a successful save. Throwing lands on
  // the error boundary, which is the honest outcome for a post no holder of this
  // session should have been able to make.
  if (admin === null) throw new Error('Not permitted.')

  const parsed = RouteForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(parsed.error.issues[0]?.message ?? 'Invalid input.')

  let id: string

  try {
    const route = await createRoute(parsed.data)
    id = route.id
  } catch (error) {
    backTo(describe(error))
  }

  await recordAudit({
    action: 'route.created',
    entityType: 'route_estimate',
    entityId: id,
    adminUserId: admin.adminUserId,
    after: {
      fromLocation: parsed.data.fromLocation,
      toLocation: parsed.data.toLocation,
      mode: parsed.data.mode,
    },
  })

  saved(`Added ${parsed.data.fromLocation} → ${parsed.data.toLocation} by ${parsed.data.mode}.`)
}

export async function updateRouteAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = EditForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(parsed.error.issues[0]?.message ?? 'Invalid input.')

  const { id, ...input } = parsed.data

  try {
    await updateRoute(id, input)
  } catch (error) {
    backTo(describe(error))
  }

  await recordAudit({
    action: 'route.updated',
    entityType: 'route_estimate',
    entityId: id,
    adminUserId: admin.adminUserId,
    after: { priceMinBdt: input.priceMinBdt, priceMaxBdt: input.priceMaxBdt },
  })

  saved(`Saved ${input.fromLocation} → ${input.toLocation}.`)
}

/**
 * Take a route out of circulation, or put it back.
 *
 * The DESIRED state is posted rather than derived from what the page happened to
 * read, so two clicks in quick succession land on the same answer instead of
 * racing each other back and forth.
 */
export async function toggleRouteAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = ToggleForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo('That route could not be identified.')

  const isActive = parsed.data.desiredActive === 'true'

  try {
    await setRouteActive(parsed.data.id, isActive)
  } catch (error) {
    backTo(describe(error))
  }

  await recordAudit({
    action: isActive ? 'route.reactivated' : 'route.retired',
    entityType: 'route_estimate',
    entityId: parsed.data.id,
    adminUserId: admin.adminUserId,
  })

  saved(
    isActive
      ? 'Back in use. New plans will be estimated against it.'
      : 'Retired. Plans already quoted keep the numbers they were given.'
  )
}

/**
 * Remove a row that should never have existed.
 *
 * Retiring is nearly always the right action — the service says why at length —
 * so this is for the row typed wrong rather than the route that stopped running.
 */
export async function deleteRouteAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = IdForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo('That route could not be identified.')

  try {
    await deleteRoute(parsed.data.id)
  } catch (error) {
    backTo(describe(error))
  }

  await recordAudit({
    action: 'route.deleted',
    entityType: 'route_estimate',
    entityId: parsed.data.id,
    adminUserId: admin.adminUserId,
  })

  saved('Deleted.')
}
