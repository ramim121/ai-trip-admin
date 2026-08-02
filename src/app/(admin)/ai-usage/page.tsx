import { AdminRole } from '@/generated/prisma/enums'
import { MICRO_BDT_PER_BDT } from '@/server/ai/usage'
import {
  DAY_MS,
  MONTH_MS,
  accountAllowances,
  anonymousSummary,
  busiestAddressBuckets,
  cacheSummary,
  credentialPresence,
  readModelConfiguration,
  recentFailures,
  siteCeilings,
  usageByModel,
  usageBySurface,
  type AccountAllowance,
  type CeilingStatus,
  type ModelUsageRow,
} from '@/server/modules/ai-usage/service'
import { Locked } from '../_components/locked'
import { readConsoleAdminWithRole } from '../_lib/console-session'
import { formatDateTime, formatLimit } from '../_lib/format'

/**
 * /ai-usage — what the AI cost, and what is left.
 *
 * Built around the question ops actually arrives with, which is never "how many
 * tokens". It is one of:
 *
 *   the bill looks wrong         → per-model spend, and which models are unpriced
 *   a traveller says it stopped  → their allowance, and when it resets
 *   is it broken right now       → recent failures, with the error class
 *   are we about to be throttled → the site ceilings and their reset times
 *
 * Each section answers exactly one of those and says which. Numbers that could
 * be mistaken for one another are labelled rather than left adjacent: "unpriced"
 * is never rendered as 0, an unlimited allowance is never rendered as 0, and a
 * cached call is counted apart from a billed one everywhere both appear.
 *
 * Read-only, server-rendered, no client JavaScript — the same posture as every
 * other console screen. Nothing here can change a limit; the limits live in
 * plans, in env, and in one deliberately un-editable constant.
 */

export const metadata = { title: 'AI usage · Beyond Borders' }

/** Live numbers. A cached render of a spend dashboard is a misleading one. */
export const dynamic = 'force-dynamic'

/** Enough accounts to find the heavy users, not so many it becomes a report. */
const ACCOUNT_ROWS = 50
const FAILURE_ROWS = 15
const ADDRESS_ROWS = 8

/**
 * Who may read this screen.
 *
 * OPS, because cost and capacity are ops questions — plus the implicit
 * SUPER_ADMIN pass. CONTENT and SUPPORT are deliberately out: this page lists
 * traveller email addresses beside their usage, which is a different thing from
 * the catalog everyone on staff can read.
 */
const AI_USAGE_ROLES: readonly AdminRole[] = [AdminRole.OPS]

const COUNT = new Intl.NumberFormat('en-GB')

function formatCount(value: number): string {
  return COUNT.format(value)
}

/**
 * Micro-taka as money.
 *
 * Four decimal places, because one flash-class call costs a small fraction of a
 * taka and rounding to whole taka would render every honest row as `৳ 0`. This
 * screen is the one place that fraction matters — `formatBdt` stays whole-taka
 * for prices, which genuinely are integers.
 */
function formatMicroBdt(micro: number | null): string {
  if (micro === null) return 'unpriced'
  return `৳ ${(micro / MICRO_BDT_PER_BDT).toFixed(4)}`
}

