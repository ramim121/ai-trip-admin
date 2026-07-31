import { PLANNER_PROMPT_VERSION } from './planner'
import { TEASER_PROMPT_VERSION } from './teaser'

export {
  MAX_BRIEFED_DESTINATION_LENGTH,
  PLANNER_PROMPT_VERSION,
  plannerBriefingV1,
  plannerSystemPrompt,
  plannerSystemPromptV1,
  plannerSystemPromptV2,
  type EntitlementContext,
  type PlannerPrompt,
  type PlannerPromptContext,
} from './planner'

export {
  TEASER_PROMPT_VERSION,
  teaserSystemPrompt,
  teaserSystemPromptV1,
  type TeaserPromptContext,
} from './teaser'

/**
 * The prompt version each surface is currently on.
 *
 * Stamped onto PlannerMessage rows so a conversation stays explicable months
 * later: "why did it answer that" cannot be answered without knowing which
 * prompt was in force when it did.
 */
export const PROMPT_VERSIONS = {
  planner: PLANNER_PROMPT_VERSION,
  teaser: TEASER_PROMPT_VERSION,
} as const

export type PromptSurface = keyof typeof PROMPT_VERSIONS
