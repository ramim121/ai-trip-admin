import Link from 'next/link'
import { listCoupons } from '@/server/modules/bookings/service'
import { Locked } from '../_components/locked'
import {
  COMMERCE_READ_ROLES,
  PROMO_WRITE_ROLES,
  readConsoleAdminWithRole,
} from '../_lib/console-session'
import { formatBdt, formatDateTime } from '../_lib/format'
import { setCouponActive } from './actions'

/**
 * /coupons — the promo codes, and how much of each is left.
 *
 * WHY THERE ARE TWO REDEMPTION NUMBERS, and which one matters.
 * `_count.redemptions` is how many redemption rows exist, and it is what the
 * ceiling is ENFORCED against: `evaluateCoupon` counts those rows, and says so —
 * "counted from the redemption rows rather than from `redeemedCount`, which is a
 * denormalisation for the console and the wrong thing to enforce against".
 * `redeemedCount` is that denormalisation. Both are written in the same booking
 * transaction so they should agree, and a screen showing only one could never
 * tell you they had stopped.
 *
 * THIS COMMENT PREVIOUSLY SAID THE OPPOSITE — that the counter was incremented
 * under a conditional update, that it was what enforced the ceiling, and that
 * cancelling a booking released its redemption row. All three were false: the
 * increment is unconditional, the row count is what binds, and nothing anywhere
 * in the codebase deletes a redemption row. It mattered because the same claim
 * reached ops in the drift banner below, sending anybody investigating a
 * discrepancy to the column the engine never reads.
 *
 * EVERY CONSTRAINT IS A COLUMN, because a code that "does not work" is almost
 * always a code working exactly as configured. Minimum spend, per-booking cap,
 * package restriction, window, per-traveller ceiling and total ceiling are what
 * the engine refuses on, so all of them are visible without opening a row — the
 * refusal vocabulary in the booking service maps one-to-one onto them.
 *
 * WRITABLE BY OPS, under `PROMO_WRITE_ROLES` rather than the SUPER_ADMIN-only
 * `COMMERCE_WRITE_ROLES`. The difference is blast radius, and a coupon's is
 * bounded by the row itself — total uses, uses per account, a cap on what a
 * percentage can take off, and a window. A plan reprice has none of those
 * brakes. Codes used to be seed-and-migration only, which put a marketing lever
 * behind a deploy.
 *
 * Reading stays on the wider commerce list, so a colleague who cannot author a
 * code can still explain one to a traveller.
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
  _count: { redemptions: number }
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
  // Against the redemption ROWS, not the counter — the same number evaluateCoupon
  // refuses on. Reading the counter here meant that exactly when the two drifted,
  // this column was computed from the one the engine ignores.
  if (coupon.maxRedemptions !== null && coupon._count.redemptions >= coupon.maxRedemptions) {
    return { label: 'Fully redeemed', className: 'text-red-700 dark:text-red-400' }
  }
  return { label: 'Live', className: 'text-emerald-700 dark:text-emerald-400' }
}

export default async function CouponsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  // Reading is the wider list; authoring is OPS. A colleague who can explain a
  // code to a traveller does not have to be able to write one.
  const canWrite = (await readConsoleAdminWithRole(PROMO_WRITE_ROLES)) !== null

  const query = await searchParams
  const done = typeof query.done === 'string' ? query.done : null
  const error = typeof query.error === 'string' ? query.error : null

  const coupons = await listCoupons(PAGE_SIZE)

  // Compared rather than trusted. A drift means either a redemption row exists
  // the counter never saw or the reverse — and since both are written in one
  // transaction, either direction means something wrote to the database outside
  // the application. Worth saying above the table.
  const drifted = coupons.filter((coupon) => coupon.redeemedCount !== coupon._count.redemptions)

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Coupons</h1>
          <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
            Active codes first. Every column here is something the booking engine refuses on, so a
            code somebody says is &ldquo;not working&rdquo; can usually be explained from its row
            without opening anything.
          </p>
        </div>

        {canWrite && (
          <Link
            href="/coupons/new"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            New coupon
          </Link>
        )}
      </div>

      {done !== null && (
        <p className="mt-3 max-w-prose rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {done}
        </p>
      )}

      {error !== null && (
        <p
          role="alert"
          className="mt-3 max-w-prose rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {drifted.length > 0 && (
        <p className="mt-3 max-w-prose rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200">
          <span className="font-semibold">{drifted.length}</span>{' '}
          {drifted.length === 1 ? 'coupon has' : 'coupons have'} a redeemed counter that disagrees
          with its redemption rows ({drifted.map((coupon) => coupon.code).join(', ')}). The ROWS are
          what the ceiling is enforced against, so the claimed figure is the true one. Both are
          written in the same transaction, so a gap means somebody has been in the database by hand.
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
              {canWrite && <th className="px-4 py-3 font-medium">Switch</th>}
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {coupons.map((coupon) => {
              const state = liveState(coupon)
              const drift = coupon.redeemedCount !== coupon._count.redemptions

              return (
                <tr key={coupon.id}>
                  <td className="px-4 py-3">
                    {canWrite ? (
                      <Link
                        href={`/coupons/${coupon.id}`}
                        className="font-mono font-medium underline-offset-4 hover:underline"
                      >
                        {coupon.code}
                      </Link>
                    ) : (
                      <div className="font-mono font-medium">{coupon.code}</div>
                    )}
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

                  <td className={`px-4 py-3 whitespace-nowrap ${state.className}`}>
                    {state.label}
                  </td>

                  {/* One button per row rather than a checkbox: this console
                      ships no client JavaScript, so a checkbox would need a
                      submit beside it anyway. The value posted is the state
                      being MOVED TO, and the action predicates on the current
                      one — so two people pressing at once resolve to one
                      change rather than to whichever write landed last. */}
                  {canWrite && (
                    <td className="px-4 py-3">
                      <form action={setCouponActive}>
                        <input type="hidden" name="id" value={coupon.id} />
                        <input
                          type="hidden"
                          name="active"
                          value={coupon.isActive ? 'false' : 'true'}
                        />
                        <button
                          type="submit"
                          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
                        >
                          {coupon.isActive ? 'Switch off' : 'Switch on'}
                        </button>
                      </form>
                    </td>
                  )}
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