/** How long until a window rolls over, in the units a person would say it in. */
function formatCountdown(target: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((target.getTime() - now.getTime()) / 1_000))
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function Card({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'plain' | 'warn' | 'good'
}) {
  const valueTone =
    tone === 'warn'
      ? 'text-amber-700 dark:text-amber-400'
      : tone === 'good'
        ? 'text-emerald-700 dark:text-emerald-400'
        : ''

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueTone}`}>{value}</div>
      {hint !== undefined && (
        <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{hint}</p>
      )}
    </div>
  )
}

function SectionHeading({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="mt-10">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">{blurb}</p>
    </div>
  )
}

const TH = 'px-4 py-3 font-medium'
const TD = 'px-4 py-3'
const TABLE_WRAP =
  'mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
const THEAD =
  'border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400'
const TBODY = 'divide-y divide-zinc-100 dark:divide-zinc-800'

function ModelTable({ rows, caption }: { rows: ModelUsageRow[]; caption: string }) {
  return (
    <div className={TABLE_WRAP}>
      <table className="w-full min-w-[64rem] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className={THEAD}>
          <tr>
            <th className={TH}>Model</th>
            <th className={TH}>Calls</th>
            <th className={TH}>OK</th>
            <th className={TH}>Failed</th>
            <th className={TH}>Refused</th>
            <th className={TH}>Cached</th>
            <th className={TH}>In</th>
            <th className={TH}>Out</th>
            <th className={TH}>Est. cost</th>
            <th className={TH}>Last call</th>
          </tr>
        </thead>
        <tbody className={TBODY}>
          {rows.map((row) => (
            <tr key={`${row.provider}/${row.model}`}>
              <td className={TD}>
                <div className="font-medium">{row.model}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{row.provider}</div>
              </td>
              <td className={`${TD} tabular-nums`}>{formatCount(row.calls)}</td>
              <td className={`${TD} tabular-nums`}>{formatCount(row.succeeded)}</td>
              <td
                className={`${TD} tabular-nums ${
                  row.failed > 0 ? 'text-amber-700 dark:text-amber-400' : ''
                }`}
              >
                {formatCount(row.failed)}
              </td>
              <td className={`${TD} tabular-nums`}>{formatCount(row.refused)}</td>
              <td className={`${TD} tabular-nums`}>{formatCount(row.cached)}</td>
              <td className={`${TD} tabular-nums`}>{formatCount(row.promptTokens)}</td>
              <td className={`${TD} tabular-nums`}>{formatCount(row.completionTokens)}</td>
              <td className={`${TD} tabular-nums`}>
                {formatMicroBdt(row.estimatedCostMicroBdt)}
                {row.price === null && (
                  <div className="text-xs text-amber-700 dark:text-amber-400">no price on file</div>
                )}
              </td>
              <td className={`${TD} whitespace-nowrap text-zinc-600 dark:text-zinc-400`}>
                {formatDateTime(row.lastSeenAt)}
              </td>
            </tr>
          ))}

          {rows.length === 0 && (
            <tr>
              <td colSpan={10} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                No model calls in this window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function CeilingCard({ ceiling, now }: { ceiling: CeilingStatus; now: Date }) {
  const spent =
    ceiling.limit === 0 ? 0 : Math.min(100, Math.round((ceiling.hits / ceiling.limit) * 100))
  const tight = ceiling.remaining === 0

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{ceiling.label}</h3>
        <span
          className={`text-sm tabular-nums ${tight ? 'text-amber-700 dark:text-amber-400' : ''}`}
        >
          {formatCount(ceiling.remaining)} left of {formatCount(ceiling.limit)}
        </span>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full ${tight ? 'bg-amber-500' : 'bg-zinc-400 dark:bg-zinc-500'}`}
          style={{ width: `${spent}%` }}
        />
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-zinc-600 sm:grid-cols-2 dark:text-zinc-400">
        <div className="flex gap-2">
          <dt>Used</dt>
          <dd className="tabular-nums">{formatCount(ceiling.hits)}</dd>
        </div>
        <div className="flex gap-2">
          <dt>Window opened</dt>
          <dd className="tabular-nums">{formatDateTime(ceiling.windowStart)}</dd>
        </div>
        <div className="flex gap-2">
          <dt>Resets at</dt>
          <dd className="tabular-nums">{formatDateTime(ceiling.resetsAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt>Resets in</dt>
          <dd className="tabular-nums">{formatCountdown(ceiling.resetsAt, now)}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        {ceiling.note}
      </p>
    </div>
  )
}

/** An allowance cell: what was used, the ceiling, and what that leaves. */
function Allowance({
  used,
  ceiling,
  left,
}: {
  used: number
  ceiling: number | null
  left: number | null
}) {
  return (
    <div>
      <span className={`tabular-nums ${left === 0 ? 'text-amber-700 dark:text-amber-400' : ''}`}>
        {used} / {formatLimit(ceiling)}
      </span>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        {left === null ? 'no ceiling' : `${left} left`}
      </div>
    </div>
  )
}

