'use client'

import { useEffect } from 'react'

/**
 * What the console shows when a page or a server action throws.
 *
 * THERE WAS NOTHING HERE BEFORE, so every uncaught throw in the admin app
 * rendered Next's own error page — a bare screen with a digest and no way back.
 * That is a poor result for a genuine fault and an absurd one for the case that
 * actually reached it: a server action refusing a write with
 * `throw new Error('Not permitted.')`, which is a permission answer rather than
 * a crash.
 *
 * THE MESSAGE IS NOT RENDERED. Next redacts `error.message` from a Server
 * Component or server action in production anyway, but the rule matters in
 * development too: whatever a route threw may name a table, a constraint or a
 * column, and this screen is reachable by anyone who can reach the console. The
 * digest is shown instead — it is the id tying this screen to the line in the
 * server log that does carry the detail.
 *
 * `reset()` re-renders the segment without a document load. It is offered
 * because a fair share of what lands here is transient — a pooled connection
 * that went away, a deploy mid-request — and re-running the render is the right
 * first response to those.
 */

export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // The one place the real message survives on the client. Server-side faults
    // are already in the platform log; this catches everything else.
    console.error('[console]', error)
  }, [error])

  return (
    <section className="max-w-prose">
      <h1 className="text-xl font-semibold tracking-tight">That did not work</h1>

      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Something failed while building this screen. If you were saving something, check whether it
        took effect before trying again — this page cannot tell you whether the write landed.
      </p>

      {error.digest !== undefined && (
        <p className="mt-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">
          Reference: {error.digest}
        </p>
      )}

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Try again
        </button>

        {/*
         * A plain anchor rather than next/link, and the lint rule is suppressed
         * rather than obeyed.
         *
         * That rule is right almost everywhere: a client-side navigation is
         * faster and keeps the router's state. Keeping the router's state is
         * exactly the problem here. This boundary catches render failures, and
         * when the failure is in something the router is still holding, a soft
         * navigation can re-render straight back into it — an escape hatch that
         * lands you where you started is not one. A full document load always
         * escapes.
         */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
        >
          Back to the dashboard
        </a>
      </div>
    </section>
  )
}
