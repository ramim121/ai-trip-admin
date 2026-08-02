import {
  DepartureStatus,
  ItineraryBlockKind,
  PackageKind,
  PackagePricingMode,
  PackageScope,
  PackageStatus,
  PollStatus,
  TripLeaderRole,
} from '@/generated/prisma/enums'

/**
 * The Discover catalogue: eight trips, the people who run them, and one poll.
 *
 * Content, not code. It lives beside `catalog.ts` for the same reason that file
 * does — the seed owns it, so correcting a price or a departure happens here and
 * reaches the database on the next run, rather than by hand-editing a row
 * somebody else then overwrites.
 *
 * WHAT THE DATA IS SHAPED TO EXERCISE
 *
 * Deliberately not eight variations of one thing. Between them these rows cover
 * every branch the public page has to render:
 *
 *   • GROUP with fixed departures, and INDIVIDUAL run on the traveller's dates
 *   • FIXED_PRICE with one price, FIXED_PRICE with a genuine range, and
 *     INTEREST_ONLY where the price columns are null by database constraint
 *   • a SOLD_OUT departure and a GUARANTEED one, so those states are not
 *     theoretical
 *   • packages that map onto a catalog destination the planner already knows,
 *     and packages that do not — "Sylhet & Srimangal" is a real trip with no
 *     single catalog row behind it
 *
 * DEPARTURE DATES ARE RELATIVE
 *
 * Written as "days from the seed run" rather than as calendar dates. A seed with
 * hard-coded dates silently stops having any upcoming departures a few months
 * after it was written, and Discover then shows eight trips that all appear to
 * have already finished.
 */

// ─────────────────────────────────────────────────────────────────────────────
// People
// ─────────────────────────────────────────────────────────────────────────────

export interface TripLeaderSeed {
  slug: string
  name: string
  role: TripLeaderRole
  headline: string
  bio: string
  yearsExperience: number
  tripsLed: number
  languages: string[]
  sortOrder: number
}

