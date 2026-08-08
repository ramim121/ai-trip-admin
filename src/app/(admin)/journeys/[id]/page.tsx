import Link from 'next/link'
import { QuoteStatus } from '@/generated/prisma/enums'
import { readJourneyForPricing, readQuoteStateForJourney } from '@/server/modules/journey/quotation'
import { summariseBudget } from '@/server/modules/journey/service'
import { Locked } from '../../_components/locked'
import {
  COMMERCE_READ_ROLES,
  QUOTE_WRITE_ROLES,
  readConsoleAdminWithRole,
} from '../../_lib/console-session'
import { formatBdt, formatDateTime } from '../../_lib/format'
import {
  addLineAction,
  openDraftAction,
  removeLineAction,
  saveTermsAction,
  sendQuoteAction,
  updateLineAction,
  withdrawQuoteAction,
} from '../actions'

/**
 * /journeys/[id] — what they planned, beside what it costs.
 *
 * THE TWO COLUMNS ARE THE PRODUCT. On the left is everything the traveller
 * decided and, under each item, what they said they wanted. On the right is one
 * editable line: a real vendor and a real price. Ops reading only the left can
 * price what was chosen; ops reading both can put somebody in a better hotel and
 * say why, because the brief is right there saying "3-star plus, pool, quiet end
 * of Patong, 4-6k a night".
 *
 * That pairing is the reason a `PreferenceBrief` survives its own pick, and this
 * screen is where that decision pays for itself.
 *
 * NOTHING IS TYPED TWICE. The subtotal is the sum of the lines, recomputed on
 * every save — there is no subtotal field that can disagree with the breakdown.
 * The traveller's own estimate sits beside each line, so a figure wildly out is
 * visible without opening anything.
 *
 * NO CLIENT JAVASCRIPT, like the rest of this console. Each line is its own form
 * with two submit buttons — save, and remove via `formAction` — because HTML
 * forbids nesting a form inside a form and a script to work around that would be
 * the first one on the page.
 */

export const metadata = { title: 'Pricing a plan · Beyond Borders' }

const SLOT_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  AFTERNOON: 'Afternoon',
  EVENING: 'Evening',
}

const TYPE_LABEL: Record<string, string> = {
  ACTIVITY: 'Activity',
  STAY: 'Stay',
  FOOD: 'Food',
  TRANSFER: 'Transfer',
}

const PILLAR_LABEL: Record<string, string> = {
  STAY: 'Stay',
  ACTIVITY: 'Things to do',
  FOOD: 'Food',
  TRANSPORT: 'Transport',
}

const inputClass =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600'

const labelClass =
  'block text-[0.7rem] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400'

const chipClass =
  'inline-flex items-center rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 dark:border-zinc-700 dark:text-zinc-300'

const primaryButton =
  'rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300'

const secondaryButton =
  'rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'

/**
 * What the brief actually constrains, as chips.
 *
 * The JSON is written by a model against a fixed schema, but it is still JSON in
 * a column: every field is read defensively, because a brief stored under an
 * older schema version has to render rather than throw. An unrecognised shape
 * produces no chips, which is the right failure — a missing chip is a far
 * smaller problem than a pricing screen that will not load.
 */
function constraintChips(constraints: unknown): string[] {
  if (constraints === null || typeof constraints !== 'object') return []

  const value = constraints as Record<string, unknown>
  const chips: string[] = []

  if (typeof value.starMin === 'number') chips.push(`${value.starMin}★ and up`)

  const min = typeof value.budgetPerNightMinBdt === 'number' ? value.budgetPerNightMinBdt : null
  const max = typeof value.budgetPerNightMaxBdt === 'number' ? value.budgetPerNightMaxBdt : null

  if (min !== null || max !== null) {
    chips.push(
      min !== null && max !== null
        ? `${formatBdt(min)}–${formatBdt(max)} a night`
        : min !== null
          ? `${formatBdt(min)}+ a night`
          : `up to ${formatBdt(max ?? 0)} a night`
    )
  }

  for (const key of ['locationHints', 'amenities', 'notes']) {
    const list = value[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) if (typeof entry === 'string' && entry !== '') chips.push(entry)
  }

  return chips
}

