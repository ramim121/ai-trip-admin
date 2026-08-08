import type { z } from 'zod'
import { BriefPillar, ItemSource } from '@/generated/prisma/enums'
import { placesConfigured, searchPlaces } from '@/server/places/client'
import {
  getProduct,
  resolveDestination,
  searchFreetext,
  searchProducts,
  viatorConfigured,
  type ViatorProduct,
} from '@/server/viator/client'
import { elicitPackagePreference, rankCandidates, type RankCandidate } from './ai'
import type { SuggestionView } from './schema'

/**
 * Six real options, ranked against what the traveller actually asked for.
 *
 * THE PILLAR DECIDES THE PROVIDER, because the providers are good at different
 * things. Viator knows what a tour costs, how long it runs and whether a van
 * collects you from your hotel — the facts deciding whether something fits a
 * Tuesday. Google Places knows a hotel exists, where it is and what people think
 * of it, and knows nothing about nightly rates. Asking either for the other's
 * speciality produces confident noise.
 *
 * SIX, NEVER MORE. A marketplace wants 779 results because browsing is its
 * product; a plan wants a shortlist, because choice overload is what stops an
 * itinerary getting finished.
 *
 * NOTHING HERE INVENTS ANYTHING. Candidates come from a provider, the ranker may
 * only choose among them, and every fact on a card is one the provider stated.
 * The model contributes judgement about fit and one line saying why — the part
 * it is actually good at.
 */

export interface SuggestionBatch {
  suggestions: z.infer<typeof SuggestionView>[]
  constraintWorthRelaxing: string | null
  /** Set when the pillar's provider is not configured on this server. */
  unavailable: string | null
}

const EMPTY: SuggestionBatch = { suggestions: [], constraintWorthRelaxing: null, unavailable: null }

/**
 * A hotel's nightly band, inferred from Google's price level.
 *
 * GOOGLE DOES NOT RETURN NIGHTLY RATES, so this is genuinely an estimate and is
 * badged as one everywhere it appears. The bands are deliberately wide: a narrow
 * fake number reads as a quote, and the admin replaces all of it regardless.
 * Null where there is nothing to reason from, because no number beats a
 * fabricated one.
 */
function estimateNightlyBdt(priceLevel: string | null): { min: number; max: number } | null {
  switch (priceLevel) {
    case 'PRICE_LEVEL_INEXPENSIVE':
      return { min: 2500, max: 5000 }
    case 'PRICE_LEVEL_MODERATE':
      return { min: 5000, max: 10000 }
    case 'PRICE_LEVEL_EXPENSIVE':
      return { min: 10000, max: 20000 }
    case 'PRICE_LEVEL_VERY_EXPENSIVE':
      return { min: 20000, max: 45000 }
    default:
      return null
  }
}

function viatorToCandidate(product: ViatorProduct): RankCandidate {
  const duration =
    product.durationMinMinutes === null
      ? 'duration not stated'
      : product.durationMinMinutes === product.durationMaxMinutes
        ? `${product.durationMinMinutes} minutes`
        : `${product.durationMinMinutes}–${product.durationMaxMinutes} minutes`

  return {
    id: product.productCode,
    title: product.title,
    // Only what the provider actually said. A ranker allowed to embellish would
    // attribute a pool to a hotel that has none — the same failure as inventing
    // the hotel, arriving one step later and harder to spot.
    facts: [
      duration,
      product.fromPriceBdt === null ? 'price unknown' : `from BDT ${product.fromPriceBdt} pp`,
      product.rating === null
        ? 'not rated'
        : `rated ${product.rating.toFixed(1)} by ${product.reviewCount ?? 0}`,
      ...product.flags,
    ].join(', '),
  }
}

/**
 * Tours and activities, from Viator.
 *
 * The brief's own words are searched as free text when there are any, because a
 * traveller who said "island hopping with lunch" has narrowed the field better
 * than a destination id can. A free-text search that finds nothing falls back to
 * the destination's catalogue, so an over-specific brief degrades to "here is
 * what exists here" rather than to an empty panel.
 */
