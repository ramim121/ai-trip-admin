import {
  DepartureStatus,
  ItineraryBlockKind,
  PackageKind,
  PackagePricingMode,
  PackageScope,
  PackageStatus,
  TripLeaderRole,
} from '@/generated/prisma/enums'
import type { PackageSeed } from './discover'

/**
 * Six more group departures: three inside Bangladesh, three across South Asia.
 *
 * A second file rather than more of `discover.ts`, which is already long enough
 * that finding one trip in it is a search rather than a scroll. The shape is
 * identical — `PackageSeed` is imported from there, so both arrays go through
 * the same seeding path and neither can drift into its own format.
 *
 * All six are GROUP and FIXED_PRICE on purpose. The first eight already cover
 * the awkward combinations — private departures, interest-only pricing, a price
 * range, a sold-out date — so these do not need to re-prove any of it. What they
 * add is what the catalogue was actually thin on: somewhere to go this quarter
 * that is neither a beach nor a trek.
 */

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

const INTERNATIONAL_INCLUSIONS = [
  'Return flights from Dhaka',
  'Accommodation on twin-share basis',
  'Breakfast every morning',
  'Airport transfers and all internal transport',
  'A Beyond Borders trip leader throughout',
]

const INTERNATIONAL_EXCLUSIONS = [
  'Visa fees',
  'Lunches and dinners not listed',
  'Personal expenses and tips',
  'Travel insurance',
]

