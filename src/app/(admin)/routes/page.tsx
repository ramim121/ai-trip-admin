import { listRoutes, PRICE_UNITS, TRANSPORT_MODES } from '@/server/modules/journey/routes'
import { Locked } from '../_components/locked'
import {
  CATALOG_READ_ROLES,
  CATALOG_WRITE_ROLES,
  readConsoleAdminWithRole,
} from '../_lib/console-session'
import { formatBdt } from '../_lib/format'
import { createRouteAction, deleteRouteAction, toggleRouteAction, updateRouteAction } from './actions'

/**
 * /routes — what we know a journey between two places costs.
 *
 * THE ONE PILLAR NO PROVIDER ANSWERS. Viator prices a tour, Google finds a
 * hotel, and nothing free and reliable knows what a minivan from Phuket to Krabi
 * costs on a Tuesday — which is the question a two-city trip asks three times.
 * These rows are the agency answering it once, and they are handed to the
 * transfer estimator as facts it may not contradict.
 *
 * EVERY ROW ADDED HERE PERMANENTLY IMPROVES EVERY PLAN THAT CROSSES IT. Worth
 * saying on the page, because a maintenance screen with no visible consequence
 * is a screen nobody maintains.
 *
 * Locations are lowercased on save. The form does not shout about it — somebody
 * types "Krabi" and should not be corrected mid-sentence — but the heading of
 * each row shows what was actually stored, because the lookup folds its input
 * and a row that does not match is a row silently never found.
 */

export const metadata = { title: 'Transfer routes · Beyond Borders' }

const inputClass =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600'

const labelClass =
  'block text-[0.7rem] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400'

const primaryButton =
  'rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300'

const secondaryButton =
  'rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'

/** `private_car` is a column value; "Private car" is what a person reads. */
function modeLabel(mode: string): string {
  return mode.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase())
}

function describeDuration(min: number, max: number): string {
  const render = (minutes: number) => {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    if (hours === 0) return `${rest}m`
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  }

  return min === max ? render(min) : `${render(min)} – ${render(max)}`
}

