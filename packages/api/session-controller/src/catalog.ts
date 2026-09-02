/** Shared projection of the live LLM registry into the browser model catalog. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ModelCatalog,
  ModelReasoning,
  ModelSelection,
} from './types.ts'

/** Default deadline for one provider's advisory model-catalog interrogation. */
export const DEFAULT_MODEL_CATALOG_PROVIDER_TIMEOUT_MS = 2_500

/** Cache one Host-generation catalog and share duplicate Remote reads. */
export class ModelCatalogCache {
  private generation = 0
  private current: { generation: number; value: ModelCatalog } | undefined
  private inflight: { generation: number; promise: Promise<ModelCatalog> } | undefined

  /**
   * @param ctx - Host context carrying the live LLM registry.
   * @param providerTimeoutMs - deadline for each provider's advisory read; zero disables it.
   */
  constructor(
    private readonly ctx: Context,
    private readonly providerTimeoutMs = DEFAULT_MODEL_CATALOG_PROVIDER_TIMEOUT_MS,
  ) {}

  /** Return the current generation's cached catalog or share its one read. */
  load(): Promise<ModelCatalog> {
    const current = this.current
    if (current?.generation === this.generation) return Promise.resolve(current.value)
    const inflight = this.inflight
    if (inflight?.generation === this.generation) return inflight.promise

    const generation = this.generation
    const operation = buildModelCatalog(
      this.ctx,
      undefined,
      this.providerTimeoutMs,
    ).then((value) => {
      if (generation === this.generation) this.current = { generation, value }
      return value
    }).finally(() => {
      if (this.inflight?.promise === operation) this.inflight = undefined
    })
    this.inflight = { generation, promise: operation }
    return operation
  }

  /** Mark the cached value stale without cancelling a provider read in progress. */
  invalidate(): void {
    this.generation++
  }
}

async function withProviderDeadline<T>(
  operation: Promise<T>,
  provider: string,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs === 0) return operation
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `provider "${provider}" model catalog timed out after ${String(timeoutMs)}ms`,
      ))
    }, timeoutMs)
    void operation.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Build the browser model catalog without requiring a Session.
 * @param ctx - Host context carrying the live LLM registry.
 * @param defaultSelection - deployment default used before a Session selects a model.
 * @returns successful non-empty provider groups and isolated provider failures.
 */
export async function buildModelCatalog(
  ctx: Context,
  defaultSelection: ModelSelection = ctx.agentDefaultModel.currentSelection(),
  providerTimeoutMs = DEFAULT_MODEL_CATALOG_PROVIDER_TIMEOUT_MS,
): Promise<ModelCatalog> {
  const providers = ctx.llm.listProviders()
  const catalog = await Promise.all(providers.map(async (provider) => {
    try {
      const group = await withProviderDeadline((async () => {
        const models = await ctx.llm.listModels(provider.id)
        const entries = await Promise.all(models.map(async (model) => {
          const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
          const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
            ? undefined
            : {
              efforts: resolved.reasoning.efforts.map(effort => ({
                id: effort.id,
                name: effort.name,
                ...(effort.description === undefined ? {} : { description: effort.description }),
              })),
              ...(resolved.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: resolved.reasoning.defaultEffort }),
            }
          return {
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(reasoning === undefined ? {} : { reasoning }),
          }
        }))
        return { id: provider.id, name: provider.name, models: entries }
      })(), provider.id, providerTimeoutMs)
      return {
        kind: 'group' as const,
        group,
      }
    } catch (error) {
      return {
        kind: 'failure' as const,
        failure: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }))
  return {
    default: { ...defaultSelection },
    routableProviders: providers.map(provider => provider.id),
    groups: catalog.flatMap(item => item.kind === 'group' ? [item.group] : [])
      .filter(group => group.models.length > 0),
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}
