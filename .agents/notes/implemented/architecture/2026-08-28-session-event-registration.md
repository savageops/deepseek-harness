# Agent Note: Runtime registration for external session event types

Status: implemented

English | [中文](2026-08-28-session-event-registration.zh.md)

## Problem

The fail-closed session reader correctly refuses an event type outside the generated first-party vocabulary. The installed `dsh-rich-tracking` plugin is a real required consumer of the deferred boundary: it writes `tracking/write`, `tracking/checkpoint`, and `tracking/decision`, and its projection needs those records when a session is reopened. A static catalog cannot include an optional out-of-repository plugin without coupling the core reader to one composition. The old per-record `ignorable` path was removed because it could not express whether a type was safe to omit and was not emitted by `Session.append()`.

## Decision

Expose one core session capability, `ctx.sessionEventTypes`, backed by `SessionEventTypeRegistry` and provided by the `SessionStore` fiber. An external required-event owner registers one type or an atomic batch before persistence reads can interpret its sessions:

```ts
import { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-session'

const ctx = new Context()
ctx.inject(['sessionEventTypes'], (scope) => {
  scope.effect(
    () => scope.sessionEventTypes.register(
      ['memory/changed'],
      'my-plugin',
    ),
    'my-plugin: session event types',
  )
})
```

The registry validates slash-qualified names, rejects first-party names and active collisions, and returns an idempotent disposer. Persistence accepts a non-generated type only when the registry currently reports it. The registration is effect/HMR scoped: disposing the owner removes its types, and a later read fails closed instead of interpreting a record without its owner. The registry admits a type; the plugin remains responsible for its declaration-merged payload, projection, invariants, and any model-visible semantics.

`dsh-rich-tracking` registers all three of its durable types in one effect and no longer passes the obsolete `ignorable` argument to `Session.append()`. Its minimum harness version is `0.1.2-alpha.1`, the first version that provides this capability.

## Alternatives considered

- **Add tracking names to `KNOWN_SESSION_EVENT_TYPES`.** Rejected because the generated set is repository-owned and must remain independent of whether an optional plugin is installed.
- **Ignore every unknown event or restore `ignorable`.** Rejected because a reader cannot infer that an unknown fact is semantically optional; omission can change a projection, request reconstruction, or recovery result.
- **Make the registry a process-global set.** Rejected because plugin unload, profile composition, and HMR would leave stale admission behind. Cordis fiber ownership already supplies the correct lifetime.
- **Build a full versioned interpreter registry now.** Deferred. The current contract needs only explicit required-type admission; owner identity and active lifetime are present, while payload interpretation stays with the plugin. A future richer compatible-interpreter contract can extend this seam without reopening the static guard.

## Consequences

The existing safety boundary remains: an unregistered event type still produces `SessionFormatUnsupportedError` with its sequence and raw artifact path. A tracking session now loads when the tracking plugin is active, including through cold observation, history paging, resume, and fork paths that share the persistence coordinator. Removing the plugin intentionally makes its sessions unavailable to a build that cannot faithfully fold the tracking records.

The runtime registry adds one small service property and no second persisted event format. First-party catalog generation remains unchanged apart from documenting the external registration boundary. The tracking plugin owns its registration through the same fiber that owns its projection and tools, so its compatibility claim cannot outlive the code that interprets the events.
