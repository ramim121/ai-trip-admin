import type { NextRequest } from 'next/server'
import { optionalUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import {
  VISITOR_COOKIE_NAME,
  findVisitorByCookie,
  readVisitorCookie,
} from '@/server/modules/entitlements/anonymous'
import { toPublicPoll } from '@/server/modules/polls/schema'
import {
  activePoll,
  existingVote,
  isOpen,
  userVoterKey,
  visitorVoterKey,
} from '@/server/modules/polls/service'

/**
 * GET /api/v1/polls/active — the poll to show on Discover, if there is one.
 *
 * Answers `{ poll: null }` rather than 404 when nothing is running. A missing
 * poll is a normal state of the site, not a failed request, and the page it
 * feeds renders nothing at all in that case — a poll section with no poll in it
 * is worse than no poll section.
 *
 * WHY THIS READS THE VISITOR
 *
 * Because the response shape depends on whether this person has already voted.
 * Counts are OMITTED until they have, not shipped-and-hidden: a response
 * carrying every tally beside `resultsVisible: false` has results one devtools
 * tab away, and then "results after voting" is decoration rather than a rule.
 *
 * Recognition here is by cookie alone, through `findVisitorByCookie`, which
 * neither creates a row nor stamps `lastSeenAt`. `identifyVisitor` would do
 * both — right when a quota is about to be spent, wrong on a GET. It would also
 * match on hashed IP, which on a read means showing one visitor another
 * visitor's answer because they share an office router. An unrecognised browser
 * simply reads as "has not voted", which is the honest answer.
 */
export const GET = route(async (req: NextRequest) => {
  const now = new Date()

  const poll = await activePoll(now)
  if (poll === null) return json({ poll: null })

  const claims = await optionalUser(req)

  let voterKey: string | null = null

  if (claims !== null) {
    voterKey = userVoterKey(claims.userId)
  } else {
    const visitor = await findVisitorByCookie(
      readVisitorCookie(req.cookies.get(VISITOR_COOKIE_NAME)?.value)
    )
    voterKey = visitor === null ? null : visitorVoterKey(visitor.id)
  }

  const votedOptionId = voterKey === null ? null : await existingVote(poll.id, voterKey)

  return json({ poll: toPublicPoll(poll, { votedOptionId, open: isOpen(poll, now) }) })
})