export const SOUTH_ASIA_PACKAGES: PackageSeed[] = [
  // ── Bangladesh ────────────────────────────────────────────────────────────
  {
    slug: 'sajek-valley-cloud-chase',
    title: 'Sajek Valley Cloud Chase',
    summary:
      'Three days in the Chittagong Hill Tracts, timed for the mornings when the valley fills ' +
      'with cloud and you are looking down at it.',
    description:
      'Sajek is above the cloud line often enough to plan around, and the whole trip is arranged ' +
      'to put you on the ridge at dawn twice. Two nights in a hill resort, with the convoy up ' +
      'from Khagrachari on the first afternoon.\n\n' +
      'The convoy is worth explaining: the road to Sajek runs in escorted groups at fixed times, ' +
      'so the departure hour is not ours to choose. Missing it costs a day, which is why we go up ' +
      'the afternoon before rather than the morning of.',
    scope: PackageScope.DOMESTIC,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationLabel: 'Sajek & Khagrachari',
    country: 'Bangladesh',
    durationDays: 3,
    durationNights: 2,
    priceFromBdt: 16_900,
    groupSizeMin: 12,
    groupSizeMax: 18,
    highlights: [
      'Two dawns on the ridge, above the cloud',
      'Konglak hill and the Lusai village',
      'Alutila cave and Risang waterfall on the way back',
      'Hill-tract food cooked by the people who live there',
    ],
    inclusions: [...STANDARD_INCLUSIONS, 'Escorted convoy permits to Sajek'],
    exclusions: STANDARD_EXCLUSIONS,
    status: PackageStatus.PUBLISHED,
    sortOrder: 4,
    metaDescription:
      'Three-day Sajek Valley group trip from Dhaka: two dawns above the cloud line, Konglak hill, ' +
      'Alutila cave and Risang waterfall.',
    days: [
      {
        dayNumber: 1,
        title: 'Khagrachari, then up with the convoy',
        accommodation: 'Hill resort, Sajek',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Arrive Khagrachari and transfer',
            startMinute: 420,
            durationMinutes: 90,
          },
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Escorted convoy to Sajek',
            detail: 'The departure hour is set by the escort, not by us. Roughly three hours up.',
            startMinute: 630,
            durationMinutes: 180,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Sunset from Ruilui para',
            startMinute: 1_020,
            durationMinutes: 90,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Dawn on the ridge, and Konglak',
        accommodation: 'Hill resort, Sajek',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Sunrise above the cloud',
            detail: 'Up at 05:00. Roughly three mornings in four it is worth it.',
            startMinute: 300,
            durationMinutes: 120,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Walk to Konglak hill and the Lusai village',
            startMinute: 600,
            durationMinutes: 210,
          },
          { kind: ItineraryBlockKind.FREE, title: 'Afternoon at leisure on the ridge' },
        ],
      },
      {
        dayNumber: 3,
        title: 'Down the hill, and the waterfall',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Convoy down to Khagrachari',
            startMinute: 570,
            durationMinutes: 180,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Alutila cave and Risang waterfall',
            startMinute: 810,
            durationMinutes: 180,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 26,
        nights: 2,
        capacity: 18,
        seatsTaken: 14,
        status: DepartureStatus.GUARANTEED,
      },
      {
        startsInDays: 54,
        nights: 2,
        capacity: 18,
        seatsTaken: 6,
        status: DepartureStatus.SCHEDULED,
      },
      {
        startsInDays: 89,
        nights: 2,
        capacity: 18,
        seatsTaken: 2,
        status: DepartureStatus.SCHEDULED,
      },
    ],
    leaders: [{ slug: 'tanvir-ahmed', role: TripLeaderRole.LEADER, isPrimary: true }],
  },

  {
    slug: 'saint-martins-island-weekend',
    title: 'Saint Martin’s Island Weekend',
    summary:
      'Three days on the only coral island in Bangladesh, with two nights on the island rather ' +
      'than the day trip everyone else runs.',
    description:
      'Almost every Saint Martin’s trip is a day trip: five hours on a boat for four hours on the ' +
      'island, most of them on the one crowded beach by the jetty. This is not that. Two nights ' +
      'on the island, which is what it takes to walk to Chera Dwip at low tide and to see the ' +
      'place after the last ferry has gone.\n\n' +
      'The season is short and we are strict about it. The ferries run roughly November to March; ' +
      'outside that window the crossing is unpleasant at best and cancelled at worst, so we do ' +
      'not schedule departures we would have to call off.',
    scope: PackageScope.DOMESTIC,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationSlug: 'coxs-bazar-bangladesh',
    destinationLabel: 'Saint Martin’s Island',
    country: 'Bangladesh',
    durationDays: 3,
    durationNights: 2,
    priceFromBdt: 19_500,
    groupSizeMin: 10,
    groupSizeMax: 16,
    highlights: [
      'Two nights on the island, not a day trip',
      'Chera Dwip on foot at low tide',
      'The island after the last ferry leaves',
      'Fresh catch grilled on the beach',
    ],
    inclusions: [
      ...STANDARD_INCLUSIONS,
      'Return ferry, Teknaf to Saint Martin’s',
      'Dinner on both island nights',
    ],
    exclusions: STANDARD_EXCLUSIONS,
    status: PackageStatus.PUBLISHED,
    sortOrder: 5,
    metaDescription:
      'Three-day Saint Martin’s Island group trip with two nights on the island: Chera Dwip at ' +
      'low tide, and the island after the day-trippers have gone.',
    days: [
      {
        dayNumber: 1,
        title: 'Teknaf, the crossing, and the quiet evening',
        accommodation: 'Beachfront resort, Saint Martin’s',
        meals: ['Breakfast', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Road to Teknaf and the ferry',
            startMinute: 360,
            durationMinutes: 300,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Walk the west beach as the ferries leave',
            detail: 'The island empties around four. This is the hour worth being here for.',
            startMinute: 960,
            durationMinutes: 120,
          },
          {
            kind: ItineraryBlockKind.MEAL,
            title: 'Grilled catch on the beach',
            startMinute: 1_170,
            durationMinutes: 90,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Chera Dwip at low tide',
        accommodation: 'Beachfront resort, Saint Martin’s',
        meals: ['Breakfast', 'Dinner'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Walk south to Chera Dwip',
            detail:
              'Only walkable around low tide, and the tide sets the hour rather than the ' +
              'itinerary. Roughly two hours each way over coral.',
            startMinute: 420,
            durationMinutes: 300,
          },
          { kind: ItineraryBlockKind.FREE, title: 'Afternoon at leisure' },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Snorkelling off the north point',
            detail: 'Weather permitting, and we will say so honestly when it is not.',
            startMinute: 900,
            durationMinutes: 120,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'The crossing back',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Ferry to Teknaf and the road home',
            startMinute: 540,
            durationMinutes: 360,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 38,
        nights: 2,
        capacity: 16,
        seatsTaken: 9,
        status: DepartureStatus.SCHEDULED,
        notes: 'Ferry season only. We do not schedule crossings we would have to cancel.',
      },
      {
        startsInDays: 66,
        nights: 2,
        capacity: 16,
        seatsTaken: 16,
        status: DepartureStatus.SOLD_OUT,
      },
    ],
    leaders: [{ slug: 'nusrat-jahan', role: TripLeaderRole.LEADER, isPrimary: true }],
  },

  {
    slug: 'north-bengal-heritage-trail',
    title: 'North Bengal Heritage Trail',
    summary:
      'Three days through the oldest buildings in the country — Paharpur, Mahasthangarh and the ' +
      'terracotta temples nobody queues for.',
    description:
      'The trip for people who have done the beaches. Paharpur is a UNESCO site and an eighth-' +
      'century Buddhist monastery, Mahasthangarh is the oldest urban site in Bangladesh, and ' +
      'between them are terracotta temples you will usually have entirely to yourself.\n\n' +
      'It is a driving trip and we are honest about that: north Bengal is flat and the sites are ' +
      'far apart. What the hours in the vehicle buy is a version of the country most visitors, ' +
      'and most Bangladeshis, never see.',
    scope: PackageScope.DOMESTIC,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationLabel: 'Bogura, Naogaon & Dinajpur',
    country: 'Bangladesh',
    durationDays: 3,
    durationNights: 2,
    priceFromBdt: 13_500,
    groupSizeMin: 10,
    groupSizeMax: 14,
    highlights: [
      'Somapura Mahavihara at Paharpur, a UNESCO site',
      'Mahasthangarh, the oldest urban site in the country',
      'Kantanagar terracotta temple in low afternoon light',
      'A guide who works on these sites',
    ],
    inclusions: [...STANDARD_INCLUSIONS, 'A specialist guide for the whole route'],
    exclusions: STANDARD_EXCLUSIONS,
    status: PackageStatus.PUBLISHED,
    sortOrder: 6,
    metaDescription:
      'Three-day north Bengal heritage trip: Paharpur, Mahasthangarh and the Kantanagar ' +
      'terracotta temple, with a specialist guide.',
    days: [
      {
        dayNumber: 1,
        title: 'To Bogura, and Mahasthangarh',
        accommodation: 'Hotel, Bogura',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Dhaka to Bogura',
            startMinute: 360,
            durationMinutes: 300,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Mahasthangarh and the site museum',
            startMinute: 780,
            durationMinutes: 210,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Paharpur',
        accommodation: 'Hotel, Bogura',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Somapura Mahavihara',
            detail: 'Early, before the light goes flat. Two hours with the guide, then your own.',
            startMinute: 480,
            durationMinutes: 240,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Kusumba mosque',
            startMinute: 840,
            durationMinutes: 120,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'Kantanagar, then home',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Kantanagar terracotta temple',
            detail: 'Timed for the afternoon, when the relief carving actually reads.',
            startMinute: 540,
            durationMinutes: 150,
          },
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Road to Dhaka',
            startMinute: 780,
            durationMinutes: 360,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 31,
        nights: 2,
        capacity: 14,
        seatsTaken: 5,
        status: DepartureStatus.SCHEDULED,
      },
      {
        startsInDays: 73,
        nights: 2,
        capacity: 14,
        seatsTaken: 3,
        status: DepartureStatus.SCHEDULED,
      },
    ],
    leaders: [
      { slug: 'imran-hossain', role: TripLeaderRole.LEADER, isPrimary: true },
      { slug: 'farhana-rahman', role: TripLeaderRole.MANAGER },
    ],
  },

  // ── South Asia ────────────────────────────────────────────────────────────
  {
    slug: 'bhutan-paro-thimphu-tigers-nest',
    title: 'Bhutan: Paro, Thimphu & the Tiger’s Nest',
    summary:
      'Six days in the one country that limits how many people may visit — the monasteries, the ' +
      'dzongs, and the climb to Taktsang.',
    description:
      'Bhutan charges a daily fee to be there and caps arrivals, which means the places in this ' +
      'itinerary are not crowded in the way their photographs suggest they should be. Three ' +
      'nights in Paro, two on the road east.\n\n' +
      'The Tiger’s Nest is the day everyone comes for and the one we brief hardest. It is a ' +
      'three-hour climb to 3,120 metres, and the group goes at the pace of whoever is slowest — ' +
      'which is the only pace that gets everybody there.',
    scope: PackageScope.INTERNATIONAL,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationLabel: 'Paro & Thimphu',
    country: 'Bhutan',
    durationDays: 6,
    durationNights: 5,
    priceFromBdt: 98_000,
    groupSizeMin: 8,
    groupSizeMax: 14,
    highlights: [
      'Taktsang — the Tiger’s Nest — on foot',
      'Punakha Dzong at the meeting of two rivers',
      'The Dochula pass on a clear morning',
      'A country that caps how many people may come',
    ],
    inclusions: [
      ...INTERNATIONAL_INCLUSIONS,
      'The Sustainable Development Fee for every day',
      'All monastery and dzong entry fees',
    ],
    exclusions: INTERNATIONAL_EXCLUSIONS,
    status: PackageStatus.PUBLISHED,
    sortOrder: 14,
    metaDescription:
      'Six-day Bhutan group trip from Dhaka: Paro, Thimphu, Punakha Dzong and the climb to the ' +
      'Tiger’s Nest.',
    days: [
      {
        dayNumber: 1,
        title: 'Fly into Paro',
        accommodation: 'Paro',
        meals: [],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Dhaka to Paro',
            detail: 'One of the more interesting approaches in aviation. Sit on the left.',
            startMinute: 420,
            durationMinutes: 180,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Rinpung Dzong and the covered bridge',
            startMinute: 840,
            durationMinutes: 150,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Over the Dochula pass to Punakha',
        accommodation: 'Punakha',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Drive over Dochula',
            detail: 'On a clear morning the Himalaya are out across the whole northern horizon.',
            startMinute: 480,
            durationMinutes: 240,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Punakha Dzong',
            startMinute: 780,
            durationMinutes: 180,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'Thimphu',
        accommodation: 'Thimphu',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Buddha Dordenma and the Memorial Chorten',
            startMinute: 540,
            durationMinutes: 240,
          },
          { kind: ItineraryBlockKind.FREE, title: 'Afternoon in the town' },
        ],
      },
      {
        dayNumber: 4,
        title: 'Back to Paro, and the briefing',
        accommodation: 'Paro',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Drive to Paro',
            startMinute: 540,
            durationMinutes: 150,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Kyichu Lhakhang, and the Taktsang briefing',
            startMinute: 840,
            durationMinutes: 150,
          },
        ],
      },
      {
        dayNumber: 5,
        title: 'The Tiger’s Nest',
        accommodation: 'Paro',
        meals: ['Breakfast', 'Lunch'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Climb to Taktsang',
            detail:
              'Three hours up to 3,120 m, at the pace of whoever is slowest. The cafeteria at the ' +
              'halfway point is a genuine turning-back point and nobody is judged for taking it.',
            startMinute: 420,
            durationMinutes: 420,
          },
        ],
      },
      {
        dayNumber: 6,
        title: 'Fly home',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Paro to Dhaka',
            startMinute: 480,
            durationMinutes: 180,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 47,
        nights: 5,
        capacity: 14,
        seatsTaken: 10,
        status: DepartureStatus.GUARANTEED,
      },
      {
        startsInDays: 88,
        nights: 5,
        capacity: 14,
        seatsTaken: 4,
        status: DepartureStatus.SCHEDULED,
      },
    ],
    leaders: [
      { slug: 'tanvir-ahmed', role: TripLeaderRole.LEADER, isPrimary: true },
      { slug: 'farhana-rahman', role: TripLeaderRole.MANAGER },
    ],
  },

  {
    slug: 'sri-lanka-hill-country-rail',
    title: 'Sri Lanka by Rail: Hill Country & the South',
    summary:
      'Eight days on the train from Kandy through the tea country to Ella, then down to the ' +
      'coast — booked in the observation car, which sells out months ahead.',
    description:
      'The Kandy to Ella line is the reason this trip exists. Seven hours through tea estates and ' +
      'cloud forest, and we book the observation car early because it genuinely does sell out ' +
      'months in advance.\n\n' +
      'After the hills the trip drops to the south coast for three nights — Galle fort, and ' +
      'beaches that are quiet in a way the west coast has not been for twenty years.',
    scope: PackageScope.INTERNATIONAL,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationLabel: 'Kandy, Ella & Galle',
    country: 'Sri Lanka',
    durationDays: 8,
    durationNights: 7,
    priceFromBdt: 112_000,
    groupSizeMin: 10,
    groupSizeMax: 16,
    highlights: [
      'Kandy to Ella in the observation car',
      'A working tea estate, from leaf to cup',
      'Little Adam’s Peak at sunrise',
      'Galle fort at the hour the day-trippers leave',
    ],
    inclusions: [
      ...INTERNATIONAL_INCLUSIONS,
      'Reserved observation-car seats, Kandy to Ella',
      'Temple of the Tooth entry',
    ],
    exclusions: INTERNATIONAL_EXCLUSIONS,
    status: PackageStatus.PUBLISHED,
    sortOrder: 15,
    metaDescription:
      'Eight-day Sri Lanka group trip by rail: Kandy, the tea country, Ella and the south coast, ' +
      'with reserved observation-car seats.',
    days: [
      {
        dayNumber: 1,
        title: 'Colombo to Kandy',
        accommodation: 'Kandy',
        meals: [],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Arrive Colombo, drive to Kandy',
            startMinute: 600,
            durationMinutes: 240,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Kandy',
        accommodation: 'Kandy',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Temple of the Tooth at the evening puja',
            startMinute: 1_020,
            durationMinutes: 120,
          },
          { kind: ItineraryBlockKind.FREE, title: 'The lake and the market, at your own pace' },
        ],
      },
      {
        dayNumber: 3,
        title: 'The train to Ella',
        accommodation: 'Ella',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Kandy to Ella, observation car',
            detail: 'Seven hours. Bring less than you think, and sit by a window that opens.',
            startMinute: 510,
            durationMinutes: 420,
          },
        ],
      },
      {
        dayNumber: 4,
        title: 'Ella',
        accommodation: 'Ella',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Little Adam’s Peak at sunrise',
            startMinute: 300,
            durationMinutes: 180,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Nine Arches bridge and a tea estate',
            startMinute: 600,
            durationMinutes: 240,
          },
        ],
      },
      {
        dayNumber: 5,
        title: 'Down to the coast',
        accommodation: 'South coast',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Ella to the south coast',
            startMinute: 540,
            durationMinutes: 270,
          },
        ],
      },
      {
        dayNumber: 6,
        title: 'Galle',
        accommodation: 'South coast',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Galle fort on foot',
            detail:
              'Late afternoon, once the coaches have gone and the ramparts are worth walking.',
            startMinute: 900,
            durationMinutes: 210,
          },
        ],
      },
      {
        dayNumber: 7,
        title: 'A day with nothing in it',
        accommodation: 'South coast',
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
            title: 'Transfer to Colombo and fly',
            startMinute: 420,
            durationMinutes: 300,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 58,
        nights: 7,
        capacity: 16,
        seatsTaken: 11,
        status: DepartureStatus.GUARANTEED,
      },
      {
        startsInDays: 104,
        nights: 7,
        capacity: 16,
        seatsTaken: 3,
        status: DepartureStatus.SCHEDULED,
      },
    ],
    leaders: [
      { slug: 'farhana-rahman', role: TripLeaderRole.MANAGER, isPrimary: true },
      { slug: 'nusrat-jahan', role: TripLeaderRole.LEADER },
    ],
  },

  {
    slug: 'kathmandu-valley-heritage',
    title: 'Kathmandu Valley: Three Cities',
    summary:
      'Five days across the valley’s three old royal cities — Kathmandu, Patan and Bhaktapur — ' +
      'walking rather than driving between the squares.',
    description:
      'The valley holds three separate medieval capitals within an hour of each other, and most ' +
      'itineraries reduce them to one afternoon each. This one gives each a day, on foot, with a ' +
      'guide who can tell you which parts are original and which were rebuilt after 2015.\n\n' +
      'That last part matters more than it sounds. A good half of what you will look at is ' +
      'reconstruction, some of it superb and some of it not, and knowing which is which is the ' +
      'difference between sightseeing and actually seeing the place.',
    scope: PackageScope.INTERNATIONAL,
    kind: PackageKind.GROUP,
    pricingMode: PackagePricingMode.FIXED_PRICE,
    destinationSlug: 'pokhara-nepal',
    destinationLabel: 'Kathmandu, Patan & Bhaktapur',
    country: 'Nepal',
    durationDays: 5,
    durationNights: 4,
    priceFromBdt: 58_000,
    groupSizeMin: 10,
    groupSizeMax: 16,
    highlights: [
      'Three durbar squares, a day each, on foot',
      'Boudhanath at dusk, when the kora fills',
      'Bhaktapur before the day buses arrive',
      'A guide who says which parts are reconstruction',
    ],
    inclusions: [...INTERNATIONAL_INCLUSIONS, 'All heritage-site entry fees for the valley'],
    exclusions: INTERNATIONAL_EXCLUSIONS,
    status: PackageStatus.PUBLISHED,
    sortOrder: 16,
    metaDescription:
      'Five-day Kathmandu Valley group trip: the durbar squares of Kathmandu, Patan and ' +
      'Bhaktapur, plus Boudhanath and Swayambhunath.',
    days: [
      {
        dayNumber: 1,
        title: 'Arrive Kathmandu',
        accommodation: 'Kathmandu',
        meals: [],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Dhaka to Kathmandu',
            startMinute: 600,
            durationMinutes: 150,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Boudhanath at dusk',
            detail: 'The kora fills as the light goes. Walk it clockwise, with everyone else.',
            startMinute: 1_020,
            durationMinutes: 120,
          },
        ],
      },
      {
        dayNumber: 2,
        title: 'Kathmandu',
        accommodation: 'Kathmandu',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Kathmandu Durbar Square',
            startMinute: 540,
            durationMinutes: 210,
          },
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Swayambhunath',
            startMinute: 900,
            durationMinutes: 150,
          },
        ],
      },
      {
        dayNumber: 3,
        title: 'Patan',
        accommodation: 'Kathmandu',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Patan Durbar Square and the museum',
            startMinute: 540,
            durationMinutes: 270,
          },
          { kind: ItineraryBlockKind.FREE, title: 'The metalworkers’ lanes, on your own' },
        ],
      },
      {
        dayNumber: 4,
        title: 'Bhaktapur',
        accommodation: 'Kathmandu',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.ACTIVITY,
            title: 'Bhaktapur, early',
            detail:
              'Before the day buses. The difference is roughly two hours and entirely worth it.',
            startMinute: 420,
            durationMinutes: 300,
          },
        ],
      },
      {
        dayNumber: 5,
        title: 'Fly home',
        meals: ['Breakfast'],
        items: [
          {
            kind: ItineraryBlockKind.TRANSIT,
            title: 'Kathmandu to Dhaka',
            startMinute: 660,
            durationMinutes: 150,
          },
        ],
      },
    ],
    departures: [
      {
        startsInDays: 43,
        nights: 4,
        capacity: 16,
        seatsTaken: 12,
        status: DepartureStatus.GUARANTEED,
      },
      {
        startsInDays: 79,
        nights: 4,
        capacity: 16,
        seatsTaken: 5,
        status: DepartureStatus.SCHEDULED,
      },
    ],
    leaders: [
      { slug: 'farhana-rahman', role: TripLeaderRole.MANAGER, isPrimary: true },
      { slug: 'tanvir-ahmed', role: TripLeaderRole.LEADER },
    ],
  },
]
