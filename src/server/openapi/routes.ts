import {
  AcceptedResponse,
  AdminSessionResponse,
  ForgotPasswordBody,
  LoginBody,
  PublicAdmin,
  PublicUser,
  RefreshBody,
  RegisterBody,
  ResetPasswordBody,
  TokenPair,
  UserSessionResponse,
} from '@/server/modules/auth/schema'
import {
  ActivitySearchQuery,
  DestinationActivitiesResponse,
  DestinationListQuery,
  DestinationListResponse,
  PublicActivity,
} from '@/server/modules/catalog/schema'
import {
  EntitlementsResponse,
  PlanListResponse,
  TeaserReply,
  TeaserRequest,
} from '@/server/modules/entitlements/schema'
import {
  PackageDetailResponse,
  PackageListQuery,
  PackageListResponse,
  RegisterInterestBody,
  RegisterInterestResponse,
} from '@/server/modules/packages/schema'
import {
  BookingListResponse,
  CreateBookingBody,
  CreateBookingResponse,
  QuoteBody,
  QuoteResponse,
} from '@/server/modules/bookings/schema'
import { PastTripDetailResponse, PastTripListResponse } from '@/server/modules/past-trips/schema'
import { ActivePollResponse, CastVoteBody, CastVoteResponse } from '@/server/modules/polls/schema'
import {
  CheckoutBody,
  CheckoutResponse,
  MockCompletionBody,
  PaymentCompletionResponse,
  PaymentDetail,
  PaymentListQuery,
  PaymentListResponse,
} from '@/server/payments/schema'
import {
  BlockMutationResponse,
  CreateBlockBody,
  CreatePlannerSessionBody,
  Itinerary,
  ItineraryListQuery,
  ItineraryListResponse,
  MaterialiseItineraryBody,
  MaterialiseItineraryResponse,
  PlannerMessageBody,
  PlannerSession,
  PlannerStreamEvent,
  RegenerateDayResponse,
  SaveItineraryResponse,
  UpdateBlockBody,
  UpdateItineraryBody,
} from '@/server/modules/planner/schema'
import { errorResponse, registerRoute } from './registry'

/**
 * Every endpoint under /api/v1, declared once.
 *
 * These live beside the registry rather than inside the route files for a
 * practical reason: importing the handlers would drag in `next/navigation`, the
 * Prisma client and `env()` just to print a JSON document, and the writer script
 * has to run on a machine with no database and no secrets. What it costs is that
 * a new endpoint is not documented until somebody adds it here — so the spec's
 * path list is checked against the filesystem after every write.
 *
 * The error responses are not boilerplate. Each one is the set that endpoint can
 * actually produce, read off its handler:
 *
 *   - 400 wherever `parseJson` runs, since a malformed body is always possible.
 *   - 401 only where credentials or a bearer token are checked.
 *   - 409 only on register, the one endpoint that admits an address is taken.
 *   - 500 everywhere, because `toErrorResponse` is the last line of every route.
 *
 * Logout is 400-only on purpose: it answers 204 for an unknown token, so there
 * is no 401 to document (see the handler for why).
 */

const TRAVELLER = ['Auth'] as const
const STAFF = ['Admin Auth'] as const

/** Repeated verbatim across every endpoint that parses a JSON body. */
const MALFORMED_BODY =
  'The request body was not valid JSON, or failed schema validation. `details` names the offending fields.'

const UNEXPECTED =
  'An unexpected server error. The message is deliberately constant and carries no internal detail.'

// ─────────────────────────────────────────────────────────────────────────────
// Traveller
// ─────────────────────────────────────────────────────────────────────────────