/** The traveller's own band for one item, in the unit they were shown. */
function describeEstimate(
  min: number | null,
  max: number | null,
  per: string | null
): string | null {
  if (min === null && max === null) return null

  const unit = per === null || per === 'trip' ? '' : ` per ${per}`
  if (min === null) return `up to ${formatBdt(max ?? 0)}${unit}`
  if (max === null) return `${formatBdt(min)}+${unit}`
  if (min === max) return `${formatBdt(min)}${unit}`

  return `${formatBdt(min)}–${formatBdt(max)}${unit}`
}

/**
 * `<input type="date">` wants `YYYY-MM-DD`, and it has to be Dhaka's date.
 *
 * `validUntil` is stored as the end of a Dhaka day, which in UTC is the
 * afternoon of that same day — slicing the raw ISO string happens to work, but
 * only by luck of the +06:00 offset. Shifting first makes it correct by
 * construction rather than by coincidence.
 */
function toDateInput(value: Date | null): string {
  if (value === null) return ''
  return new Date(value.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export default async function JourneyPricingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const { id } = await params
  const query = await searchParams
  const done = typeof query.done === 'string' ? query.done : null
  const error = typeof query.error === 'string' ? query.error : null

  const journey = await readJourneyForPricing(id)
  const state = await readQuoteStateForJourney(id)

  // Read-only for anybody without the write role. The role check inside each
  // action is what actually enforces this; hiding the controls only avoids
  // offering somebody a form that would refuse them.
  const canWrite = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)

  const budget = summariseBudget(journey, journey.items)
  const draft = state?.latest ?? null
  const isDraft = draft !== null && draft.sentAt === null
  const editable = canWrite !== null && isDraft

  const linesByItem = new Map(
    (draft?.lines ?? [])
      .filter((line) => line.journeyItemId !== null)
      .map((line) => [line.journeyItemId, line])
  )
  const extras = (draft?.lines ?? []).filter((line) => line.journeyItemId === null)

  const days = Array.from({ length: journey.durationDays }, (_, index) => index + 1).filter((day) =>
    journey.items.some((item) => item.dayNumber === day)
  )

  const unpricedLines = (draft?.lines ?? []).filter((line) => line.priceBdt === 0)
  const unquoted = draft === null ? [] : journey.items.filter((item) => !linesByItem.has(item.id))
  const orphanBriefs = journey.briefs.filter((brief) => brief._count.items === 0)

  const party = journey.partyAdults + journey.partyChildren

  return (
    <section className="pb-16">
      <Link
        href="/journeys"
        className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
      >
        ← All plan quotes
      </Link>

      <h1 className="mt-2 text-xl font-semibold tracking-tight">
        {journey.title ?? journey.destinations.join(', ')}
      </h1>

      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {journey.destinations.join(' → ')} · {journey.durationDays}{' '}
        {journey.durationDays === 1 ? 'day' : 'days'} · {party}{' '}
        {party === 1 ? 'traveller' : 'travellers'}
        {journey.partyChildren > 0 && ` (${journey.partyChildren} under 12)`}
        {journey.startDate !== null && ` · from ${journey.startDate.toISOString().slice(0, 10)}`}
      </p>

      {done !== null && (
        <p className="mt-3 max-w-prose rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {done}
        </p>
      )}

      {error !== null && (
        <p className="mt-3 max-w-prose rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {/* ── Who is asking, and what they told us ─────────────────────────── */}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold">Traveller</h2>
          <div className="mt-1 text-sm">
            {journey.user === null ? (
              <span className="text-zinc-500 italic dark:text-zinc-400">account removed</span>
            ) : (
              <>
                <div>{journey.user.name ?? 'No name given'}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{journey.user.email}</div>
              </>
            )}
          </div>
          {journey.contactWhatsapp !== null && (
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              WhatsApp <span className="font-medium">{journey.contactWhatsapp}</span>
            </p>
          )}
          {journey.contactPreferredTime !== null && (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Best time: {journey.contactPreferredTime}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold">Their budget</h2>
          <p className="mt-1 text-sm tabular-nums">
            {journey.budgetMinBdt === null && journey.budgetMaxBdt === null
              ? 'Not stated'
              : journey.budgetMinBdt !== null && journey.budgetMaxBdt !== null
                ? `${formatBdt(journey.budgetMinBdt)} – ${formatBdt(journey.budgetMaxBdt)}`
                : journey.budgetMinBdt !== null
                  ? `${formatBdt(journey.budgetMinBdt)}+`
                  : `up to ${formatBdt(journey.budgetMaxBdt ?? 0)}`}
          </p>
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
            Their own estimates came to{' '}
            <span className="font-medium tabular-nums">
              {formatBdt(budget.estimatedMinBdt)}–{formatBdt(budget.estimatedMaxBdt)}
            </span>
            {budget.overBudget && (
              <span className="ml-1 font-medium text-amber-700 dark:text-amber-400">
                — already over their ceiling.
              </span>
            )}
          </p>
          {budget.unpricedItems > 0 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {budget.unpricedItems} {budget.unpricedItems === 1 ? 'item carries' : 'items carry'} no
              estimate at all.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold">How they asked</h2>
          {journey.rawIntake === null ? (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Built without a typed brief.
            </p>
          ) : (
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              &ldquo;{journey.rawIntake}&rdquo;
            </p>
          )}
          {state !== null && state.quote.travellerNote !== null && (
            <p className="mt-2 border-t border-zinc-200 pt-2 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">With the request:</span>{' '}
              {state.quote.travellerNote}
            </p>
          )}
        </div>
      </div>

      {/* ── The state of the conversation ────────────────────────────────── */}

      {state === null ? (
        <p className="mt-6 rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          Nobody has asked us to price this plan. It is here so you can read it, not quote it.
        </p>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            <span className="text-sm">
              Quote is <span className="font-semibold">{state.quote.status.toLowerCase()}</span>
              {draft !== null && (
                <>
                  {' '}
                  · version {draft.version}
                  {draft.sentAt === null ? (
                    <span className="text-amber-700 dark:text-amber-400"> · draft, not sent</span>
                  ) : (
                    <span className="text-emerald-700 dark:text-emerald-400">
                      {' '}
                      · sent {formatDateTime(draft.sentAt)}
                    </span>
                  )}
                </>
              )}
            </span>

            <span className="grow" />

            {canWrite !== null && !isDraft && state.quote.status !== QuoteStatus.ACCEPTED && (
              <form action={openDraftAction}>
                <input type="hidden" name="journeyId" value={journey.id} />
                <input type="hidden" name="quoteId" value={state.quote.id} />
                <button type="submit" className={primaryButton}>
                  {draft === null ? 'Start pricing' : `Start version ${draft.version + 1}`}
                </button>
              </form>
            )}

            {canWrite !== null && state.quote.status !== QuoteStatus.ACCEPTED && (
              <form action={withdrawQuoteAction}>
                <input type="hidden" name="journeyId" value={journey.id} />
                <input type="hidden" name="quoteId" value={state.quote.id} />
                <button type="submit" className={secondaryButton}>
                  Withdraw
                </button>
              </form>
            )}
          </div>

          {draft === null && (
            <p className="mt-4 rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              Nothing drafted yet. Starting a draft fills the right-hand column with one line per
              planned item, at the traveller&rsquo;s own estimate, for you to correct.
            </p>
          )}
        </>
      )}

      {/* ── The comparison ───────────────────────────────────────────────── */}

      {draft !== null && (
        <>
          {isDraft && unpricedLines.length > 0 && (
            <p className="mt-6 max-w-prose rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
              <span className="font-semibold">{unpricedLines.length}</span>{' '}
              {unpricedLines.length === 1 ? 'line is' : 'lines are'} still at zero — there was no
              estimate to start them from.
            </p>
          )}

          {isDraft && unquoted.length > 0 && (
            <p className="mt-3 max-w-prose rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              <span className="font-semibold">{unquoted.length}</span>{' '}
              {unquoted.length === 1 ? 'planned item has' : 'planned items have'} no line. The
              traveller will see they were not quoted for.
            </p>
          )}

          <div className="mt-6 hidden grid-cols-2 gap-4 px-1 text-xs font-medium tracking-wide text-zinc-500 uppercase lg:grid dark:text-zinc-400">
            <div>What they planned</div>
            <div>What it costs</div>
          </div>

          {days.map((day) => (
            <div key={day} className="mt-4">
              <h2 className="text-sm font-semibold tracking-tight">Day {day}</h2>

              <div className="mt-2 space-y-3">
                {journey.items
                  .filter((item) => item.dayNumber === day)
                  .map((item) => {
                    const line = linesByItem.get(item.id) ?? null
                    const estimate = describeEstimate(
                      item.estPriceMinBdt,
                      item.estPriceMaxBdt,
                      item.estPricePer
                    )
                    const chips = item.brief === null ? [] : constraintChips(item.brief.constraints)

                    return (
                      <div
                        key={item.id}
                        className="grid gap-4 rounded-lg border border-zinc-200 bg-white p-4 lg:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-900"
                      >
                        {/* ── Their side ──────────────────────────────── */}
                        <div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                            <span>{SLOT_LABEL[item.slot] ?? item.slot}</span>
                            <span>·</span>
                            <span>{TYPE_LABEL[item.type] ?? item.type}</span>
                            {item.locationName !== null && (
                              <>
                                <span>·</span>
                                <span>{item.locationName}</span>
                              </>
                            )}
                            {/* An item the traveller pinned is a requirement. One
                                we suggested is a starting point they merely did
                                not object to, and quoting the two the same way is
                                how you replace the thing they cared about. */}
                            {item.origin === 'USER_PINNED' && (
                              <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[0.65rem] font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                                They chose this
                              </span>
                            )}
                          </div>

                          <p className="mt-1 font-medium">{item.title}</p>

                          {item.description !== null && (
                            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                              {item.description}
                            </p>
                          )}

                          <p className="mt-2 text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                            {estimate === null ? (
                              <span className="italic">They saw no estimate for this.</span>
                            ) : (
                              <>
                                Their estimate: <span className="font-medium">{estimate}</span>
                                {item.estPricePer === 'person' && party > 1 && (
                                  <span className="text-zinc-500 dark:text-zinc-500">
                                    {' '}
                                    (× {party})
                                  </span>
                                )}
                              </>
                            )}
                          </p>

                          {item.matchReason !== null && (
                            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              Shown to them as: &ldquo;{item.matchReason}&rdquo;
                            </p>
                          )}

                          {item.brief !== null && (
                            <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-950">
                              <p className="text-[0.7rem] font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                                What they asked for · {PILLAR_LABEL[item.brief.pillar] ?? ''} in{' '}
                                {item.brief.location}
                              </p>
                              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
                                {item.brief.summary}
                              </p>
                              {chips.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {chips.map((chip) => (
                                    <span key={chip} className={chipClass}>
                                      {chip}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* ── Our side ────────────────────────────────── */}
                        <div className="lg:border-l lg:border-zinc-200 lg:pl-4 dark:lg:border-zinc-800">
                          {line === null ? (
                            editable ? (
                              <form action={addLineAction} className="space-y-2">
                                <input type="hidden" name="journeyId" value={journey.id} />
                                <input type="hidden" name="revisionId" value={draft.id} />
                                <input type="hidden" name="journeyItemId" value={item.id} />
                                <input type="hidden" name="label" value={item.title} />
                                <input
                                  type="hidden"
                                  name="detail"
                                  value={
                                    item.locationName === null
                                      ? `Day ${item.dayNumber}`
                                      : `Day ${item.dayNumber} - ${item.locationName}`
                                  }
                                />
                                <input type="hidden" name="quantity" value={1} />

                                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                                  Not quoted for. The traveller will see this line empty.
                                </p>

                                <div className="grid gap-2 sm:grid-cols-2">
                                  <div>
                                    <label className={labelClass} htmlFor={`add-v-${item.id}`}>
                                      Vendor
                                    </label>
                                    <input
                                      id={`add-v-${item.id}`}
                                      name="vendorName"
                                      className={inputClass}
                                      placeholder="Who supplies it"
                                    />
                                  </div>
                                  <div>
                                    <label className={labelClass} htmlFor={`add-p-${item.id}`}>
                                      Price (BDT)
                                    </label>
                                    <input
                                      id={`add-p-${item.id}`}
                                      name="priceBdt"
                                      type="number"
                                      min={0}
                                      step={1}
                                      defaultValue={0}
                                      className={`${inputClass} tabular-nums`}
                                    />
                                  </div>
                                </div>

                                <button type="submit" className={secondaryButton}>
                                  Put a line back
                                </button>
                              </form>
                            ) : (
                              <p className="text-sm text-zinc-500 italic dark:text-zinc-400">
                                Not quoted for.
                              </p>
                            )
                          ) : (
                            <form action={updateLineAction} className="space-y-2">
                              <input type="hidden" name="journeyId" value={journey.id} />
                              <input type="hidden" name="revisionId" value={draft.id} />
                              <input type="hidden" name="lineId" value={line.id} />

                              <div className="grid gap-2 sm:grid-cols-2">
                                <div>
                                  <label className={labelClass} htmlFor={`vendor-${line.id}`}>
                                    Vendor
                                  </label>
                                  <input
                                    id={`vendor-${line.id}`}
                                    name="vendorName"
                                    defaultValue={line.vendorName ?? ''}
                                    disabled={!editable}
                                    className={inputClass}
                                    placeholder="Which hotel, which operator"
                                  />
                                </div>

                                <div>
                                  <label className={labelClass} htmlFor={`label-${line.id}`}>
                                    Line
                                  </label>
                                  <input
                                    id={`label-${line.id}`}
                                    name="label"
                                    defaultValue={line.label}
                                    disabled={!editable}
                                    required
                                    className={inputClass}
                                  />
                                </div>
                              </div>

                              <div>
                                <label className={labelClass} htmlFor={`detail-${line.id}`}>
                                  Detail
                                </label>
                                <input
                                  id={`detail-${line.id}`}
                                  name="detail"
                                  defaultValue={line.detail ?? ''}
                                  disabled={!editable}
                                  className={inputClass}
                                  placeholder="Room type, what is included, pickup"
                                />
                              </div>

                              <div className="grid gap-2 sm:grid-cols-[1fr_6rem]">
                                <div>
                                  <label className={labelClass} htmlFor={`price-${line.id}`}>
                                    Price (BDT, whole party)
                                  </label>
                                  <input
                                    id={`price-${line.id}`}
                                    name="priceBdt"
                                    type="number"
                                    min={0}
                                    step={1}
                                    defaultValue={line.priceBdt}
                                    disabled={!editable}
                                    required
                                    className={`${inputClass} tabular-nums`}
                                  />
                                </div>
                                <div>
                                  <label className={labelClass} htmlFor={`qty-${line.id}`}>
                                    Nights / qty
                                  </label>
                                  <input
                                    id={`qty-${line.id}`}
                                    name="quantity"
                                    type="number"
                                    min={1}
                                    max={999}
                                    step={1}
                                    defaultValue={line.quantity}
                                    disabled={!editable}
                                    className={`${inputClass} tabular-nums`}
                                  />
                                </div>
                              </div>

                              <p className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                                Line total{' '}
                                <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                                  {formatBdt(line.priceBdt * line.quantity)}
                                </span>
                                {line.priceBdt === 0 && (
                                  <span className="ml-2 text-amber-700 dark:text-amber-400">
                                    not priced yet
                                  </span>
                                )}
                              </p>

                              {editable && (
                                <div className="flex gap-2">
                                  <button type="submit" className={primaryButton}>
                                    Save line
                                  </button>
                                  {/* A second submit on the same form rather than
                                      a nested one, which HTML forbids. */}
                                  <button
                                    type="submit"
                                    formAction={removeLineAction}
                                    className={secondaryButton}
                                  >
                                    Not quoting this
                                  </button>
                                </div>
                              )}
                            </form>
                          )}
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          ))}

          {/* ── Briefs nobody picked against ──────────────────────────── */}

          {orphanBriefs.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold tracking-tight">Asked for, never chosen</h2>
              <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
                They told us what they wanted here and never picked anything. Worth quoting for —
                add it below and it appears as something we suggested.
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {orphanBriefs.map((brief) => (
                  <div
                    key={brief.id}
                    className="rounded-lg border border-dashed border-zinc-300 p-3 dark:border-zinc-700"
                  >
                    <p className="text-[0.7rem] font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                      {PILLAR_LABEL[brief.pillar] ?? brief.pillar} in {brief.location}
                    </p>
                    <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{brief.summary}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {constraintChips(brief.constraints).map((chip) => (
                        <span key={chip} className={chipClass}>
                          {chip}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Extras ────────────────────────────────────────────────── */}

          <div className="mt-8">
            <h2 className="text-sm font-semibold tracking-tight">Added by us</h2>
            <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
              Anything the plan does not contain — visas, airport transfers, insurance, the service
              fee.
            </p>

            <div className="mt-3 space-y-3">
              {extras.map((line) => (
                <form
                  key={line.id}
                  action={updateLineAction}
                  className="grid gap-2 rounded-lg border border-zinc-200 bg-white p-3 sm:grid-cols-[1fr_1fr_8rem_5rem_auto] sm:items-end dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <input type="hidden" name="journeyId" value={journey.id} />
                  <input type="hidden" name="revisionId" value={draft.id} />
                  <input type="hidden" name="lineId" value={line.id} />
                  <input type="hidden" name="detail" value={line.detail ?? ''} />

                  <div>
                    <label className={labelClass} htmlFor={`x-label-${line.id}`}>
                      Line
                    </label>
                    <input
                      id={`x-label-${line.id}`}
                      name="label"
                      defaultValue={line.label}
                      disabled={!editable}
                      required
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass} htmlFor={`x-vendor-${line.id}`}>
                      Vendor
                    </label>
                    <input
                      id={`x-vendor-${line.id}`}
                      name="vendorName"
                      defaultValue={line.vendorName ?? ''}
                      disabled={!editable}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass} htmlFor={`x-price-${line.id}`}>
                      Price (BDT)
                    </label>
                    <input
                      id={`x-price-${line.id}`}
                      name="priceBdt"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={line.priceBdt}
                      disabled={!editable}
                      required
                      className={`${inputClass} tabular-nums`}
                    />
                  </div>

                  <div>
                    <label className={labelClass} htmlFor={`x-qty-${line.id}`}>
                      Qty
                    </label>
                    <input
                      id={`x-qty-${line.id}`}
                      name="quantity"
                      type="number"
                      min={1}
                      max={999}
                      step={1}
                      defaultValue={line.quantity}
                      disabled={!editable}
                      className={`${inputClass} tabular-nums`}
                    />
                  </div>

                  {editable && (
                    <div className="flex gap-2">
                      <button type="submit" className={primaryButton}>
                        Save
                      </button>
                      <button
                        type="submit"
                        formAction={removeLineAction}
                        className={secondaryButton}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </form>
              ))}

              {extras.length === 0 && !editable && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Nothing added.</p>
              )}

              {editable && (
                <form
                  action={addLineAction}
                  className="grid gap-2 rounded-lg border border-dashed border-zinc-300 p-3 sm:grid-cols-[1fr_1fr_8rem_5rem_auto] sm:items-end dark:border-zinc-700"
                >
                  <input type="hidden" name="journeyId" value={journey.id} />
                  <input type="hidden" name="revisionId" value={draft.id} />
                  {/* Empty means nothing planned lies behind this, which is what
                      puts the row in this section rather than beside a day. */}
                  <input type="hidden" name="journeyItemId" value="" />
                  <input type="hidden" name="detail" value="" />

                  <div>
                    <label className={labelClass} htmlFor="new-label">
                      Line
                    </label>
                    <input
                      id="new-label"
                      name="label"
                      required
                      className={inputClass}
                      placeholder="Visa processing"
                    />
                  </div>

                  <div>
                    <label className={labelClass} htmlFor="new-vendor">
                      Vendor
                    </label>
                    <input id="new-vendor" name="vendorName" className={inputClass} />
                  </div>

                  <div>
                    <label className={labelClass} htmlFor="new-price">
                      Price (BDT)
                    </label>
                    <input
                      id="new-price"
                      name="priceBdt"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={0}
                      required
                      className={`${inputClass} tabular-nums`}
                    />
                  </div>

                  <div>
                    <label className={labelClass} htmlFor="new-qty">
                      Qty
                    </label>
                    <input
                      id="new-qty"
                      name="quantity"
                      type="number"
                      min={1}
                      max={999}
                      step={1}
                      defaultValue={party}
                      className={`${inputClass} tabular-nums`}
                    />
                  </div>

                  <button type="submit" className={secondaryButton}>
                    Add
                  </button>
                </form>
              )}
            </div>
          </div>

          {/* ── Terms, and the number ─────────────────────────────────── */}

          <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_20rem]">
            <form
              action={saveTermsAction}
              className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <input type="hidden" name="journeyId" value={journey.id} />
              <input type="hidden" name="revisionId" value={draft.id} />

              <h2 className="text-sm font-semibold">Terms</h2>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="inclusions">
                    Included — one per line
                  </label>
                  <textarea
                    id="inclusions"
                    name="inclusions"
                    rows={4}
                    defaultValue={draft.inclusions.join('\n')}
                    disabled={!editable}
                    className={inputClass}
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor="exclusions">
                    Not included — one per line
                  </label>
                  <textarea
                    id="exclusions"
                    name="exclusions"
                    rows={4}
                    defaultValue={draft.exclusions.join('\n')}
                    disabled={!editable}
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label className={labelClass} htmlFor="travellerMessage">
                  A note to them
                </label>
                <textarea
                  id="travellerMessage"
                  name="travellerMessage"
                  rows={3}
                  defaultValue={draft.travellerMessage ?? ''}
                  disabled={!editable}
                  className={inputClass}
                  placeholder="Why you swapped the hotel, what you would change, what to book first."
                />
              </div>

              <div>
                <label className={labelClass} htmlFor="terms">
                  Payment and cancellation terms
                </label>
                <textarea
                  id="terms"
                  name="terms"
                  rows={3}
                  defaultValue={draft.terms ?? ''}
                  disabled={!editable}
                  className={inputClass}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="discountBdt">
                    Discount (BDT)
                  </label>
                  <input
                    id="discountBdt"
                    name="discountBdt"
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={draft.discountBdt}
                    disabled={!editable}
                    className={`${inputClass} tabular-nums`}
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor="validUntil">
                    Held until
                  </label>
                  <input
                    id="validUntil"
                    name="validUntil"
                    type="date"
                    defaultValue={toDateInput(draft.validUntil)}
                    disabled={!editable}
                    className={inputClass}
                  />
                </div>
              </div>

              {editable && (
                <button type="submit" className={primaryButton}>
                  Save terms
                </button>
              )}
            </form>

            <div className="h-fit rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-sm font-semibold">The number</h2>

              <dl className="mt-3 space-y-1.5 text-sm tabular-nums">
                <div className="flex justify-between">
                  <dt className="text-zinc-600 dark:text-zinc-400">Their estimate</dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">
                    {formatBdt(budget.estimatedMaxBdt)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-600 dark:text-zinc-400">
                    Our lines ({draft.lines.length})
                  </dt>
                  <dd>{formatBdt(draft.subtotalBdt)}</dd>
                </div>
                {draft.discountBdt > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-zinc-600 dark:text-zinc-400">Discount</dt>
                    <dd>−{formatBdt(draft.discountBdt)}</dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-zinc-200 pt-1.5 font-semibold dark:border-zinc-800">
                  <dt>Total</dt>
                  <dd>{formatBdt(draft.totalBdt)}</dd>
                </div>
                {party > 1 && (
                  <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
                    <dt>Per traveller</dt>
                    <dd>{formatBdt(Math.round(draft.totalBdt / party))}</dd>
                  </div>
                )}
              </dl>

              {journey.budgetMaxBdt !== null && draft.totalBdt > journey.budgetMaxBdt && (
                <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
                  {formatBdt(draft.totalBdt - journey.budgetMaxBdt)} over the ceiling they gave.
                  Worth a sentence in the note.
                </p>
              )}

              {editable && state !== null && (
                <form action={sendQuoteAction} className="mt-4">
                  <input type="hidden" name="journeyId" value={journey.id} />
                  <input type="hidden" name="quoteId" value={state.quote.id} />
                  <button
                    type="submit"
                    className="w-full rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600"
                  >
                    Send version {draft.version}
                  </button>
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    Sending freezes every line on this version. A correction after that is a new
                    version, not an edit.
                  </p>
                </form>
              )}
            </div>
          </div>

          {/* ── What they have already been shown ─────────────────────── */}

          {state !== null && state.history.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold tracking-tight">Already sent</h2>
              <ul className="mt-2 space-y-1 text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                {state.history.map((revision) => (
                  <li key={revision.id}>
                    Version {revision.version} · {formatBdt(revision.totalBdt)} ·{' '}
                    {formatDateTime(revision.sentAt)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
