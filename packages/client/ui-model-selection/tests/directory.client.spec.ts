import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'

const value = {
  default: { provider: 'fixture', model: 'default-model' },
  routableProviders: ['fixture'],
  groups: [{
    id: 'fixture',
    name: 'Fixture',
    models: [{ id: 'default-model', name: 'Default Model' }],
  }],
  failures: [],
} as const

describe('ModelDirectory', () => {
  it('uses the Host default as soon as the catalog is ready, then marks the Session selection synced', async () => {
    const response = Promise.withResolvers<unknown>()
    const catalog = new ModelCatalogDirectory({
      modelCatalog: vi.fn(() => response.promise),
    } as never)
    const projection = createSnapshotStore<unknown>(undefined)
    const subject = new ModelDirectory(
      { selectModel: vi.fn() } as never,
      'session-1' as never,
      () => true,
      catalog,
      projection,
    )

    const loading = subject.load()
    expect(subject.store.getSnapshot()).toMatchObject({
      current: null,
      selectionSynced: false,
      status: 'loading',
    })

    response.resolve({ ok: true, value })
    await loading
    expect(subject.store.getSnapshot()).toMatchObject({
      current: value.default,
      selectionSynced: false,
      status: 'ready',
    })

    projection.set({
      lastUsed: null,
      next: { provider: 'fixture', model: 'session-model' },
    })
    expect(subject.store.getSnapshot()).toMatchObject({
      current: { provider: 'fixture', model: 'session-model' },
      selectionSynced: true,
      status: 'ready',
    })
    subject.dispose()
  })

  it('keeps a durable Session selection visible while the catalog is still loading', async () => {
    const response = Promise.withResolvers<unknown>()
    const catalog = new ModelCatalogDirectory({ modelCatalog: () => response.promise } as never)
    const projection = createSnapshotStore<unknown>({
      lastUsed: null,
      next: { provider: 'fixture', model: 'session-model' },
    })
    const subject = new ModelDirectory(
      { selectModel: vi.fn() } as never,
      'session-2' as never,
      () => true,
      catalog,
      projection,
    )

    const loading = subject.load()
    expect(subject.store.getSnapshot()).toMatchObject({
      current: { provider: 'fixture', model: 'session-model' },
      selectionSynced: true,
      status: 'loading',
    })
    response.resolve({ ok: true, value })
    await loading
    expect(subject.store.getSnapshot()).toMatchObject({
      current: { provider: 'fixture', model: 'session-model' },
      selectionSynced: true,
      status: 'ready',
    })
    subject.dispose()
  })
})
