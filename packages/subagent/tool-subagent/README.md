---
description: "Model-facing subagent delegation tool for users and maintainers configuring, composing, or debugging delegation over a subagent provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent` is the model-facing delegation tool: it turns one configured `ctx.subagents` provider into a tool the agent can call to start a child agent. Changing the provider changes the transport without changing the execution contract, so one composition can expose several delegation tools, each bound to a different backend. Calls wait for the child by default under `one-shot` policy, or start work in the background by default under `continuable` policy, which returns a durable child id the model can message later. A settings-enabled instance can select the child runtime per new Session, then expose DSH-owned child LLM provider, model, and reasoning-effort controls when that runtime supports them. Native Codex, Claude Code, and ACP runtimes keep model and effort ownership in their own products. The tool's descriptions adapt to whether the child inherits the parent's completed turns, and failed runs surface as errored tool results rather than partial success.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount one instance per delegation target, each with a distinct `toolName`. The tool exists exactly while its provider does, so sibling load order and provider reloads never strand it.

### Minimal configuration

Load the subagent service, an in-process or remote backend, and this tool; then name the provider. This composition exposes a `subagent` tool that delegates to the `spawn` backend:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | Provider name on `ctx.subagents` (e.g. `spawn`, `fork`, `acp`) |
| `toolName` | `subagent` | Model-facing tool name; distinct for every loaded instance |
| `runtimeSelectionSettings` | `false` | Sample the Host's selected child-runtime provider for each new top-level Session; native runtimes own their model and reasoning-effort settings |
| `modelSelectionSettings` | `false` | Sample the Host's subagent default route and optional per-call allowlist for each new top-level Session; valid only in Agent scope and requires provider `agentOptions` support |
| `enableRunInBackground` | `true` | Expose `run_in_background`; disabling also rejects forced background calls |
| `backgroundMode` | `one-shot` | Background policy: `one-shot` defaults calls to foreground; `continuable` defaults them to background and requires the provider's `prepareContinuable` capability |
| `agentOptions` | — | Configured child `provider`, `model`, adapter-owned `reasoningEffort`, and positive `maxTokens` defaults; requires provider `agentOptions` support and overlays any provider-owned route defaults |
| `persona` | — | Per-child persona; requires the provider's `persona` capability |
| `toolFilter` | — | Per-child global-tool restriction; requires the `toolFilter` capability |
| `maxDepth` | `3` | Absolute delegation-depth cap (`0` forbids delegation); `'provider-managed'` sends no cap to an out-of-process provider |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent) is the exhaustive source for every accepted field and its JSDoc.

### Foreground and background modes

Under `one-shot` policy, an omitted `run_in_background` waits in the foreground and returns the child's final text; `run_in_background: true` starts a plain parent-owned background job and returns `started background subagent job <id>`, collected with `job_output` and stopped with `job_kill`.

Under `continuable` policy, an omitted or `true` `run_in_background` starts a durable child and returns `started subagent <childId>` without waiting for a result; the runtime delivers one settlement notice when the child's Activation ends, and the optional `send_message` tool sends it more work. Set `run_in_background: false` to wait for the result in the foreground.

When `runtimeSelectionSettings: true` is enabled, a new Session samples the Host's `subagent-model-selection.runtimeProvider` and binds this tool instance to that registered child runtime. An empty setting keeps the profile's configured `provider`. If the selected runtime is a native one-shot product such as Codex, Claude Code, or ACP/OpenCode, the tool uses its one-shot start path even when the profile row requests `backgroundMode: continuable`; an explicit `run_in_background: true` uses the generic job surface because the native runtime has no continuable child-session contract. The runtime provider owns its process and protocol, so a native runtime's model and reasoning effort stay in the native product configuration.

`maxDepth` caps recursion (default `3`; `0` forbids delegation) and requires a provider with the `depthLimit` capability; `'provider-managed'` leaves the budget to an out-of-process provider. `persona` and `toolFilter` configure every child when the provider supports them, and the tool stays visible at the cap — each attempted start checks the calling agent's current depth and rejects with an errored result.

### Selecting the child runtime and LLM

Set `runtimeSelectionSettings: true` to sample the Host's `subagent-model-selection.runtimeProvider` when each top-level Session is composed. The runtime directory is a settings-safe catalog of registered provider names, labels, product kinds, and model-authority metadata. The sampled runtime is recorded in the Session, inherited by child Sessions, and unchanged by later settings edits. The profile's configured `provider` remains the fallback when the setting is empty.

