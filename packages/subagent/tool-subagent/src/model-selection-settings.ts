/** Host-owned opt-in setting for model-selectable subagent delegation. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  assertSubagentModelSelection,
  SubagentModelSelectionSchema,
  type AllowedModelRoute,
  type SubagentModelSelection,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled when a new Agent receives its delegation tools. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** User-settings section for model-selectable subagent delegation. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = settingsNamespace('subagent-model-selection')

/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
  /** Explicit child-runtime provider; omission keeps the delegation tool's profile default. */
  runtimeProvider?: string
  /** Whether newly composed top-level Sessions receive model selection. */
  enabled: boolean
  /** Automatic child route applied when a delegation call does not choose one. */
  defaultSelection?: SubagentModelSelection
  /** Exact child LLM routes offered to newly composed top-level Sessions. */
  allowedModels: AllowedModelRoute[]
}

const createSubagentModelSelectionSchema = () => z.object({
  runtimeProvider: z.string().min(1),
  enabled: z.boolean().default(false),
  // Prevent Schemastery from materializing an omitted nested route as `{}`.
  defaultSelection: SubagentModelSelectionSchema.default(undefined as unknown as SubagentModelSelection),
  allowedModels: z.array(AllowedModelRouteSchema).default([]),
})

/** Schema served to settings clients for the opt-in preference. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA: z<SubagentModelSelectionSettings> = createSubagentModelSelectionSchema()

/** Optional deployment base for the preference. */
export interface Config {
  /** Initial child-runtime provider; omission keeps the delegation tool's profile default. */
  runtimeProvider?: string
  /** Initial enabled state inherited when the user document does not override it. */
  enabled?: boolean
  /** Initial automatic child route inherited when the user document does not override it. */
  defaultSelection?: SubagentModelSelection
  /** Initial route list inherited when the user document does not override it. */
  allowedModels?: AllowedModelRoute[]
}

function detach(value: SubagentModelSelectionSettings): SubagentModelSelectionSettings {
  return {
    ...value.runtimeProvider === undefined ? {} : { runtimeProvider: value.runtimeProvider },
    enabled: value.enabled,
    ...value.defaultSelection === undefined ? {} : {
      defaultSelection: {
        provider: value.defaultSelection.provider,
        model: value.defaultSelection.model,
        ...value.defaultSelection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: value.defaultSelection.reasoningEffort },
      },
    },
    allowedModels: value.allowedModels.map(route => ({ ...route })),
  }
}

/** Singleton settings owner read by delegation tools when an Agent is published. */
export class SubagentModelSelectionConfig extends Service {
  static Config: z<Config> = createSubagentModelSelectionSchema()

  private source: () => SubagentModelSelectionSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'subagentModelSelection')
    // Cordis supplies the schema default; the fallback also covers direct construction.
    /* v8 ignore next */
    const entry = detach({
      ...config,
      enabled: config.enabled ?? false,
      allowedModels: config.allowedModels ?? [],
    })
    this.validate(entry)
    this.source = () => entry
    installSettingsSection(
      ctx,
      SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
      SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA,
      entry,
      {
        setSource: (source) => { this.source = source },
        validate: (value) => { this.validate(value) },
        // Consumers sample at Agent publication, so a settings update never
        // rebuilds the tool definitions of an Agent that is already running.
        onChange: () => {},
      },
    )
  }

  /**
   * Read a detached selection preference for the next eligible Agent publication.
   * @returns the enabled state, automatic child route, and exact allowed routes.
   */
  current(): SubagentModelSelectionSettings {
    const current = this.source()
    return detach(current)
  }

  private validate(value: SubagentModelSelectionSettings): void {
    if (value.runtimeProvider !== undefined
      && (typeof value.runtimeProvider !== 'string' || value.runtimeProvider.length === 0)) {
      throw new Error('subagent runtime selection requires a non-empty provider name')
    }
    assertAllowedModelRoutes(value.allowedModels)
    if (value.defaultSelection !== undefined) assertSubagentModelSelection(value.defaultSelection)
    if (value.enabled && value.defaultSelection === undefined && value.allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model or a default model')
    }
  }
}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
