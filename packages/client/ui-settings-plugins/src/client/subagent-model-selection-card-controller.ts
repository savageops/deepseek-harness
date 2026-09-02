/** Staged editor for the Host-owned subagent model allowlist. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  ModelCatalogModel,
  ModelProviderGroup,
  ModelSelection,
  SubagentProviderInfo,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'

/** Namespace of the Host-owned subagent model-selection preference. */
export const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection'

/** One exact provider/model route stored as user authorization. */
export interface AllowedSubagentModel {
  provider: string
  model: string
}

/** Settings fields stored for subagent model selection. */
export interface SubagentModelSelectionSettings {
  /** Explicit child-runtime provider; omission keeps the preset default. */
  runtimeProvider?: string
  /** Whether model-facing child route selection applies to new Sessions. */
  enabled: boolean
  /** Automatic child route used when a delegation call does not choose one. */
  defaultSelection?: ModelSelection
  /** Exact child routes offered to newly composed top-level Sessions. */
  allowedModels: AllowedSubagentModel[]
}

/** One catalog row joined with a stored route that may no longer be advertised. */
export interface SubagentModelCandidate extends AllowedSubagentModel {
  /** Stable opaque identity used only for lookup. */
  key: string
  /** Adapter-owned provider display name. */
  providerName: string
  /** Adapter-owned model display name. */
  modelName: string
  /** Whether the current adapter catalog advertises this exact route. */
  available: boolean
  /** Whether the current draft authorizes this route. */
  selected: boolean
  /** Exact-model reasoning metadata from the live catalog, when available. */
  reasoning?: ModelCatalogModel['reasoning']
}

/** One child-runtime provider joined with an optional saved provider name. */
export interface SubagentRuntimeCandidate extends SubagentProviderInfo {
  /** Whether the provider is registered in the current Host composition. */
  available: boolean
}

/** State rendered by the staged allowlist card. */
export interface SubagentModelSelectionCardState extends CardShell {
  /** Explicit child-runtime provider, or null for the preset default. */
  runtimeProvider: string | null
  /** Registered child runtimes plus a retained unavailable saved choice. */
  runtimeCandidates: readonly SubagentRuntimeCandidate[]
  /** Child-runtime directory request state. */
  runtimeStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Model/effort authority of the selected child runtime. */
  runtimeAuthority: 'harness' | 'native' | 'unknown'
  /** Display label of the selected child runtime, when registered. */
  runtimeLabel?: string
  /** Settings-facing explanation of the selected child runtime. */
  runtimeDescription?: string
  /** Whether the draft enables model-facing child route selection. */
  enabled: boolean
  /** Automatic child route staged for new Agents, or null for inheritance. */
  defaultSelection: ModelSelection | null
  /** Live catalog joined with stored routes. */
  candidates: readonly SubagentModelCandidate[]
  /** Adapter-directory request state. */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Whether any provider-local catalog request failed. */
  catalogPartial: boolean
  /** Whether a newer Host revision invalidated the current draft. */
  conflicted: boolean
}

/** Registration-side face for the subagent model-selection card. */
export interface SubagentModelSelectionCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useSubagentModelSelectionCard. */
    subagentModelSelectionCard: SnapshotStore<SubagentModelSelectionCardState>
  }
  /** Stage the child-runtime provider; an empty key restores the preset default. */
  selectRuntimeProvider: (provider: string) => void
  /** Stage the enabled state; enabling also loads the adapter directory. */
  toggleEnabled: () => void
  /** Stage one exact route as allowed or denied. */
  toggleModel: (key: string) => void
  /** Stage the automatic child model route. */
  selectDefaultModel: (key: string) => void
  /** Stage the automatic child reasoning effort. */
  selectDefaultEffort: (effort: string | undefined) => void
  /** Retry the adapter directory. */
  retryCatalog: () => void
  /** Persist the switch and exact routes as one revision-fenced mutation. */
  save: () => void
  /** Drop the staged enabled state and route choices. */
  discard: () => void
}

