import { tool } from 'ai'
import { z } from 'zod'
import { ActivityCategory, TimeOfDay, TransitMode } from '@/generated/prisma/enums'
import { sanitiseToolOutput } from '@/server/ai/guard'
import {
  InvalidTimeWindowError,
  MAX_BLOCK_END_MINUTE,
  MAX_SEARCH_LIMIT,
  MINUTES_IN_DAY,
  estimateTravelMinutes,
  getActivity,
  isOpenAt,
  listDestinations,
  searchActivities,
  type ActivityDetail,
  type DestinationSummary,
  type RankedActivity,
} from './service'

/**
 * The catalog, as the model is allowed to see it.
 *
 * These five tools are the ONLY way an activity can enter a plan. The rule is
 * enforced in three independent places, because one of them will eventually be
 * wrong: the system prompt states it, `DayBlockSchema` demands an `activityId`
 * that has to resolve against a real row, and this file is the third leg — the
 * only thing in the process that turns a catalog row into something the model
 * can read.
 *
 * Four rules hold for every tool here.
 *
 *   Read-only, always. Nothing in this file writes. Catalog mutation lives in
 *     `admin.ts` behind a staff guard and is not reachable from a tool call, so
 *     a prompt injection that convinces the model to "update the price" has
 *     nothing to call.
 *
 *   No free-form query language. Every input is a typed, bounded field — an
 *     enum, a uuid, a capped integer, a short string. There is no parameter into
 *     which a SQL fragment, an operator or an ordering clause could be passed,
 *     because the WHERE clause is assembled in `service.ts` from named arguments
 *     and never from caller text.
 *
 *   Bounded output. Every list has a `max` on its limit and a default well below
 *     it. An unbounded limit is not a performance problem here so much as a
 *     billing one: tool results are re-sent as context on every subsequent step.
 *
 *   Output is sanitised, and failure is a *result* rather than a throw. Catalog
 *     copy is admin-authored, which describes provenance and not
 *     trustworthiness — one compromised content account and an activity
 *     description is issuing instructions to a model that reads tool results as
 *     trusted findings. And a tool that throws aborts the whole generation and
 *     shows the traveller nothing, where one that answers `{ found: false }`
 *     lets the designer say "I could not find anything for that" and carry on.
 */

/** Ceiling on rows handed back for one search, whatever the model asks for. */
export const MAX_TOOL_SEARCH_RESULTS = MAX_SEARCH_LIMIT
const DEFAULT_TOOL_SEARCH_RESULTS = 8

/** Ceiling on destinations in one listing. */
export const MAX_TOOL_DESTINATION_RESULTS = 25

export interface CatalogToolContext {
  /**
   * Narrows every search once the brief has settled on a destination. Set from
   * what the traveller actually told us, and it WINS over whatever the model
   * passes: a model that "helpfully" widens the destination is proposing a trip
   * to the wrong city.
   */
  destinationId?: string | null
  /** Narrows on capacity, so the model is never shown a tour that cannot take them. */
  partySize?: number | null
  /**
   * Ids the model was actually shown this turn. Mutated as tools run; the caller
   * owns the set and reads it afterwards. A model that later emits a well-formed
   * uuid it was never given has either invented it or copied it from somewhere
   * it should not have, and both deserve to fail closed.
   */
  retrievedActivityIds: Set<string>
}

/**
 * Trimmed for the model.
 *
 * `slug`, `destinationId` and `isActive` are dropped: the model has no use for
 * them, they cost tokens on every row of every result, and `slug` in particular
 * invites it to compose URLs we never promised to serve.
 */
function activityForModel(activity: RankedActivity | ActivityDetail) {
  return {
    activityId: activity.id,
    name: activity.name,
    summary: activity.summary,
    destination: activity.destination.name,
    category: activity.category,
    durationMinutes: activity.durationMinutes,
    pricePerPersonBdt: activity.pricePerPersonBdt,
    priceNote: activity.priceNote,
    bestTimeOfDay: activity.bestTimeOfDay,
    intensity: activity.intensity,
    bookingRequired: activity.bookingRequired,
    minPartySize: activity.minPartySize,
    maxPartySize: activity.maxPartySize,
    tags: activity.tags.map((tag) => tag.slug),
    hasCoordinates: activity.location !== null,
  }
}

