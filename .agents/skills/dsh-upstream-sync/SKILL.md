---
name: dsh-upstream-sync
description: Use when syncing this local fork of deepseek-harness with upstream (origin = deepseek-ai/deepseek-harness), before pushing to the svgop/deepseek-harness fork, or when authoring new local features so future upstream merges stay small.
---

# DSH Upstream Sync

This checkout is a fork: `origin` is upstream (`deepseek-ai/deepseek-harness`, read-only for us) and `fork` is `svgop/deepseek-harness` (our publication target). `branch.master.pushRemote = fork`, so `git push` publishes to the fork while `git fetch`/`git pull` read upstream. `rerere.enabled = true` records every conflict resolution and replays identical ones in later merges; `merge.conflictStyle = zdiff3` shows the base hunk when a conflict does need hands.

## Local features that must survive every merge

- **Subagent model selection** — default child model + reasoning-effort config, native child-runtime provider selection across subagent providers, the settings card, and durable selection events (`subagent/model-selection-default`, `subagent/runtime-provider-selection`). Primary files: `packages/subagent/tool-subagent/src/{index,model-selection*,list-models}.ts`, `packages/subagent/subagent/src/{index,control-types,types}.ts`, `packages/client/ui-settings-plugins/src/client/subagent-model-selection-card-controller.ts`.
- **Session external-event-type registration** — `ctx.sessionEventTypes` in `packages/core/session/src/event-types.ts` + `known-event-types.ts`. Known gap: read-time enforcement is dormant; upstream's `validateStoredEvents` (`packages/session/session-persistence/src/storage-contract.ts`) only honors `ignorable`.
- **Change-driven session-controller list snapshots** — boolean-returning `apply()` in `packages/api/session-controller/src/client/sessions/{manager,projection-store}.ts`, plus the model-catalog cache in `src/catalog.ts` (listens for `llm/adapters-updated`, `settings/document-updated`, `credentials/reference-updated`).
- **Host/client session faces** — `packages/api/session-controller/src/client/index.ts`, `packages/core/session/src/index.ts`.
- **Chat rendering** — virtualized long-transcript flow, scroll restore, font-axis styles in `packages/client/ui-chat/src/client/chat/{ChatView,TurnNavigator}.tsx`.
- **Rescope-vendor anchors** — inspector wire-identifier skips and cookbook `EXACT_EDITS` in `scripts/rescope-vendor.ts`.

Policy for conflicts: keep both sides. When upstream refactored a file we changed, re-apply our feature on top of upstream's new shape; when upstream deleted an API wholesale (package, export, coordinator), accept the deletion and adapt or drop our dependent code — never resurrect upstream-deleted files. Union test cases, keeping both sides' new cases.

## Sync procedure

1. Commit or stash all local work first — a dirty tree blocks the merge and risks loss. Leave `.docs/` and `.refs/` untracked (local research); exclude them from broad `git add -A`.
2. Snapshot: `git branch backup/pre-sync-$(date +%m%d)`.
3. `git fetch origin`, then compare: `git rev-list --left-right --count master...origin/master`.
4. `git merge origin/master --no-edit`. Resolve conflicts per the policy above; lean on rerere replay from earlier syncs.
5. Mechanical tail (do this even after a conflict-free merge):
   - `pnpm install` — validate the merged lockfile.
   - Regenerate derived docs from the merged source: `pnpm run gen-cordis-catalog`, `gen-config-catalog`, `gen-persistence-catalog`, `gen-doc-graphs`.
   - Mirror generator changes into the `.zh.md` counterparts by hand (generators write English only), then re-record each touched pair: `pnpm run verify-translation-pairing --write <en.md>`.
   - `pnpm run doc-sync` — all documentation gates must pass.
6. Verify: `pnpm run typecheck`, focused unit/client specs for every local feature touched by upstream, then publish with `git push` (pre-push runs typecheck again).

## Known traps

- After `pnpm run clean`, e2e fails with stale-artifact symptoms (missing exports, "initialize; category: protocol" child failures) until a full `pnpm run build` — rerun build before diagnosing.
- Windows-local e2e failures that are NOT regressions (upstream CI runs e2e on ubuntu only): `web-agent-presets` (expects `bash` toolset, Windows composes `pwsh`), `pwsh-sandbox` ACL (privilege), `web-auth` forged-loopback, LSP (`typescript-language-server` binary absent locally).
- Lefthook pre-commit gates: staged lint (140 cols), translation pairing, third-party notices (it regenerates `THIRD_PARTY_NOTICES.md` — re-stage it), whitespace, vendor manifest.

## Authoring local features for merge-ability

The 2026-09-02 sync cost ~64 hand-resolved conflicts because features were written inside files upstream actively edits. Keep new local work out of that blast radius:

- **Fork-local features live in the sibling plugin repo `dsh-better-harness`** (github.com/svgop/dsh-better-harness, mounted via the user web profile's package.json + its `dsh.bundle.patch` self-insert; sibling pattern per dsh-rich-tracking: plain JS `export function apply(ctx)` + `export const inject`, console logging). Zero in-tree footprint, merges trivially.
- In-tree patches are reserved for surgery with no public seam. Classification of the current fork divergence (audited 2026-09-05):
  - **Extractable via public seams**: features built on slots (`settings.plugins.tab` is the designated settings-page list slot), tool registration, `ctx.sessionEventTypes`. Future work goes to dsh-better-harness.
  - **NOT extractable today**: the enhanced SubagentModelSelectionCard (imports ui-settings-plugins PRIVATE building blocks — PluginCard, card-form, slot-contract — not public exports; extraction needs upstream to publicize them or forks the privates and drifts), tool-subagent's selection engine (compile-time tool-lifecycle internals), ChatView virtualization (component internals), session-controller manager/catalog (remote-owner internals). These stay in-tree; rerere manages their conflicts.
  - **Belongs upstream**: the four session read-path admission commits (`138c424a58`, `ede3d89b70`, `390009086d`, `14e325f698`) — general correctness fixes any plugin ecosystem needs; prepare as upstream PRs when there is appetite.
- **Next-merge warning**: upstream 0.1.3 shipped their OWN subagent model-selection settings (`subagent-model-selection-settings` row, base SubagentModelSelectionCard, `modelSelectionSettings` preset key). Our fork's versions evolved in parallel — the next sync will reconcile our `runtimeSelectionSettings` + enhanced card with upstream's implementation. Expect conflicts concentrated in tool-subagent model-selection files; our additions are additive over upstream's, keep both capabilities.
- The dsh-better-harness v0.1.0 host half is a fork compatibility guard (probes KNOWN_SESSION_EVENT_TYPES + registry enumeration at boot; unit-tested in the sibling repo). Note: user-layer plugin hosts may mount lazily on first session, so the guard's console banner need not appear at server boot.
