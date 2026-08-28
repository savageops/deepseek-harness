# Agent Note：外部会话事件类型的运行时注册

Status: implemented

[English](2026-08-28-session-event-registration.md) | 中文

## 问题

fail-closed 会话读取器正确拒绝生成的第一方词汇之外的事件类型。已安装的 `dsh-rich-tracking` 插件是延期边界的真实必需消费方：它写入 `tracking/write`、`tracking/checkpoint` 和 `tracking/decision`，重新打开会话时其投影需要这些记录。静态目录不能在不让核心读取器依赖某个组合的情况下加入仓库外可选插件。旧的逐记录 `ignorable` 路径已经移除，因为它无法表达某种类型是否确实可以省略，`Session.append()` 也不会发出该字段。

## 决策

核心会话能力暴露 `ctx.sessionEventTypes`，由 `SessionStore` fiber 提供 `SessionEventTypeRegistry`。仓库外的必需事件所有者，必须在持久化读取可以解释其会话之前注册一个类型或一个原子批次：

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

注册表校验带斜杠的名称，拒绝第一方名称和活动冲突，并返回可重复调用的 disposer。持久化只在注册表当前报告某个非生成类型时接纳它。注册具有 effect/HMR 生命周期：所有者 dispose 后移除其类型，后续读取会再次 fail closed，而不会在缺少所有者时解释记录。注册表只接纳类型；payload 的声明合并、投影、不变式及任何面向模型的语义仍由插件负责。

`dsh-rich-tracking` 在一个 effect 中注册自己的三个持久类型，并不再向 `Session.append()` 传递废弃的 `ignorable` 参数。其最低 harness 版本是提供此能力的第一个版本 `0.1.2-alpha.1`。

## 考虑过的替代方案

- **把 tracking 名称加入 `KNOWN_SESSION_EVENT_TYPES`。**不予采用，因为生成集合由仓库所有，并且必须独立于可选插件是否安装。
- **忽略所有未知事件或恢复 `ignorable`。**不予采用，因为读取器无法推断未知事实在语义上是否可选；省略可能改变投影、请求重建或恢复结果。
- **使用进程全局集合。**不予采用，因为插件卸载、profile 组合和 HMR 会留下陈旧接纳。Cordis fiber 所有制已经提供正确生命周期。
- **现在构建完整的版本化解释器注册表。**延期。当前约定只需要明确的必需类型接纳；所有者身份和活动生命周期已经具备，payload 解释仍由插件负责。未来更丰富的兼容解释器约定可以扩展此 seam，而无需重新打开静态守卫。

## 后果

原有安全边界保留：未注册事件类型仍以 `SessionFormatUnsupportedError` 拒绝，并包含序号与原始产物路径。tracking 插件活动时，tracking 会话现在可以通过冷观察、历史分页、恢复以及共享持久化协调器的 fork 路径加载。移除插件会有意使其会话对无法忠实折叠 tracking 记录的构建不可用。

运行时注册表只增加一个小型服务属性，不增加第二套持久化事件格式。第一方目录生成除记录外部注册边界的说明外保持不变。tracking 插件由拥有其投影与工具的同一 fiber 管理注册，因此其兼容性声明不会超出解释这些事件的代码生命周期。
