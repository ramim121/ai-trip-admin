import Link from 'next/link'
import { BookingStatus } from '@/generated/prisma/enums'
import { listAllBookings } from '@/server/modules/bookings/service'
import { Locked } from '../_components/locked'
import { COMMERCE_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatBdt, formatDateTime } from '../_lib/format'

/**
 * /bookings — seats held and seats sold.
 *
 * THE SEAT IS ALREADY GONE ON EVERY ROW IN HERE, including the PENDING_PAYMENT
 * ones. Booking claims inventory inside a transaction before any money moves,
 * so a pending row is a seat nobody else can buy — which makes "how many are
 * pending, and how old are they" the question this screen exists to answer. A
 * list showing only confirmed bookings would show a departure as half empty
 * while it was in fact full of holds.
 *
 * FOUR MONEY COLUMNS, NOT ONE. Unit price, subtotal, discount and total are
 * each stored on the row and each is rendered, because they are a snapshot of
 * what was agreed rather than a calculation to redo. When somebody rings about
 * a charge the answer has to be readable straight off this table, and a single
 * total column cannot explain itself.
 *
 * A row can have no account. `PackageBooking.userId` is nullable so the booking
 * survives an account deletion, and the contact details on the row are what
 * remains. The column says which case it is rather than rendering an empty cell
 * that reads like a bug.
 */

export const metadata = { title: 'Bookings · Beyond Borders' }

const PAGE_SIZE = 100

const STATUSES = [
  BookingStatus.PENDING_PAYMENT,
  BookingStatus.CONFIRMED,
  BookingStatus.CANCELLED,
  BookingStatus.REFUNDED,
] as const

function isBookingStatus(value: string): value is BookingStatus {
  return Object.hasOwn(BookingStatus, value)
}

/** Colour carries meaning here, so it is always paired with the word, never alone. */
const STATUS_CLASS: Record<BookingStatus, string> = {
  PENDING_PAYMENT: 'text-amber-700 dark:text-amber-400',
  CONFIRMED: 'text-emerald-700 dark:text-emerald-400',
  CANCELLED: 'text-zinc-600 dark:text-zinc-400',
  REFUNDED: 'text-violet-700 dark:text-violet-400',
}

/**
 * A `@db.Date` as the calendar date it is.
 *
 * Postgres hands these back at UTC midnight, so formatting them in the server's
 * local zone renders the previous day for every zone west of UTC. Pinning the
 * formatter to UTC is what keeps a departure on the date it was given.
 */
function formatTripDate(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value)
}