export const TRIP_LEADERS: TripLeaderSeed[] = [
  {
    slug: 'nusrat-jahan',
    name: 'Nusrat Jahan',
    role: TripLeaderRole.LEADER,
    headline: 'Eleven years on the Chattogram coast',
    bio:
      'Nusrat started guiding day trips out of Cox’s Bazar in 2015 and has run the long-weekend ' +
      'group every season since. She plans around the tide tables rather than the clock, which ' +
      'is why her groups reach Inani when the coral rock is actually exposed.',
    yearsExperience: 11,
    tripsLed: 240,
    languages: ['Bangla', 'English'],
    sortOrder: 0,
  },
  {
    slug: 'imran-hossain',
    name: 'Imran Hossain',
    role: TripLeaderRole.LEADER,
    headline: 'Sundarbans boat routes and bird calls',
    bio:
      'Imran grew up in Mongla and has worked the Sundarbans channels since he was nineteen — ' +
      'first crewing, then guiding. He can name a bird from its call before anyone has found it ' +
      'in the canopy, and he is candid that tigers are rarely seen and that this is fine.',
    yearsExperience: 14,
    tripsLed: 190,
    languages: ['Bangla', 'English'],
    sortOrder: 1,
  },
  {
    slug: 'farhana-rahman',
    name: 'Farhana Rahman',
    role: TripLeaderRole.MANAGER,
    headline: 'Plans the international departures',
    bio:
      'Farhana handles visas, flights and the parts of a trip nobody wants to think about. She ' +
      'is the name on the quote for every international package, and the person travellers reach ' +
      'when something changes at three in the morning in another time zone.',
    yearsExperience: 9,
    tripsLed: 120,
    languages: ['Bangla', 'English', 'Hindi'],
    sortOrder: 2,
  },
  {
    slug: 'tanvir-ahmed',
    name: 'Tanvir Ahmed',
    role: TripLeaderRole.LEADER,
    headline: 'Hill treks, and knowing when to turn back',
    bio:
      'Tanvir has led treks in the Chittagong Hill Tracts and the Annapurna foothills for a ' +
      'decade. He is the reason our trekking groups carry a satellite messenger, and the reason ' +
      'two departures have turned back short of the pass. Both were the right call.',
    yearsExperience: 10,
    tripsLed: 85,
    languages: ['Bangla', 'English', 'Nepali'],
    sortOrder: 3,
  },
  {
    slug: 'ayu-wijaya',
    name: 'Ayu Wijaya',
    role: TripLeaderRole.GUIDE,
    headline: 'Local guide in Ubud and the Bali highlands',
    bio:
      'Ayu joins our Bali trips for the temple and rice-terrace days. She grew up in Tegallalang ' +
      'and reads the ceremony calendar, so groups arrive at Tirta Empul on a day it is worth ' +
      'arriving.',
    yearsExperience: 7,
    tripsLed: 60,
    languages: ['Indonesian', 'Balinese', 'English'],
    sortOrder: 4,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Trips
// ─────────────────────────────────────────────────────────────────────────────

interface ItemSeed {
  kind: ItineraryBlockKind
  title: string
  detail?: string
  /** Minutes from local midnight; 540 is 09:00. Omit where the day is vague on purpose. */
  startMinute?: number
  durationMinutes?: number
}

interface DaySeed {
  dayNumber: number
  title: string
  summary?: string
  accommodation?: string
  meals: string[]
  items: ItemSeed[]
}

interface DepartureSeed {
  /** Days from the seed run. Keeps a seeded catalogue from expiring. */
  startsInDays: number
  nights: number
  capacity: number
  seatsTaken: number
  priceBdt?: number
  status: DepartureStatus
  notes?: string
}

interface LeaderAssignment {
  slug: string
  role: TripLeaderRole
  isPrimary?: boolean
}

export interface PackageSeed {
  slug: string
  title: string
  summary: string
  description: string
  scope: PackageScope
  kind: PackageKind
  pricingMode: PackagePricingMode
  /** A catalog destination slug, when the trip maps onto one. */
  destinationSlug?: string
  destinationLabel: string
  country: string
  durationDays: number
  durationNights: number
  priceFromBdt?: number
  priceToBdt?: number
  groupSizeMin?: number
  groupSizeMax?: number
  highlights: string[]
  inclusions: string[]
  exclusions: string[]
  status: PackageStatus
  sortOrder: number
  metaDescription: string
  days: DaySeed[]
  departures: DepartureSeed[]
  leaders: LeaderAssignment[]
}

const STANDARD_INCLUSIONS = [
  'All internal transport in an air-conditioned vehicle',
  'Accommodation on twin-share basis',
  'Breakfast every morning',
  'A Beyond Borders trip leader throughout',
  'All entry tickets listed in the itinerary',
]

const STANDARD_EXCLUSIONS = [
  'Lunches and dinners not listed',
  'Personal expenses and tips',
  'Travel insurance',
  'Anything not listed under what is included',
]

export const PACKAGES: PackageSeed[] = [
  // ── Domestic ──────────────────────────────────────────────────────────────
  {
    slug: 'coxs-bazar-long-weekend',
    title: 'Cox’s Bazar Long Weekend',
    summary:
      'Four days on the world’s longest unbroken beach, timed around the tides so Inani’s coral ' +
      'rock is actually out of the water when you get there.',
    description:
      'The trip most people start with, and the one we have run the most times. Three nights in ' +
      'Cox’s Bazar with the driving kept short: Himchari and the waterfall on the first full ' +
      'day, the Marine Drive south to Inani and Patuartek on the second, and Maheshkhali by ' +
      'boat on the third.\n\n' +
      'It is deliberately not a packed itinerary. Afternoons are open, because the point of ' +
      'being on that beach is being on that beach. The one thing we are strict about is the ' +
      'Inani timing — arrive at the wrong hour and the coral rock the whole drive exists for is ' +
      'under a metre of water.',
    scope: PackageScope.DOMESTIC,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationSlug: 'coxs-bazar-bangladesh',
    destinationLabel: 'Cox’s Bazar',
    country: 'Bangladesh',
    durationDays: 4,
    durationNights: 3,
    priceFromBdt: 18_500,
    groupSizeMin: 10,
    groupSizeMax: 16,
    highlights: [
      'Sunset walk from Laboni to Kolatoli',
      'Himchari National Park and the waterfall',
      'Marine Drive to Inani, timed to low tide',
      'Maheshkhali by boat, and the Adinath temple',
    ],
    inclusions: [...STANDARD_INCLUSIONS, 'Return AC coach, Dhaka to Cox’s Bazar'],
    exclusions: STANDARD_EXCLUSIONS,
    status: PackageStatus.PUBLISHED,
    sortOrder: 0,
    metaDescription:
      'Four-day group trip to Cox’s Bazar from Dhaka: Himchari, Inani coral rock at low tide, ' +
      'and Maheshkhali island. Small group, fixed departures.',
    days: [
      {
        dayNumber: 1,
        title: 'Dhaka to Cox’s Bazar, and the first walk on the sand',
        summary: 'An overnight coach, a late-morning check-in, and nothing strenuous after it.',
        accommodation: 'Sea-facing hotel, Kolatoli',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Arrive Cox’s Bazar and transfer to the hotel',
            detail: 'The overnight coach reaches Kolatoli mid-morning.',
            startMinute: 600,
            durationMinutes: 60,
          },
          {
            kind: ItineraryBlockKind.REST,
            title: 'Check in and rest',
            detail: 'Rooms are held from 11:00. Sleep, or go straight to the water.',
            startMinute: 660,
            durationMinutes: 180,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Laboni to Kolatoli sunset walk',
            detail:
              'About four kilometres along the tideline with the group, ending as the light goes.',
            startMinute: 1_020,
            durationMinutes: 120,
          },
          {
            kind: ItineraryBlockKind.MEAL,
            title: 'Sea-fish barbecue at Kolatoli',
            detail: 'Optional, and worth it. Ordered by weight at the stalls.',
            startMinute: 1_200,
            durationMinutes: 90,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Himchari, the waterfall, and an open afternoon',
        accommodation: 'Sea-facing hotel, Kolatoli',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Himchari National Park and waterfall',
            detail: 'The viewpoint climb first, while it is still cool.',
            startMinute: 510,
            durationMinutes: 210,
          },
          {
            kind: ItineraryBlockKind.MEAL,
            title: 'Lunch back in town',
            startMinute: 780,
            durationMinutes: 60,
          },
          {
            kind: ItineraryBlockKind.FREE,
            title: 'Afternoon at leisure',
            detail:
              'Deliberately unplanned. The Burmese Market is fifteen minutes away if you want it.',
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'Marine Drive south to Inani and Patuartek',
        summary: 'The one day with a fixed departure time, and the reason is the tide.',
        accommodation: 'Sea-facing hotel, Kolatoli',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Marine Drive to Inani',
            detail: 'An hour along the coast road with the sea on one side the whole way.',
            startMinute: 480,
            durationMinutes: 60,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Inani and Patuartek coral rock beach',
            detail:
              'We leave early because the rock formations are only exposed around low tide. ' +
              'Later in the day this is an ordinary stretch of beach.',
            startMinute: 540,
            durationMinutes: 180,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Ramu Buddhist village and the Bara Kyang',
            detail: 'On the way back, if the group still has the energy.',
            startMinute: 900,
            durationMinutes: 120,
          },
        ],
      },
      {
        dayNumber: 4,
        title: 'Maheshkhali by boat, then the road home',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Maheshkhali island and the Adinath temple',
            detail: 'Speedboat across the channel, then the temple hill.',
            startMinute: 480,
            durationMinutes: 240,
          },
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Evening coach to Dhaka',
            startMinute: 1_140,
            durationMinutes: 60,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 21,
        nights: 3,
        capacity: 16,
        seatsTaken: 11,
        status: DepartureStatus.GUARANTEED,
      },
      {
        startsInDays: 49,
        nights: 3,
        capacity: 16,
        seatsTaken: 4,
        status: DepartureStatus.SCHEDULED,
      },
      {
        startsInDays: 84,
        nights: 3,
        capacity: 16,
        seatsTaken: 16,
        status: DepartureStatus.SOLD_OUT,
        notes: 'Eid holiday departure. Waiting list only.',
      },
    ],
    leaders: [{ slug: 'nusrat-jahan', role: TripLeaderRole.LEADER, isPrimary: true }],
  },

  {
    slug: 'sundarbans-mangrove-expedition',
    title: 'Sundarbans Mangrove Expedition',
    summary:
      'Four days on a boat in the largest mangrove forest on earth. Tigers are rare; the ' +
      'kingfishers, the channels and the silence are not.',
    description:
      'A live-aboard trip out of Mongla, sleeping on the boat all three nights. Days are spent ' +
      'on the small tender through the narrow channels, which is where the wildlife actually is ' +
      '— the main rivers are wide, busy and mostly empty of birds.\n\n' +
      'We will say this plainly because other operators do not: you will probably not see a ' +
      'tiger. Perhaps one group in fifteen does. What you will see is six or seven kingfisher ' +
      'species, spotted deer at the waterline, crocodiles on the mud, and a forest that goes ' +
      'quiet in a way that is difficult to describe and easy to remember.',
    scope: PackageScope.DOMESTIC,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationLabel: 'Sundarbans & Mongla',
    country: 'Bangladesh',
    durationDays: 4,
    durationNights: 3,
    priceFromBdt: 22_900,
    priceToBdt: 27_500,
    groupSizeMin: 12,
    groupSizeMax: 20,
    highlights: [
      'Three nights aboard, with the channels to yourselves at dawn',
      'Kotka and Jamtola beach at first light',
      'Small-tender birding in the narrow creeks',
      'A forest department guard aboard throughout',
    ],
    inclusions: [
      'Full board aboard the boat — all meals and tea',
      'Forest department permits and the mandatory armed guard',
      'Small tender for the channel trips',
      'A Beyond Borders trip leader throughout',
    ],
    exclusions: [
      'Transport from Dhaka to Mongla',
      'Soft drinks and bottled water beyond what is provided',
      'Personal expenses and tips',
      'Travel insurance',
    ],
    status: PackageStatus.PUBLISHED,
    sortOrder: 1,
    metaDescription:
      'Four-day live-aboard Sundarbans expedition from Mongla: Kotka, Jamtola and the narrow ' +
      'channels, with a forest department guard throughout.',
    days: [
      {
        dayNumber: 1,
        title: 'Board at Mongla and sail south',
        accommodation: 'Aboard, twin cabin',
        meals: ['Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Board at Mongla jetty',
            startMinute: 660,
            durationMinutes: 60,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Sail into the forest',
            detail: 'Four hours south. The channels narrow as the afternoon goes on.',
            startMinute: 780,
            durationMinutes: 240,
          },
          {
            kind: ItineraryBlockKind.MEAL,
            title: 'Dinner aboard',
            startMinute: 1_200,
            durationMinutes: 60,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Kotka at first light',
        accommodation: 'Aboard, twin cabin',
        meals: ['Breakfast', 'Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Dawn tender trip through the creeks',
            detail: 'The single best two hours of the trip. Leaving late costs you the birds.',
            startMinute: 330,
            durationMinutes: 150,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Kotka watchtower and the grasslands walk',
            startMinute: 600,
            durationMinutes: 180,
          },
          { kind: ItineraryBlockKind.FREE, title: 'Afternoon aboard as the boat repositions' },
        ],
      },
      {
        dayNumber: 3,
        title: 'Jamtola beach and the narrow channels',
        accommodation: 'Aboard, twin cabin',
        meals: ['Breakfast', 'Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Walk to Jamtola beach',
            detail: 'Through the forest to an empty stretch of the Bay of Bengal.',
            startMinute: 390,
            durationMinutes: 210,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Afternoon birding by tender',
            startMinute: 900,
            durationMinutes: 150,
          },
        ],
      },
      {
        dayNumber: 4,
        title: 'North to Mongla',
        meals: ['Breakfast', 'Lunch'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Sail back to Mongla',
            startMinute: 360,
            durationMinutes: 360,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 33,
        nights: 3,
        capacity: 20,
        seatsTaken: 8,
        status: DepartureStatus.SCHEDULED,
      },
      {
        startsInDays: 61,
        nights: 3,
        capacity: 20,
        seatsTaken: 15,
        priceBdt: 27_500,
        status: DepartureStatus.GUARANTEED,
        notes: 'Peak season sailing — the price reflects the higher permit and fuel cost.',
      },
    ],
    leaders: [
      { slug: 'imran-hossain', role: TripLeaderRole.LEADER, isPrimary: true },
      { slug: 'farhana-rahman', role: TripLeaderRole.MANAGER },
    ],
  },

  {
    slug: 'sylhet-srimangal-tea-trail',
    title: 'Sylhet & Srimangal Tea Trail',
    summary:
      'Three days through the tea gardens, the seven-layer tea and the Lawachara canopy — run ' +
      'on whichever dates suit you.',
    description:
      'An individual trip rather than a group departure: you pick the dates, we run it for your ' +
      'party alone. Two nights in Srimangal with a car and driver throughout.\n\n' +
      'The route is built around what is actually good rather than what is famous. Madhabpur ' +
      'Lake early, before the coaches; Lawachara with a forest guide who knows where the hoolock ' +
      'gibbons were yesterday; and an afternoon on a working tea estate rather than at the ' +
      'roadside stalls.',
    scope: PackageScope.DOMESTIC,
    kind: PackageKind.INDIVIDUAL,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationLabel: 'Sylhet & Srimangal',
    country: 'Bangladesh',
    durationDays: 3,
    durationNights: 2,
    priceFromBdt: 14_200,
    highlights: [
      'Seven-layer tea, and a straight answer about whether it is worth it',
      'Lawachara rainforest with a forest department guide',
      'Madhabpur Lake before the day-trippers arrive',
      'A working tea estate, not a roadside stall',
    ],
    inclusions: [...STANDARD_INCLUSIONS, 'Private car and driver for the whole trip'],
    exclusions: STANDARD_EXCLUSIONS,
    status: PackageStatus.PUBLISHED,
    sortOrder: 2,
    metaDescription:
      'Private three-day Sylhet and Srimangal trip: tea gardens, Lawachara rainforest and ' +
      'Madhabpur Lake, on your own dates.',
    days: [
      {
        dayNumber: 1,
        title: 'Into the tea country',
        accommodation: 'Tea resort, Srimangal',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Arrive Sylhet and drive to Srimangal',
            startMinute: 600,
            durationMinutes: 150,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Seven-layer tea at Nilkantha',
            startMinute: 960,
            durationMinutes: 60,
          },
          { kind: ItineraryBlockKind.FREE, title: 'Evening free at the resort' },
        ],
      },
      {
        dayNumber: 2,
        title: 'Lawachara and Madhabpur',
        accommodation: 'Tea resort, Srimangal',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Lawachara National Park with a forest guide',
            detail: 'Early, when the gibbons are calling.',
            startMinute: 420,
            durationMinutes: 180,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Madhabpur Lake',
            startMinute: 660,
            durationMinutes: 120,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'A working tea estate, and how the leaf is graded',
            startMinute: 900,
            durationMinutes: 150,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'Sylhet and the road home',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Ratargul swamp forest by boat',
            detail: 'Only worth doing in the monsoon months, and we will tell you if it is not.',
            startMinute: 480,
            durationMinutes: 210,
          },
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Transfer to Sylhet airport',
            startMinute: 900,
            durationMinutes: 90,
          },
        ],
      },
    ],
    departures: [],
    leaders: [{ slug: 'farhana-rahman', role: TripLeaderRole.MANAGER, isPrimary: true }],
  },

  {
    slug: 'bandarban-nafakhum-trek',
    title: 'Bandarban & Nafakhum Trek',
    summary:
      'Five days walking to the largest waterfall in Bangladesh. Not costed yet — tell us you ' +
      'would come and we will build the departure around who shows up.',
    description:
      'The hardest trip on this list, and the one we are least willing to run badly. Remakri to ' +
      'Nafakhum on foot, river crossings included, sleeping in village guesthouses and a Marma ' +
      'village.\n\n' +
      'It is on this page as an interest list rather than a priced departure because the cost ' +
      'depends entirely on group size, permits and the season, and quoting a number we would ' +
      'have to walk back is worse than quoting none. Register, and we will come back with real ' +
      'dates and a real price once there are enough of you to run it properly.',
    scope: PackageScope.DOMESTIC,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.INTEREST_ONLY,
    destinationLabel: 'Bandarban & Remakri',
    country: 'Bangladesh',
    durationDays: 5,
    durationNights: 4,
    groupSizeMin: 8,
    groupSizeMax: 14,
    highlights: [
      'Nafakhum falls, reached the only way there is — on foot',
      'Two nights in a Marma village guesthouse',
      'River crossings and the Remakri gorge',
      'A trek leader who has turned groups back before, and would again',
    ],
    inclusions: [
      'All permits and local guide fees',
      'Village guesthouse accommodation',
      'All meals on trek',
      'A Beyond Borders trek leader and a satellite messenger',
    ],
    exclusions: [
      'Transport from Dhaka to Bandarban',
      'Personal trekking gear',
      'Travel insurance, which is mandatory on this trip',
      'Anything not listed under what is included',
    ],
    status: PackageStatus.PUBLISHED,
    sortOrder: 3,
    metaDescription:
      'Five-day trek to Nafakhum waterfall through Bandarban and Remakri. Register your interest ' +
      'and we will build the departure around the group.',
    days: [
      {
        dayNumber: 1,
        title: 'Bandarban to Thanchi',
        accommodation: 'Guesthouse, Thanchi',
        meals: ['Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Road to Thanchi',
            startMinute: 420,
            durationMinutes: 300,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Permits and the safety briefing',
            startMinute: 1_020,
            durationMinutes: 90,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Boat to Remakri, then walk',
        accommodation: 'Village guesthouse, Remakri',
        meals: ['Breakfast', 'Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Engine boat up the Sangu',
            startMinute: 420,
            durationMinutes: 240,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Remakri falls and the gorge',
            startMinute: 780,
            durationMinutes: 150,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'Remakri to Nafakhum',
        accommodation: 'Marma village guesthouse',
        meals: ['Breakfast', 'Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Trek to Nafakhum',
            detail: 'Around five hours, with river crossings. The current decides the pace.',
            startMinute: 420,
            durationMinutes: 300,
          },
        ],
      },
      {
        dayNumber: 4,
        title: 'Back down the valley',
        accommodation: 'Guesthouse, Thanchi',
        meals: ['Breakfast', 'Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Return trek and boat',
            startMinute: 420,
            durationMinutes: 480,
          },
        ],
      },
      {
        dayNumber: 5,
        title: 'Thanchi to Bandarban',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Road to Bandarban',
            startMinute: 480,
            durationMinutes: 300,
          },
        ],
      },
    ],
    departures: [],
    leaders: [{ slug: 'tanvir-ahmed', role: TripLeaderRole.LEADER, isPrimary: true }],
  },

  // ── International ─────────────────────────────────────────────────────────
  {
    slug: 'phuket-island-hopper',
    title: 'Phuket Island Hopper',
    summary:
      'Five days out of Phuket with three of them on the water — Phi Phi, Phang Nga Bay, and a ' +
      'longtail to the beaches the speedboats skip.',
    description:
      'A group trip built around the boats rather than the resort. Four nights in Kata, and the ' +
      'island days spaced so nobody spends three consecutive mornings on a pier.\n\n' +
      'The Phi Phi day runs on a private longtail rather than a shared speedboat. It costs more ' +
      'and it takes longer, and it is the reason our groups reach Maya Bay before the fleet and ' +
      'get an hour at Bamboo Island with almost nobody on it.',
    scope: PackageScope.INTERNATIONAL,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationSlug: 'phuket-thailand',
    destinationLabel: 'Phuket',
    country: 'Thailand',
    durationDays: 5,
    durationNights: 4,
    priceFromBdt: 62_000,
    priceToBdt: 74_000,
    groupSizeMin: 10,
    groupSizeMax: 18,
    highlights: [
      'Phi Phi by private longtail, ahead of the speedboat fleet',
      'Phang Nga Bay sea caves by canoe',
      'Old Phuket Town on foot, with the shophouse history',
      'Kata and Karon sunsets, unhurried',
    ],
    inclusions: [
      'Return flights, Dhaka to Phuket',
      'Four nights’ accommodation on twin-share basis',
      'Breakfast every morning',
      'All boat trips listed, including the private longtail',
      'Airport transfers and a Beyond Borders trip leader',
    ],
    exclusions: [
      'Thailand visa fee',
      'Lunches and dinners not listed',
      'Personal expenses and tips',
      'Travel insurance',
    ],
    status: PackageStatus.PUBLISHED,
    sortOrder: 10,
    metaDescription:
      'Five-day Phuket group trip from Dhaka: Phi Phi by private longtail, Phang Nga Bay sea ' +
      'caves and Old Phuket Town.',
    days: [
      {
        dayNumber: 1,
        title: 'Arrive Phuket',
        accommodation: 'Hotel in Kata',
        meals: [],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Arrive and transfer to Kata',
            startMinute: 780,
            durationMinutes: 90,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Kata beach at sunset',
            startMinute: 1_020,
            durationMinutes: 120,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Phi Phi by private longtail',
        accommodation: 'Hotel in Kata',
        meals: ['Breakfast', 'Lunch'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Pier transfer and boarding',
            startMinute: 420,
            durationMinutes: 60,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Maya Bay, Pileh Lagoon and Viking Cave',
            detail: 'We leave early specifically to be there before the speedboats.',
            startMinute: 480,
            durationMinutes: 300,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Bamboo Island',
            startMinute: 810,
            durationMinutes: 120,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'Phang Nga Bay',
        accommodation: 'Hotel in Kata',
        meals: ['Breakfast', 'Lunch'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Sea caves and hongs by canoe',
            startMinute: 480,
            durationMinutes: 300,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'James Bond Island',
            startMinute: 810,
            durationMinutes: 90,
          },
        ],
      },
      {
        dayNumber: 4,
        title: 'Old Phuket Town, and an open afternoon',
        accommodation: 'Hotel in Kata',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Old Town walking tour',
            detail: 'Sino-Portuguese shophouses, Thalang Road, and where the tin money went.',
            startMinute: 540,
            durationMinutes: 180,
          },
          { kind: ItineraryBlockKind.FREE, title: 'Afternoon at leisure' },
        ],
      },
      {
        dayNumber: 5,
        title: 'Fly home',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Transfer to the airport',
            startMinute: 600,
            durationMinutes: 90,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 40,
        nights: 4,
        capacity: 18,
        seatsTaken: 13,
        status: DepartureStatus.GUARANTEED,
      },
      {
        startsInDays: 75,
        nights: 4,
        capacity: 18,
        seatsTaken: 6,
        priceBdt: 74_000,
        status: DepartureStatus.SCHEDULED,
        notes: 'High season fares. Book early if the date matters more than the price.',
      },
      {
        startsInDays: 118,
        nights: 4,
        capacity: 18,
        seatsTaken: 2,
        status: DepartureStatus.SCHEDULED,
      },
    ],
    leaders: [
      { slug: 'farhana-rahman', role: TripLeaderRole.MANAGER, isPrimary: true },
      { slug: 'nusrat-jahan', role: TripLeaderRole.LEADER },
    ],
  },

  {
    slug: 'bali-temples-and-rice-terraces',
    title: 'Bali: Temples & Rice Terraces',
    summary:
      'Six days between Ubud and the east coast, planned around the ceremony calendar rather ' +
      'than around the photographs.',
    description:
      'A private trip for your own party. Three nights in Ubud, two on the coast, and a local ' +
      'guide who lives in Tegallalang for the temple and terrace days.\n\n' +
      'The scheduling is the point. Tirta Empul on the wrong day is a queue; on the right one it ' +
      'is a working temple with a purification ritual going on around you. Ayu reads the ' +
      'ceremony calendar and moves the days accordingly, which is a thing an itinerary printed ' +
      'six months in advance cannot do.',
    scope: PackageScope.INTERNATIONAL,
    kind: PackageKind.INDIVIDUAL,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationSlug: 'bali-indonesia',
    destinationLabel: 'Ubud & East Bali',
    country: 'Indonesia',
    durationDays: 6,
    durationNights: 5,
    priceFromBdt: 78_500,
    highlights: [
      'Tirta Empul on a day the ritual is actually happening',
      'Tegallalang rice terraces before the coaches',
      'A Balinese cooking afternoon in a family compound',
      'Two nights on the quiet east coast',
    ],
    inclusions: [
      'Return flights, Dhaka to Denpasar',
      'Five nights’ accommodation',
      'Breakfast every morning',
      'Private car and driver throughout',
      'A local guide for the temple and terrace days',
    ],
    exclusions: [
      'Indonesia visa on arrival',
      'Lunches and dinners not listed',
      'Personal expenses and tips',
      'Travel insurance',
    ],
    status: PackageStatus.PUBLISHED,
    sortOrder: 11,
    metaDescription:
      'Private six-day Bali trip: Ubud, Tegallalang, Tirta Empul and the east coast, with a ' +
      'local guide and a driver throughout.',
    days: [
      {
        dayNumber: 1,
        title: 'Arrive Denpasar, transfer to Ubud',
        accommodation: 'Ubud',
        meals: [],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Airport to Ubud',
            startMinute: 720,
            durationMinutes: 120,
          },
          { kind: ItineraryBlockKind.FREE, title: 'Evening at leisure' },
        ],
      },
      {
        dayNumber: 2,
        title: 'Tegallalang and the Ubud ridge',
        accommodation: 'Ubud',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Tegallalang rice terraces',
            startMinute: 420,
            durationMinutes: 150,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Campuhan ridge walk',
            startMinute: 960,
            durationMinutes: 90,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'Temples, on the right day',
        accommodation: 'Ubud',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Tirta Empul purification',
            startMinute: 480,
            durationMinutes: 180,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Gunung Kawi rock shrines',
            startMinute: 720,
            durationMinutes: 120,
          },
        ],
      },
      {
        dayNumber: 4,
        title: 'A cooking afternoon, then east',
        accommodation: 'East coast',
        meals: ['Breakfast', 'Lunch'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Cooking class in a family compound',
            startMinute: 540,
            durationMinutes: 240,
          },
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Drive to the east coast',
            startMinute: 900,
            durationMinutes: 120,
          },
        ],
      },
      {
        dayNumber: 5,
        title: 'The quiet coast',
        accommodation: 'East coast',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Snorkelling at Amed',
            startMinute: 480,
            durationMinutes: 180,
          },
          { kind: ItineraryBlockKind.FREE, title: 'Afternoon at leisure' },
        ],
      },
      {
        dayNumber: 6,
        title: 'Fly home',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Transfer to Denpasar',
            startMinute: 540,
            durationMinutes: 150,
          },
        ],
      },
    ],
    departures: [],
    leaders: [
      { slug: 'ayu-wijaya', role: TripLeaderRole.GUIDE, isPrimary: true },
      { slug: 'farhana-rahman', role: TripLeaderRole.MANAGER },
    ],
  },

  {
    slug: 'pokhara-annapurna-foothills',
    title: 'Pokhara & the Annapurna Foothills',
    summary:
      'Seven days with three of them walking — Poon Hill for the sunrise, and Pokhara either ' +
      'side of it. No technical ground, and no altitude to speak of.',
    description:
      'The trek most people can actually do. Three days on the Ghorepani–Poon Hill circuit, ' +
      'topping out around 3,200 metres, with teahouse nights and a support porter for every two ' +
      'walkers.\n\n' +
      'Either side of the trek there are two nights in Pokhara: Phewa lake, Sarangkot at dawn if ' +
      'the weather cooperates, and a rest day that exists because a trek without one is a trek ' +
      'people finish tired and remember badly.',
    scope: PackageScope.INTERNATIONAL,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationSlug: 'pokhara-nepal',
    destinationLabel: 'Pokhara & Ghorepani',
    country: 'Nepal',
    durationDays: 7,
    durationNights: 6,
    priceFromBdt: 86_000,
    groupSizeMin: 8,
    groupSizeMax: 12,
    highlights: [
      'Poon Hill at sunrise, with Dhaulagiri and Annapurna South out',
      'Three teahouse nights on the Ghorepani circuit',
      'Phewa lake and Sarangkot from Pokhara',
      'One porter for every two walkers',
    ],
    inclusions: [
      'Return flights, Dhaka to Kathmandu, and the Pokhara connection',
      'All accommodation, including teahouses on trek',
      'All meals while trekking',
      'TIMS card and ACAP permit',
      'A Beyond Borders trek leader and local porters',
    ],
    exclusions: [
      'Nepal visa on arrival',
      'Meals in Pokhara and Kathmandu',
      'Personal trekking gear',
      'Travel insurance covering trekking to 4,000 m, which is mandatory',
    ],
    status: PackageStatus.PUBLISHED,
    sortOrder: 12,
    metaDescription:
      'Seven-day Poon Hill trek and Pokhara trip from Dhaka. Teahouse nights, sunrise over ' +
      'Annapurna South, small group.',
    days: [
      {
        dayNumber: 1,
        title: 'Kathmandu to Pokhara',
        accommodation: 'Lakeside, Pokhara',
        meals: [],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Fly Dhaka–Kathmandu–Pokhara',
            startMinute: 480,
            durationMinutes: 420,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Phewa lake in the evening',
            startMinute: 1_020,
            durationMinutes: 90,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Drive to Nayapul, walk to Tikhedhunga',
        accommodation: 'Teahouse, Tikhedhunga',
        meals: ['Breakfast', 'Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Road to Nayapul',
            startMinute: 420,
            durationMinutes: 120,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Trek to Tikhedhunga',
            startMinute: 570,
            durationMinutes: 300,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'The stone steps to Ghorepani',
        accommodation: 'Teahouse, Ghorepani',
        meals: ['Breakfast', 'Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Ulleri steps and on to Ghorepani',
            detail: 'The hardest day. Around 3,200 steps, and everyone finds their own pace.',
            startMinute: 420,
            durationMinutes: 420,
          },
        ],
      },
      {
        dayNumber: 4,
        title: 'Poon Hill at dawn, then down to Tadapani',
        accommodation: 'Teahouse, Tadapani',
        meals: ['Breakfast', 'Lunch', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Poon Hill sunrise',
            detail: 'Up at 04:30 in the dark. It is worth it roughly four mornings in five.',
            startMinute: 270,
            durationMinutes: 180,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Descend to Tadapani',
            startMinute: 600,
            durationMinutes: 300,
          },
        ],
      },
      {
        dayNumber: 5,
        title: 'Out to Ghandruk and back to Pokhara',
        accommodation: 'Lakeside, Pokhara',
        meals: ['Breakfast', 'Lunch'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Trek to Ghandruk',
            startMinute: 420,
            durationMinutes: 240,
          },
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Jeep to Pokhara',
            startMinute: 720,
            durationMinutes: 180,
          },
        ],
      },
      {
        dayNumber: 6,
        title: 'Rest day in Pokhara',
        accommodation: 'Lakeside, Pokhara',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Sarangkot at dawn, weather permitting',
            startMinute: 300,
            durationMinutes: 180,
          },
          { kind: ItineraryBlockKind.FREE, title: 'The rest of the day is yours' },
        ],
      },
      {
        dayNumber: 7,
        title: 'Fly home',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Pokhara–Kathmandu–Dhaka',
            startMinute: 480,
            durationMinutes: 420,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 55,
        nights: 6,
        capacity: 12,
        seatsTaken: 9,
        status: DepartureStatus.GUARANTEED,
      },
      {
        startsInDays: 96,
        nights: 6,
        capacity: 12,
        seatsTaken: 3,
        status: DepartureStatus.SCHEDULED,
      },
    ],
    leaders: [
      { slug: 'tanvir-ahmed', role: TripLeaderRole.LEADER, isPrimary: true },
      { slug: 'farhana-rahman', role: TripLeaderRole.MANAGER },
    ],
  },

  {
    slug: 'kyoto-autumn-walks',
    title: 'Kyoto Autumn Walks',
    summary:
      'Eight days walking Kyoto in autumn colour. Not priced yet — the airfare that week moves ' +
      'too much to quote honestly this far out.',
    description:
      'A walking trip rather than a bus tour: the eastern hills one day, Arashiyama and the ' +
      'bamboo another, and the northern temples when the maples are at their best.\n\n' +
      'It is an interest list because the second half of November is the single most expensive ' +
      'week of the year to fly into Kansai, and the fare swings by more than we would be willing ' +
      'to absorb. Tell us you want to come, and we will price it the moment the fares for that ' +
      'window are real rather than indicative.',
    scope: PackageScope.INTERNATIONAL,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.INTEREST_ONLY,
    destinationLabel: 'Kyoto & Nara',
    country: 'Japan',
    durationDays: 8,
    durationNights: 7,
    groupSizeMin: 10,
    groupSizeMax: 16,
    highlights: [
      'The Higashiyama temples on foot, early',
      'Arashiyama bamboo before the crowds arrive',
      'A day in Nara among the deer',
      'Timed to the autumn colour, which is the whole reason to go then',
    ],
    inclusions: [
      'Return flights, Dhaka to Osaka',
      'Seven nights’ accommodation in central Kyoto',
      'Rail passes for the trip',
      'A Beyond Borders trip leader throughout',
    ],
    exclusions: [
      'Japan visa fee and application support',
      'Most meals — Kyoto is a city to eat your own way through',
      'Personal expenses',
      'Travel insurance',
    ],
    status: PackageStatus.PUBLISHED,
    sortOrder: 13,
    metaDescription:
      'Eight-day Kyoto walking trip in autumn colour season. Register your interest and we will ' +
      'price it when the fares are real.',
    days: [
      {
        dayNumber: 1,
        title: 'Arrive Osaka, train to Kyoto',
        accommodation: 'Central Kyoto',
        meals: [],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Kansai to Kyoto by train',
            startMinute: 720,
            durationMinutes: 120,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Higashiyama on foot',
        accommodation: 'Central Kyoto',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Kiyomizu-dera at opening',
            startMinute: 360,
            durationMinutes: 120,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Ninenzaka, Yasaka and Gion',
            startMinute: 540,
            durationMinutes: 240,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'Arashiyama',
        accommodation: 'Central Kyoto',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Bamboo grove, early',
            startMinute: 390,
            durationMinutes: 120,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Tenryu-ji and the Hozu river',
            startMinute: 570,
            durationMinutes: 210,
          },
        ],
      },
      {
        dayNumber: 4,
        title: 'Fushimi Inari and the southern hills',
        accommodation: 'Central Kyoto',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Fushimi Inari to the summit',
            startMinute: 330,
            durationMinutes: 240,
          },
          { kind: ItineraryBlockKind.FREE, title: 'Afternoon at leisure' },
        ],
      },
      {
        dayNumber: 5,
        title: 'Nara',
        accommodation: 'Central Kyoto',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Train to Nara',
            startMinute: 480,
            durationMinutes: 60,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Todai-ji, Kasuga Taisha and the park',
            startMinute: 570,
            durationMinutes: 300,
          },
        ],
      },
      {
        dayNumber: 6,
        title: 'The northern temples',
        accommodation: 'Central Kyoto',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Kinkaku-ji and Ryoan-ji',
            startMinute: 480,
            durationMinutes: 240,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'The Philosopher’s Path in full colour',
            startMinute: 840,
            durationMinutes: 150,
          },
        ],
      },
      {
        dayNumber: 7,
        title: 'A day with nothing in it',
        accommodation: 'Central Kyoto',
        meals: ['Breakfast'],
        items: [{ kind: ItineraryBlockKind.FREE, title: 'Deliberately unplanned' }],
      },
      {
        dayNumber: 8,
        title: 'Fly home',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Kyoto to Kansai',
            startMinute: 540,
            durationMinutes: 120,
          },
        ],
      },
    ],
    departures: [],
    leaders: [{ slug: 'farhana-rahman', role: TripLeaderRole.MANAGER, isPrimary: true }],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// The poll
