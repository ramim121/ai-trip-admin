import Link from 'next/link'
import { listCoupons } from '@/server/modules/bookings/service'
import { Locked } from '../_components/locked'
import { COMMERCE_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatBdt, formatDateTime } from '../_lib/format'

/**
 * /coupons — the promo codes, and how much of each is left.
 *
 * WHY THERE ARE TWO REDEMPTION NUMBERS. `redeemedCount` is the counter the
 * booking transaction increments under a conditional update — it is what
 * actually enforces the ceiling, and it is the number a race can only ever move
 * correctly. `_count.redemptions` is how many redemption rows exist. They
 * should agree, and a screen showing only one could never tell you they had
 * stopped agreeing. Cancelling a booking releases its redemption row, so a gap
 * here is a real signal rather than a rounding difference.
 *
 * EVERY CONSTRAINT IS A COLUMN, because a code that "does not work" is almost
 * always a code working exactly as configured. Minimum spend, per-booking cap,
 * package restriction, window, per-traveller ceiling and total ceiling are what
 * the engine refuses on, so all of them are visible without opening a row — the
 * refusal vocabulary in the booking service maps one-to-one onto them.
 *
 * READ-ONLY, DELIBERATELY. `COMMERCE_WRITE_ROLES` is empty — no console role
 * may write commerce — so this screen shows and does not edit. Codes are
 * created by seed or migration, which means a value deciding what somebody is
 * charged goes through review rather than through a text field.
 */

export const metadata = { title: 'Coupons · Beyond Borders' }

const PAGE_SIZE = 100

/** "15% off, up to ৳8,000" or "৳2,000 off" — the rule as a sentence. */
function describeDiscount(coupon: {
  type: 'PERCENT' | 'FIXED'
  value: number
  maxDiscountBdt: number | null
}): string {
  if (coupon.type === 'FIXED') return `${formatBdt(coupon.value)} off`

  const cap = coupon.maxDiscountBdt === null ? '' : `, up to ${formatBdt(coupon.maxDiscountBdt)}`
  return `${coupon.value}% off${cap}`
}

/**
 * Whether a code would be accepted right now, and if not, why.
 *
 * Mirrors the refusals `evaluateCoupon` can return, minus the two that depend
 * on who is asking: WRONG_PACKAGE and ALREADY_USED are properties of a
 * particular booking rather than of the coupon, and asserting either here would
 * be a claim this page is in no position to check.
 */
function liveState(coupon: {
  isActive: boolean
  startsAt: Date | null
  endsAt: Date | null
  maxRedemptions: number | null
  redeemedCount: number
}): { label: string; className: string } {
  const now = new Date()

  if (!coupon.isActive) {
    return { label: 'Inactive', className: 'text-zinc-500 dark:text-zinc-400' }
  }
  if (coupon.startsAt !== null && coupon.startsAt > now) {
    return { label: 'Not started', className: 'text-sky-700 dark:text-sky-400' }
  }
  if (coupon.endsAt !== null && coupon.endsAt < now) {
    return { label: 'Expired', className: 'text-red-700 dark:text-red-400' }
  }
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { label: 'Fully redeemed', className: 'text-red-700 dark:text-red-400' }
  }
  return { label: 'Live', className: 'text-emerald-700 dark:text-emerald-400' }
}

export default async function CouponsPage() {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const coupons = await listCoupons(PAGE_SIZE)

  // Compared rather than trusted. A drift means either a redemption row exists
  // the counter never saw or the reverse — and since the counter is what
  // enforces the ceiling, that is the thing worth saying above the table.
  const drifted = coupons.filter((coupon) => coupon.redeemedCount !== coupon._count.redemptions)

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Coupons</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Active codes first. Every column here is something the booking engine refuses on, so a code
        somebody says is &ldquo;not working&rdquo; can usually be explained from its row without
        opening anything.
      </p>

      {drifted.length > 0 && (
        <p className="mt-3 max-w-prose rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200">
          <span className="font-semibold">{drifted.length}</span>{' '}
          {drifted.length === 1 ? 'coupon has' : 'coupons have'} a redeemed counter that disagrees
          with its redemption rows ({drifted.map((coupon) => coupon.code).join(', ')}). The counter
          is what enforces the ceiling, so a gap means the ceiling is being enforced against the
          wrong number.
        </p>
      )}

      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[68rem] border-collapse text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3 font-medium">Code</th>
              <th className="px-4 py-3 font-medium">Discount</th>
              <th className="px-4 py-3 font-medium">Minimum spend</th>
              <th className="px-4 py-3 font-medium">Applies to</th>
              <th className="px-4 py-3 font-medium">Window</th>
              <th className="px-4 py-3 font-medium">Per traveller</th>
              <th className="px-4 py-3 font-medium">Redeemed</th>
              <th className="px-4 py-3 font-medium">State</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {coupons.map((coupon) => {
              const state = liveState(coupon)
              const drift = coupon.redeemedCount !== coupon._count.redemptions

              return (
                <tr key={coupon.id}>
                  <td className="px-4 py-3">
                    <div className="font-mono font-medium">{coupon.code}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">{coupon.label}</div>
                  </td>

                  <td className="px-4 py-3 whitespace-nowrap">{describeDiscount(coupon)}</td>

                  <td className="px-4 py-3 tabular-nums">
                    {coupon.minSpendBdt === null ? (
                      <span className="text-zinc-400 dark:text-zinc-500">none</span>
                    ) : (
                      formatBdt(coupon.minSpendBdt)
                    )}
                  </td>

                  {/* A null package is every package, and that difference is
                      the whole of WRONG_PACKAGE. Saying "all trips" rather than
                      leaving the cell empty is what makes it legible. */}
                  <td className="px-4 py-3">
                    {coupon.package === null ? (
                      <span className="text-zinc-500 dark:text-zinc-400">all trips</span>
                    ) : (
                      <Link
                        href={`/packages/${coupon.package.slug}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {coupon.package.title}
                      </Link>
                    )}
                  </td>

                  <td className="px-4 py-3 text-xs whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                    {coupon.startsAt === null && coupon.endsAt === null ? (
                      <span className="text-zinc-400 dark:text-zinc-500">always</span>
                    ) : (
                      <>
                        <div>from {formatDateTime(coupon.startsAt)}</div>
                        <div>until {formatDateTime(coupon.endsAt)}</div>
                      </>
                    )}
                  </td>

                  <td className="px-4 py-3 tabular-nums">{coupon.maxPerUser}</td>

                  {/* The enforcing counter first, the row count under it, both
                      marked when they disagree. */}
                  <td className="px-4 py-3 tabular-nums">
                    <span className={drift ? 'font-semibold text-red-700 dark:text-red-400' : ''}>
                      {coupon.redeemedCount}
                      {coupon.maxRedemptions === null ? '' : ` / ${coupon.maxRedemptions}`}
                    </span>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {coupon._count.redemptions} row{coupon._count.redemptions === 1 ? '' : 's'}
                    </div>
                  </td>

                  <td className={`px-4 py-3 whitespace-nowrap ${state.className}`}>{state.label}</td>
                </tr>
              )
            })}

            {coupons.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  No coupons yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 max-w-prose text-xs text-zinc-500 dark:text-zinc-400">
        Read-only. Codes are created by seed or migration so that a value deciding what somebody is
        charged goes through review rather than through a text field.
      </p>
    </section>
  )
}
