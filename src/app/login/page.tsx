'use client'

import { useActionState } from 'react'
import { signIn, type LoginState } from './actions'

/**
 * Staff sign-in.
 *
 * Deliberately outside the `(admin)` route group: the console shell links to
 * screens a signed-out visitor cannot open, and greeting someone whose session
 * just lapsed with a navigation bar of dead ends is a poor way to explain what
 * happened.
 */

const INITIAL: LoginState = { error: null }

export default function AdminLoginPage() {
  const [state, formAction, pending] = useActionState(signIn, INITIAL)

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 py-12 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <p className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Beyond Borders
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Admin console
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Staff accounts only. Traveller accounts cannot sign in here.
          </p>
        </div>

        <form action={formAction} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>

          {/* aria-live so a screen reader announces a refusal that appears
              without the page navigating. */}
          <p aria-live="polite" className="min-h-5 text-sm text-red-600 dark:text-red-400">
            {state.error ?? ''}
          </p>

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">
          Console sessions are not refreshed in the browser, so you will be asked to sign in again
          when this one lapses.
        </p>
      </div>
    </div>
  )
}
