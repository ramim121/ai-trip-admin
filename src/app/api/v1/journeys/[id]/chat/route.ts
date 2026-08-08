import { randomUUID } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { DaySlot, ItemSource, JourneyItemType } from '@/generated/prisma/enums'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import { chatTurn } from '@/server/modules/journey/ai'
import { JourneyChatBody } from '@/server/modules/journey/schema'
import {
  addItem,
  moveItem,
  readJourney,
  refineBrief,
  removeItem,
  updateBasics,
  updateItemTime,
} from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * POST /api/v1/journeys/{id}/chat — a turn of the itinerary conversation.
 *
 * THE MODEL PROPOSES, THIS APPLIES. Actions come back as structured objects and
 * every one is executed through the same service functions a button press uses —
 * so a model cannot write day 9 onto a seven-day trip, cannot touch somebody
 * else's plan, and cannot skip a validation, because it never gets nearer the
 * database than this loop.
 *
 * AN ACTION THAT FAILS DOES NOT FAIL THE TURN. The traveller gets the reply and
 * whatever did apply; a partial edit with an honest answer beats a 500 that
 * loses the sentence they typed. Failures are logged, not surfaced as noise.
 */

const CHAT_TURNS_PER_USER_PER_HOUR = 120

/**
 * The itinerary as one readable block, so the model can name real item ids.
 *
 * SELECTED DAYS ARE MARKED IN THE BRIEFING RATHER THAN FILTERED OUT OF IT. A
 * model shown only days 3 and 4 will cheerfully move something onto day 5 and
 * collide with a thing it was never told about; a model shown the whole trip
 * with two days marked knows both what to change and what not to tread on.
 *
 * EVERY DAY APPEARS, INCLUDING THE EMPTY ONES. A day with nothing in it is
 * exactly the day somebody is most likely to be talking about, and omitting it
 * makes "fill day 6" look like a request about a day outside the trip.
 */
