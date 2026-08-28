# Agent Note: Native child-runtime selection

Status: implemented

English | [中文](2026-08-28-native-subagent-runtime-selection.zh.md)

## Problem

The subagent seam already had separate DSH, Codex, Claude Code, and ACP transports, but the Web product did not expose one settings-level choice for the child runtime. The model-selection card could choose a DSH LLM route while a native child product had no honest place to own its model and reasoning effort. OpenCode also had no configured ACP instance in the shipped Web profile, and the generic ACP package was not a valid loadable Bundle without a consuming profile patch.

## Decision

`SubagentProvider` carries optional settings-safe `selection` metadata: label, description, product kind, and `modelAuthority`. `ctx.subagents.providers` returns only that metadata and the registry name through `SubagentProviderCatalog`; commands, arguments, paths, environment values, credentials, provider instances, and native options remain Host-owned. Providers without explicit metadata receive a capability-derived fallback identity.

The Host-owned `subagent-model-selection` preference stores `runtimeProvider` beside the existing DSH model route policy. The primary `dsh-tool-subagent` instance samples that provider at top-level Agent publication and child Sessions inherit the selected provider. The runtime controller refreshes its directory independently, keeps a saved but unavailable provider visible, and writes the provider name through the same revision-fenced settings mutation as the model policy.

The Web card separates runtime authority from DSH model authority. DSH-managed providers expose the DSH model and reasoning-effort controls. Codex, Claude Code, and ACP/OpenCode advertise native authority; the card shows the native ownership notice and hides DSH model controls, while the executor rejects accidental DSH route fields and omits unsupported `agentOptions` and depth fields. Native one-shot providers retain their existing foreground behavior, with explicit background calls using the generic Job path.

The Web profile mounts the Codex and Claude providers and inserts a named `opencode` ACP instance with `command: opencode`, `args: [acp]`, and `permission: reject`. The generic ACP package ships an empty `dsh.bundle` patch carrier so a profile can provide executable configuration without the package inventing a command or policy. OpenCode owns its model and variant configuration in the native product.

## Evidence

- The focused provider, settings, delegation, ACP, and Web card suite passes with 416 tests passing and one existing skipped test.
- `pnpm run build:lib:host` passes, and the Cordis, config, tool, and client catalogs regenerate from the new source contracts.
- `dsh --profile web --dump-config` loads the staged ACP package and emits the `subagent-acp-opencode` overlay together with the `subagent-model-selection-settings` row; the active `standard` preset carries the primary runtime-selection configuration consumed when a Web Session is composed.
- The settings tests cover runtime catalog loading, saved-provider retention, native-control hiding, runtime persistence, parent-to-child inheritance, native schema rejection, and provider-aware delegation.

## Alternatives considered

**Expose DSH model controls for every provider** — rejected. Codex, Claude Code, and ACP providers do not accept DSH `AgentOptions`; showing those controls would promise a route the child product does not own.

**Put runtime selection in each provider package** — rejected. Runtime choice is a session policy. The subagent service owns the provider catalog, and each provider publishes only its settings-safe identity and model authority.

## Consequences

The Web card can select every registered runtime through one persisted field. DSH-managed providers retain the DSH model and effort controls. Native providers show their ownership boundary and leave model configuration in the native product. Profiles must register a concrete ACP command and policy before that ACP runtime appears in the selector.

## Boundary

DSH chooses a native provider, not the native product's model or reasoning-effort setting. Codex and Claude Code configuration remains in their products; OpenCode configuration remains in OpenCode. A generic ACP runtime appears in the Web selector only when a Profile registers it with a concrete command and policy. The full client project typecheck still has an unrelated pre-existing Session-store declaration mismatch outside this change; the focused client tests and direct client bundle path are the relevant proof for this feature.

## Related decisions

The DSH LLM route and allowlist remain owned by [user-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.md) and [model-selected subagent routes](2026-08-18-model-selected-subagent-routes.md). Transport semantics remain owned by the [subagent capability seam](2026-06-21-subagent-capability-seam.md), while native product process contracts remain in the [Codex and Claude Code backends](2026-08-04-claude-code-and-codex-subagent-backends.md).
