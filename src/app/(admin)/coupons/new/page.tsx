import Link from 'next/link'
import { Locked } from '../../_components/locked'
import { PROMO_WRITE_ROLES, readConsoleAdminWithRole } from '../../_lib/console-session'
import { createCoupon } from '../actions'
import { CouponFormFields } from '../coupon-form'

/**
 * /coupons/new — a new promo code.
 *
 * Gated on the WRITE role rather than the read one, following `activities/new`.
 * A page whose only content is a form has nothing to show somebody who cannot
 * submit it, and rendering one anyway is how a console ends up throwing at
 * people after they have typed a price in.
 */

export const metadata = { title: 'New coupon · Beyond Borders' }

export default async function NewCouponPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(PROMO_WRITE_ROLES)
  if (admin === null) return <Locked />

  const query = await searchParams
  const error = typeof query.error === 'string' ? query.error : null

  return (
    <section className="max-w-3xl">
      <Link
        href="/coupons"
        className="text-sm text-zinc-600 underline underline-offset-4 hover:no-underline dark:text-zinc-400"
      >
        ← All coupons
      </Link>

      <h1 className="mt-3 text-xl font-semibold tracking-tight">New coupon</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Every field here is something the booking engine refuses on, so what is set now is what
        somebody will read back off the list when a traveller says the code did not work.
      </p>

      {error !== null && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      <form action={createCoupon} className="mt-6">
        <CouponFormFields coupon={null} />

        <button
          type="submit"
          className="mt-6 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Create coupon
        </button>
      </form>
    </section>
  )
}
