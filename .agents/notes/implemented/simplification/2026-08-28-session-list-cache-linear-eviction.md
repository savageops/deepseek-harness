# Agent Note: Change-driven session-list snapshots

Status: implemented

English | [中文](2026-08-28-session-list-cache-linear-eviction.zh.md)

## Problem

[`SessionManager.buildListSnapshot()`](../../../../packages/api/session-controller/src/client/sessions/manager.ts) keeps an identity cache so an unchanged refresh reuses the same `SessionListEntry` object and preserves React external-store memoization. Its eviction pass previously walked every cached id and called `items.some(...)` for each one. A list refresh therefore paid O(cache size × current list size) even though the row pass had already visited every current id. The high-cardinality browser fixture uses 1,000 sidebar sessions, so this cost lands on the chat-list refresh path. The same manager also marked the list dirty for stale projection frames and for lifecycle mutations that left list state unchanged, causing avoidable snapshot construction and subscriber work.

## Decision

Build one `Set<SessionId>` while the existing fresh-row pass runs, use it for cache eviction, and reuse it for the selected-row membership check. Make `ProjectionValueStore.apply()` report whether a row advanced, and only publish an accepted projection frame. Make list mutation application return the existing readonly summary array when no row changes, so `recordMutation()` keeps the in-flight replay journal but skips the manager notification when the current list cannot change. The list contents, established order, unchanged row references, cached items-array behavior, accepted-frame publication cadence, and `useSyncExternalStore` snapshot contract remain unchanged; cleanup stays linear and no-op updates stay change-driven.

## Alternatives considered

**Keep the nested scan.** It has no extra state but retains a quadratic refresh cost on a supported high-cardinality path.

**Build a second permanent index beside `entryCache`.** It could make membership reads constant time but would duplicate cache ownership and introduce another lifecycle to keep synchronized. The one refresh-local Set provides the needed bound without a second mutable index.

**Virtualize the sidebar.** Virtual rendering is the correct next step when DOM population is the measured bottleneck, as the [VS Code list and tree design](https://github.com/microsoft/vscode/wiki/Lists-And-Trees) demonstrates, but it changes UI ownership, accessibility, row measurement, and browser snapshot behavior. The current defect is in manager-side list construction and is safely removable without that product-scale change.

**Publish every received frame.** Publishing stale projections and no-op lifecycle mutations keeps the implementation mechanically simple, but it invalidates the reason for the existing cached snapshot and batches work that cannot change a consumer-visible list. Accepted values still publish through the existing manager path, and the mutation journal still retains no-op events for a future baseline replay.

## Consequences

Unchanged sidebar rows retain their existing object identity, removed rows no longer remain in the identity cache, and refresh cleanup scales with the number of rows. Stale projection frames and no-op list mutations no longer rebuild or notify the list snapshot. The manager still materializes the full metadata list; DOM virtualization remains a separate measured decision if the browser fixture shows rendering rather than snapshot construction as the dominant cost.

## Testing

The manager test proves that a row removed by refresh is evicted before the same id is listed again, so its reappearing row receives a new identity, and that no-op lifecycle frames do not publish. The projection-store test proves that an accepted frame publishes while a stale frame remains silent. The focused session-controller suite covers 116 tests across four files. One-shot source-level timing probes measured the pre-change manager path at 52.2 ms for twenty 1,000-row rebuilds and 106.0 ms for five 3,000-row rebuilds; the post-change probe measured accepted updates at 8.25 ms and 5.07 ms, and no-op updates at 0.44 ms and 0.09 ms for the same cardinalities and repetition counts.