function summarise(
  journey: Awaited<ReturnType<typeof readJourney>>,
  focus: readonly number[]
): string {
  const selected = new Set(focus)

  const lines = [
    `Trip: ${journey.destinations.join(' and ') || 'not set'}, ${journey.durationDays} days, ` +
      `${journey.partyAdults} adults and ${journey.partyChildren} children` +
      (journey.tripType ? `, ${journey.tripType}` : ''),
  ]

  if (selected.size > 0) {
    const list = [...selected].sort((a, b) => a - b).join(', ')
    lines.push(
      `The traveller has selected ${selected.size === 1 ? 'day' : 'days'} ${list}. Their message ` +
        `is about ${selected.size === 1 ? 'that day' : 'those days'} unless they clearly say ` +
        'otherwise. Leave every other day alone.'
    )
  }

  const byDay = new Map<number, string[]>()
  for (const item of journey.items) {
    const list = byDay.get(item.dayNumber) ?? []
    const time = item.startMinute === null ? item.slot : `${item.slot} at ${item.startMinute}min`
    list.push(
      `item ${item.id} "${item.title}" (${time}${item.durationMin === null ? '' : `, ${item.durationMin}min`})`
    )
    byDay.set(item.dayNumber, list)
  }

  for (let day = 1; day <= journey.durationDays; day += 1) {
    const record = journey.days.find((entry) => entry.dayNumber === day)
    const marker = selected.has(day) ? ' [SELECTED]' : ''
    const place = record?.locationName == null ? '' : ` (${record.locationName})`
    // The traveller's own note is quoted verbatim, because "anniversary dinner,
    // do not move this" is the single most important sentence about that day and
    // a model that has not seen it will move the dinner.
    const note = record?.note == null ? '' : ` — they wrote: "${record.note}"`

    lines.push(
      `Day ${day}${place}${marker}: ${byDay.get(day)?.join('; ') ?? 'nothing planned'}${note}`
    )
  }

  return lines.join('\n')
}

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/chat'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    await enforceRateLimit(
      {
        key: `journey-chat:user:${claims.userId}`,
        limit: CHAT_TURNS_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'That is a lot of messages at once. Give it a moment.'
    )

    const body = await parseJson(req, JourneyChatBody)

    const before = await readJourney(id, claims.userId)

    const reply = await chatTurn(
      { itinerarySummary: summarise(before, body.dayNumbers), message: body.message },
      { userId: claims.userId }
    )

    /*
     * WHICH ITEMS DID THIS TURN TOUCH?
     *
     * Collected from two directions because neither alone is complete. An
     * `addItem` returns the whole plan rather than the new row, so a created
     * item is only findable by diffing ids against the snapshot below; a `move`
     * or `updateTime` names an id that already existed, so no diff would ever
     * see it.
     *
     * Diffing ids rather than comparing timestamps, because two items created in
     * the same millisecond are indistinguishable by clock and perfectly
     * distinguishable by id.
     */
    const idsBefore = new Set(before.items.map((item) => item.id))
    const namedByModel = new Set<string>()

    for (const action of reply.actions) {
      try {
        switch (action.action) {
          case 'updateTripBasics':
            await updateBasics(id, claims.userId, {
              ...(action.durationDays === null ? {} : { durationDays: action.durationDays }),
              ...(action.partyAdults === null ? {} : { partyAdults: action.partyAdults }),
              ...(action.partyChildren === null ? {} : { partyChildren: action.partyChildren }),
              ...(action.budgetMinBdt === null ? {} : { budgetMinBdt: action.budgetMinBdt }),
              ...(action.budgetMaxBdt === null ? {} : { budgetMaxBdt: action.budgetMaxBdt }),
            })
            break

          case 'addItem':
            await addItem(id, claims.userId, {
              dayNumber: action.dayNumber,
              slot: action.slot as DaySlot,
              type: action.itemType as JourneyItemType,
              title: action.title,
              // Anything the chat adds is a placeholder describing a kind of
              // thing. Real options come from a provider and the traveller picks
              // one, which is why this can never carry an external id.
              source: ItemSource.AI_ESTIMATE,
              durationMin: action.durationMin,
              snapshot: action.searchQuery === null ? null : { searchQuery: action.searchQuery },
            })
            break

          case 'removeItem':
            await removeItem(id, claims.userId, action.itemId)
            break

          case 'moveItem':
            namedByModel.add(action.itemId)
            await moveItem(
              id,
              claims.userId,
              action.itemId,
              action.dayNumber,
              action.slot as DaySlot
            )
            break

          case 'updateTime':
            namedByModel.add(action.itemId)
            await updateItemTime(
              id,
              claims.userId,
              action.itemId,
              action.startMinute,
              action.durationMin
            )
            break

          case 'refineBrief':
            await refineBrief(id, claims.userId, action.pillar, action.location, action.message)
            break

          case 'regenerateDay':
          case 'answer':
            // Nothing to apply. `answer` is the model saying it only spoke, and
            // regenerating a day is a deliberate button rather than something
            // the chat should do to a plan somebody has been editing.
            break
        }
      } catch (error) {
        // One bad action must not cost the traveller their whole turn — they
        // still get the reply and whatever else applied.
        console.error(`[journey-chat] action ${action.action} failed:`, error)
      }
    }

    /*
     * Stamp the turn, so the interface can say which cards just changed.
     *
     * A FRESH ID EVERY TIME, and the previous turn's stamps are left where they
     * are. They stop mattering the moment the journey's own id moves on, because
     * "part of the last change" is defined as the two ids matching — so nothing
     * has to be cleaned up, and an item touched three turns ago quietly stops
     * being highlighted without anybody rewriting its row.
     *
     * Only when something actually changed. A turn that only answered a question
     * must not clear the highlight on the edit before it — that would punish
     * somebody for asking "what did you just do?".
     */
    const touched = [
      ...new Set([
        ...namedByModel,
        ...(await db.journeyItem.findMany({
          where: { journeyId: id, id: { notIn: [...idsBefore] } },
          select: { id: true },
        })).map((item) => item.id),
      ]),
    ]

    if (touched.length > 0) {
      const changeSetId = randomUUID()

      await db.$transaction([
        db.journeyItem.updateMany({
          where: { journeyId: id, id: { in: touched } },
          data: { changeSetId },
        }),
        db.journey.update({ where: { id }, data: { lastChangeSetId: changeSetId } }),
      ])
    }

    const after = await readJourney(id, claims.userId)

    return json({
      reply: reply.reply,
      quickReplies: reply.quickReplies,
      pacing: reply.pacing,
      journey: assembleJourneyView(after),
    })
  }
)