function AccountTable({ rows }: { rows: AccountAllowance[] }) {
  return (
    <div className={TABLE_WRAP}>
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead className={THEAD}>
          <tr>
            <th className={TH}>Traveller</th>
            <th className={TH}>Plan</th>
            <th className={TH}>Planner turns</th>
            <th className={TH}>Itineraries</th>
            <th className={TH}>Allowance resets</th>
          </tr>
        </thead>
        <tbody className={TBODY}>
          {rows.map((row) => (
            <tr key={row.userId}>
              <td className={TD}>
                <div className="font-medium">{row.name}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{row.email}</div>
              </td>
              <td className={TD}>{row.planName}</td>
              <td className={TD}>
                <Allowance
                  used={row.aiPromptsUsed}
                  ceiling={row.aiPromptsPerPeriod}
                  left={row.promptsRemaining}
                />
              </td>
              <td className={TD}>
                <Allowance
                  used={row.itinerariesCreated}
                  ceiling={row.itinerariesPerPeriod}
                  left={row.itinerariesRemaining}
                />
              </td>
              <td className={`${TD} whitespace-nowrap`}>
                {formatDateTime(row.periodEnd)}
                {row.periodStale && (
                  <div className="text-xs text-amber-700 dark:text-amber-400">
                    counter is on an older window — a billing date moved
                  </div>
                )}
              </td>
            </tr>
          ))}

          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                No account has used any allowance in its current period.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export default async function AiUsagePage() {
  const admin = await readConsoleAdminWithRole(AI_USAGE_ROLES)
  if (admin === null) return <Locked />

  const now = new Date()
  const dayAgo = new Date(now.getTime() - DAY_MS)
  const monthAgo = new Date(now.getTime() - MONTH_MS)

  const [
    configuration,
    day,
    month,
    surfaces,
    failures,
    ceilings,
    addresses,
    accounts,
    anonymous,
    cache,
  ] = await Promise.all([
    readModelConfiguration(),
    usageByModel(dayAgo),
    usageByModel(monthAgo),
    usageBySurface(monthAgo),
    recentFailures(FAILURE_ROWS),
    siteCeilings(now),
    busiestAddressBuckets(ADDRESS_ROWS, now),
    accountAllowances(ACCOUNT_ROWS, now),
    anonymousSummary(now),
    cacheSummary(),
  ])

  const credentials = credentialPresence()
  const configured = credentials.filter((credential) => credential.configured)

  const monthCalls = month.reduce((total, row) => total + row.calls, 0)
  const monthTokens = month.reduce((total, row) => total + row.totalTokens, 0)
  const monthCached = month.reduce((total, row) => total + row.cached, 0)
  const monthFailed = month.reduce((total, row) => total + row.failed, 0)
  const unpriced = month.filter((row) => row.price === null).length

  // A lower bound, and labelled as one below. Summing the priced rows while
  // silently dropping the unpriced ones would present a number that is wrong in
  // a direction nobody checks, so the count of unpriced models travels with it.
  const monthCostMicro = month.reduce((total, row) => total + (row.estimatedCostMicroBdt ?? 0), 0)

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">AI usage and limits</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Every model call this product makes writes a row — including the ones that failed, the ones
        a quota refused, and the ones the cache answered for free. Cached and refused calls cost
        nothing and are counted separately everywhere they appear.
      </p>

      {/* ── Configuration ────────────────────────────────────────────────── */}

      <SectionHeading
        title="What is configured right now"
        blurb="The selection the next call will use. A settings row overrides env without a deploy, so the two are shown side by side — if they differ, an override is live."
      />

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          label="Conversational model"
          value={configuration.active.modelId}
          hint={`${configuration.active.provider} · from ${configuration.active.source}${
            configuration.active.modelId === configuration.fromEnv.modelId
              ? ''
              : ` · env says ${configuration.fromEnv.modelId}`
          }`}
        />
        <Card
          label="Schema-constrained model"
          value={configuration.cheap?.modelId ?? 'not set'}
          hint={
            configuration.cheap === null
              ? 'AI_MODEL_CHEAP is unset, so previews run on the conversational model.'
              : 'Used only where a JSON schema forces the output shape — the anonymous preview today.'
          }
        />
        <Card
          label="Anonymous previews"
          value={configuration.teaserEnabled ? 'Enabled' : 'Switched off'}
          tone={configuration.teaserEnabled ? 'plain' : 'warn'}
          hint="The ai.teaser.enabled kill switch. Off still serves the cache, because that costs nothing."
        />
        <Card
          label="Provider credentials"
          value={
            configured.length === 0
              ? 'none'
              : configured.map((credential) => credential.provider).join(', ')
          }
          hint="Which keys are present. Never which keys they are."
        />
      </div>

      {/* ── Spend ────────────────────────────────────────────────────────── */}

      <SectionHeading
        title="Spend, last 30 days"
        blurb="Cost is estimated from the token counts and the published per-million price. A model with no price on file reports “unpriced” rather than zero, so the total is a lower bound whenever any row is unpriced."
      />

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card label="Calls" value={formatCount(monthCalls)} />
        <Card label="Tokens" value={formatCount(monthTokens)} />
        <Card
          label="Served from cache"
          value={formatCount(monthCached)}
          tone={monthCached > 0 ? 'good' : 'plain'}
          hint="Model calls the cache made unnecessary."
        />
        <Card
          label="Failed"
          value={formatCount(monthFailed)}
          tone={monthFailed > 0 ? 'warn' : 'plain'}
          hint="Reached a provider and came back wrong. Usually still billed."
        />
        <Card
          label="Estimated cost"
          value={formatMicroBdt(monthCostMicro)}
          tone={unpriced > 0 ? 'warn' : 'plain'}
          hint={
            unpriced > 0
              ? `Lower bound — ${unpriced} model${unpriced === 1 ? '' : 's'} with no price on file.`
              : 'Every model in this window is priced.'
          }
        />
      </div>

      <SectionHeading
        title="Per model, last 24 hours"
        blurb="What is running now. In and Out are prompt and completion tokens; a cached or refused call contributes neither, by construction."
      />
      <ModelTable rows={day} caption="Model usage in the last 24 hours" />

      <SectionHeading
        title="Per model, last 30 days"
        blurb="The same breakdown across the billing window."
      />
      <ModelTable rows={month} caption="Model usage in the last 30 days" />

      <SectionHeading
        title="Per surface, last 30 days"
        blurb="Where the budget goes. TEASER is the only surface a stranger can reach without an account, which is why it carries two rate limits and a daily ceiling of its own."
      />

      <div className={TABLE_WRAP}>
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead className={THEAD}>
            <tr>
              <th className={TH}>Surface</th>
              <th className={TH}>Calls</th>
              <th className={TH}>OK</th>
              <th className={TH}>Failed</th>
              <th className={TH}>Refused</th>
              <th className={TH}>Cached</th>
              <th className={TH}>Tokens</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {surfaces.map((row) => (
              <tr key={row.surface}>
                <td className={`${TD} font-medium`}>{row.surface}</td>
                <td className={`${TD} tabular-nums`}>{formatCount(row.calls)}</td>
                <td className={`${TD} tabular-nums`}>{formatCount(row.succeeded)}</td>
                <td className={`${TD} tabular-nums`}>{formatCount(row.failed)}</td>
                <td className={`${TD} tabular-nums`}>{formatCount(row.refused)}</td>
                <td className={`${TD} tabular-nums`}>{formatCount(row.cached)}</td>
                <td className={`${TD} tabular-nums`}>{formatCount(row.totalTokens)}</td>
              </tr>
            ))}

            {surfaces.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  No model calls in the last 30 days.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Ceilings ─────────────────────────────────────────────────────── */}

      <SectionHeading
        title="Site-wide ceilings"
        blurb="Fixed windows, counted in Postgres so they hold across every instance rather than per process. These are the limits nobody can raise from a console — deliberately."
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {ceilings.map((ceiling) => (
          <CeilingCard key={ceiling.bucketKey} ceiling={ceiling} now={now} />
        ))}
      </div>

      <SectionHeading
        title="Busiest networks this hour"
        blurb="Per-address preview buckets. The keys are salted digests and never addresses — this table meters callers, it does not watch them. A digest near its limit means one network is looping."
      />

      <div className={TABLE_WRAP}>
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead className={THEAD}>
            <tr>
              <th className={TH}>Bucket</th>
              <th className={TH}>Used</th>
              <th className={TH}>Limit</th>
              <th className={TH}>Resets at</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {addresses.map((bucket) => (
              <tr key={bucket.bucketKey}>
                <td className={`${TD} font-mono text-xs`}>{bucket.bucketKey}</td>
                <td
                  className={`${TD} tabular-nums ${
                    bucket.hits >= bucket.limit ? 'text-amber-700 dark:text-amber-400' : ''
                  }`}
                >
                  {bucket.hits}
                </td>
                <td className={`${TD} tabular-nums`}>{bucket.limit}</td>
                <td className={`${TD} whitespace-nowrap`}>
                  {formatDateTime(bucket.resetsAt)}{' '}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    ({formatCountdown(bucket.resetsAt, now)})
                  </span>
                </td>
              </tr>
            ))}

            {addresses.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  No preview requests this hour.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Per account ──────────────────────────────────────────────────── */}

      <SectionHeading
        title="Account allowances"
        blurb={`The ${ACCOUNT_ROWS} accounts using the most of their current period, heaviest first. “Unlimited” means the plan has no ceiling on that counter — never the same thing as zero. The reset date is derived from the live subscription rather than from the counter row, so it is the date the allowance genuinely returns.`}
      />
      <AccountTable rows={accounts} />

      <SectionHeading
        title="Visitors and the cache"
        blurb="An anonymous visitor gets a fixed number of previews for the life of that visitor. There is no reset — that is the product rule, not a limit that expires."
      />

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card
          label="Previews per visitor"
          value={String(anonymous.promptLimit)}
          hint="Lifetime, not per period. Never resets."
        />
        <Card label="Visitors seen" value={formatCount(anonymous.visitors)} />
        <Card
          label="At their limit"
          value={formatCount(anonymous.visitorsAtLimit)}
          hint="Have used every preview they will get."
        />
        <Card
          label="Signed up afterwards"
          value={formatCount(anonymous.converted)}
          tone={anonymous.converted > 0 ? 'good' : 'plain'}
        />
        <Card
          label="Cache hits"
          value={formatCount(cache.hits)}
          tone={cache.hits > 0 ? 'good' : 'plain'}
          hint={`${formatCount(cache.entries)} entries; the busiest has answered ${formatCount(
            cache.hottestKeyHits
          )} times.`}
        />
      </div>

      {/* ── Failures ─────────────────────────────────────────────────────── */}

      <SectionHeading
        title="Recent failures"
        blurb="The error class only, never the message: provider errors quote the request back, and a traveller's words are not staff reading material. A run of AbortError means calls are hitting the wall clock."
      />

      <div className={TABLE_WRAP}>
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <thead className={THEAD}>
            <tr>
              <th className={TH}>When</th>
              <th className={TH}>Surface</th>
              <th className={TH}>Model</th>
              <th className={TH}>Error</th>
              <th className={TH}>Latency</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {failures.map((failure) => (
              <tr key={`${failure.createdAt.toISOString()}-${failure.model}-${failure.surface}`}>
                <td className={`${TD} whitespace-nowrap`}>{formatDateTime(failure.createdAt)}</td>
                <td className={TD}>{failure.surface}</td>
                <td className={TD}>
                  {failure.provider}/{failure.model}
                </td>
                <td className={`${TD} font-mono text-xs`}>{failure.errorKind ?? '—'}</td>
                <td className={`${TD} tabular-nums`}>
                  {failure.latencyMs === null ? '—' : `${failure.latencyMs} ms`}
                </td>
              </tr>
            ))}

            {failures.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  No failed model calls on record.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
