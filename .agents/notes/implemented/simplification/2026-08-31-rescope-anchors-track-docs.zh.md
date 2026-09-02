# Agent Note：Rescope 精确编辑锚点跟随改写后的文档

Status: implemented

[English](2026-08-31-rescope-anchors-track-docs.md) | 中文

## Problem

`pnpm run rescope-vendor:check` 门禁（`pnpm run hygiene` 十五个门禁之一）失败：六个精确编辑被报告为 `neither pending nor cleanly applied (duplicated, partial, or moved)`，另有四个残留文件。`scripts/rescope-vendor.ts` 的 `EXACT_EDITS` 中六个锚点是为改写前的文档写的：agent-spine-demo README 的 fence 行在 demo 包迁移到 `packages/examples/*-demo`（6f77da4c8c）时增加了 `(writes nothing to stdout)` 并重新对齐列宽；vendoring cookbook 的行被改写为记录 publishable release member 状态（0b5eba0c8d，文档技能重建 #2983）。check 将每个锚点的 rescope 后字符串与文档逐字节比对，因此改写使锚点过期。另外，`packages/experimental/inspector/` 的四个新文件包含带引号的产品标识符（`'cordis/tree'` 观察主题与 `'cordis.shadow'` realm 标记），通用 token 路径会误把它们当作包引用改写。

## Decision

重新锚定六个 `EXACT_EDITS`：每个 `find` 取当前文档行的 rescope 前形态，每个 `replace` 取当前 rescope 后文本。两个 agent-spine-demo mounted-tree 锚点（EN+ZH）现在覆盖 `@cordisjs/plugin-timer      timer service (writes nothing to stdout)` 及其 scope 改写形态；两个 cookbook tree-comment 锚点（EN+ZH）现在覆盖 `keep name/exports/type (publishable release member, no private flag)` → `rescope the name, keep exports/type (publishable release member, no private flag)`；两个 cookbook name-invariant 锚点（EN+ZH）把 `version` 移出保留集合，与文档关于 `version` 跟随 harness 发布序列的表述一致。四个 inspector 文件加入 `GENERIC_SKIPS`，注释说明 `cordis/tree` 与 `cordis.shadow` 是 wire/runtime 标识符而非包引用。文档文本本身未改动。

## Alternatives considered

**把文档改回旧措辞以保留原锚点。** 否决：改写是有意的且更准确——vendored 包是 publishable release member，不是 `private: true`。

**check 对移动锚点降级为警告而非失败。** 否决：fail-loud 是该 check 的契约；锚点存在的意义就是在文档行移动或重复时被发现，而不是被静默跳过。

**把 inspector 产品标识符改写成 scope 名称。** 否决：`cordis/tree` 是 inspector 的观察主题 id，`cordis.shadow` 是上游 realm 标记；改名会改变 wire 协议与 Symbol 身份。

## Consequences

`pnpm run rescope-vendor:check` 退出码 0，输出 `post-state verified — no residue, every exact edit landed, idempotent`。未来 re-vendor 从新的 rescope 前锚点应用相同的六个改名，inspector 的产品标识符保持不变。

## Testing

- `pnpm run rescope-vendor:check` — 退出码 0，无失败。
- `pnpm run hygiene` — 15 passed, 0 failed, 0 skipped（53.06s）。
