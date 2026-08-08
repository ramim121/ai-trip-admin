import type { NextRequest } from 'next/server'
import { ItemSource } from '@/generated/prisma/enums'
import { badRequest } from '@/server/http/errors'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { AddItemBody } from '@/server/modules/journey/schema'
import { addItem } from '@/server/modules/journey/service'
import { suggestionDetail } from '@/server/modules/journey/suggestions'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * POST /api/v1/journeys/{id}/items — put something on a day.
 *
 * NO PRICE IS ACCEPTED FROM THE CLIENT. When the item names a Viator product the
 * estimate, the image, the rating and the deep link are read from the provider
 * here and snapshotted — so a browser cannot decide what something costs, and a
 * quotation is priced against what the traveller was actually looking at.
 *
 * Snapshotting rather than re-fetching later is the same decision the schema
 * explains: a tour that changes price next week must not silently change what
 * somebody asked for.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/items'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    const body = await parseJson(req, AddItemBody)

    // The database enforces this too. Checking here turns a constraint violation
    // into a sentence, which is the difference between a bug report and a
    // correction.
    if (body.source === ItemSource.CURATED && !body.activityId) {
      throw badRequest('A curated item must name a catalogue activity.')
    }
    if (
      (body.source === ItemSource.VIATOR || body.source === ItemSource.GOOGLE_PLACES) &&
      !body.externalId
    ) {
      throw badRequest('An imported item must name its provider id.')
    }

    let estPriceMinBdt: number | null = null
    let estPriceMaxBdt: number | null = null
    let estPricePer: string | null = null
    let snapshot: unknown = null
    let durationMin = body.durationMin ?? null

    if (body.source === ItemSource.VIATOR && body.externalId) {
      const product = await suggestionDetail(body.externalId)

      if (product !== null) {
        estPriceMinBdt = product.fromPriceBdt
        // Viator quotes a "from" price, so the top of the band is genuinely
        // unknown. Claiming a maximum nobody gave us would be precision that
        // misleads.
        estPriceMaxBdt = null
        estPricePer = 'person'
        durationMin = durationMin ?? product.durationMinMinutes
        snapshot = {
          imageUrl: product.imageUrl,
          rating: product.rating,
          reviewCount: product.reviewCount,
          url: product.productUrl,
          pickupType: product.pickupType,
          durationMinMinutes: product.durationMinMinutes,
          durationMaxMinutes: product.durationMaxMinutes,
        }
      }
    }

    const journey = await addItem(id, claims.userId, {
      dayNumber: body.dayNumber,
      slot: body.slot,
      type: body.type,
      title: body.title,
      description: body.description ?? null,
      source: body.source,
      externalId: body.externalId ?? null,
      activityId: body.activityId ?? null,
      startMinute: body.startMinute ?? null,
      durationMin,
      estPriceMinBdt,
      estPriceMaxBdt,
      estPricePer,
      locationName: body.locationName ?? null,
      briefId: body.briefId ?? null,
      snapshot,
    })

    return json(assembleJourneyView(journey), 201)
  }
)
