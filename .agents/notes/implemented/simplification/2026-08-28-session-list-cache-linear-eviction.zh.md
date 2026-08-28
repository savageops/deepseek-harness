# Agent Note: 按变化驱动的会话列表 snapshot

Status: implemented

[English](2026-08-28-session-list-cache-linear-eviction.md) | 中文

## 问题

[`SessionManager.buildListSnapshot()`](../../../../packages/api/session-controller/src/client/sessions/manager.ts) 保留 identity cache，使未变化的 refresh 复用同一个 `SessionListEntry` object，并保留 React external-store memoization。之前的清理循环遍历每个 cached id，再对每个 id 调用一次 `items.some(...)`。因此一次 list refresh 即使已经在 row 遍历中访问过所有当前 id，仍然要支付 O(cache size × current list size) 的成本。高基数 browser fixture 使用 1,000 个 sidebar session，因此这项成本会落在 chat-list refresh 路径上。同一个 manager 还会为过期 projection frame 和不改变 list state 的 lifecycle mutation 标记 list dirty，造成可避免的 snapshot construction 与 subscriber 工作。

## 决策

在现有 fresh-row 遍历期间构建一个 `Set<SessionId>`，用它清理 identity cache，并复用它检查 selected row 是否存在。让 `ProjectionValueStore.apply()` 报告 row 是否前进，只发布被接受的 projection frame。让 list mutation application 在没有 row 变化时返回原有 readonly summary array，使 `recordMutation()` 继续保留 in-flight replay journal，但当当前 list 不会变化时跳过 manager notification。list 内容、既有顺序、未变化 row reference、cached items-array 行为、已接受 frame 的 publication cadence 和 `useSyncExternalStore` snapshot 约定全部保持不变；清理保持线性时间，无效更新保持变化驱动。

## Alternatives considered

**保留嵌套扫描。** 它不增加额外状态，但会在受支持的高基数路径上保留二次方 refresh 成本。

**在 `entryCache` 旁边永久维护第二个 index。** 它可以让 membership read 达到常数时间，但会重复 cache ownership，并增加另一套需要同步的生命周期。一次 refresh 内的 Set 已经满足所需复杂度，无需第二个 mutable index。

**把 sidebar 改成 virtual rendering。** 当 DOM population 被测量为瓶颈时，virtual rendering 是正确的下一步，[VS Code list 与 tree design](https://github.com/microsoft/vscode/wiki/Lists-And-Trees) 展示了这种方式；但它会改变 UI ownership、accessibility、row measurement 和 browser snapshot 行为。当前缺陷在 manager 侧的 list construction 中，可以不做产品规模的改造就安全移除。

**发布每个收到的 frame。** 发布过期 projection 和无效 lifecycle mutation 虽然实现机械上简单，但会破坏现有 cached snapshot 的目的，并把不可能改变 consumer-visible list 的工作批量提交。已接受的 value 仍通过现有 manager 路径发布，mutation journal 仍会保留 no-op event 以便未来 baseline replay。

## 后果

未变化的 sidebar row 保留原有 object identity，被移除的 row 不再留在 identity cache 中，refresh 清理成本与 row 数量线性增长。过期 projection frame 和不改变 list 的 mutation 不再 rebuild 或 notify list snapshot。manager 仍会 materialize 完整 metadata list；如果 browser fixture 证明主要瓶颈在 rendering，而不是 snapshot construction，再把 DOM virtualization 作为单独的 measurement-driven 决策。

## Testing

manager test 证明 refresh 移除 row 后，该 row 会在同一 id 再次列出前从 cache 中清理，因此重新出现的 row 会得到新的 identity，并证明 no-op lifecycle frame 不会发布。projection-store test 证明被接受的 frame 会发布，而过期 frame 保持静默。session-controller focused suite 覆盖四个文件的 116 个测试。one-shot source-level timing probe 在变更前测得 20 次 1,000-row rebuild 为 52.2 ms、5 次 3,000-row rebuild 为 106.0 ms；变更后 accepted update 为 8.25 ms 与 5.07 ms，no-op update 在相同基数和重复次数下为 0.44 ms 与 0.09 ms。
