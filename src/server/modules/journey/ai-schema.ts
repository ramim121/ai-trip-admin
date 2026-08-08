import { z } from 'zod'

/**
 * What each journey prompt is allowed to return.
 *
 * THE SCHEMA IS THE ENFORCEMENT, NOT THE PROMPT. A system prompt is a strong
 * request; a schema is a contract the SDK refuses to break. Every product rule
 * that CAN be expressed as a shape is expressed here rather than asked for in
 * prose — six suggestions and not sixty, fifteen words and not a paragraph,
 * three questions and not an interrogation — so a model which ignored its
 * instructions entirely still cannot produce something the interface will not
 * render.
 *
 * Everything is re-parsed after the call as well: `generateObject` is handed
 * these schemas, but structured output is a hint to a provider rather than a
 * guarantee from one.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 7.1 Intake parser
// ─────────────────────────────────────────────────────────────────────────────

/** A tappable answer. Never free text — the point is that nobody has to type. */
export const ChipSchema = z.object({
  label: z.string().trim().min(1).max(60),
  /** What this chip means for the field it answers. */
  value: z.string().trim().min(1).max(120),
})

export const MissingFieldSchema = z.object({
  field: z.enum(['destinations', 'durationDays', 'dates', 'party', 'budget']),
  question: z.string().trim().min(1).max(160),
  /**
   * The last chip is always an escape.
   *
   * Not politeness: somebody who does not know their budget yet has to be able
   * to continue, or the funnel loses them at the question they could not answer.
   */
  chips: z.array(ChipSchema).min(2).max(5),
})

export const ParsedTripSchema = z.object({
  destinations: z.array(z.string().trim().min(1).max(80)).max(6),
  durationDays: z.number().int().min(1).max(60).nullable(),
  dateBucket: z.enum(['NEXT_WEEK', 'TWO_TO_FOUR_WEEKS', 'NEXT_MONTH', 'CUSTOM']).nullable(),
  /** `YYYY-MM-DD`, only when the traveller gave real dates. */
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  partyAdults: z.number().int().min(1).max(40).nullable(),
  partyChildren: z.number().int().min(0).max(40).nullable(),
  partyType: z.string().trim().max(40).nullable(),
  tripType: z.string().trim().max(60).nullable(),
  interests: z.array(z.string().trim().min(1).max(40)).max(12),
  /** Whole taka. A lakh is 100000. */
  budgetMinBdt: z.number().int().min(0).max(100_000_000).nullable(),
  budgetMaxBdt: z.number().int().min(0).max(100_000_000).nullable(),
  budgetScope: z.enum(['TOTAL_TRIP', 'PER_PERSON', 'PER_NIGHT']).nullable(),
  /**
   * At most three, because this runs before anybody has signed in — and an
   * interrogation at the top of a funnel is how the funnel empties.
   */
  missing: z.array(MissingFieldSchema).max(3),
})

export type ParsedTrip = z.infer<typeof ParsedTripSchema>

// ─────────────────────────────────────────────────────────────────────────────
// 7.2 Skeleton
// ─────────────────────────────────────────────────────────────────────────────

export const SkeletonItemSchema = z.object({
  slot: z.enum(['MORNING', 'AFTERNOON', 'EVENING']),
  type: z.enum(['ACTIVITY', 'STAY', 'FOOD', 'TRANSFER']),
  /**
   * A kind of thing, never a business.
   *
   * "Seafood dinner by the water" is a placeholder. A real restaurant name is an
   * invention even when the restaurant exists — the model has no way to know we
   * can sell it, and a specific name in a draft reads as a recommendation.
   */
  title: z.string().trim().min(1).max(120),
  /** What we type into the tour and place search to make it real. */
  searchQuery: z.string().trim().min(1).max(120),
  /**
   * Minutes — a hint for slot packing, refined when a real option is picked.
   *
   * ZERO IS ACCEPTED AND MEANS "NOT APPLICABLE". A stay has no duration:
   * checking into a hotel is not a fifteen-minute activity, and the model
   * reasonably says so with a 0 rather than inventing a length. A floor of 15
   * rejected every draft containing a hotel, which is every draft.
   *
   * Normalised to null here so nothing downstream has to know that 0 and null
   * mean the same thing — the conflict checker treats null as "floats within its
   * slot", which is exactly right for a stay.
   */
  durationMin: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .nullable()
    .transform((value) => (value === null || value < 15 ? null : value)),
})

