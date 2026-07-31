/**
 * Rendering helpers for the console.
 *
 * Small, and shared for one reason: each encodes a rule that is wrong elsewhere
 * in the product if it gets written twice. Money is whole taka. A null limit is
 * unlimited, not zero. Times are read by staff sitting in Dhaka, so they are
 * shown in Dhaka.
 */

/**
 * Whole taka, grouped.
 *
 * No decimal places, ever — every money column in this schema is an `Int`
 * because there is no minor unit in circulation, and rendering "990.00" would
 * imply a precision the database deliberately does not carry.
 */
const TAKA = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })

export function formatBdt(amount: number): string {
  return `৳ ${TAKA.format(amount)}`
}

/**
 * A plan limit.
 *
 * `null` means unlimited. Printing it as "0", or as an empty cell, is the same
 * mistake the enforcement code is written to avoid — and on this screen it
 * would make the most expensive tier look like the most restrictive one.
 */
export function formatLimit(limit: number | null): string {
  return limit === null ? 'Unlimited' : String(limit)
}

/**
 * Local time at head office.
 *
 * Timestamps are stored in UTC and shown in Asia/Dhaka, because "did this
 * payment settle before or after we closed" is a question about Dhaka, not
 * about the server's locale.
 */
const DHAKA = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatDateTime(value: Date | null): string {
  return value === null ? '—' : DHAKA.format(value)
}
