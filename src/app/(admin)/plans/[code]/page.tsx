import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PlanCode } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { Locked } from '../../_components/locked'
import {
  COMMERCE_READ_ROLES,
  COMMERCE_WRITE_ROLES,
  readConsoleAdminWithRole,
} from '../../_lib/console-session'
import { formatDateTime } from '../../_lib/format'
import { updatePlan } from './actions'

/**
 * /plans/[code] — edit one tier.
 *
 * A plain form posting to a server action. No client component, no controlled
 * inputs, no validation in the browser: the action re-validates everything it
 * receives, so a second copy of the rules running client-side could only ever
 * be the copy that goes out of date.
 *
 * Blank means unlimited on the three limit fields, and the form says so beside
 * each. That is the only genuinely surprising thing on this screen, and it is
 * the difference between "this tier has no ceiling" and "this tier can do
 * nothing at all".
 *
 * `code` and `interval` are shown but not editable. The code is the identity
 * every payment and subscription refers to; the interval decides what a
 * Subscription row means. Neither is a text-field-sized decision.
 */

const PLAN_SELECT = {
  code: true,
  name: true,
  description: true,
  priceBdt: true,
  interval: true,
  maxItineraryDays: true,
  maxSavedItineraries: true,
  itinerariesPerPeriod: true,
  isActive: true,
  sortOrder: true,
  updatedAt: true,
} as const

function isPlanCode(value: string): value is PlanCode {
  return Object.hasOwn(PlanCode, value)
}

const fieldClass =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950'
const labelClass = 'block text-sm font-medium'
const hintClass = 'mt-1 text-xs text-zinc-500 dark:text-zinc-400'

export default async function EditPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  /*
   * TWO GATES, BECAUSE THE PAGE AND THE FORM ARE NOT THE SAME PERMISSION.
   *
   * Reading a plan is an OPS question — "what does this tier actually include"
   * comes up while answering a traveller. Changing one sets the price of every
   * future purchase of it, and that is SUPER_ADMIN only.
   *
   * Gating only the page, as this did, rendered a fully submittable form to any
   * OPS admin whose action then threw `Not permitted.` — and with no error.tsx
   * anywhere under src/app, that was Next's raw error page, arriving after they
   * had typed a new price in. The form is what needs the write role, so the form
   * is what checks it. `activities/new` already worked this way; this did not.
   */
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const canWrite = (await readConsoleAdminWithRole(COMMERCE_WRITE_ROLES)) !== null

  const { code } = await params
  if (!isPlanCode(code)) notFound()

  const plan = await db.plan.findUnique({ where: { code }, select: PLAN_SELECT })
  if (plan === null) notFound()

  const query = await searchParams
  const error = typeof query.error === 'string' ? query.error : null

  return (
    <section className="max-w-2xl">
      <Link
        href="/plans"
        className="text-sm text-zinc-600 underline underline-offset-4 hover:no-underline dark:text-zinc-400"
      >
        ← All plans
      </Link>

      <h1 className="mt-3 text-xl font-semibold tracking-tight">{plan.name}</h1>
      <p className="mt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
        {plan.code} · {plan.interval} · last changed {formatDateTime(plan.updatedAt)}
      </p>

      {error !== null && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {!canWrite && (
        <p className="mt-4 rounded-md border border-dashed border-zinc-300 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          You can read this plan but not change it. Repricing a tier changes what every future
          purchase of it costs, so it needs a super-admin.
        </p>
      )}

      <form action={updatePlan} className="mt-6 space-y-5" hidden={!canWrite}>
        {/* Selects the row to write. Re-validated against the enum in the
            action — it travels through the client like every other field. */}
        <input type="hidden" name="code" value={plan.code} />

        <div>
          <label className={labelClass} htmlFor="name">
            Name
          </label>
          <input
            id="name"
            name="name"
            defaultValue={plan.name}
            required
            maxLength={120}
            className={fieldClass}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="description">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            defaultValue={plan.description}
            required
            maxLength={2000}
            rows={4}
            className={fieldClass}
          />
          <p className={hintClass}>Shown on the public pricing page.</p>
        </div>

        <div>
          <label className={labelClass} htmlFor="priceBdt">
            Price (BDT)
          </label>
          <input
            id="priceBdt"
            name="priceBdt"
            type="number"
            min={0}
            step={1}
            defaultValue={plan.priceBdt}
            required
            className={fieldClass}
          />
          <p className={hintClass}>
            Whole taka only. USD is display-only, computed from the admin-set rate at render time.
          </p>
        </div>

        <fieldset className="grid gap-5 sm:grid-cols-3">
          <legend className="text-sm font-medium">Limits</legend>

          <div>
            <label className={labelClass} htmlFor="maxItineraryDays">
              Max days
            </label>
            <input
              id="maxItineraryDays"
              name="maxItineraryDays"
              type="number"
              min={0}
              step={1}
              defaultValue={plan.maxItineraryDays ?? ''}
              className={fieldClass}
            />
            <p className={hintClass}>Blank = unlimited</p>
          </div>

          <div>
            <label className={labelClass} htmlFor="maxSavedItineraries">
              Max saved
            </label>
            <input
              id="maxSavedItineraries"
              name="maxSavedItineraries"
              type="number"
              min={0}
              step={1}
              defaultValue={plan.maxSavedItineraries ?? ''}
              className={fieldClass}
            />
            <p className={hintClass}>Blank = unlimited</p>
          </div>

          <div>
            <label className={labelClass} htmlFor="itinerariesPerPeriod">
              Per period
            </label>
            <input
              id="itinerariesPerPeriod"
              name="itinerariesPerPeriod"
              type="number"
              min={0}
              step={1}
              defaultValue={plan.itinerariesPerPeriod ?? ''}
              className={fieldClass}
            />
            <p className={hintClass}>Blank = unmetered</p>
          </div>
        </fieldset>

        <div>
          <label className={labelClass} htmlFor="sortOrder">
            Sort order
          </label>
          <input
            id="sortOrder"
            name="sortOrder"
            type="number"
            step={1}
            defaultValue={plan.sortOrder}
            required
            className={`${fieldClass} sm:w-32`}
          />
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={plan.isActive} />
            On sale
          </label>
          <p className={hintClass}>
            Unchecking retires the plan: it disappears from the public list, and subscriptions
            already on it keep running to the end of their period.
          </p>
        </div>

        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Save plan
        </button>
      </form>
    </section>
  )
}
