import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { userActor } from '@/server/modules/entitlements/service'
import { CreatePlannerSessionBody } from '@/server/modules/planner/schema'
import {
  createOrResumeSession,
  createSession,
  listMessages,
} from '@/server/modules/planner/session'
import { toPlannerSessionView } from '@/server/modules/planner/views'

/**
 * POST /api/v1/planner/sessions — start or resume a planning conversation.
 *
 * Resuming is the default. A traveller who reloads the page has not started a
 * second trip, and a fresh row per page load would scatter one conversation
 * across a dozen sessions and lose the brief each time. `resume: false` is how a
 * client offers "plan another trip" deliberately.
 *
 * The status code distinguishes the two outcomes — 201 when a session was
 * created, 200 when an existing one was handed back — and `resumed` in the body
 * says the same thing for clients that do not branch on status.
 *
 * The service layer supports anonymous owners; the schema has a visitor column
 * for exactly that. This endpoint still requires a traveller. The anonymous
 * surface is the teaser, which is a fixed questionnaire rather than a
 * conversation, and opening a full session to unauthenticated callers would put
 * an unmetered model call behind a route with no quota attached to it.
 */
export const POST = route(async (req: NextRequest) => {
  const claims = await requireUser(req)
  const body = await parseJson(req, CreatePlannerSessionBody)

  const actor = userActor(claims.userId)
  const brief = body.brief ?? {}

  const { session, resumed } =
    body.resume === false
      ? { session: await createSession(actor, brief), resumed: false }
      : await createOrResumeSession(actor, brief)

  const messages = resumed ? await listMessages(session.id) : []

  return json(toPlannerSessionView(session, resumed, messages), resumed ? 200 : 201)
})
