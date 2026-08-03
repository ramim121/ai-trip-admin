'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import type { Prisma } from '@/generated/prisma/client'
import { CouponType } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit/log'
import { PROMO_WRITE_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'

/**
 * Creating and editing promo codes.
 *
 * A server action is an HTTP endpoint with a generated URL, not a function call,
 * so the role check in each action below is the only thing controlling what is
 * written — the page's check controls only what is displayed.
 *
 * EVERY RULE HERE ALSO EXISTS AS A CHECK CONSTRAINT, which is deliberate rather
 * than redundant. The database is the authority: six constraints cover uppercase
 * codes, percent-versus-taka values, caps only on percentages, positive limits
 * and an ordered window. What these schemas add is a sentence instead of a
 * constraint violation. Where the two could disagree the database wins, which is
 * the right way round — a validation somebody forgets to write is not a rule,
 * and a constraint cannot be forgotten.
 *
 * NOTHING HERE DELETES A CODE. Deactivating is the only way to stop one, because
 * `coupon_redemptions` cascades on delete: removing a code would take its
 * redemption history with it, and that history is precisely what somebody needs
 * when a traveller says they were promised a discount. A dead code costs one row.
 */

/**
 * The code as typed, normalised the way the constraint demands.
 *
 * Uppercased and trimmed here rather than merely validated, because the lookup
 * at booking time is exact — "earlybird" failing to match "EARLYBIRD" is the
 * most predictable support ticket a coupon feature can generate, and the schema
 * says so in as many words.
 *
 * The character class is narrower than the constraint requires. The constraint
 * demands only uppercase and non-empty; this also refuses spaces and slashes,
 * because a code has to survive being read down a phone line and pasted into a
 * URL.
 */
const CodeField = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9][A-Z0-9-]*$/.test(value), {
    message: 'Use letters, numbers and hyphens only — no spaces.',
  })

/** Whole taka, or null when the field is left blank. */
const OptionalTaka = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isInteger(value) && value >= 0), {
    message: 'Must be a whole number of taka, zero or more.',
  })

/** A positive whole number, or null for "no limit". */
const OptionalLimit = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isInteger(value) && value > 0), {
    message: 'Must be a whole number above zero, or blank for no limit.',
  })

const RequiredCount = z
  .string()
  .trim()
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value > 0, {
    message: 'Must be a whole number above zero.',
  })

/**
 * `<input type="datetime-local">` posts `YYYY-MM-DDTHH:mm`, carrying no zone.
 *
 * Read as Dhaka time, because that is the clock the person typing it is looking
 * at. Taking it as UTC would start a Friday-morning sale at 6am Friday for the
 * office and 6pm Thursday for the database, and six hours of drift shows up only
 * as "the code worked before it was supposed to".
 */
const OptionalMoment = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : new Date(`${value}:00+06:00`)))
  .refine((value) => value === null || !Number.isNaN(value.getTime()), {
    message: 'That is not a date and time we can read.',
  })

const CouponForm = z
  .object({
    code: CodeField,
    label: z.string().trim().min(1).max(160),
    description: z
      .string()
      .trim()
      .max(2000)
      .transform((value) => (value === '' ? null : value)),
    type: z.enum(CouponType),
    value: RequiredCount,
    maxDiscountBdt: OptionalTaka,
    minSpendBdt: OptionalTaka,
    startsAt: OptionalMoment,
    endsAt: OptionalMoment,
    maxRedemptions: OptionalLimit,
    maxPerUser: RequiredCount,
    isActive: z.string().optional(),
  })
  /*
   * The three cross-field rules, each mirroring a CHECK constraint.
   *
   * Written here so the console can name the field that is wrong and say why.
   * The constraint still runs and still wins; this exists so nobody meets it.
   */
  .refine((form) => form.type !== CouponType.PERCENT || form.value <= 100, {
    path: ['value'],
    message: 'A percentage cannot be above 100.',
  })
  .refine((form) => form.maxDiscountBdt === null || form.type === CouponType.PERCENT, {
    path: ['maxDiscountBdt'],
    // On a FIXED coupon the value IS the cap, so a second one is a number
    // nobody reads — which is why the constraint refuses it too.
    message: 'A discount cap only means something on a percentage code.',
  })
  .refine((form) => form.startsAt === null || form.endsAt === null || form.endsAt > form.startsAt, {
    path: ['endsAt'],
    message: 'The end has to come after the start.',
  })

/** Which row an edit targets. Selects, never written. */
const EditForm = z.object({ id: z.uuid() })

const ToggleForm = z.object({ id: z.uuid(), active: z.enum(['true', 'false']) })

/** What an audit entry carries. No counters, no redemption history. */
const AUDITED_SELECT = {
  code: true,
  label: true,
  type: true,
  value: true,
  maxDiscountBdt: true,
  minSpendBdt: true,
  startsAt: true,
  endsAt: true,
  maxRedemptions: true,
  maxPerUser: true,
  isActive: true,
} as const

function backTo(target: string, message: string): never {
  redirect(`${target}?error=${encodeURIComponent(message)}`)
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'That form could not be read.'
  const field = issue.path.join('.')
  return field === '' ? issue.message : `${field}: ${issue.message}`
}

