import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { Locked } from '../../_components/locked'
import { PROMO_WRITE_ROLES, readConsoleAdminWithRole } from '../../_lib/console-session'
import { formatDateTime } from '../../_lib/format'
import { updateCoupon } from '../actions'
import { CouponFormFields } from '../coupon-form'

/**
 * /coupons/[id] — edit one promo code.
 *
 * Keyed by id rather than by code, unlike the plan editor. The code IS editable
 * here — nothing joins on the string, so a rename breaks no rows — and a URL
 * built from an editable field stops resolving the moment somebody uses it.
 *
 * HOW MUCH HAS BEEN CLAIMED IS SHOWN, NEVER EDITABLE, and the two numbers appear
 * separately on purpose. The redemption ROW COUNT is what the booking engine
 * enforces the ceiling against; `redeemedCount` is a denormalised counter for
 * the list view. They should agree. Showing only one makes it impossible to
 * notice they have stopped agreeing — and presenting the counter as the
 * enforcing number, which this console used to do, points anybody investigating
 * at the column the engine does not read.
 */

export const metadata = { title: 'Coupon · Beyond Borders' }

const COUPON_SELECT = {
  id: true,
  code: true,
  label: true,
  description: true,
  type: true,
  value: true,
  maxDiscountBdt: true,
  minSpendBdt: true,
  startsAt: true,
  endsAt: true,
  maxRedemptions: true,
  maxPerUser: true,
  isActive: true,
  redeemedCount: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { redemptions: true } },
} as const

export default async function EditCouponPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(PROMO_WRITE_ROLES)
  if (admin === null) return <Locked />

  const [{ id }, query] = await Promise.all([params, searchParams])
  const error = typeof query.error === 'string' ? query.error : null

  const coupon = await db.coupon.findUnique({ where: { id }, select: COUPON_SELECT })
  if (coupon === null) notFound()

  const drifted = coupon.redeemedCount !== coupon._count.redemptions

  return (
    <section className="max-w-3xl">
      <Link
        href="/coupons"
        className="text-sm text-zinc-600 underline underline-offset-4 hover:no-underline dark:text-zinc-400"
      >
        ← All coupons
      </Link>

      <h1 className="mt-3 font-mono text-xl font-semibold tracking-tight">{coupon.code}</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {coupon.label} · created {formatDateTime(coupon.createdAt)} · last changed{' '}
        {formatDateTime(coupon.updatedAt)}
      </p>

      {error !== null && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      <dl className="mt-6 grid gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-sm sm:grid-cols-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            Claimed
          </dt>
          <dd className="mt-1 tabular-nums">
            {coupon._count.redemptions}
            {coupon.maxRedemptions !== null && ` of ${coupon.maxRedemptions}`}
          </dd>
          {/* Named as the enforcing number because it is: `evaluateCoupon`
              counts these rows. The console previously credited the counter
              beside it, which is the column the engine never reads. */}
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Redemption rows — what the ceiling is enforced against.
          </p>
        </div>

        <div>
          <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            Counter
          </dt>
          <dd className="mt-1 tabular-nums">{coupon.redeemedCount}</dd>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Denormalised for the list. Bookkeeping, not enforcement.
          </p>
        </div>

        <div>
          <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            State
          </dt>
          <dd className="mt-1 font-medium">{coupon.isActive ? 'Active' : 'Switched off'}</dd>
        </div>
      </dl>

      {drifted && (
        <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200">
          The counter and the redemption rows disagree. The rows are the ones that count — this code
          has been claimed <span className="font-semibold">{coupon._count.redemptions}</span> times
          whatever the counter says. Nothing in the application writes one without the other in the
          same transaction, so a gap means somebody has been in the database by hand.
        </p>
      )}

      <form action={updateCoupon} className="mt-6">
        <CouponFormFields coupon={coupon} />

        <button
          type="submit"
          className="mt-6 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Save changes
        </button>
      </form>

      <p className="mt-4 max-w-prose text-xs text-zinc-500 dark:text-zinc-400">
        There is no delete. Switching a code off stops it on the next request and keeps every
        redemption made against it — which is what somebody will need if a traveller says a discount
        was promised. Deleting the row would take that history with it.
      </p>
    </section>
  )
}