export const SkeletonDaySchema = z.object({
  dayNumber: z.number().int().min(1).max(60),
  theme: z.string().trim().min(1).max(80),
  /**
   * Where the traveller is that day.
   *
   * LOAD-BEARING FOR TRANSFERS. Gap-cards are found by noticing that consecutive
   * items are in different places, so without a per-day location every item on a
   * multi-city trip inherits the first city and the gaps are nonsense — a
   * Phuket-and-Krabi trip showed three transfers, all in the wrong direction,
   * until this existed.
   */
  location: z.string().trim().min(1).max(80),
  /** Capped at four, so pace is enforced by shape rather than asked for in prose. */
  items: z.array(SkeletonItemSchema).min(1).max(4),
})

export const SkeletonSchema = z.object({ days: z.array(SkeletonDaySchema).min(1).max(60) })

export type Skeleton = z.infer<typeof SkeletonSchema>

// ─────────────────────────────────────────────────────────────────────────────
// 7.3 Preference brief
// ─────────────────────────────────────────────────────────────────────────────

export const BriefConstraintsSchema = z.object({
  starMin: z.number().int().min(1).max(5).nullable(),
  locationHints: z.array(z.string().trim().min(1).max(80)).max(8),
  budgetPerNightMinBdt: z.number().int().min(0).max(10_000_000).nullable(),
  budgetPerNightMaxBdt: z.number().int().min(0).max(10_000_000).nullable(),
  amenities: z.array(z.string().trim().min(1).max(40)).max(12),
  /** Anything real that fits no other field — not a dumping ground for prose. */
  notes: z.array(z.string().trim().min(1).max(160)).max(8),
})

export const CuratedBriefSchema = z.object({
  constraints: BriefConstraintsSchema,
  /** At most twenty-five words: what the chips say, as one actionable sentence. */
  summary: z.string().trim().min(1).max(220),
  /** Three things they are plausibly about to want. */
  refinementChips: z.array(z.string().trim().min(1).max(50)).max(4),
})

export type CuratedBrief = z.infer<typeof CuratedBriefSchema>

// ─────────────────────────────────────────────────────────────────────────────
// 7.4 Ranker
// ─────────────────────────────────────────────────────────────────────────────

export const RankedChoiceSchema = z.object({
  /** The candidate's id, exactly as given. */
  id: z.string().trim().min(1).max(80),
  /**
   * At most fifteen words, echoing the traveller's own phrasing.
   *
   * The length cap IS the product rule. A paragraph of justification reads as a
   * sales pitch; one line quoting them back reads as having been listened to,
   * which is the entire effect being bought here.
   */
  matchReason: z.string().trim().min(1).max(120),
  /** Substrings of `matchReason` that came from the brief, for highlighting. */
  echoedPhrases: z.array(z.string().trim().min(1).max(60)).max(6),
})

export const RankedBatchSchema = z.object({
  /** Six, because choice overload is what stops an itinerary getting finished. */
  choices: z.array(RankedChoiceSchema).max(6),
  /**
   * Named only when fewer than three fit.
   *
   * Turns a dead end into a next step: "nothing under ৳4,000 has a pool" is
   * something a traveller can act on, where "no results" is not.
   */
  constraintWorthRelaxing: z.string().trim().max(160).nullable(),
})

export type RankedBatch = z.infer<typeof RankedBatchSchema>

// ─────────────────────────────────────────────────────────────────────────────
// 7.5 Transfer
// ─────────────────────────────────────────────────────────────────────────────

export const TransferOptionSchema = z.object({
  mode: z.enum(['bus', 'train', 'minivan', 'private_car', 'taxi', 'ferry', 'flight']),
  durationMinMinutes: z.number().int().min(5).max(2880),
  durationMaxMinutes: z.number().int().min(5).max(2880),
  priceMinBdt: z.number().int().min(0).max(10_000_000),
  priceMaxBdt: z.number().int().min(0).max(10_000_000),
  pricePer: z.enum(['person', 'vehicle']),
  /**
   * `high` only for rows that came from our own route table.
   *
   * The distinction is shown to the traveller, so it has to mean something: the
   * agency has sold this route and knows the price, or it has not and this is a
   * guess. Letting the model claim high confidence for its own estimate would
   * make the badge decorative.
   */
  confidence: z.enum(['high', 'low']),
  note: z.string().trim().max(160).nullable(),
})

