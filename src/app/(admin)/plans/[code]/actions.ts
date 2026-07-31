'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { PlanCode } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit/log'
import { clearSettingCache } from '@/server/settings/read'
import { COMMERCE_WRITE_ROLES, readConsoleAdminWithRole } from '../../_lib/console-session'

/**
 * Editing a plan.
 *
 * A server action is an HTTP endpoint with a generated URL, not a function
 * call — anyone who can reach the console can post to it, whether or not the
 * form that binds it ever rendered for them. So the role check here is not a
 * duplicate of the page's: the page's controls what is *displayed*, and this
 * one is the only thing controlling what is *written*. Removing either leaves a
 * hole.
 *
 * `code` arrives in the form body and is re-validated against the enum like
 * everything else from a client. It selects which row to write; it is never
 * itself writable. Neither is `interval` — moving a plan between one-off and
 * monthly changes what every existing Subscription row means, and that is a
 * migration, not a text field.
 */

/**
 * A limit field.
 *
 * The empty string means UNLIMITED and is stored as null. That mapping is the
 * whole reason this is a transform rather than `z.coerce.number()`: an empty
 * input coerces to 0, and 0 is the single value that must never be confused
 * with "no limit" — it would silently forbid everything on the tier somebody
 * had just marked unlimited.
 */
const LimitField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isInteger(value) && value >= 0), {
    message: 'Limits must be a whole number of zero or more, or blank for unlimited.',
  })

/**
 * Whole taka. `z.coerce.number()` would take "990.50" and let Postgres round it
 * into the Int column without complaint, so the integer check is explicit.
 */
const PriceField = z
  .string()
  .trim()
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 0, {
    message: 'Price must be a whole number of taka, zero or more.',
  })

const PlanEditForm = z.object({
  code: z.enum(PlanCode),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  priceBdt: PriceField,
  maxItineraryDays: LimitField,
  maxSavedItineraries: LimitField,
  itinerariesPerPeriod: LimitField,
  sortOrder: z
    .string()
    .trim()
    .transform((value) => Number(value))
    .refine((value) => Number.isInteger(value), { message: 'Sort order must be a whole number.' }),
  // An unchecked checkbox sends nothing at all, so this is optional rather than
  // a boolean: the absent case *is* the false case.
  isActive: z.literal('on').optional(),
})

/** The columns whose changes are worth recording. */
const AUDITED_SELECT = {
  name: true,
  description: true,
  priceBdt: true,
  maxItineraryDays: true,
  maxSavedItineraries: true,
  itinerariesPerPeriod: true,
  isActive: true,
  sortOrder: true,
} as const

export async function updatePlan(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(COMMERCE_WRITE_ROLES)
  // Silently doing nothing would look like a successful save. Throwing lands on
  // the error boundary, which is the honest outcome for a post that no holder
  // of this session should have been able to make.
  if (admin === null) throw new Error('Not permitted.')

  const parsed = PlanEditForm.safeParse(Object.fromEntries(formData))

  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const rawCode = formData.get('code')
    const target = typeof rawCode === 'string' ? encodeURIComponent(rawCode) : ''
    redirect(`/plans/${target}?error=${encodeURIComponent(first?.message ?? 'Invalid input.')}`)
  }

  const { code, isActive, ...fields } = parsed.data

  const before = await db.plan.findUnique({ where: { code }, select: AUDITED_SELECT })
  if (before === null) redirect('/plans?error=No+such+plan.')

  const after = await db.plan.update({
    where: { code },
    data: { ...fields, isActive: isActive === 'on' },
    select: AUDITED_SELECT,
  })

  // Money changes hands on the strength of these numbers, so who moved them and
  // when is not optional. `entityId` is the code rather than the uuid, because
  // the code is what an incident report will be written in.
  await recordAudit({
    action: 'plan.updated',
    entityType: 'plan',
    entityId: code,
    adminUserId: admin.adminUserId,
    before,
    after,
  })

  // The unlock price is mirrored in a settings row that entitlement decisions
  // read through a 30-second cache. Dropping it here makes a repricing take
  // effect on the next request rather than half a minute later, which matters
  // when the number is being quoted to somebody mid-checkout.
  clearSettingCache()

  revalidatePath('/plans')
  revalidatePath(`/plans/${code}`)
  redirect('/plans')
}
