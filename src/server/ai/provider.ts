import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle, type GoogleProvider } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { db } from '@/lib/db'
import { env } from '@/lib/env'

/**
 * Which model the planner talks to, and how we get hold of it.
 *
 * Two layers of configuration, deliberately:
 *
 *   env (AI_PROVIDER / AI_MODEL) — the floor. Always present, always valid,
 *     works with no database at all, which is what keeps `next build` and the
 *     test suite from needing Postgres.
 *   settings row `ai.model` — the override. Lets ops move off gemini-2.5-flash
 *     at 2am without a redeploy, and lets us fail back by deleting one row.
 *
 * The override is read through a short TTL cache. A per-request database
 * round-trip to learn a value that changes twice a year is a bad trade, and a
 * 30s stale window is a perfectly acceptable price for avoiding it.
 */

export const AI_PROVIDERS = ['google', 'openai', 'anthropic'] as const
export type AiProviderId = (typeof AI_PROVIDERS)[number]

/**
 * `LanguageModelV4`. Taken as the return type of a provider we depend on
 * directly rather than imported from `@ai-sdk/provider`, which is only ever a
 * transitive dependency here and could be hoisted elsewhere by a future install.
 */
export type ChatModel = ReturnType<GoogleProvider['languageModel']>

/** The settings key ops edits to change model without a deploy. */
export const AI_MODEL_SETTING_KEY = 'ai.model'

/** How long a resolved selection is trusted before the row is re-read. */
export const MODEL_SETTING_TTL_MS = 30_000

export type ModelSource = 'explicit' | 'setting' | 'env'

export interface ModelSelection {
  provider: AiProviderId
  modelId: string
  /** Where this came from — worth recording on every PlannerMessage. */
  source: ModelSource
}

/** A resolved selection plus the SDK handle to call with. */
export interface ActiveModel extends ModelSelection {
  model: ChatModel
}

/** What may be pinned per call, e.g. a cheap model for the anonymous teaser. */
export interface ModelOverride {
  provider?: AiProviderId
  modelId?: string
}

/**
 * Shape of the `ai.model` settings row.
 *
 * Unknown keys are stripped rather than rejected: a field added by a newer
 * deploy must not brick model resolution on an older instance still running
 * behind the load balancer.
 */
const ModelSettingSchema = z.object({
  provider: z.enum(AI_PROVIDERS).optional(),
  model: z.string().trim().min(1).max(120).optional(),
})

// ── The registry ────────────────────────────────────────────────────────────

/**
 * Each entry knows the env var carrying its credential, so a misconfiguration
 * is reported as "OPENAI_API_KEY is not set" rather than as a 401 from a vendor
 * three layers down.
 */
interface ProviderEntry {
  keyVar: 'GOOGLE_GENERATIVE_AI_API_KEY' | 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY'
  create: (apiKey: string) => (modelId: string) => ChatModel
}

const REGISTRY: Record<AiProviderId, ProviderEntry> = {
  google: {
    keyVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
    create: (apiKey) => {
      const provider = createGoogle({ apiKey })
      return (modelId) => provider.languageModel(modelId)
    },
  },
  openai: {
    keyVar: 'OPENAI_API_KEY',
    create: (apiKey) => {
      const provider = createOpenAI({ apiKey })
      return (modelId) => provider.languageModel(modelId)
    },
  },
  anthropic: {
    keyVar: 'ANTHROPIC_API_KEY',
    create: (apiKey) => {
      const provider = createAnthropic({ apiKey })
      return (modelId) => provider.languageModel(modelId)
    },
  },
}

/** Provider clients are stateless and reusable; building one per call is waste. */
const clients = new Map<AiProviderId, (modelId: string) => ChatModel>()

let cachedSelection: { value: ModelSelection; readAt: number } | null = null

/** True when the value names a provider we have a client for. */
export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value)
}

/** The env-configured selection. Always available, never touches the database. */
export function envModelSelection(): ModelSelection {
  const config = env()
  return { provider: config.AI_PROVIDER, modelId: config.AI_MODEL, source: 'env' }
}

/**
 * Read the `ai.model` override.
 *
 * Every failure path returns `null` and falls back to env: a settings table
 * that does not exist yet, a database that is down, or a row somebody
 * hand-edited into nonsense. None of those are reasons for the planner to stop
 * answering travellers — but each earns a log line, because silently ignoring
 * an override ops just set is a genuinely confusing way to lose an afternoon.
 */