// ─────────────────────────────────────────────────────────────────────────────

export interface PollOptionSeed {
  label: string
  subtitle: string
  sortOrder: number
}

export interface PollSeed {
  slug: string
  question: string
  description: string
  status: PollStatus
  /** Days from the seed run, for the same reason departures are relative. */
  closesInDays: number
  showResultsBeforeVote: boolean
  sortOrder: number
  options: PollOptionSeed[]
}

export const POLLS: PollSeed[] = [
  {
    slug: 'next-group-destination',
    question: 'Where should we run the next group trip?',
    description:
      'We build one new group departure a quarter, and this is genuinely how we choose it. ' +
      'Results stay hidden until you vote — seeing the leader first changes the answer.',
    status: PollStatus.OPEN,
    closesInDays: 45,
    showResultsBeforeVote: false,
    sortOrder: 0,
    options: [
      {
        label: 'Sri Lanka',
        subtitle: 'The hill country railway and the south coast',
        sortOrder: 0,
      },
      { label: 'Vietnam', subtitle: 'Ha Long Bay, Hoi An and the Hai Van pass', sortOrder: 1 },
      { label: 'Bhutan', subtitle: 'Paro, Thimphu and the Tiger’s Nest', sortOrder: 2 },
      { label: 'Georgia', subtitle: 'Tbilisi, Kazbegi and the Caucasus', sortOrder: 3 },
      { label: 'Maldives', subtitle: 'A local-island week, not a resort week', sortOrder: 4 },
    ],
  },
]
