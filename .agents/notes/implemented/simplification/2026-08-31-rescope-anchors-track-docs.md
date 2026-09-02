# Agent Note: Rescope exact-edit anchors track the reworded docs

Status: implemented

English | [中文](2026-08-31-rescope-anchors-track-docs.zh.md)

## Problem

The `pnpm run rescope-vendor:check` gate (one of the fifteen `pnpm run hygiene` gates) failed with six exact edits reported as `neither pending nor cleanly applied (duplicated, partial, or moved)` plus four residue files. Six of the anchors in `scripts/rescope-vendor.ts` `EXACT_EDITS` were written against the pre-rewording docs: the agent-spine-demo README fence line gained `(writes nothing to stdout)` and re-aligned column spacing when the demo bundles relocated to `packages/examples/*-demo` (6f77da4c8c), and the vendoring-cookbook lines were reworded to record publishable-release-member status (0b5eba0c8d, the documentation skill rebuild #2983). The check compares each anchor's post-rescope string against the docs byte-for-byte, so the rewording left the anchors stale. Separately, four new `packages/experimental/inspector/` files carry quoted product identifiers (the `'cordis/tree'` observation topic and the `'cordis.shadow'` realm marker) that the generic token pass would have rewritten as if they were package references.

## Decision

Re-anchor the six `EXACT_EDITS` so each `find` is the pre-rescope form of the current doc line and each `replace` is the current post-rescope text: the two agent-spine-demo mounted-tree anchors (EN+ZH) now cover `@cordisjs/plugin-timer      timer service (writes nothing to stdout)` → its scoped form; the two cookbook tree-comment anchors (EN+ZH) now cover `keep name/exports/type (publishable release member, no private flag)` → `rescope the name, keep exports/type (publishable release member, no private flag)`; the two cookbook name-invariant anchors (EN+ZH) drop `version` from the kept set, matching the docs' statement that `version` follows the harness release sequence. Add the four inspector files to `GENERIC_SKIPS` with a comment stating that `cordis/tree` and `cordis.shadow` are wire/runtime identifiers, not package references. No documentation text was changed.

## Alternatives considered

**Revert the docs to the old wording so the original anchors hold.** Rejected: the rewording is intentional and more accurate — vendored packages are publishable release members, not `private: true`.

**Relax the check to warn instead of fail on a moved anchor.** Rejected: fail-loud is the check's contract; the anchors exist so a moved or duplicated doc line is caught instead of silently skipped.

**Rewrite the inspector product identifiers to scoped names.** Rejected: `cordis/tree` is the inspector's observation topic id and `cordis.shadow` is an upstream realm marker; renaming them changes wire-protocol and Symbol identity.

## Consequences

`pnpm run rescope-vendor:check` exits 0 with `post-state verified — no residue, every exact edit landed, idempotent`. A future re-vendor applies the same six renames from the new pre-rescope anchors, and the inspector's product identifiers stay untouched.

## Testing

- `pnpm run rescope-vendor:check` — exit 0, no failures.
- `pnpm run hygiene` — 15 passed, 0 failed, 0 skipped (53.06s).
