/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  assertAllowedModelRoutes,
  assertSubagentModelSelection,
  type AllowedModelRoute,
  type SubagentModelSelection,
} from './model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records the child-runtime provider captured for this Session's
     * delegation definition. Absence means the tool's configured profile
     * provider. Log-only: it never enters model history.
     */
    'subagent/runtime-provider-selection': {
      /** Exact `ctx.subagents` provider name used by this Session's tool. */
      provider: string
    }
    /**
     * Records that this session's delegation tool exposes child provider,
     * model, and reasoning-effort selection. Appended before the first model
     * request; absence means the fixed-route definition. Log-only: it carries
     * no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this Session may select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
    }
    /**
     * Records the automatic child route sampled for this Session's tool
     * definition. Appended before the first model request; absence means that
     * child calls inherit the parent route unless they make an explicit choice.
     * Log-only: it carries no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-default': {
      /** Exact provider/model/effort applied to calls without an override. */
      selection: SubagentModelSelection
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Exact routes authorized for child LLM selection, or null when disabled. */
    subagentModelSelectionPolicy: AllowedModelRoute[] | null
  }
}

const modelSelectionPolicySchema: zod.ZodType<AllowedModelRoute[] | null> = zod.array(zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()).min(1).nullable()

/** Host-only projection of the durable model-selection policy. */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 1,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels } = event.data
    assertAllowedModelRoutes(allowedModels)
    if (allowedModels.length === 0) {
      throw new Error('subagent/model-selection-policy requires at least one route')
    }
    return allowedModels
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', AllowedModelRoute[] | null>

/**
 * Read the child-runtime provider captured for one delegation definition.
 * @param session - session whose durable runtime decision is read.
 * @returns the registered provider name, or undefined for the fixed-provider definition.
 */
export function subagentRuntimeProviderSelection(session: Session): string | undefined {
  const event = session.events.find(candidate => candidate.type === 'subagent/runtime-provider-selection')
  if (event?.type !== 'subagent/runtime-provider-selection') return undefined
  if (typeof event.data.provider !== 'string' || event.data.provider.length === 0) {
    throw new Error('subagent/runtime-provider-selection requires a non-empty provider name')
  }
  return event.data.provider
}

/**
 * Append the runtime provider captured by a Session's delegation definition.
 * @param session - session receiving the durable runtime decision.
 * @param provider - exact registered child-runtime provider name.
 */
export function recordSubagentRuntimeProviderSelection(session: Session, provider: string): void {
  if (subagentRuntimeProviderSelection(session) !== undefined) return
  if (provider.length === 0) throw new Error('subagent runtime selection requires a non-empty provider name')
  session.append('subagent/runtime-provider-selection', { provider })
}

/**
 * Read the exact route list captured for a model-selectable definition.
 * @param projections - registry that owns the policy projection.
 * @param session - session whose durable decision is read.
 * @returns a detached route list, or undefined for the fixed-route definition.
 */
export function subagentModelSelectionPolicy(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): AllowedModelRoute[] | undefined {
  return projections.stateOf(session, 'subagentModelSelectionPolicy')?.map(route => ({ ...route }))
}

/**
 * Append the route policy once, before its definition can reach a model request.
 * @param projections - registry that owns the policy projection.
 * @param session - session receiving the model-selectable definition.
 * @param allowedModels - exact routes the definition may select explicitly.
 */
export function recordSubagentModelSelection(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  allowedModels: readonly AllowedModelRoute[],
): void {
  if (subagentModelSelectionPolicy(projections, session) !== undefined) return
  session.append('subagent/model-selection-policy', {
    allowedModels: allowedModels.map(route => ({ ...route })),
  })
}

/**
 * Read the automatic child route captured for a Session's delegation
 * definition.
 * @param session - session whose durable decision is read.
 * @returns a detached route, or undefined when calls inherit their parent.
 */
export function subagentModelSelectionDefault(session: Session): SubagentModelSelection | undefined {
  const event = session.events.find(candidate => candidate.type === 'subagent/model-selection-default')
  if (event?.type !== 'subagent/model-selection-default') return undefined
  assertSubagentModelSelection(event.data.selection)
  return {
    provider: event.data.selection.provider,
    model: event.data.selection.model,
    ...event.data.selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: event.data.selection.reasoningEffort },
  }
}

/**
 * Append the automatic child route once, before the definition can reach a
 * model request.
 * @param session - session receiving the automatic delegation definition.
 * @param selection - exact route and optional effort applied by default.
 */
export function recordSubagentModelSelectionDefault(
  session: Session,
  selection: SubagentModelSelection,
): void {
  if (subagentModelSelectionDefault(session) !== undefined) return
  assertSubagentModelSelection(selection)
  session.append('subagent/model-selection-default', {
    selection: {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    },
  })
}