/**
 * A row as an audit payload.
 *
 * `recordAudit` stores JSON, and a `Date` is not JSON — Prisma's
 * `InputJsonValue` rejects one at the type level rather than letting it
 * serialise to whatever `JSON.stringify` happens to produce. Converting to ISO
 * here keeps the stored window readable in the same form the API speaks.
 */
function auditable(row: Record<string, unknown>): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : (value ?? null),
    ])
  ) as Prisma.InputJsonObject
}

export async function createCoupon(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(PROMO_WRITE_ROLES)
  // Silently doing nothing would look like a successful save. Throwing lands on
  // the console's error boundary, which is the honest outcome for a post no
  // holder of this session should have been able to make.
  if (admin === null) throw new Error('Not permitted.')

  const parsed = CouponForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo('/coupons/new', firstIssue(parsed.error))

  const { isActive, ...fields } = parsed.data

  // A unique index owns this. The check exists so a duplicate reads as a
  // sentence rather than a constraint violation; the index still decides under
  // a race, and the create below is wrapped for exactly that case.
  const clash = await db.coupon.findUnique({ where: { code: fields.code }, select: { id: true } })
  if (clash !== null) backTo('/coupons/new', `${fields.code} already exists.`)

  try {
    await db.coupon.create({
      data: { ...fields, isActive: isActive === 'on' },
      select: { id: true },
    })
  } catch {
    backTo('/coupons/new', 'That code could not be created. Check the values and try again.')
  }

  await recordAudit({
    action: 'coupon.created',
    entityType: 'coupon',
    // The code rather than the uuid, because the code is what an incident
    // report gets written in.
    entityId: fields.code,
    adminUserId: admin.adminUserId,
    after: auditable({ ...fields, isActive: isActive === 'on' }),
  })

  revalidatePath('/coupons')
  redirect(`/coupons?done=${encodeURIComponent(`${fields.code} created.`)}`)
}

/**
 * Edit a code.
 *
 * THE CODE STRING IS EDITABLE HERE, unlike a plan's. Nothing joins on it —
 * `coupon_redemptions` references `couponId` — so a rename breaks no rows. The
 * only argument against is that a code already handed out stops working, and the
 * form says that beside the field rather than enforcing it: fixing a typo in a
 * code nobody has used yet is a real thing to want.
 *
 * `redeemedCount` is not in the form and cannot be posted. It is bookkeeping the
 * booking transaction maintains, and a hand-edited counter would be a number
 * disagreeing with the redemption rows that actually enforce the ceiling.
 */
export async function updateCoupon(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(PROMO_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const target = EditForm.safeParse({ id: formData.get('id') })
  if (!target.success) backTo('/coupons', 'That code could not be identified.')

  const here = `/coupons/${target.data.id}`

  const parsed = CouponForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(here, firstIssue(parsed.error))

  const { isActive, ...fields } = parsed.data

  const before = await db.coupon.findUnique({
    where: { id: target.data.id },
    select: AUDITED_SELECT,
  })
  if (before === null) backTo('/coupons', 'No such code.')

  let after: typeof before

  try {
    after = await db.coupon.update({
      where: { id: target.data.id },
      data: { ...fields, isActive: isActive === 'on' },
      select: AUDITED_SELECT,
    })
  } catch {
    backTo(here, 'That change could not be saved. Another code may already use that name.')
  }

  await recordAudit({
    action: 'coupon.updated',
    entityType: 'coupon',
    entityId: before.code,
    adminUserId: admin.adminUserId,
    before: auditable(before),
    after: auditable(after),
  })

  revalidatePath('/coupons')
  revalidatePath(here)
  redirect(`/coupons?done=${encodeURIComponent(`${after.code} saved.`)}`)
}

/**
 * Switch a code on or off.
 *
 * The whole of "delete", as far as this console is concerned. `isActive` is the
 * first thing the validation engine checks, so switching it off stops the code
 * on the next request while the row and every redemption against it stay exactly
 * where they are.
 *
 * Predicated on the current state, so two people pressing at once resolve to one
 * change rather than to whichever write landed last.
 */
export async function setCouponActive(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(PROMO_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = ToggleForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo('/coupons', 'That code could not be identified.')

  const active = parsed.data.active === 'true'

  const updated = await db.coupon.updateMany({
    where: { id: parsed.data.id, isActive: !active },
    data: { isActive: active },
  })

  // Zero rows means somebody else already did it. Not worth a red banner — the
  // code is in the state the person wanted it in.
  if (updated.count > 0) {
    const coupon = await db.coupon.findUnique({
      where: { id: parsed.data.id },
      select: { code: true },
    })

    await recordAudit({
      action: active ? 'coupon.activated' : 'coupon.deactivated',
      entityType: 'coupon',
      entityId: coupon?.code ?? parsed.data.id,
      adminUserId: admin.adminUserId,
    })
  }

  revalidatePath('/coupons')
  redirect(
    `/coupons?done=${encodeURIComponent(active ? 'Code switched on.' : 'Code switched off.')}`
  )
}
