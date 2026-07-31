import { ActivityCategory, ActivityIntensity, TimeOfDay } from '@/generated/prisma/enums'

/**
 * The curated activity catalog.
 *
 * This is the ONLY inventory the planner may recommend. The model is grounded
 * on these rows and is not permitted to invent an activity: an invented outing
 * cannot be booked by ops, its price is fiction, and the traveller finds out at
 * the destination. Everything here is a real, specific, sellable thing —
 * durations, taka prices and opening hours included — because a plausible-
 * sounding placeholder is worse than an empty catalog. An empty catalog fails
 * loudly; a fake one fails at the airport.
 *
 * Prices are whole BDT per person unless `priceNote` says otherwise, and are
 * indicative retail as at the last content review, converted from local
 * currency at roughly BDT 3.4/THB, BDT 0.0074/IDR and BDT 0.91/NPR. Ops
 * re-quotes anything that goes on an invoice.
 *
 * No image rows are seeded. Fabricated image URLs would render broken cards and
 * would tell the model an activity is illustrated when it is not; content staff
 * upload licensed photography through the admin console. `sourceUrl` is set
 * only where the official site is known for certain and left null for the rest
 * to be filled in at content review — a guessed URL is a fabrication with a
 * footnote.
 */

/** Minutes from local midnight, the unit every time in the planner uses. */
export function at(hour: number, minute = 0): number {
  return hour * 60 + minute
}

/** 0 = Sunday … 6 = Saturday, matching JavaScript's Date#getDay(). */
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const MONDAY_TO_SATURDAY = [1, 2, 3, 4, 5, 6]

export interface OpeningWindowSeed {
  dayOfWeek: number
  opensMinute: number
  closesMinute: number
}

function openOn(days: number[], opens: number, closes: number): OpeningWindowSeed[] {
  return days.map((dayOfWeek) => ({ dayOfWeek, opensMinute: opens, closesMinute: closes }))
}

function daily(opens: number, closes: number): OpeningWindowSeed[] {
  return openOn(EVERY_DAY, opens, closes)
}

export interface ActivitySeed {
  slug: string
  name: string
  summary: string
  description: string
  category: ActivityCategory
  durationMinutes: number
  /** null = free or price on request; `priceNote` carries the nuance. */
  pricePerPersonBdt: number | null
  priceNote: string | null
  /** Strings, not floats: they reach Decimal(9,6) without a rounding step. */
  latitude: string | null
  longitude: string | null
  bestTimeOfDay: TimeOfDay
  minPartySize: number | null
  maxPartySize: number | null
  intensity: ActivityIntensity
  bookingRequired: boolean
  sourceUrl: string | null
  tags: string[]
  /** Empty means always available (an open beach, a public viewpoint). */
  openingHours: OpeningWindowSeed[]
}

export interface DestinationSeed {
  slug: string
  name: string
  country: string
  region: string | null
  summary: string
  timezone: string
  latitude: string
  longitude: string
  sortOrder: number
  activities: ActivitySeed[]
}

/**
 * Interest vocabulary. Tags are how a trip brief ("temples and street food,
 * nothing strenuous") is matched to inventory, so the slugs are stable and the
 * labels are what a traveller sees.
 */
export const TAG_LABELS: Record<string, string> = {
  'adventure-sports': 'Adventure sports',
  beach: 'Beach',
  'boat-trip': 'Boat trips',
  caves: 'Caves',
  'cooking-class': 'Cooking classes',
  coral: 'Coral & reefs',
  'cultural-heritage': 'Cultural heritage',
  cycling: 'Cycling',
  'ethical-tourism': 'Ethical tourism',
  'family-friendly': 'Family friendly',
  handicrafts: 'Handicrafts',
  hiking: 'Hiking',
  'island-hopping': 'Island hopping',
  kayaking: 'Kayaking',
  lakes: 'Lakes',
  'live-music': 'Live music',
  'live-performance': 'Live performance',
  'local-market': 'Local markets',
  mountains: 'Mountains',
  museums: 'Museums',
  nature: 'Nature',
  nightlife: 'Nightlife',
  paragliding: 'Paragliding',
  photography: 'Photography',
  rafting: 'White-water rafting',
  'rice-terraces': 'Rice terraces',
  rivers: 'Rivers',
  'scenic-drive': 'Scenic drives',
  seafood: 'Seafood',
  shopping: 'Shopping',
  snorkelling: 'Snorkelling',
  spa: 'Spa & massage',
  spiritual: 'Spiritual & ritual',
  'street-food': 'Street food',
  sunrise: 'Sunrise',
  sunset: 'Sunset',
  surfing: 'Surfing',
  temples: 'Temples',
  viewpoint: 'Viewpoints',
  volcano: 'Volcanoes',
  'walking-tour': 'Walking tours',
  waterfall: 'Waterfalls',
  wellness: 'Wellness',
  wildlife: 'Wildlife',
}

// ─────────────────────────────────────────────────────────────────────────────
// Bangladesh — Cox's Bazar
// ─────────────────────────────────────────────────────────────────────────────