async function readModelSetting(): Promise<Partial<ModelSelection> | null> {
  let raw: unknown
  try {
    const row = await db.setting.findUnique({
      where: { key: AI_MODEL_SETTING_KEY },
      select: { value: true },
    })
    if (!row) return null
    raw = row.value
  } catch (e) {
    const description = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.warn(
      `[ai] could not read "${AI_MODEL_SETTING_KEY}", using env defaults: ${description}`
    )
    return null
  }

  const parsed = ModelSettingSchema.safeParse(raw)
  if (!parsed.success) {
    console.warn(
      `[ai] settings row "${AI_MODEL_SETTING_KEY}" is not a valid model selection, using env defaults`
    )
    return null
  }

  const { provider, model } = parsed.data
  if (!provider && !model) return null

  return { provider, modelId: model }
}

/**
 * The selection in force right now: env, with the settings row layered on top.
 *
 * A row may override only the model (stay on Google, move to a newer Gemini) or
 * only the provider, so the two fields merge independently.
 */
export async function resolveModelSelection(override?: ModelOverride): Promise<ModelSelection> {
  // Fully pinned by the caller — no reason to consult anything.
  if (override?.provider && override.modelId) {
    return { provider: override.provider, modelId: override.modelId, source: 'explicit' }
  }

  const fromEnv = envModelSelection()
  const fresh =
    cachedSelection !== null && Date.now() - cachedSelection.readAt < MODEL_SETTING_TTL_MS

  let base: ModelSelection
  if (fresh && cachedSelection) {
    base = cachedSelection.value
  } else {
    const setting = await readModelSetting()
    base = setting
      ? {
          provider: setting.provider ?? fromEnv.provider,
          modelId: setting.modelId ?? fromEnv.modelId,
          source: 'setting',
        }
      : fromEnv
    cachedSelection = { value: base, readAt: Date.now() }
  }

  if (!override?.provider && !override?.modelId) return base

  return {
    provider: override.provider ?? base.provider,
    modelId: override.modelId ?? base.modelId,
    source: 'explicit',
  }
}

/**
 * Build the SDK handle for an already-decided selection.
 *
 * Synchronous and database-free, so a caller that already knows what it wants —
 * replaying a message against the exact model that produced it, for instance —
 * does not pay for a settings lookup.
 */
export function buildModel(selection: Pick<ModelSelection, 'provider' | 'modelId'>): ChatModel {
  const entry = REGISTRY[selection.provider]
  if (!entry) {
    throw new Error(`Unknown AI provider "${selection.provider}".`)
  }

  let client = clients.get(selection.provider)
  if (!client) {
    const apiKey = env()[entry.keyVar]
    if (!apiKey) {
      throw new Error(
        `AI provider "${selection.provider}" is selected but ${entry.keyVar} is not set.`
      )
    }
    client = entry.create(apiKey)
    clients.set(selection.provider, client)
  }

  return client(selection.modelId)
}

/**
 * The model to use for this call, with the metadata worth logging beside it.
 *
 * Returns the selection as well as the handle because usage accounting needs to
 * record *which* model produced a message — a cost attributed to the wrong
 * model is worse than no cost at all.
 */
export async function getModel(override?: ModelOverride): Promise<ActiveModel> {
  const selection = await resolveModelSelection(override)
  return { ...selection, model: buildModel(selection) }
}

/**
 * The pin for calls whose output shape is enforced by a schema.
 *
 * Pass to `getModel()` ONLY where the result is decoded against a
 * `responseSchema` — `generateObject`, not `streamText`. That condition is the
 * whole safety argument, not a stylistic preference.
 *
 * Which is why the planner never gets this pin. Its guarantees — recommend only
 * what the catalog returned, never disclose these instructions — are carried by
 * the prompt, and a cheaper model that treats a prompt loosely cannot carry
 * them. Here the decoder imposes the shape instead, so a weaker model is fine.
 *
 * On why this is flash-lite and not Gemma, which is the obvious candidate:
 * `gemma-4-31b-it` narrates instructions rather than following them (asked to
 * reply in one word it answers `* Input: … * Constraint 1: …`, in the system and
 * user roles alike, since it has no system role on this API), and while it
 * handles a trivial schema it timed out past five minutes on the real
 * `TeaserResponseSchema`. Flash-lite returns the same shape in under a second.
 *
 * Returns `undefined` when AI_MODEL_CHEAP is unset, so the caller transparently
 * falls back to the normal selection.
 */
export function schemaConstrainedModel(): ModelOverride | undefined {
  const { AI_MODEL_CHEAP, AI_PROVIDER } = env()
  if (!AI_MODEL_CHEAP) return undefined

  return { provider: AI_PROVIDER, modelId: AI_MODEL_CHEAP }
}

/**
 * Drop cached provider clients and the cached settings row.
 *
 * Call this after writing `ai.model` so the change takes effect immediately
 * rather than up to `MODEL_SETTING_TTL_MS` later. Also the reset hook for tests.
 */
export function clearModelCache(): void {
  cachedSelection = null
  clients.clear()
}