function destinationForModel(destination: DestinationSummary) {
  return {
    destinationId: destination.id,
    name: destination.name,
    country: destination.country,
    region: destination.region,
    summary: destination.summary,
    timezone: destination.timezone,
    activityCount: destination.activityCount,
  }
}

/** One log line, no re-throw. See the file header for why this never throws. */
function toolFailure(toolName: string, e: unknown): { ok: false; error: string } {
  const description = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  console.error(`[catalog] tool "${toolName}" failed: ${description}`)
  return {
    ok: false,
    error:
      'The catalog could not be read just now. Tell the traveller plainly that you could not ' +
      'check, and continue with what you already have.',
  }
}

const OPENING_HOURS_LEGEND =
  'dayOfWeek 0 = Sunday through 6 = Saturday. Minutes count from local midnight, so 540 is ' +
  '09:00; a closesMinute above 1440 runs past midnight, so 1560 is 02:00 the next morning.'

/**
 * Build the tool set for one planner turn.
 *
 * A factory rather than a module-level constant because the context — the pinned
 * destination, the party size, the set of ids actually retrieved — belongs to a
 * single conversation. One shared mutable set across concurrent requests would
 * let one traveller's retrieved ids validate another traveller's plan.
 */
export function catalogTools(context: CatalogToolContext) {
  return {
    listDestinations: tool({
      description:
        'List the destinations Beyond Borders actually sells, optionally filtered by a name, ' +
        'country or region. CALL THIS FIRST, before any other catalog tool, whenever the ' +
        'traveller names a place or asks where they could go — you need the destinationId from ' +
        'here to search activities, and a place that does not appear in this list is a place we ' +
        'do not operate in. Omit the query to see everything on offer. Do not name a destination ' +
        'to the traveller unless it came back from this tool.',
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .max(120)
          .optional()
          .describe(
            'Place name as the traveller said it, e.g. "Coxs Bazar" or "Thailand". Omit to list ' +
              'every destination.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOOL_DESTINATION_RESULTS)
          .optional()
          .describe(`Maximum rows to return. Defaults to ${MAX_TOOL_DESTINATION_RESULTS}.`),
      }),
      execute: async ({ query, limit }) => {
        try {
          const destinations = await listDestinations({ query, limit })
          return sanitiseToolOutput({
            ok: true,
            found: destinations.length > 0,
            count: destinations.length,
            destinations: destinations.map(destinationForModel),
          })
        } catch (e) {
          return toolFailure('listDestinations', e)
        }
      },
    }),

    searchActivities: tool({
      description:
        'Search the curated activity catalog and get back a ranked shortlist. THIS IS THE ONLY ' +
        'SOURCE OF ACTIVITIES YOU MAY RECOMMEND. An activity that has not come back from this ' +
        'tool does not exist as far as this conversation is concerned — do not name it, do not ' +
        'price it, do not put it in a day, not even if you are certain it is real. Carry every ' +
        '`activityId` through unchanged into any plan you produce; a plan block without one will ' +
        'be rejected. ' +
        'Call this once the destination is known and you have some idea of what the traveller ' +
        'enjoys, and call it again with different interests or a different category when the ' +
        'first shortlist does not fit — a second search is far cheaper than a wrong suggestion. ' +
        'Results are ranked by how well their tags overlap the interests you pass, so pass the ' +
        "traveller's own words: \"street food\", \"temples\", \"nothing strenuous\". " +
        'If it returns nothing, say so plainly and either offer what the catalog does have or ' +
        'ask a question that would let you search differently. Never fill the gap from your own ' +
        'knowledge of the place.',
      inputSchema: z.object({
        destinationId: z
          .uuid()
          .optional()
          .describe(
            'From listDestinations. Omitting it searches every destination, which is rarely what ' +
              'you want once a trip has a location.'
          ),
        interests: z
          .array(z.string().trim().min(1).max(60))
          .max(10)
          .optional()
          .describe(
            'What the traveller enjoys, in their own words. This drives the ranking: an activity ' +
              'whose tags match more of these comes back higher.'
          ),
        category: z
          .enum(ActivityCategory)
          .optional()
          .describe('Restrict to one category. Leave it off unless the traveller was specific.'),
        timeOfDay: z
          .enum(TimeOfDay)
          .optional()
          .describe(
            'The slot you are filling. Activities marked ANY suit any slot and are always ' +
              'included.'
          ),
        maxDurationMinutes: z
          .number()
          .int()
          .min(15)
          .max(MINUTES_IN_DAY)
          .optional()
          .describe('Use this when you are filling a gap of a known length.'),
        maxPricePerPersonBdt: z
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .optional()
          .describe(
            'Whole taka per person. Activities with no listed price — free sights, and anything ' +
              'quoted case by case — are always included, so read priceNote before quoting a cost.'
          ),
        partySize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Filters out activities that cannot take a group this size.'),
        excludeActivityIds: z
          .array(z.uuid())
          .max(50)
          .optional()
          .describe(
            'Ids already placed in the plan, or already rejected by the traveller, so a second ' +
              'search does not return the same things.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOOL_SEARCH_RESULTS)
          .optional()
          .describe(`Maximum rows to return. Defaults to ${DEFAULT_TOOL_SEARCH_RESULTS}.`),
      }),
      execute: async (input) => {
        try {
          const result = await searchActivities({
            ...input,
            // The brief wins over whatever the model passed. See CatalogToolContext.
            destinationId: context.destinationId ?? input.destinationId,
            partySize: context.partySize ?? input.partySize,
            limit: input.limit ?? DEFAULT_TOOL_SEARCH_RESULTS,
          })

          for (const activity of result.activities) context.retrievedActivityIds.add(activity.id)

          return sanitiseToolOutput({
            ok: true,
            found: result.activities.length > 0,
            count: result.activities.length,
            activities: result.activities.map((activity) => ({
              ...activityForModel(activity),
              // Why it ranked where it did. Useful to the model when it explains a
              // suggestion, and useful to us when a ranking looks wrong in a log.
              matchedInterests: activity.matchedInterests,
            })),
          })
        } catch (e) {
          return toolFailure('searchActivities', e)
        }
      },
    }),

    getActivityDetails: tool({
      description:
        'Full detail for ONE activity you have already seen in a searchActivities result, ' +
        'including its long description and its opening hours. Call this before you commit an ' +
        'activity to a specific time of day, and before you describe it in more than a sentence ' +
        '— the search result carries only a summary, and inventing the rest is the same failure ' +
        'as inventing the activity itself. This tool does not discover new activities: an id ' +
        'that did not come from a search will simply not be found.',
      inputSchema: z.object({
        activityId: z.uuid().describe('An id returned by searchActivities.'),
      }),
      execute: async ({ activityId }) => {
        try {
          const activity = await getActivity(activityId)

          if (activity === null) {
            // Deliberately not an error: the honest answer to "tell me about this
            // id" for an id we do not have is that we do not have it.
            return { ok: true, found: false, activityId }
          }

          context.retrievedActivityIds.add(activity.id)

          return sanitiseToolOutput({
            ok: true,
            found: true,
            ...activityForModel(activity),
            description: activity.description,
            openingHours: activity.openingHours.map((window) => ({
              dayOfWeek: window.dayOfWeek,
              opensMinute: window.opensMinute,
              closesMinute: window.closesMinute,
            })),
            openingHoursNote:
              activity.openingHours.length === 0
                ? 'No opening hours are recorded, which means this one is open access — a beach, ' +
                  'a viewpoint, a public road. It can be scheduled at any hour that makes sense.'
                : `${OPENING_HOURS_LEGEND} A weekday with no window listed is CLOSED that day.`,
            imageCount: activity.images.length,
          })
        } catch (e) {
          return toolFailure('getActivityDetails', e)
        }
      },
    }),

    estimateTravelTime: tool({
      description:
        'Estimate how long it takes to get from one catalog activity to another by a given mode. ' +
        'Call this between every pair of consecutive activities before you decide their start ' +
        'times — two things that look close on a map can be an hour apart in traffic, and a day ' +
        'planned without transfers is a day that falls apart by lunchtime. ' +
        'THE RESULT IS AN ESTIMATE, NOT A MEASUREMENT. It comes from straight-line distance and ' +
        'an assumed average speed: there is no routing, no traffic and no timetable behind it. ' +
        'Present it as approximate ("about 40 minutes"), never as exact, and leave headroom on ' +
        'anything with a fixed departure such as a ferry or a flight. When `minutes` comes back ' +
        'null we have no coordinates for one of the two, so leave a generous transfer block and ' +
        'say the timing still needs confirming.',
      inputSchema: z.object({
        fromActivityId: z.uuid().describe('Where the traveller is leaving from.'),
        toActivityId: z.uuid().describe('Where they are going next.'),
        mode: z
          .enum(TransitMode)
          .describe(
            'How they travel. Choose from the trip brief: a PRIVATE_CAR trip uses CAR, a city ' +
              'centre hop is usually WALK or TAXI.'
          ),
      }),
      execute: async ({ fromActivityId, toActivityId, mode }) => {
        try {
          const estimate = await estimateTravelMinutes(fromActivityId, toActivityId, mode)

          if (estimate === null) {
            return {
              ok: true,
              found: false,
              error:
                'One or both of those activity ids are not in the catalog. Use ids returned by ' +
                'searchActivities.',
            }
          }

          return sanitiseToolOutput({
            ok: true,
            found: true,
            minutes: estimate.minutes,
            isEstimate: true as const,
            distanceKm: estimate.distanceKm,
            mode: estimate.mode,
            from: estimate.from.name,
            to: estimate.to.name,
            note: estimate.note,
          })
        } catch (e) {
          return toolFailure('estimateTravelTime', e)
        }
      },
    }),

    checkActivityAvailability: tool({
      description:
        'Check whether one activity is open for a specific slot on a specific weekday. Call this ' +
        'for every activity you are about to pin to a time, and always for anything scheduled ' +
        'early, late or at a weekend — an itinerary that sends someone to a museum on its ' +
        'closing day is worse than one that leaves the morning free. ' +
        'The answer covers the WHOLE slot: a partly-covered slot comes back closed, because a ' +
        'traveller arriving twenty minutes before the gate opens is standing outside a locked ' +
        'gate. When it says CLOSED_ON_DAY or OUTSIDE_HOURS, move the activity rather than ' +
        'shortening it, and use the returned windows to pick an hour that works.',
      inputSchema: z.object({
        activityId: z.uuid().describe('An id returned by searchActivities.'),
        dayOfWeek: z
          .number()
          .int()
          .min(0)
          .max(6)
          .describe('0 = Sunday through 6 = Saturday, matching the trip dates you have.'),
        startMinute: z
          .number()
          .int()
          .min(0)
          .max(MINUTES_IN_DAY - 1)
          .describe('Slot start, minutes from local midnight. 09:30 is 570.'),
        endMinute: z
          .number()
          .int()
          .min(1)
          .max(MAX_BLOCK_END_MINUTE)
          .describe(
            'Slot end, minutes from local midnight and after startMinute. May exceed 1440 for a ' +
              'block running past midnight.'
          ),
      }),
      execute: async ({ activityId, dayOfWeek, startMinute, endMinute }) => {
        try {
          const availability = await isOpenAt(activityId, dayOfWeek, startMinute, endMinute)

          if (availability === null) {
            return {
              ok: true,
              found: false,
              activityId,
              error: 'That activity id is not in the catalog. Use ids returned by searchActivities.',
            }
          }

          return sanitiseToolOutput({
            ok: true,
            found: true,
            activityId: availability.activityId,
            name: availability.name,
            isOpen: availability.isOpen,
            reason: availability.reason,
            windowsOnDay: availability.windowsOnDay,
            durationMinutes: availability.durationMinutes,
            note: OPENING_HOURS_LEGEND,
          })
        } catch (e) {
          // A malformed slot is the model's mistake, not ours, and telling it
          // exactly what was wrong is what lets it fix the call rather than
          // abandon the day.
          if (e instanceof InvalidTimeWindowError) {
            return { ok: false as const, found: false as const, error: e.message }
          }
          return toolFailure('checkActivityAvailability', e)
        }
      },
    }),
  }
}

export type CatalogTools = ReturnType<typeof catalogTools>

/** The tool names this module publishes, for prompt copy and for logging. */
export const CATALOG_TOOL_NAMES = [
  'listDestinations',
  'searchActivities',
  'getActivityDetails',
  'estimateTravelTime',
  'checkActivityAvailability',
] as const

export type CatalogToolName = (typeof CATALOG_TOOL_NAMES)[number]
