import type { NextRequest } from 'next/server'
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

/** The itinerary as one readable block, so the model can name real item ids. */
function summarise(journey: Awaited<ReturnType<typeof readJourney>>): string {
  const lines = [
    `Trip: ${journey.destinations.join(' and ') || 'not set'}, ${journey.durationDays} days, ` +
      `${journey.partyAdults} adults and ${journey.partyChildren} children` +
      (journey.tripType ? `, ${journey.tripType}` : ''),
  ]

  const byDay = new Map<number, string[]>()
  for (const item of journey.items) {
    const list = byDay.get(item.dayNumber) ?? []
    const time = item.startMinute === null ? item.slot : `${item.slot} at ${item.startMinute}min`
    list.push(
      `item ${item.id} "${item.title}" (${time}${item.durationMin === null ? '' : `, ${item.durationMin}min`})`
    )
    byDay.set(item.dayNumber, list)
  }

  for (const [day, list] of [...byDay].sort((a, b) => a[0] - b[0])) {
    lines.push(`Day ${day}: ${list.join('; ')}`)
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
      { itinerarySummary: summarise(before), message: body.message },
      { userId: claims.userId }
    )

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
            await moveItem(
              id,
              claims.userId,
              action.itemId,
              action.dayNumber,
              action.slot as DaySlot
            )
            break

          case 'updateTime':
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

    const after = await readJourney(id, claims.userId)

    return json({
      reply: reply.reply,
      quickReplies: reply.quickReplies,
      pacing: reply.pacing,
      journey: assembleJourneyView(after),
    })
  }
)
