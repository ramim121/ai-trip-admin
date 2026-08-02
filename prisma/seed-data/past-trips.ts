import {
  ModerationStatus,
  PackageScope,
  PastTripStatus,
  ReviewDimension,
  TripHighlightKind,
  TripLeaderRole,
} from '@/generated/prisma/enums'

/**
 * Trips we have already run, with what people thought of them.
 *
 * Three of them, and the content is chosen to make the page prove its own point
 * rather than to look good:
 *
 *   Every trip has an INCIDENT. The Sundarbans one is that nobody saw a tiger.
 *   A past-trips page that records only the sunrise is a brochure, and the first
 *   thing a reader does with a brochure is discount all of it.
 *
 *   The ratings disagree with each other. Cox's Bazar scores well on guiding and
 *   poorly on transport; the Sundarbans scores superbly on the leader and
 *   moderately on accommodation, because a boat cabin is a boat cabin. Seed
 *   reviews that all said 5 would make seven dimensions look like decoration on
 *   a single star, which is exactly what they are not.
 *
 * REVIEWS NEED ACCOUNTS
 *
 * `TripReview.userId` is required — a review is only worth publishing if it came
 * from somebody we can show was on the trip. So this file also declares the
 * traveller accounts the reviews belong to, and the seed creates them the same
 * way it creates the demo traveller: skipped if already present, never
 * overwritten.
 */

export interface ReviewerSeed {
  email: string
  name: string
}

/**
 * `.local` is reserved by RFC 6762 and never resolves publicly, so these cannot
 * collide with — or accidentally send mail to — a real address.
 */
export const REVIEWERS: ReviewerSeed[] = [
  { email: 'rifat.karim@beyondborders.local', name: 'Rifat Karim' },
  { email: 'sadia.noor@beyondborders.local', name: 'Sadia Noor' },
  { email: 'arif.chowdhury@beyondborders.local', name: 'Arif Chowdhury' },
  { email: 'meherun.haque@beyondborders.local', name: 'Meherun Haque' },
]

/** Every axis, so a seeded review is never missing one and skewing an average. */
type Ratings = Record<ReviewDimension, number>

interface ReviewSeed {
  reviewerEmail: string
  headline: string
  body: string
  displayName?: string
  ratings: Ratings
}

interface HighlightSeed {
  kind: TripHighlightKind
  title: string
  body: string
  dayNumber?: number
}

interface MediaSeed {
  url: string
  alt: string
  caption?: string
}

interface LeaderSeed {
  slug: string
  role: TripLeaderRole
}

export interface PastTripSeed {
  slug: string
  title: string
  summary: string
  story: string
  /** The package this was a running of, when there is one. */
  packageSlug?: string
  destinationLabel: string
  country: string
  scope: PackageScope
  /**
   * Fixed calendar dates, NOT relative to the seed run — the opposite of a
   * departure.
   *
   * A departure has to be relative or a seeded catalogue quietly stops having
   * any upcoming dates. A past trip is the reverse: it only ever needs to be in
   * the past, and it already is. Making these relative meant the month in the
   * title drifted away from the month on the page every time somebody reseeded,
   * which is how "Sundarbans Expedition — January" ended up dated February.
   */
  startDate: string
  endDate: string
  memberCount: number
  heroImageUrl?: string
  leaders: LeaderSeed[]
  highlights: HighlightSeed[]
  media: MediaSeed[]
  reviews: ReviewSeed[]
}

