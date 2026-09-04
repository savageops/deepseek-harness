# Agent Note：会话格式迁移中的安装词汇准入

Status: implemented

[English](2026-09-04-session-format-migration-installed-vocabulary.md) | 中文

## 问题

已发布的 v0→v1→v2 迁移链按冻结的已发布事件清单校验，并拒绝所有未知的历史事件类型，即使该事件带有 `ignorable` 标记。本 fork 的 `subagent` 插件写入的 v0 日志因此在发布迁移链落地后变得不可读：`subagent/runtime-provider-selection` 位于安装构建的 `KNOWN_SESSION_EVENT_TYPES` 中，却不在任何已发布清单里，冷读取在安装的当前恢复器有机会解释之前就拒绝了整个会话。

## 决策

每条相邻迁移与 released-v0 编解码器现在都接受安装构建自己的事件词汇，由生成的 catalog 以 `KNOWN_SESSION_EVENT_TYPES` 一次性提供：

```ts ignore-check
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { createSessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { createSessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'

export const sessionFormatCatalog = createSessionFormatCatalog({
  migrations: [
    createSessionFormatV0ToV1(KNOWN_SESSION_EVENT_TYPES),
    createSessionFormatV1ToV2(KNOWN_SESSION_EVENT_TYPES),
  ],
  installedEventTypes: KNOWN_SESSION_EVENT_TYPES,
})
```

已发布清单内的事件类型保持完整的 payload、关系与语义校验。只有安装构建声明的事件类型会作为不透明记录迁移：信封仍然要求精确的 `type`/`seq`/`time`/`data` 键与稠密序号，payload 语义被跳过（因为安装构建拥有它们），记录原样携带到后续版本，由之后的恢复按同一词汇重新解释。不在两个集合中的类型仍然拒绝，已发布清单本身保持冻结；catalog 仍是注入安装词汇的唯一位置。

这补全了 2026-08-28 注册 seam 的读取侧：注册让实时读取器接受一个类型，而生成的 catalog 让历史迁移接纳同一安装集合。

## 备选方案

把本 fork 的事件类型加入冻结的已发布清单被否决：这些清单描述的是任何已发布的 v0/v1/v2 写入端可能发出的事件，加入 fork 本地词汇会让已发布格式变成移动目标。写入时把注册事件转换为 `ignorable` 标记被否决：它会静默丢弃模型不可见的历史而不是携带它，也无法修复已经写好的日志。把挂载的 `ctx.sessionEventTypes` 注册表穿入持久层被否决：历史可读性将取决于当前挂载了哪些插件；生成的静态 catalog 让整条链保持构建期静态。

## 后果

引用 fork 本地事件类型的旧日志可以迁移并重新打开；不透明记录原样穿过链条，由安装的 Session 包重新解释。没有某个类型声明的构建仍然拒绝，fail-closed 行为得以保留。未来的相邻迁移必须接受同样的安装集合，生成的 catalog 会自动提供。
