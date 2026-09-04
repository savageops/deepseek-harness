/**
 * Runtime admission registry for durable event types declared outside the
 * harness repository.
 *
 * The generated first-party set remains the source of truth for events owned
 * by this repository. This registry is the explicit compatibility handshake
 * for an active plugin that owns an additional event interpreter/projection.
 * Registration is effect-owned by the caller, so plugin unload and HMR remove
 * the admission capability with the code that supplied it.
 *
 * @module @deepseek-ai/dsh-session/event-types
 */

import { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'

const EVENT_TYPE_PATTERN = /^[^/\s]+(?:\/[^/\s]+)+$/
const DEFAULT_OWNER = 'anonymous'

/** The public runtime admission surface for external durable event types. */
export class SessionEventTypeRegistry {
  private readonly registrations = new Map<string, { owner: string; token: symbol }>()

  /**
   * Register one or more external event types as a single atomic ownership
   * unit. The returned disposer removes only this registration and is safe to
   * call more than once.
   *
   * @param typeOrTypes - one slash-qualified type or a non-empty batch.
   * @param owner - stable plugin or package label used in collision errors.
   * @returns an idempotent disposer for this registration batch.
   * @throws when a type is malformed, first-party, already registered, or the
   *   batch contains a duplicate.
   */
  register(typeOrTypes: string | readonly string[], owner?: string): () => void {
    const rawTypes = typeof typeOrTypes === 'string' ? [typeOrTypes] : [...typeOrTypes]
    if (rawTypes.length === 0) {
      throw new Error('session event type registration requires at least one type')
    }
    const rawOwner = owner ?? DEFAULT_OWNER
    if (typeof rawOwner !== 'string') {
      throw new Error(`session event type registration owner must be a string, got ${String(rawOwner)}`)
    }
    const normalizedOwner = rawOwner.trim()
    if (normalizedOwner === '') {
      throw new Error('session event type registration owner must not be empty')
    }

    const types = rawTypes.map(normalizeEventType)
    const unique = new Set<string>()
    for (const type of types) {
      if (unique.has(type)) {
        throw new Error(`session event type "${type}" appears more than once in one registration`)
      }
      unique.add(type)
      if (KNOWN_SESSION_EVENT_TYPES.has(type)) {
        throw new Error(`session event type "${type}" belongs to the first-party vocabulary; external registration is not required`)
      }
      const current = this.registrations.get(type)
      if (current !== undefined) {
        throw new Error(`session event type "${type}" is already registered by "${current.owner}"`)
      }
    }

    const token = Symbol('session-event-type-registration')
    for (const type of types) this.registrations.set(type, { owner: normalizedOwner, token })

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const type of types) {
        if (this.registrations.get(type)?.token === token) this.registrations.delete(type)
      }
    }
  }

  /**
   * Whether an external event type is currently registered by an active owner.
   * @param type - event type to test.
   * @returns true when an active owner has registered the type.
   */
  has(type: string): boolean {
    return this.registrations.has(type)
  }

  /**
   * Snapshot the external event types registered by active owners.
   * @returns the registered types in registration order; empty when none are registered.
   */
  registeredEventTypes(): readonly string[] {
    return [...this.registrations.keys()]
  }
}

function normalizeEventType(type: unknown): string {
  if (typeof type !== 'string' || EVENT_TYPE_PATTERN.test(type) === false) {
    throw new Error(`session event type must be slash-qualified without whitespace, got ${String(type)}`)
  }
  return type
}