Set `modelSelectionSettings: true` to sample the Host's DSH child-LLM preference when each fresh top-level Session is composed. A restored Session without a recorded policy remains disabled, including an explicitly empty restore. The setting has one automatic `defaultSelection` (`provider`, `model`, and optional `reasoningEffort`) and an optional `allowedModels` list for model-directed per-call choices; when enabled, the non-empty exact provider/model route list is recorded in the Session, inherited by child Sessions, and unchanged by later settings edits. The default route applies whenever a delegation call omits route fields; an explicit route overrides it only when the Session also carries an allowlist. This control is active only for a selected runtime whose provider advertises `agentOptions` and whose metadata says DSH owns model authority. The in-process backends and DSH SDK support it. ACP, Codex, Claude Code, and ACP-configured OpenCode keep their product-owned model controls; the model-facing route fields and `list_subagent_models` are omitted, and an injected harness route is rejected rather than silently ignored.

For the settings UI, choose one provider-grouped model and then one effort from that exact model's live catalog. A model choice records its advertised default effort when one exists. The live LLM adapter validates the effective route before child creation. Catalog membership remains advisory, so a model can use an unlisted id when its adapter accepts it. Static `provider.agentRouteDefaults`, when present, form the provider/model baseline below the Host default and tool configuration. A route change without an explicit effort clears the inherited route-owned effort, so the selected model resolves its own default. Providers without static defaults use compatible values from the parent's latest logged request, then the parent's creation options before its first request, while retaining the configured `maxTokens`.

The Host setting uses this shape:

```yaml
subagent-model-selection:
  runtimeProvider: codex
  enabled: true
  defaultSelection:
    provider: deepseek-official
    model: deepseek-v4-flash
    reasoningEffort: high
  allowedModels: []
```

Leave `defaultSelection` absent to make subagents inherit the parent route. Add `allowedModels` only when the model should choose a different route per call; the default route does not require an allowlist.

The web card exposes the same runtime directory above the DSH model controls. Choose **Profile default (DSH Agent)** to use the tool row's provider, or choose a registered Codex, Claude Code, or OpenCode runtime to hand model and effort selection to that product. Native choices hide the DSH model controls because those values cannot be applied through the `SubagentProvider` start contract.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tool mirrors provider lifecycle and settles runs; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

One instance is one configured provider plus one tool name. The plugin mirrors provider lifecycle: it resolves the Session's sampled runtime, registers the tool when that provider appears, and disposes it when the provider leaves, so sibling load order and HMR replacement cannot strand a dangling tool. A numeric `maxDepth` or configured LLM selection the selected provider cannot enforce fails the mount instead of the first delegation. At most one harness-backed instance in a tool scope may own model selection because `list_subagent_models` has a global name; switching to a native runtime disposes that discovery tool with the old runtime.

### Foreground settlement

A foreground call awaits `run.result`, maps every non-completed stop reason to an error headline, appends the provider diagnostic and any preserved partial assistant text, and always awaits `run.dispose()` before returning; when result collection and disposal both reject, the errored result preserves both failures.

### Background routes

One-shot background registers a plain parent-owned Task whose done channel settles the start and keeps the stop reason and optional provider diagnostic in its detail. Continuable background calls `ctx.subagents.startContinuable()`, which resolves at inbox acceptance: the child owns its own turns from there, so the call neither waits for nor collects a result.

### Context-sensitive wording

The tool's description derives from `provider.inheritsParentContext`: a fresh child gets "it does not see this conversation" wording, a forked child gets "it does not see the current in-flight turn" wording, so the model never restates or omits context that does not exist.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Tool registration, lifecycle mirroring, mode resolution, result settlement |
| [`src/model-selection.ts`](src/model-selection.ts) | Request/config merge and live LLM route preflight |
| [`src/model-selection-settings.ts`](src/model-selection-settings.ts) | Host-owned child runtime, default route, and optional allowlist sampled for new Sessions |
| [`src/model-selection-state.ts`](src/model-selection-state.ts) | Session events that record and inherit the sampled runtime, default, and allowlist |
| [`src/list-models.ts`](src/list-models.ts) | `list_subagent_models` runtime discovery tool |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the tool's runtime behavior to the seam it delegates over and the adjacent child tools.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — providers, one-shot start requests, continuable children and activations.
- [dsh-tool-subagent-control](../tool-subagent-control/README.md) — messaging, interrupt, and listing tools for continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) — the default schema and per-mode wording.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent) — every accepted config field.
- [Background subagent tasks](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md) — the one-shot background route.
- [Background-first continuable delegation](../../../.agents/notes/implemented/feature/2026-08-11-background-first-continuable-delegation.md) — why continuable work defaults to background.
- [Model-selected subagent routes](../../../.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md) — selection policy, inheritance, discovery, and the fork restriction.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated default [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) under this instance's configured name while its provider exists. A Host default route is automatic and adds no tool arguments. An enabled Session allowlist adds `provider`, `model`, and `reasoning_effort` plus inheritance and selection guidance; the provider must support `agentOptions`. Provider context inheritance changes the tool and prompt descriptions. Enabled background mode adds `run_in_background`: continuable mode documents its `true` default, runtime settlement notice, and explicit foreground override, while one-shot mode documents its `false` default and the job id collected with `job_output` or stopped with `job_kill`. While the tool is visible in an assembly's scope, a `tool:<toolName>` system-prompt section tells the model to start independent continuable delegations together, keep working while they run, and choose foreground only when its next action depends on the result; a tool restriction removes both its schema and this guidance.

