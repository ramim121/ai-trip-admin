'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ApiError } from '@/server/http/errors'
import {
  ActivityFormSchema,
  createActivity,
  parseImagesText,
  parseOpeningHoursText,
  setActivityPublished,
  updateActivity,
} from '@/server/modules/catalog/admin'
import { CATALOG_WRITE_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'

/**
 * Writing to the catalog from the console.
 *
 * A server action is an HTTP endpoint with a generated URL, not a function
 * call — anyone who can reach the console can post to it, whether or not the
 * form that binds it ever rendered for them. The role check here is therefore
 * not a duplicate of the page's: the page's decides what is *displayed*, this
 * one is the only thing deciding what is *written*. Removing either leaves a
 * hole.
 *
 * The catalog is the AI's grounding set. Every row saved here becomes something
 * the planner may put in front of a traveller and something ops is then expected
 * to deliver, which is why the parsing below refuses rather than repairs. A price
 * with a decimal point, an image with no alt text, an opening window that closes
 * before it opens: each is rejected with a message, never quietly corrected into
 * something plausible.
 */

/** Where a failed save sends the editor back to, with their complaint attached. */
function backTo(activityId: string | null, message: string): never {
  const target = activityId === null ? '/activities/new' : `/activities/${activityId}`
  redirect(`${target}?error=${encodeURIComponent(message)}`)
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === 'string' ? value : ''
}

/**
 * Save one activity, creating it when `id` is absent.
 *
 * One action for both, because the validation, the child-row replacement and the
 * audit shape are identical, and two copies of that would drift on the first
 * field anybody added.
 */
export async function saveActivity(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  // Silently doing nothing would look like a successful save. Throwing lands on
  // the error boundary, which is the honest outcome for a post that no holder of
  // this session should have been able to make.
  if (admin === null) throw new Error('Not permitted.')

  const rawId = text(formData, 'id').trim()
  const activityId = rawId === '' ? null : rawId

  // The two textareas are parsed before the schema runs, because each turns one
  // field into many rows and their failures are line-numbered rather than
  // field-shaped. An editor gets "Line 3: …", not "openingHours: invalid".
  const hours = parseOpeningHoursText(text(formData, 'openingHoursText'))
  const images = parseImagesText(text(formData, 'imagesText'))

  const textErrors = [...hours.errors, ...images.errors]
  if (textErrors.length > 0) backTo(activityId, textErrors.join(' '))

  const parsed = ActivityFormSchema.safeParse({
    destinationId: text(formData, 'destinationId'),
    slug: text(formData, 'slug'),
    name: text(formData, 'name'),
    summary: text(formData, 'summary'),
    description: text(formData, 'description'),
    category: text(formData, 'category'),
    durationMinutes: text(formData, 'durationMinutes'),
    pricePerPersonBdt: text(formData, 'pricePerPersonBdt'),
    priceNote: text(formData, 'priceNote'),
    latitude: text(formData, 'latitude'),
    longitude: text(formData, 'longitude'),
    bestTimeOfDay: text(formData, 'bestTimeOfDay'),
    minPartySize: text(formData, 'minPartySize'),
    maxPartySize: text(formData, 'maxPartySize'),
    intensity: text(formData, 'intensity'),
    // An unchecked box is absent from the FormData entirely, and `undefined` is
    // what the schema's checkbox field expects for that case.
    bookingRequired: formData.get('bookingRequired') ?? undefined,
    isActive: formData.get('isActive') ?? undefined,
    sourceUrl: text(formData, 'sourceUrl'),
    sortOrder: text(formData, 'sortOrder'),
    // `getAll`, because a multi-select posts one entry per selection and reading
    // it with `get` would silently keep only the first tag.
    tagSlugs: formData.getAll('tagSlugs').filter((value) => typeof value === 'string'),
    images: images.images,
    openingHours: hours.windows,
  })

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue?.path.join('.') ?? ''
    const message = issue?.message ?? 'Invalid input.'
    backTo(activityId, field === '' ? message : `${field}: ${message}`)
  }

  const context = { adminUserId: admin.adminUserId }

  let savedId: string

  try {
    if (activityId === null) {
      savedId = await createActivity(parsed.data, context)
    } else {
      await updateActivity(activityId, parsed.data, context)
      savedId = activityId
    }
  } catch (e) {
    // A duplicate slug and an unknown tag are both things the editor can fix by
    // retyping, so they go back to the form as prose. Anything else is our fault
    // and belongs on the error boundary with its stack intact.
    if (e instanceof ApiError && e.status < 500) backTo(activityId, e.message)
    throw e
  }

  revalidatePath('/activities')
  revalidatePath(`/activities/${savedId}`)
  redirect(`/activities?saved=${encodeURIComponent(savedId)}`)
}

/**
 * Publish or retire one activity.
 *
 * Its own action, and its own button, rather than a checkbox on the edit form.
 * Unpublishing withdraws inventory from every search and every future plan; that
 * deserves one deliberate click with its own audit line, not a box somebody
 * toggles while fixing a typo in a summary.
 */
export async function setPublished(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(CATALOG_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const id = text(formData, 'id').trim()
  if (id === '') redirect('/activities?error=Missing+activity.')

  const isActive = text(formData, 'isActive') === 'true'

  try {
    await setActivityPublished(id, isActive, { adminUserId: admin.adminUserId })
  } catch (e) {
    if (e instanceof ApiError && e.status < 500) {
      redirect(`/activities?error=${encodeURIComponent(e.message)}`)
    }
    throw e
  }

  revalidatePath('/activities')
  revalidatePath(`/activities/${id}`)
  redirect(`/activities?saved=${encodeURIComponent(id)}`)
}
