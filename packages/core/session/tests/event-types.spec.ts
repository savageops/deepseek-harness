import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, SessionEventTypeRegistry } from '@deepseek-ai/dsh-session'

describe('SessionEventTypeRegistry', () => {
  it('registers an atomic batch and removes it through an idempotent disposer', () => {
    const registry = new SessionEventTypeRegistry()
    const dispose = registry.register(['fixture/one', 'fixture/two'], 'fixture-plugin')

    expect(registry.has('fixture/one')).toBe(true)
    expect(registry.has('fixture/two')).toBe(true)
    expect(registry.has('future/event')).toBe(false)

    dispose()
    dispose()
    expect(registry.has('fixture/one')).toBe(false)
    expect(registry.has('fixture/two')).toBe(false)
    expect(registry.registeredEventTypes()).toEqual([])
  })

  it('snapshots the registered types in registration order', () => {
    const registry = new SessionEventTypeRegistry()
    const disposeA = registry.register('fixture/alpha', 'owner-a')
    const disposeB = registry.register(['fixture/beta', 'fixture/gamma'], 'owner-b')
    expect(registry.registeredEventTypes()).toEqual(['fixture/alpha', 'fixture/beta', 'fixture/gamma'])

    disposeA()
    expect(registry.registeredEventTypes()).toEqual(['fixture/beta', 'fixture/gamma'])
    disposeB()
  })

  it('validates names, protects first-party names, and keeps failed batches atomic', () => {
    const registry = new SessionEventTypeRegistry()
    const dispose = registry.register('fixture/owned', 'owner-a')
    try {
      expect(() => registry.register([])).toThrow(/at least one type/)
      expect(() => registry.register('not-qualified')).toThrow(/slash-qualified/)
      expect(() => registry.register(['fixture/new', 'fixture/new'])).toThrow(/more than once/)
      expect(() => registry.register(['fixture/new', 'fixture/owned'], 'owner-b')).toThrow(/already registered by "owner-a"/)
      expect(registry.has('fixture/new')).toBe(false)
      expect(() => registry.register('turn/start')).toThrow(/first-party vocabulary/)
      expect(KNOWN_SESSION_EVENT_TYPES.has('turn/start')).toBe(true)
    } finally {
      dispose()
    }
  })

  it('is provided and removed with the SessionStore fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(SessionStore)
    try {
      expect(ctx.get('sessionEventTypes')).toBeInstanceOf(SessionEventTypeRegistry)
    } finally {
      await fiber.dispose()
    }
    expect(ctx.get('sessionEventTypes')).toBeUndefined()
  })
})
