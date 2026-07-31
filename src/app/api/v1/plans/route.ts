import { z } from 'zod'
import { db } from '@/lib/db'
import { json, route } from '@/server/http/handler'
import { toPlanSummary, type PlanListResponse } from '@/server/modules/entitlements/schema'
import { readCachedSetting } from '@/server/settings/read'

/**
 * GET /api/v1/plans — what we sell, in taka.
 *
 * Public and unauthenticated. Prices are the pricing page, and a pricing page
 * behind a login converts nobody.
 *
 * Only `isActive` rows are listed. A retired plan still has to exist —
 * subscriptions and payments reference it — but it must not be offered, and
 * filtering here rather than deleting the row is what makes retiring a plan a
 * reversible decision instead of an orphaned foreign key.
 *
 * The USD rate rides along instead of USD prices. Every stored amount is whole
 * BDT and USD is computed at render time from the admin-set rate, so a rate
 * change never rewrites a price that was already quoted. Sending the rate
 * rather than the converted figures is what keeps that true on the client too.
 */

/** Taka per 1 USD. Positive and finite, or it is not a rate. */
const BdtPerUsdSchema = z.number().positive().finite()

const BDT_PER_USD_SETTING_KEY = 'bdtPerUsd'

const PLAN_SELECT = {
  code: true,
  name: true,
  description: true,
  priceBdt: true,
  interval: true,
  maxItineraryDays: true,
  maxSavedItineraries: true,
  itinerariesPerPeriod: true,
  sortOrder: true,
} as const

export const GET = route(async () => {
  const [plans, bdtPerUsd] = await Promise.all([
    db.plan.findMany({
      where: { isActive: true },
      // `sortOrder` is the merchandising decision; price is the tiebreak, so
      // the list stays deterministic when somebody leaves two plans on 0.
      orderBy: [{ sortOrder: 'asc' }, { priceBdt: 'asc' }],
      select: PLAN_SELECT,
    }),
    readCachedSetting(BDT_PER_USD_SETTING_KEY, BdtPerUsdSchema),
  ])

  const body: PlanListResponse = {
    plans: plans.map(toPlanSummary),
    bdtPerUsd,
  }

  return json(body)
})
