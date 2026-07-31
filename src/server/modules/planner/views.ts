import type { PlannerSession as PlannerSessionView } from './schema'
import type { PlannerSessionRecord, StoredMessage } from './session'

/**
 * Database records to wire shapes.
 *
 * Separated from both sides so the mapping exists exactly once. Two routes
 * return a session — creating one and reading one — and a second copy of this
 * function is how the create response quietly stops matching the read response.
 *
 * Note what is dropped: `userId` and `anonymousVisitorId` never leave the
 * process. A caller already knows who they are, and echoing an owner id back
 * turns every response into a small confirmation oracle.
 */
export function toPlannerSessionView(
  session: PlannerSessionRecord,
  resumed: boolean,
  messages: readonly StoredMessage[]
): PlannerSessionView {
  return {
    id: session.id,
    status: session.status,
    tripBrief: session.tripBrief,
    createdAt: session.createdAt.toISOString(),
    lastMessageAt: session.lastMessageAt.toISOString(),
    resumed,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      model: message.model,
      promptTokens: message.promptTokens,
      completionTokens: message.completionTokens,
      createdAt: message.createdAt.toISOString(),
    })),
  }
}