async function activitySuggestions(
  location: string,
  briefSummary: string,
  briefConstraints: unknown,
  userId: string | null
): Promise<SuggestionBatch> {
  if (!viatorConfigured()) {
    return { ...EMPTY, unavailable: 'Tours are not configured on this server.' }
  }

  const destination = await resolveDestination(location)

  const found =
    briefSummary.trim() === ''
      ? destination === null
        ? { products: [] as ViatorProduct[] }
        : await searchProducts({ destinationId: destination.destinationId, count: 14 })
      : await searchFreetext(`${briefSummary} ${location}`.trim(), 14)

  const products =
    found.products.length > 0 || destination === null
      ? found.products
      : (await searchProducts({ destinationId: destination.destinationId, count: 14 })).products

  if (products.length === 0) return EMPTY

  const ranked = await rankCandidates(
    { briefSummary, briefConstraints, candidates: products.map(viatorToCandidate) },
    userId === null ? {} : { userId }
  )

  const byCode = new Map(products.map((p) => [p.productCode, p]))

  const suggestions = ranked.choices.flatMap((choice) => {
    const product = byCode.get(choice.id)

    // A ranked id absent from the candidate list would be an invention. Dropped
    // rather than rendered — the prompt forbids it, and this is the second line
    // in case a future model finds a way around the first.
    if (product === undefined) return []

    return [
      {
        externalId: product.productCode,
        source: ItemSource.VIATOR,
        title: product.title,
        description: product.description,
        imageUrl: product.imageUrl,
        rating: product.rating,
        reviewCount: product.reviewCount,
        durationMinMinutes: product.durationMinMinutes,
        durationMaxMinutes: product.durationMaxMinutes,
        estimate: {
          minBdt: product.fromPriceBdt,
          // Viator quotes a "from" price, so the top of the band is unknown
          // rather than equal to it. Claiming a maximum nobody gave us would be
          // the kind of precision that misleads.
          maxBdt: null,
          per: 'person',
        },
        matchReason: choice.matchReason,
        echoedPhrases: choice.echoedPhrases,
        externalUrl: product.productUrl,
        locationName: location,
      },
    ]
  })

  return { suggestions, constraintWorthRelaxing: ranked.constraintWorthRelaxing, unavailable: null }
}

/**
 * Hotels and restaurants, from Google Places.
 *
 * PRICES ARE ESTIMATED FROM A BAND, NEVER QUOTED. Places returns a price level
 * rather than a rate, so the nightly figure on a hotel card is our own inference
 * and is badged an estimate wherever it appears. The admin supplies the real
 * number in the quotation, which is the arrangement this whole product rests on.
 */
async function placeSuggestions(
  pillar: BriefPillar,
  location: string,
  briefSummary: string,
  briefConstraints: unknown,
  userId: string | null
): Promise<SuggestionBatch> {
  if (!placesConfigured()) {
    return { ...EMPTY, unavailable: 'Places are not configured on this server.' }
  }

  const what = pillar === BriefPillar.STAY ? 'hotels' : 'restaurants'
  const places = await searchPlaces({ query: `${briefSummary} ${what} in ${location}`.trim() })

  if (places.length === 0) return EMPTY

  const candidates: RankCandidate[] = places.map((place) => {
    const nightly = estimateNightlyBdt(place.priceLevel)

    return {
      id: place.googlePlaceId,
      title: place.name,
      facts: [
        place.formattedAddress ?? 'address unknown',
        place.rating === null
          ? 'not rated'
          : `rated ${place.rating.toFixed(1)} by ${place.userRatingCount ?? 0}`,
        nightly === null
          ? 'price band unknown'
          : `roughly BDT ${nightly.min}–${nightly.max} a night (estimated)`,
        ...place.types
          .filter((t) => t !== 'point_of_interest' && t !== 'establishment')
          .slice(0, 4),
      ].join(', '),
    }
  })

  const ranked = await rankCandidates(
    { briefSummary, briefConstraints, candidates },
    userId === null ? {} : { userId }
  )

  const byId = new Map(places.map((p) => [p.googlePlaceId, p]))

  const suggestions = ranked.choices.flatMap((choice) => {
    const place = byId.get(choice.id)
    if (place === undefined) return []

    const nightly = estimateNightlyBdt(place.priceLevel)

    return [
      {
        externalId: place.googlePlaceId,
        source: ItemSource.GOOGLE_PLACES,
        title: place.name,
        description: place.formattedAddress,
        imageUrl: null,
        rating: place.rating,
        reviewCount: place.userRatingCount,
        durationMinMinutes: null,
        durationMaxMinutes: null,
        estimate: {
          minBdt: nightly?.min ?? null,
          maxBdt: nightly?.max ?? null,
          per: pillar === BriefPillar.STAY ? 'night' : 'person',
        },
        matchReason: choice.matchReason,
        echoedPhrases: choice.echoedPhrases,
        externalUrl: place.googleMapsUri,
        locationName: location,
      },
    ]
  })

  return { suggestions, constraintWorthRelaxing: ranked.constraintWorthRelaxing, unavailable: null }
}

