# Agent Note: 六条高权重 Web 性能工作流

Status: implemented

[English](2026-08-29-web-performance-critical-path.md) | 中文

## Problem

Web client 有四个彼此独立、可以避免的延迟和主线程工作来源：每个 model selector 都可能重复执行 Host catalog interrogation；一个永不结束的 provider 可以阻塞整个 catalog；事件 burst 可以触发重复的 client refresh；model selection 会在 metadata 或 projection 到达前保持空白。Chat 会把组装后的每个 node 都渲染到 DOM；大型 project 的 workspace list 即使行在屏外，仍会承担完整的 row style/layout/paint 工作。这些成本会在大型 project 上叠加，让健康的 backend 看起来像挂起。

## Decision

已在既有 owner 上交付六条路径：

1. `packages/api/session-controller/src/catalog.ts` 默认给每个 provider catalog interrogation 2,500 ms 截止时间。超时 provider 会成为独立 catalog failure；成功的 provider 分组仍然渲染。`0` 仍是显式 opt-out，供接受无界 provider read 的部署使用。
2. Session Controller 中的 `ModelCatalogCache` 缓存一份 Host-generation catalog，并共享一次进行中的 Remote read。Adapter、settings 与 credential-reference owner event 会使代次失效。
3. `ui-model-selection` 中的 `ModelCatalogDirectory` 在 refresh 期间保留上一份成功值，并把一串 event 合并为一次 trailing read。旧 generation 不能覆盖新 generation。
4. `ModelDirectory` 会在 catalog metadata 到达前暴露持久化的 Session selection，并在 catalog ready 后立即暴露 Host default。`selectionSynced` 区分 durable projection 与该 default，因此 readiness 不再依赖两个无关 read 以同一顺序完成。
5. `ChatView` 在历史超过 100 个 Chat node 时使用 `@tanstack/react-virtual`。它挂载经过测量的 viewport 加 12 行 overscan，使用稳定 node key，在 flow-root 测量 wrapper 中保留每行间距；目标未挂载时，Turn navigation 按 index 滚动。小历史继续走原普通路径。每个 flow item 还使用带 160 px 固有回退值的 `content-visibility: auto`。同一工作流在每次结构变化时只计算一次每个可见 node 的呈现位置，并为每个 Turn rail mark 建立 memo，因此 active-turn 变化只重渲染状态发生变化的 mark。
6. `ui-workspace` 给 Session row 添加 `content-visibility: auto` 与 32 px 固有回退值。它保留完整 row DOM 和交互身份，以维护 tree 语义、键盘导航、拖放与悬浮卡片，同时让浏览器跳过屏外渲染工作。默认分组仍然每个 Workspace 最多显示五条非空 row。

六条机制复用既有 catalog、directory、Chat row 与 Session row owner。没有引入第二份 cache、平行的 session projection 或按交互另建的 sidebar virtualizer。

## Alternatives considered

**一个 provider 失败就让整个 catalog 失败。** 否决，因为 catalog 是 advisory；一个 adapter 慢或坏时，健康 provider 仍必须可选。

**让每个 selector 自己拥有 query/cache library。** 否决，因为 Host-generation catalog 是共享 deployment state，不是 Session state；分别在 popup 和 composer consumer 中缓存会保留重复 read，并造成 invalidation 漂移。

**每个 forwarded event 都立即失效并启动新 read。** 否决，因为 adapter/settings/credential update 可能成 burst 到达；保留当前有用的 read，并安排一次 trailing generation，可以限制 request fan-out。

**等 catalog 与 Session projection 一起 settle 后才放开 selector。** 否决，因为 durable selection 与 deployment default 都已经是有效显示状态；metadata 延迟不应让 composer 变空白。

**把每个 workspace row 都做成 virtual。** 本轮否决，因为 tree 依赖稳定 row identity 来实现 drag/drop、键盘、悬浮卡片和 accessibility。Native containment 先取得安全的屏外收益，同时保持这些交互约定。

**渲染每个 Chat node，只依赖 `content-visibility`。** 对大型历史否决，因为 DOM、React tree、subscriptions 与 event target 仍会随整个 loaded order 增长。Chat owner 需要 virtualization；containment 仍对已挂载 row 有价值。

## Consequences

第一次 model-catalog read 现在会在最慢的健康 provider 完成或到达截止时间时结束，而不是永远等待最慢 provider。超时 provider 以命名 failure 保留，并在 owner generation 改变后可重试。截止后底层未取消的 provider promise 可能仍在 adapter 中继续；Remote 与 UI 不再等待它。

大型 Chat history 的 mounted-row window 有界，但真实 row height 会在进入 viewport 时学习。初始 160 px estimate 会在真实 markdown、code、tool 或 image 测量后调整 scrollbar geometry。Turn navigation 与 paging 保留 semantic-key anchor；假定所有 Chat row 都是 flow 直接子节点的 DOM selector 必须跨 virtual-row wrapper 使用 `[data-chat-flow-key]`。

Workspace containment 不减少 DOM cardinality。它减少屏外 row 的浏览器渲染工作，同时保留交互表面。未来完整 tree virtualizer 仍需单独证明键盘焦点、drag boundary、悬浮卡片 owner 与 find-in-page 行为。

## Testing

Focused source proof 通过 8 个文件、133 个测试，覆盖 catalog cache/deadline、refresh-burst coalescing、durable/default selection readiness、Chat containment/virtual-row style 与 Workspace containment style。定向 Host 和 client TypeScript build 通过。完整 repository build 通过，并记录 218 个 client artifact。大型历史 browser contract 验证 virtual flow 已启用，mounted Chat row 数量小于 88-turn fixture，同时 semantic tool、branch、copy 与 fork interaction 仍按稳定 identity 解析。jsdom ChatView contract 钉住 threshold 切换、有界 mounted window（行带 index 与 translate 定位），以及跨 commit 的稳定 window identity。

Configuration catalog 已从 Host schema 重新生成。安装 built artifact 或在未占用 port 启动后，assembled browser suite 与 fresh local runtime check 仍是最终 live gate；本次变更不会停止用户已有的 `127.0.0.1:3080` 进程。