registerRoute({
  method: 'post',
  path: '/api/v1/auth/register',
  operationId: 'registerUser',
  summary: 'Create a traveller account',
  description:
    'Creates the account and signs the traveller in immediately — the response carries a full ' +
    'session, so no follow-up login call is needed. This is the only endpoint in the API that ' +
    'reveals whether an email address is already registered; every other one answers identically ' +
    'for known and unknown addresses.',
  tags: TRAVELLER,
  requestSchema: RegisterBody,
  responses: {
    201: {
      schema: UserSessionResponse,
      description: 'The account was created and is now signed in.',
    },
    400: errorResponse(MALFORMED_BODY),
    409: errorResponse('An account already exists for this email address.'),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/auth/login',
  operationId: 'loginUser',
  summary: 'Sign in as a traveller',
  description:
    'Exchanges credentials for an access/refresh token pair. An unknown address, a wrong password ' +
    'and a suspended account are indistinguishable from the outside: same status, same message, ' +
    'and comparable timing.',
  tags: TRAVELLER,
  requestSchema: LoginBody,
  responses: {
    200: { schema: UserSessionResponse, description: 'Signed in.' },
    400: errorResponse(MALFORMED_BODY),
    401: errorResponse(
      'The credentials were refused. Covers an unknown address, an incorrect password and a ' +
        'non-active account, without distinguishing between them.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/auth/refresh',
  operationId: 'refreshUserSession',
  summary: 'Rotate a traveller refresh token',
  description:
    'Trades a refresh token for its successor. No access token is required — the refresh token is ' +
    'itself the credential, and the reason to present it is that the access token has expired. ' +
    'The old token is invalidated; replaying it revokes the entire session family on every device.',
  tags: TRAVELLER,
  requestSchema: RefreshBody,
  responses: {
    200: { schema: TokenPair, description: 'A fresh token pair. Discard the presented one.' },
    400: errorResponse(MALFORMED_BODY),
    401: errorResponse(
      'The refresh token is unknown, expired, already rotated, or belongs to an account that is ' +
        'no longer active. Sign the traveller in again.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/auth/logout',
  operationId: 'logoutUser',
  summary: 'End one traveller session',
  description:
    'Revokes the presented refresh token and nothing else, so signing out on a phone leaves a ' +
    'laptop signed in. Always 204, including for a token that never existed — answering 404 would ' +
    'turn this into a way to test whether a captured token is still live. The matching access ' +
    'token keeps working until it expires.',
  tags: TRAVELLER,
  requestSchema: RefreshBody,
  responses: {
    204: { schema: 'noContent', description: 'The session is ended, or was never live.' },
    400: errorResponse(MALFORMED_BODY),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/auth/me',
  operationId: 'getCurrentUser',
  summary: 'The signed-in traveller',
  description:
    'Reads the profile from the database rather than from the token, so a name or avatar changed a ' +
    'moment ago is reflected immediately. Account status is re-checked here: access tokens are not ' +
    'revocable, so this is where a suspension applied since the token was minted takes effect.',
  tags: TRAVELLER,
  security: 'user',
  responses: {
    200: { schema: PublicUser, description: 'The traveller behind the bearer token.' },
    401: errorResponse(
      'The bearer token is missing, malformed, expired, signed for the other audience, or names an ' +
        'account that is no longer active.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/auth/password/forgot',
  operationId: 'requestPasswordReset',
  summary: 'Request a password reset link',
  description:
    'Always 202 with the same body, whether or not the address is registered — anything else would ' +
    'make this a bulk membership test. The copy is phrased conditionally for the same reason, so ' +
    'the wording does not become the oracle the status code refuses to be. Suspended and deleted ' +
    'accounts are sent nothing.',
  tags: TRAVELLER,
  requestSchema: ForgotPasswordBody,
  responses: {
    202: {
      schema: AcceptedResponse,
      description: 'The request was accepted. Says nothing about whether the address exists.',
    },
    400: errorResponse(MALFORMED_BODY),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/auth/password/reset',
  operationId: 'resetPassword',
  summary: 'Spend a password reset link',
  description:
    'Sets the new password and revokes every refresh token the account holds, on every device. No ' +
    'session is returned: handing out tokens here would sign in anyone who merely intercepted the ' +
    'link, so send the traveller to the login form afterwards. The token is single-use.',
  tags: TRAVELLER,
  requestSchema: ResetPasswordBody,
  responses: {
    204: {
      schema: 'noContent',
      description: 'The password was changed and all sessions were revoked.',
    },
    400: errorResponse(
      'The body failed validation, or the reset token is unknown, expired or already used — those ' +
        'three are not distinguished. `details[].path` is `token` for the latter.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Staff
//
// Structurally identical to the traveller endpoints, and deliberately so. Staff
// addresses are the ones most worth enumerating, so this half gets no weaker
// treatment than the public one.
// ─────────────────────────────────────────────────────────────────────────────

registerRoute({
  method: 'post',
  path: '/api/v1/admin/auth/login',
  operationId: 'loginAdmin',
  summary: 'Sign in as staff',
  description:
    'Verified against a separate table and signed with a separate secret, so a traveller token can ' +
    'never satisfy an admin route and no request a traveller can make grants staff privilege. ' +
    'Failures are audited; the response tells the caller nothing about which check failed.',
  tags: STAFF,
  requestSchema: LoginBody,
  responses: {
    200: { schema: AdminSessionResponse, description: 'Signed in.' },
    400: errorResponse(MALFORMED_BODY),
    401: errorResponse(
      'The credentials were refused. Covers an unknown address, an incorrect password and a ' +
        'non-active account, without distinguishing between them.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/admin/auth/refresh',
  operationId: 'refreshAdminSession',
  summary: 'Rotate a staff refresh token',
  description:
    'Where staff revocation actually bites. The row is re-read on every rotation, anything no ' +
    'longer active is refused, and the successor token carries the role the database holds now ' +
    'rather than the one the old token claimed.',
  tags: STAFF,
  requestSchema: RefreshBody,
  responses: {
    200: { schema: TokenPair, description: 'A fresh token pair. Discard the presented one.' },
    400: errorResponse(MALFORMED_BODY),
    401: errorResponse(
      'The refresh token is unknown, expired, already rotated, or belongs to an admin who is no ' +
        'longer active. Sign in again.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/admin/auth/logout',
  operationId: 'logoutAdmin',
  summary: 'End one staff session',
  description:
    'Always 204, for the same reason the traveller logout is. Revocation is scoped to the ' +
    'presented token and touches the admin tables only, so a traveller token posted here matches ' +
    'nothing and changes nothing.',
  tags: STAFF,
  requestSchema: RefreshBody,
  responses: {
    204: { schema: 'noContent', description: 'The session is ended, or was never live.' },
    400: errorResponse(MALFORMED_BODY),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/admin/auth/me',
  operationId: 'getCurrentAdmin',
  summary: 'The signed-in staff member',
  description:
    'Open to every role — each admin may read their own record. The role returned is the one in ' +
    'the database, not the one in the token, so a console that renders navigation from this ' +
    'response will not offer a demoted admin controls the server is about to refuse.',
  tags: STAFF,
  security: 'admin',
  responses: {
    200: { schema: PublicAdmin, description: 'The staff member behind the bearer token.' },
    401: errorResponse(
      'The bearer token is missing, malformed, expired, signed for the other audience, or names an ' +
        'account that is no longer active.'
    ),
    403: errorResponse(
      'The token is valid but the role it carries is not permitted here. Not reachable on this ' +
        'endpoint today — it accepts every role — but documented because it is the standard ' +
        'refusal of the admin guard, and role-scoped endpoints will emit it.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Commerce, entitlements and the anonymous planner
//
// The 403s below are worth reading as a group. They are not permission errors
// in the usual sense — the caller is who they say they are, and the request is
// well formed — they are *product* walls. Each one carries a machine-readable
// cause in `details`, under `path: "reason"`. Clients branch on that and never
// on the message, because the message is copy, and copy gets edited.
// ─────────────────────────────────────────────────────────────────────────────

const COMMERCE = ['Plans'] as const
const ENTITLEMENTS = ['Entitlements'] as const
const PLANNER = ['Planner'] as const

/** Repeated on every endpoint that can refuse for entitlement reasons. */
const ENTITLEMENT_REFUSAL =
  'The action is not available on this account. `details` carries one entry whose `path` is ' +
  '`reason` and whose `message` is an EntitlementReason — ANON_PROMPT_EXHAUSTED, ' +
  'FREE_DAY_LIMIT, SAVE_LIMIT or PERIOD_LIMIT. GET /api/v1/me/entitlements describes what would ' +
  'lift it.'

registerRoute({
  method: 'get',
  path: '/api/v1/plans',
  operationId: 'listPlans',
  summary: 'The plans on sale',
  description:
    'Public and unauthenticated — a pricing page behind a login converts nobody. Retired plans ' +
    'are omitted rather than deleted, since subscriptions and payments still reference them.\n\n' +
    'Prices are whole Bangladeshi taka. There is no minor unit, no fractional price and no USD ' +
    'figure: `bdtPerUsd` is returned so a client can convert at render time, which is what stops ' +
    'a rate change rewriting a price that was already quoted.\n\n' +
    'A `null` on any limit means UNLIMITED, never zero. Reading it as zero turns the most ' +
    'expensive tier into the most restrictive one.',
  tags: COMMERCE,
  responses: {
    200: { schema: PlanListResponse, description: 'Every active plan, in display order.' },
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/me/entitlements',
  operationId: 'getMyEntitlements',
  summary: 'Current limits, usage and walls',
  description:
    'What this traveller may do and how much of it they have already done, so a client can ' +
    'explain a wall before hitting it rather than discovering it as a 403. `refusals` names the ' +
    'ones already in force, each with the upgrade that would lift it.\n\n' +
    'This is a report, not an authority. Every mutating endpoint re-runs the same checks against ' +
    'the same tables, so a client that caches this past a payment, or edits it, gains nothing — ' +
    'which is exactly what makes it safe to publish the numbers.\n\n' +
    'An expired subscription reports as FREE with no ceremony: it stops matching, so there is no ' +
    'lapsed state for a client to have to interpret.',
  tags: ENTITLEMENTS,
  security: 'user',
  responses: {
    200: {
      schema: EntitlementsResponse,
      description: 'The plan in force, the counters for the current period, and any active walls.',
    },
    401: errorResponse(
      'The bearer token is missing, malformed, expired, signed for the other audience, or names ' +
        'an account that is no longer active.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/planner/teaser',
  operationId: 'generateTeaser',
  summary: 'The anonymous trip preview',
  description:
    'Answers a four-question form with a short preview. Deliberately not a chat: the small, ' +
    'fixed input space is what makes the reply cacheable, and the cache is what makes a bypass ' +
    'attempt cost no AI spend.\n\n' +
    'An anonymous visitor gets exactly one reply, ever. Identity is the union of three signals — ' +
    'the signed `bb_visitor` cookie, a salted hash of the IP, and a salted hash of the optional ' +
    '`deviceFingerprint` — and a match on ANY ONE of them is the same visitor, so clearing ' +
    'cookies alone does not reset the quota. The response re-issues that cookie, including when ' +
    'the visitor was recognised by one of the other two signals.\n\n' +
    'A cached reply still spends the prompt: the rule is one reply, not one model call. Send a ' +
    'traveller bearer token to be metered against a plan instead of the anonymous quota; an ' +
    'absent or expired token is simply treated as anonymous.',
  tags: PLANNER,
  requestSchema: TeaserRequest,
  responses: {
    200: {
      schema: TeaserReply,
      description:
        'The preview. `cached` says whether the model was called; `promptsRemaining` is null for ' +
        'a signed-in caller.',
    },
    400: errorResponse(MALFORMED_BODY),
    403: errorResponse(ENTITLEMENT_REFUSAL),
    500: errorResponse(UNEXPECTED),
    503: errorResponse(
      'Previews are switched off — an operational kill switch for AI spend, not a fault. Cached ' +
        'replies are still served while it is on, so reaching this means nothing was cached for ' +
        'these particular answers.'
    ),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
//
// Public, unauthenticated, and read-only. This is the inventory the company
// actually sells, and the same rows the AI planner is grounded on — the website
// browsing them and the model recommending them are looking at one catalog, not
// two, which is why the destination activities endpoint runs the very same
// ranked search the planner's tool does.
//
// Nothing here documents a 401. Nothing here checks a token; the price of a
// public beach is not a secret. Nothing documents a 403 either: there is no
// entitlement wall on browsing, only on generating.
//
// Unpublished rows are invisible rather than forbidden. A draft is not listed,
// not counted in `activityCount`, and 404s when addressed directly — the same
// answer an id we have never issued gets, so neither can be told from the other.
// ─────────────────────────────────────────────────────────────────────────────

const CATALOG = ['Catalog'] as const

/** Repeated on every catalog endpoint that takes a query string. */
const MALFORMED_QUERY =
  'A query parameter failed validation — a non-numeric `limit`, an out-of-range bound, an ' +
  'unknown enum value. `details[].path` names the parameter.'

registerRoute({
  method: 'get',
  path: '/api/v1/destinations',
  operationId: 'listDestinations',
  summary: 'Destinations we sell',
  description:
    'The top of the catalog, and where a browse page or a planning session starts. The `slug` ' +
    'returned here is the key the activities endpoint takes.\n\n' +
    'Retired destinations are absent rather than flagged, so a client cannot forget to filter ' +
    'them. `activityCount` counts published activities only — advertising eleven things to do ' +
    'when three of them are drafts is a promise ops cannot keep.\n\n' +
    'Unpaginated by design: this is a curated list of places a Bangladeshi tour operator ' +
    'actually runs trips to, not a directory of the world.',
  tags: CATALOG,
  querySchema: DestinationListQuery,
  responses: {
    200: {
      schema: DestinationListResponse,
      description: 'Every active destination, in curated order.',
    },
    400: errorResponse(MALFORMED_QUERY),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/destinations/{slug}/activities',
  operationId: 'listDestinationActivities',
  summary: 'Ranked activities for one destination',
  description:
    'The same ranked search the AI planner runs through its `searchActivities` tool. One ' +
    'implementation on purpose: if browsing and planning ranked differently, a traveller would ' +
    'be shown one order on the website and another in their itinerary, and neither of us could ' +
    'say which was right.\n\n' +
    "Pass `interests` in the traveller's own words. Ranking is by how many of them a row's tags " +
    'answer, then by curated order; `matchedInterests` on each result says which ones hit, so a ' +
    'UI can explain the ordering rather than assert it.\n\n' +
    'A budget passed as `maxPricePerPersonBdt` does NOT drop activities with no listed price. ' +
    'Null price means free, or quoted case by case, and excluding those would hide every free ' +
    'sight from exactly the traveller who most wants one — read `priceNote`.\n\n' +
    '`total` is what passed the filters before `limit`. There is no cursor: at tens of ' +
    'activities per destination, a pagination contract we would owe forever is not worth it.',
  tags: CATALOG,
  querySchema: ActivitySearchQuery,
  responses: {
    200: {
      schema: DestinationActivitiesResponse,
      description: 'The destination, and its activities ranked against the requested interests.',
    },
    400: errorResponse(MALFORMED_QUERY),
    404: errorResponse(
      'No such destination, or it has been retired. The two are not distinguished. Note this is ' +
        'a 404 rather than an empty list: answering `200 { activities: [] }` for a place we do ' +
        'not go would read as "we go there, there is just nothing to do".'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/activities/{id}',
  operationId: 'getActivity',
  summary: 'One activity, in full',
  description:
    'Everything a detail page needs in one response: the long description, every image with its ' +
    'alt text, the interest tags, and the opening hours.\n\n' +
    "Opening hours are minutes from local midnight in the destination's timezone, with " +
    '`dayOfWeek` 0 = Sunday. A `closesMinute` above 1440 runs past midnight — 1560 is 02:00 the ' +
    'next morning. An EMPTY `openingHours` array means ALWAYS AVAILABLE, not closed: it is how a ' +
    'public beach or a viewpoint is recorded. Once any window exists, a weekday with none is ' +
    'closed that day.\n\n' +
    '`pricePerPersonBdt` is whole taka as an integer. There is no minor unit and no decimal ' +
    'place; null means free or price on request, and `priceNote` carries the nuance.',
  tags: CATALOG,
  responses: {
    200: { schema: PublicActivity, description: 'The activity.' },
    404: errorResponse(
      'No such activity, or it is not published. A malformed id answers 404 here too rather ' +
        'than 400 — the difference between "not a valid id" and "no such id" is a free oracle ' +
        'for anyone probing what our identifiers look like.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Planner conversations
//
// Everything here is a signed-in surface. The anonymous path is the teaser
// above: a fixed questionnaire, cached on its four answers, which is what makes
// it safe to expose and cheap to abuse. A free-form conversation reachable
// without an account would be an unmetered model call behind a route with no
// quota attached to it.
//
// A refusal that comes from the traveller's plan rather than from their request
// is always a 403 carrying ENTITLEMENT_REFUSAL's `details` entry. The one place
// that is NOT true is itinerary generation, where hitting the day cap is a
// partial success: the plan comes back with a `refusal` beside it on a 201.
// ─────────────────────────────────────────────────────────────────────────────

const ITINERARIES = ['Itineraries'] as const

const NOT_MY_SESSION =
  'No such planning session, or it belongs to another traveller. The two are deliberately ' +
  'indistinguishable — a 403 here would confirm that an id someone guessed is real.'

const NOT_MY_ITINERARY =
  'No such itinerary, or it belongs to another traveller. The two are deliberately ' +
  'indistinguishable, for the same reason a session is.'

registerRoute({
  method: 'post',
  path: '/api/v1/planner/sessions',
  operationId: 'createPlannerSession',
  summary: 'Start or resume a planning conversation',
  description:
    'Resuming is the default, and the reason is mundane: a traveller who reloads the page has ' +
    'not started a second trip. A new session per page load would scatter one conversation ' +
    'across a dozen rows and lose the accumulated brief each time. Send `resume: false` when the ' +
    'traveller explicitly asks to plan another trip.\n\n' +
    '201 means a session was created, 200 that an existing one was handed back; `resumed` in the ' +
    'body says the same thing for clients that would rather not branch on status.\n\n' +
    'Any `brief` sent here is folded into what we already know rather than replacing it. There ' +
    'is no way to clear a field: a client that forgets one must not be able to erase what the ' +
    'traveller said three turns ago.',
  tags: PLANNER,
  security: 'user',
  requestSchema: CreatePlannerSessionBody,
  responses: {
    201: { schema: PlannerSession, description: 'A new conversation.' },
    200: { schema: PlannerSession, description: 'The conversation already in progress.' },
    400: errorResponse(MALFORMED_BODY),
    401: errorResponse(
      'The bearer token is missing, malformed, expired or for the other audience.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/planner/sessions/{id}',
  operationId: 'getPlannerSession',
  summary: 'One conversation, with its history',
  description:
    'The full message history plus the brief accumulated so far. Ownership is part of the query ' +
    "rather than a check performed after it, so there is no path that reads another traveller's " +
    'session at all.\n\n' +
    'Token counts are per message, not per session, because the configured model can change ' +
    'mid-conversation and cost attribution has to survive that.',
  tags: PLANNER,
  security: 'user',
  responses: {
    200: { schema: PlannerSession, description: 'The conversation.' },
    401: errorResponse('Authentication is required.'),
    404: errorResponse(NOT_MY_SESSION),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/planner/sessions/{id}/messages',
  operationId: 'sendPlannerMessage',
  summary: 'Say something, and stream the reply',
  description:
    'Answers `text/event-stream`, NOT JSON. Each `data:` line carries one PlannerStreamEvent ' +
    'encoded as JSON — the schema below describes a single frame, not the whole body. Append ' +
    '`delta.text` as it arrives; `done` is the last frame unless the connection dropped.\n\n' +
    'Ignore frame types you do not recognise rather than treating them as errors. That is what ' +
    'lets a frame be added without a version bump.\n\n' +
    '`limit` is not a failure. It means a plan wall was reached mid-answer and should be ' +
    'rendered as an offer; the turn is still persisted and the conversation is still usable.\n\n' +
    'Everything that could refuse the turn — ownership, the prompt quota, the session token ' +
    'budget — is settled before the first byte, so a refusal arrives as an ordinary 4xx in the ' +
    'standard envelope rather than as a 200 whose body turns out to contain an error.',
  tags: PLANNER,
  security: 'user',
  requestSchema: PlannerMessageBody,
  responses: {
    200: {
      schema: PlannerStreamEvent,
      mediaType: 'text/event-stream',
      description: 'A stream of events. The schema describes ONE frame, not the response body.',
    },
    400: errorResponse(
      'The body failed validation, or the message was empty once structural markers were ' +
        'stripped from it.'
    ),
    401: errorResponse('Authentication is required.'),
    403: errorResponse(ENTITLEMENT_REFUSAL),
    404: errorResponse(NOT_MY_SESSION),
    429: errorResponse(
      'This conversation has spent its token budget. Start a new session to keep planning — the ' +
        'brief is not lost, it is on the itinerary you have already generated.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/planner/sessions/{id}/itinerary',
  operationId: 'materialiseItinerary',
  summary: 'Turn the brief into a real itinerary',
  description:
    'The itinerary comes back WITH the day allowance beside it, and that pairing is the product ' +
    'rule rather than a convenience. A FREE traveller who asked for seven days gets a genuinely ' +
    'good two-day plan plus a `refusal` explaining the rest and what would lift it — not a 403, ' +
    'and not a silent two-day answer that pretends nothing was cut.\n\n' +
    'Compare `generatedDays` with `requestedDays` to know whether a wall was hit. `totalDays` on ' +
    'the itinerary records the trip they asked for, not what we planned, so the unlock still has ' +
    'something to unlock.\n\n' +
    '`days` in the body is a request. The entitlement decides the length; a client-supplied day ' +
    'count is an opinion, never an input to enforcement.\n\n' +
    'A 403 here means the monthly generation allowance is spent — the one case with no partial ' +
    'plan to hand back.',
  tags: PLANNER,
  security: 'user',
  requestSchema: MaterialiseItineraryBody,
  responses: {
    201: {
      schema: MaterialiseItineraryResponse,
      description: 'The itinerary, and how much of it the entitlement allowed.',
    },
    400: errorResponse(
      'The body failed validation, or the brief has no destination yet — an itinerary cannot be ' +
        'built without one.'
    ),
    401: errorResponse('Authentication is required.'),
    403: errorResponse(ENTITLEMENT_REFUSAL),
    404: errorResponse(NOT_MY_SESSION),
    500: errorResponse(UNEXPECTED),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Itineraries
//
// Every route here is scoped to the owner inside the query, so a traveller can
// only ever reach their own. Somebody else's itinerary answers 404 rather than
// 403 throughout.
//
// The timeline is server-authoritative. A client sends what it wants and the
// server decides what happens: the day count comes from the entitlement, the
// activity has to resolve against the catalog, and `costBdt` is recomputed from
// the catalog price and the party size — it is never read from a request, since
// that would let the client set our prices.
//
// Conflicts are REPORTED, never resolved. A block that clashes is still
// accepted, because a traveller may know something about the road that we do
// not; the clash comes back in `conflicts` on the same response. Nothing is ever
// silently reordered.
// ─────────────────────────────────────────────────────────────────────────────

registerRoute({
  method: 'get',
  path: '/api/v1/itineraries',
  operationId: 'listItineraries',
  summary: "The traveller's own trips",
  description:
    'Summaries only. A list returning every day and every block would ship hundreds of ' +
    'kilobytes to render a dozen cards, and would make the practical page size a function of ' +
    "how detailed somebody's trips happen to be.\n\n" +
    'There is no parameter for whose trips to list. The user id comes from the token and goes ' +
    'straight into the WHERE clause, so there is nothing here to tamper with.\n\n' +
    '`total` counts everything matching the filter, ignoring `limit` and `offset`.',
  tags: ITINERARIES,
  security: 'user',
  querySchema: ItineraryListQuery,
  responses: {
    200: { schema: ItineraryListResponse, description: "This traveller's itineraries." },
    400: errorResponse(MALFORMED_QUERY),
    401: errorResponse('Authentication is required.'),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/itineraries/{id}',
  operationId: 'getItinerary',
  summary: 'One trip, in full, with its conflicts',
  description:
    'Every day, every block, and every conflict we can see. Times are minutes from local ' +
    "midnight in the destination's timezone: `startMinute` 540 is 09:00, and an `endMinute` " +
    'above 1440 runs past midnight.\n\n' +
    'A block with `isEstimate: true` is a transfer WE computed from straight-line distance — ' +
    'ours to redraw whenever the day changes. A block a person authored never carries the flag ' +
    'and is never touched by us.\n\n' +
    '`plannedDays` below `totalDays` means the plan stops at an entitlement wall rather than at ' +
    'the end of the trip.',
  tags: ITINERARIES,
  security: 'user',
  responses: {
    200: { schema: Itinerary, description: 'The itinerary.' },
    401: errorResponse('Authentication is required.'),
    404: errorResponse(NOT_MY_ITINERARY),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'patch',
  path: '/api/v1/itineraries/{id}',
  operationId: 'updateItinerary',
  summary: "Edit the trip's own fields",
  description:
    'Two fields ripple further than they look, which is why the whole itinerary comes back ' +
    'rather than an acknowledgement.\n\n' +
    'Moving `startDate` re-dates every day, changing which weekday each falls on and therefore ' +
    'which opening-hours warnings apply. Changing `transportPreference` re-estimates every ' +
    'transfer WE drew — and only those; a ferry the traveller typed in stays exactly where it ' +
    'is.\n\n' +
    'An omitted field is left alone. `null` is accepted only where the column is nullable, and ' +
    'means "clear it".',
  tags: ITINERARIES,
  security: 'user',
  requestSchema: UpdateItineraryBody,
  responses: {
    200: { schema: Itinerary, description: 'The itinerary as it now stands.' },
    400: errorResponse(MALFORMED_BODY),
    401: errorResponse('Authentication is required.'),
    404: errorResponse(NOT_MY_ITINERARY),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/itineraries/{id}/days/{day}/blocks',
  operationId: 'addItineraryBlock',
  summary: 'Put something on the timeline',
  description:
    '`day` is the 1-based day number, not a day id — it is what the traveller sees and what a ' +
    'drag-and-drop client already has to hand.\n\n' +
    'A block that clashes with another IS accepted. The traveller is allowed to build a day we ' +
    'believe is impossible, and our job is to say so rather than refuse: the whole itinerary ' +
    'comes back with `conflicts` populated, which makes the clash unmissable without making it ' +
    'an error.\n\n' +
    'What is refused: an ACTIVITY block with no `activityId`, an `activityId` on any other kind, ' +
    'and an activity that is not in the catalog or is no longer offered. That is the catalog ' +
    'rule at its last enforcement point — nothing outside our inventory can reach a plan.\n\n' +
    'Cost is never accepted from the caller. It is recomputed as the catalog price times the ' +
    'party size, in whole taka.',
  tags: ITINERARIES,
  security: 'user',
  requestSchema: CreateBlockBody,
  responses: {
    201: { schema: BlockMutationResponse, description: 'The block, and the itinerary around it.' },
    400: errorResponse(
      'The body failed validation, the day number is not a whole number, or the activity ' +
        'reference is missing, forbidden for this kind, or not in the catalog.'
    ),
    401: errorResponse('Authentication is required.'),
    404: errorResponse(`${NOT_MY_ITINERARY} Also returned when the itinerary has no such day.`),
    409: errorResponse('That day already holds the maximum number of blocks.'),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/itineraries/{id}/days/{day}/regenerate',
  operationId: 'regenerateItineraryDay',
  summary: 'Rebuild one day from the catalog',
  description:
    'Two properties matter to a traveller pressing "try this day again". Locked blocks survive — ' +
    'the day is planned AROUND them, never over them. And activities already used on the other ' +
    'days are excluded, so day 3 does not quietly become day 1 again.\n\n' +
    'A day beyond the entitlement is refused with the structured reason rather than generated. ' +
    "Day 5 of a free traveller's trip is precisely the wall the one-off unlock exists to lift.\n\n" +
    'Regeneration is deterministic and catalog-only: it places rows the catalog ranked, in the ' +
    'order it ranked them. It is not a model call, so it costs no AI budget.',
  tags: ITINERARIES,
  security: 'user',
  responses: {
    200: {
      schema: RegenerateDayResponse,
      description: 'The rebuilt itinerary, and the allowance that governed it.',
    },
    400: errorResponse('The day is not a whole number counting from 1.'),
    401: errorResponse('Authentication is required.'),
    403: errorResponse(ENTITLEMENT_REFUSAL),
    404: errorResponse(`${NOT_MY_ITINERARY} Also returned when the itinerary has no such day.`),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'patch',
  path: '/api/v1/itineraries/{id}/blocks/{blockId}',
  operationId: 'updateItineraryBlock',
  summary: 'Move, retime or pin a block',
  description:
    '`dayNumber` moves the block to another day of the same trip; omitting it leaves it where it ' +
    'is. Both the day it left and the day it arrived on have their estimated transfers redrawn.\n\n' +
    'Nothing else on the timeline moves. If the new position clashes, the clash is reported in ' +
    "`conflicts` and the block stays exactly where it was put — shuffling somebody's afternoon " +
    'to make our arithmetic work would produce a day nobody asked for.\n\n' +
    'Editing a block we generated makes it theirs: `isEstimate` is cleared, so a later resync can ' +
    'never delete the change.',
  tags: ITINERARIES,
  security: 'user',
  requestSchema: UpdateBlockBody,
  responses: {
    200: { schema: BlockMutationResponse, description: 'The itinerary as it now stands.' },
    400: errorResponse(
      'The body failed validation, or the requested times are outside the permitted range.'
    ),
    401: errorResponse('Authentication is required.'),
    404: errorResponse(
      `${NOT_MY_ITINERARY} Also returned when the block is not part of this itinerary, or the ` +
        'target day does not exist.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'delete',
  path: '/api/v1/itineraries/{id}/blocks/{blockId}',
  operationId: 'deleteItineraryBlock',
  summary: 'Take a block off the timeline',
  description:
    'Answers with the updated itinerary rather than 204. Removing a block changes the transfers ' +
    'around it, and a client given no body would have to refetch immediately to draw the ' +
    'timeline correctly.',
  tags: ITINERARIES,
  security: 'user',
  responses: {
    200: { schema: Itinerary, description: 'The itinerary without that block.' },
    401: errorResponse('Authentication is required.'),
    404: errorResponse(
      `${NOT_MY_ITINERARY} Also returned when the block is not part of this itinerary.`
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/itineraries/{id}/save',
  operationId: 'saveItinerary',
  summary: 'Keep this trip',
  description:
    'A DRAFT is work in progress and occupies no allowance; saving is what claims one of the ' +
    "free tier's three slots. That is why the check lives here rather than at creation — a " +
    'traveller who tries four ideas and keeps three has not exceeded anything.\n\n' +
    'Re-saving an itinerary that is already kept succeeds and changes nothing. It is not a ' +
    'fourth of three, and refusing it would leave an account at its cap unable to touch the ' +
    'trips it already has.\n\n' +
    '`remaining` is what is left of the allowance afterwards, or null on a plan with no cap.',
  tags: ITINERARIES,
  security: 'user',
  responses: {
    200: { schema: SaveItineraryResponse, description: 'The itinerary, now kept.' },
    401: errorResponse('Authentication is required.'),
    403: errorResponse(ENTITLEMENT_REFUSAL),
    404: errorResponse(NOT_MY_ITINERARY),
    500: errorResponse(UNEXPECTED),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Payments
//
// Two things about this group are worth reading before the operations.
//
// THE CLIENT NEVER NAMES A PRICE. `CheckoutBody` has no amount field, and an
// amount sent anyway is dropped by the schema before a handler sees it. The
// server reads the figure from the Plan row or the unlock-price setting on
// every call, and `CheckoutResponse.amountBdt` reports what will actually be
// charged. A client that wants to show a price should render that number, not
// one it sent.
//
// THE SANDBOX IS REAL BUT NOT MONEY. `provider: "MOCK"` and `isTest: true` mark
// payments taken by the simulated gateway. They settle on a button press and
// grant genuine entitlements — an ItineraryUnlock, a Subscription — so any
// client rendering a payment page MUST say so unmissably when `isTest` is true.
// The gateway refuses to run under NODE_ENV=production unless two separate
// environment flags both permit it, so these operations answer 403 there by
// default.
// ─────────────────────────────────────────────────────────────────────────────

const PAYMENTS = ['Payments'] as const

const NOT_MY_PAYMENT =
  'No such payment, or it belongs to another traveller. The two are deliberately ' +
  'indistinguishable, for the same reason an itinerary is.'

registerRoute({
  method: 'post',
  path: '/api/v1/payments/checkout',
  operationId: 'openCheckout',
  summary: 'Start a purchase',
  description:
    'Creates a payment and returns somewhere to pay it. The body says WHAT is being bought; it ' +
    'cannot say what that costs. There is no amount field, one sent anyway is stripped before ' +
    'validation, and the price is read server-side from the Plan row or the unlock-price ' +
    'setting — `amountBdt` in the response is what will be charged.\n\n' +
    'The two purposes are not interchangeable. `ITINERARY_UNLOCK` takes an `itineraryId` you own ' +
    'and buys the full length of that one trip, permanently. `SUBSCRIPTION` takes a `planCode` ' +
    'naming a plan that is on sale AND billed monthly.\n\n' +
    'UNLOCK_SINGLE is refused here with a 400. It is a price, not a tier: granting it as a ' +
    'subscription would turn one 200 BDT payment into an account-wide upgrade, so a checkout for ' +
    'any plan whose interval is NONE is rejected rather than quietly downgraded.\n\n' +
    '`redirectUrl` is absolute and points at the public website, not at this API. Send the ' +
    'browser there, then poll GET /api/v1/payments/{id}.',
  tags: PAYMENTS,
  security: 'user',
  requestSchema: CheckoutBody,
  responses: {
    201: {
      schema: CheckoutResponse,
      description: 'The payment was created. Nothing has been charged or granted yet.',
    },
    400: errorResponse(
      `${MALFORMED_BODY} Also returned when \`itineraryId\` is missing for an unlock, when ` +
        '`planCode` is missing for a subscription, or when the named plan is a one-off price ' +
        'rather than a monthly tier.'
    ),
    401: errorResponse('Authentication is required.'),
    403: errorResponse(
      'The configured gateway refuses to open a checkout here. For the sandbox provider that ' +
        'means PAYMENTS_MOCK_ENABLED is off, or NODE_ENV is production without ' +
        'PAYMENTS_ALLOW_MOCK_IN_PRODUCTION also set. The message names both flags.'
    ),
    404: errorResponse(
      'The itinerary was not found or belongs to another traveller, or no such plan is on sale. ' +
        'A retired plan answers the same as a code that was never issued.'
    ),
    409: errorResponse('That itinerary is already unlocked in full — there is nothing to buy.'),
    429: errorResponse('Too many checkouts started by this account in the last hour.'),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/payments/mock/{paymentId}/complete',
  operationId: 'completeMockPayment',
  summary: 'Settle a sandbox payment',
  description:
    "The simulated gateway's Pay / Decline / Cancel button. Stands in for the callback a real " +
    'provider would send, and exists so the purchase flow can be exercised end to end without a ' +
    'merchant account.\n\n' +
    'SAFE TO CALL TWICE, and clients should assume they will. The settlement is a conditional ' +
    "update predicated on the payment's current status, so a second completion grants nothing " +
    'and returns exactly the body the first one did — `grant` included, because it is read back ' +
    'from the entitlement rather than reported by the settlement. A double-clicked Pay button ' +
    'buys one unlock.\n\n' +
    'On SUCCESS the entitlement is granted in the SAME transaction that marks the payment ' +
    'SUCCEEDED: an ItineraryUnlock for that trip, or a Subscription running one month from now. ' +
    'FAILURE and CANCEL both end in a FAILED payment and grant nothing; they are distinguished ' +
    'because a decline and an abandonment are different facts about a funnel.\n\n' +
    "Reaches only payments this traveller owns AND that the sandbox created. A real gateway's " +
    'payment is not settleable here at any price.',
  tags: PAYMENTS,
  security: 'user',
  requestSchema: MockCompletionBody,
  responses: {
    200: {
      schema: PaymentCompletionResponse,
      description:
        'The payment in its final state, and what it granted. Identical on a repeated call.',
    },
    400: errorResponse(MALFORMED_BODY),
    401: errorResponse('Authentication is required.'),
    403: errorResponse(
      'The sandbox gateway is not permitted here. PAYMENTS_MOCK_ENABLED is off, or NODE_ENV is ' +
        'production without PAYMENTS_ALLOW_MOCK_IN_PRODUCTION also set — it grants real ' +
        'entitlements without taking real money, so it takes two independent flags to run there. ' +
        'The message names both.'
    ),
    404: errorResponse(
      `${NOT_MY_PAYMENT} Also returned when the payment was created by a real gateway rather ` +
        'than the sandbox, which this route may not settle.'
    ),
    409: errorResponse(
      'The payment can no longer be settled — its account was deleted, or the plan behind it is ' +
        'not a subscription tier.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/payments/{id}',
  operationId: 'getPayment',
  summary: 'One payment, for polling',
  description:
    'Where a payment has got to. The client sent the traveller off to a gateway and has no other ' +
    'way to learn the outcome — the settlement arrives as a callback on the server, not as a ' +
    'reply to anything the browser is holding open.\n\n' +
    'While a payment is still in flight its status is confirmed with the provider before being ' +
    'reported, rather than read from our row alone: callbacks get lost, and "pending" shown for a ' +
    'payment that cleared ten minutes ago is how a support queue fills up. A terminal status is ' +
    'reported as it stands.\n\n' +
    '`rawPayload` and `idempotencyKey` are never published. The first is a verbatim gateway body ' +
    'and the second is what stops a replayed callback granting twice.',
  tags: PAYMENTS,
  security: 'user',
  responses: {
    200: { schema: PaymentDetail, description: 'The payment.' },
    401: errorResponse('Authentication is required.'),
    404: errorResponse(NOT_MY_PAYMENT),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/me/payments',
  operationId: 'listMyPayments',
  summary: "The traveller's own payments",
  description:
    'Payment history, newest first. There is no parameter for whose payments to list: the user ' +
    'id comes from the token and goes straight into the query.\n\n' +
    'Sandbox payments ARE included, flagged by `isTest`. They granted real entitlements, so ' +
    'hiding them would leave somebody looking at an unlocked trip with nothing in their history ' +
    'to explain it. Test rows are filtered in the admin console and in revenue reporting, where ' +
    'the question is about money rather than about what somebody owns.\n\n' +
    '`total` counts everything matching, ignoring `limit` and `offset`.',
  tags: PAYMENTS,
  security: 'user',
  querySchema: PaymentListQuery,
  responses: {
    200: { schema: PaymentListResponse, description: "This traveller's payments." },
    400: errorResponse(MALFORMED_QUERY),
    401: errorResponse('Authentication is required.'),
    500: errorResponse(UNEXPECTED),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Discover
//
// The public trip catalogue and the poll beside it. Everything here is
// unauthenticated: these are the pages a stranger lands on from a search
// result, and requiring a token to read them would be requiring one to be
// indexed.
//
// Two of the three write, and neither takes a session. `interest` and `vote`
// are open on purpose — an account before you may say "I'd come on this" loses
// exactly the people the list is for — so each carries its own rate limit and
// its own uniqueness constraint instead. The 429s below are not boilerplate.
// ─────────────────────────────────────────────────────────────────────────────

const DISCOVER = ['Discover'] as const
const POLLS = ['Polls'] as const

registerRoute({
  method: 'get',
  path: '/api/v1/packages',
  operationId: 'listPackages',
  summary: 'The Discover catalogue',
  description:
    'Trips designed in advance, as opposed to the ones the planner builds on demand. Only ' +
    'PUBLISHED rows are ever returned — drafts are absent rather than flagged, so no client has ' +
    'to remember to filter them.\n\n' +
    '`scope` is optional and the website omits it: both tabs arrive in one response and the ' +
    'Domestic/International split happens client-side, so switching tabs costs no request. A ' +
    'mobile client on a slow connection can ask for one scope instead.\n\n' +
    'Two counts on each card look alike and are not. `registeredCount` is people on the interest ' +
    'list; `nextDeparture.seatsTaken` is seats actually held on a dated departure. An interest ' +
    'is a lead, a seat is a commitment, and they are never added together.',
  tags: DISCOVER,
  querySchema: PackageListQuery,
  responses: {
    200: { schema: PackageListResponse, description: 'Published packages, in curator order.' },
    400: errorResponse(MALFORMED_QUERY),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/packages/{slug}',
  operationId: 'getPackage',
  summary: 'One trip, in full',
  description:
    'The day-by-day ships with this response rather than behind a second call: for a package the ' +
    'itinerary IS the product description. The leaders do too — "who is running this" is a reason ' +
    'people book a group trip, not a detail they go looking for afterwards.\n\n' +
    '`departures` covers everything from today onwards, CANCELLED entries included. Somebody who ' +
    'had that date in mind should see it was cancelled rather than find it quietly missing.\n\n' +
    'A DRAFT slug answers 404, identically to a slug that does not exist. A trip ops has not ' +
    'published is not a secret, but it is not an announcement either.',
  tags: DISCOVER,
  responses: {
    200: { schema: PackageDetailResponse, description: 'The trip, its itinerary and its people.' },
    404: errorResponse('No published trip has this slug.'),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/packages/{slug}/interest',
  operationId: 'registerPackageInterest',
  summary: 'Join a trip’s interest list',
  description:
    'The join list for a trip we have not costed yet, and the enquiry list for one we have. No ' +
    'account required, deliberately.\n\n' +
    'Idempotent on (trip, email). Registering twice is a double-click or a correction, not two ' +
    'travellers — so a repeat call UPDATES the details and answers `created: false`. That matters ' +
    'because `registeredCount` is printed on a public card, and a duplicate would inflate the ' +
    'exact number the feature exists to communicate.\n\n' +
    '`departureId` is validated against THIS trip. A departure id belonging to another package ' +
    'is a 404 rather than a silently mis-filed lead.\n\n' +
    'A traveller token is optional. Sending one attaches the account to the row, which is how ops ' +
    'sees that a lead is already a customer; it does not replace the address they typed.',
  tags: DISCOVER,
  requestSchema: RegisterInterestBody,
  responses: {
    200: {
      schema: RegisterInterestResponse,
      description: 'Registered, or the existing registration updated.',
    },
    400: errorResponse(MALFORMED_BODY),
    404: errorResponse('No published trip has this slug, or that departure is not on it.'),
    409: errorResponse('That departure has been cancelled or has already run.'),
    429: errorResponse(
      'Too many registrations from this network in the last hour. The limit counts resolved edge ' +
        'addresses; callers whose address cannot be resolved share one pool.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/polls/active',
  operationId: 'getActivePoll',
  summary: 'The poll running right now, if there is one',
  description:
    'Answers `{ poll: null }` rather than 404 when nothing is running: a site with no poll is a ' +
    'normal state, not a failed request, and the section renders nothing at all in that case.\n\n' +
    'RESULTS ARE OMITTED, NOT HIDDEN. Until this viewer has voted, every `votes` and `share` is ' +
    '`null` and `resultsVisible` is false. Shipping the tallies alongside a flag would put them ' +
    'one devtools tab away, and "results after voting" would be decoration rather than a rule. ' +
    'Null means withheld; it never means zero.\n\n' +
    'Results do become visible without voting in two cases: a poll configured to show them up ' +
    'front, and a poll that has closed — otherwise a finished poll would stay a locked box for ' +
    'everyone who never got round to it.\n\n' +
    'Recognition is by visitor cookie alone and creates nothing. A browser we do not recognise ' +
    'simply reads as "has not voted".',
  tags: POLLS,
  responses: {
    200: { schema: ActivePollResponse, description: 'The open poll, or null.' },
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/polls/{slug}/vote',
  operationId: 'castPollVote',
  summary: 'Vote, once',
  description:
    'One vote per voter is a UNIQUE constraint in Postgres, not a check in application code. A ' +
    'poll whose numbers can be inflated by opening a second tab is a poll whose numbers are ' +
    'worthless.\n\n' +
    'A second vote is NOT an error: it answers 200 with `counted: false` and the results, which ' +
    'is what a returning visitor wanted anyway. So does voting on a poll that closed while the ' +
    'page was open.\n\n' +
    'A signed-in caller is identified by their account. Everyone else is identified by the union ' +
    'of cookie, hashed edge address and `deviceFingerprint` — a hit on any one is the same ' +
    'person. A caller matching none of the three is refused with 400: a voter with no identity ' +
    'can vote any number of times.\n\n' +
    'Signing in after voting anonymously produces a different voter identity, deliberately. The ' +
    'alternative would refuse a genuine first vote from a new account because a stranger on the ' +
    'same office router had already voted.',
  tags: POLLS,
  requestSchema: CastVoteBody,
  responses: {
    200: {
      schema: CastVoteResponse,
      description: 'The vote was counted, or had already been cast. Results included either way.',
    },
    400: errorResponse(
      'The body failed validation, or this browser could not be identified well enough to count ' +
        'a vote.'
    ),
    404: errorResponse('No poll has this slug, or that option is not on it.'),
    429: errorResponse('Too many votes from this network in the last hour.'),
    500: errorResponse(UNEXPECTED),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Past trips
//
// The public record of what we have already run. Unauthenticated, like the rest
// of Discover — these are pages people arrive at from a search result, and the
// reviews on them are the reason somebody books.
// ─────────────────────────────────────────────────────────────────────────────

const PAST_TRIPS = ['Past trips'] as const

registerRoute({
  method: 'get',
  path: '/api/v1/past-trips',
  operationId: 'listPastTrips',
  summary: 'Trips we have already run',
  description:
    'Published trips, most recent first — ordered by the date the trip STARTED rather than the ' +
    'date it was written up, because a trip published six months late is still a trip from six ' +
    'months ago.\n\n' +
    '`overallAverage` is the only single figure this API computes, and it exists for the card. It ' +
    'is a mean of the per-axis means rather than of every score, so an axis two people answered ' +
    'cannot swing it and an axis everybody answered cannot dominate it. Null until somebody has ' +
    'reviewed — never 0.\n\n' +
    '`memberCount` is how many travelled. The participants themselves are never published: naming ' +
    'fourteen people would put a social graph on a public page that none of them agreed to.',
  tags: PAST_TRIPS,
  responses: {
    200: { schema: PastTripListResponse, description: 'Published trips, newest first.' },
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/past-trips/{slug}',
  operationId: 'getPastTrip',
  summary: 'One trip, as it actually went',
  description:
    'The whole record in one response: the story, the highlights, the approved gallery, every ' +
    'approved review with its own scores, and the per-dimension averages.\n\n' +
    'HIGHLIGHTS INCLUDE INCIDENTS. `TripHighlightKind.INCIDENT` is the thing that went wrong — the ' +
    'cancelled ferry, the failed generator, the animal nobody saw — and it is published beside ' +
    'the sunrise on purpose. A record containing only the good parts is a brochure, and readers ' +
    'discount brochures entirely.\n\n' +
    'RATINGS ARE PER AXIS, NOT A STAR. `ratingSummary` carries one entry for each dimension ' +
    'anybody has rated, with its own average and its own response count, and there is deliberately ' +
    'no overall score in this response. A trip with superb guiding and poor transport averages to ' +
    'something unremarkable, and that single number hides the two facts a reader would decide on.\n\n' +
    'Unapproved photographs and reviews are ABSENT rather than flagged — the filter is a WHERE ' +
    'clause, not a field a client is trusted to check. A DRAFT slug answers 404, identically to a ' +
    'slug that does not exist.',
  tags: PAST_TRIPS,
  responses: {
    200: {
      schema: PastTripDetailResponse,
      description: 'The trip, its highlights, its gallery and its reviews.',
    },
    404: errorResponse('No published trip has this slug.'),
    500: errorResponse(UNEXPECTED),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Booking a departure
//
// The commerce half of Discover. A quote is free and anonymous; holding seats
// needs an account; paying goes through the same checkout every other purchase
// uses, with `purpose: BOOKING`.
// ─────────────────────────────────────────────────────────────────────────────

const BOOKINGS = ['Bookings'] as const

const NO_AMOUNT_IN_BODY =
  'No request body on this endpoint carries an amount, a unit price, a discount or a total. The ' +
  'client names a departure, a party size and at most a promo code; every figure comes back from ' +
  'the server, which reads the departure price and the coupon terms itself.'

registerRoute({
  method: 'post',
  path: '/api/v1/packages/{slug}/bookings/quote',
  operationId: 'quoteBooking',
  summary: 'What would these seats cost?',
  description:
    'Prices a party on a departure and applies a promo code if one is sent. Writes nothing — no ' +
    'booking, no redemption, and no seat held.\n\n' +
    'A REFUSED CODE STILL RETURNS A PRICE. `couponRefusal` is populated, `coupon` is null and the ' +
    'total is undiscounted. Answering 400 would blank the price while somebody is halfway through ' +
    'typing a code; the booking endpoint refuses the same code properly, so nothing can be bought ' +
    'at the wrong price.\n\n' +
    'Refusal reasons are a closed vocabulary — UNKNOWN, INACTIVE, NOT_STARTED, EXPIRED, ' +
    'WRONG_PACKAGE, BELOW_MIN_SPEND, FULLY_REDEEMED, ALREADY_USED. Branch on the reason, not the ' +
    'message.\n\n' +
    'No session required. Somebody deciding whether a trip is affordable has not signed in yet — ' +
    'the per-account redemption ceiling then cannot bind, which is why a code relying on ' +
    '`maxPerUser` should also carry `maxRedemptions`.\n\n' +
    NO_AMOUNT_IN_BODY,
  tags: BOOKINGS,
  requestSchema: QuoteBody,
  responses: {
    200: { schema: QuoteResponse, description: 'The price, and how the code fared.' },
    400: errorResponse(MALFORMED_BODY),
    404: errorResponse('No published trip has this slug, or that departure is not on it.'),
    409: errorResponse(
      'That departure is cancelled or already run, or the trip has no price set — an ' +
        'INTEREST_ONLY trip cannot be booked and answers here rather than pretending to quote.'
    ),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'post',
  path: '/api/v1/packages/{slug}/bookings',
  operationId: 'createBooking',
  summary: 'Hold the seats',
  description:
    'Creates a booking in PENDING_PAYMENT and claims its seats immediately, before anybody pays. ' +
    'Send the returned `bookingId` to POST /api/v1/payments/checkout with `purpose: BOOKING`.\n\n' +
    'SEATS ARE HELD NOW, NOT AT SETTLEMENT. Claiming on payment would let two travellers both ' +
    'reach a payment page for the last seat, and one of them would pay for something that no ' +
    'longer exists. The claim is a single UPDATE whose WHERE clause compares `seatsTaken + n` ' +
    'against `capacity`, so of two concurrent requests for one seat exactly one succeeds and the ' +
    'other gets a 409.\n\n' +
    'Unlike the quote, a promo code that does not apply is a 400 here: charging the full price for ' +
    'a booking somebody submitted expecting a discount is the one outcome nobody would forgive.\n\n' +
    'A session IS required, unlike registering interest. This holds inventory and creates ' +
    'something that will be charged, so it needs an owner — and an anonymous seat hold is free ' +
    'denial-of-service against a departure.\n\n' +
    'Every figure comes back in the response: unit price, subtotal, discount and total. Render ' +
    'those rather than recomputing, so what is shown and what is charged cannot disagree.',
  tags: BOOKINGS,
  security: 'user',
  requestSchema: CreateBookingBody,
  responses: {
    201: { schema: CreateBookingResponse, description: 'Seats held. Nothing is paid yet.' },
    400: errorResponse(
      'The body failed validation, or the promo code sent does not apply — `details[].path` is ' +
        '`couponCode` and the message names the reason.'
    ),
    401: errorResponse('Authentication is required.'),
    404: errorResponse('No published trip has this slug, or that departure is not on it.'),
    409: errorResponse(
      'Not enough seats left for that party, or the departure is cancelled, already run, or ' +
        'uncosted.'
    ),
    429: errorResponse('Too many bookings started from this account in the last hour.'),
    500: errorResponse(UNEXPECTED),
  },
})

registerRoute({
  method: 'get',
  path: '/api/v1/me/bookings',
  operationId: 'listMyBookings',
  summary: 'The traveller’s own bookings',
  description:
    'Newest first. There is no parameter for whose bookings to list: the user id comes from the ' +
    'token and goes straight into the query.\n\n' +
    'Every booking carries the figures it was MADE with rather than today’s price. A departure ' +
    'repriced next week does not restate a receipt, and an expired coupon does not retroactively ' +
    'raise a total.\n\n' +
    '`bookedAt` and `confirmedAt` are two different dates: when the seats were held, and when the ' +
    'money landed. The second is null while a booking is still awaiting payment.',
  tags: BOOKINGS,
  security: 'user',
  responses: {
    200: { schema: BookingListResponse, description: 'This traveller’s bookings.' },
    401: errorResponse('Authentication is required.'),
    500: errorResponse(UNEXPECTED),
  },
})
