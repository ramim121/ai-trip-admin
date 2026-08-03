'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { recordAudit } from '@/server/audit/log'
import { ActivityFormSchema, createActivity } from '@/server/modules/catalog/admin'
import {
  linkApproval,
  readCandidate,
  rejectCandidate,
  reopenCandidate,
  searchAndStage,
} from '@/server/modules/places/service'
import { PlacesError } from '@/server/places/client'
import { CATALOG_WRITE_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'

/**
 * Importing places, and deciding which become catalogue.
 *
 * CATALOG_WRITE_ROLES — the same list guarding every other write to what we
 * sell. Approving a place IS creating an activity: it goes through
 * `createActivity`, produces a real catalogue row, and decides what the planner
 * may recommend. A separate, looser gate here would be a second door into the
 * same room.
 *
 * A server action is an HTTP endpoint with a generated URL, so each check below
 * is the only thing controlling what is written; the pages' checks control only
 * what is displayed.
 */

const SearchForm = z.object({
  destinationId: z.uuid('Choose a destination.'),
  query: z.string().trim().min(3, 'Search for something a little more specific.').max(200),
})

const RejectForm = z.object({
  candidateId: z.uuid(),
  reason: z.string().trim().min(1, 'Say why, so the next person does not have to guess.').max(500),
})

const CandidateForm = z.object({ candidateId: z.uuid() })

function backTo(target: string, message: string): never {
  redirect(`${target}?error=${encodeURIComponent(message)}`)
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'That form could not be read.'
  const field = issue.path.join('.')
  return field === '' ? issue.message : `${field}: ${issue.message}`
}

/** What a thrown error says, without handing a stack to the page. */
function describe(error: unknown): string {
  if (error instanceof PlacesError) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return 'That did not work. Try again.'
}

/** The request context `createActivity` records alongside its audit entry. */
async function auditContext(adminUserId: string) {
  const headerList = await headers()
  return {
    adminUserId,
    ip: headerList.get('x-forwarded-for'),
    userAgent: headerList.get('user-agent'),
  }
}

/**
 * Search Google and queue anything new.
 *
 * NOTHING HERE IS PUBLISHED. The result is rows in `place_candidates`, a table
 * the planner cannot read. The skipped count travels back in the message because
 * "0 imported" and "20 imported" are both normal outcomes, and the first usually
 * means the search has been run before rather than that anything failed.
 */
export async function importPlaces(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  // Silently doing nothing would look like a successful import. Throwing lands
  // on the console's error boundary, which is the honest outcome for a post no
  // holder of this session should have been able to make.
  if (admin === null) throw new Error('Not permitted.')

  const parsed = SearchForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo('/places', firstIssue(parsed.error))

  let summary: string

  try {
    const result = await searchAndStage(parsed.data.destinationId, parsed.data.query)

    if (result.found === 0) {
      summary = 'Google found nothing for that. Try different wording.'
    } else if (result.imported === 0) {
      summary = `All ${result.found} results were already queued or already decided.`
    } else {
      const tail = result.skipped > 0 ? ` ${result.skipped} were already known.` : ''
      summary = `${result.imported} new ${
        result.imported === 1 ? 'place' : 'places'
      } queued for review.${tail}`
    }
  } catch (error) {
    backTo('/places', describe(error))
  }

  await recordAudit({
    action: 'places.imported',
    entityType: 'destination',
    entityId: parsed.data.destinationId,
    adminUserId: admin.adminUserId,
    // The query rather than the results: what somebody searched for is the
    // useful record, and the rows themselves are already a table.
    after: { query: parsed.data.query },
  })

  revalidatePath('/places')
  redirect(`/places?done=${encodeURIComponent(summary)}`)
}

/**
 * Turn a reviewed place into a real activity.
 *
 * THE FORM IS AN ACTIVITY FORM, not a place form, and that is the whole point of
 * the screen: everything the planner needs — a summary, a description, a
 * duration, a price in taka, a category, a time of day — is typed by the
 * curator, because Google supplies none of it. The Place contributed a name, a
 * location, and a starting guess.
 *
 * `createActivity` does the writing, so slug collisions, tags, images, opening
 * hours and the activity audit entry all behave exactly as on the hand-authored
 * path. This action only links the candidate afterwards.
 */
export async function approveCandidate(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const target = CandidateForm.safeParse({ candidateId: formData.get('candidateId') })
  if (!target.success) backTo('/places', 'That place could not be identified.')

  const here = `/places/${target.data.candidateId}`

  const parsed = ActivityFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(here, firstIssue(parsed.error))

  /*
   * Checked BEFORE the activity is created, not after.
   *
   * Approving something already decided has to fail before anything is written,
   * or the catalogue gains an activity nobody asked for and the failure message
   * arrives too late to prevent it. `linkApproval` still re-checks under a
   * predicate — this read only narrows the window, it does not close it.
   */
  const candidate = await readCandidate(target.data.candidateId).catch(() => null)
  if (candidate === null) backTo('/places', 'That place could not be found.')
  if (candidate.status !== 'PENDING') {
    backTo(here, 'That place has already been decided. Reload to see what happened to it.')
  }

  const context = await auditContext(admin.adminUserId)
  let activityId: string

  try {
    activityId = await createActivity(parsed.data, context)
  } catch (error) {
    backTo(here, describe(error))
  }

  try {
    await linkApproval(target.data.candidateId, activityId, admin.adminUserId)
  } catch (error) {
    /*
     * The activity exists but the link failed, which means somebody decided this
     * candidate in the moment between. Saying so plainly beats a generic error:
     * the activity is real and in the catalogue now, and whoever reads this needs
     * to know that rather than assume nothing happened.
     */
    backTo(
      here,
      `${describe(error)} The activity was created — find it under Activities and remove it if it is a duplicate.`
    )
  }

  await recordAudit({
    action: 'place.approved',
    entityType: 'place_candidate',
    entityId: target.data.candidateId,
    adminUserId: admin.adminUserId,
    after: { googlePlaceId: candidate.googlePlaceId, activityId, slug: parsed.data.slug },
  })

  revalidatePath('/places')
  revalidatePath('/activities')
  redirect(`/places?done=${encodeURIComponent(`${parsed.data.name} added to the catalogue.`)}`)
}

/** Decide we will not sell this. The reason is required, and it is kept. */
export async function rejectPlace(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = RejectForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    const raw = formData.get('candidateId')
    const here = typeof raw === 'string' ? `/places/${encodeURIComponent(raw)}` : '/places'
    backTo(here, firstIssue(parsed.error))
  }

  try {
    await rejectCandidate(parsed.data.candidateId, admin.adminUserId, parsed.data.reason)
  } catch (error) {
    backTo(`/places/${parsed.data.candidateId}`, describe(error))
  }

  await recordAudit({
    action: 'place.rejected',
    entityType: 'place_candidate',
    entityId: parsed.data.candidateId,
    adminUserId: admin.adminUserId,
    after: { reason: parsed.data.reason },
  })

  revalidatePath('/places')
  redirect(
    `/places?done=${encodeURIComponent('Turned down. It will not come back on a re-search.')}`
  )
}

/** Put a rejected place back in the queue — judgements age. */
export async function reopenPlace(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = CandidateForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo('/places', 'That place could not be identified.')

  try {
    await reopenCandidate(parsed.data.candidateId)
  } catch (error) {
    backTo('/places?status=REJECTED', describe(error))
  }

  await recordAudit({
    action: 'place.reopened',
    entityType: 'place_candidate',
    entityId: parsed.data.candidateId,
    adminUserId: admin.adminUserId,
  })

  revalidatePath('/places')
  redirect(`/places?done=${encodeURIComponent('Back in the queue for another look.')}`)
}
