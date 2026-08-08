import { db } from '@/lib/db'
import { badRequest, conflict, notFound } from '@/server/http/errors'

/**
 * The routes this agency has actually sold.
 *
 * WHY A CURATED TABLE EXISTS AT ALL. Every other pillar has a provider behind
 * it: Viator knows what a tour costs, Google knows a hotel is there. Nothing
 * free and reliable knows what a minivan from Phuket to Krabi costs on a
 * Tuesday, and that is exactly the question a two-city trip asks three times.
 * So the agency answers it once, here, and the model is handed these rows as
 * facts it may not contradict.
 *
 * WHERE THERE IS NO ROW, THE ESTIMATE SAYS SO. The transfer estimator falls back
 * to the model's own judgement and the interface badges the difference, because
 * "we have sold this and it costs 1,800 taka" and "this is probably about right"
 * are different claims and a traveller is owed the distinction.
 *
 * LOCATIONS ARE CASE-FOLDED ON WRITE, and a CHECK constraint enforces it. Rows
 * for "Krabi" and "krabi" are two answers to one question, and the lookup folds
 * its input — so an unfolded row would simply never be found. That is the worst
 * kind of wrong: silent, and only visible as an estimate that inexplicably
 * ignores the table.
 */

/** What we can actually describe a journey by. */
export const TRANSPORT_MODES = [
  'bus',
  'train',
  'minivan',
  'private_car',
  'taxi',
  'ferry',
  'flight',
] as const

export type TransportMode = (typeof TRANSPORT_MODES)[number]

export const PRICE_UNITS = ['person', 'vehicle'] as const

export type PriceUnit = (typeof PRICE_UNITS)[number]

const ROUTE_SELECT = {
  id: true,
  fromLocation: true,
  toLocation: true,
  mode: true,
  durationMinMinutes: true,
  durationMaxMinutes: true,
  priceMinBdt: true,
  priceMaxBdt: true,
  pricePer: true,
  note: true,
  isActive: true,
  updatedAt: true,
}

/** Every curated route, in the order somebody reads them: by pair, then mode. */
export async function listRoutes() {
  return db.routeEstimate.findMany({
    orderBy: [{ fromLocation: 'asc' }, { toLocation: 'asc' }, { mode: 'asc' }],
    select: ROUTE_SELECT,
  })
}

export async function readRoute(id: string) {
  const route = await db.routeEstimate.findUnique({ where: { id }, select: ROUTE_SELECT })
  if (route === null) throw notFound('That route was not found.')
  return route
}

export interface RouteInput {
  fromLocation: string
  toLocation: string
  mode: string
  durationMinMinutes: number
  durationMaxMinutes: number
  priceMinBdt: number
  priceMaxBdt: number
  pricePer: string
  note: string | null
  isActive: boolean
}

/**
 * Everything the database will refuse, refused here first with a sentence.
 *
 * The CHECK constraints are the real guarantee — they hold against a psql
 * session and against a future caller that forgets this function. These exist so
 * ops reads "the shortest time cannot be longer than the longest" rather than a
 * constraint violation with a constraint name in it.
 */
function normalise(input: RouteInput) {
  const fromLocation = input.fromLocation.trim().toLowerCase()
  const toLocation = input.toLocation.trim().toLowerCase()

  if (fromLocation === '' || toLocation === '') {
    throw badRequest('A route needs both a start and an end.')
  }

  // A route from a place to itself is not a journey, and it would sit in the
  // table forever without ever being looked up — the gap finder skips a pair
  // whose ends match.
  if (fromLocation === toLocation) {
    throw badRequest('A route has to go somewhere other than where it started.')
  }

  if (!TRANSPORT_MODES.includes(input.mode as TransportMode)) {
    throw badRequest('That is not a mode of transport we describe.')
  }

  if (!PRICE_UNITS.includes(input.pricePer as PriceUnit)) {
    throw badRequest('A price is either per person or per vehicle.')
  }

  if (input.durationMinMinutes > input.durationMaxMinutes) {
    throw badRequest('The shortest time cannot be longer than the longest.')
  }

  if (input.priceMinBdt > input.priceMaxBdt) {
    throw badRequest('The lowest price cannot be higher than the highest.')
  }

  return {
    ...input,
    fromLocation,
    toLocation,
    note: input.note === null || input.note.trim() === '' ? null : input.note.trim(),
  }
}

/**
 * Add a route, or say why not.
 *
 * The unique index is on (from, to, mode) rather than (from, to), because a bus
 * and a private car are different answers to the same question and both should
 * be offerable — the estimator receives all of them and picks what fits the
 * party and the hour.
 */
export async function createRoute(input: RouteInput) {
  const data = normalise(input)

  const existing = await db.routeEstimate.findFirst({
    where: { fromLocation: data.fromLocation, toLocation: data.toLocation, mode: data.mode },
    select: { id: true },
  })

  // Checked here so ops reads a sentence rather than a unique violation, and
  // enforced by the index anyway because this check races with itself.
  if (existing !== null) {
    throw conflict('That route already exists for this mode. Edit the existing one instead.')
  }

  return db.routeEstimate.create({ data, select: ROUTE_SELECT })
}

export async function updateRoute(id: string, input: RouteInput) {
  const data = normalise(input)

  const clash = await db.routeEstimate.findFirst({
    where: {
      fromLocation: data.fromLocation,
      toLocation: data.toLocation,
      mode: data.mode,
      id: { not: id },
    },
    select: { id: true },
  })

  if (clash !== null) throw conflict('Another row already covers that route and mode.')

  return db.routeEstimate.update({ where: { id }, data, select: ROUTE_SELECT })
}

/**
 * Retire a route rather than delete it.
 *
 * DEACTIVATION IS THE DEFAULT, because a route that stopped running last month
 * is a fact about the past and a quotation priced against it should stay
 * explicable. `isActive` sits in the lookup's WHERE clause, so a retired row
 * stops reaching travellers immediately while remaining readable here.
 */
export async function setRouteActive(id: string, isActive: boolean) {
  return db.routeEstimate.update({ where: { id }, data: { isActive }, select: ROUTE_SELECT })
}

/**
 * Actually remove one.
 *
 * For a row typed wrong — the wrong city, a price off by a factor of ten — where
 * keeping it could only mislead. Nothing references these rows: the estimator
 * reads them and copies the numbers into an item's snapshot, so a delete cannot
 * orphan anything already quoted.
 */
export async function deleteRoute(id: string) {
  await db.routeEstimate.delete({ where: { id } })
}