/**
 * Stable identity for one exact route; callers resolve it by lookup and never parse it.
 * @param route - Provider/model route to identify.
 * @returns Opaque key for lookup within the card.
 */
export function subagentModelKey(route: AllowedSubagentModel): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Join live adapter metadata with stored routes that remain removable after disappearance.
 * @param groups - Current model directory grouped by provider.
 * @param stored - Routes in the effective settings value.
 * @param selected - Opaque route keys selected in the current draft.
 * @returns Candidate rows for the card.
 */
export function subagentModelCandidates(
  groups: readonly ModelProviderGroup[],
  stored: readonly AllowedSubagentModel[],
  selected: ReadonlySet<string>,
): SubagentModelCandidate[] {
  const storedByKey = new Map(stored.map(route => [subagentModelKey(route), route]))
  const candidates = groups.flatMap(group => group.models.map((model): SubagentModelCandidate => {
    const route = { provider: group.id, model: model.id }
    const key = subagentModelKey(route)
    storedByKey.delete(key)
    return {
      ...route,
      key,
      providerName: group.name,
      modelName: model.name,
      available: true,
      selected: selected.has(key),
      ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
    }
  }))
  for (const route of storedByKey.values()) {
    const key = subagentModelKey(route)
    candidates.push({
      ...route,
      key,
      providerName: route.provider,
      modelName: route.model,
      available: false,
      selected: selected.has(key),
    })
  }
  return candidates
}

/**
 * Join the live child-runtime directory with one saved provider that may have
 * disappeared after a profile change. The command and process configuration
 * never enter this client projection.
 * @param providers - currently registered provider metadata.
 * @param stored - saved provider names.
 * @returns live providers followed by unavailable saved names.
 */
export function subagentRuntimeCandidates(
  providers: readonly SubagentProviderInfo[],
  stored: readonly string[],
): SubagentRuntimeCandidate[] {
  const storedNames = new Set(stored)
  const candidates = providers.map((provider) => {
    storedNames.delete(provider.name)
    return { ...provider, available: true }
  })
  for (const name of storedNames) {
    candidates.push({
      name,
      label: name,
      description: 'This child runtime is saved but is not registered in the current profile.',
      kind: 'custom',
      modelAuthority: 'native',
      available: false,
    })
  }
  return candidates
}

function sameRoutes(left: readonly AllowedSubagentModel[], right: readonly AllowedSubagentModel[]): boolean {
  if (left.length !== right.length) return false
  const rightKeys = new Set(right.map(subagentModelKey))
  return left.every(route => rightKeys.has(subagentModelKey(route)))
}

function sameSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left?.provider === right?.provider
    && left?.model === right?.model
    && left?.reasoningEffort === right?.reasoningEffort
}