export const TransferEstimateSchema = z.object({ options: z.array(TransferOptionSchema).max(3) })

export type TransferEstimate = z.infer<typeof TransferEstimateSchema>

// ─────────────────────────────────────────────────────────────────────────────
// 7.6 / 7.7 Chat
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the model may do to an itinerary.
 *
 * A CLOSED LIST, AND THAT IS THE POINT. The model proposes; the application
 * applies. Every action runs through the same validation a button press would,
 * so the model cannot write day 9 onto a seven-day trip — the database refuses
 * it either way, but the action is checked long before it gets that far.
 */
export const JourneyActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('updateTripBasics'),
    durationDays: z.number().int().min(1).max(60).nullable(),
    partyAdults: z.number().int().min(1).max(40).nullable(),
    partyChildren: z.number().int().min(0).max(40).nullable(),
    budgetMinBdt: z.number().int().min(0).max(100_000_000).nullable(),
    budgetMaxBdt: z.number().int().min(0).max(100_000_000).nullable(),
  }),
  z.object({
    action: z.literal('addItem'),
    dayNumber: z.number().int().min(1).max(60),
    slot: z.enum(['MORNING', 'AFTERNOON', 'EVENING']),
    itemType: z.enum(['ACTIVITY', 'STAY', 'FOOD', 'TRANSFER']),
    title: z.string().trim().min(1).max(120),
    searchQuery: z.string().trim().max(120).nullable(),
    durationMin: z.number().int().min(15).max(1440).nullable(),
  }),
  z.object({ action: z.literal('removeItem'), itemId: z.string().trim().min(1).max(80) }),
  z.object({
    action: z.literal('moveItem'),
    itemId: z.string().trim().min(1).max(80),
    dayNumber: z.number().int().min(1).max(60),
    slot: z.enum(['MORNING', 'AFTERNOON', 'EVENING']),
  }),
  z.object({
    action: z.literal('updateTime'),
    itemId: z.string().trim().min(1).max(80),
    startMinute: z.number().int().min(0).max(1439).nullable(),
    durationMin: z.number().int().min(15).max(1440).nullable(),
  }),
  z.object({
    action: z.literal('refineBrief'),
    pillar: z.enum(['STAY', 'ACTIVITY', 'FOOD', 'TRANSPORT']),
    location: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(400),
  }),
  z.object({ action: z.literal('regenerateDay'), dayNumber: z.number().int().min(1).max(60) }),
  z.object({ action: z.literal('answer') }),
])

export const PacingWarningSchema = z.object({
  dayNumber: z.number().int().min(1).max(60),
  /** One clause naming the problem — not a lecture about pacing in general. */
  message: z.string().trim().min(1).max(200),
  /** A specific fix the interface can offer as one tap. */
  suggestedFix: z.string().trim().max(160).nullable(),
})

export const ChatReplySchema = z.object({
  /** At most two sentences. The itinerary is the answer, not the prose. */
  reply: z.string().trim().min(1).max(400),
  actions: z.array(JourneyActionSchema).max(6),
  quickReplies: z.array(z.string().trim().min(1).max(50)).max(4),
  pacing: PacingWarningSchema.nullable(),
})

export type ChatReply = z.infer<typeof ChatReplySchema>

// ─────────────────────────────────────────────────────────────────────────────
// 7.8 Package elicitor
// ─────────────────────────────────────────────────────────────────────────────

export const ElicitorQuestionSchema = z.object({
  question: z.string().trim().min(1).max(160),
  /**
   * Every chip describes something present in the product data.
   *
   * `dimension` names which real difference the chip answers, so an answer
   * merges into the brief as a fact rather than as a sentence.
   */
  chips: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(90),
        dimension: z.string().trim().min(1).max(40),
        value: z.string().trim().min(1).max(80),
      })
    )
    .min(2)
    .max(6),
})

export const ElicitorSchema = z.object({
  /**
   * Null when the products do not meaningfully differ.
   *
   * Asking anyway would be a question with one real answer, which teaches a
   * traveller that the questions here are decoration.
   */
  question: ElicitorQuestionSchema.nullable(),
  /** Why nothing was worth asking, when there is no question. */
  reason: z.string().trim().max(160).nullable(),
})

export type Elicitor = z.infer<typeof ElicitorSchema>