export default async function RoutesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(CATALOG_READ_ROLES)
  if (admin === null) return <Locked />

  // Read-only for anybody without the catalogue write role. The check inside
  // each action is what enforces this; disabling the fields only avoids offering
  // somebody a form that would refuse them.
  const canWrite = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)

  const query = await searchParams
  const done = typeof query.done === 'string' ? query.done : null
  const error = typeof query.error === 'string' ? query.error : null

  const routes = await listRoutes()
  const active = routes.filter((route) => route.isActive)

  return (
    <section className="pb-16">
      <h1 className="text-xl font-semibold tracking-tight">Transfer routes</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        What we know a journey between two places actually costs. Nothing else in the planner can
        answer this — every other suggestion comes from a provider, and no provider prices a minivan
        between two Thai towns. Each row turns a guess into a figure, for every plan that ever
        crosses that route.
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

      <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
        <span className="font-semibold">{active.length}</span>{' '}
        {active.length === 1 ? 'route is' : 'routes are'} in use
        {routes.length !== active.length && `, ${routes.length - active.length} retired`}.
      </p>

      {/* ── Add one ──────────────────────────────────────────────────────── */}

      {canWrite !== null && (
        <form
          action={createRouteAction}
          className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h2 className="text-sm font-semibold">Add a route</h2>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className={labelClass} htmlFor="new-from">
                From
              </label>
              <input
                id="new-from"
                name="fromLocation"
                required
                maxLength={80}
                className={inputClass}
                placeholder="Phuket"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="new-to">
                To
              </label>
              <input
                id="new-to"
                name="toLocation"
                required
                maxLength={80}
                className={inputClass}
                placeholder="Krabi"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="new-mode">
                How
              </label>
              <select id="new-mode" name="mode" className={inputClass} defaultValue="minivan">
                {TRANSPORT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {modeLabel(mode)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelClass} htmlFor="new-per">
                Priced per
              </label>
              <select id="new-per" name="pricePer" className={inputClass} defaultValue="person">
                {PRICE_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelClass} htmlFor="new-dmin">
                Fastest (minutes)
              </label>
              <input
                id="new-dmin"
                name="durationMinMinutes"
                type="number"
                min={1}
                max={1440}
                step={1}
                required
                className={`${inputClass} tabular-nums`}
                placeholder="150"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="new-dmax">
                Slowest (minutes)
              </label>
              <input
                id="new-dmax"
                name="durationMaxMinutes"
                type="number"
                min={1}
                max={1440}
                step={1}
                required
                className={`${inputClass} tabular-nums`}
                placeholder="210"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="new-pmin">
                Cheapest (BDT)
              </label>
              <input
                id="new-pmin"
                name="priceMinBdt"
                type="number"
                min={0}
                step={1}
                required
                className={`${inputClass} tabular-nums`}
                placeholder="1400"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="new-pmax">
                Dearest (BDT)
              </label>
              <input
                id="new-pmax"
                name="priceMaxBdt"
                type="number"
                min={0}
                step={1}
                required
                className={`${inputClass} tabular-nums`}
                placeholder="2200"
              />
            </div>
          </div>

          <div className="mt-3">
            <label className={labelClass} htmlFor="new-note">
              Anything a traveller should know
            </label>
            <input
              id="new-note"
              name="note"
              maxLength={300}
              className={inputClass}
              placeholder="Hotel pickup included; leaves twice a day."
            />
          </div>

          <div className="mt-3 flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked className="size-4" />
              In use
            </label>

            <button type="submit" className={primaryButton}>
              Add route
            </button>
          </div>
        </form>
      )}

      {/* ── The table ────────────────────────────────────────────────────── */}

      {routes.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          No routes yet. Until one exists, every transfer in every plan is the model&rsquo;s own
          guess, badged as an estimate.
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {routes.map((route) => (
            <form
              key={route.id}
              action={updateRouteAction}
              className={`rounded-lg border p-4 ${
                route.isActive
                  ? 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
                  : 'border-dashed border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950'
              }`}
            >
              <input type="hidden" name="id" value={route.id} />

              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-semibold">
                  {route.fromLocation} → {route.toLocation}
                </h3>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {modeLabel(route.mode)} ·{' '}
                  {describeDuration(route.durationMinMinutes, route.durationMaxMinutes)} ·{' '}
                  {formatBdt(route.priceMinBdt)}–{formatBdt(route.priceMaxBdt)} per {route.pricePer}
                </span>
                {!route.isActive && (
                  <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-[0.65rem] text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                    retired
                  </span>
                )}
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className={labelClass} htmlFor={`from-${route.id}`}>
                    From
                  </label>
                  <input
                    id={`from-${route.id}`}
                    name="fromLocation"
                    defaultValue={route.fromLocation}
                    disabled={canWrite === null}
                    required
                    maxLength={80}
                    className={inputClass}
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor={`to-${route.id}`}>
                    To
                  </label>
                  <input
                    id={`to-${route.id}`}
                    name="toLocation"
                    defaultValue={route.toLocation}
                    disabled={canWrite === null}
                    required
                    maxLength={80}
                    className={inputClass}
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor={`mode-${route.id}`}>
                    How
                  </label>
                  <select
                    id={`mode-${route.id}`}
                    name="mode"
                    defaultValue={route.mode}
                    disabled={canWrite === null}
                    className={inputClass}
                  >
                    {TRANSPORT_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {modeLabel(mode)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={labelClass} htmlFor={`per-${route.id}`}>
                    Priced per
                  </label>
                  <select
                    id={`per-${route.id}`}
                    name="pricePer"
                    defaultValue={route.pricePer}
                    disabled={canWrite === null}
                    className={inputClass}
                  >
                    {PRICE_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={labelClass} htmlFor={`dmin-${route.id}`}>
                    Fastest (minutes)
                  </label>
                  <input
                    id={`dmin-${route.id}`}
                    name="durationMinMinutes"
                    type="number"
                    min={1}
                    max={1440}
                    step={1}
                    defaultValue={route.durationMinMinutes}
                    disabled={canWrite === null}
                    required
                    className={`${inputClass} tabular-nums`}
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor={`dmax-${route.id}`}>
                    Slowest (minutes)
                  </label>
                  <input
                    id={`dmax-${route.id}`}
                    name="durationMaxMinutes"
                    type="number"
                    min={1}
                    max={1440}
                    step={1}
                    defaultValue={route.durationMaxMinutes}
                    disabled={canWrite === null}
                    required
                    className={`${inputClass} tabular-nums`}
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor={`pmin-${route.id}`}>
                    Cheapest (BDT)
                  </label>
                  <input
                    id={`pmin-${route.id}`}
                    name="priceMinBdt"
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={route.priceMinBdt}
                    disabled={canWrite === null}
                    required
                    className={`${inputClass} tabular-nums`}
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor={`pmax-${route.id}`}>
                    Dearest (BDT)
                  </label>
                  <input
                    id={`pmax-${route.id}`}
                    name="priceMaxBdt"
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={route.priceMaxBdt}
                    disabled={canWrite === null}
                    required
                    className={`${inputClass} tabular-nums`}
                  />
                </div>
              </div>

              <div className="mt-3">
                <label className={labelClass} htmlFor={`note-${route.id}`}>
                  Anything a traveller should know
                </label>
                <input
                  id={`note-${route.id}`}
                  name="note"
                  defaultValue={route.note ?? ''}
                  disabled={canWrite === null}
                  maxLength={300}
                  className={inputClass}
                />
              </div>

              {canWrite !== null && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="isActive"
                      defaultChecked={route.isActive}
                      className="size-4"
                    />
                    In use
                  </label>

                  <button type="submit" className={primaryButton}>
                    Save
                  </button>

                  {/* Retire and delete are further submits on the same form,
                      because HTML forbids nesting one form inside another. The
                      DESIRED state travels with the button, so a double click
                      cannot flip it back — and it is named `desiredActive`
                      rather than `isActive` so it cannot collide with the
                      checkbox above and resolve by DOM order. */}
                  <button
                    type="submit"
                    formAction={toggleRouteAction}
                    name="desiredActive"
                    value={route.isActive ? 'false' : 'true'}
                    className={secondaryButton}
                  >
                    {route.isActive ? 'Retire' : 'Put back in use'}
                  </button>

                  <button
                    type="submit"
                    formAction={deleteRouteAction}
                    className="text-sm text-red-700 underline-offset-4 hover:underline dark:text-red-400"
                  >
                    Delete
                  </button>

                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    Retiring keeps the row explicable for quotes already priced against it. Delete is
                    for a row typed wrong.
                  </span>
                </div>
              )}
            </form>
          ))}
        </div>
      )}
    </section>
  )
}