/** Bridges one settings scope and the live adapter directory onto a staged card. */
export class SubagentModelSelectionCardController {
  private catalogGroups: readonly ModelProviderGroup[] = []
  private runtimeProviders: readonly SubagentProviderInfo[] = []
  private catalogPartial = false
  private catalogStatus: SubagentModelSelectionCardState['catalogStatus'] = 'idle'
  private runtimeStatus: SubagentModelSelectionCardState['runtimeStatus']
  private draftEnabled: boolean | undefined
  private draftRoutes: Map<string, AllowedSubagentModel> | undefined
  private draftDefaultSelection: ModelSelection | null | undefined
  private draftRuntimeProvider: string | null | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private catalogGeneration = 0
  private runtimeGeneration = 0
  private readonly store: SnapshotStore<SubagentModelSelectionCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `subagent-model-selection` settings scope.
   * @param ctx - the card plugin's context, whose `remote.session` namespace
   * answers the Host model catalog and whose `remote.subagents` namespace
   * answers the registered child-runtime directory.
   */
  constructor(
    private readonly scope: SettingsScope<SubagentModelSelectionSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.runtimeStatus = 'idle'
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving && this.draftRoutes !== undefined
        && this.scope.getSnapshot().revision !== this.draftRevision) {
        if (this.currentEnabled() === this.enabled()
          && sameRoutes(this.currentRoutes(), this.desiredRoutes())
          && sameSelection(this.currentDefaultSelection(), this.desiredDefaultSelection())) this.clearDraft()
        else this.conflicted = true
      }
      if (this.enabled() && this.catalogStatus === 'idle') void this.loadCatalog()
      if (this.runtimeStatus === 'idle') void this.loadRuntimeCatalog()
      this.publish()
    })
    if (this.enabled() && this.catalogStatus === 'idle') void this.loadCatalog()
    if (this.runtimeStatus === 'idle') void this.loadRuntimeCatalog()
  }

  /** Stop observing settings and suppress late directory/write settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    this.runtimeGeneration += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this card.
   * @returns The snapshot and staged card actions injected into the renderer.
   */
  inject(): SubagentModelSelectionCardFace {
    return {
      hooks: { subagentModelSelectionCard: this.store },
      selectRuntimeProvider: (provider) => { this.selectRuntimeProvider(provider) },
      toggleEnabled: () => { this.toggleEnabled() },
      toggleModel: (key) => { this.toggleModel(key) },
      selectDefaultModel: (key) => { this.selectDefaultModel(key) },
      selectDefaultEffort: (effort) => { this.selectDefaultEffort(effort) },
      retryCatalog: () => { this.retryCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  private currentRoutes(): AllowedSubagentModel[] {
    return this.scope.getSnapshot().value?.allowedModels.map(route => ({ ...route })) ?? []
  }

  private currentRuntimeProvider(): string | null {
    return this.scope.getSnapshot().value?.runtimeProvider ?? null
  }

  private currentEnabled(): boolean {
    return this.scope.getSnapshot().value?.enabled ?? false
  }

  private currentDefaultSelection(): ModelSelection | null {
    const selection = this.scope.getSnapshot().value?.defaultSelection
    return selection === undefined ? null : { ...selection }
  }

  private selected(): Set<string> {
    return new Set(this.draftRoutes?.keys() ?? this.currentRoutes().map(subagentModelKey))
  }

  private enabled(): boolean {
    return this.draftEnabled ?? this.currentEnabled()
  }

  private beginDraft(): Map<string, AllowedSubagentModel> {
    if (this.draftRoutes === undefined) {
      const snapshot = this.scope.getSnapshot()
      this.draftEnabled = snapshot.value?.enabled ?? false
      this.draftRoutes = new Map(
        snapshot.value?.allowedModels.map(route => [subagentModelKey(route), { ...route }]) ?? [],
      )
      this.draftDefaultSelection = snapshot.value?.defaultSelection === undefined
        ? null
        : { ...snapshot.value.defaultSelection }
      this.draftRuntimeProvider = snapshot.value?.runtimeProvider ?? null
      this.draftRevision = snapshot.revision
    }
    return this.draftRoutes
  }

  private toggleEnabled(): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    this.beginDraft()
    this.draftEnabled = !this.draftEnabled
    this.failed = false
    if (this.draftEnabled && this.catalogStatus === 'idle') void this.loadCatalog()
    this.publish()
  }

  private selectRuntimeProvider(provider: string): void {
    if (this.saving || !this.scope.getSnapshot().writable) return
    if (provider.length > 0 && !this.runtimeCandidates().some(candidate => candidate.name === provider && candidate.available)) return
    this.beginDraft()
    this.draftRuntimeProvider = provider.length === 0 ? null : provider
    this.failed = false
    this.publish()
  }

  private toggleModel(key: string): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    const candidate = this.candidates().find(candidate => candidate.key === key)
    if (candidate === undefined) return
    const routes = this.beginDraft()
    if (routes.has(key)) routes.delete(key)
    else routes.set(key, { provider: candidate.provider, model: candidate.model })
    this.failed = false
    this.publish()
  }

  private selectDefaultModel(key: string): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    if (key.length === 0) {
      this.beginDraft()
      this.draftDefaultSelection = null
      this.failed = false
      this.publish()
      return
    }
    const candidate = this.candidates().find(candidate => candidate.key === key)
    if (candidate === undefined || !candidate.available) return
    this.beginDraft()
    this.draftDefaultSelection = {
      provider: candidate.provider,
      model: candidate.model,
      ...candidate.reasoning?.defaultEffort === undefined
        ? {}
        : { reasoningEffort: candidate.reasoning.defaultEffort },
    }
    this.failed = false
    this.publish()
  }

  private selectDefaultEffort(effort: string | undefined): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    const current = this.defaultSelection()
    if (current === null) return
    this.beginDraft()
    this.draftDefaultSelection = {
      provider: current.provider,
      model: current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    this.failed = false
    this.publish()
  }

  private clearDraft(): void {
    this.draftEnabled = undefined
    this.draftRoutes = undefined
    this.draftDefaultSelection = undefined
    this.draftRuntimeProvider = undefined
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  private candidates(): SubagentModelCandidate[] {
    const retained = new Map(this.currentRoutes().map(route => [subagentModelKey(route), route]))
    for (const [key, route] of this.draftRoutes ?? []) retained.set(key, route)
    const defaultSelection = this.defaultSelection()
    if (defaultSelection !== null) {
      const key = subagentModelKey(defaultSelection)
      if (!retained.has(key)) retained.set(key, {
        provider: defaultSelection.provider,
        model: defaultSelection.model,
      })
    }
    return subagentModelCandidates(this.catalogGroups, [...retained.values()], this.selected())
  }

  private runtimeCandidates(): SubagentRuntimeCandidate[] {
    const stored = new Set<string>()
    const current = this.currentRuntimeProvider()
    if (current !== null) stored.add(current)
    const draft = this.draftRuntimeProvider
    if (draft !== undefined && draft !== null) stored.add(draft)
    return subagentRuntimeCandidates(this.runtimeProviders, [...stored])
  }

  private desiredRoutes(): AllowedSubagentModel[] {
    return [...this.draftRoutes?.values() ?? this.currentRoutes()].map(route => ({ ...route }))
  }

  private defaultSelection(): ModelSelection | null {
    return this.draftDefaultSelection === undefined
      ? this.currentDefaultSelection()
      : this.draftDefaultSelection === null
        ? null
        : { ...this.draftDefaultSelection }
  }

  private desiredDefaultSelection(): ModelSelection | null {
    return this.defaultSelection()
  }

  private runtimeProvider(): string | null {
    return this.draftRuntimeProvider === undefined
      ? this.currentRuntimeProvider()
      : this.draftRuntimeProvider
  }

  private desiredRuntimeProvider(): string | null {
    return this.runtimeProvider()
  }

  private async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const desiredEnabled = this.enabled()
    const desired = this.desiredRoutes()
    const desiredDefault = this.desiredDefaultSelection()
    const currentDefault = this.currentDefaultSelection()
    const desiredRuntimeProvider = this.desiredRuntimeProvider()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving
      || (this.currentEnabled() === desiredEnabled
        && this.currentRuntimeProvider() === desiredRuntimeProvider
        && sameRoutes(this.currentRoutes(), desired)
        && sameSelection(currentDefault, desiredDefault))
      || (desiredEnabled && desired.length === 0 && desiredDefault === null)) return
    if (this.draftRoutes !== undefined && snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    await this.scope.mutate([
      ...desiredRuntimeProvider === null
        ? snapshot.value?.runtimeProvider === undefined
          ? []
          : [{ op: 'unset' as const, path: ['runtimeProvider'] }]
        : [{ op: 'set' as const, path: ['runtimeProvider'], value: desiredRuntimeProvider }],
      { op: 'set', path: ['enabled'], value: desiredEnabled },
      {
        op: 'set',
        path: ['allowedModels'],
        value: desired.map(route => ({ provider: route.provider, model: route.model })),
      },
      ...desiredDefault === null
        ? snapshot.value?.defaultSelection === undefined
          ? []
          : [{ op: 'unset' as const, path: ['defaultSelection'] }]
        : [{ op: 'set' as const, path: ['defaultSelection'], value: {
          provider: desiredDefault.provider,
          model: desiredDefault.model,
          ...desiredDefault.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: desiredDefault.reasoningEffort },
        } }],
    ], this.draftRevision)
    if (generation !== this.saveGeneration) return
    const landed = this.currentEnabled() === desiredEnabled
      && this.currentRuntimeProvider() === desiredRuntimeProvider
      && sameRoutes(this.currentRoutes(), desired)
      && sameSelection(this.currentDefaultSelection(), desiredDefault)
    this.saving = false
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
  }

  /** Invalidate and reload model candidates after a Host model input changes. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.runtimeGeneration += 1
    this.catalogStatus = 'idle'
    this.catalogPartial = false
    this.runtimeStatus = 'idle'
    if (this.enabled()) void this.loadCatalog()
    void this.loadRuntimeCatalog()
    this.publish()
  }

  /** Drop Host-specific candidates and drafts, then reload after reconnecting. */
  resetConnection(): void {
    if (this.disposed) return
    this.saveGeneration += 1
    this.saving = false
    this.clearDraft()
    this.catalogGroups = []
    this.runtimeProviders = []
    this.refreshCatalog()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    const response = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.catalogGeneration) return
    if (response.ok) {
      this.catalogGroups = response.value.groups
      this.catalogPartial = response.value.failures.length > 0
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private retryCatalog(): void {
    if (this.disposed) return
    if (this.enabled()) void this.loadCatalog()
    void this.loadRuntimeCatalog()
  }

  private async loadRuntimeCatalog(): Promise<void> {
    if (this.disposed || this.runtimeStatus === 'loading') return
    const generation = this.runtimeGeneration
    this.runtimeStatus = 'loading'
    this.publish()
    try {
      const response = await this.ctx.remote.subagents.providers()
      if (generation !== this.runtimeGeneration) return
      if (!response.ok) throw new Error(response.error.message)
      this.runtimeProviders = response.value.providers
      this.runtimeStatus = 'ready'
    } catch {
      if (generation !== this.runtimeGeneration) return
      this.runtimeStatus = 'error'
    }
    this.publish()
  }

  private projection(): SubagentModelSelectionCardState {
    const snapshot = this.scope.getSnapshot()
    const current = this.currentRoutes()
    const desired = this.desiredRoutes()
    const enabled = this.enabled()
    const currentDefault = this.currentDefaultSelection()
    const desiredDefault = this.desiredDefaultSelection()
    const desiredRuntimeProvider = this.desiredRuntimeProvider()
    const selectedRuntime = this.runtimeCandidates().find(candidate => candidate.name === desiredRuntimeProvider)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.currentEnabled() !== enabled
        || this.currentRuntimeProvider() !== desiredRuntimeProvider
        || !sameRoutes(current, desired)
        || !sameSelection(currentDefault, desiredDefault),
      invalid: enabled && desired.length === 0 && desiredDefault === null,
      saving: this.saving,
      failed: this.failed,
      enabled,
      runtimeProvider: desiredRuntimeProvider,
      runtimeCandidates: this.runtimeCandidates(),
      runtimeStatus: this.runtimeStatus,
      runtimeAuthority: selectedRuntime?.modelAuthority ?? (desiredRuntimeProvider === null ? 'harness' : 'unknown'),
      ...selectedRuntime?.label === undefined ? {} : { runtimeLabel: selectedRuntime.label },
      ...selectedRuntime?.description === undefined ? {} : { runtimeDescription: selectedRuntime.description },
      defaultSelection: desiredDefault,
      candidates: this.candidates(),
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      conflicted: this.conflicted,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