#### Token effect

Fixed schema cost per parent request; an automatic route adds no schema fields, while an allowlist adds three parameters. Each provider instance adds one schema, and each continuable instance adds one short system-prompt section.

#### KV Cache effect

Prefix-stable while provider instances and their configuration are unchanged. Adapter catalog changes do not alter the definition; a child route override may prevent a fork child from reusing the inherited parent prefix.

### Model selection and discovery

#### What the model sees

A settings-controlled instance whose Session carries a selected runtime binds the tool to that runtime. A harness-owned runtime can also carry a default route without a model-facing choice; a Session carrying an allowlist exposes the child LLM selection fields and `list_subagent_models`. A native runtime exposes neither DSH route fields nor the discovery tool because the native product owns model and effort selection. Calls reject while the optional `ctx.llm` service is unavailable only when a DSH route must be preflighted. Discovery returns only registered providers and advertised models in the exact route policy; an unauthorized provider is rejected before its adapter catalog is called, and an exact lookup must be allowed before it resolves the model's reasoning efforts and default. Execution independently enforces the same policy.

#### Token effect

One fixed discovery schema is present in enabled compositions. Directory contents enter the transcript only when the model calls the tool.

#### KV Cache effect

The schema is prefix-stable across adapter registration and catalog changes. Each discovery result is appended after the reusable prefix.

### System prompt

#### What the model sees

When `enableRunInBackground` and `backgroundMode: continuable` are both set, the model additionally reads a `tool:<toolName>` system-prompt section telling it to start independent continuable delegations together and keep working while they run. With the default tool name `subagent`, the section text is:

##### Tool-guidance section

```markdown
Use subagent in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.
```

#### Token effect

One short fixed section per continuable instance, paid on every parent request while the tool is in scope.

#### KV Cache effect

Prefix-stable while the section text and tool presence are unchanged; removing the tool or changing the section establishes a different parent prefix.

### Foreground result

#### What the model sees

The call retains the description and prompt. Success contains only the child's final text; other outcomes become `Error: <stop reason>`, followed by a safe provider diagnostic when present and then any partial assistant text. Intermediate child steps stay out of the parent.

#### Token effect

The prompt and result remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background result

#### What the model sees

Start returns exactly `started subagent <childId>` in configured continuable mode, or `started background subagent job <id>` in configured one-shot mode. In one-shot mode the generic task surface provides later status, final output, cancellation responses, and notices; failed status detail includes the provider diagnostic when the result supplied one. In continuable mode this tool returns no result of its own: the child's settlement reaches the parent as a service-owned notice, an independently loaded `send_message` tool delivers follow-ups, and the child's transcript by its id is the source of its detailed output.

#### Token effect

The acknowledgement is retained; a one-shot final output enters parent history only when collected or injected, while a continuable child's output never returns through this tool — its settlement notice arrives independently of any tool result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what this tool does not return or enforce; they are current package constraints.

- **Background runs expose no result through this tool** — a one-shot task's final output is collected through the generic task surface, and a continuable child's output stays in its own session, read by its subagent id. The settlement notice states how that child ended and carries any final assistant message, but it is not this call's return value and cannot be awaited here.
- **Duplicate names across waiting one-shot instances are detected late** (`TODO(subagent-dup-toolname)`) — continuable instances reserve their prompt-section name during plugin application, but preventing provider-registration rollback for waiting one-shot instances requires a registry of intended names.
- **Fork route changes can reduce inherited-prefix reuse** — the standard fork tool accepts the Host default route when enabled, but a route different from the parent may prevent provider-side reuse of the copied conversation prefix.
- **Native runtimes keep native model ownership** — the runtime selector can route a Session to Codex, Claude Code, or OpenCode over ACP, but DSH cannot apply its LLM provider/model/effort settings to those products; configure those values in the native product.
- **Non-routing child policy is fixed per instance** — another persona, tool filter, or depth cap requires another distinctly named tool. Harness route selection requires an enabled per-Session preference and a provider that advertises `agentOptions`; both in-process providers and DSH SDK advertise it, while ACP, Codex, and Claude Code keep their native product model controls and reject a harness route override rather than ignore it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