/** Six ranked options for one pillar in one place. */
export async function suggestFor(
  pillar: BriefPillar,
  location: string,
  briefSummary: string,
  briefConstraints: unknown,
  userId: string | null
): Promise<SuggestionBatch> {
  const place = location.trim()
  if (place === '') return EMPTY

  if (pillar === BriefPillar.ACTIVITY) {
    return activitySuggestions(place, briefSummary, briefConstraints, userId)
  }

  if (pillar === BriefPillar.STAY || pillar === BriefPillar.FOOD) {
    return placeSuggestions(pillar, place, briefSummary, briefConstraints, userId)
  }

  // TRANSPORT is answered by the curated route table and the transfer estimator
  // rather than by a provider search. Returning nothing is correct rather than a
  // gap — the gap-card is where that question actually gets asked.
  return EMPTY
}

/**
 * Which format of a packaged tour somebody wants — spec §7.8.
 *
 * ASKS FROM REAL PRODUCTS OR NOT AT ALL. The elicitor is handed the actual
 * inventory and told to find the dimensions that vary across it; when they do
 * not vary it says so and the caller goes straight to the ranked list. A
 * question with one real answer teaches a traveller that the questions here are
 * decoration.
 */
export async function elicitFor(
  category: string,
  location: string,
  userId: string | null
): Promise<{
  question: {
    question: string
    chips: { label: string; dimension: string; value: string }[]
  } | null
  reason: string | null
}> {
  if (!viatorConfigured()) return { question: null, reason: 'Tours are not configured.' }

  const found = await searchFreetext(`${category} ${location}`.trim(), 10)

  if (found.products.length < 2) {
    return { question: null, reason: 'There are too few options here to be worth narrowing.' }
  }

  const lines = found.products.map((p) => {
    const duration =
      p.durationMinMinutes === null
        ? 'duration not stated'
        : p.durationMinMinutes === p.durationMaxMinutes
          ? `${p.durationMinMinutes} min`
          : `${p.durationMinMinutes}–${p.durationMaxMinutes} min`

    return `${p.title} | ${duration} | ${
      p.fromPriceBdt === null ? 'price unknown' : `from BDT ${p.fromPriceBdt}`
    } | ${p.rating?.toFixed(1) ?? '-'} stars`
  })

  const elicited = await elicitPackagePreference(
    { category, location, products: lines },
    userId === null ? {} : { userId }
  )

  return { question: elicited.question, reason: elicited.reason }
}

/**
 * Everything known about one Viator product, for an expanded card.
 *
 * Kept here rather than exposing the client directly, so a route never has to
 * know which provider an id belongs to.
 */
export async function suggestionDetail(externalId: string) {
  if (!viatorConfigured()) return null
  return getProduct(externalId)
}
