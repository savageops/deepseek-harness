# Agent Note: Six high-weight Web performance workstreams

Status: implemented

English | [中文](2026-08-29-web-performance-critical-path.zh.md)

## Problem

The Web client had four independent sources of avoidable latency and main-thread work: every model selector could repeat the Host catalog interrogation, one non-settling provider could hold the whole catalog open, event bursts could trigger repeated client refreshes, and model selection stayed blank while metadata or projection state arrived. Chat rendered every assembled node into the DOM, and large workspace lists retained full row style/layout/paint work even when rows were offscreen. These costs compound on large projects and make a healthy backend look hung.

## Decision

The shipped path applies six bounded optimizations at the existing owners:

1. `packages/api/session-controller/src/catalog.ts` gives every provider catalog interrogation a 2,500 ms deadline by default. A timed-out provider becomes an isolated catalog failure; successful provider groups still render. `0` remains an explicit opt-out for deployments that accept an unbounded provider read.
2. `ModelCatalogCache` in the Session Controller caches one Host-generation catalog and shares one in-flight Remote read. Adapter, settings, and credential-reference owner events invalidate the generation.
3. `ModelCatalogDirectory` in `ui-model-selection` retains the last good value during refresh and coalesces an event burst into one trailing read. Older generations cannot publish over a newer generation.
4. `ModelDirectory` exposes a durable Session selection before catalog metadata arrives and exposes the Host default as soon as the catalog is ready. `selectionSynced` distinguishes a durable projection from that default, so readiness no longer depends on two unrelated reads completing in the same order.
5. `ChatView` uses `@tanstack/react-virtual` for histories over 100 Chat nodes. It mounts the measured viewport plus 12 overscan rows, uses stable node keys, preserves per-row spacing in a flow-root measurement wrapper, and scrolls Turn navigation targets by index when the target is not mounted. The small-history path remains unchanged. Every flow item also uses `content-visibility: auto` with a 160 px intrinsic fallback. The same workstream computes each visible node's presentation position once per structural change, and memoizes each Turn-rail mark so an active-turn change only re-renders marks whose state moved.
6. `ui-workspace` applies `content-visibility: auto` and a 32 px intrinsic fallback to Session rows. It keeps the full row DOM and interaction identity for tree semantics, keyboard navigation, drag/drop, and hover cards while allowing the browser to skip offscreen rendering work. The grouped default remains capped at five non-blank rows per Workspace.

The six mechanisms reuse the existing catalog, directory, Chat row, and Session row owners. No second cache, parallel session projection, or interaction-specific sidebar virtualizer was introduced.

## Alternatives considered

**Fail the entire catalog when one provider fails.** Rejected because the catalog is advisory and a healthy provider must remain selectable when another adapter is slow or broken.

**Let each selector own a query/cache library.** Rejected because the Host-generation catalog is shared deployment state, not Session state; caching it separately in popup and composer consumers would preserve duplicate reads and create invalidation drift.

**Invalidate and start a new read for every forwarded event.** Rejected because adapter/settings/credential updates can arrive as a burst; retaining the useful read and scheduling one trailing generation bounds the request fan-out.

**Keep the selector blocked until catalog and Session projection settle together.** Rejected because a durable selection and the deployment default are already valid display state; metadata latency must not produce a blank composer.

**Virtualize every workspace row.** Rejected for this pass because the tree carries drag/drop, keyboard, hover-card, and accessibility behavior that depends on stable row identity. Native containment captures the safe offscreen win while preserving those interaction contracts.

**Render every Chat node and rely only on `content-visibility`.** Rejected for very large histories because the DOM, React tree, subscriptions, and event targets would still scale with the entire loaded order. Virtualization is required at the Chat owner; containment remains useful for mounted rows.

## Consequences

The first model-catalog read can now complete on the slowest healthy provider or at the deadline, rather than waiting for the slowest provider forever. A provider that times out remains visible as a named failure and can be retried after the owning generation changes. The uncancelled underlying provider promise may continue in the adapter after the deadline; the Remote and UI no longer wait for it.

Large Chat histories have a bounded mounted-row window, but row heights are learned as rows enter the viewport. The initial 160 px estimate can adjust scrollbar geometry as real markdown, code, tools, or images measure. Turn navigation and paging retain semantic-key anchors; DOM selectors that assume every Chat row is a direct child of the flow must use `[data-chat-flow-key]` across virtual-row wrappers.

Workspace containment does not reduce DOM cardinality. It reduces browser rendering work for offscreen rows while preserving the interaction surface. A future full tree virtualizer still requires separate proof for keyboard focus, drag boundaries, hover-card ownership, and find-in-page behavior.

## Testing

The focused source proof passes 8 files and 133 tests, including catalog cache/deadline behavior, refresh-burst coalescing, durable/default selection readiness, Chat containment/virtual-row styles, and Workspace containment styles. Targeted Host and client TypeScript builds pass. The full repository build passes and records 218 client artifacts. The long-history browser contract asserts the virtual flow is active and mounted Chat rows remain below the 88-turn fixture size while semantic tool, branch, copy, and fork interactions continue to resolve by stable identities. The jsdom ChatView contract pins the threshold switch, a bounded mounted window with indexed translated rows above it, and stable window identity across commits.

The configuration catalog was regenerated from the Host schema. The assembled browser suite and a fresh local runtime check remain the final live gates after the built artifact is installed or launched on an unused port; the user's existing `127.0.0.1:3080` process is not stopped by this change.