function bookingsHref(status: BookingStatus | null): string {
  return status === null ? '/bookings' : `/bookings?status=${status}`
}

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const query = await searchParams
  const raw = typeof query.status === 'string' ? query.status : null
  // An unrecognised `?status=` is ignored rather than rejected. This is a
  // filter, and the safe reading of a nonsense filter is "no filter", not a 400
  // in the middle of somebody working out what happened to a booking.
  const status = raw !== null && isBookingStatus(raw) ? raw : null

  // Filtered in memory rather than with a second query. `listAllBookings` is
  // the one place the booking projection is defined, and a page-local
  // `findMany` here would be a second copy that drifts the first time a column
  // is added. At a hundred rows the difference is not measurable.
  const all = await listAllBookings(PAGE_SIZE)
  const bookings = status === null ? all : all.filter((booking) => booking.status === status)

  /*
   * Counted across everything loaded, not just the filtered view.
   *
   * Pending holds are what somebody came here worried about, and the figure has
   * to stay visible while looking at CONFIRMED — otherwise the one view where
   * the warning matters most is the view that hides it.
   */
  const pending = all.filter((booking) => booking.status === BookingStatus.PENDING_PAYMENT)
  const heldSeats = pending.reduce((sum, booking) => sum + booking.partySize, 0)

  const tabClass = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      active
        ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
        : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400'
    }`

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Bookings</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        The {PAGE_SIZE} most recent, newest first. Every figure is the one stored on the booking
        when it was made — a departure repriced since then does not change what these travellers
        owe.
      </p>

      {pending.length > 0 && (
        <p className="mt-3 max-w-prose rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-semibold">{pending.length}</span>{' '}
          {pending.length === 1 ? 'booking is' : 'bookings are'} awaiting payment, holding{' '}
          <span className="font-semibold">{heldSeats}</span> {heldSeats === 1 ? 'seat' : 'seats'}.
          Those seats are already unavailable to anybody else.
        </p>
      )}

      <nav className="mt-4 flex flex-wrap gap-2">
        <Link href={bookingsHref(null)} className={tabClass(status === null)}>
          All
        </Link>
        {STATUSES.map((value) => (
          <Link key={value} href={bookingsHref(value)} className={tabClass(status === value)}>
            {value.replace('_', ' ')}
          </Link>
        ))}
      </nav>

      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[72rem] border-collapse text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3 font-medium">Reference</th>
              <th className="px-4 py-3 font-medium">Traveller</th>
              <th className="px-4 py-3 font-medium">Trip</th>
              <th className="px-4 py-3 font-medium">Departure</th>
              <th className="px-4 py-3 font-medium">Seats</th>
              <th className="px-4 py-3 font-medium">Unit</th>
              <th className="px-4 py-3 font-medium">Subtotal</th>
              <th className="px-4 py-3 font-medium">Discount</th>
              <th className="px-4 py-3 font-medium">Total</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Booked / paid</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {bookings.map((booking) => (
              <tr key={booking.id}>
                <td className="px-4 py-3 font-mono whitespace-nowrap">{booking.reference}</td>

                <td className="px-4 py-3">
                  <div className="font-medium">{booking.contactName}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {booking.contactEmail}
                    {booking.contactPhone !== null && ` · ${booking.contactPhone}`}
                  </div>
                  {booking.user === null && (
                    <div className="text-xs text-zinc-500 italic dark:text-zinc-400">
                      account removed
                    </div>
                  )}
                </td>

                <td className="px-4 py-3">
                  <Link
                    href={`/packages/${booking.package.slug}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {booking.package.title}
                  </Link>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {booking.package.destinationLabel}, {booking.package.country}
                  </div>
                </td>

                <td className="px-4 py-3 whitespace-nowrap">
                  {formatTripDate(booking.departure.startDate)}
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    to {formatTripDate(booking.departure.endDate)} · {booking.departure.status}
                  </div>
                </td>

                <td className="px-4 py-3 tabular-nums">{booking.partySize}</td>
                <td className="px-4 py-3 tabular-nums">{formatBdt(booking.unitPriceBdt)}</td>
                <td className="px-4 py-3 tabular-nums">{formatBdt(booking.subtotalBdt)}</td>

                {/* The code beside the amount. "− ৳5,550" with no reason next
                    to it is the cell somebody has to open a database console to
                    explain. */}
                <td className="px-4 py-3 tabular-nums">
                  {booking.discountBdt === 0 ? (
                    <span className="text-zinc-400 dark:text-zinc-500">—</span>
                  ) : (
                    <>
                      <span className="text-emerald-700 dark:text-emerald-400">
                        − {formatBdt(booking.discountBdt)}
                      </span>
                      {booking.redemption !== null && (
                        <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                          {booking.redemption.coupon.code}
                        </div>
                      )}
                    </>
                  )}
                </td>

                <td className="px-4 py-3 font-medium tabular-nums">{formatBdt(booking.totalBdt)}</td>

                <td className={`px-4 py-3 whitespace-nowrap ${STATUS_CLASS[booking.status]}`}>
                  {booking.status.replace('_', ' ')}
                  {/* A sandbox settlement confirmed a real booking and released
                      no seat back. Flagged for the same reason it is flagged on
                      /payments: it is not income. */}
                  {booking.payments.some((payment) => payment.isTest) && (
                    <div
                      className="mt-1 inline-block rounded border border-amber-500 bg-amber-100 px-1.5 py-0.5 text-[0.625rem] font-bold tracking-wide text-amber-900 uppercase dark:border-amber-500/70 dark:bg-amber-900/50 dark:text-amber-200"
                      title="Settled by the sandbox gateway — no money moved."
                    >
                      Test
                    </div>
                  )}
                </td>

                {/* Two dates, never collapsed into one. When it was made and
                    when it was paid answer different questions, and the gap
                    between them is what an ageing pending hold looks like. */}
                <td className="px-4 py-3 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                  {formatDateTime(booking.createdAt)}
                  <div className="text-xs">
                    {booking.cancelledAt !== null
                      ? `cancelled ${formatDateTime(booking.cancelledAt)}`
                      : booking.confirmedAt !== null
                        ? `paid ${formatDateTime(booking.confirmedAt)}`
                        : 'unpaid'}
                  </div>
                </td>
              </tr>
            ))}

            {bookings.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  {status === null ? 'No bookings yet.' : `No bookings with status ${status}.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