const COXS_BAZAR: DestinationSeed = {
  slug: 'coxs-bazar-bangladesh',
  name: "Cox's Bazar",
  country: 'Bangladesh',
  region: 'Chattogram Division',
  summary:
    "The longest natural sea beach in the world — 120 unbroken kilometres of sand running south down the Marine Drive towards Teknaf, with Saint Martin's coral island offshore in the winter season.",
  timezone: 'Asia/Dhaka',
  latitude: '21.427200',
  longitude: '92.005800',
  sortOrder: 1,
  activities: [
    {
      slug: 'coxs-bazar-laboni-kolatoli-sunset-walk',
      name: 'Laboni to Kolatoli Beach Sunset Walk',
      summary:
        'Three kilometres of open sand between the two main beach points, timed for sunset over the Bay of Bengal.',
      description:
        "Laboni is the town-end beach and Kolatoli the hotel-end one, and the stretch between them is the walk that defines Cox's Bazar: flat hard sand, fishing boats drawn up above the tideline, and a sun that goes down straight into the Bay of Bengal. Start about ninety minutes before sunset from Laboni and drift south. Chairs and umbrellas are hired by the hour along the way. The current here is stronger than it looks and there are drownings every season — swim only between the lifeguard flags, and treat a red flag as absolute.",
      category: ActivityCategory.SIGHTSEEING,
      durationMinutes: 120,
      pricePerPersonBdt: null,
      priceNote: 'Free; beach chairs and umbrellas are about BDT 100 an hour',
      latitude: '21.427000',
      longitude: '91.979000',
      bestTimeOfDay: TimeOfDay.EVENING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['sunset', 'beach', 'photography', 'family-friendly'],
      openingHours: daily(at(5), at(20)),
    },
    {
      slug: 'coxs-bazar-himchari-national-park',
      name: 'Himchari National Park & Waterfall',
      summary:
        'Hill forest reserve eight kilometres south along the Marine Drive, with a seasonal waterfall and a ridge watchtower over the beach.',
      description:
        'Himchari protects a strip of tropical evergreen hill forest where the ridges meet the sea. A short walk from the road reaches the waterfall — genuinely impressive during and just after the monsoon, a trickle by March — and a stepped path climbs to a watchtower looking north along the entire beach. Rhesus macaques and hornbills are common, barking deer less so. You get there on the Marine Drive, which is half the point: the road runs between the hills and the sand the whole way. Pairs naturally with Inani in one southbound half-day.',
      category: ActivityCategory.NATURE,
      durationMinutes: 210,
      pricePerPersonBdt: 600,
      priceNote: 'Park entry plus shared jeep from Kolatoli',
      latitude: '21.354000',
      longitude: '92.030000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.MODERATE,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['waterfall', 'nature', 'viewpoint', 'scenic-drive', 'wildlife'],
      openingHours: daily(at(8), at(17)),
    },
    {
      slug: 'coxs-bazar-inani-patuartek-drive',
      name: 'Inani & Patuartek Coral Rock Beach Drive',
      summary:
        'Marine Drive run 32 km south to the boulder fields at Inani and Patuartek, best at low tide.',
      description:
        "The Marine Drive south from Cox's Bazar is one of the great coastal roads — hills on the left, unbroken beach on the right, eighty kilometres to Teknaf. Inani, half an hour down, is where fields of rounded coral-limestone boulders emerge from the sand as the tide drops; Patuartek a little further has bigger formations and far fewer people. Check the tide before setting out, because at high water the boulders are simply underwater and there is nothing to see. Half a day with a hired car. Sunrise beats sunset here, with the light coming over the hills behind you.",
      category: ActivityCategory.SIGHTSEEING,
      durationMinutes: 300,
      pricePerPersonBdt: 1800,
      priceNote:
        'Seat in a shared car for the round trip; a private car is about BDT 4,500 for the vehicle',
      latitude: '21.235000',
      longitude: '92.048000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['beach', 'scenic-drive', 'photography', 'coral'],
      openingHours: daily(at(7), at(18)),
    },
    {
      slug: 'coxs-bazar-saint-martins-day-trip',
      name: "Saint Martin's Island Day Trip by Ship",
      summary:
        "Bangladesh's only coral island, reached by passenger ship from Teknaf — clear water, coconut palms and Chhera Dwip at low tide.",
      description:
        "Saint Martin's — Narikel Jinjira — is a nine-square-kilometre coral island off the Teknaf peninsula, and the only place in the country with living coral. The day runs long: pre-dawn road transfer to Teknaf, a ship down the Naf river with Myanmar on the far bank, three hours or so ashore for the beach and a walk or boat to Chhera Dwip at the southern tip, then the afternoon sailing back. Two things govern this trip and neither is negotiable: ships sail only in the November–March season, and access is capped by government rules requiring a travel pass, which change from year to year. Confirm the current rules before booking anything else around it.",
      category: ActivityCategory.ADVENTURE,
      durationMinutes: 780,
      pricePerPersonBdt: 4500,
      priceNote:
        "Return ship ticket and road transfer from Cox's Bazar. November–March season only, and a government travel pass is required.",
      latitude: '20.627000',
      longitude: '92.323000',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: 1,
      maxPartySize: null,
      intensity: ActivityIntensity.MODERATE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['island-hopping', 'boat-trip', 'beach', 'snorkelling', 'coral'],
      openingHours: daily(at(5, 30), at(19, 30)),
    },
    {
      slug: 'coxs-bazar-maheshkhali-adinath',
      name: 'Maheshkhali Island Boat Trip & Adinath Temple',
      summary:
        'Speedboat across the channel to the only hill island on this coast, for the Adinath Shiva temple on Mainak hill and the betel-leaf villages below it.',
      description:
        "Maheshkhali is the one island off this coast with hills, and the crossing from Cox's Bazar jetty takes about half an hour by speedboat or ninety minutes by trawler. The Adinath temple sits at the top of Mainak hill up a long flight of steps, with a Buddhist pagoda and a mosque within a few hundred metres of it — the mix is the island's character. Below, the villages grow the betel leaf the island is known for and dry fish along the shore. Take the earlier boat and be back before the afternoon chop.",
      category: ActivityCategory.CULTURE,
      durationMinutes: 330,
      pricePerPersonBdt: 1400,
      priceNote: 'Return speedboat and local transport on the island',
      latitude: '21.570000',
      longitude: '91.960000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: 2,
      maxPartySize: null,
      intensity: ActivityIntensity.MODERATE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['boat-trip', 'temples', 'island-hopping', 'local-market', 'cultural-heritage'],
      openingHours: daily(at(7), at(17)),
    },
    {
      slug: 'coxs-bazar-ramu-buddhist-village',
      name: 'Ramu Buddhist Village & Bara Kyang',
      summary:
        'The Rakhine Buddhist settlement 16 km inland: monasteries, a large bronze Buddha, and family workshops weaving and casting by hand.',
      description:
        "Ramu is a centuries-old Rakhine Buddhist village on the Bakkhali river, and the most rewarding cultural half-day near Cox's Bazar. The Bara Kyang monastery holds a large bronze Buddha; the Ramu Central Simha Bihar and a cluster of smaller kyangs are within walking distance, several rebuilt after the 2012 arson attacks — the village is candid about that history and it is worth understanding before you go. Family workshops along the main lane weave Rakhine textiles on pit looms and cast bronze and brass. Shoes off at every monastery, and ask before photographing monks.",
      category: ActivityCategory.CULTURE,
      durationMinutes: 210,
      pricePerPersonBdt: 900,
      priceNote: 'Transport and local guide; monastery entry is by donation',
      latitude: '21.430000',
      longitude: '92.100000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['temples', 'cultural-heritage', 'handicrafts'],
      openingHours: daily(at(9), at(17)),
    },
    {
      slug: 'coxs-bazar-burmese-market',
      name: 'Burmese Market (Boro Bazar) Shopping',
      summary:
        'Cross-border goods market in town — Rakhine textiles, dried fish, shell and bamboo craft, blankets, pickles and cosmetics.',
      description:
        'The Burmese Market off Main Road is where the cross-border trade lands: hand-loomed Rakhine thami and longyi, Burmese blankets and slippers, thanaka and cheap cosmetics, shell and bamboo craft, jars of shutki and pickled fruit. Prices open high for visitors and haggling is expected — settle around half the first number and be willing to walk. Late afternoon is liveliest. Buy dried fish vacuum-packed if it is going in a suitcase, and check what your onward country allows before buying any shell or coral item at all.',
      category: ActivityCategory.SHOPPING,
      durationMinutes: 120,
      pricePerPersonBdt: null,
      priceNote: 'Free to browse',
      latitude: '21.434000',
      longitude: '91.984000',
      bestTimeOfDay: TimeOfDay.AFTERNOON,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['shopping', 'local-market', 'handicrafts'],
      openingHours: daily(at(10), at(22)),
    },
    {
      slug: 'coxs-bazar-kolatoli-seafood-bbq',
      name: 'Kolatoli Sea-Fish BBQ Dinner',
      summary:
        'Pick your fish off the ice at a Kolatoli grill house and have it barbecued — rupchanda, coral fish, king prawn, lobster.',
      description:
        "The grill houses along the Kolatoli beach road display the day's catch on ice and cook what you point at: rupchanda (silver pomfret) is the local benchmark, alongside coral fish, red snapper, king prawn, squid and lobster. It is sold by weight, so agree the weight and the price before it goes on the coals — this is where visitors overpay. Served with rice, dal and a mustard-chilli chutney. Ask for grilled rather than deep-fried. Busy from about eight; choose the place with a queue of Bangladeshi families rather than the loudest tout.",
      category: ActivityCategory.FOOD,
      durationMinutes: 90,
      pricePerPersonBdt: 1200,
      priceNote:
        'Typical per head for grilled fish with rice; lobster is charged by weight and costs considerably more',
      latitude: '21.416000',
      longitude: '91.988000',
      bestTimeOfDay: TimeOfDay.NIGHT,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['seafood', 'street-food', 'nightlife'],
      openingHours: daily(at(17), at(23, 30)),
    },
    {
      slug: 'coxs-bazar-parasailing-laboni',
      name: 'Parasailing at Laboni Point',
      summary:
        'Boat-towed parasail flight over the beach — about ten minutes airborne, no experience needed.',
      description:
        'A short, genuinely fun adrenaline stop on the main beach: harness and life jacket on, a speedboat takes up the slack and the canopy lifts you 150 metres or so above the water for eight to twelve minutes, with the whole sweep of the beach below. Take-off and landing are from the boat deck, so nothing is asked of you but sitting still. Weight limits apply and flights stop when the wind or surf gets up. Operators cluster at Laboni Point; use one visibly checking harnesses between flights, and leave phones and glasses on the boat.',
      category: ActivityCategory.WATER_SPORTS,
      durationMinutes: 45,
      pricePerPersonBdt: 2500,
      priceNote: 'Single tandem flight of roughly ten minutes',
      latitude: '21.429000',
      longitude: '91.977000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: 1,
      maxPartySize: 2,
      intensity: ActivityIntensity.ACTIVE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['adventure-sports', 'beach', 'photography'],
      openingHours: daily(at(8), at(17)),
    },
    {
      slug: 'coxs-bazar-dulahazara-safari-park',
      name: 'Dulahazara Safari Park',
      summary:
        'Drive-through safari park 50 km north on the Chattogram highway — Asian elephants, sambar and spotted deer, gaur, and a big-cat section.',
      description:
        "Bangladesh's first safari park, on reserve forest at Dulahazara, run as much as a rescue and breeding centre as an attraction. The core is the drive-through enclosure where deer, gaur and elephants range loose around the minibus; there are separate sections for tigers, lions, bears and crocodiles, an aviary, and a small elephant orphanage. Manage expectations: this is a working conservation facility, not a private game reserve, and enclosure standards vary. Best in the cooler morning hours when the animals move. Efficient to fit in on the way to or from Chattogram rather than as a return trip from the beach.",
      category: ActivityCategory.NATURE,
      durationMinutes: 300,
      pricePerPersonBdt: 700,
      priceNote: "Entry plus the safari minibus ride; transport from Cox's Bazar extra",
      latitude: '21.647000',
      longitude: '92.064000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['wildlife', 'nature', 'family-friendly'],
      openingHours: daily(at(9), at(17)),
    },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Thailand — Phuket
// ─────────────────────────────────────────────────────────────────────────────

const PHUKET: DestinationSeed = {
  slug: 'phuket-thailand',
  name: 'Phuket',
  country: 'Thailand',
  region: 'Andaman Coast',
  summary:
    "Thailand's largest island, and the easiest long-weekend beach trip out of Dhaka: limestone islands and snorkelling bays on one side, a Sino-Portuguese old town and hill temples on the other.",
  timezone: 'Asia/Bangkok',
  latitude: '7.880448',
  longitude: '98.392254',
  sortOrder: 2,
  activities: [
    {
      slug: 'phuket-phi-phi-maya-bay-speedboat',
      name: 'Phi Phi Islands & Maya Bay Speedboat Day Trip',
      summary:
        'Full-day speedboat circuit of Maya Bay, Pileh Lagoon and Bamboo Island with two snorkelling stops and lunch on Phi Phi Don.',
      description:
        "Hotel pickup on Phuket's west coast, then a 45-minute speedboat run to the Phi Phi group. The route takes in Maya Bay — entry is by the national park's timed slot system since the bay reopened under visitor caps — plus Pileh Lagoon and Viking Cave, with snorkelling at Loh Samah and again off Bamboo Island. Lunch is a buffet on Phi Phi Don. Mask, snorkel and fins are provided; the national park fee is normally collected separately at the pier. Seas are calmest November to April; in the monsoon months trips are cancelled for weather often enough that the operator refunds rather than sails.",
      category: ActivityCategory.WATER_SPORTS,
      durationMinutes: 540,
      pricePerPersonBdt: 7500,
      priceNote:
        'Speedboat, lunch, snorkel gear and hotel transfer; national park fee paid at the pier',
      latitude: '7.678900',
      longitude: '98.767200',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: 1,
      maxPartySize: 30,
      intensity: ActivityIntensity.MODERATE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['island-hopping', 'snorkelling', 'beach', 'boat-trip', 'photography'],
      openingHours: daily(at(7), at(17, 30)),
    },
    {
      slug: 'phuket-big-buddha',
      name: 'Big Buddha (Ming Mongkol Buddha), Nakkerd Hill',
      summary:
        "A 45-metre marble Buddha on the ridge between Chalong and Kata, with the island's widest viewpoint at its feet.",
      description:
        'A steep six-kilometre road climbs Nakkerd Hill to the Ming Mongkol Buddha, faced in Burmese white jade marble and visible from most of southern Phuket. The terrace looks over Chalong Bay on one side and Kata on the other. Shoulders and knees must be covered — sarongs are lent free at the entrance. The site is still under construction and runs on donations rather than an entry fee. Go before 10:00 or after 16:00; midday is hot and full of tour buses.',
      category: ActivityCategory.SIGHTSEEING,
      durationMinutes: 120,
      pricePerPersonBdt: null,
      priceNote:
        'Free entry; donations fund the ongoing construction. Allow about BDT 900 for a return taxi.',
      latitude: '7.827800',
      longitude: '98.312000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['viewpoint', 'temples', 'photography', 'cultural-heritage'],
      openingHours: daily(at(6), at(19)),
    },
    {
      slug: 'phuket-old-town-heritage-walk',
      name: 'Old Phuket Town Sino-Portuguese Heritage Walk',
      summary:
        'Guided walk through Thalang Road and Soi Romanee — shophouse architecture, Hokkien shrines and a Peranakan coffee stop.',
      description:
        "Phuket Town was built on tin money, and the Sino-Portuguese shophouses along Thalang, Dibuk and Krabi Roads are what the money bought. The walk covers the Thai Hua Museum's mansion facade, the pastel row on Soi Romanee, the Jui Tui and Put Jaw Chinese shrines, and finishes over Peranakan-style coffee and o-aew shaved ice. On Sunday afternoons Thalang Road closes for the Lard Yai walking street, which is the best and the busiest time to go.",
      category: ActivityCategory.CULTURE,
      durationMinutes: 180,
      pricePerPersonBdt: 1800,
      priceNote: 'Guided walk including museum entry and one coffee stop',
      latitude: '7.884300',
      longitude: '98.387800',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: 2,
      maxPartySize: 12,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['cultural-heritage', 'walking-tour', 'photography', 'local-market', 'street-food'],
      openingHours: daily(at(9), at(18)),
    },
    {
      slug: 'phuket-phang-nga-sea-cave-canoe',
      name: 'Phang Nga Bay Sea Cave Canoeing & James Bond Island',
      summary:
        'Long-tail cruise into the limestone karsts of Phang Nga Bay, paddling through tidal sea caves into hidden hongs.',
      description:
        'Phang Nga Bay is a drowned karst landscape: hundreds of limestone towers, many of them hollow. A guide paddles each two-person canoe through low tidal caves — at some tides you lie flat in the boat to clear the roof — and out into hongs, collapsed interiors open to the sky and reachable no other way. The itinerary usually takes in Panak and Hong islands, a stop at Ko Tapu (James Bond Island, from The Man with the Golden Gun) and lunch aboard. Cave access is tide-dependent, so the operator sets the departure time, not you.',
      category: ActivityCategory.ADVENTURE,
      durationMinutes: 600,
      pricePerPersonBdt: 8200,
      priceNote: 'Long-tail boat, canoe with guide paddler, lunch and transfers',
      latitude: '8.274500',
      longitude: '98.501700',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: 1,
      maxPartySize: 24,
      intensity: ActivityIntensity.MODERATE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['boat-trip', 'caves', 'kayaking', 'photography', 'nature'],
      openingHours: daily(at(7), at(18)),
    },
    {
      slug: 'phuket-thai-cooking-class-kathu',
      name: 'Thai Cooking Class with Market Tour, Kathu',
      summary:
        'Half-day class: shop a Kathu wet market for the ingredients, then cook four southern Thai dishes and eat them.',
      description:
        'Starts at a local wet market in Kathu, where the teacher walks you through galangal against ginger, the three basils, palm sugar grades and which chilli does what. Back at the school each cook gets a wok station and makes four dishes — typically tom yum goong, green curry from a paste you pound yourself, pad thai and mango sticky rice. Vegetarian, halal and no-shellfish versions are standard with notice. You eat what you cook and leave with a recipe booklet.',
      category: ActivityCategory.FOOD,
      durationMinutes: 240,
      pricePerPersonBdt: 4200,
      priceNote: 'Market tour, all ingredients, apron, recipe booklet and the meal',
      latitude: '7.908000',
      longitude: '98.335000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: 1,
      maxPartySize: 12,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['cooking-class', 'local-market', 'family-friendly', 'street-food'],
      openingHours: openOn(MONDAY_TO_SATURDAY, at(9), at(16)),
    },
    {
      slug: 'phuket-traditional-thai-massage-patong',
      name: 'Traditional Thai Massage, Patong',
      summary:
        'Ninety minutes of nuad phaen boran — the dry, clothed, stretch-and-pressure Thai massage.',
      description:
        'Traditional Thai massage is done on a floor mat, fully clothed in the loose cotton the shop provides, with no oil. The therapist works compression along the sen lines and moves you through assisted yoga-style stretches; expect firm thumbs and forearms rather than a soothing glide. Say so if you want it lighter. Reputable shopfronts around Patong and Kata charge a fraction of hotel-spa rates for the same technique. Not advisable straight after a heavy meal.',
      category: ActivityCategory.WELLNESS,
      durationMinutes: 90,
      pricePerPersonBdt: 1400,
      priceNote: 'Shopfront rate; hotel spas charge roughly three times this',
      latitude: '7.891800',
      longitude: '98.296000',
      bestTimeOfDay: TimeOfDay.ANY,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['spa', 'wellness'],
      openingHours: daily(at(10), at(23)),
    },
    {
      slug: 'phuket-bangla-road-night-walk',
      name: 'Bangla Road Night Walk, Patong',
      summary:
        "Phuket's loudest 400 metres — bar street, cover bands and street food, closed to traffic after dark.",
      description:
        'Bangla Road shuts to vehicles in the evening and becomes a pedestrian strip of open-fronted bars, cover bands and neon. It is loud, relentlessly touted and best treated as a spectacle you walk through rather than a night you spend. Practicalities: agree prices before ordering anything, ignore anyone selling a "show", keep phones in a front pocket. The soi off the main strip have the better live music. Not suitable for children, and the wrong recommendation for a family or honeymoon brief.',
      category: ActivityCategory.NIGHTLIFE,
      durationMinutes: 150,
      pricePerPersonBdt: null,
      priceNote: 'No cover charge; drinks are pay-as-you-go, roughly BDT 350 for a local beer',
      latitude: '7.892600',
      longitude: '98.296600',
      bestTimeOfDay: TimeOfDay.NIGHT,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['nightlife', 'live-music', 'street-food'],
      // Runs past midnight: minute 1560 is 02:00 the following morning.
      openingHours: daily(at(18), at(26)),
    },
    {
      slug: 'phuket-promthep-cape-sunset',
      name: 'Promthep Cape Sunset',
      summary:
        "The headland at Phuket's southern tip, and the island's classic sunset over the Andaman Sea.",
      description:
        'Laem Phromthep is the rocky spur at the southern end of the island, with a lighthouse museum, an elephant shrine and an unbroken western horizon. Arrive forty minutes before sunset — the small car park fills and the best ground on the point goes first. Walking down the spine of the headland gets you away from the crowd on the viewing terrace. Windy year-round, no shade, and no railing at the far end.',
      category: ActivityCategory.SIGHTSEEING,
      durationMinutes: 90,
      pricePerPersonBdt: null,
      priceNote: 'Free',
      latitude: '7.762000',
      longitude: '98.305000',
      bestTimeOfDay: TimeOfDay.EVENING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['sunset', 'viewpoint', 'photography'],
      openingHours: daily(at(6), at(19, 30)),
    },
    {
      slug: 'phuket-kata-beach-surf-lesson',
      name: 'Beginner Surf Lesson, Kata Beach',
      summary:
        'Two-hour first lesson on the soft beach break at Kata, board and instructor included.',
      description:
        "Kata is where Phuket teaches people to surf: sandy bottom, a forgiving inside break, and surf schools lined along the south end of the beach. The lesson covers paddling, the pop-up on the sand, then time in the whitewater with the instructor pushing you into waves. Most people stand up in the first session. The swell that makes this work is monsoon swell — surfing runs roughly May to October, and outside those months the bay is flat. Red-flag days mean no lesson; that is the lifeguards' call, not the school's.",
      category: ActivityCategory.WATER_SPORTS,
      durationMinutes: 120,
      pricePerPersonBdt: 3400,
      priceNote: 'Board, rash vest and instructor; surfable swell runs May to October',
      latitude: '7.819900',
      longitude: '98.297700',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: 1,
      maxPartySize: 8,
      intensity: ActivityIntensity.ACTIVE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['surfing', 'beach', 'adventure-sports'],
      openingHours: daily(at(8), at(17)),
    },
    {
      slug: 'phuket-elephant-sanctuary-morning',
      name: 'Phuket Elephant Sanctuary Morning Visit',
      summary:
        'Observation-only visit to a retirement sanctuary for former logging and trekking elephants. No riding, no bathing, no performances.',
      description:
        "A retirement home in Paklok for elephants worked out of the logging and trekking trades, run on a hands-off model: guests walk raised boardwalks and watch the herd forage, bathe and rest on their own terms. There is no riding, no washing the elephants and no tricks — contact is what stresses a recovering animal, and the sanctuary is explicit that these elephants are not entertainers. Each animal's history is told on the tour, and it is not a comfortable set of stories. Includes a vegetarian buffet lunch and transfers. Book well ahead; visitor numbers are capped by design.",
      category: ActivityCategory.NATURE,
      durationMinutes: 240,
      pricePerPersonBdt: 9500,
      priceNote: 'Guided boardwalk tour, buffet lunch and hotel transfer',
      latitude: '8.050000',
      longitude: '98.360000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: 1,
      maxPartySize: 20,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: true,
      sourceUrl: 'https://www.phuketelephantsanctuary.org',
      tags: ['wildlife', 'ethical-tourism', 'nature', 'family-friendly'],
      openingHours: daily(at(9, 30), at(16)),
    },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Indonesia — Bali
// ─────────────────────────────────────────────────────────────────────────────

const BALI: DestinationSeed = {
  slug: 'bali-indonesia',
  name: 'Bali',
  country: 'Indonesia',
  region: 'Lesser Sunda Islands',
  summary:
    'Volcanic ridges, water temples and rice terraces inland around Ubud; surf beaches and beach clubs in the south. Visa on arrival for Bangladeshi passports, routed through Kuala Lumpur or Bangkok.',
  timezone: 'Asia/Makassar',
  latitude: '-8.409518',
  longitude: '115.188919',
  sortOrder: 3,
  activities: [
    {
      slug: 'bali-tegallalang-rice-terraces',
      name: 'Tegallalang Rice Terrace Walk',
      summary:
        'Early-morning walk down and across the terraced valley north of Ubud, before the coach parties and the swing queues.',
      description:
        'The Tegallalang terraces are carved into a steep valley and irrigated by subak, the thousand-year-old cooperative water system UNESCO lists as a cultural landscape. A path drops from the roadside cafes to the valley floor and climbs the far side — steep, uneven, slippery after rain, about an hour round trip. Farmers along the route ask a small donation at several points, which is normal and worth carrying small notes for. Go at 07:00: by 09:30 the roadside is coaches and the photo swings have queues.',
      category: ActivityCategory.NATURE,
      durationMinutes: 120,
      pricePerPersonBdt: 350,
      priceNote: 'Entry plus the customary small donations along the valley path',
      latitude: '-8.431200',
      longitude: '115.279200',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.MODERATE,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['rice-terraces', 'nature', 'photography', 'viewpoint', 'hiking'],
      openingHours: daily(at(7), at(18)),
    },
    {
      slug: 'bali-tirta-empul-melukat',
      name: 'Tirta Empul Holy Spring Purification (Melukat)',
      summary:
        'The Balinese Hindu water purification ritual at the spring temple at Tampaksiring, with a guide to the sequence of spouts.',
      description:
        'Tirta Empul has been a purification site since 962 CE. Pilgrims enter the bathing pool in a sarong and move left to right along the row of stone spouts, praying and passing their head under each — two spouts near the end are reserved for funerary rites and are skipped by the living. A guide matters here: the sequence, the offerings and what to do with your hands are not obvious, and getting it wrong in front of worshippers is discourteous rather than harmless. Sarong and sash required, a change of clothes essential, and menstruating women are asked not to enter the pool.',
      category: ActivityCategory.CULTURE,
      durationMinutes: 150,
      pricePerPersonBdt: 800,
      priceNote: 'Entry, sarong hire, locker and offering',
      latitude: '-8.415500',
      longitude: '115.315300',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['temples', 'spiritual', 'cultural-heritage'],
      openingHours: daily(at(8), at(18)),
    },
    {
      slug: 'bali-mount-batur-sunrise-trek',
      name: 'Mount Batur Sunrise Trek',
      summary:
        'Pre-dawn climb of an active volcano for sunrise over Lake Batur and Mount Agung, with eggs cooked in a steam vent at the summit.',
      description:
        "Pickup is around 02:00 for the drive to Toya Bungkah, then a two-hour climb by torchlight up 1,717-metre Mount Batur. The summit ridge looks east over Lake Batur to Mount Agung and, on clear mornings, Lombok's Rinjani beyond. Guides cook eggs and bananas in the volcanic steam vents at the top. The path is loose volcanic scree and genuinely steep in the last section — proper shoes, a head torch and a windproof layer, because the summit is cold before dawn. A licensed local guide is compulsory on this mountain. Not for young children or anyone whose knees dislike a long descent.",
      category: ActivityCategory.ADVENTURE,
      durationMinutes: 480,
      pricePerPersonBdt: 6200,
      priceNote: 'Licensed guide, head torch, summit breakfast and hotel transfer',
      latitude: '-8.242200',
      longitude: '115.375300',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: 1,
      maxPartySize: 15,
      intensity: ActivityIntensity.ACTIVE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['hiking', 'sunrise', 'volcano', 'viewpoint', 'mountains'],
      // Pickup from 01:30; parties are back down by mid-morning.
      openingHours: daily(at(1, 30), at(10)),
    },
    {
      slug: 'bali-sacred-monkey-forest-ubud',
      name: 'Sacred Monkey Forest Sanctuary, Ubud',
      summary:
        'Twelve hectares of temple forest in the middle of Ubud, home to around 1,200 long-tailed macaques and three 14th-century temples.',
      description:
        'A conservation area and a working temple complex rather than a zoo: moss-covered stone stairways, a banyan-shaded ravine and the 14th-century Pura Dalem Agung. The macaques are wild and habituated, which is a warning rather than a selling point — they take sunglasses, water bottles, phones and anything in an open bag, and a bite means a rabies clinic visit. Keep bags zipped, carry no food, avoid eye contact, and never try to take an item back yourself; staff do that. Otherwise it is one of the calmest walks in central Ubud.',
      category: ActivityCategory.NATURE,
      durationMinutes: 90,
      pricePerPersonBdt: 900,
      priceNote: 'Adult entry; children roughly two thirds',
      latitude: '-8.518800',
      longitude: '115.258600',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: 'https://monkeyforestubud.com',
      tags: ['wildlife', 'temples', 'nature', 'family-friendly'],
      openingHours: daily(at(8, 30), at(18)),
    },
    {
      slug: 'bali-uluwatu-kecak-sunset',
      name: 'Uluwatu Temple & Kecak Fire Dance at Sunset',
      summary:
        'Clifftop sea temple 70 metres above the Indian Ocean, followed by the Kecak chant-and-fire performance in the open-air amphitheatre.',
      description:
        'Pura Luhur Uluwatu sits on a limestone cliff at the south-western tip of the island, one of Bali\'s six directional sea temples. The 18:00 Kecak performance is staged in an amphitheatre on the cliff edge with the sunset behind it: no instruments at all, just around seventy men chanting "cak" in interlocking rhythm while the Ramayana plays out, ending with Hanuman in a ring of fire. Buy dance tickets ahead or on arrival — the good rows go early. Sarong and sash are required for the temple and provided at the gate. The resident macaques here are notorious specifically for taking glasses; keep them cased.',
      category: ActivityCategory.CULTURE,
      durationMinutes: 210,
      pricePerPersonBdt: 1900,
      priceNote: 'Temple entry plus Kecak dance ticket; transfer extra',
      latitude: '-8.829100',
      longitude: '115.084900',
      bestTimeOfDay: TimeOfDay.EVENING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['temples', 'sunset', 'live-performance', 'cultural-heritage', 'viewpoint'],
      openingHours: daily(at(9), at(19, 30)),
    },
    {
      slug: 'bali-nusa-penida-west-tour',
      name: 'Nusa Penida West Tour: Kelingking & Broken Beach',
      summary:
        "Long day by fast boat to Nusa Penida for the T-rex headland at Kelingking, the collapsed sea arch at Broken Beach and the Angel's Billabong tide pool.",
      description:
        "Fast boat from Sanur to Toya Pakeh, roughly 45 minutes, then a hired car and driver for the west-coast circuit: the Kelingking viewpoint where the headland reads as a dinosaur's spine, the collapsed arch at Pasih Uug (Broken Beach), the Angel's Billabong rock pool and Crystal Bay for a swim before the return crossing. Two hard truths: the descent to Kelingking's beach is a near-vertical scramble on a bamboo handrail and most people should skip it, and Penida's roads are narrow, steep and badly surfaced, so the driving takes longer than the map suggests. Crossings are cancelled in rough weather.",
      category: ActivityCategory.SIGHTSEEING,
      durationMinutes: 660,
      pricePerPersonBdt: 9800,
      priceNote: 'Return fast boat, private car with driver, entry fees and lunch',
      latitude: '-8.750000',
      longitude: '115.472000',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: 1,
      maxPartySize: 12,
      intensity: ActivityIntensity.ACTIVE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['island-hopping', 'boat-trip', 'viewpoint', 'beach', 'photography'],
      openingHours: daily(at(6, 30), at(18)),
    },
    {
      slug: 'bali-ubud-cooking-class',
      name: 'Balinese Cooking Class with Ubud Market Tour',
      summary:
        'Dawn market walk, then five hours making base gede spice paste and a full Balinese lunch in a village compound.',
      description:
        "Begins at 06:00 in Ubud's morning market, which is a genuine produce market at that hour and a souvenir market by nine. The class is held in a family compound outside town and centres on base gede, the foundational spice paste — shallots, garlic, galangal, kencur, turmeric, candlenut, chilli — pounded by hand in a stone mortar, because a blender gives you the ingredients without the texture. From it you build sate lilit, lawar, urab, tum ayam and black rice pudding. Vegetarian and halal-friendly versions on request. You eat the lot at a long table with the family.",
      category: ActivityCategory.FOOD,
      durationMinutes: 300,
      pricePerPersonBdt: 4600,
      priceNote: 'Market tour, ingredients, recipe folder, lunch and Ubud-area transfer',
      latitude: '-8.506900',
      longitude: '115.262500',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: 1,
      maxPartySize: 14,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['cooking-class', 'local-market', 'family-friendly'],
      openingHours: openOn(MONDAY_TO_SATURDAY, at(6), at(14)),
    },
    {
      slug: 'bali-ayung-river-rafting',
      name: 'Ayung River White-Water Rafting',
      summary:
        'Twelve kilometres of Class II–III water through the Ayung gorge north of Ubud, past carved cliff reliefs.',
      description:
        "The Ayung is Bali's beginner-friendly whitewater: about two hours on the water, Class II with a few III sections, and long calm stretches between rapids where the gorge walls carry Ramayana reliefs carved by rafting-company crews. Helmet, life jacket and a guide per raft are standard. The catch is at either end — a few hundred steps down to the put-in and up from the take-out, which is the part that actually tires people. Waterproof your phone or leave it in the locker. Levels rise sharply after heavy rain and trips are pulled when they do.",
      category: ActivityCategory.WATER_SPORTS,
      durationMinutes: 300,
      pricePerPersonBdt: 5200,
      priceNote: 'Guide, safety gear, buffet lunch and hotel transfer',
      latitude: '-8.448300',
      longitude: '115.261700',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: 2,
      maxPartySize: 20,
      intensity: ActivityIntensity.ACTIVE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['rafting', 'adventure-sports', 'rivers', 'nature'],
      openingHours: daily(at(8), at(15)),
    },
    {
      slug: 'bali-ubud-spa-flower-bath',
      name: 'Balinese Massage & Flower Bath, Ubud',
      summary:
        'Two and a half hours: full-body Balinese massage, a lulur or boreh body scrub, and a flower bath over the rice fields.',
      description:
        'Balinese massage uses long strokes, palm pressure and acupressure points with warm coconut or frangipani oil — firmer than Swedish, gentler than Thai. The standard Ubud package adds a lulur scrub of turmeric, rice powder and sandalwood or a warming boreh, a yoghurt rinse, and finishes in a stone tub scattered with frangipani and hibiscus, usually with the rice terraces in view. Book the late-afternoon slot and stay for the light. State your pressure preference at the start rather than enduring it politely.',
      category: ActivityCategory.WELLNESS,
      durationMinutes: 150,
      pricePerPersonBdt: 2800,
      priceNote: 'Massage, body scrub, flower bath and herbal tea',
      latitude: '-8.506000',
      longitude: '115.262000',
      bestTimeOfDay: TimeOfDay.AFTERNOON,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['spa', 'wellness'],
      openingHours: daily(at(9), at(21)),
    },
    {
      slug: 'bali-seminyak-beach-club-sunset',
      name: 'Seminyak Beach Club Sunset Session',
      summary:
        'Daybed on the sand at Seminyak for the sunset session — the Bali evening that asks nothing of you.',
      description:
        "Seminyak's beach clubs run west-facing terraces straight onto the sand, and the 16:00–19:00 session is the one people come for: a daybed or a lounger, a DJ that stays background until dusk, and the sun going down over the Indian Ocean. Entry is normally a minimum spend redeemable against food and drinks rather than a ticket. Reserve a bed for sunset in high season or you will be standing. Alcohol is central to the format, which makes this a poor fit for briefs that ask for none — the Uluwatu Kecak evening is the better recommendation there.",
      category: ActivityCategory.NIGHTLIFE,
      durationMinutes: 240,
      pricePerPersonBdt: 3200,
      priceNote: 'Typical minimum spend per person, redeemable against food and drinks',
      latitude: '-8.684200',
      longitude: '115.156000',
      bestTimeOfDay: TimeOfDay.EVENING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['sunset', 'beach', 'nightlife', 'live-music'],
      openingHours: daily(at(11), at(23)),
    },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Nepal — Pokhara
// ─────────────────────────────────────────────────────────────────────────────

const POKHARA: DestinationSeed = {
  slug: 'pokhara-nepal',
  name: 'Pokhara',
  country: 'Nepal',
  region: 'Gandaki Province',
  summary:
    'Lakeside town under the Annapurnas, and the shortest route from Dhaka to a proper mountain horizon — Machhapuchhre stands 6,000 metres above a valley floor at 800.',
  timezone: 'Asia/Kathmandu',
  latitude: '28.209583',
  longitude: '83.985567',
  sortOrder: 4,
  activities: [
    {
      slug: 'pokhara-sarangkot-sunrise',
      name: 'Sarangkot Sunrise over the Annapurnas',
      summary:
        'Pre-dawn drive to the 1,600-metre ridge for first light on Dhaulagiri, Annapurna and Machhapuchhre.',
      description:
        'Sarangkot is the ridge directly north-west of Pokhara and the standard sunrise viewpoint: the peaks catch the sun several minutes before the valley does, and the whole Annapurna wall turns grey to orange to white while Phewa Lake is still dark below. Pickup is 60–90 minutes before sunrise depending on season. It is cold on the ridge before dawn even in summer, whatever the daytime forecast says. October and November give the clearest air; the monsoon months are often a wall of cloud, and no operator can promise otherwise.',
      category: ActivityCategory.SIGHTSEEING,
      durationMinutes: 210,
      pricePerPersonBdt: 1100,
      priceNote: 'Shared jeep transfer and viewpoint entry',
      latitude: '28.244400',
      longitude: '83.949400',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['sunrise', 'viewpoint', 'mountains', 'photography'],
      openingHours: daily(at(4, 30), at(10)),
    },
    {
      slug: 'pokhara-sarangkot-paragliding',
      name: 'Tandem Paragliding from Sarangkot',
      summary:
        'Thirty minutes airborne over Phewa Lake with the Annapurnas on the horizon, launching from the Sarangkot ridge.',
      description:
        "Pokhara is one of the world's better tandem paragliding sites for a simple reason: a 1,000-metre launch ridge sits directly above a lake, thermals are reliable through the middle of the day, and the landing zone is a flat field by the water. You are clipped to a licensed pilot; the launch is a few running steps off the slope and after that you sit. Standard flights run 25–35 minutes, often sharing thermals with Himalayan griffon vultures. Flying starts mid-morning once thermals build and stops when the wind turns; a cancelled flight is a refunded flight. Pilot weight limits apply.",
      category: ActivityCategory.ADVENTURE,
      durationMinutes: 120,
      pricePerPersonBdt: 11500,
      priceNote: 'Tandem flight with licensed pilot, transfers and GoPro footage',
      latitude: '28.244000',
      longitude: '83.949000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: 1,
      maxPartySize: 6,
      intensity: ActivityIntensity.ACTIVE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['paragliding', 'adventure-sports', 'mountains', 'viewpoint'],
      openingHours: daily(at(9), at(15)),
    },
    {
      slug: 'pokhara-phewa-lake-tal-barahi',
      name: 'Phewa Lake Rowboat to Tal Barahi Temple',
      summary:
        'Hand-rowed doonga across Phewa Lake to the two-tiered pagoda on the island shrine, with the Annapurnas reflected on a still morning.',
      description:
        'Brightly painted wooden doongas are hired by the hour along the Lakeside shore, either rowed for you or rowed yourself. The island shrine of Tal Barahi sits a few hundred metres out and is the most important temple in the valley — busy on Saturdays with families making offerings. On a still morning the whole Annapurna range and Machhapuchhre reflect in the water, which is the shot everyone comes for and only works before the wind picks up around ten. Life jackets are provided; insist on them.',
      category: ActivityCategory.WATER_SPORTS,
      durationMinutes: 90,
      pricePerPersonBdt: 700,
      priceNote: 'Per boat for up to four people, rower included; temple entry free',
      latitude: '28.209600',
      longitude: '83.956000',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: null,
      maxPartySize: 4,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['boat-trip', 'temples', 'lakes', 'family-friendly', 'photography'],
      openingHours: daily(at(6), at(18)),
    },
    {
      slug: 'pokhara-world-peace-pagoda-hike',
      name: 'World Peace Pagoda Hike',
      summary:
        'Boat across Phewa Lake, then a forested 45-minute climb to the white stupa on the southern ridge and the best view back over the town.',
      description:
        "Cross the lake by doonga to the southern shore, then climb a stepped forest trail to the Shanti Stupa on Anadu hill — one of a series of peace pagodas built by the Japanese Nipponzan-Myōhōji order. The terrace looks north over Phewa Lake and the town to the full Annapurna wall. Walk back down the road towards Devi's Fall if you would rather not repeat the trail. Steep in places and slick in monsoon, but no scrambling. Free to enter; shoes come off on the stupa terrace.",
      category: ActivityCategory.NATURE,
      durationMinutes: 240,
      pricePerPersonBdt: null,
      priceNote: 'Free entry; the lake crossing is about BDT 450 per boat',
      latitude: '28.196000',
      longitude: '83.945000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.ACTIVE,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['hiking', 'viewpoint', 'temples', 'mountains', 'lakes'],
      openingHours: daily(at(5), at(19)),
    },
    {
      slug: 'pokhara-davis-falls-gupteshwor-cave',
      name: 'Davis Falls & Gupteshwor Mahadev Cave',
      summary:
        'The Pardi Khola disappearing into a sinkhole, and the limestone cave across the road where the same water reappears underground.',
      description:
        'Davis Falls — Patale Chhango, "the underworld waterfall" — is where the stream draining Phewa Lake drops into a sinkhole and vanishes. Directly across the road a stairway descends into Gupteshwor Mahadev cave to a Shiva shrine, and continues down a slippery passage to a viewing point where the fall thunders out of the rock face underground. The cave stairs are wet, steep and low-ceilinged; the shrine chamber is a place of worship and photography is restricted past a marked point. Both are compact and normally visited together. Loudest during and just after the monsoon.',
      category: ActivityCategory.SIGHTSEEING,
      durationMinutes: 120,
      pricePerPersonBdt: 400,
      priceNote: 'Combined entry to both sites',
      latitude: '28.189900',
      longitude: '83.959900',
      bestTimeOfDay: TimeOfDay.ANY,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['waterfall', 'caves', 'family-friendly'],
      openingHours: daily(at(6), at(18)),
    },
    {
      slug: 'pokhara-international-mountain-museum',
      name: 'International Mountain Museum',
      summary:
        'The museum of Himalayan mountaineering and mountain peoples — expedition kit, summit histories and the ethnography of the ranges.',
      description:
        'Built by the Nepal Mountaineering Association below the airport, and the one indoor option in Pokhara worth a wet afternoon. Three halls: the mountains themselves, the people who live in them (Sherpa, Thakali, Gurung and Tharu material culture), and the climbing history — original equipment from the 8,000-metre first ascents, Tenzing and Hillary material, and a sobering wall of expeditions that did not come back. A model of Manaslu stands in the grounds, alongside a climbing wall. Allow two hours; captions are in English throughout.',
      category: ActivityCategory.CULTURE,
      durationMinutes: 150,
      pricePerPersonBdt: 900,
      priceNote: 'Foreign visitor entry; SAARC nationals pay a reduced rate',
      latitude: '28.190700',
      longitude: '83.981900',
      bestTimeOfDay: TimeOfDay.ANY,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['museums', 'mountains', 'cultural-heritage', 'family-friendly'],
      openingHours: daily(at(9), at(17)),
    },
    {
      slug: 'pokhara-australian-camp-day-hike',
      name: 'Kande to Australian Camp Day Hike',
      summary:
        'A day on the Annapurna foothill trails — stone staircases through rhododendron forest to a 2,060-metre meadow facing Machhapuchhre.',
      description:
        'The honest answer to "we want to trek but only have one day". Drive 45 minutes to Kande, then climb stone-stepped trail through forest and Gurung villages to the ridge meadow at Australian Camp, where Machhapuchhre, Hiunchuli and Annapurna South stand across the valley with nothing in between. Roughly two hours up, ninety minutes down via Dhampus, with tea houses at the top serving dal bhat. No permit is needed for this section as a day walk. It is a real climb — around 700 metres of ascent on uneven stone — so it belongs in an active brief, not a relaxed one.',
      category: ActivityCategory.ADVENTURE,
      durationMinutes: 420,
      pricePerPersonBdt: 3200,
      priceNote: 'Licensed guide, return private transfer and tea-house lunch',
      latitude: '28.278900',
      longitude: '83.849700',
      bestTimeOfDay: TimeOfDay.EARLY_MORNING,
      minPartySize: 1,
      maxPartySize: 10,
      intensity: ActivityIntensity.ACTIVE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['hiking', 'mountains', 'viewpoint', 'nature'],
      openingHours: daily(at(5, 30), at(17)),
    },
    {
      slug: 'pokhara-begnas-lake-cycling',
      name: 'Begnas Lake Cycling Loop',
      summary:
        'Ride out to Begnas and Rupa, the quiet lakes east of Pokhara, through terraced farmland and fishing villages.',
      description:
        "Begnas is the second-largest lake in the valley and sees a fraction of Phewa's traffic. The ride out is about 15 kilometres on tarmac with one sustained climb, then a dirt ridge track between Begnas and Rupa lakes with terraced fields dropping away on both sides and the Annapurnas behind. Fish farms along the shore fry the day's catch with rice. Hardtail mountain bikes and helmets are supplied; the ridge section is unpaved and rutted, and the highway stretch out of town deserves respect. Half a day at an easy pace.",
      category: ActivityCategory.ADVENTURE,
      durationMinutes: 300,
      pricePerPersonBdt: 2100,
      priceNote: 'Bike hire, helmet and guide; lunch extra',
      latitude: '28.172000',
      longitude: '84.090000',
      bestTimeOfDay: TimeOfDay.MORNING,
      minPartySize: 1,
      maxPartySize: 8,
      intensity: ActivityIntensity.ACTIVE,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['cycling', 'lakes', 'nature', 'scenic-drive'],
      openingHours: daily(at(6), at(18)),
    },
    {
      slug: 'pokhara-lakeside-food-walk',
      name: 'Lakeside (Baidam) Evening Food Walk',
      summary:
        'Guided eating walk through Lakeside: buff momo, a Newari khaja set, sekuwa off the coals and a glass of tongba.',
      description:
        'Starts at dusk on the Baidam strip and works away from the tourist frontage into the lanes where Pokhara actually eats. Buffalo momo steamed then fried in chilli sauce, with kothey and jhol variants; a Newari khaja set of beaten rice with bara, choila and achar; sekuwa grilled over coals; and a millet tongba drunk hot through a bamboo straw for anyone who drinks. Vegetarian throughout on request, and buff is skipped for briefs that need it. Two and a half hours, five or six stops, and you will not need dinner afterwards.',
      category: ActivityCategory.FOOD,
      durationMinutes: 150,
      pricePerPersonBdt: 1500,
      priceNote: 'All tastings and one drink included',
      latitude: '28.213000',
      longitude: '83.958000',
      bestTimeOfDay: TimeOfDay.EVENING,
      minPartySize: 2,
      maxPartySize: 10,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: true,
      sourceUrl: null,
      tags: ['street-food', 'local-market', 'walking-tour'],
      openingHours: daily(at(17), at(22)),
    },
    {
      slug: 'pokhara-seti-gorge-mahendra-cave',
      name: 'Seti River Gorge & Mahendra Cave',
      summary:
        'The Seti running invisibly through a slot canyon a few metres wide beneath the town, and the limestone cave at Batulechaur.',
      description:
        'The Seti Gandaki cuts a gorge through Pokhara so narrow that in places it is bridged without anyone noticing there is a river below — the K.I. Singh bridge and the Gorkha Memorial viewpoint both look into a slot barely a few metres across with white water forty metres down. Combine it with Mahendra Gufa at Batulechaur on the northern edge of town, a limestone cave with stalactites and a Shiva shrine, lit but wet and low in sections. Both are short stops that make a compact half-morning, and they pair naturally on the way back from Sarangkot.',
      category: ActivityCategory.NATURE,
      durationMinutes: 120,
      pricePerPersonBdt: 500,
      priceNote: 'Cave entry; the gorge viewpoints are free',
      latitude: '28.260000',
      longitude: '83.980000',
      bestTimeOfDay: TimeOfDay.ANY,
      minPartySize: null,
      maxPartySize: null,
      intensity: ActivityIntensity.RELAXED,
      bookingRequired: false,
      sourceUrl: null,
      tags: ['caves', 'rivers', 'nature', 'family-friendly'],
      openingHours: daily(at(7), at(18)),
    },
  ],
}

export const DESTINATIONS: DestinationSeed[] = [COXS_BAZAR, PHUKET, BALI, POKHARA]
