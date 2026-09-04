# Agent Note: Installed-vocabulary admission in session format migrations

Status: implemented

English | [中文](2026-09-04-session-format-migration-installed-vocabulary.zh.md)

## Problem

The released v0→v1→v2 migration chain validates against the frozen released event inventories and refuses every unknown historical event type, even one marked `ignorable`. A v0 log written by this fork's `subagent` plugin therefore became unreadable the moment the released migration chain landed: `subagent/runtime-provider-selection` sits in the installed build's `KNOWN_SESSION_EVENT_TYPES` but not in any released inventory, so cold reads refused the whole session before the installed restorer could interpret it.

## Decision

Each adjacent migration and the released-v0 codec now accept the installed build's own event vocabulary, supplied once by the generated catalog as `KNOWN_SESSION_EVENT_TYPES`:

```ts ignore-check
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { createSessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { createSessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'

export const sessionFormatCatalog = createSessionFormatCatalog({
  migrations: [
    createSessionFormatV0ToV1(KNOWN_SESSION_EVENT_TYPES),
    createSessionFormatV1ToV2(KNOWN_SESSION_EVENT_TYPES),
  ],
  installedEventTypes: KNOWN_SESSION_EVENT_TYPES,
})
```

An event type inside a released inventory keeps full payload, relationship, and semantic validation. An event type that only the installed build declares migrates as an opaque record: the envelope still requires exact `type`/`seq`/`time`/`data` keys with dense sequence numbers, payload semantics are skipped because the installed build owns them, and the record is carried forward untouched so later restorations reinterpret it against the same vocabulary. Types outside both sets still refuse, and the released inventories themselves stay frozen; the catalog remains the single place where the installed vocabulary is injected.

This completes the read side of the 2026-08-28 registration seam: registration makes a live reader accept a type, and the generated catalog makes historical migration admit the same installed set.

## Alternatives considered

Adding the fork's event types to the frozen released inventories was rejected: those inventories describe what any released v0/v1/v2 writer may emit, and fork-local vocabulary would make the released format a moving target. Converting registered events to `ignorable` markers on write was rejected because it silently drops model-invisible history instead of carrying it, and it cannot repair already-written logs. Threading the mounted `ctx.sessionEventTypes` registry into the persistence layer was rejected because historical readability would then depend on which plugins happen to be mounted; the generated static catalog keeps the chain build-static.

## Consequences

Old logs that reference fork-local event types migrate and reopen; the opaque records ride the chain verbatim and the installed Session package reinterprets them. Builds without a declaration for an installed-only type still refuse, so fail-closed behavior is preserved. Future adjacent migrations must accept the same installed set, which the generated catalog supplies automatically.
