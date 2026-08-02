import Link from 'next/link'
import type { ReactNode } from 'react'
import { signOut } from '../login/actions'
import { readConsoleAdmin } from './_lib/console-session'

/**
 * The admin console shell.
 *
 * Server-rendered, no client JavaScript, no UI framework. These are operational
 * screens read a few dozen times a day by a handful of people; every dependency
 * added here has to be upgraded forever for the benefit of a table.
 *
 * The shell also does the one thing a shell is genuinely good for: it resolves
 * the viewer once, in one place, so the header can say plainly whether anyone is
 * signed in. That is a courtesy, not the guard — a layout cannot protect a page,
 * because a page renders whether or not its layout approved of it. Every page
 * and every action re-checks for itself.
 */

/**
 * Grouped by what somebody came here to do rather than alphabetically. The
 * catalogue first, because it changes most often; then the money; then the two
 * screens that exist to answer "why is it behaving like that" — AI spend, and
 * what the public poll is being told.
 */
const NAV = [
  { href: '/activities', label: 'Activities' },
  { href: '/packages', label: 'Packages' },
  { href: '/past-trips', label: 'Past trips' },
  { href: '/leaders', label: 'Leaders' },
  { href: '/interests', label: 'Interest' },
  { href: '/polls', label: 'Polls' },
  { href: '/plans', label: 'Plans' },
  { href: '/subscriptions', label: 'Subscriptions' },
  // Bookings before Payments, and both before Coupons: a question about money
  // nearly always starts at "which booking", and the coupon is the explanation
  // for a figure on it rather than a thing anybody comes looking for first.
  { href: '/bookings', label: 'Bookings' },
  { href: '/payments', label: 'Payments' },
  { href: '/coupons', label: 'Coupons' },
  { href: '/ai-usage', label: 'AI usage' },
] as const

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await readConsoleAdmin()

  return (
    <div className="flex min-h-full flex-1 flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Beyond Borders
          </Link>

          <nav className="flex gap-4 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-zinc-600 underline-offset-4 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
            {admin ? (
              <>
                <span>Signed in · {admin.role}</span>
                {/* A plain form, so signing out needs no client JavaScript and
                    cannot be triggered by a cross-site GET. */}
                <form action={signOut}>
                  <button
                    type="submit"
                    className="underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link href="/login" className="underline underline-offset-4">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  )
}
