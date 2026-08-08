import { validate } from './conflicts'
import { toJourneyView, type JourneyProjectionInput, type JourneyView } from './schema'
import { findTransferGaps, summariseBudget, toConflictInputs } from './service'

/**
 * The one place a journey row becomes the shape every route returns.
 *
 * WHY THIS IS NOT INLINE IN EACH ROUTE. A journey's validation, its budget and
 * its transfer gaps are all derived from the same item list, and every endpoint
 * returning a journey must return all three — a route assembling only two would
 * ship a plan whose budget meter disagreed with its own items, and nothing would
 * catch it. Twelve routes computing this separately is twelve chances to forget
 * one.
 *
 * DERIVED RATHER THAN STORED, deliberately. A cached validation status is a
 * status that can be wrong, and recomputing from the items is cheap and cannot
 * drift. Same for the budget: a sum over rows already loaded, so storing it
 * would buy nothing and cost correctness.
 */
export function assembleJourneyView(row: JourneyProjectionInput): JourneyView {
  return toJourneyView(row, {
    validation: validate(toConflictInputs(row.items)),
    budget: summariseBudget(row, row.items),
    transferGaps: findTransferGaps(row.items),
  })
}