export const PAST_TRIPS: PastTripSeed[] = [
  {
    slug: 'coxs-bazar-long-weekend-march',
    title: 'Cox’s Bazar Long Weekend — March',
    summary:
      'Fourteen travellers, three nights, and the one morning at Inani when the tide was exactly ' +
      'where it was supposed to be.',
    story:
      'The March departure ran full and ran well. Fourteen people, most of whom had been to Cox’s ' +
      'Bazar before and none of whom had seen Inani at low tide — which is the entire argument ' +
      'for doing it with somebody who reads a tide table.\n\n' +
      'The group was quick, which let us add Ramu on the way back from the Marine Drive rather ' +
      'than dropping it as we usually do. The Maheshkhali morning did not go to plan, and is ' +
      'written up below because it is the part people ask about.',
    packageSlug: 'coxs-bazar-long-weekend',
    destinationLabel: 'Cox’s Bazar',
    country: 'Bangladesh',
    scope: PackageScope.DOMESTIC,
    startDate: '2026-03-12',
    endDate: '2026-03-15',
    memberCount: 14,
    heroImageUrl: '/images/destinations/coxs-bazar-bangladesh.webp',
    leaders: [{ slug: 'nusrat-jahan', role: TripLeaderRole.LEADER }],
    highlights: [
      {
        kind: TripHighlightKind.MOMENT,
        title: 'Inani, forty minutes after low water',
        body:
          'The coral rock was fully out and the group had it to themselves for the better part of ' +
          'an hour before the first day-trip coaches arrived. This is the whole reason that day ' +
          'starts at eight rather than at ten.',
        dayNumber: 3,
      },
      {
        kind: TripHighlightKind.INCIDENT,
        title: 'The Maheshkhali boat was held for three hours',
        body:
          'A weather warning closed the channel on the last morning and the speedboats did not ' +
          'run until nearly eleven. We lost the temple hill and swapped in the Burmese Market, ' +
          'which is not the same thing and nobody pretended it was. Everyone still made the ' +
          'evening coach. Had the channel stayed closed we would have refunded that leg.',
        dayNumber: 4,
      },
      {
        kind: TripHighlightKind.MILESTONE,
        title: 'The fiftieth running of this trip',
        body:
          'March was the fiftieth time we have run the Cox’s Bazar long weekend since 2015, and ' +
          'the first with a full group of fourteen booked more than a month ahead.',
      },
    ],
    media: [
      {
        url: '/images/destinations/coxs-bazar-bangladesh.webp',
        alt: 'A wide beach at golden hour with low surf and a headland in the distance',
        caption: 'The walk south from Laboni, about an hour before sunset.',
      },
    ],
    reviews: [
      {
        reviewerEmail: 'rifat.karim@beyondborders.local',
        headline: 'The tide timing is not marketing, it is the trip',
        body:
          'I had been to Inani twice before on day trips and had genuinely no idea the rock ' +
          'formations were a thing — both times I arrived at midday and looked at a normal beach. ' +
          'Going at eight in the morning changed what the place is. The coach from Dhaka is a ' +
          'coach from Dhaka and there is no fixing that, but everything after it was handled.',
        ratings: {
          ORGANISATION: 5,
          ACCOMMODATION: 4,
          FOOD: 4,
          TRANSPORT: 3,
          VALUE_FOR_MONEY: 5,
          TRIP_LEADER: 5,
          ACTIVITIES: 5,
        },
      },
      {
        reviewerEmail: 'sadia.noor@beyondborders.local',
        headline: 'Straight answers on the morning it went wrong',
        body:
          'The boat to Maheshkhali was cancelled and we were told within about ten minutes, with ' +
          'a real alternative and an offer to refund that part if it did not run at all. That is ' +
          'rarer than it should be. The hotel was fine rather than good — sea-facing, a bit tired.',
        displayName: 'Sadia N.',
        ratings: {
          ORGANISATION: 5,
          ACCOMMODATION: 3,
          FOOD: 4,
          TRANSPORT: 3,
          VALUE_FOR_MONEY: 4,
          TRIP_LEADER: 5,
          ACTIVITIES: 4,
        },
      },
      {
        reviewerEmail: 'arif.chowdhury@beyondborders.local',
        headline: 'Good trip, long bus',
        body:
          'Everything on the ground was well run and the group was a nice size. The overnight ' +
          'coach each way is eleven hours of your life and I would pay meaningfully more to fly ' +
          'that leg. Worth knowing before you book rather than after.',
        ratings: {
          ORGANISATION: 4,
          ACCOMMODATION: 4,
          FOOD: 5,
          TRANSPORT: 2,
          VALUE_FOR_MONEY: 4,
          TRIP_LEADER: 5,
          ACTIVITIES: 4,
        },
      },
    ],
  },

  {
    slug: 'sundarbans-expedition-january',
    title: 'Sundarbans Expedition — January',
    summary:
      'Eighteen aboard for three nights. Seven kingfisher species, a great deal of silence, and ' +
      'no tiger.',
    story:
      'The January sailing is the one we would send somebody on if they could only do one. Cold ' +
      'enough at dawn to want a jacket, still enough that the tender leaves no wake, and the ' +
      'birds were extraordinary — seven kingfisher species over three mornings, which is a good ' +
      'count anywhere.\n\n' +
      'Nobody saw a tiger. That is written at the top of the page rather than the bottom because ' +
      'it is what the trip actually is, and a group that boards expecting one spends three days ' +
      'disappointed in the wrong direction.',
    packageSlug: 'sundarbans-mangrove-expedition',
    destinationLabel: 'Sundarbans & Mongla',
    country: 'Bangladesh',
    scope: PackageScope.DOMESTIC,
    startDate: '2026-01-16',
    endDate: '2026-01-19',
    memberCount: 18,
    leaders: [
      { slug: 'imran-hossain', role: TripLeaderRole.LEADER },
      { slug: 'farhana-rahman', role: TripLeaderRole.MANAGER },
    ],
    highlights: [
      {
        kind: TripHighlightKind.MOMENT,
        title: 'The dawn tender at Kotka',
        body:
          'Ninety minutes in the narrow creeks before the light was properly up. Brown-winged, ' +
          'collared, black-capped and stork-billed kingfishers inside the first half hour, and a ' +
          'group of spotted deer at the waterline that did not move as we passed.',
        dayNumber: 2,
      },
      {
        kind: TripHighlightKind.INCIDENT,
        title: 'No tiger, again',
        body:
          'We say roughly one group in fifteen sees one, and this was not that group. Two sets of ' +
          'pugmarks on the Jamtola path, fresh enough that the guard was interested. That is the ' +
          'closest anyone got, and it is the honest expectation to board with.',
      },
      {
        kind: TripHighlightKind.INCIDENT,
        title: 'The generator failed on the second night',
        body:
          'No power aboard from roughly nine until the following midday, which meant no fans and ' +
          'no charging. In January that is uncomfortable rather than serious. We have since ' +
          'changed the boat we charter for this sailing.',
        dayNumber: 3,
      },
      {
        kind: TripHighlightKind.MILESTONE,
        title: 'Seven kingfisher species in three mornings',
        body: 'The best count we have recorded on this route since we began running it in 2019.',
      },
    ],
    media: [],
    reviews: [
      {
        reviewerEmail: 'meherun.haque@beyondborders.local',
        headline: 'They told us we probably would not see a tiger, and we did not',
        body:
          'I have been on trips where the guide keeps promising the animal right up to the last ' +
          'hour. This was the opposite — Imran said on the first evening that it was unlikely, ' +
          'explained why, and then spent three days showing us what is actually there. I came ' +
          'back knowing what a stork-billed kingfisher sounds like. The cabins are basic and the ' +
          'generator went; neither ruined anything.',
        ratings: {
          ORGANISATION: 5,
          ACCOMMODATION: 3,
          FOOD: 4,
          TRANSPORT: 4,
          VALUE_FOR_MONEY: 5,
          TRIP_LEADER: 5,
          ACTIVITIES: 5,
        },
      },
      {
        reviewerEmail: 'rifat.karim@beyondborders.local',
        headline: 'The silence is the thing nobody photographs',
        body:
          'Hard to describe and worth the money on its own. Food aboard was better than it needed ' +
          'to be. The power cut on the second night was a genuine nuisance, and the crew were ' +
          'straightforward about it rather than pretending it was fine.',
        ratings: {
          ORGANISATION: 4,
          ACCOMMODATION: 3,
          FOOD: 5,
          TRANSPORT: 4,
          VALUE_FOR_MONEY: 5,
          TRIP_LEADER: 5,
          ACTIVITIES: 5,
        },
      },
      {
        reviewerEmail: 'sadia.noor@beyondborders.local',
        headline: 'Go in January, not later',
        body:
          'Cold mornings, no insects to speak of, and the channels were glass. I would not do ' +
          'this trip in March. Eighteen is at the top of what the tender can move comfortably in ' +
          'one go, and we did split into two runs, which cost some time.',
        ratings: {
          ORGANISATION: 4,
          ACCOMMODATION: 3,
          FOOD: 4,
          TRANSPORT: 3,
          VALUE_FOR_MONEY: 4,
          TRIP_LEADER: 5,
          ACTIVITIES: 5,
        },
      },
    ],
  },

  {
    slug: 'annapurna-foothills-november',
    title: 'Annapurna Foothills — November',
    summary:
      'Eleven walkers on the Poon Hill circuit, one of whom turned back at Ulleri and was right ' +
      'to.',
    story:
      'November is the clear month and it delivered: Dhaulagiri and Annapurna South out on all ' +
      'three mornings, and Poon Hill at dawn with maybe forty other people rather than the ' +
      'several hundred who arrive in October.\n\n' +
      'Eleven booked, ten summited. One member turned back on the Ulleri steps on day three and ' +
      'came down with a porter to Tikhedhunga. That was the correct decision, it was theirs to ' +
      'make, and it is written up here because a trekking page that reports only the people who ' +
      'finished is not telling you what the trek is like.',
    packageSlug: 'pokhara-annapurna-foothills',
    destinationLabel: 'Pokhara & Ghorepani',
    country: 'Nepal',
    scope: PackageScope.INTERNATIONAL,
    startDate: '2025-11-12',
    endDate: '2025-11-18',
    memberCount: 11,
    heroImageUrl: '/images/destinations/pokhara-nepal.webp',
    leaders: [{ slug: 'tanvir-ahmed', role: TripLeaderRole.LEADER }],
    highlights: [
      {
        kind: TripHighlightKind.MOMENT,
        title: 'Poon Hill, 06:20',
        body:
          'Clear to the horizon in every direction. Dhaulagiri first, then Annapurna South picking ' +
          'up colour about four minutes later. Nobody said anything for a while.',
        dayNumber: 4,
      },
      {
        kind: TripHighlightKind.INCIDENT,
        title: 'One member turned back at Ulleri',
        body:
          'The Ulleri steps are the hardest hour of the trek, and they are hard for people who ' +
          'are fit. A member decided at roughly the halfway point that they had had enough, and a ' +
          'porter walked them back down to the teahouse at Tikhedhunga, where they spent two ' +
          'comfortable days. We build the group with a spare porter precisely so that is ' +
          'available rather than theoretical.',
        dayNumber: 3,
      },
      {
        kind: TripHighlightKind.MILESTONE,
        title: 'Youngest and oldest, twenty-six years apart',
        body:
          'Our widest age range on a trek so far — nineteen and forty-five — and both were on the ' +
          'hill at dawn.',
      },
    ],
    media: [
      {
        url: '/images/destinations/pokhara-nepal.webp',
        alt: 'A still lake reflecting a snow-covered mountain range under a clear sky',
        caption: 'Phewa lake on the rest day, before the cloud came in.',
      },
    ],
    reviews: [
      {
        reviewerEmail: 'arif.chowdhury@beyondborders.local',
        headline: 'The rest day is not padding',
        body:
          'I thought the day in Pokhara at the end was filler and I was wrong — coming off the ' +
          'hill and having twenty-four hours before flying made the whole thing land differently. ' +
          'Teahouses are teahouses; you are paying for the route and the leader, and both were ' +
          'excellent.',
        ratings: {
          ORGANISATION: 5,
          ACCOMMODATION: 3,
          FOOD: 4,
          TRANSPORT: 4,
          VALUE_FOR_MONEY: 4,
          TRIP_LEADER: 5,
          ACTIVITIES: 5,
        },
      },
      {
        reviewerEmail: 'meherun.haque@beyondborders.local',
        headline: 'I was the one who turned back',
        body:
          'Writing this because I would have wanted to read it. Ulleri beat me, and Tanvir made ' +
          'stopping feel like a normal outcome rather than a failure — there was a porter with me ' +
          'inside two minutes and a plan for the next two days inside five. I saw Poon Hill in ' +
          'other people’s photographs and I would go back and do it properly. Book it, and be ' +
          'honest with yourself about the steps.',
        displayName: 'Meherun H.',
        ratings: {
          ORGANISATION: 5,
          ACCOMMODATION: 4,
          FOOD: 4,
          TRANSPORT: 4,
          VALUE_FOR_MONEY: 5,
          TRIP_LEADER: 5,
          ACTIVITIES: 4,
        },
      },
    ],
  },
]

/** Every axis, in the order the public page prints them. */
export const REVIEW_DIMENSIONS: ReviewDimension[] = [
  ReviewDimension.ORGANISATION,
  ReviewDimension.TRIP_LEADER,
  ReviewDimension.ACTIVITIES,
  ReviewDimension.ACCOMMODATION,
  ReviewDimension.FOOD,
  ReviewDimension.TRANSPORT,
  ReviewDimension.VALUE_FOR_MONEY,
]

/** Seeded gallery rows and reviews are pre-approved, since a seed has no queue. */
export const SEEDED_MODERATION = ModerationStatus.APPROVED
export const SEEDED_TRIP_STATUS = PastTripStatus.PUBLISHED
