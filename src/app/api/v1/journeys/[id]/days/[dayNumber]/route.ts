import type { NextRequest } from 'next/server'
import { badRequest } from '@/server/http/errors'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { SetDayNoteBody } from '@/server/modules/journey/schema'
import { setDayNote } from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * PATCH /api/v1/journeys/{id}/days/{dayNumber} — the traveller's own note.
 *
 * THE ONE PIECE OF TEXT ON A PLAN THAT NOTHING GENERATES. Every other sentence
 * here was written by a model and can be rewritten by one — the day summary, the
 * match reasons, the brief. This column is the traveller's, and no prompt, no
 * redraw and no regenerate touches it.
 *
 * That matters more than it sounds. "Anniversary dinner, do not move this" is
 * the kind of thing somebody writes once and expects to survive an afternoon of
 * rearranging, and a planner that eats it is one they stop trusting with
 * anything that matters. It is also fed to the chat verbatim, so the model is
 * told about the dinner rather than left to move it.
 *
 * RETURNS THE WHOLE PLAN, like every other mutation here — the note changes what
 * the chat is briefed with, so a client patching its own copy would be holding a
 * plan whose briefing it cannot see.
 */
export const PATCH = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/days/[dayNumber]'>) => {
    const claims = await requireUser(req)
    const { id, dayNumber } = await ctx.params

    /*
     * A path segment is a string, and `Number('3abc')` is NaN rather than 3.
     *
     * Checked here rather than left to the service, because NaN fails every
     * comparison silently: it would slip past both `day < 1` and
     * `day > durationDays` and reach the database as a null day number.
     */
    const day = Number(dayNumber)

    if (!Number.isInteger(day) || day < 1) {
      throw badRequest('That is not a day of this trip.')
    }

    const body = await parseJson(req, SetDayNoteBody)

    return json(assembleJourneyView(await setDayNote(id, claims.userId, day, body.note)))
  }
)
