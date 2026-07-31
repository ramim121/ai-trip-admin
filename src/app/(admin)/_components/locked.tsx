/**
 * What a console screen shows to someone it will not show data to.
 *
 * One component, used by every screen, so the refusal is identical everywhere:
 * no page name, no record count, no hint about what sits behind it. A locked
 * screen that says "3 payments hidden" has already answered the question it was
 * refusing to answer.
 *
 * It deliberately does not distinguish "not signed in" from "signed in without
 * the role". Both mean "not for you", and telling a CONTENT admin that some
 * other role would work here is an invitation rather than an explanation.
 */
export function Locked() {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
      <h1 className="text-lg font-semibold tracking-tight">Not available</h1>
      <p className="mt-2 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        This screen needs a staff session that this browser does not have. Sign in with an account
        that has access, then reload.
      </p>
    </div>
  )
}
