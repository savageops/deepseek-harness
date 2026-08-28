# Agent Note: 原生子运行时选择

Status: implemented

[English](2026-08-28-native-subagent-runtime-selection.md) | 中文

## 问题

subagent seam 已经拥有独立的 DSH、Codex、Claude Code 与 ACP 传输，但 Web 产品没有提供设置级的子运行时选择。模型选择卡可以选择 DSH LLM 路由，却没有诚实的边界让原生子产品负责自己的模型与推理强度。OpenCode 在随附 Web Profile 中也没有已配置的 ACP 实例，而且通用 ACP 包如果没有消费方 Profile patch，就不是可加载的有效 Bundle。

## 决策

`SubagentProvider` 携带可选的 settings-safe `selection` 元数据：标签、描述、产品类型与 `modelAuthority`。`ctx.subagents.providers` 通过 `SubagentProviderCatalog` 只返回这些元数据与注册名称；命令、参数、路径、环境值、凭据、提供方实例与原生选项仍由 Host 持有。没有显式元数据的提供方会根据能力描述符得到回退身份。

Host 自有的 `subagent-model-selection` 偏好在既有 DSH 模型路由策略旁保存 `runtimeProvider`。主 `dsh-tool-subagent` 实例在顶层 Agent 发布时取样该提供方，子 Session 继承所选提供方。运行时控制器独立刷新目录，保留已保存但当前不可用的提供方，并在同一次带 revision 设栅的 settings mutation 中写回提供方名称与模型策略。

Web 卡把运行时所有权与 DSH 模型所有权分开。DSH 管理的提供方显示 DSH 模型与推理强度控件。Codex、Claude Code 与 ACP/OpenCode 声明原生所有权；卡片显示原生所有权提示并隐藏 DSH 模型控件，执行器拒绝意外的 DSH 路由字段，并省略不受支持的 `agentOptions` 与 depth 字段。原生一次性提供方保留原有前台行为，显式后台调用走通用 Job 路径。

Web Profile 挂载 Codex 与 Claude 提供方，并插入具名的 `opencode` ACP 实例，配置 `command: opencode`、`args: [acp]` 与 `permission: reject`。通用 ACP 包携带空的 `dsh.bundle` patch carrier，让 Profile 提供可执行配置，而不是由包自行猜测命令或策略。OpenCode 在原生产品中负责自己的模型与 variant 配置。

## 证据

- 提供方、设置、委派、ACP 与 Web 卡聚焦套件通过，416 个测试通过，另有 1 个既有测试跳过。
- `pnpm run build:lib:host` 通过，Cordis、配置、工具与客户端目录均从新的源码约定重新生成。
- `dsh --profile web --dump-config` 成功加载暂存的 ACP 包，并输出 `subagent-acp-opencode` overlay 与 `subagent-model-selection-settings` 行；激活的 `standard` preset 携带 Web Session 组合时消费的主运行时选择配置。
- 设置测试覆盖运行时目录加载、已存提供方保留、原生控件隐藏、运行时持久化、父子继承、原生 schema 拒绝与按提供方委派。

## Alternatives considered

**为每个提供方显示 DSH 模型控件**——拒绝。Codex、Claude Code 与 ACP 提供方不接受 DSH `AgentOptions`；显示这些控件会承诺一个子产品不负责的路由。

**把运行时选择放进每个提供方包**——拒绝。运行时选择是会话策略。subagent service 负责提供方目录，每个提供方只发布 settings-safe 身份与模型所有权。

## Consequences

Web 卡片通过一个持久化字段选择所有已注册运行时。DSH 管理的提供方保留 DSH 模型与强度控件。原生提供方显示所有权边界，并把模型配置留在原生产品中。Profile 必须先注册具体的 ACP 命令与策略，ACP 运行时才会出现在选择器中。

## 边界

DSH 选择原生提供方，不选择原生产品的模型或推理强度设置。Codex 与 Claude Code 配置仍在各自产品中；OpenCode 配置仍在 OpenCode 中。只有 Profile 以具体命令与策略注册通用 ACP 运行时后，它才会出现在 Web 选择器中。完整 client project typecheck 仍有本次改动之外、既有的 Session-store 声明不匹配；本功能的相关证据是聚焦 client 测试与直接 client bundle 路径。

## 相关决策

DSH LLM 路由与允许列表仍由[用户授权的 subagent 模型路由](2026-08-24-user-authorized-subagent-model-routes.zh.md)和[模型选择的 subagent 路由](2026-08-18-model-selected-subagent-routes.zh.md)负责。传输语义仍由 [subagent 能力 seam](2026-06-21-subagent-capability-seam.zh.md)负责，原生产品进程约定仍位于 [Codex 与 Claude Code 后端](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)中。
