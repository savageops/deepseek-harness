/** User control for model-selectable subagent delegation in new sessions. */

import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SubagentModelCandidate,
  SubagentModelSelectionCardFace,
} from './subagent-model-selection-card-controller.ts'
import type {} from './slot-contract.ts'
import { PluginCard } from './PluginCard.tsx'
import css from './SubagentModelSelectionCard.module.css'

/** Props the renderer binds for the subagent model-selection card. */
export type SubagentModelSelectionCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SubagentModelSelectionCardFace>

/**
 * Render the default-off preference and its exact adapter-route choices.
 * @param props - locale copy, the card snapshot, and its toggle action.
 * @returns the preference card, or nothing when the namespace is unavailable.
 */
export function SubagentModelSelectionCard(props: SubagentModelSelectionCardProps) {
  const { t } = props
  const state = props.useSubagentModelSelectionCard(snapshot => snapshot)
  const availableGroups = new Map<string, {
    providerName: string
    candidates: SubagentModelCandidate[]
  }>()
  const unavailable: SubagentModelCandidate[] = []
  for (const candidate of state.candidates) {
    if (!candidate.available) {
      unavailable.push(candidate)
      continue
    }
    const group = availableGroups.get(candidate.provider)
    if (group === undefined) {
      availableGroups.set(candidate.provider, {
        providerName: candidate.providerName,
        candidates: [candidate],
      })
    } else {
      group.candidates.push(candidate)
    }
  }
  const defaultKey = state.defaultSelection === null
    ? ''
    : `${state.defaultSelection.provider}\0${state.defaultSelection.model}`
  const defaultCandidate = state.defaultSelection === null
    ? undefined
    : state.candidates.find(candidate => candidate.key === defaultKey)
  const reasoning = defaultCandidate?.reasoning
  const effortValue = state.defaultSelection?.reasoningEffort ?? reasoning?.defaultEffort ?? ''
  const selectedRuntime = state.runtimeProvider === null
    ? undefined
    : state.runtimeCandidates.find(candidate => candidate.name === state.runtimeProvider)
  const nativeRuntime = state.runtimeAuthority === 'native'
  const unavailableRuntime = selectedRuntime?.available === false ? selectedRuntime : undefined
  const runtimeDisabled = !state.writable || state.saving || state.runtimeStatus === 'loading'
  const renderCandidate = (candidate: SubagentModelCandidate) => (
    <label key={candidate.key} className={css.model}>
      <input
        type="checkbox"
        checked={candidate.selected}
        disabled={!state.writable || state.saving}
        onChange={() => { props.toggleModel(candidate.key) }}
      />
      <span>
        <span className={css.modelName}>{candidate.modelName}</span>
        <span className={css.route}>{`${candidate.providerName} · ${candidate.provider}/${candidate.model}`}</span>
      </span>
      {!candidate.available
        ? <span className={css.unavailable}>{t('subagentModelSelectionUnavailable')}</span>
        : null}
    </label>
  )
  return (
    <PluginCard
      t={t}
      titleKey="subagentModelSelectionTitle"
      descriptionKey="subagentModelSelectionDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.runtimeSelection}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('subagentRuntime')}</span>
          <select
            aria-label={t('subagentRuntime')}
            value={state.runtimeProvider ?? ''}
            disabled={runtimeDisabled}
            onChange={(event) => { props.selectRuntimeProvider(event.currentTarget.value) }}
          >
            <option value="">{t('subagentRuntimeProfileDefault')}</option>
            {state.runtimeCandidates.filter(candidate => candidate.available).map(candidate => (
              <option key={candidate.name} value={candidate.name}>
                {`${candidate.label} · ${candidate.name}`}
              </option>
            ))}
            {unavailableRuntime !== undefined
              ? (
                <option value={unavailableRuntime.name}>
                  {`${unavailableRuntime.label} · ${unavailableRuntime.name} (${t('subagentRuntimeUnavailable')})`}
                </option>
              )
              : null}
          </select>
        </label>
        {state.runtimeStatus === 'loading'
          ? <p className={css.notice} role="status">{t('subagentRuntimeLoading')}</p>
          : null}
        {state.runtimeStatus === 'error'
          ? (
            <div className={css.catalogError} role="alert">
              <span>{t('subagentRuntimeLoadFailed')}</span>
              <button type="button" disabled={state.saving} onClick={props.retryCatalog}>
                {t('subagentModelSelectionRetry')}
              </button>
            </div>
          )
          : null}
        {nativeRuntime
          ? <p className={css.notice}>{state.runtimeDescription ?? t('subagentRuntimeNativeNotice')}</p>
          : null}
      </div>
      {!nativeRuntime
        ? (
          <div className={css.permission}>
            <div className={css.toggleRow}>
              <span className={css.toggleLabel}>{t('subagentModelSelectionToggle')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={state.enabled}
                aria-label={t('subagentModelSelectionToggle')}
                className={clsx(css.switch, state.enabled && css.switchOn)}
                disabled={!state.writable || state.saving}
                onClick={props.toggleEnabled}
              >
                <span className={css.thumb} />
              </button>
            </div>
            <p className={css.hint}>
              {t(state.enabled ? 'subagentModelSelectionChoose' : 'subagentModelSelectionOff')}
            </p>
          </div>
        )
        : null}
      {state.enabled && !nativeRuntime
        ? (
          <div className={css.selection}>
            <div className={css.defaultSelection}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('subagentModelSelectionDefault')}</span>
                <select
                  aria-label={t('subagentModelSelectionDefault')}
                  value={defaultKey}
                  disabled={!state.writable || state.saving || state.catalogStatus === 'loading'}
                  onChange={(event) => { props.selectDefaultModel(event.currentTarget.value) }}
                >
                  <option value="">{t('subagentModelSelectionUseParent')}</option>
                  {[...availableGroups].map(([provider, group]) => (
                    <optgroup key={provider} label={group.providerName}>
                      {group.candidates.map(candidate => (
                        <option key={candidate.key} value={candidate.key}>
                          {`${candidate.modelName} · ${candidate.provider}/${candidate.model}`}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  {defaultCandidate !== undefined && !defaultCandidate.available
                    ? (
                      <option value={defaultCandidate.key}>
                        {`${defaultCandidate.modelName} · ${defaultCandidate.provider}/${defaultCandidate.model} (${t('subagentModelSelectionUnavailable')})`}
                      </option>
                    )
                    : null}
                </select>
              </label>
              {reasoning !== undefined
                ? (
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('subagentModelSelectionEffort')}</span>
                    <select
                      aria-label={t('subagentModelSelectionEffort')}
                      value={effortValue}
                      disabled={!state.writable || state.saving}
                      onChange={(event) => {
                        const value = event.currentTarget.value
                        props.selectDefaultEffort(value.length === 0 ? undefined : value)
                      }}
                    >
                      {reasoning.defaultEffort === undefined
                        ? <option value="">{t('subagentModelSelectionProviderDefault')}</option>
                        : null}
                      {reasoning.efforts.map(effort => (
                        <option key={effort.id} value={effort.id}>{effort.name}</option>
                      ))}
                    </select>
                  </label>
                )
                : null}
            </div>
            {state.catalogStatus === 'loading'
              ? <p className={css.notice} role="status">{t('subagentModelSelectionLoading')}</p>
              : null}
            {state.catalogStatus === 'error'
              ? (
                <div className={css.catalogError} role="alert">
                  <span>{t('subagentModelSelectionLoadFailed')}</span>
                  <button type="button" disabled={state.saving} onClick={props.retryCatalog}>
                    {t('subagentModelSelectionRetry')}
                  </button>
                </div>
              )
              : null}
            {state.catalogPartial
              ? <p className={css.notice}>{t('subagentModelSelectionPartial')}</p>
              : null}
            {state.candidates.length > 0
              ? (
                <fieldset className={css.models}>
                  <legend>{t('subagentModelSelectionAllowed')}</legend>
                  {[...availableGroups].map(([provider, group]) => (
                    <div key={provider} className={css.modelGroup}>
                      <div className={css.providerName}>{group.providerName}</div>
                      {group.candidates.map(renderCandidate)}
                    </div>
                  ))}
                  {unavailable.length > 0
                    ? (
                      <div className={css.modelGroup}>
                        <div className={css.providerName}>{t('subagentModelSelectionUnavailableGroup')}</div>
                        {unavailable.map(renderCandidate)}
                      </div>
                    )
                    : null}
                </fieldset>
              )
              : state.catalogStatus === 'ready'
                ? <p className={css.notice}>{t('subagentModelSelectionEmpty')}</p>
                : null}
            {state.invalid ? <p className={css.invalid}>{t('subagentModelSelectionRequired')}</p> : null}
          </div>
        )
        : null}
      {state.conflicted
        ? <p className={css.conflict} role="status">{t('subagentModelSelectionConflict')}</p>
        : null}
    </PluginCard>
  )
}
